import { accessSync, constants, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import { createSeatbeltBashOperations } from "./src/bash.ts";
import {
  ConfigError,
  DEFAULT_CONFIG,
  composeConfig,
  expandConfigPath,
  loadBaseConfig,
  loadProjectOverride,
  type ConfigOverride,
  type SeatbeltConfig,
} from "./src/config.ts";
import {
  addGrant,
  applyGrantStoreDeny,
  applyGrants,
  formatGrantList,
  loadGrants,
  pruneExpired,
  sanitizeForDisplay,
  saveGrants,
  type Grant,
  type GrantKind,
  type LoadGrantsResult,
  type NewGrantInput,
} from "./src/grants.ts";
import { buildPolicy, type PathPolicy } from "./src/policy.ts";
import { createProfileFile, type ProfileFile } from "./src/seatbelt.ts";
import { SANDBOX_EXEC_PATH } from "./src/sandbox-exec.ts";
import { registerAccessTool } from "./src/access-tool.ts";
import { registerToolGuard } from "./src/tool-guard.ts";
import { cwdRefusalReasonForRuntime, resolveSessionRoot } from "./src/workspace.ts";

export type RuntimeState = "disabled" | "initializing" | "active" | "fail-closed" | "degraded";
export type BashRuntimeRoute = "local" | "sandboxed" | "refused";

export function bashRuntimeRoute(state: RuntimeState, hasProfile: boolean): BashRuntimeRoute {
  if (state === "disabled" || state === "degraded") return "local";
  if (state === "active" && hasProfile) return "sandboxed";
  return "refused";
}

/**
 * One decision of the access tool, as written to the session record (FR10).
 * The target is the canonical path for read/write and the requested mode for
 * network; the agent's `reason` text is never part of the record.
 */
export interface GrantDecisionRecord {
  kind: GrantKind;
  decision: "session" | "remember" | "deny";
  target: string;
}

/**
 * The runtime surface handed to `registerAccessTool` (Phase 5). The access tool
 * asks for one grant to be installed and then re-activates the runtime; it never
 * touches the closure directly.
 */
export interface RuntimeAccessors {
  getConfig(): SeatbeltConfig;
  setConfig(next: SeatbeltConfig): void;
  getState(): RuntimeState;
  getFailureReason(): string | undefined;
  getSessionRoot(): string;
  getAgentDir(): string;
  isStoreLocked(): boolean;
  recordSessionGrant(input: NewGrantInput): void;
  /** Write one grant to the per-project store, then rebuild. May throw `GrantStoreError`. */
  persistGrant(input: NewGrantInput): Grant;
  /** Append the FR10 session record. Best effort: a failure is swallowed. */
  recordDecision(record: GrantDecisionRecord): void;
  activate(ctx: Pick<ExtensionContext, "ui">): Promise<void>;
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
  // Grants: `grants` mirrors the persisted per-project store, while
  // `sessionGrants` and `sessionNetwork` are session-only and never written.
  let grants: Grant[] = [];
  let sessionGrants: Grant[] = [];
  let sessionNetwork: SeatbeltConfig["network"]["mode"] | undefined;
  let grantStoreLocked = false;
  let projectOverride: ConfigOverride | undefined;

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
        const sandboxedBash = createBashTool(ctx.cwd, {
          operations: createSeatbeltBashOperations(profile!.path, config.environment),
        });
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
    if (route === "sandboxed") return { operations: createSeatbeltBashOperations(profile!.path, config.environment) };
    return { result: bashRefusedCommandResult(failureReason ?? "sandbox profile unavailable") };
  });

  registerToolGuard(pi, {
    isActive: () => state !== "disabled" && state !== "degraded",
    getPolicy: () => policy,
  });

  pi.on("session_start", async (_event, ctx) => {
    sessionRoot = resolveSessionRoot(ctx.cwd);
    // Session-only changes are dropped on every session start (FR7).
    sessionGrants = [];
    sessionNetwork = undefined;
    // Loading is read-only: a corrupt, foreign, or workspace-hosted store yields
    // no grants plus exactly one notice and is never rewritten here.
    const loaded = loadGrants(getAgentDir(), sessionRoot);
    grants = loaded.grants;
    grantStoreLocked = loaded.warning !== undefined;
    const notice = grantStartNotice(loaded);
    if (notice) ctx.ui.notify(notice.text, notice.type);
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
        try {
          sessionNetwork = mode;
          rebuildConfig();
          await activate(ctx);
          ctx.ui.notify(`Seatbelt network mode set to ${mode} for this session`, "info");
        } catch (error) {
          failClosed(ctx, errorMessage(error));
        }
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
          // Session grants live in memory only and apply above the project layer.
          sessionGrants = addGrant(sessionGrants, { kind: cmd === "allow-read" ? "read" : "write", path: expanded }, sessionRoot).grants;
          rebuildConfig();
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

  /**
   * The single configuration mutator: no command composes `config`. Layers are
   * defaults → global config → persisted grants → project restrictions (with
   * the pre-grant base as the widening ceiling) → session grants → session
   * network override → store deny paths, so deny lists stay append-only and
   * only grants and an explicit session command can change the network mode.
   */
  function rebuildConfig(): void {
    const base = loadBaseConfig(sessionRoot);
    projectOverride = loadProjectOverride(sessionRoot);
    const projectConfigPath = join(sessionRoot, CONFIG_DIR_NAME, "seatbelt.json");
    const withGrants = composeConfig(base, projectOverride, grants, sessionRoot, projectConfigPath);
    const withSessionGrants = applyGrants(withGrants, sessionGrants, sessionRoot);
    // `/seatbelt network <mode>` replaces the composed mode, so it can narrow as
    // well as widen. Without the command, persisted grants keep their own mode.
    const withSessionNetwork = sessionNetwork === undefined ? withSessionGrants : { ...withSessionGrants, network: { mode: sessionNetwork } };
    config = applyGrantStoreDeny(withSessionNetwork, getAgentDir());
  }

  async function activate(ctx: Pick<ExtensionContext, "ui">, reloadConfig = false): Promise<void> {
    // Every transition first refuses commands. No path may run local bash while
    // an old profile is being disposed or a replacement is being created.
    state = "initializing";
    policy = undefined;
    failureReason = undefined;

    try {
      await disposeProfile();
      if (reloadConfig) rebuildConfig();

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
      try {
        accessSync(SANDBOX_EXEC_PATH, constants.X_OK);
      } catch {
        unavailable(ctx, `${SANDBOX_EXEC_PATH} is unavailable or not executable`);
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
      ctx.ui.setStatus("seatbelt", statusText());
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

  /** Status line shown while active: network mode plus the effective grant count. */
  function statusText(): string {
    const count = grants.length + sessionGrants.length;
    return `🔒 seatbelt: net=${config.network.mode}${count > 0 ? ` +${count} grants` : ""}`;
  }

  /** Effective grants, then session-only entries marked `(session)` (FR9/FR10). */
  function grantSection(): string[] {
    const lines = [
      ...formatGrantList(grants).map((line) => `  - ${line}`),
      ...formatGrantList(sessionGrants).map((line) => `  - ${line}  (session)`),
    ];
    return lines.length === 0 ? ["  (none)"] : lines;
  }

  /**
   * Runtime accessors for `registerAccessTool` (Phase 5). The tool asks here to
   * persist or record one grant and to re-activate; it never composes a
   * configuration. `recordSessionGrant` and `persistGrant` rebuild in FR7 order
   * and neither one activates.
   */
  const runtimeAccessors: RuntimeAccessors = {
    getConfig: () => config,
    setConfig: (next) => {
      // Kept for the accessor surface. The access tool never calls it: the
      // rebuild in `recordSessionGrant`/`persistGrant` is the only composer.
      config = next;
    },
    getState: () => state,
    getFailureReason: () => failureReason,
    getSessionRoot: () => sessionRoot,
    getAgentDir: () => getAgentDir(),
    isStoreLocked: () => grantStoreLocked,
    recordSessionGrant: (input) => {
      sessionGrants = addGrant(sessionGrants, input, sessionRoot).grants;
      rebuildConfig();
    },
    // The tool's only durable write. It rebuilds in FR7 order and never
    // activates: the tool decides the session fallback and calls `activate`.
    persistGrant: (input) => {
      const next = addGrant(grants, input, sessionRoot);
      saveGrants(getAgentDir(), sessionRoot, next.grants);
      grants = pruneExpired(next.grants);
      rebuildConfig();
      return next.grant;
    },
    recordDecision: (record) => {
      try {
        pi.appendEntry("seatbelt-grant", record);
      } catch {
        // The session record is best effort (FR10).
      }
    },
    activate: (ctx) => activate(ctx),
  };

  registerAccessTool(pi, runtimeAccessors);

  function formatStatus(): string {
    const lines = [
      "Seatbelt sandbox:",
      `  state: ${state}${failureReason ? ` (${failureReason})` : ""}`,
      `  status: ${statusText()}`,
      `  network: ${config.network.mode}`,
      `  environment: ${config.environment.mode}${config.environment.mode === "filtered" ? ` (${config.environment.deny.length} denied variables)` : ""}`,
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
      "Grants:",
      ...grantSection(),
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

interface GrantStartNotice {
  type: "info" | "warning" | "error";
  text: string;
}

/**
 * The one grant notice emitted on session start (FR10). A warning means the
 * store was not applied at all, so it is the only thing worth reporting; a
 * missing target is reported next to the applied count and stays on disk.
 */
function grantStartNotice(loaded: LoadGrantsResult): GrantStartNotice | undefined {
  switch (loaded.warning) {
    case "corrupt":
      return { type: "error", text: "Seatbelt grant store is unusable (corrupt); run /seatbelt grants reset" };
    case "version":
      return { type: "error", text: "Seatbelt grant store has an unsupported version; run /seatbelt grants reset" };
    case "store-inside-workspace":
      return { type: "warning", text: "Seatbelt grant store directory is inside the workspace; grants are disabled for this project" };
    case "project-mismatch":
      return { type: "warning", text: "Seatbelt grant store belongs to another project; grants are disabled for this project" };
    case undefined:
      break;
  }

  if (loaded.grants.length === 0) return undefined;
  const applied = `Seatbelt grants: ${loaded.grants.length} applied for this project`;
  const missing: string[] = [];
  for (const grant of loaded.grants) {
    if (grant.kind !== "network" && !existsSync(grant.path)) missing.push(`${grant.id} ${sanitizeForDisplay(grant.path)}`);
  }
  if (missing.length === 0) return { type: "info", text: applied };
  return { type: "info", text: `${applied}; missing grant targets: ${missing.join(", ")}` };
}

function errorMessage(error: unknown): string {
  if (error instanceof ConfigError) return error.message;
  return error instanceof Error ? error.message : String(error);
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
