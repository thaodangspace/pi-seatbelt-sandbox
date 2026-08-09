import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

function setupConfig(globalConfig: Record<string, unknown>, projectConfig?: Record<string, unknown>): string {
  const agentDir = tempDir("seatbelt-agent-");
  const workspace = tempDir("seatbelt-workspace-");
  process.env.PI_CODING_AGENT_DIR = agentDir;

  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "seatbelt.json"), JSON.stringify(globalConfig));
  if (projectConfig !== undefined) {
    mkdirSync(join(workspace, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(workspace, CONFIG_DIR_NAME, "seatbelt.json"), JSON.stringify(projectConfig));
  }
  return workspace;
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

  it("applies project config as a restriction-only layer", () => {
    const workspace = setupConfig(
      { failClosed: false, readable: ["${WORKSPACE}"], writable: ["${WORKSPACE}"], denyRead: ["${WORKSPACE}/global-secret"], denyWrite: ["${WORKSPACE}/global-protected"], network: { mode: "all" } },
      { failClosed: true, readable: ["${WORKSPACE}/src"], writable: ["${WORKSPACE}/build"], denyRead: ["${WORKSPACE}/project-secret"], denyWrite: ["${WORKSPACE}/project-protected"], network: { mode: "none" } },
    );

    const loaded = loadConfig(workspace);
    const realWorkspace = realpathSync(workspace);

    expect(loaded.failClosed).toBe(true);
    expect(loaded.network.mode).toBe("none");
    expect(loaded.readable).toEqual([join(realWorkspace, "src")]);
    expect(loaded.writable).toEqual([join(realWorkspace, "build")]);
    expect(loaded.denyRead).toEqual([join(realWorkspace, "global-secret"), join(realWorkspace, "project-secret")]);
    expect(loaded.denyWrite).toEqual([join(realWorkspace, "global-protected"), join(realWorkspace, "project-protected")]);
  });

  it.each([
    ["enabled", { enabled: true }, { enabled: false }, /cannot disable a globally enabled sandbox/],
    ["failClosed", { failClosed: true }, { failClosed: false }, /cannot disable global fail-closed behavior/],
    ["network none -> all", { network: { mode: "none" } }, { network: { mode: "all" } }, /widen network mode from none to all/],
    ["network localhost -> all", { network: { mode: "localhost" } }, { network: { mode: "all" } }, /widen network mode from localhost to all/],
  ] as const)("rejects project widening for %s", (_name, globalConfig, projectConfig, expected) => {
    const workspace = setupConfig(globalConfig, projectConfig);
    expect(() => loadConfig(workspace)).toThrow(expected);
  });

  it("rejects non-existent project paths escaping through a symlink", () => {
    const workspace = setupConfig(
      { writable: ["${WORKSPACE}/trusted"] },
      { writable: ["${WORKSPACE}/trusted/link/new"] },
    );
    const outside = tempDir("seatbelt-outside-");
    mkdirSync(join(workspace, "trusted"));
    symlinkSync(outside, join(workspace, "trusted", "link"));

    expect(() => loadConfig(workspace)).toThrow(/outside the trusted global allowance/);
  });

  it.each(["readable", "writable"] as const)("rejects converting a global %s glob into a project subtree", (key) => {
    const workspace = setupConfig(
      { [key]: ["${WORKSPACE}/build/*"] },
      { [key]: ["${WORKSPACE}/build/pkg"] },
    );

    expect(() => loadConfig(workspace)).toThrow(/outside the trusted global allowance/);
  });

  it("allows stricter network mode and rejects filesystem widening", () => {
    const workspace = setupConfig(
      { readable: ["${WORKSPACE}/trusted"], writable: ["${WORKSPACE}/trusted"], network: { mode: "all" } },
      { readable: ["${WORKSPACE}"], writable: ["${WORKSPACE}/outside"], network: { mode: "localhost" } },
    );

    expect(() => loadConfig(workspace)).toThrow(/outside the trusted global allowance/);

    const validWorkspace = setupConfig(
      { readable: ["${WORKSPACE}"], writable: ["${WORKSPACE}"], network: { mode: "all" } },
      { readable: ["${WORKSPACE}/src"], writable: ["${WORKSPACE}/build"], network: { mode: "localhost" } },
    );
    const loaded = loadConfig(validWorkspace);
    expect(loaded.network.mode).toBe("localhost");
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
