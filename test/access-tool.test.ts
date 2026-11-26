import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GrantDecisionRecord, RuntimeAccessors, RuntimeState } from "../index.ts";
import { ACCESS_DIALOG_OPTIONS, ACCESS_DIALOG_TITLE, ACCESS_TOOL_NAME, registerAccessTool } from "../src/access-tool.ts";
import type { SeatbeltConfig } from "../src/config.ts";
import { GrantStoreError, type NewGrantInput } from "../src/grants.ts";
import { canon } from "../src/policy.ts";

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

/** A target that R1 accepts: an existing directory outside every protected location. */
function existingTarget(prefix = "seatbelt-access-target-"): string {
  const dir = tempDir(prefix);
  writeFileSync(join(dir, "file.txt"), "");
  return realpathSync(dir);
}

const BASE_CONFIG: SeatbeltConfig = {
  enabled: true,
  failClosed: true,
  readable: [],
  writable: [],
  denyRead: [],
  denyWrite: [],
  environment: { mode: "inherit", deny: [] },
  network: { mode: "localhost" },
};

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  execute: (...args: any[]) => Promise<{ content: { type: "text"; text: string }[]; details: unknown }>;
}

interface FakeRuntimeOptions {
  storeLocked?: boolean;
  persistError?: Error;
  /** An `activate` that rejects instead of fail-closing internally. */
  activateError?: Error;
  /** State the runtime reports after `activate`. Defaults to staying `active`. */
  activateState?: RuntimeState;
}

function createRuntime(options: FakeRuntimeOptions = {}) {
  const workspace = tempDir("seatbelt-access-workspace-");
  const agentDir = tempDir("seatbelt-access-agent-");
  const ui = { select: vi.fn<(...args: any[]) => Promise<string | undefined>>(), notify: vi.fn(), setStatus: vi.fn() };
  const sessions: { sessionGrants: NewGrantInput[]; persistedGrants: NewGrantInput[]; decisions: GrantDecisionRecord[]; activateCalls: number } = {
    sessionGrants: [],
    persistedGrants: [],
    decisions: [],
    activateCalls: 0,
  };
  let state: RuntimeState = "active";
  let failureReason: string | undefined;

  const deps: RuntimeAccessors = {
    getConfig: () => BASE_CONFIG,
    setConfig: vi.fn(),
    getState: () => state,
    getFailureReason: () => failureReason,
    getSessionRoot: () => workspace,
    getAgentDir: () => agentDir,
    isStoreLocked: () => options.storeLocked === true,
    recordSessionGrant: vi.fn((input: NewGrantInput) => {
      sessions.sessionGrants.push(input);
    }),
    persistGrant: vi.fn((input: NewGrantInput) => {
      if (options.persistError) throw options.persistError;
      sessions.persistedGrants.push(input);
      const createdAt = "2026-11-26T00:00:00.000Z";
      return input.kind === "network"
        ? { id: "abc12345", kind: "network" as const, mode: input.mode, createdAt, expiresAt: null }
        : { id: "abc12345", kind: input.kind, path: input.path, createdAt, expiresAt: null };
    }),
    recordDecision: vi.fn((record: GrantDecisionRecord) => {
      sessions.decisions.push(record);
    }),
    activate: vi.fn(async () => {
      sessions.activateCalls += 1;
      if (options.activateError) throw options.activateError;
      if (options.activateState) {
        state = options.activateState;
        failureReason = "profile creation failed";
      }
    }),
  };

  const tools = new Map<string, CapturedTool>();
  const pi = {
    registerTool: (tool: CapturedTool) => {
      tools.set(tool.name, tool);
    },
  } as unknown as ExtensionAPI;
  registerAccessTool(pi, deps);

  const tool = tools.get(ACCESS_TOOL_NAME);
  if (!tool) throw new Error("access tool was not registered");

  return {
    workspace,
    agentDir,
    ui,
    deps,
    tool,
    tools,
    get sessionGrants() {
      return sessions.sessionGrants;
    },
    get persistedGrants() {
      return sessions.persistedGrants;
    },
    get decisions() {
      return sessions.decisions;
    },
    get activateCalls() {
      return sessions.activateCalls;
    },
    request: (params: unknown, overrides: Record<string, unknown> = {}) =>
      tool.execute("call-1", params, undefined, undefined, { hasUI: true, signal: undefined, ui, cwd: workspace, ...overrides }),
  };
}

function resultText(result: { content: { text: string }[] }): string {
  return result.content[0].text;
}

function dialogTitle(runtime: ReturnType<typeof createRuntime>, call = 0): string {
  return String(runtime.ui.select.mock.calls[call][0]);
}

describe("access tool definition", () => {
  it("registers exactly one tool without prompt injection", () => {
    const runtime = createRuntime();

    expect([...runtime.tools.keys()]).toEqual([ACCESS_TOOL_NAME]);
    expect(runtime.tool.name).toBe(ACCESS_TOOL_NAME);
    expect(runtime.tool.label.length).toBeGreaterThan(0);
    expect(runtime.tool.promptSnippet).toBeUndefined();
    expect(runtime.tool.promptGuidelines).toBeUndefined();
  });

  it("teaches the FR11 statements in its description", () => {
    const description = createRuntime().tool.description;

    expect(description).toMatch(/user decides in the terminal/i);
    expect(description).toContain("Allow and remember for this project");
    expect(description).toContain("persists the grant for this project");
    expect(description).toMatch(/deny is final for this session/i);
  });
});

describe("access tool dialog", () => {
  it("asks once with the approved title and option order", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[0]);

    const result = await runtime.request({ kind: "read", path: target, reason: "need the shared library" });

    expect(runtime.ui.select).toHaveBeenCalledOnce();
    const [title, options, dialogOptions] = runtime.ui.select.mock.calls[0];
    expect(String(title).split("\n")[0]).toBe(ACCESS_DIALOG_TITLE);
    expect(options).toEqual(["Allow for this session", "Allow and remember for this project", "Deny"]);
    expect(dialogOptions).toBeUndefined();
    expect(resultText(result)).toMatch(/allowed for this session/);
  });

  it("orders the message segments: action, target, requested form, quoted reason", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    const requestedAs = `${target}/.`;
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[0]);

    await runtime.request({ kind: "read", path: requestedAs, reason: "why" });

    const title = dialogTitle(runtime);
    const action = title.indexOf("Requested: read access");
    const canonicalTarget = title.indexOf(`Target: ${canon(requestedAs, runtime.workspace)}`);
    const asRequested = title.indexOf(`Requested as: ${requestedAs}`);
    const reason = title.indexOf('Reason: "why"');

    expect(action).toBeGreaterThanOrEqual(0);
    expect(canonicalTarget).toBeGreaterThan(action);
    expect(asRequested).toBeGreaterThan(canonicalTarget);
    expect(reason).toBeGreaterThan(asRequested);
  });

  it("states implied read access for a write request", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[2]);

    await runtime.request({ kind: "write", path: target, reason: "edit a file" });

    const title = dialogTitle(runtime);
    expect(title).toContain("Requested: write access (includes read access to the same subtree)");
    expect(title).toContain(`Target: ${target}`);
    // The path was already canonical, so there is no requested-form line.
    expect(title).not.toContain("Requested as:");
  });

  it("shows the network mode and no path segments", async () => {
    const runtime = createRuntime();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[2]);

    await runtime.request({ kind: "network", mode: "all", reason: "fetch a dependency" });

    const title = dialogTitle(runtime);
    expect(title).toContain("Requested: network access (mode: all)");
    expect(title).toContain("Target: all");
    expect(title).not.toContain("Requested as:");
    expect(title).toContain('Reason: "fetch a dependency"');
  });

  it("never passes ANSI escapes or newlines from the reason to the dialog", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[2]);

    await runtime.request({ kind: "read", path: target, reason: "need \u001b[31mred\u001b[0m\naccess\r\nnow" });

    const title = dialogTitle(runtime);
    expect(title).not.toContain("\u001b");
    expect(title.split("\n")).toHaveLength(4);
    expect(title).toContain('Reason: "need red access now"');
  });

  it("passes the turn signal to the dialog", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    const controller = new AbortController();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[2]);

    await runtime.request({ kind: "read", path: target, reason: "why" }, { signal: controller.signal });

    expect(runtime.ui.select.mock.calls[0][2]).toEqual({ signal: controller.signal });
  });
});

describe("access tool decisions", () => {
  it("persists nothing on deny and never prompts for the same target twice", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue("Deny");

    const first = await runtime.request({ kind: "read", path: target, reason: "why" });
    const second = await runtime.request({ kind: "read", path: target, reason: "why again" });

    expect(runtime.ui.select).toHaveBeenCalledOnce();
    expect(runtime.persistedGrants).toEqual([]);
    expect(runtime.sessionGrants).toEqual([]);
    expect(runtime.activateCalls).toBe(0);
    expect(resultText(first)).toMatch(/denied/);
    expect(resultText(second)).toMatch(/final for this session/);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "deny", target: canon(target, runtime.workspace) }]);
  });

  it("treats dismissal as deny and caches it", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(undefined);

    const first = await runtime.request({ kind: "write", path: target, reason: "why" });
    await runtime.request({ kind: "write", path: target, reason: "why" });

    expect(runtime.ui.select).toHaveBeenCalledOnce();
    expect(runtime.persistedGrants).toEqual([]);
    expect(resultText(first)).toMatch(/dismissed or the turn was aborted/);
    expect(runtime.decisions).toHaveLength(1);
  });

  it("treats an aborted turn as deny and caches it", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockRejectedValue(new Error("AbortError"));

    const first = await runtime.request({ kind: "read", path: target, reason: "why" }, { signal: new AbortController().signal });
    await runtime.request({ kind: "read", path: target, reason: "why" }, { signal: new AbortController().signal });

    expect(runtime.ui.select).toHaveBeenCalledOnce();
    expect(resultText(first)).toMatch(/denied/);
    expect(runtime.sessionGrants).toEqual([]);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "deny", target: target }]);
  });

  it("allows five dialogs per session and refuses the sixth as capped", async () => {
    const runtime = createRuntime();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[0]);
    const targets = Array.from({ length: 6 }, () => existingTarget());

    for (const target of targets.slice(0, 5)) {
      await runtime.request({ kind: "read", path: target, reason: "why" });
    }
    const sixth = await runtime.request({ kind: "read", path: targets[5], reason: "why" });

    expect(runtime.ui.select).toHaveBeenCalledTimes(5);
    expect(resultText(sixth)).toContain("limit of 5");
    expect(resultText(sixth)).toMatch(/final for this session/);
    expect(runtime.sessionGrants).toHaveLength(5);
    expect(runtime.decisions).toHaveLength(6);
    expect(runtime.decisions[5]).toEqual({ kind: "read", decision: "deny", target: targets[5] });
  });

  it("does not prompt without a UI and names the replacement command", async () => {
    const runtime = createRuntime();
    const target = existingTarget();

    const result = await runtime.request({ kind: "read", path: target, reason: "why" }, { hasUI: false });

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(result)).toMatch(/no interactive terminal UI/);
    expect(resultText(result)).toContain("/seatbelt allow-read");
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "deny", target }]);
    expect(runtime.sessionGrants).toEqual([]);
    expect(runtime.persistedGrants).toEqual([]);
  });

  it("names the network command when there is no UI", async () => {
    const runtime = createRuntime();

    const result = await runtime.request({ kind: "network", mode: "localhost", reason: "why" }, { hasUI: false });

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(result)).toContain("/seatbelt network localhost");
  });
});

describe("access tool grants", () => {
  it("records a session grant without touching the store", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[0]);

    const result = await runtime.request({ kind: "read", path: target, reason: "why" });

    expect(runtime.deps.recordSessionGrant).toHaveBeenCalledOnce();
    expect(runtime.sessionGrants).toEqual([{ kind: "read", path: target }]);
    expect(runtime.deps.persistGrant).not.toHaveBeenCalled();
    expect(runtime.activateCalls).toBe(1);
    expect(resultText(result)).toMatch(/allowed for this session/);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "session", target }]);
  });

  it("persists a remember decision once with the canonical target", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    const requestedAs = `${target}/.`;
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[1]);

    const result = await runtime.request({ kind: "read", path: requestedAs, reason: "why" });

    expect(runtime.deps.persistGrant).toHaveBeenCalledOnce();
    expect(runtime.deps.persistGrant).toHaveBeenCalledWith({ kind: "read", path: target });
    expect(runtime.deps.recordSessionGrant).not.toHaveBeenCalled();
    expect(runtime.activateCalls).toBe(1);
    expect(resultText(result)).toMatch(/remembered for this project/);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "remember", target }]);
  });

  it("falls back to a session grant when the store is locked", async () => {
    const runtime = createRuntime({ storeLocked: true });
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[1]);

    const result = await runtime.request({ kind: "read", path: target, reason: "why" });

    expect(runtime.deps.persistGrant).not.toHaveBeenCalled();
    expect(runtime.sessionGrants).toEqual([{ kind: "read", path: target }]);
    expect(resultText(result)).toContain("/seatbelt grants reset");
    expect(runtime.activateCalls).toBe(1);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "session", target }]);
  });

  it("turns a store error into the same session-only fallback", async () => {
    const runtime = createRuntime({ persistError: new GrantStoreError("grant store is corrupt; run /seatbelt grants reset") });
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[1]);

    const result = await runtime.request({ kind: "write", path: target, reason: "why" });

    expect(runtime.sessionGrants).toEqual([{ kind: "write", path: target }]);
    expect(runtime.activateCalls).toBe(1);
    expect(resultText(result)).toMatch(/could not be saved/);
    expect(resultText(result)).toContain("grant store is corrupt");
    expect(runtime.decisions).toEqual([{ kind: "write", decision: "session", target }]);
  });

  it("fails closed when activation fails and keeps the recorded decision", async () => {
    const runtime = createRuntime({ activateState: "fail-closed" });
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[1]);

    const result = await runtime.request({ kind: "read", path: target, reason: "why" });

    expect(resultText(result)).toContain("profile creation failed");
    expect(resultText(result)).toMatch(/grant stays on disk/i);
    expect(resultText(result)).not.toMatch(/re-activated/);
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "remember", target }]);
  });

  it("reports a fail-closed result when re-activation rejects instead of fail-closing", async () => {
    const runtime = createRuntime({ activateError: new Error("profile creation threw") });
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[0]);

    const result = await runtime.request({ kind: "read", path: target, reason: "why" });

    const text = resultText(result);
    expect(text).toContain("re-activating the sandbox failed");
    expect(text).toContain("profile creation threw");
    expect(text).not.toContain("the sandbox was re-activated");
    expect(runtime.decisions).toEqual([{ kind: "read", decision: "session", target }]);
  });

  it("does not record the agent reason in the session record", async () => {
    const runtime = createRuntime();
    const target = existingTarget();
    runtime.ui.select.mockResolvedValue(ACCESS_DIALOG_OPTIONS[1]);

    await runtime.request({ kind: "read", path: target, reason: "secret agent text" });

    expect(JSON.stringify(runtime.decisions)).not.toContain("secret agent text");
  });
});

describe("access tool gates", () => {
  it.each([
    [{ kind: "read", reason: "why" }, /path is required for a read request/],
    [{ kind: "read", path: "relative/dir", reason: "why" }, /path must be an absolute path/],
    [{ kind: "read", path: "", reason: "why" }, /path is required/],
    [{ kind: "write", path: "/tmp", mode: "all", reason: "why" }, /mode is not allowed for a write request/],
    [{ kind: "network", reason: "why" }, /mode must be "localhost" or "all"/],
    [{ kind: "network", mode: "all", path: "/tmp", reason: "why" }, /path is not allowed for a network request/],
    [{ kind: "read", path: "/tmp", reason: "" }, /reason must be 1 to 500 characters/],
    [{ kind: "execute", path: "/tmp", reason: "why" }, /kind must be "read", "write", or "network"/],
    [{ path: "/tmp", reason: "why" }, /kind must be "read", "write", or "network"/],
  ])("rejects invalid parameters %j without a dialog", async (params, message) => {
    const runtime = createRuntime();

    const result = await runtime.request(params);

    expect(resultText(result)).toMatch(message);
    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(runtime.decisions).toEqual([]);
    expect(runtime.activateCalls).toBe(0);
  });

  it("refuses to run unless the runtime is active and names the user command", async () => {
    const runtime = createRuntime({ activateState: "fail-closed" });
    const target = existingTarget();
    // Reach the non-active gate directly: activate is not called before it.
    const result = await runtime.deps.activate({ ui: runtime.ui } as never).then(() =>
      runtime.request({ kind: "write", path: target, reason: "why" }),
    );

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(result)).toMatch(/not active \(state: fail-closed\)/);
    expect(resultText(result)).toContain("/seatbelt allow-write");
    expect(runtime.decisions).toEqual([]);
  });

  it("refuses a protected target without a dialog", async () => {
    const runtime = createRuntime();

    const result = await runtime.request({ kind: "read", path: "/", reason: "why" });

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(result)).toMatch(/refused/);
    expect(resultText(result)).toMatch(/R3/);
    expect(runtime.decisions).toEqual([]);
    expect(runtime.persistedGrants).toEqual([]);
  });

  it("refuses a glob target and a path inside the grant store", async () => {
    const runtime = createRuntime();
    const globalConfig = join(runtime.agentDir, "extensions", "seatbelt.json");
    mkdirSync(join(runtime.agentDir, "extensions"), { recursive: true });
    writeFileSync(globalConfig, "{}");
    const glob = await runtime.request({ kind: "read", path: join(runtime.workspace, "*"), reason: "why" });
    const store = await runtime.request({ kind: "read", path: globalConfig, reason: "why" });

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(glob)).toMatch(/R2/);
    expect(resultText(store)).toMatch(/R4/);
  });

  it("refuses a missing target with R1", async () => {
    const runtime = createRuntime();

    const result = await runtime.request({ kind: "read", path: join(tempDir("seatbelt-access-missing-"), "gone"), reason: "why" });

    expect(runtime.ui.select).not.toHaveBeenCalled();
    expect(resultText(result)).toMatch(/R1/);
  });
});
