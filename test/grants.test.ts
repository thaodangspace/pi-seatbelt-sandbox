import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GRANT_STORE_VERSION, grantStorePath } from "../src/grants.ts";

let tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs = [];
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

describe("grant store path", () => {
  it("derives a deterministic per-project file from the project real path", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const projectRoot = tempDir("seatbelt-project-");
    const expectedDigest = createHash("sha256").update(realpathSync(projectRoot)).digest("hex");

    const path = grantStorePath(agentDir, projectRoot);

    expect(path).toBe(join(agentDir, "extensions", "seatbelt-grants", `${expectedDigest}.json`));
    expect(dirname(path)).toBe(join(agentDir, "extensions", "seatbelt-grants"));
    expect(basename(dirname(path))).toBe("seatbelt-grants");
    expect(path.endsWith(".json")).toBe(true);
    expect(path).toContain(expectedDigest);
    expect(expectedDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the same path for repeated calls and different paths for different projects", () => {
    const agentDir = tempDir("seatbelt-agent-");
    const projectRoot = tempDir("seatbelt-project-");
    const otherProjectRoot = tempDir("seatbelt-other-project-");

    expect(grantStorePath(agentDir, projectRoot)).toBe(grantStorePath(agentDir, projectRoot));
    expect(grantStorePath(agentDir, projectRoot)).not.toBe(grantStorePath(agentDir, otherProjectRoot));
  });

  it("pins the store version", () => {
    expect(GRANT_STORE_VERSION).toBe(1);
  });
});
