import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtempSync, statSync, existsSync } from "node:fs";
import { writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeatbeltBashOperations } from "../src/bash.ts";
import { createProfileFile } from "../src/seatbelt.ts";

const hasSandboxExec = process.platform === "darwin" && (() => {
  try {
    execFileSync("/usr/bin/which", ["sandbox-exec"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const runIf = hasSandboxExec ? describe : describe.skip;

runIf("sandbox-exec integration", () => {
  it("allows workspace reads and blocks denied home secrets", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-int-"));
    writeFileSync(join(cwd, "ok.txt"), "ok");
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd, tmpdir()], denyRead: [join(homedir(), ".ssh")], denyWrite: [], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("cat ok.txt", cwd, { onData() {} })).exitCode).toBe(0);
      expect((await ops.exec("ls ~/.ssh >/dev/null 2>&1", cwd, { onData() {} })).exitCode).not.toBe(0);
    } finally {
      await profile.dispose();
    }
  });

  it("allows workspace writes but blocks .env and outside writes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-int-"));
    const outside = join(homedir(), `.seatbelt-out-${Date.now()}`);
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd, tmpdir()], denyRead: [], denyWrite: [join(cwd, ".env")], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("echo ok > allowed.txt", cwd, { onData() {} })).exitCode).toBe(0);
      expect((await ops.exec("echo no > .env", cwd, { onData() {} })).exitCode).not.toBe(0);
      expect((await ops.exec(`echo no > ${JSON.stringify(join(outside, "x"))}`, cwd, { onData() {} })).exitCode).not.toBe(0);
    } finally {
      await profile.dispose();
    }
  });

  it("enforces none/all/localhost network modes", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-net-"));
    const baseReadable = [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"];
    try {
      for (const mode of ["all", "localhost"] as const) {
        const profile = await createProfileFile({ readable: baseReadable, writable: [cwd], denyRead: [], denyWrite: [], network: mode });
        try {
          const ops = createSeatbeltBashOperations(profile.path);
          expect((await ops.exec(`curl -fsS --max-time 3 http://127.0.0.1:${port}`, cwd, { onData() {} })).exitCode).toBe(0);
        } finally {
          await profile.dispose();
        }
      }

      const none = await createProfileFile({ readable: baseReadable, writable: [cwd], denyRead: [], denyWrite: [], network: "none" });
      try {
        expect((await createSeatbeltBashOperations(none.path).exec(`curl -fsS --max-time 3 http://127.0.0.1:${port}`, cwd, { onData() {} })).exitCode).not.toBe(0);
      } finally {
        await none.dispose();
      }

      const localhost = await createProfileFile({ readable: baseReadable, writable: [cwd], denyRead: [], denyWrite: [], network: "localhost" });
      try {
        expect((await createSeatbeltBashOperations(localhost.path).exec("curl -fsS --max-time 3 https://example.com >/dev/null", cwd, { onData() {} })).exitCode).not.toBe(0);
      } finally {
        await localhost.dispose();
      }
    } finally {
      server.close();
    }
  });

  it("creates a private profile temp dir and removes it", async () => {
    const profile = await createProfileFile({ readable: ["/tmp"], writable: [], denyRead: [], denyWrite: [], network: "none" });
    const dir = profile.path.replace(/\/profile\.sb$/, "");
    expect((statSync(dir).mode & 0o777)).toBe(0o700);
    await profile.dispose();
    expect(existsSync(dir)).toBe(false);
  });
});
