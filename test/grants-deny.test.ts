import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { composeConfig, loadBaseConfig, loadProjectOverride, type SeatbeltConfig } from "../src/config.ts";
import { applyGrantStoreDeny, grantStoreDenyPaths } from "../src/grants.ts";
import { assertCanRead, assertCanWrite, buildPolicy } from "../src/policy.ts";
import { renderSeatbeltProfile } from "../src/seatbelt.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let tempDirs: string[] = [];

afterEach(() => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;

  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  agentDir: string;
  workspace: string;
}

/** Create a temp agent dir (injected via the env var) and a temp workspace. */
function fixture(): Fixture {
  const agentDir = tempDir("seatbelt-agent-");
  const workspace = tempDir("seatbelt-workspace-");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  return { agentDir, workspace };
}

function writeGlobalConfig(agentDir: string, config: Record<string, unknown>): void {
  writeFileSync(join(agentDir, "extensions", "seatbelt.json"), JSON.stringify(config));
}

function writeProjectConfig(workspace: string, config: Record<string, unknown>): void {
  mkdirSync(join(workspace, CONFIG_DIR_NAME), { recursive: true });
  writeFileSync(join(workspace, CONFIG_DIR_NAME, "seatbelt.json"), JSON.stringify(config));
}

/** The canonical store directory the deny must name. */
function storeDirOf(agentDir: string): string {
  return grantStoreDenyPaths(agentDir)[0];
}

/** Compose exactly like `rebuildConfig()` in index.ts. */
function composeFor({ workspace }: Fixture): SeatbeltConfig {
  const projectConfigPath = join(workspace, CONFIG_DIR_NAME, "seatbelt.json");
  const base = loadBaseConfig(workspace);
  const composed = composeConfig(base, loadProjectOverride(workspace), [], workspace, projectConfigPath);
  return applyGrantStoreDeny(composed, getAgentDir());
}

function profileOptions(config: SeatbeltConfig) {
  return {
    readable: config.readable,
    writable: config.writable,
    denyRead: config.denyRead,
    denyWrite: config.denyWrite,
    network: config.network.mode,
  };
}

function expectStoreDeniedOnce(config: SeatbeltConfig, storeDir: string): void {
  expect(config.denyRead.filter((path) => path === storeDir)).toHaveLength(1);
  expect(config.denyWrite.filter((path) => path === storeDir)).toHaveLength(1);
}

/** Text of the rule block that starts with `marker` (blocks end with "\n)"). */
function block(profile: string, marker: string): string {
  const start = profile.indexOf(marker);
  expect(start, `missing block ${marker}`).toBeGreaterThanOrEqual(0);
  const end = profile.indexOf("\n)", start);
  expect(end, `unterminated block ${marker}`).toBeGreaterThan(start);
  return profile.slice(start, end + 2);
}

function indicesOf(haystack: string, needle: string): number[] {
  const found: number[] = [];
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    found.push(index);
    index = haystack.indexOf(needle, index + needle.length);
  }
  return found;
}

describe("grant store deny", () => {
  it("adds the canonical store directory to both deny lists exactly once", () => {
    const fixtureA = fixture();
    const storeDir = storeDirOf(fixtureA.agentDir);

    const config = composeFor(fixtureA);

    expectStoreDeniedOnce(config, storeDir);
    expect(config.denyRead.at(-1)).toBe(storeDir);
    expect(config.denyWrite.at(-1)).toBe(storeDir);
    // Appending must not disturb the earlier entries or any other field.
    const base = loadBaseConfig(fixtureA.workspace);
    expect(config.denyRead.slice(0, base.denyRead.length)).toEqual(base.denyRead);
    expect(config.denyWrite.slice(0, base.denyWrite.length)).toEqual(base.denyWrite);
    expect(config.readable).toEqual(base.readable);
    expect(config.writable).toEqual(base.writable);
    expect(config.network).toEqual(base.network);
  });

  it("deduplicates the store deny when a global config layer already denies it", () => {
    const fixtureA = fixture();
    const storeDir = storeDirOf(fixtureA.agentDir);
    writeGlobalConfig(fixtureA.agentDir, { denyRead: [storeDir], denyWrite: [storeDir] });

    const config = composeFor(fixtureA);

    expectStoreDeniedOnce(config, storeDir);
  });

  it("deduplicates the store deny when a project config layer already denies it", () => {
    const fixtureA = fixture();
    const storeDir = storeDirOf(fixtureA.agentDir);
    writeProjectConfig(fixtureA.workspace, { denyRead: [storeDir], denyWrite: [storeDir] });

    const config = composeFor(fixtureA);

    expectStoreDeniedOnce(config, storeDir);
  });

  it("denies store files in the path policy while workspace paths stay allowed", () => {
    const fixtureA = fixture();
    writeFileSync(join(fixtureA.workspace, "other.txt"), "other");
    const storeDir = storeDirOf(fixtureA.agentDir);
    const config = composeFor(fixtureA);
    const policy = buildPolicy(config, fixtureA.workspace);

    expect(() => assertCanRead(join(storeDir, "x.json"), policy)).toThrow(/denied/);
    expect(() => assertCanWrite(join(storeDir, "x.json"), policy)).toThrow(/denied/);
    expect(() => assertCanRead(join(fixtureA.workspace, "other.txt"), policy)).not.toThrow();
    expect(() => assertCanWrite(join(fixtureA.workspace, "other.txt"), policy)).not.toThrow();
  });

  it("renders the store subpath inside the file-read and file-write deny blocks", () => {
    const fixtureA = fixture();
    const storeDir = storeDirOf(fixtureA.agentDir);
    const profile = renderSeatbeltProfile(profileOptions(composeFor(fixtureA)));
    const subpath = `(subpath ${JSON.stringify(storeDir)})`;

    expect(block(profile, "(deny file-read*")).toContain(subpath);
    expect(block(profile, "(deny file-write*")).toContain(subpath);
  });

  it("renders every deny block after every allow block", () => {
    const fixtureA = fixture();
    const profile = renderSeatbeltProfile(profileOptions(composeFor(fixtureA)));

    const allowIndices = [...indicesOf(profile, "(allow file-read*"), ...indicesOf(profile, "(allow file-write*")];
    const denyIndices = [...indicesOf(profile, "(deny file-read*"), ...indicesOf(profile, "(deny file-write*")];

    // Negative control: vacuous parsing must fail instead of passing silently.
    expect(allowIndices.length).toBeGreaterThanOrEqual(2);
    expect(denyIndices.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...denyIndices)).toBeGreaterThan(Math.max(...allowIndices));
  });

  it("denies only the store subtree when the store sits inside the workspace", () => {
    const workspace = tempDir("seatbelt-workspace-");
    const agentDir = join(workspace, "agent");
    mkdirSync(join(agentDir, "extensions", "seatbelt-grants"), { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const sibling = tempDir("seatbelt-sibling-");
    writeGlobalConfig(agentDir, {
      readable: ["${WORKSPACE}", sibling],
      writable: ["${WORKSPACE}", sibling],
    });
    writeFileSync(join(workspace, "other.txt"), "other");
    writeFileSync(join(sibling, "sibling.txt"), "sibling");

    const storeDir = storeDirOf(agentDir);
    expect(storeDir.startsWith(realpathSync(workspace))).toBe(true);
    const config = composeFor({ agentDir, workspace });
    expectStoreDeniedOnce(config, storeDir);
    const policy = buildPolicy(config, workspace);

    expect(() => assertCanRead(join(storeDir, "x.json"), policy)).toThrow(/denied/);
    expect(() => assertCanWrite(join(storeDir, "x.json"), policy)).toThrow(/denied/);
    expect(() => assertCanRead(join(workspace, "other.txt"), policy)).not.toThrow();
    expect(() => assertCanWrite(join(workspace, "other.txt"), policy)).not.toThrow();
    expect(() => assertCanRead(join(sibling, "sibling.txt"), policy)).not.toThrow();
    expect(() => assertCanWrite(join(sibling, "sibling.txt"), policy)).not.toThrow();
  });
});
