import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import type { SeatbeltConfig } from "./config.ts";

export interface PathPolicy {
  cwd: string;
  readable: PathRule[];
  writable: PathRule[];
  denyRead: PathRule[];
  denyWrite: PathRule[];
}

interface PathRule {
  raw: string;
  value: string;
  glob: boolean;
  regex?: RegExp;
  prefix?: string;
}

export function canon(path: string, cwd = process.cwd()): string {
  const abs = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(canon(parent, cwd), basename(abs));
  }
}

export function isInside(child: string, root: string): boolean {
  const c = stripTrailingSep(child);
  const r = stripTrailingSep(root);
  if (r === sep) return c.startsWith(sep);
  return c === r || c.startsWith(r + sep);
}

function stripTrailingSep(path: string): string {
  if (path === sep) return path;
  return path.endsWith(sep) ? path.slice(0, -1) : path;
}

function containsGlob(path: string): boolean {
  return /[*?[]/.test(path);
}

function normalizeForRegex(path: string): string {
  return path.split(sep).join("/");
}

function globToRegex(pattern: string): RegExp {
  const p = normalizeForRegex(pattern);
  let out = "^";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    const next = p[i + 1];
    if (ch === "*" && next === "*") {
      const after = p[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (ch === "*") {
      out += "[^/]*";
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += ch.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  out += "$";
  return new RegExp(out);
}

function splitGlobPattern(pattern: string, cwd: string): { abs: string; prefix: string; remainder: string[] } {
  const abs = isAbsolute(pattern) ? resolve(pattern) : resolve(cwd, pattern);
  const parts = abs.split(sep);
  const prefixParts: string[] = [];
  let firstGlob = parts.length;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === "") {
      prefixParts.push(part);
      continue;
    }
    if (containsGlob(part)) {
      firstGlob = i;
      break;
    }
    prefixParts.push(part);
  }
  const rawPrefix = prefixParts.length <= 1 ? sep : prefixParts.join(sep);
  return { abs, prefix: canon(rawPrefix, cwd), remainder: parts.slice(firstGlob) };
}

function canonicalizeGlobPattern(pattern: string, cwd: string): { value: string; prefix: string } {
  const { prefix, remainder } = splitGlobPattern(pattern, cwd);
  return { prefix, value: remainder.length === 0 ? prefix : join(prefix, ...remainder) };
}

function makeRule(path: string, cwd: string): PathRule {
  if (containsGlob(path)) {
    const { value, prefix } = canonicalizeGlobPattern(path, cwd);
    return {
      raw: path,
      value,
      glob: true,
      regex: globToRegex(value),
      prefix,
    };
  }
  return { raw: path, value: canon(path, cwd), glob: false };
}

export function buildPolicy(config: Pick<SeatbeltConfig, "readable" | "writable" | "denyRead" | "denyWrite">, cwd: string): PathPolicy {
  return {
    cwd: canon(cwd),
    readable: config.readable.map((path) => makeRule(path, cwd)),
    writable: config.writable.map((path) => makeRule(path, cwd)),
    denyRead: config.denyRead.map((path) => makeRule(path, cwd)),
    denyWrite: config.denyWrite.map((path) => makeRule(path, cwd)),
  };
}

function matchesRule(path: string, rule: PathRule): boolean {
  if (rule.glob) {
    const normalized = normalizeForRegex(path);
    return Boolean(rule.regex?.test(normalized));
  }
  return isInside(path, rule.value);
}

function assertAllowed(path: string, policy: PathPolicy, denyRules: PathRule[], allowRules: PathRule[], mode: "read" | "write"): void {
  const target = canon(path, policy.cwd);
  const deny = denyRules.find((rule) => matchesRule(target, rule));
  if (deny) throw new Error(`seatbelt policy blocked ${mode} for ${target}: denied by ${deny.raw}`);
  if (!allowRules.some((rule) => matchesRule(target, rule))) {
    throw new Error(`seatbelt policy blocked ${mode} for ${target}: outside allowed roots`);
  }
}

export function assertCanRead(path: string, policy: PathPolicy): void {
  assertAllowed(path, policy, policy.denyRead, policy.readable, "read");
}

export function assertCanWrite(path: string, policy: PathPolicy): void {
  assertAllowed(path, policy, policy.denyWrite, policy.writable, "write");
}
