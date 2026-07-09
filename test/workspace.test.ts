import { mkdir, symlink } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cwdOutsideSessionReason, cwdRefusalReasonForRuntime, isCwdInsideSessionRoot, resolveCandidateCwd, resolveSessionRoot } from "../src/workspace.ts";

describe("session workspace binding", () => {
  it("accepts cwd equal to or inside the session root", async () => {
    const root = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-workspace-")));
    await mkdir(join(root, "nested"));

    expect(isCwdInsideSessionRoot(root, root)).toBe(true);
    expect(isCwdInsideSessionRoot(join(root, "nested"), root)).toBe(true);
    expect(cwdOutsideSessionReason(root, root)).toBeUndefined();
    expect(cwdOutsideSessionReason(join(root, "nested"), root)).toBeUndefined();
  });

  it("rejects cwd outside the session root", () => {
    const root = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-workspace-")));
    const outside = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-outside-")));

    expect(isCwdInsideSessionRoot(outside, root)).toBe(false);
    expect(cwdOutsideSessionReason(outside, root)).toMatch(/outside the session workspace/);
  });

  it("resolves relative cwd candidates against the session root", async () => {
    const root = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-workspace-")));
    await mkdir(join(root, "nested"));

    expect(resolveCandidateCwd("nested", root)).toBe(join(root, "nested"));
    expect(isCwdInsideSessionRoot("nested", root)).toBe(true);
  });

  it("rejects symlink cwd escapes", async () => {
    const root = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-workspace-")));
    const outside = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-outside-")));
    await symlink(outside, join(root, "link"));

    expect(resolveCandidateCwd(join(root, "link"), root)).toBe(outside);
    expect(isCwdInsideSessionRoot(join(root, "link"), root)).toBe(false);
    expect(cwdOutsideSessionReason(join(root, "link"), root)).toContain(outside);
  });

  it("refuses outside cwd for active, fail-closed, and degraded runtimes but not disabled runtimes", () => {
    const root = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-workspace-")));
    const outside = resolveSessionRoot(mkdtempSync(join(tmpdir(), "seatbelt-outside-")));

    expect(cwdRefusalReasonForRuntime("active", outside, root)).toMatch(/outside the session workspace/);
    expect(cwdRefusalReasonForRuntime("fail-closed", outside, root)).toMatch(/outside the session workspace/);
    expect(cwdRefusalReasonForRuntime("degraded", outside, root)).toMatch(/outside the session workspace/);
    expect(cwdRefusalReasonForRuntime("disabled", outside, root)).toBeUndefined();
    expect(cwdRefusalReasonForRuntime("active", root, root)).toBeUndefined();
  });
});
