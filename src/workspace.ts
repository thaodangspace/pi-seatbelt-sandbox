import { canon, isInside } from "./policy.ts";

export type CwdBoundRuntimeState = "disabled" | "initializing" | "active" | "fail-closed" | "degraded";

export function resolveSessionRoot(cwd: string): string {
  return canon(cwd);
}

export function resolveCandidateCwd(cwd: string, sessionRoot: string): string {
  return canon(cwd, sessionRoot);
}

export function isCwdInsideSessionRoot(cwd: string, sessionRoot: string): boolean {
  return isInside(resolveCandidateCwd(cwd, sessionRoot), sessionRoot);
}

export function cwdOutsideSessionReason(cwd: string, sessionRoot: string): string | undefined {
  const resolved = resolveCandidateCwd(cwd, sessionRoot);
  if (isInside(resolved, sessionRoot)) return undefined;
  return `cwd ${resolved} is outside the session workspace ${sessionRoot}`;
}

export function cwdRefusalReasonForRuntime(state: CwdBoundRuntimeState, cwd: string, sessionRoot: string): string | undefined {
  if (state === "disabled") return undefined;
  return cwdOutsideSessionReason(cwd, sessionRoot);
}
