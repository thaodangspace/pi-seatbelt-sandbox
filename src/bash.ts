import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { BashOperations } from "@earendil-works/pi-coding-agent";
import { SANDBOX_EXEC_PATH } from "./sandbox-exec.ts";

export function createSeatbeltBashOperations(profilePath: string): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (process.platform !== "darwin") throw new Error("pi-seatbelt-sandbox: macOS only");
      if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

      return new Promise((resolve, reject) => {
        const child = spawn(SANDBOX_EXEC_PATH, ["-f", profilePath, "/bin/bash", "-c", command], {
          cwd,
          env,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
        });

        let settled = false;
        let timedOut = false;
        let timeoutHandle: NodeJS.Timeout | undefined;

        const cleanup = () => {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          signal?.removeEventListener("abort", onAbort);
        };

        const kill = () => {
          if (!child.pid) return;
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            try {
              child.kill("SIGKILL");
            } catch {
              // Ignore kill races.
            }
          }
        };

        const onAbort = () => kill();

        if (timeout !== undefined && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            kill();
          }, timeout * 1000);
        }

        if (signal?.aborted) onAbort();
        else signal?.addEventListener("abort", onAbort, { once: true });

        child.stdout?.on("data", onData);
        child.stderr?.on("data", onData);

        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        });

        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          cleanup();
          if (signal?.aborted) reject(new Error("aborted"));
          else if (timedOut) reject(new Error(`timeout:${timeout}`));
          else resolve({ exitCode: code });
        });
      });
    },
  };
}
