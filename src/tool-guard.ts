import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { assertCanRead, assertCanWrite, type PathPolicy } from "./policy.ts";

const READERS = new Set(["read", "grep", "find", "ls"]);
const WRITERS = new Set(["write", "edit"]);

export interface ToolGuardState {
  isActive(): boolean;
  getPolicy(): PathPolicy | undefined;
}

export function registerToolGuard(pi: ExtensionAPI, state: ToolGuardState): void {
  pi.on("tool_call", (event) => {
    if (!state.isActive()) return;

    const mode = READERS.has(event.toolName) ? "read" : WRITERS.has(event.toolName) ? "write" : undefined;
    if (!mode) return;

    try {
      const policy = requirePolicy(state);
      const target = (event.input as { path?: unknown }).path;
      if (typeof target !== "string" || target.trim().length === 0) {
        throw new Error(`seatbelt policy blocked ${event.toolName}: missing or invalid path`);
      }

      if (mode === "read") assertCanRead(target, policy);
      else assertCanWrite(target, policy);
    } catch (error) {
      return { block: true, reason: error instanceof Error ? error.message : String(error) };
    }
  });
}

function requirePolicy(state: ToolGuardState): PathPolicy {
  const policy = state.getPolicy();
  if (!policy) throw new Error("seatbelt policy is unavailable");
  return policy;
}
