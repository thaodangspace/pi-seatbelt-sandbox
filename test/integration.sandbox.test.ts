import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createSeatbeltBashOperations } from "../src/bash.ts";
import { SANDBOX_EXEC_PATH } from "../src/sandbox-exec.ts";
import { createProfileFile, type ProfileFile } from "../src/seatbelt.ts";

const sandboxUnavailableReason = (() => {
  if (process.platform !== "darwin") return `macOS Seatbelt required (platform: ${process.platform})`;
  try {
    execFileSync(
      SANDBOX_EXEC_PATH,
      ["-p", "(version 1) (allow default)", "/usr/bin/true"],
      { stdio: "ignore" },
    );
    return undefined;
  } catch {
    return "/usr/bin/sandbox-exec is unavailable or cannot apply a probe profile";
  }
})();
const hasSandboxExec = sandboxUnavailableReason === undefined;
if (sandboxUnavailableReason) console.info(`Skipping Seatbelt integration: ${sandboxUnavailableReason}`);
const runIf = hasSandboxExec ? describe : describe.skip;

runIf("sandbox-exec integration", () => {
  it("does not resolve sandbox-exec through PATH", async () => {
    const fakeBin = mkdtempSync(join(tmpdir(), "seatbelt-fake-bin-"));
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-path-"));
    const marker = join(fakeBin, "invoked");
    const fakeSandboxExec = join(fakeBin, "sandbox-exec");
    const originalPath = process.env.PATH;
    writeFileSync(fakeSandboxExec, `#!/bin/sh\nprintf invoked > ${JSON.stringify(marker)}\nexit 99\n`);
    chmodSync(fakeSandboxExec, 0o755);
    // Deliberately make both the inherited and per-command PATH prefer the fake.
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    let profile: ProfileFile | undefined;
    try {
      profile = await createProfileFile({ readable: [cwd, "/bin", "/usr"], writable: [cwd], denyRead: [], denyWrite: [], network: "none" });
      const result = await createSeatbeltBashOperations(profile.path).exec("printf ok > path-check.txt", cwd, {
        onData() {},
        env: { ...process.env, PATH: `${fakeBin}:${originalPath ?? ""}` },
      });
      expect(result.exitCode).toBe(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      await profile?.dispose();
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(fakeBin, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

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
    const outside = mkdtempSync(join(homedir(), ".seatbelt-out-"));
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd, tmpdir()], denyRead: [], denyWrite: [join(cwd, ".env")], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("echo ok > allowed.txt", cwd, { onData() {} })).exitCode).toBe(0);
      expect((await ops.exec("echo no > .env", cwd, { onData() {} })).exitCode).not.toBe(0);
      expect((await ops.exec(`echo no > ${JSON.stringify(join(outside, "x"))}`, cwd, { onData() {} })).exitCode).not.toBe(0);
    } finally {
      await profile.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps its reusable profile immutable across commands", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-profile-"));
    const outside = mkdtempSync(join(homedir(), ".seatbelt-profile-out-"));
    const outsideFile = join(outside, "escaped.txt");
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd, tmpdir()], denyRead: [], denyWrite: [], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      const env = { ...process.env, PI_SEATBELT_PROFILE: profile.path };

      expect((await ops.exec('printf "(version 1) (allow default)\\n" > "$PI_SEATBELT_PROFILE"', cwd, { onData() {}, env })).exitCode).not.toBe(0);
      expect((await ops.exec(`echo no > ${JSON.stringify(outsideFile)}`, cwd, { onData() {}, env })).exitCode).not.toBe(0);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      await profile.dispose();
      rmSync(outside, { recursive: true, force: true });
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

  it("keeps shell escapes inside the same Seatbelt profile", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-shell-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-shell-out-"));
    const outsideFile = join(outside, "escaped.txt");
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd], denyRead: [], denyWrite: [outside], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("/bin/sh -c 'echo ok > via-sh.txt'", cwd, { onData() {} })).exitCode).toBe(0);
      expect((await ops.exec(`/bin/sh -c 'echo no > ${JSON.stringify(outsideFile)}'`, cwd, { onData() {} })).exitCode).not.toBe(0);
      expect((await ops.exec(`target=${JSON.stringify(outsideFile)}; echo no > \"$(printf %s \"$target\")\"`, cwd, { onData() {} })).exitCode).not.toBe(0);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      await profile.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks symlink traversal to files outside writable roots", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-link-"));
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-link-out-"));
    mkdirSync(join(outside, "target"));
    symlinkSync(join(outside, "target"), join(cwd, "link"));
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd], denyRead: [], denyWrite: [outside], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("echo no > link/escaped.txt", cwd, { onData() {} })).exitCode).not.toBe(0);
      expect(existsSync(join(outside, "target", "escaped.txt"))).toBe(false);
    } finally {
      await profile.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("blocks a dangling final symlink to a nonexistent external target", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-dangling-link-"));
    const outside = mkdtempSync(join(homedir(), ".seatbelt-dangling-link-out-"));
    const outsideFile = join(outside, "not-created.txt");
    symlinkSync(outsideFile, join(cwd, "link"));
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd], denyRead: [], denyWrite: [], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec("echo no > link", cwd, { onData() {} })).exitCode).not.toBe(0);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      await profile.dispose();
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("allows configured temp writes while blocking denied temp writes", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "seatbelt-tmp-"));
    const tempTarget = join(tmpdir(), `seatbelt-temp-write-${Date.now()}.txt`);
    const outside = mkdtempSync(join(tmpdir(), "seatbelt-temp-denied-"));
    const outsideFile = join(outside, "x.txt");
    const profile = await createProfileFile({ readable: [cwd, "/bin", "/usr", "/System", "/Library", "/etc", "/private/etc", "/dev/null", "/dev/urandom"], writable: [cwd, tmpdir()], denyRead: [], denyWrite: [outside], network: "none" });
    try {
      const ops = createSeatbeltBashOperations(profile.path);
      expect((await ops.exec(`echo ok > ${JSON.stringify(tempTarget)}`, cwd, { onData() {} })).exitCode).toBe(0);
      expect(existsSync(tempTarget)).toBe(true);
      expect((await ops.exec(`echo no > ${JSON.stringify(outsideFile)}`, cwd, { onData() {} })).exitCode).not.toBe(0);
      expect(existsSync(outsideFile)).toBe(false);
    } finally {
      await profile.dispose();
      rmSync(tempTarget, { force: true });
      rmSync(outside, { recursive: true, force: true });
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
