import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, loadConfig, shallowMergeConfig } from "../src/config.ts";

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

describe("config loading", () => {
  it("shallow-merges top-level config and nested network settings", () => {
    const merged = shallowMergeConfig(DEFAULT_CONFIG, {
      enabled: false,
      network: { mode: "all" },
      readable: ["/custom-read"],
    });

    expect(merged.enabled).toBe(false);
    expect(merged.failClosed).toBe(DEFAULT_CONFIG.failClosed);
    expect(merged.network.mode).toBe("all");
    expect(merged.readable).toEqual(["/custom-read"]);
    expect(merged.writable).toBe(DEFAULT_CONFIG.writable);
  });

  it("loads global config and lets project config override it", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const workspace = tempDir("seatbelt-workspace-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    writeFileSync(
      join(agentDir, "extensions", "seatbelt.json"),
      JSON.stringify({ failClosed: false, readable: ["${WORKSPACE}/global-read"], writable: ["${WORKSPACE}/global-write"], network: { mode: "all" } }),
    );

    mkdirSync(join(workspace, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(
      join(workspace, CONFIG_DIR_NAME, "seatbelt.json"),
      JSON.stringify({ readable: ["${WORKSPACE}/project-read"], network: { mode: "none" } }),
    );

    const loaded = loadConfig(workspace);

    expect(loaded.failClosed).toBe(false);
    expect(loaded.network.mode).toBe("none");
    const realWorkspace = realpathSync(workspace);
    expect(loaded.readable).toEqual([join(realWorkspace, "project-read")]);
    expect(loaded.writable).toEqual([join(realWorkspace, "global-write")]);
  });

  it("ignores malformed override files and keeps defaults", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const workspace = tempDir("seatbelt-workspace-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    mkdirSync(join(workspace, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(workspace, CONFIG_DIR_NAME, "seatbelt.json"), "{ nope");

    const loaded = loadConfig(workspace);

    expect(loaded.enabled).toBe(DEFAULT_CONFIG.enabled);
    expect(loaded.failClosed).toBe(DEFAULT_CONFIG.failClosed);
    expect(loaded.network.mode).toBe(DEFAULT_CONFIG.network.mode);
    expect(loaded.readable).toContain(realpathSync(workspace));
  });
});
