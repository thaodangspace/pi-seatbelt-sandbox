import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { canon } from "./policy.ts";
import type { EnvironmentMode } from "./environment.ts";
import type { NetworkMode } from "./seatbelt.ts";

export interface SeatbeltConfig {
  enabled: boolean;
  failClosed: boolean;
  readable: string[];
  writable: string[];
  denyRead: string[];
  denyWrite: string[];
  environment: { mode: EnvironmentMode; deny: string[] };
  network: { mode: NetworkMode };
}

export const DEFAULT_CONFIG: SeatbeltConfig = {
  enabled: true,
  failClosed: true,
  readable: [
    "${WORKSPACE}",
    "/bin",
    "/sbin",
    "/usr",
    "/System",
    "/Library",
    "/Applications/Xcode.app",
    "/Applications/Xcode-beta.app",
    "/opt/homebrew",
    "/usr/local",
    "/etc",
    "/private/etc",
    "/dev/null",
    "/dev/urandom",
  ],
  writable: ["${WORKSPACE}", "${TMPDIR}"],
  denyRead: [
    "${HOME}/.ssh",
    "${HOME}/.aws",
    "${HOME}/.gnupg",
    "${HOME}/.config/gcloud",
    "${HOME}/.netrc",
    "${HOME}/.git-credentials",
  ],
  denyWrite: ["${WORKSPACE}/.git/hooks", "${WORKSPACE}/.env", "${WORKSPACE}/.env.local"],
  environment: { mode: "inherit", deny: [] },
  network: { mode: "localhost" },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(`pi-seatbelt-sandbox config error: ${message}`);
  }
}

type ConfigOverride = Omit<Partial<SeatbeltConfig>, "environment" | "network"> & {
  environment?: Partial<SeatbeltConfig["environment"]>;
  network?: Partial<SeatbeltConfig["network"]>;
};

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function shallowMergeConfig(base: SeatbeltConfig, override: ConfigOverride): SeatbeltConfig {
  return {
    ...base,
    enabled: override.enabled ?? base.enabled,
    failClosed: override.failClosed ?? base.failClosed,
    readable: override.readable ?? base.readable,
    writable: override.writable ?? base.writable,
    denyRead: override.denyRead ?? base.denyRead,
    denyWrite: override.denyWrite ?? base.denyWrite,
    environment: { ...base.environment, ...(override.environment ?? {}) },
    network: { ...base.network, ...(override.network ?? {}) },
  };
}

const OVERRIDE_KEYS = new Set(["enabled", "failClosed", "readable", "writable", "denyRead", "denyWrite", "environment", "network"]);
const ENVIRONMENT_KEYS = new Set(["mode", "deny"]);
const NETWORK_KEYS = new Set(["mode"]);

function configError(path: string, message: string): ConfigError {
  return new ConfigError(`${path}: ${message}`);
}

function validateOverride(raw: unknown, path: string): ConfigOverride {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw configError(path, "configuration must be an object");
  }

  const value = raw as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!OVERRIDE_KEYS.has(key)) throw configError(path, `unknown key ${key}`);
  }

  if ("enabled" in value && typeof value.enabled !== "boolean") throw configError(path, "enabled must be a boolean");
  if ("failClosed" in value && typeof value.failClosed !== "boolean") throw configError(path, "failClosed must be a boolean");
  for (const key of ["readable", "writable", "denyRead", "denyWrite"] as const) {
    if (key in value) {
      if (!Array.isArray(value[key]) || !value[key].every((item) => typeof item === "string")) {
        throw configError(path, `${key} must be an array of strings`);
      }
    }
  }

  if ("environment" in value) {
    const environment = value.environment;
    if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
      throw configError(path, "environment must be an object");
    }
    const environmentValue = environment as Record<string, unknown>;
    for (const key of Object.keys(environmentValue)) {
      if (!ENVIRONMENT_KEYS.has(key)) throw configError(path, `unknown environment key ${key}`);
    }
    if ("mode" in environmentValue && environmentValue.mode !== "inherit" && environmentValue.mode !== "filtered") {
      throw configError(path, 'environment.mode must be one of "inherit" or "filtered"');
    }
    if ("deny" in environmentValue && (!Array.isArray(environmentValue.deny) || !environmentValue.deny.every((item) => typeof item === "string"))) {
      throw configError(path, "environment.deny must be an array of strings");
    }
  }

  if ("network" in value) {
    const network = value.network;
    if (typeof network !== "object" || network === null || Array.isArray(network)) {
      throw configError(path, "network must be an object");
    }
    const networkValue = network as Record<string, unknown>;
    for (const key of Object.keys(networkValue)) {
      if (!NETWORK_KEYS.has(key)) throw configError(path, `unknown network key ${key}`);
    }
    if (networkValue.mode !== "none" && networkValue.mode !== "localhost" && networkValue.mode !== "all") {
      throw configError(path, 'network.mode must be one of "none", "localhost", or "all"');
    }
  }

  return value as ConfigOverride;
}

function readOverride(path: string): ConfigOverride {
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw configError(path, `could not read configuration: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    return validateOverride(JSON.parse(contents), path);
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw configError(path, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ConfigError(`${name} must be an array of strings`);
  }
  return value;
}

function validateConfigShape(config: SeatbeltConfig): void {
  if (typeof config.enabled !== "boolean") throw new ConfigError("enabled must be a boolean");
  if (typeof config.failClosed !== "boolean") throw new ConfigError("failClosed must be a boolean");
  assertStringArray(config.readable, "readable");
  assertStringArray(config.writable, "writable");
  assertStringArray(config.denyRead, "denyRead");
  assertStringArray(config.denyWrite, "denyWrite");
  if (!config.environment || !["inherit", "filtered"].includes(config.environment.mode)) {
    throw new ConfigError('environment.mode must be one of "inherit" or "filtered"');
  }
  assertStringArray(config.environment.deny, "environment.deny");
  if (!config.network || !["none", "localhost", "all"].includes(config.network.mode)) {
    throw new ConfigError('network.mode must be one of "none", "localhost", or "all"');
  }
}

export interface ExpansionContext {
  cwd: string;
}

export function expandConfigPath(input: string, ctx: ExpansionContext): string {
  const workspace = realpathOrResolve(ctx.cwd);
  const values: Record<string, string> = {
    WORKSPACE: workspace,
    HOME: homedir(),
    TMPDIR: realpathOrResolve(tmpdir()),
  };

  const expanded = input.replace(/\$\{([^}]+)\}/g, (match, key: string) => {
    const value = values[key];
    if (value === undefined) throw new ConfigError(`unknown variable ${match} in path ${input}`);
    return value;
  });

  return isAbsolute(expanded) ? resolve(expanded) : resolve(workspace, expanded);
}

const ENVIRONMENT_STRICTNESS: Record<EnvironmentMode, number> = {
  filtered: 0,
  inherit: 1,
};

const NETWORK_STRICTNESS: Record<NetworkMode, number> = {
  none: 0,
  localhost: 1,
  all: 2,
};

function containsGlob(path: string): boolean {
  return /[*?]/.test(path);
}

function globPrefix(path: string, cwd: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const parts = absolute.split(sep);
  const prefix: string[] = [];
  for (const part of parts) {
    if (part === "") {
      prefix.push(part);
      continue;
    }
    if (containsGlob(part)) break;
    prefix.push(part);
  }
  return canon(prefix.length <= 1 ? sep : prefix.join(sep), cwd);
}

function isInsidePath(child: string, root: string): boolean {
  const normalizedChild = child === sep ? sep : child.endsWith(sep) ? child.slice(0, -1) : child;
  const normalizedRoot = root === sep ? sep : root.endsWith(sep) ? root.slice(0, -1) : root;
  return normalizedRoot === sep
    ? normalizedChild.startsWith(sep)
    : normalizedChild === normalizedRoot || normalizedChild.startsWith(`${normalizedRoot}${sep}`);
}

function projectPathCovered(projectPath: string, basePath: string, cwd: string): boolean {
  const projectGlob = containsGlob(projectPath);
  const baseGlob = containsGlob(basePath);

  // A glob-to-glob subset check is deliberately conservative. An exact match
  // is safe; otherwise a project glob could hide a widening in the base glob.
  if (baseGlob && projectGlob) return projectPath === basePath;
  // A global glob is intentionally not treated as an OS-enforced subtree
  // allowance. Project non-glob rules would be emitted as Seatbelt subpaths,
  // which could turn a Layer-B match into a broader Layer-A privilege.
  if (baseGlob) return false;
  if (projectGlob) return isInsidePath(globPrefix(projectPath, cwd), canon(basePath, cwd));
  return isInsidePath(canon(projectPath, cwd), canon(basePath, cwd));
}

function expandedRestrictionPaths(paths: string[], cwd: string, sourcePath: string, key: string): string[] {
  try {
    return paths.map((path) => expandConfigPath(path, { cwd }));
  } catch (error) {
    throw configError(sourcePath, `${key} contains an invalid path: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assertProjectPathsDoNotWiden(base: SeatbeltConfig, override: ConfigOverride, cwd: string, sourcePath: string): void {
  for (const key of ["readable", "writable"] as const) {
    if (override[key] === undefined) continue;
    const basePaths = expandedRestrictionPaths(base[key], cwd, sourcePath, key);
    const projectPaths = expandedRestrictionPaths(override[key], cwd, sourcePath, key);
    for (const projectPath of projectPaths) {
      if (!basePaths.some((basePath) => projectPathCovered(projectPath, basePath, cwd))) {
        throw configError(sourcePath, `project ${key} path ${projectPath} is outside the trusted global allowance`);
      }
    }
  }
}

/** Apply a project config as a restriction-only layer over trusted config. */
export function applyProjectRestrictions(
  base: SeatbeltConfig,
  override: ConfigOverride,
  cwd: string,
  sourcePath = "project configuration",
): SeatbeltConfig {
  if (base.enabled && override.enabled === false) {
    throw configError(sourcePath, "project configuration cannot disable a globally enabled sandbox");
  }
  if (base.failClosed && override.failClosed === false) {
    throw configError(sourcePath, "project configuration cannot disable global fail-closed behavior");
  }
  if (override.environment && override.environment.mode !== undefined && ENVIRONMENT_STRICTNESS[override.environment.mode] > ENVIRONMENT_STRICTNESS[base.environment.mode]) {
    throw configError(sourcePath, `project seatbelt config attempted to widen environment mode from ${base.environment.mode} to ${override.environment.mode}`);
  }
  if (override.network?.mode !== undefined && NETWORK_STRICTNESS[override.network.mode] > NETWORK_STRICTNESS[base.network.mode]) {
    throw configError(sourcePath, `project seatbelt config attempted to widen network mode from ${base.network.mode} to ${override.network.mode}`);
  }

  assertProjectPathsDoNotWiden(base, override, cwd, sourcePath);
  return {
    ...base,
    enabled: override.enabled ?? base.enabled,
    failClosed: override.failClosed ?? base.failClosed,
    readable: override.readable ?? base.readable,
    writable: override.writable ?? base.writable,
    denyRead: [...base.denyRead, ...(override.denyRead ?? [])],
    denyWrite: [...base.denyWrite, ...(override.denyWrite ?? [])],
    environment: {
      mode: override.environment?.mode ?? base.environment.mode,
      deny: [...base.environment.deny, ...(override.environment?.deny ?? [])],
    },
    network: { mode: override.network?.mode ?? base.network.mode },
  };
}

export function expandConfig(config: SeatbeltConfig, cwd: string): SeatbeltConfig {
  validateConfigShape(config);
  const expandList = (items: string[]) => items.map((item) => expandConfigPath(item, { cwd }));
  return {
    ...config,
    readable: expandList(config.readable),
    writable: expandList(config.writable),
    denyRead: expandList(config.denyRead),
    denyWrite: expandList(config.denyWrite),
    network: { mode: config.network.mode },
  };
}

export function loadConfig(cwd: string): SeatbeltConfig {
  const projectPath = join(cwd, CONFIG_DIR_NAME, "seatbelt.json");
  const globalPath = join(getAgentDir(), "extensions", "seatbelt.json");

  const base = shallowMergeConfig(DEFAULT_CONFIG, readOverride(globalPath));
  const effective = applyProjectRestrictions(base, readOverride(projectPath), cwd, projectPath);
  return expandConfig(effective, cwd);
}
