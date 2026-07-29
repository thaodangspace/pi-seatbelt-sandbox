import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfileFile } from "../src/seatbelt.ts";

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");
const originalPath = process.env.PATH;
const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock("../src/seatbelt.ts");
  vi.resetModules();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
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
