export type EnvironmentMode = "inherit" | "filtered";

export interface EnvironmentPolicy {
  mode: EnvironmentMode;
  /** Exact environment variable names to remove when mode is filtered. */
  deny: string[];
}

/**
 * Build the environment visible to a sandboxed subprocess without mutating
 * the source environment. Deny entries are exact names; shell-style patterns
 * are intentionally not supported.
 */
export function buildSandboxEnvironment(source: NodeJS.ProcessEnv, policy: EnvironmentPolicy): NodeJS.ProcessEnv {
  const environment = { ...source };
  if (policy.mode === "filtered") {
    for (const name of policy.deny) delete environment[name];
  }
  return environment;
}
