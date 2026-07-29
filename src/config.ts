import { readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import type { NetworkMode } from "./seatbelt.ts";

export interface SeatbeltConfig {
  enabled: boolean;
  failClosed: boolean;
  readable: string[];
  writable: string[];
  denyRead: string[];
  denyWrite: string[];
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
  network: { mode: "localhost" },
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(`pi-seatbelt-sandbox config error: ${message}`);
  }
}

type ConfigOverride = Partial<SeatbeltConfig>;

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
    network: { ...base.network, ...(override.network ?? {}) },
  };
}

const OVERRIDE_KEYS = new Set(["enabled", "failClosed", "readable", "writable", "denyRead", "denyWrite", "network"]);
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

  const merged = shallowMergeConfig(shallowMergeConfig(DEFAULT_CONFIG, readOverride(globalPath)), readOverride(projectPath));
  return expandConfig(merged, cwd);
}
