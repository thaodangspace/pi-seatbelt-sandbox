import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileFile } from "../src/seatbelt.ts";
import { SANDBOX_EXEC_PATH } from "../src/sandbox-exec.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
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

async function installRuntime(createProfileFile: () => Promise<ProfileFile>) {
  const workspace = tempDir("seatbelt-runtime-workspace-");
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
    },
    registerCommand: (_name: string, definition: { handler: typeof command }) => {
      command = definition.handler;
    },
    getFlag: () => false,
  };
  seatbeltSandbox(pi as any);
  if (!bashTool || !sessionStart || !userBash || !command) throw new Error("runtime handlers were not registered");

  return {
    workspace,
    ui,
    bashTool,
    start: () => sessionStart!({}, { cwd: workspace, ui }),
    userBash: () => userBash!({ cwd: workspace }),
    command: (args: string) => command!(args, { ui }),
  };
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
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const runtime = await installRuntime(() => Promise.resolve(fakeProfile()));
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
