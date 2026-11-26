import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SeatbeltConfig } from "../src/config.ts";
import {
  GRANT_STORE_VERSION,
  GrantStoreError,
  addGrant,
  applyGrants,
  formatGrantList,
  grantStoreDenyPaths,
  grantStorePath,
  loadGrants,
  pruneExpired,
  refuseGrantTarget,
  revokeGrant,
  sanitizeForDisplay,
  saveGrants,
  type Grant,
  type GrantProtectedPaths,
  type GrantStoreFile,
} from "../src/grants.ts";
import { canon } from "../src/policy.ts";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("grant store path", () => {
  it("derives a deterministic per-project file from the project real path", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const projectRoot = tempDir("seatbelt-project-");
    const expectedDigest = createHash("sha256").update(realpathSync(projectRoot)).digest("hex");

    const path = grantStorePath(agentDir, projectRoot);

    expect(path).toBe(join(agentDir, "extensions", "seatbelt-grants", `${expectedDigest}.json`));
    expect(dirname(path)).toBe(join(agentDir, "extensions", "seatbelt-grants"));
    expect(basename(dirname(path))).toBe("seatbelt-grants");
    expect(path.endsWith(".json")).toBe(true);
    expect(path).toContain(expectedDigest);
    expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same path for repeated calls and different paths for different projects", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const projectRoot = tempDir("seatbelt-project-");
    const otherProjectRoot = tempDir("seatbelt-other-project-");

    expect(grantStorePath(agentDir, projectRoot)).toBe(grantStorePath(agentDir, projectRoot));
    expect(grantStorePath(agentDir, projectRoot)).not.toBe(grantStorePath(agentDir, otherProjectRoot));
  });

  it("pins the store version", () => {
    expect(GRANT_STORE_VERSION).toBe(1);
  });
});

const CREATED_AT = "2026-11-26T02:00:00.000Z";
const NETWORK_EXPIRES_AT = "2026-12-03T02:00:00.000Z";

const OPEN_CONFIG: SeatbeltConfig = {
  enabled: true,
  failClosed: true,
  readable: [],
  writable: [],
  denyRead: [],
  denyWrite: [],
  environment: { mode: "inherit", deny: [] },
  network: { mode: "none" },
};

function readGrant(path: string, id = "aaaaaaaa"): Grant {
  return { id, kind: "read", path, createdAt: CREATED_AT, expiresAt: null };
}

function writeGrant(path: string, id = "bbbbbbbb"): Grant {
  return { id, kind: "write", path, createdAt: CREATED_AT, expiresAt: null };
}

function networkGrant(mode: "localhost" | "all", id = "cccccccc"): Grant {
  return { id, kind: "network", mode, createdAt: CREATED_AT, expiresAt: NETWORK_EXPIRES_AT };
}

interface GrantFixture {
  agentDir: string;
  projectRoot: string;
  realProjectRoot: string;
  storePath: string;
}

function setupStore(): GrantFixture {
  const agentDir = tempDir("seatbelt-agent-");
  const projectRoot = tempDir("seatbelt-project-");
  return {
    agentDir,
    projectRoot,
    realProjectRoot: realpathSync(projectRoot),
    storePath: grantStorePath(agentDir, projectRoot),
  };
}

function writeRawStore(storePath: string, contents: string): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, contents);
}

function readStoreFile(storePath: string): GrantStoreFile {
  return JSON.parse(readFileSync(storePath, "utf8")) as GrantStoreFile;
}

describe("grant store", () => {
  it("writes the store with a 0700 directory and a 0600 file", () => {
    const { agentDir, projectRoot, realProjectRoot, storePath } = setupStore();

    expect(loadGrants(agentDir, projectRoot)).toEqual({ grants: [] });

    saveGrants(agentDir, projectRoot, [readGrant(realProjectRoot)]);

    expect(statSync(dirname(storePath)).mode & 0o777).toBe(0o700);
    expect(statSync(storePath).mode & 0o777).toBe(0o600);
    expect(loadGrants(agentDir, projectRoot).grants.map((grant) => grant.id)).toEqual(["aaaaaaaa"]);
    expect(readStoreFile(storePath)).toEqual({
      version: GRANT_STORE_VERSION,
      projectRoot: realProjectRoot,
      grants: [readGrant(realProjectRoot)],
    });
  });

  it("leaves no temporary file behind after a save or a refused save", () => {
    const { agentDir, projectRoot, storePath } = setupStore();

    saveGrants(agentDir, projectRoot, [readGrant(projectRoot)]);
    expect(readdirSync(dirname(storePath))).toEqual([basename(storePath)]);

    writeRawStore(storePath, "{ nope");
    expect(() => saveGrants(agentDir, projectRoot, [])).toThrow(GrantStoreError);
    expect(readdirSync(dirname(storePath))).toEqual([basename(storePath)]);
  });

  it("issues unique 8-hex ids for a seeded store and keeps them unique on disk", () => {
    const { agentDir, projectRoot, storePath } = setupStore();
    saveGrants(agentDir, projectRoot, [readGrant(join(projectRoot, "seed"), "deadbeef")]);

    let grants = loadGrants(agentDir, projectRoot).grants;
    const ids: string[] = [];
    for (let index = 0; index < 5; index++) {
      const added = addGrant(grants, { kind: "read", path: join(projectRoot, `dir-${index}`) }, projectRoot);
      grants = added.grants;
      ids.push(added.grant.id);
    }

    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{8}$/);
    expect(new Set(ids).size).toBe(ids.length);

    saveGrants(agentDir, projectRoot, grants);
    const storedIds = readStoreFile(storePath).grants.map((grant) => grant.id);
    expect(new Set(storedIds).size).toBe(storedIds.length);
    expect(storedIds).toContain("deadbeef");
  });

  it("stamps network grants with seven days and path grants with no expiry", () => {
    const { projectRoot, realProjectRoot } = setupStore();
    const now = new Date(CREATED_AT);

    const network = addGrant([], { kind: "network", mode: "all" }, projectRoot, now).grant;
    if (network.kind !== "network") throw new Error("expected a network grant");
    expect(network.expiresAt).toBe(NETWORK_EXPIRES_AT);
    expect(Date.parse(String(network.expiresAt)) - Date.parse(network.createdAt)).toBe(7 * 24 * 60 * 60 * 1000);

    const path = addGrant([], { kind: "write", path: "sub/dir" }, projectRoot, now).grant;
    if (path.kind !== "write") throw new Error("expected a write grant");
    expect(path.expiresAt).toBeNull();
    expect(path.path).toBe(join(realProjectRoot, "sub", "dir"));
  });

  it("prunes expired grants on load and on save", () => {
    const { agentDir, projectRoot, realProjectRoot, storePath } = setupStore();
    const expired: Grant = { id: "eeeeeeee", kind: "read", path: "/old", createdAt: "2000-01-01T00:00:00.000Z", expiresAt: "2001-01-01T00:00:00.000Z" };
    const live = readGrant(join(realProjectRoot, "live"), "11111111");

    writeRawStore(storePath, JSON.stringify({ version: GRANT_STORE_VERSION, projectRoot: realProjectRoot, grants: [expired, live] }));
    expect(loadGrants(agentDir, projectRoot).grants.map((grant) => grant.id)).toEqual(["11111111"]);
    // Loading never rewrites the file, so the expired entry is still on disk.
    expect(readStoreFile(storePath).grants).toHaveLength(2);

    saveGrants(agentDir, projectRoot, [expired, live]);
    expect(readStoreFile(storePath).grants.map((grant) => grant.id)).toEqual(["11111111"]);

    const now = new Date("2026-11-26T00:00:00.000Z");
    expect(pruneExpired([expired, live], now).map((grant) => grant.id)).toEqual(["11111111"]);
  });

  it("ignores a store written for another project without rewriting it", () => {
    const { agentDir, projectRoot, storePath } = setupStore();
    const otherProjectRoot = tempDir("seatbelt-other-project-");
    writeRawStore(
      storePath,
      JSON.stringify({ version: GRANT_STORE_VERSION, projectRoot: realpathSync(otherProjectRoot), grants: [readGrant(projectRoot)] }),
    );
    const before = readFileSync(storePath);

    expect(loadGrants(agentDir, projectRoot)).toEqual({ grants: [], warning: "project-mismatch" });
    expect(() => saveGrants(agentDir, projectRoot, [])).toThrow(/seatbelt grants reset/);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  const unusableStores: Array<[string, (realProjectRoot: string) => string, string]> = [
    ["invalid JSON", () => "{ nope", "corrupt"],
    ["a non-object document", () => "[]", "corrupt"],
    ["an unknown version", (realProjectRoot) => JSON.stringify({ version: 2, projectRoot: realProjectRoot, grants: [] }), "version"],
    ["a missing version", (realProjectRoot) => JSON.stringify({ projectRoot: realProjectRoot, grants: [] }), "version"],
    ["a schema violation", (realProjectRoot) => JSON.stringify({ version: 1, projectRoot: realProjectRoot, grants: [{ id: 1, kind: "read" }] }), "corrupt"],
  ];

  it.each(unusableStores)("ignores %s and refuses to write over it", (_name, build, warning) => {
    const { agentDir, projectRoot, realProjectRoot, storePath } = setupStore();
    const contents = build(realProjectRoot);
    writeRawStore(storePath, contents);

    expect(loadGrants(agentDir, projectRoot)).toEqual({ grants: [], warning });
    expect(() => saveGrants(agentDir, projectRoot, [])).toThrow(GrantStoreError);
    expect(() => saveGrants(agentDir, projectRoot, [])).toThrow(/seatbelt grants reset/);
    expect(readFileSync(storePath, "utf8")).toBe(contents);
  });

  it("returns no grants when the store directory is inside the workspace", () => {
    const workspace = tempDir("seatbelt-workspace-");
    const agentDir = join(workspace, "agent");
    const storePath = grantStorePath(agentDir, workspace);
    writeRawStore(storePath, JSON.stringify({ version: GRANT_STORE_VERSION, projectRoot: realpathSync(workspace), grants: [readGrant(workspace)] }));

    expect(loadGrants(agentDir, workspace)).toEqual({ grants: [], warning: "store-inside-workspace" });
    expect(() => saveGrants(agentDir, workspace, [])).toThrow(/store directory is inside the workspace/);
  });

  it("revokes one grant by id and leaves the input untouched", () => {
    const grants = [readGrant("/a", "aaaaaaaa"), readGrant("/b", "bbbbbbbb")];

    expect(revokeGrant(grants, "aaaaaaaa").map((grant) => grant.id)).toEqual(["bbbbbbbb"]);
    expect(revokeGrant(grants, "unknown")).toEqual(grants);
    expect(revokeGrant(grants, "")).toEqual(grants);
    expect(grants).toHaveLength(2);
  });

  it("resolves the store deny path before the directory exists", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const projectRoot = tempDir("seatbelt-project-");

    expect(grantStoreDenyPaths(agentDir)).toEqual([join(realpathSync(agentDir), "extensions", "seatbelt-grants")]);
    expect(grantStoreDenyPaths(agentDir)).toEqual([canon(dirname(grantStorePath(agentDir, projectRoot)))]);
  });
});

describe("grant application", () => {
  it("adds a write grant to both lists and a read grant to readable only", () => {
    const workspace = realpathSync(tempDir("seatbelt-workspace-"));
    const grantedPath = join(workspace, "shared");
    const config: SeatbeltConfig = { ...OPEN_CONFIG, readable: [workspace], writable: [workspace] };

    const once = applyGrants(config, [writeGrant(grantedPath)], workspace);
    expect(once.writable).toEqual([workspace, grantedPath]);
    expect(once.readable).toEqual([workspace, grantedPath]);

    const readOnly = applyGrants(config, [readGrant(join(workspace, "read-only"))], workspace);
    expect(readOnly.readable).toEqual([workspace, join(workspace, "read-only")]);
    expect(readOnly.writable).toEqual([workspace]);

    const twice = applyGrants(once, [writeGrant(grantedPath), readGrant(grantedPath)], workspace);
    expect(twice.readable.filter((entry) => entry === grantedPath)).toHaveLength(1);
    expect(twice.writable.filter((entry) => entry === grantedPath)).toHaveLength(1);
    expect(config.readable).toEqual([workspace]);
  });

  it("widens the network mode and never narrows it", () => {
    const workspace = realpathSync(tempDir("seatbelt-workspace-"));

    expect(applyGrants({ ...OPEN_CONFIG, network: { mode: "localhost" } }, [networkGrant("all")], workspace).network.mode).toBe("all");
    expect(applyGrants({ ...OPEN_CONFIG, network: { mode: "all" } }, [networkGrant("localhost")], workspace).network.mode).toBe("all");
    expect(applyGrants(OPEN_CONFIG, [networkGrant("localhost")], workspace).network.mode).toBe("localhost");
    expect(applyGrants({ ...OPEN_CONFIG, network: { mode: "none" } }, [], workspace).network.mode).toBe("none");
  });

  it("leaves deny lists, environment, enabled, and failClosed untouched", () => {
    const workspace = realpathSync(tempDir("seatbelt-workspace-"));
    const config: SeatbeltConfig = {
      ...OPEN_CONFIG,
      enabled: false,
      failClosed: false,
      denyRead: ["/deny-read"],
      denyWrite: ["/deny-write"],
      environment: { mode: "filtered", deny: ["TOKEN"] },
    };

    const applied = applyGrants(config, [writeGrant(join(workspace, "shared")), networkGrant("all")], workspace);

    expect(applied.denyRead).toEqual(config.denyRead);
    expect(applied.denyWrite).toEqual(config.denyWrite);
    expect(applied.environment).toEqual(config.environment);
    expect(applied.enabled).toBe(false);
    expect(applied.failClosed).toBe(false);
    expect(config.readable).toEqual([]);
    expect(config.writable).toEqual([]);
  });
});

describe("grant target refusals", () => {
  function setupRefusal() {
    const root = realpathSync(tempDir("seatbelt-grant-root-"));
    const agentDir = join(root, "agent");
    const workspace = join(root, "workspace");
    const configDir = join(workspace, ".pi");
    mkdirSync(configDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const trustFile = join(agentDir, "trust.json");
    writeFileSync(trustFile, "{}");
    const protectedPaths: GrantProtectedPaths = {
      agentDir,
      globalConfigPath: join(agentDir, "extensions", "seatbelt.json"),
      storeDir: join(agentDir, "extensions", "seatbelt-grants"),
      configDir,
      trustFile,
      workspace,
    };
    return { root, agentDir, workspace, configDir, trustFile, protectedPaths };
  }

  function denyConfig(root: string): SeatbeltConfig {
    return { ...OPEN_CONFIG, denyRead: [join(root, "denied")], denyWrite: [join(root, "denied-write")] };
  }

  it("R2 refuses a glob target before it is resolved", () => {
    const fixture = setupRefusal();
    const glob = join(fixture.root, "missing-*");

    const result = refuseGrantTarget(glob, OPEN_CONFIG, fixture.protectedPaths);

    expect(result).toMatch(/^R2:/);
    expect(result).toContain(glob);
    expect(refuseGrantTarget(join(fixture.root, "missing?"), OPEN_CONFIG, fixture.protectedPaths)).toMatch(/^R2:/);
  });

  it("R1 refuses a target that does not exist", () => {
    const fixture = setupRefusal();
    const missing = join(fixture.workspace, "missing");

    const result = refuseGrantTarget(missing, OPEN_CONFIG, fixture.protectedPaths);

    expect(result).toMatch(/^R1:/);
    expect(result).toContain(missing);
  });

  it("R3 refuses the filesystem root and the home directory", () => {
    const fixture = setupRefusal();

    expect(refuseGrantTarget("/", OPEN_CONFIG, fixture.protectedPaths)).toMatch(/^R3:/);
    expect(refuseGrantTarget(homedir(), OPEN_CONFIG, fixture.protectedPaths)).toMatch(/^R3:/);
  });

  it("R4 refuses a target equal to, inside, or above a protected location", () => {
    const fixture = setupRefusal();

    const equal = refuseGrantTarget(fixture.agentDir, OPEN_CONFIG, fixture.protectedPaths);
    expect(equal).toMatch(/^R4:/);
    expect(equal).toContain(fixture.agentDir);

    expect(refuseGrantTarget(fixture.trustFile, OPEN_CONFIG, fixture.protectedPaths)).toMatch(/^R4:/);
    expect(refuseGrantTarget(fixture.configDir, OPEN_CONFIG, fixture.protectedPaths)).toMatch(/^R4:/);

    const ancestor = refuseGrantTarget(fixture.root, OPEN_CONFIG, fixture.protectedPaths);
    expect(ancestor).toMatch(/^R4:/);
    expect(ancestor).toContain(fixture.root);
  });

  it("R5 refuses a target equal to, inside, or above a deny path", () => {
    const denyRoot = realpathSync(tempDir("seatbelt-deny-root-"));
    const denied = join(denyRoot, "denied");
    mkdirSync(join(denied, "nested"), { recursive: true });
    mkdirSync(join(denyRoot, "denied-write"), { recursive: true });
    const fixture = setupRefusal();
    const config = denyConfig(denyRoot);

    const equal = refuseGrantTarget(denied, config, fixture.protectedPaths);
    expect(equal).toMatch(/^R5:/);
    expect(equal).toContain(denied);

    expect(refuseGrantTarget(join(denied, "nested"), config, fixture.protectedPaths)).toMatch(/^R5:/);
    expect(refuseGrantTarget(join(denyRoot, "denied-write"), config, fixture.protectedPaths)).toMatch(/^R5:/);

    const ancestor = refuseGrantTarget(denyRoot, config, fixture.protectedPaths);
    expect(ancestor).toMatch(/^R5:/);
    expect(ancestor).toContain(denyRoot);
  });

  it("R6 refuses the workspace and its ancestors when the store lives inside it", () => {
    const workspace = realpathSync(tempDir("seatbelt-workspace-"));
    const agentDir = join(workspace, "agent");
    const protectedPaths: GrantProtectedPaths = {
      agentDir,
      globalConfigPath: join(agentDir, "extensions", "seatbelt.json"),
      storeDir: join(agentDir, "extensions", "seatbelt-grants"),
      configDir: join(workspace, ".pi"),
      trustFile: join(agentDir, "trust.json"),
      workspace,
    };
    mkdirSync(join(workspace, "data"), { recursive: true });

    const equal = refuseGrantTarget(workspace, OPEN_CONFIG, protectedPaths);
    expect(equal).toMatch(/^R6:/);
    expect(equal).toContain(workspace);

    const ancestor = refuseGrantTarget(dirname(workspace), OPEN_CONFIG, protectedPaths);
    expect(ancestor).toMatch(/^R6:/);

    // Descendants of the workspace stay allowed; only its ancestors are refused.
    expect(refuseGrantTarget(join(workspace, "data"), OPEN_CONFIG, protectedPaths)).toBeUndefined();
  });

  it("allows a path grant inside the workspace that no rule protects", () => {
    const fixture = setupRefusal();
    mkdirSync(join(fixture.workspace, "data"), { recursive: true });

    expect(refuseGrantTarget(join(fixture.workspace, "data"), OPEN_CONFIG, fixture.protectedPaths)).toBeUndefined();
  });
});

describe("display helpers", () => {
  it("strips ANSI escapes, newlines, and control characters", () => {
    const raw = "\u001b[31mread\u001b[0m\n/etc\tpasswd\u001b]0;title\u0007";

    const clean = sanitizeForDisplay(raw);

    expect(clean).toBe("read /etc passwd");
    expect(clean).not.toContain("\u001b");
    expect(clean).not.toContain("\n");
    expect(clean).not.toContain("\r");
    expect(sanitizeForDisplay("  spaced\n\n out  ")).toBe("spaced out");
    expect(sanitizeForDisplay("a".repeat(800))).toHaveLength(500);
  });

  it("formats one line per grant with the id as the first token", () => {
    const grants = [readGrant("/opt/shared"), writeGrant("/opt/build"), networkGrant("all")];

    const lines = formatGrantList(grants);

    expect(lines).toEqual([
      "aaaaaaaa  read  /opt/shared  created 2026-11-26T02:00:00.000Z  no expiry",
      "bbbbbbbb  write  /opt/build  created 2026-11-26T02:00:00.000Z  no expiry",
      "cccccccc  network  all  created 2026-11-26T02:00:00.000Z  expires 2026-12-03T02:00:00.000Z",
    ]);
    lines.forEach((line, index) => expect(line.startsWith(`${grants[index].id}  `)).toBe(true));
    expect(formatGrantList([])).toEqual([]);
  });
});
