/**
 * `seatbelt_request_access`: the one tool the agent can call to ask the user
 * for extra read, write, or network access (FR1, FR2, FR4, FR8, FR10, FR11).
 *
 * `registerAccessTool(pi, deps)` takes the runtime surface as `deps`, which is
 * the `RuntimeAccessors` object from `index.ts`:
 *
 * - `getConfig()` — the effective configuration, read-only (feeds the R1–R6 gate).
 * - `getState()` / `getFailureReason()` — the runtime gate and the fail-closed reason.
 * - `getSessionRoot()` / `getAgentDir()` — the canonical target root and the
 *   protected locations the refusal gate needs.
 * - `isStoreLocked()` — whether the persisted store is unusable this session.
 * - `recordSessionGrant(input)` — install a session-only grant, then rebuild.
 * - `persistGrant(input)` — re-read the store, merge one grant, write, rebuild.
 * - `recordDecision(record)` — append the FR10 session record (best effort).
 * - `activate(ctx)` — apply the rebuilt configuration to both layers (FR8).
 * - `setConfig(next)` — part of the accessor surface but unused here: this tool
 *   never composes or spreads a configuration, because `recordSessionGrant` and
 *   `persistGrant` already rebuild in FR7 order before `activate`.
 *
 * The tool never writes the grant store itself, never widens the policy from a
 * parameter, and every agent-supplied string passes `sanitizeForDisplay` before
 * it reaches `select` or a result. Once the user allows a request, `execute`
 * never rejects: `installGrant` reports a fail-closed result instead (FR8).
 */
import { isAbsolute, join } from "node:path";
import { CONFIG_DIR_NAME, type ExtensionAPI, type ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { GrantDecisionRecord, RuntimeAccessors } from "../index.ts";
import {
  grantStoreDenyPaths,
  refuseGrantTarget,
  sanitizeForDisplay,
  type GrantKind,
  type GrantProtectedPaths,
  type NewGrantInput,
} from "./grants.ts";
import { canon } from "./policy.ts";

export const ACCESS_TOOL_NAME = "seatbelt_request_access";
export const ACCESS_DIALOG_TITLE = "Seatbelt access request";
/** The approved dialog options, in order (FR2). Dismissal counts as `Deny`. */
export const ACCESS_DIALOG_OPTIONS = ["Allow for this session", "Allow and remember for this project", "Deny"] as const;
const SESSION_CHOICE = ACCESS_DIALOG_OPTIONS[0];
const REMEMBER_CHOICE = ACCESS_DIALOG_OPTIONS[1];
const DENY_CHOICE = ACCESS_DIALOG_OPTIONS[2];
/** Dialog budget per session (FR4). */
const MAX_DIALOGS = 5;
const REASON_LIMIT = 500;

const DESCRIPTION =
  "Request extra read, write, or network access when a seatbelt policy block stops you: pass the kind, the absolute path (or the network mode), and a short reason. The user decides in the terminal whether to approve it; this tool grants nothing by itself. \"Allow and remember for this project\" persists the grant for this project, so later sessions in the same project start with it. A deny is final for this session: do not ask again for the same target.";

const PARAMETERS = Type.Object({
  kind: Type.Union([Type.Literal("read"), Type.Literal("write"), Type.Literal("network")], {
    description: 'Access to request: "read" a path, "write" a path (includes read), or "network".',
  }),
  path: Type.Optional(Type.String({ description: "Absolute path for a read or write request; rejected for network." })),
  mode: Type.Optional(
    Type.Union([Type.Literal("localhost"), Type.Literal("all")], {
      description: "Network mode for a network request; rejected for read or write.",
    }),
  ),
  reason: Type.String({
    minLength: 1,
    maxLength: REASON_LIMIT,
    description: "Why the access is needed. Shown to the user, quoted and sanitized.",
  }),
});

/** One validated request: the canonical target and the grant to record. */
interface AccessRequest {
  kind: GrantKind;
  input: NewGrantInput;
  /** The path (or mode) exactly as the agent wrote it. */
  rawTarget: string;
  /** The canonical path for read/write, the mode for network. */
  target: string;
  /** Already sanitized for display. */
  reason: string;
}

/**
 * Register the single access-request tool. Called once from `index.ts`, next to
 * `registerToolGuard`, with the live runtime accessors.
 */
export function registerAccessTool(pi: ExtensionAPI, deps: RuntimeAccessors): void {
  // Session-only state (FR4): a denied or dismissed target is never prompted
  // again, and the dialog budget is finite. Both die with this closure, so a
  // new session asks again.
  const deniedTargets = new Set<string>();
  let dialogsShown = 0;

  pi.registerTool({
    name: ACCESS_TOOL_NAME,
    label: "Request seatbelt access",
    description: DESCRIPTION,
    parameters: PARAMETERS,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // Validation precedes every other gate, so a malformed call never shows a
      // dialog and never consumes the budget (FR1).
      const validated = validateRequest(params, deps.getSessionRoot());
      if ("error" in validated) return textResult(`Invalid ${ACCESS_TOOL_NAME} parameters: ${validated.error}`);
      const request = validated.request;

      const state = deps.getState();
      if (state !== "active") {
        return textResult(
          `Seatbelt is not active (state: ${state}), so no access can be requested now. Ask the user to run ${replacementCommand(request)} instead.`,
        );
      }

      if (request.kind !== "network") {
        const refusal = refuseGrantTarget(request.target, deps.getConfig(), protectedPaths(deps));
        // A refusal is not a decision: no dialog, no store write, no record.
        if (refusal) return textResult(`Seatbelt access request refused: ${sanitizeForDisplay(refusal)}`);
      }

      const cacheKey = `${request.kind}:${request.target}`;
      if (deniedTargets.has(cacheKey)) {
        return denyResult(request, `${sanitizeForDisplay(request.target)} was already denied in this session`);
      }

      if (!ctx.hasUI) {
        deps.recordDecision(decisionRecord(request, "deny"));
        return textResult(
          `Seatbelt access denied: no interactive terminal UI is available, so nothing can be prompted. ${targetPhrase(request)} stays denied and the decision is final for this session; ask the user to run ${replacementCommand(request)} instead.`,
        );
      }

      if (dialogsShown >= MAX_DIALOGS) {
        deps.recordDecision(decisionRecord(request, "deny"));
        return textResult(
          `Seatbelt access denied: this session already reached the limit of ${MAX_DIALOGS} approval dialogs, so no further request can be shown. ${targetPhrase(request)} stays denied and the decision is final for this session; ask the user to run ${replacementCommand(request)} instead.`,
        );
      }

      dialogsShown += 1;
      const choice = await askUser(ctx, request);
      if (choice !== SESSION_CHOICE && choice !== REMEMBER_CHOICE) {
        // Denial, dismissal, and an aborted turn all deny and are remembered.
        deniedTargets.add(cacheKey);
        deps.recordDecision(decisionRecord(request, "deny"));
        return denyResult(
          request,
          choice === DENY_CHOICE ? "the user denied it" : "the prompt was dismissed or the turn was aborted",
        );
      }

      const install = installGrant(deps, request, choice === REMEMBER_CHOICE);
      // The session record is written exactly once per decision, whatever the
      // install outcome (FR10).
      deps.recordDecision(decisionRecord(request, install.persisted ? "remember" : "session"));

      if (install.failure !== undefined) {
        return textResult(
          `Seatbelt: ${targetPhrase(request)} was approved, but the grant could not be installed (${install.failure}), so the seatbelt policy was not updated and the sandbox was not re-activated. Access remains blocked; ask the user to repair the problem before asking again.`,
        );
      }

      try {
        await deps.activate(ctx);
      } catch (error) {
        return textResult(
          `Seatbelt: ${grantSummary(request, install.persisted)}, but re-activating the sandbox failed (${sanitizeForDisplay(errorMessage(error))}). Access may stay blocked until the sandbox recovers.${install.hint}`,
        );
      }

      const after = deps.getState();
      if (after !== "active") {
        const reason = deps.getFailureReason();
        return textResult(
          `Seatbelt: ${grantSummary(request, install.persisted)}, but the sandbox failed to activate (state: ${after}${reason ? `: ${sanitizeForDisplay(reason)}` : ""}). ${install.persisted ? "The grant stays on disk" : "The grant stays in this session"}; access remains blocked until the sandbox recovers.${install.hint}`,
        );
      }

      return textResult(`Seatbelt: ${grantSummary(request, install.persisted)}; the sandbox was re-activated.${install.hint}`);
    },
  });
}

/** The outcome of installing one approved grant (FR8). */
interface GrantInstall {
  /** Whether the grant reached the per-project store. */
  persisted: boolean;
  /** Extra sentence appended to the result, already sanitized. */
  hint: string;
  /**
   * Set when no grant could be installed at all: the sanitized error text. The
   * policy was not updated in that case.
   */
  failure?: string;
}

/**
 * Install one approved grant (FR8) and never throw. A store failure falls back
 * to a session-only grant — the store error already means nothing was written —
 * and a fallback that fails too returns a `failure` outcome instead of escaping
 * `execute` as a rejected promise, which would leave the runtime half-applied.
 */
function installGrant(deps: RuntimeAccessors, request: AccessRequest, remember: boolean): GrantInstall {
  let storeFailure: string | undefined;
  let hint = "";
  if (remember) {
    if (deps.isStoreLocked()) {
      hint = ` The grant store is unusable in this session, so the grant applies to this session only; run /seatbelt grants reset to repair it.`;
    } else {
      try {
        deps.persistGrant(request.input);
        return { persisted: true, hint };
      } catch (error) {
        storeFailure = sanitizeForDisplay(errorMessage(error));
        hint = ` The grant could not be saved (${storeFailure}), so it applies to this session only; run /seatbelt grants reset to repair the store.`;
      }
    }
  }

  try {
    deps.recordSessionGrant(request.input);
  } catch (error) {
    const fallbackFailure = sanitizeForDisplay(errorMessage(error));
    // A rebuild failure names the same underlying error twice; report it once.
    const detail =
      storeFailure === undefined
        ? fallbackFailure
        : storeFailure.includes(fallbackFailure)
          ? storeFailure
          : `${storeFailure}; the session fallback also failed (${fallbackFailure})`;
    return { persisted: false, hint, failure: detail };
  }
  return { persisted: false, hint };
}

/** Validate the cross-field rules and the reason length before any dialog (FR1). */
function validateRequest(raw: unknown, sessionRoot: string): { request: AccessRequest } | { error: string } {
  const params = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const kind = params.kind;
  if (kind !== "read" && kind !== "write" && kind !== "network") {
    return { error: 'kind must be "read", "write", or "network"' };
  }

  const reason = typeof params.reason === "string" ? sanitizeForDisplay(params.reason) : "";
  if (reason.length < 1 || reason.length > REASON_LIMIT) {
    return { error: `reason must be 1 to ${REASON_LIMIT} characters after sanitizing` };
  }

  if (kind === "network") {
    if (params.path !== undefined) return { error: "path is not allowed for a network request; use mode" };
    const mode = params.mode;
    if (mode !== "localhost" && mode !== "all") {
      return { error: 'mode must be "localhost" or "all" for a network request' };
    }
    return { request: { kind, input: { kind: "network", mode }, rawTarget: mode, target: mode, reason } };
  }

  if (params.mode !== undefined) return { error: `mode is not allowed for a ${kind} request; use path` };
  const path = params.path;
  if (typeof path !== "string" || path.trim().length === 0) {
    return { error: `path is required for a ${kind} request` };
  }
  if (!isAbsolute(path)) return { error: `path must be an absolute path: ${sanitizeForDisplay(path)}` };
  const target = canon(path, sessionRoot);
  return { request: { kind, input: { kind, path: target }, rawTarget: path, target, reason } };
}

/** The protected locations for the R4 refusal (FR3). */
function protectedPaths(deps: RuntimeAccessors): GrantProtectedPaths {
  const agentDir = deps.getAgentDir();
  const sessionRoot = deps.getSessionRoot();
  return {
    agentDir,
    globalConfigPath: join(agentDir, "extensions", "seatbelt.json"),
    storeDir: grantStoreDenyPaths(agentDir)[0],
    configDir: join(sessionRoot, CONFIG_DIR_NAME),
    trustFile: join(agentDir, "trust.json"),
    workspace: sessionRoot,
  };
}

/**
 * Show the dialog and map every non-allow outcome — `Deny`, dismissal
 * (`undefined`), an aborted signal, and a rejected selector — to `undefined`.
 */
async function askUser(ctx: ExtensionToolContext, request: AccessRequest): Promise<string | undefined> {
  const { signal } = ctx;
  if (signal?.aborted) return undefined;
  try {
    const choice = await ctx.ui.select(
      dialogTitle(request),
      [...ACCESS_DIALOG_OPTIONS],
      signal ? { signal } : undefined,
    );
    return signal?.aborted ? undefined : choice;
  } catch {
    return undefined;
  }
}

/**
 * Dialog text, one segment per line in FR2 order: the effective action, the
 * canonical target, the requested form when it differs, then the quoted reason.
 */
function dialogTitle(request: AccessRequest): string {
  const lines = [ACCESS_DIALOG_TITLE, `Requested: ${actionLine(request)}`, `Target: ${sanitizeForDisplay(request.target)}`];
  if (request.rawTarget !== request.target) {
    lines.push(`Requested as: ${sanitizeForDisplay(request.rawTarget)}`);
  }
  lines.push(`Reason: "${request.reason}"`);
  return lines.join("\n");
}

/** The effective action, explicit about implied access (FR2). */
function actionLine(request: AccessRequest): string {
  if (request.kind === "network") return `network access (mode: ${request.target})`;
  if (request.kind === "write") return "write access (includes read access to the same subtree)";
  return "read access";
}

function targetPhrase(request: AccessRequest): string {
  if (request.kind === "network") return `network access (mode: ${request.target})`;
  return `${request.kind} access to ${sanitizeForDisplay(request.target)}`;
}

function grantSummary(request: AccessRequest, persisted: boolean): string {
  return `${targetPhrase(request)} ${persisted ? "allowed and remembered for this project" : "allowed for this session"}`;
}

/** The user command that reaches the same outcome without the dialog (FR1/FR2). */
function replacementCommand(request: AccessRequest): string {
  const target = sanitizeForDisplay(request.target);
  if (request.kind === "network") return `/seatbelt network ${target}`;
  return `/seatbelt ${request.kind === "write" ? "allow-write" : "allow-read"} ${target}`;
}

function decisionRecord(request: AccessRequest, decision: GrantDecisionRecord["decision"]): GrantDecisionRecord {
  // The record keeps the decision and the canonical target, never the reason text (FR10).
  return { kind: request.kind, decision, target: request.target };
}

function denyResult(request: AccessRequest, detail: string) {
  return textResult(
    `Seatbelt access denied: ${detail}. ${targetPhrase(request)} stays denied and the decision is final for this session; do not ask again for this target.`,
  );
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }], details: undefined };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
