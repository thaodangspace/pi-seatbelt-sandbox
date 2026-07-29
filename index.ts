import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { createSeatbeltBashOperations } from "./src/bash.ts";
import { ConfigError, DEFAULT_CONFIG, expandConfigPath, loadConfig, type SeatbeltConfig } from "./src/config.ts";
import { buildPolicy, type PathPolicy } from "./src/policy.ts";
import { createProfileFile, type ProfileFile } from "./src/seatbelt.ts";
import { registerToolGuard } from "./src/tool-guard.ts";
import { cwdRefusalReasonForRuntime, resolveSessionRoot } from "./src/workspace.ts";

export type RuntimeState = "disabled" | "initializing" | "active" | "fail-closed" | "degraded";
export type BashRuntimeRoute = "local" | "sandboxed" | "refused";

export function bashRuntimeRoute(state: RuntimeState, hasProfile: boolean): BashRuntimeRoute {
  if (state === "disabled" || state === "degraded") return "local";
  if (state === "active" && hasProfile) return "sandboxed";
  return "refused";
}

const FAIL_CLOSED_MESSAGE = "bash is disabled: Seatbelt sandbox unavailable";
export const SHARED_PROFILE_ENV = "PI_SEATBELT_PROFILE";
export const SHARED_PROFILE_SCOPE_ENV = "PI_SEATBELT_PROFILE_SCOPE";
export const SHARED_PROFILE_SCOPE = "tool-subprocess-v1";

export default function seatbeltSandbox(pi: ExtensionAPI) {
  pi.registerFlag("no-seatbelt", {
    description: "Disable the Seatbelt sandbox",
    type: "boolean",
    default: false,
  });

  let state: RuntimeState = "disabled";
  let policy: PathPolicy | undefined;
  let profile: ProfileFile | undefined;
  let config: SeatbeltConfig = DEFAULT_CONFIG;
  let sessionRoot = resolveSessionRoot(process.cwd());
  let failureReason: string | undefined;

  const baseBash = createBashTool(process.cwd());

  pi.registerTool({
    ...baseBash,
    label: "bash (seatbelt)",
    async execute(id, params, signal, onUpdate, ctx) {
      const cwdDriftReason = rejectCwdOutsideSession(ctx.cwd);
      if (cwdDriftReason) return bashDisabledResult(cwdDriftReason);

      const route = bashRuntimeRoute(state, profile !== undefined);
      if (route === "local") return createBashTool(ctx.cwd).execute(id, params, signal, onUpdate);
      if (route === "sandboxed") {
        const sandboxedBash = createBashTool(ctx.cwd, { operations: createSeatbeltBashOperations(profile!.path) });
        return sandboxedBash.execute(id, params, signal, onUpdate);
      }
      return bashDisabledResult(failureReason ?? "sandbox profile unavailable");
    },
  });

  pi.on("user_bash", (event) => {
    const cwdDriftReason = rejectCwdOutsideSession(event.cwd);
    if (cwdDriftReason) return { result: bashRefusedCommandResult(cwdDriftReason) };

    const route = bashRuntimeRoute(state, profile !== undefined);
    if (route === "local") return;
    if (route === "sandboxed") return { operations: createSeatbeltBashOperations(profile!.path) };
    return { result: bashRefusedCommandResult(failureReason ?? "sandbox profile unavailable") };
  });

  registerToolGuard(pi, {
    isActive: () => state !== "disabled" && state !== "degraded",
    getPolicy: () => policy,
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionRoot = resolveSessionRoot(ctx.cwd);
    await activate(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    state = "initializing";
    policy = undefined;
    try {
      await disposeProfile();
      state = "disabled";
    } catch (error) {
      failureReason = errorMessage(error);
      state = "fail-closed";
    }
  });

  pi.registerCommand("seatbelt", {
    description: "Show or change Seatbelt sandbox state",
    handler: async (args, ctx) => {
      await handleCommand(args.trim(), ctx);
    },
  });

  async function handleCommand(args: string, ctx: ExtensionCommandContext): Promise<void> {
    if (!args) {
      ctx.ui.notify(formatStatus(), "info");
      return;
    }

    const [cmd, ...rest] = splitArgs(args);
    switch (cmd) {
      case "network": {
        const mode = rest[0];
        if (mode !== "none" && mode !== "localhost" && mode !== "all") {
          ctx.ui.notify("Usage: /seatbelt network none|localhost|all", "error");
          return;
        }
        config = { ...config, network: { mode } };
        await activate(ctx);
        ctx.ui.notify(`Seatbelt network mode set to ${mode} for this session`, "info");
        return;
      }
      case "allow-read":
      case "allow-write": {
        const value = rest.join(" ");
        if (!value) {
          ctx.ui.notify(`Usage: /seatbelt ${cmd} <path>`, "error");
          return;
        }
        try {
          const expanded = expandConfigPath(value, { cwd: sessionRoot });
          config =
            cmd === "allow-read"
              ? { ...config, readable: [...config.readable, expanded] }
              : { ...config, writable: [...config.writable, expanded] };
          await activate(ctx);
          ctx.ui.notify(`Added ${expanded} for this session`, "info");
        } catch (error) {
          failClosed(ctx, errorMessage(error));
        }
        return;
      }
      case "off":
        state = "initializing";
        policy = undefined;
        failureReason = undefined;
        try {
          await disposeProfile();
          failureReason = "disabled by /seatbelt off";
          state = config.failClosed ? "fail-closed" : "degraded";
          ctx.ui.setStatus("seatbelt", config.failClosed ? "seatbelt: off (bash refused)" : "seatbelt: off (unsandboxed)");
          ctx.ui.notify(config.failClosed ? "Seatbelt disabled; failClosed=true so bash will be refused" : "Seatbelt disabled; bash will run unsandboxed", config.failClosed ? "warning" : "info");
        } catch (error) {
          failClosed(ctx, errorMessage(error));
        }
        return;
      default:
        ctx.ui.notify("Usage: /seatbelt [network none|localhost|all | allow-read <path> | allow-write <path> | off]", "error");
    }
  }

  async function activate(ctx: Pick<ExtensionContext, "ui">, reloadConfig = false): Promise<void> {
    // Every transition first refuses commands. No path may run local bash while
    // an old profile is being disposed or a replacement is being created.
    state = "initializing";
    policy = undefined;
    failureReason = undefined;

    try {
      await disposeProfile();
      if (reloadConfig) config = loadConfig(sessionRoot);

      if (!config.enabled || pi.getFlag("no-seatbelt") === true) {
        state = "disabled";
        ctx.ui.setStatus("seatbelt", "seatbelt: disabled");
        ctx.ui.notify("Seatbelt sandbox disabled", "warning");
        return;
      }
      if (process.platform !== "darwin") {
        unavailable(ctx, `macOS only (current platform: ${process.platform})`);
        return;
      }
      if (!which("sandbox-exec")) {
        unavailable(ctx, "sandbox-exec not found in PATH");
        return;
      }

      policy = buildPolicy(config, sessionRoot);
      profile = await createProfileFile({
        readable: config.readable,
        writable: config.writable,
        denyRead: config.denyRead,
        denyWrite: config.denyWrite,
        network: config.network.mode,
      });
      // Trusted extensions such as Chronos can launch their subprocesses under
      // this exact profile instead of composing a second, narrower sandbox.
      process.env[SHARED_PROFILE_ENV] = profile.path;
      process.env[SHARED_PROFILE_SCOPE_ENV] = SHARED_PROFILE_SCOPE;
      state = "active";
      ctx.ui.setStatus("seatbelt", `🔒 seatbelt: net=${config.network.mode}`);
      ctx.ui.notify("Seatbelt sandbox initialized", "info");
    } catch (error) {
      try {
        await disposeProfile();
      } catch {
        // The runtime is already fail-closed; retain the original failure.
      }
      failClosed(ctx, errorMessage(error));
    }
  }

  function unavailable(ctx: Pick<ExtensionCommandContext, "ui">, reason: string): void {
    if (config.failClosed) failClosed(ctx, reason);
    else {
      state = "degraded";
      failureReason = reason;
      ctx.ui.setStatus("seatbelt", "seatbelt: degraded");
      ctx.ui.notify(`Seatbelt unavailable; falling back to unsandboxed bash: ${reason}`, "warning");
    }
  }

  function failClosed(ctx: Pick<ExtensionCommandContext, "ui">, reason: string): void {
    state = "fail-closed";
    failureReason = reason;
    ctx.ui.setStatus("seatbelt", "seatbelt: fail-closed");
    ctx.ui.notify(`${FAIL_CLOSED_MESSAGE}: ${reason}`, "error");
  }

  function rejectCwdOutsideSession(cwd: string): string | undefined {
    return cwdRefusalReasonForRuntime(state, cwd, sessionRoot);
  }

  async function disposeProfile(): Promise<void> {
    const old = profile;
    profile = undefined;
    if (old && process.env[SHARED_PROFILE_ENV] === old.path) {
      delete process.env[SHARED_PROFILE_ENV];
    }
    if (old && process.env[SHARED_PROFILE_SCOPE_ENV] === SHARED_PROFILE_SCOPE) {
      delete process.env[SHARED_PROFILE_SCOPE_ENV];
    }
    if (old) await old.dispose();
  }

  function formatStatus(): string {
    const lines = [
      "Seatbelt sandbox:",
      `  state: ${state}${failureReason ? ` (${failureReason})` : ""}`,
      `  network: ${config.network.mode}`,
      `  workspace: ${sessionRoot}`,
      `  cwd binding: bash is refused outside the session workspace while seatbelt is enabled`,
      `  profile: ${profile?.path ?? "(none)"}`,
      "",
      "Readable roots:",
      ...config.readable.map((p) => `  - ${p}`),
      "Writable roots:",
      ...config.writable.map((p) => `  - ${p}`),
      "Deny read:",
      ...config.denyRead.map((p) => `  - ${p}`),
      "Deny write:",
      ...config.denyWrite.map((p) => `  - ${p}`),
    ];
    return lines.join("\n");
  }
}

function bashDisabledResult(reason?: string) {
  return {
    content: [{ type: "text" as const, text: `${FAIL_CLOSED_MESSAGE}${reason ? ` (${reason})` : ""}` }],
    details: undefined,
    terminate: true,
  };
}

function bashRefusedCommandResult(reason?: string) {
  return {
    output: `${FAIL_CLOSED_MESSAGE}${reason ? ` (${reason})` : ""}\n`,
    exitCode: 126,
    cancelled: false,
    truncated: false,
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function which(command: string): string | undefined {
  const paths = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  for (const dir of paths) {
    const candidate = isAbsolute(command) ? command : resolve(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue searching.
    }
  }
  return undefined;
}

function splitArgs(input: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) quote = undefined;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}
