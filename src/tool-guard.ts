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
    const target = (event.input as { path?: unknown }).path;
    if (typeof target !== "string" || target.length === 0) return;

    try {
      if (READERS.has(event.toolName)) assertCanRead(target, requirePolicy(state));
      else if (WRITERS.has(event.toolName)) assertCanWrite(target, requirePolicy(state));
      else return;
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
