import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addGrant, grantStorePath, saveGrants, type Grant } from "../src/grants.ts";
import type { ProfileFile } from "../src/seatbelt.ts";
import { SANDBOX_EXEC_PATH } from "../src/sandbox-exec.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const originalProfilePath = process.env.PI_SEATBELT_PROFILE;
const originalProfileScope = process.env.PI_SEATBELT_PROFILE_SCOPE;
const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock("../src/seatbelt.ts");
  vi.doUnmock("node:fs");
  vi.resetModules();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  if (originalProfilePath === undefined) delete process.env.PI_SEATBELT_PROFILE;
  else process.env.PI_SEATBELT_PROFILE = originalProfilePath;
  if (originalProfileScope === undefined) delete process.env.PI_SEATBELT_PROFILE_SCOPE;
  else process.env.PI_SEATBELT_PROFILE_SCOPE = originalProfileScope;
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function fakeProfile(dispose = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)): ProfileFile {
  return { path: join(tempDir("seatbelt-profile-"), "profile.sb"), dispose };
}

interface RuntimeOptions {
  /** Override the agent directory, which is injected before `../index.ts` loads. */
  agentDir?: (workspace: string) => string;
}

async function installRuntime(createProfileFile: () => Promise<ProfileFile>, options: RuntimeOptions = {}) {
  const workspace = tempDir("seatbelt-runtime-workspace-");
  const agentDir = options.agentDir ? options.agentDir(workspace) : tempDir("seatbelt-runtime-agent-");
  // No test may read or write the real agent directory.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const bin = tempDir("seatbelt-runtime-bin-");
  const sandboxExec = join(bin, "sandbox-exec");
  writeFileSync(sandboxExec, "#!/bin/sh\nexit 0\n");
  chmodSync(sandboxExec, 0o755);
  Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
  process.env.PATH = `${bin}${process.platform === "win32" ? ";" : ":"}${originalPath ?? ""}`;

  vi.doMock("node:fs", async () => {
    const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
    return {
      ...actual,
      accessSync(path: any, mode?: any) {
        if (path === SANDBOX_EXEC_PATH) return;
        return actual.accessSync(path, mode);
      },
    };
  });
  vi.doMock("../src/seatbelt.ts", async () => {
    const actual = await vi.importActual<typeof import("../src/seatbelt.ts")>("../src/seatbelt.ts");
    return { ...actual, createProfileFile };
  });
  const { default: seatbeltSandbox } = await import("../index.ts");

  let bashTool: { execute: (...args: any[]) => unknown } | undefined;
  let sessionStart: ((event: unknown, ctx: any) => Promise<void>) | undefined;
  let userBash: ((event: { cwd: string }) => unknown) | undefined;
  let toolCall: ((event: { toolName: string; input: unknown }) => unknown) | undefined;
  let command: ((args: string, ctx: any) => Promise<void>) | undefined;
  const ui = { setStatus: vi.fn(), notify: vi.fn() };
  const pi = {
    registerFlag: vi.fn(),
    registerTool: (tool: typeof bashTool) => {
      bashTool = tool;
    },
    on: (event: string, handler: unknown) => {
      if (event === "session_start") sessionStart = handler as typeof sessionStart;
      if (event === "user_bash") userBash = handler as typeof userBash;
      if (event === "tool_call") toolCall = handler as typeof toolCall;
    },
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
    getFlag: () => false,
  };
  seatbeltSandbox(pi as any);
  if (!bashTool || !sessionStart || !userBash || !toolCall || !command) throw new Error("runtime handlers were not registered");

  return {
    workspace,
    agentDir,
    ui,
    bashTool,
    start: () => sessionStart!({}, { cwd: workspace, ui }),
    userBash: () => userBash!({ cwd: workspace }),
    toolCall: (toolName: string, path: string) => toolCall!({ toolName, input: { path } }),
    command: (args: string) => command!(args, { ui }),
  };
}

/** All notify texts, in call order. */
function notifyTexts(ui: { notify: ReturnType<typeof vi.fn> }): string[] {
  return ui.notify.mock.calls.map(([text]) => String(text));
}

function storePathOf(runtime: { agentDir: string; workspace: string }): string {
  return grantStorePath(runtime.agentDir, runtime.workspace);
}

/** Write a store file directly: `saveGrants` refuses a store inside the workspace. */
function writeRawStore(storePath: string, projectRoot: string, grants: Grant[]): void {
  mkdirSync(dirname(storePath), { recursive: true });
  writeFileSync(storePath, JSON.stringify({ version: 1, projectRoot: realpathSync(projectRoot), grants }));
}

function readGrant(path: string): Grant {
  return addGrant([], { kind: "read", path }, "/").grant;
}

describe("runtime fail-closed transitions", () => {
  it("refuses bash while profile creation is in progress", async () => {
    let resolveProfile: ((profile: ProfileFile) => void) | undefined;
    const created = vi.fn(
      () =>
        new Promise<ProfileFile>((resolve) => {
          resolveProfile = resolve;
        }),
    );
    const runtime = await installRuntime(created);
    const starting = runtime.start();
    await vi.waitFor(() => expect(created).toHaveBeenCalledOnce());

    expect(runtime.userBash()).toMatchObject({ result: { exitCode: 126, output: expect.stringMatching(/sandbox profile unavailable/) } });
    resolveProfile?.(fakeProfile());
    await starting;
  });

  it("fails closed when profile creation fails", async () => {
    const runtime = await installRuntime(() => Promise.reject(new Error("profile creation failed")));
    await runtime.start();

    expect(runtime.userBash()).toMatchObject({ result: { exitCode: 126, output: expect.stringMatching(/profile creation failed/) } });
  });

  it("fails closed when a project config tries to disable the sandbox", async () => {
    const agentDir = tempDir("seatbelt-runtime-agent-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()), { agentDir: () => agentDir });
    mkdirSync(join(runtime.workspace, CONFIG_DIR_NAME), { recursive: true });
    writeFileSync(join(runtime.workspace, CONFIG_DIR_NAME, "seatbelt.json"), JSON.stringify({ enabled: false }));

    await runtime.start();

    expect(runtime.userBash()).toMatchObject({
      result: { exitCode: 126, output: expect.stringMatching(/cannot disable a globally enabled sandbox/) },
    });
  });

  it("fails closed when disposing the previous profile fails during reconfiguration", async () => {
    const dispose = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("profile disposal failed"));
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile(dispose)));
    await runtime.start();
    await runtime.command("network none");

    expect(dispose).toHaveBeenCalledOnce();
    expect(runtime.userBash()).toMatchObject({ result: { exitCode: 126, output: expect.stringMatching(/profile disposal failed/) } });
  });

  it("routes active runtimes without a profile to refusal", async () => {
    const { bashRuntimeRoute } = await import("../index.ts");

    expect(bashRuntimeRoute("active", false)).toBe("refused");
    expect(bashRuntimeRoute("initializing", false)).toBe("refused");
    expect(bashRuntimeRoute("fail-closed", false)).toBe("refused");
    expect(bashRuntimeRoute("disabled", false)).toBe("local");
    expect(bashRuntimeRoute("degraded", false)).toBe("local");
  });
});

describe("runtime grants", () => {
  it("applies persisted grants on session start", async () => {
    const shared = tempDir("seatbelt-runtime-shared-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    const grant = addGrant([], { kind: "read", path: shared }, runtime.workspace).grant;
    saveGrants(runtime.agentDir, runtime.workspace, [grant]);

    await runtime.start();

    expect(runtime.ui.setStatus).toHaveBeenCalledWith("seatbelt", "🔒 seatbelt: net=localhost +1 grants");
    const grantNotices = runtime.ui.notify.mock.calls.filter(([text]) => String(text).includes("grants"));
    expect(grantNotices).toHaveLength(1);
    expect(grantNotices[0][0]).toContain("Seatbelt grants: 1");
    expect(grantNotices[0][1]).toBe("info");

    // The grant is live in the path policy even though the defaults do not cover it.
    expect(runtime.toolCall("read", join(shared, "file.txt"))).toBeUndefined();
    // Negative control: an ungranted temp path stays outside the allowed roots.
    expect(runtime.toolCall("read", join(tempDir("seatbelt-runtime-ungranted-"), "file.txt"))).toMatchObject({
      block: true,
      reason: expect.stringMatching(/outside allowed roots/),
    });
  });

  it("reports a deleted grant target as missing and keeps the grant on disk", async () => {
    const target = tempDir("seatbelt-runtime-missing-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    const grant = readGrant(target);
    if (grant.kind === "network") throw new Error("expected a path grant");
    const storePath = storePathOf(runtime);
    saveGrants(runtime.agentDir, runtime.workspace, [grant]);
    const before = readFileSync(storePath);
    rmSync(target, { recursive: true, force: true });

    await runtime.start();

    const grantNotices = notifyTexts(runtime.ui).filter((text) => text.includes("grants"));
    expect(grantNotices).toHaveLength(1);
    expect(grantNotices[0]).toContain("Seatbelt grants: 1");
    expect(grantNotices[0]).toContain("missing");
    expect(grantNotices[0]).toContain(grant.id);
    expect(grantNotices[0]).toContain(grant.path);
    expect(readFileSync(storePath).equals(before)).toBe(true);
  });

  it("treats a corrupt store as no grants and reports the reset hint once", async () => {
    const ungranted = tempDir("seatbelt-runtime-ungranted-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    const storePath = storePathOf(runtime);
    mkdirSync(dirname(storePath), { recursive: true });
    writeFileSync(storePath, "{ not json");

    await runtime.start();

    const resetNotices = runtime.ui.notify.mock.calls.filter(([text]) => /seatbelt grants reset/.test(String(text)));
    expect(resetNotices).toHaveLength(1);
    expect(resetNotices[0][1]).toBe("error");
    expect(readFileSync(storePath, "utf8")).toBe("{ not json");

    expect(runtime.ui.setStatus).toHaveBeenCalledWith("seatbelt", "🔒 seatbelt: net=localhost");
    expect(runtime.ui.setStatus.mock.calls.some(([, text]) => /\+\d+ grants/.test(String(text)))).toBe(false);
    // Zero grants applied: the target a corrupt grant might have named is refused.
    expect(runtime.toolCall("read", join(ungranted, "file.txt"))).toMatchObject({
      block: true,
      reason: expect.stringMatching(/outside allowed roots/),
    });
  });

  it("ignores a grant store that sits inside the workspace", async () => {
    const ungranted = tempDir("seatbelt-runtime-ungranted-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()), { agentDir: (workspace) => join(workspace, "agent") });
    writeRawStore(storePathOf(runtime), runtime.workspace, [readGrant(ungranted)]);

    await runtime.start();

    const warningNotices = runtime.ui.notify.mock.calls.filter(([text]) => String(text).includes("inside the workspace"));
    expect(warningNotices).toHaveLength(1);
    expect(warningNotices[0][1]).toBe("warning");
    expect(notifyTexts(runtime.ui).filter((text) => text.includes("Seatbelt grants:"))).toHaveLength(0);
    expect(runtime.ui.setStatus).toHaveBeenCalledWith("seatbelt", "🔒 seatbelt: net=localhost");
    expect(runtime.toolCall("read", join(ungranted, "file.txt"))).toMatchObject({
      block: true,
      reason: expect.stringMatching(/outside allowed roots/),
    });
  });

  it("disposes the old profile once and installs the new one after a session network change", async () => {
    const first = fakeProfile();
    const second = fakeProfile();
    const created = vi.fn<() => Promise<ProfileFile>>().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const runtime = await installRuntime(created);
    await runtime.start();
    expect(process.env.PI_SEATBELT_PROFILE).toBe(first.path);

    await runtime.command("network all");

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(second.dispose).not.toHaveBeenCalled();
    expect(first.path).not.toBe(second.path);
    expect(process.env.PI_SEATBELT_PROFILE).toBe(second.path);
    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=all");
    expect(notifyTexts(runtime.ui)).toContain("Seatbelt network mode set to all for this session");
  });

  it("narrows and widens the network mode with a session command", async () => {
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    await runtime.start();
    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=localhost");

    await runtime.command("network none");

    // The session command replaces the composed mode, so it can also narrow.
    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=none");
    await runtime.command("");
    expect(String(runtime.ui.notify.mock.calls.at(-1)?.[0])).toContain("  network: none");

    await runtime.command("network all");

    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=all");
  });

  it("lists persisted and session grants in the status output", async () => {
    const shared = tempDir("seatbelt-runtime-shared-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    const persisted = addGrant([], { kind: "read", path: shared }, runtime.workspace).grant;
    if (persisted.kind === "network") throw new Error("expected a path grant");
    saveGrants(runtime.agentDir, runtime.workspace, [persisted]);
    await runtime.start();
    const sessionTarget = join(runtime.workspace, "build");
    await runtime.command(`allow-write ${sessionTarget}`);

    await runtime.command("");

    const status = String(runtime.ui.notify.mock.calls.at(-1)?.[0]);
    expect(status).toContain("Grants:");
    expect(status).toContain(`  - ${persisted.id}  read  ${persisted.path}`);
    const sessionLines = status.split("\n").filter((line) => line.includes("(session)"));
    expect(sessionLines).toHaveLength(1);
    expect(sessionLines[0]).toMatch(/^ {2}- [0-9a-f]{8} {2}write {2}/);
    expect(sessionLines[0]).toContain(join(realpathSync(runtime.workspace), "build"));
    expect(status).toContain("🔒 seatbelt: net=localhost +2 grants");
    expect(notifyTexts(runtime.ui)).toContain(`Added ${sessionTarget} for this session`);
  });

  it("never persists a session grant and drops it on the next session start", async () => {
    const persistedTarget = tempDir("seatbelt-runtime-persisted-");
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
    const persisted = addGrant([], { kind: "read", path: persistedTarget }, runtime.workspace).grant;
    const storePath = storePathOf(runtime);
    saveGrants(runtime.agentDir, runtime.workspace, [persisted]);
    await runtime.start();
    const before = readFileSync(storePath);

    const sessionTarget = tempDir("seatbelt-runtime-session-");
    await runtime.command(`allow-read ${sessionTarget}`);

    expect(runtime.toolCall("read", join(sessionTarget, "file.txt"))).toBeUndefined();
    expect(readFileSync(storePath).equals(before)).toBe(true);
    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=localhost +2 grants");

    await runtime.start();

    // Session changes are dropped; the persisted grant survives the reload.
    expect(runtime.toolCall("read", join(sessionTarget, "file.txt"))).toMatchObject({
      block: true,
      reason: expect.stringMatching(/outside allowed roots/),
    });
    expect(runtime.toolCall("read", join(persistedTarget, "file.txt"))).toBeUndefined();
    expect(runtime.ui.setStatus).toHaveBeenLastCalledWith("seatbelt", "🔒 seatbelt: net=localhost +1 grants");
  });
});
