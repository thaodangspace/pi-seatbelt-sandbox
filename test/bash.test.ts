import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { createSeatbeltBashOperations } from "../src/bash.ts";
import { SANDBOX_EXEC_PATH } from "../src/sandbox-exec.ts";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform");

afterEach(() => {
  vi.clearAllMocks();
  if (originalPlatform) Object.defineProperty(process, "platform", originalPlatform);
});

describe("Seatbelt bash operations", () => {
  it("filters the environment before spawning without mutating it", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child as never;
    });

    const env = { PATH: "/usr/bin", PUBLIC_VALUE: "visible", SECRET_VALUE: "hidden" };
    await createSeatbeltBashOperations("/tmp/profile.sb", { mode: "filtered", deny: ["SECRET_VALUE"] }).exec("true", process.cwd(), { onData() {}, env });

    expect(env.SECRET_VALUE).toBe("hidden");
    expect(vi.mocked(spawn).mock.calls[0]?.[2]).toEqual(expect.objectContaining({
      env: { PATH: "/usr/bin", PUBLIC_VALUE: "visible" },
    }));
  });

  it("uses the trusted launcher even when PATH is shadowed", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "darwin" });
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 123;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    vi.mocked(spawn).mockImplementation(() => {
      queueMicrotask(() => child.emit("close", 0));
      return child as never;
    });

    const env = { PATH: "/tmp/fake-bin:/usr/bin", CUSTOM: "value" };
    await createSeatbeltBashOperations("/tmp/profile.sb").exec("printf ok", process.cwd(), { onData() {}, env });

    expect(spawn).toHaveBeenCalledWith(
      SANDBOX_EXEC_PATH,
      ["-f", "/tmp/profile.sb", "/bin/bash", "-c", "printf ok"],
      expect.objectContaining({ env }),
    );
  });
});
