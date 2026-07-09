import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { buildPolicy, type PathPolicy } from "../src/policy.ts";
import { registerToolGuard, type ToolGuardState } from "../src/tool-guard.ts";

type ToolCallHandler = (event: { toolName: string; input: unknown }) => unknown;

function captureGuard(state: ToolGuardState): ToolCallHandler {
  let handler: ToolCallHandler | undefined;
  const pi = {
    on(name: string, fn: ToolCallHandler) {
      if (name === "tool_call") handler = fn;
    },
  } as unknown as ExtensionAPI;

  registerToolGuard(pi, state);
  if (!handler) throw new Error("tool_call handler was not registered");
  return handler;
}

function testPolicy(): PathPolicy {
  const root = mkdtempSync(join(tmpdir(), "seatbelt-guard-"));
  return buildPolicy({ readable: [root], writable: [root], denyRead: [join(root, "secret")], denyWrite: [join(root, ".env")] }, root);
}

describe("tool guard", () => {
  it("passes through when inactive", () => {
    const guard = captureGuard({ isActive: () => false, getPolicy: testPolicy });
    expect(guard({ toolName: "read", input: {} })).toBeUndefined();
  });

  it("passes through unguarded tools even with malformed path input", () => {
    const guard = captureGuard({ isActive: () => true, getPolicy: testPolicy });
    expect(guard({ toolName: "bash", input: {} })).toBeUndefined();
    expect(guard({ toolName: "custom", input: { path: 123 } })).toBeUndefined();
  });

  it.each(["read", "grep", "find", "ls", "write", "edit"])("blocks %s when path is missing or invalid", (toolName) => {
    const guard = captureGuard({ isActive: () => true, getPolicy: testPolicy });

    for (const input of [{}, { path: "" }, { path: "   " }, { path: null }, { path: 123 }, { path: ["x"] }]) {
      expect(guard({ toolName, input })).toMatchObject({
        block: true,
        reason: expect.stringMatching(/missing or invalid path/),
      });
    }
  });

  it("applies read and write policy for valid paths", () => {
    const root = mkdtempSync(join(tmpdir(), "seatbelt-guard-"));
    const policy = buildPolicy({ readable: [root], writable: [root], denyRead: [join(root, "secret")], denyWrite: [join(root, ".env")] }, root);
    const guard = captureGuard({ isActive: () => true, getPolicy: () => policy });

    expect(guard({ toolName: "read", input: { path: join(root, "ok.txt") } })).toBeUndefined();
    expect(guard({ toolName: "write", input: { path: join(root, "ok.txt") } })).toBeUndefined();
    expect(guard({ toolName: "read", input: { path: join(root, "secret", "x") } })).toMatchObject({ block: true, reason: expect.stringMatching(/denied/) });
    expect(guard({ toolName: "write", input: { path: join(root, ".env") } })).toMatchObject({ block: true, reason: expect.stringMatching(/denied/) });
  });

  it("blocks guarded tools when active but policy is unavailable", () => {
    const guard = captureGuard({ isActive: () => true, getPolicy: () => undefined });
    expect(guard({ toolName: "read", input: { path: "README.md" } })).toMatchObject({
      block: true,
      reason: expect.stringMatching(/policy is unavailable/),
    });
  });
});
