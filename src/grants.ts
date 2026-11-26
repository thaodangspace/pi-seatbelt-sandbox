import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { Type } from "typebox";
import { Value } from "typebox/value";
import type { SeatbeltConfig } from "./config.ts";
import { canon, isInside } from "./policy.ts";

export const GRANT_STORE_VERSION = 1;

export type GrantKind = "read" | "write" | "network";

interface GrantBase {
  id: string;
  createdAt: string;
  expiresAt: string | null;
}

export type Grant =
  | (GrantBase & { kind: "read"; path: string })
  | (GrantBase & { kind: "write"; path: string })
  | (GrantBase & { kind: "network"; mode: "localhost" | "all" });

export interface GrantStoreFile {
  version: number;
  projectRoot: string;
  grants: Grant[];
}

export type GrantStoreWarning = "corrupt" | "version" | "store-inside-workspace" | "project-mismatch";

export interface LoadGrantsResult {
  grants: Grant[];
  warning?: GrantStoreWarning;
}

/**
 * Thrown when a grant store cannot be written without destroying user data:
 * corrupt JSON, an unknown version, a file for another project, or a store that
 * sits inside the workspace. The message always carries the recovery command.
 */
export class GrantStoreError extends Error {
  constructor(message: string) {
    super(`pi-seatbelt-sandbox grant store error: ${message}`);
  }
}

const RESET_HINT = "run /seatbelt grants reset";

const TIMESTAMP_SCHEMA = Type.String({ minLength: 1 });

const PATH_GRANT_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Union([Type.Literal("read"), Type.Literal("write")]),
  path: Type.String({ minLength: 1 }),
  createdAt: TIMESTAMP_SCHEMA,
  expiresAt: Type.Union([TIMESTAMP_SCHEMA, Type.Null()]),
});

const NETWORK_GRANT_SCHEMA = Type.Object({
  id: Type.String({ minLength: 1 }),
  kind: Type.Literal("network"),
  mode: Type.Union([Type.Literal("localhost"), Type.Literal("all")]),
  createdAt: TIMESTAMP_SCHEMA,
  expiresAt: Type.Union([TIMESTAMP_SCHEMA, Type.Null()]),
});

const GRANT_SCHEMA = Type.Union([PATH_GRANT_SCHEMA, NETWORK_GRANT_SCHEMA]);

const GRANT_STORE_SCHEMA = Type.Object({
  version: Type.Literal(GRANT_STORE_VERSION),
  projectRoot: Type.String({ minLength: 1 }),
  grants: Type.Array(GRANT_SCHEMA),
});

const NETWORK_WIDTH: Record<SeatbeltConfig["network"]["mode"], number> = {
  none: 0,
  localhost: 1,
  all: 2,
};

const NETWORK_GRANT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function grantStoreDir(agentDir: string): string {
  return join(agentDir, "extensions", "seatbelt-grants");
}

/**
 * Location of the per-project grant store. The store path is a security
 * boundary, so it is derived here and nowhere else: the file name is the
 * sha256 of the canonical project root, keeping one file per project without
 * leaking path text into a shared directory.
 */
export function grantStorePath(agentDir: string, projectRoot: string): string {
  const digest = createHash("sha256").update(canon(projectRoot)).digest("hex");
  return join(grantStoreDir(agentDir), `${digest}.json`);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function warningMessage(warning: GrantStoreWarning): string {
  switch (warning) {
    case "corrupt":
      return `grant store is corrupt; ${RESET_HINT}`;
    case "version":
      return `grant store has an unsupported version; ${RESET_HINT}`;
    case "store-inside-workspace":
      return `grant store directory is inside the workspace; ${RESET_HINT}`;
    case "project-mismatch":
      return `grant store belongs to another project; ${RESET_HINT}`;
  }
}

/**
 * Read the per-project store. Never throws and never writes: any unreadable,
 * unparsable, or unexpected store yields no grants plus a warning, and a store
 * for another project is ignored but kept on disk (FR5).
 */
export function loadGrants(agentDir: string, projectRoot: string): LoadGrantsResult {
  const storePath = grantStorePath(agentDir, projectRoot);
  const canonicalProjectRoot = canon(projectRoot);

  // Checked before reading: a store inside the workspace is user data that the
  // sandboxed agent could rewrite, so it can never be trusted.
  if (isInside(canon(dirname(storePath)), canonicalProjectRoot)) {
    return { grants: [], warning: "store-inside-workspace" };
  }

  let contents: string;
  try {
    contents = readFileSync(storePath, "utf8");
  } catch (error) {
    return isMissingFile(error) ? { grants: [] } : { grants: [], warning: "corrupt" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return { grants: [], warning: "corrupt" };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { grants: [], warning: "corrupt" };
  }

  // An unknown or missing version is reported separately: it may be a newer
  // store that this build must not overwrite or downgrade.
  if ((parsed as Record<string, unknown>).version !== GRANT_STORE_VERSION) {
    return { grants: [], warning: "version" };
  }

  if (!Value.Check(GRANT_STORE_SCHEMA, parsed)) return { grants: [], warning: "corrupt" };

  const file = parsed as GrantStoreFile;
  if (file.projectRoot !== canonicalProjectRoot) return { grants: [], warning: "project-mismatch" };

  return { grants: pruneExpired(file.grants) };
}

/**
 * Replace the per-project store via a temporary file in the same directory plus
 * a rename. Refuses to write over a store it could not read, prunes expired
 * grants, and guarantees the directory mode (0700) and the file mode (0600).
 */
export function saveGrants(agentDir: string, projectRoot: string, grants: Grant[]): void {
  const storePath = grantStorePath(agentDir, projectRoot);
  const loaded = loadGrants(agentDir, projectRoot);
  if (loaded.warning) throw new GrantStoreError(warningMessage(loaded.warning));

  const directory = dirname(storePath);
  const document: GrantStoreFile = {
    version: GRANT_STORE_VERSION,
    projectRoot: canon(projectRoot),
    grants: pruneExpired(grants),
  };

  const directoryExisted = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir applies the umask, so tighten a directory this call created.
  if (!directoryExisted) chmodSync(directory, 0o700);

  const temporaryPath = join(directory, `.${basename(storePath)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    writeFileSync(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporaryPath, storePath);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  // The umask can weaken the create mode; the rename keeps the file in place.
  chmodSync(storePath, 0o600);
}

/** Drop grants whose expiry has passed. `expiresAt: null` never expires. */
export function pruneExpired(grants: Grant[], now = new Date()): Grant[] {
  return grants.filter((grant) => grant.expiresAt === null || Date.parse(grant.expiresAt) > now.getTime());
}

export type NewGrantInput =
  | { kind: "read"; path: string }
  | { kind: "write"; path: string }
  | { kind: "network"; mode: "localhost" | "all" };

function newGrantId(grants: Grant[]): string {
  const used = new Set(grants.map((grant) => grant.id));
  for (;;) {
    const id = randomBytes(4).toString("hex");
    if (!used.has(id)) return id;
  }
}

/**
 * Build one new grant without mutating the input. Path grants are stored as
 * `canon()` output with no expiry; network grants expire after seven days.
 */
export function addGrant(
  grants: Grant[],
  input: NewGrantInput,
  cwd = process.cwd(),
  now = new Date(),
): { grants: Grant[]; grant: Grant } {
  const id = newGrantId(grants);
  const createdAt = now.toISOString();
  const grant: Grant =
    input.kind === "network"
      ? { id, kind: "network", mode: input.mode, createdAt, expiresAt: new Date(now.getTime() + NETWORK_GRANT_TTL_MS).toISOString() }
      : { id, kind: input.kind, path: canon(input.path, cwd), createdAt, expiresAt: null };
  return { grants: [...grants, grant], grant };
}

export function revokeGrant(grants: Grant[], id: string): Grant[] {
  return grants.filter((grant) => grant.id !== id);
}

function appendUnique(list: string[], value: string): void {
  if (!list.includes(value)) list.push(value);
}

/**
 * Widen a configuration with grants (FR7 step 3). A write grant implies read,
 * network grants only ever widen, and deny lists are left untouched.
 */
export function applyGrants(config: SeatbeltConfig, grants: Grant[], cwd: string): SeatbeltConfig {
  const readable = [...config.readable];
  const writable = [...config.writable];
  let networkMode = config.network.mode;

  for (const grant of grants) {
    if (grant.kind === "network") {
      if (NETWORK_WIDTH[grant.mode] > NETWORK_WIDTH[networkMode]) networkMode = grant.mode;
      continue;
    }
    const target = canon(grant.path, cwd);
    if (grant.kind === "write") appendUnique(writable, target);
    appendUnique(readable, target);
  }

  return { ...config, readable, writable, network: { mode: networkMode } };
}

/** Locations a path grant must never reach (FR3 R4). */
export interface GrantProtectedPaths {
  agentDir: string;
  globalConfigPath: string;
  storeDir: string;
  configDir: string;
  trustFile: string;
  workspace: string;
}

const GLOB_CHARACTERS = /[*?]/;

/**
 * Refuse a path grant target. Returns the refusal text, which always starts
 * with its rule label (`R1:` … `R6:`), or `undefined` when the grant may
 * proceed. Network grants never reach this function; the access tool decides
 * those on its own.
 *
 * Order: R2 tests the raw string, then R1 resolves the real path, then R3, R6,
 * R4, R5. R6 is a specialization of R4 (the store directory is itself a
 * protected location), so it is evaluated first to keep its message reachable:
 * without that, every path that R6 refuses is already refused by R4 through
 * the store directory inside the workspace.
 */
export function refuseGrantTarget(
  target: string,
  config: SeatbeltConfig,
  protectedPaths: GrantProtectedPaths,
): string | undefined {
  // R2 first: the raw request decides whether a glob was asked for, before any
  // canonicalization could resolve it away.
  if (GLOB_CHARACTERS.test(target)) {
    return `R2: glob characters are not allowed in a grant target: ${target}`;
  }

  let canonical: string;
  try {
    canonical = realpathSync(isAbsolute(target) ? target : resolve(target));
  } catch {
    return `R1: path does not exist: ${target}`;
  }

  if (canonical === sep || canonical === canon(homedir())) {
    return `R3: refusing the filesystem root or the home directory: ${canonical}`;
  }

  const workspace = canon(protectedPaths.workspace);
  const storeDir = canon(protectedPaths.storeDir);
  if (isInside(storeDir, workspace) && isInside(workspace, canonical)) {
    return `R6: refusing ${canonical}: it contains the workspace that holds the grant store`;
  }

  for (const protectedPath of [
    protectedPaths.agentDir,
    protectedPaths.globalConfigPath,
    protectedPaths.storeDir,
    protectedPaths.configDir,
    protectedPaths.trustFile,
  ]) {
    const resolved = canon(protectedPath);
    if (isInside(canonical, resolved) || isInside(resolved, canonical)) {
      return `R4: refusing ${canonical}: it overlaps the protected location ${resolved}`;
    }
  }

  for (const denyPath of [...config.denyRead, ...config.denyWrite]) {
    const resolvedDenyPath = canon(denyPath);
    if (isInside(canonical, resolvedDenyPath) || isInside(resolvedDenyPath, canonical)) {
      return `R5: refusing ${canonical}: it overlaps a deny path ${resolvedDenyPath}`;
    }
  }

  return undefined;
}

/**
 * Deny entries for the grant store directory. Phase 3 appends these to both
 * deny lists before the policy and the profile are built. The path is resolved
 * best-effort so it works before the first save created the directory.
 */
export function grantStoreDenyPaths(agentDir: string): string[] {
  return [canon(grantStoreDir(agentDir))];
}

const ANSI_ESCAPE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[@-Z\\-_])/g;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUNS = /\s+/g;
const MAX_DISPLAY_LENGTH = 500;

/** Strip escapes and control characters, collapse whitespace, and cap length. */
export function sanitizeForDisplay(text: string): string {
  return text
    .replace(ANSI_ESCAPE, " ")
    .replace(CONTROL_CHARACTERS, " ")
    .replace(WHITESPACE_RUNS, " ")
    .trim()
    .slice(0, MAX_DISPLAY_LENGTH);
}

/** One line per grant, with the grant id as the first token. */
export function formatGrantList(grants: Grant[]): string[] {
  return grants.map((grant) => {
    const target = sanitizeForDisplay(grant.kind === "network" ? grant.mode : grant.path);
    const expiry = grant.expiresAt === null ? "no expiry" : `expires ${grant.expiresAt}`;
    return `${grant.id}  ${grant.kind}  ${target}  created ${grant.createdAt}  ${expiry}`;
  });
}
