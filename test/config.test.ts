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

  it.each([
    ["invalid JSON", "{ nope", /invalid JSON/],
    ["non-object root", "[]", /configuration must be an object/],
    ["unknown key", '{"unknown":true}', /unknown key unknown/],
    ["invalid path list", '{"writable":"workspace"}', /writable must be an array of strings/],
    ["network string", '{"network":"none"}', /network must be an object/],
    ["network null", '{"network":null}', /network must be an object/],
    ["unknown network key", '{"network":{"mode":"none","extra":true}}', /unknown network key extra/],
    ["unsupported network mode", '{"network":{"mode":"internet"}}', /network\.mode must be one of/],
  ])("fails closed for %s project overrides", (_name, contents, expected) => {
    const agentDir = tempDir("seatbelt-agent-");
    const workspace = tempDir("seatbelt-workspace-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    mkdirSync(join(workspace, CONFIG_DIR_NAME), { recursive: true });
    const path = join(workspace, CONFIG_DIR_NAME, "seatbelt.json");
    writeFileSync(path, contents);

    expect(() => loadConfig(workspace)).toThrow(expected);
    expect(() => loadConfig(workspace)).toThrow(path);
  });

  it("fails closed when an existing override cannot be read", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const workspace = tempDir("seatbelt-workspace-");
    process.env.PI_CODING_AGENT_DIR = agentDir;

    mkdirSync(join(workspace, CONFIG_DIR_NAME, "seatbelt.json"), { recursive: true });
    const path = join(workspace, CONFIG_DIR_NAME, "seatbelt.json");

    expect(() => loadConfig(workspace)).toThrow(/could not read configuration/);
    expect(() => loadConfig(workspace)).toThrow(path);
  });
});
