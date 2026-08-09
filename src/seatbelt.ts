import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

export type NetworkMode = "none" | "localhost" | "all";

export interface SeatbeltProfileOptions {
  readable: string[];
  writable: string[];
  denyRead: string[];
  denyWrite: string[];
  network: NetworkMode;
}

export interface ProfileFile {
  path: string;
  dispose(): Promise<void>;
}

function hasGlob(path: string): boolean {
  return /[*?]/.test(path);
}

export function canonicalPath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(canonicalPath(parent), basename(abs));
  }
}

function subpath(path: string): string {
  return `(subpath ${JSON.stringify(canonicalPath(path))})`;
}

function renderRule(kind: "allow" | "deny", operation: "file-read*" | "file-write*", paths: string[]): string {
  const usable = paths.filter((path) => !hasGlob(path));
  if (usable.length === 0) return "";
  const body = usable.map((path) => `  ${subpath(path)}`).join("\n");
  return `(${kind} ${operation}\n${body}\n)`;
}

function renderScratchRule(): string {
  return `(allow file-read* file-write*\n  (subpath "/private/tmp")\n  (subpath "/private/var/tmp")\n  (subpath "/private/var/folders")\n)`;
}

function renderNetworkRules(mode: NetworkMode): string {
  switch (mode) {
    case "all":
      return `(allow network*)`;
    case "none":
      return "";
    case "localhost":
      return `(allow network-outbound (remote ip "localhost:*"))\n(allow network-inbound (local ip "localhost:*"))`;
  }
}

export function renderSeatbeltProfile(o: SeatbeltProfileOptions, protectedProfileDirectory?: string): string {
  const allows = [
    renderRule("allow", "file-read*", o.readable),
    renderRule("allow", "file-write*", o.writable),
    renderScratchRule(),
  ].filter(Boolean);
  const denies = [renderRule("deny", "file-read*", o.denyRead), renderRule("deny", "file-write*", o.denyWrite)].filter(Boolean);
  const profileProtection = protectedProfileDirectory
    ? `(deny file-write*\n  ${subpath(protectedProfileDirectory)}\n)`
    : "";
  const network = renderNetworkRules(o.network);

  return [
    `(version 1)`,
    `(deny default)`,
    ``,
    `(import "bsd.sb")`,
    ``,
    `(allow process-fork)`,
    `(allow process-exec)`,
    `(allow signal (target self))`,
    `;; Process inspection can expose the parent Pi environment on macOS.`,
    `(deny process-info*)`,
    `(allow process-info* (target self))`,
    `;; Do not grant blanket sysctl access; it can expose process arguments.`,
    ``,
    `;; Explicit filesystem allows.`,
    ...allows,
    ``,
    `;; Deny rules are intentionally last among filesystem rules (Seatbelt is last-match-wins).`,
    ...denies,
    `;; The reusable profile must remain immutable to sandboxed commands.`,
    profileProtection,
    ``,
    `;; Network policy.`,
    network,
    ``,
  ]
    .filter((line, index, lines) => !(line === "" && lines[index - 1] === ""))
    .join("\n");
}

export async function createProfileFile(o: SeatbeltProfileOptions): Promise<ProfileFile> {
  const dir = await mkdtemp(join(tmpdir(), "pi-seatbelt-"));
  await chmod(dir, 0o700);
  const path = join(dir, "profile.sb");
  await writeFile(path, renderSeatbeltProfile(o, dir), { mode: 0o600 });
  await chmod(path, 0o600);

  let disposed = false;
  return {
    path,
    async dispose() {
      if (disposed) return;
      disposed = true;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
