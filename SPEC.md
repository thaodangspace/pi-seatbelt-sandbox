# pi-seatbelt-sandbox — Implementation Spec

Status: draft v1 · Target: macOS only · Pi: `@earendil-works/pi-coding-agent` (verified against **v0.80.3**)

A Pi extension that runs the agent's `bash` commands inside a macOS Seatbelt
(`sandbox-exec`) sandbox and enforces a path-access policy on the in-process
file tools (`read`/`write`/`edit`/`grep`/`find`/`ls`). Two enforcement layers,
because the OS sandbox only constrains subprocesses — the file tools run inside
the Pi Node process and are not covered by Seatbelt.

This spec supersedes the original design. It records the decisions taken after
auditing that design against the real Pi API and its official
`examples/extensions/sandbox` reference.

---

## 1. Decisions (locked)

1. **Hand-roll the Seatbelt `.sb` profile generator.** No dependency on
   `@anthropic-ai/sandbox-runtime`. Rationale: keep the plugin tiny, macOS-only,
   zero-sandbox-dependency, and fully auditable. Trade-off accepted: we own all
   Seatbelt-syntax correctness risk and must validate it with real
   `sandbox-exec` integration tests (§6, §11).
2. **Enforce the file-tool policy via `pi.on("tool_call", …)` interception**,
   not by re-registering `read`/`write`/`edit`/`grep`/`find`/`ls`. All six file
   tools expose a uniform `path` input field, and `ToolCallEventResult` supports
   `{ block, reason }`. One handler covers all of them, reimplements nothing, and
   cannot be bypassed by the tools it guards.

---

## 2. Goals / Non-goals

### Goals
- Agent `bash` and user (`!`) bash both run under `sandbox-exec` with a
  fail-closed profile.
- File tools cannot read/write outside configured roots, and cannot touch
  deny-listed paths (secrets, `.git/hooks`, `.env`, key material).
- Fail closed: if the platform isn't macOS, `sandbox-exec` is missing, or the
  profile can't be built, **bash refuses to run** — it never runs unsandboxed.
- Small, few-dependency, single-purpose, easy to review.

### Non-goals
- Linux / Windows support (explicitly macOS-only; other platforms → fail closed).
- Domain-based network allow-listing (Seatbelt can't do it without a proxy; see
  §6.4). Network is coarse: `none` / `localhost` / `all`.
- Environment allow-listing. Environment policy is deliberately small: `inherit`
  or exact-name filtering via `filtered` (an allow-only mode is future work).
- Sandboxing MCP tools or arbitrary extension code (Pi extensions run with full
  system access by design; this plugin only constrains the built-in tools).
- Letting the **agent** change sandbox config. Only the **user** may, via slash
  commands (§9).

---

## 3. Architecture

```
                       Pi process (Node, unsandboxed)
 ┌───────────────────────────────────────────────────────────────────┐
 │  extension index.ts                                                 │
 │                                                                     │
 │  Layer A — OS sandbox (subprocess-enforced)                         │
 │    registerTool(bash')  ─┐                                          │
 │    on("user_bash")      ─┴─► BashOperations.exec()                  │
 │                                └─► sandbox-exec -f <profile> \       │
 │                                      /bin/bash -c "<command>"        │
 │                                                                     │
 │  Layer B — path policy (in-process, advisory)                       │
 │    on("tool_call")  ─► if toolName ∈ {read,write,edit,grep,find,ls} │
 │                          check input.path vs policy                 │
 │                          → allow | { block:true, reason }           │
 └───────────────────────────────────────────────────────────────────┘
```

Layer A is OS-enforced (a compromised subprocess still can't escape Seatbelt).
Layer B is advisory policy inside the trusted Node process — it stops the agent
from *asking* Pi's file tools to touch forbidden paths, but it is not an OS
boundary. State this honestly in the README (§11).

---

## 4. Package structure & manifest

```
pi-seatbelt-sandbox/
  package.json
  index.ts                 # extension entrypoint (default export)
  src/
    config.ts              # load + merge + variable expansion + validation
    seatbelt.ts            # .sb profile generator + temp-file lifecycle
    bash.ts                # createSeatbeltBashOperations()
    sandbox-exec.ts        # trusted absolute Seatbelt launcher path
    policy.ts              # path canonicalization + allow/deny checks
    tool-guard.ts          # tool_call handler wiring policy to file tools
  test/
    seatbelt.test.ts
    policy.test.ts
    bash.test.ts
    integration.sandbox.test.ts   # real sandbox-exec, gated on darwin
  README.md
```

### package.json (corrected)

```jsonc
{
  "name": "pi-seatbelt-sandbox",
  "version": "0.1.0",
  "type": "module",
  "license": "MIT",
  "engines": { "node": ">=20" },
  "peerDependencies": {
    // real published version; NOT ^0.0.0
    "@earendil-works/pi-coding-agent": ">=0.80.0"
  },
  "devDependencies": {
    "@earendil-works/pi-coding-agent": ">=0.80.0",
    "@sinclair/typebox": "^0.34.0"   // NOT the unscoped "typebox" package
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Notes:
- The SDK is a **peer** dependency (Pi provides it at runtime). Do not pin
  `^0.0.0`.
- If tool schemas are needed, import `Type` from `@sinclair/typebox` (the
  package Pi actually uses) or via the SDK re-export — never the unscoped
  `typebox`. With the interception design we likely need **no** schema at all.
- Keep the dependency count at zero runtime deps beyond the peer SDK.

---

## 5. Configuration

### 5.1 File locations & precedence
Use Pi's exported helpers rather than hardcoding `.pi`:

```ts
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

const projectPath = join(ctx.cwd, CONFIG_DIR_NAME, "seatbelt.json");        // <cwd>/.pi/seatbelt.json
const globalPath  = join(getAgentDir(), "extensions", "seatbelt.json");     // ~/.pi/agent/extensions/seatbelt.json
```

The effective policy is layered as `DEFAULT_CONFIG` → trusted global policy →
project restrictions. The global policy is the maximum privilege ceiling. A
project may narrow the policy, but may not silently weaken it:

- `enabled: true` and `failClosed: true` cannot be changed to `false`;
- network mode may only become stricter (`all` → `localhost` → `none`);
- `readable` and `writable` entries must remain within the corresponding global
  allowance (a project list replaces the global list with a subset);
- project `denyRead` and `denyWrite` entries are unioned with global denies, so
  global deny rules cannot be removed;
- project environment policy may switch from `inherit` to `filtered`, but may
  not switch a globally filtered policy back to `inherit`; environment deny
  names are unioned so project config cannot remove trusted denies.

Widening attempts are explicit configuration errors and fail closed. Explicit
user actions, such as `--no-seatbelt` or `/seatbelt off`, are separate from
repository-controlled configuration. Global config is merged shallowly over the
defaults; project config is applied by the restriction rules above.

Config is loaded in `session_start` using **`ctx.cwd`**, not at module init with
`process.cwd()` (the workspace may differ from the process cwd).

### 5.2 Schema

```ts
type NetworkMode = "none" | "localhost" | "all";

interface SeatbeltConfig {
  enabled: boolean;        // default true
  failClosed: boolean;     // default true
  readable: string[];      // subpaths allowed for file-read* (OS layer + policy)
  writable: string[];      // subpaths allowed for file-write*
  denyRead: string[];      // subtracted from readable
  denyWrite: string[];     // subtracted from writable
  environment: {
    mode: "inherit" | "filtered"; // default "inherit"
    deny: string[];                // exact names removed in filtered mode
  };
  network: { mode: NetworkMode };  // default "localhost"
}
```

### 5.3 Environment policy

Sandboxed subprocesses inherit the environment passed by Pi unless filtering is
selected. Seatbelt cannot hide a process's own inherited environment, so this is
a separate security surface from filesystem rules. `inherit` is the compatibility
default. `filtered` copies the source environment and removes each name in
`environment.deny` before `spawn()`; the source object is never mutated. Names
are matched exactly, with no shell-style wildcard syntax in v1. Variables not
listed remain available, including normal runtime/toolchain variables such as
`PATH`, `HOME`, `TMPDIR`, `TERM`, `LANG`, `LC_*`, and `SHELL`.

The `/seatbelt` status output reports the mode and count of denied names without
printing environment values. A future `allow-only` mode is out of scope for v1.

### 5.4 Variable expansion (must be specified — the original omitted it)
Every string in `readable`/`writable`/`denyRead`/`denyWrite` is expanded before
use, with these variables only. Environment deny entries are not paths and are
not expanded:

| Token          | Expands to                                             |
|----------------|--------------------------------------------------------|
| `${WORKSPACE}` | `ctx.cwd` (realpath-resolved)                          |
| `${HOME}`      | `os.homedir()`                                         |
| `${TMPDIR}`    | `os.tmpdir()` (realpath-resolved; on macOS under `/private/var/folders`) |

Rules:
- Expansion is literal token replacement, then `path.resolve` to absolute.
- Unknown `${...}` tokens are a **config error** → fail closed (do not pass an
  unexpanded `${FOO}` to Seatbelt).
- Glob patterns (`**/*.pem`, `.env.*`) are **not** expanded by Seatbelt (it takes
  `subpath` prefixes only). Globs are honored only by the Layer-B policy matcher
  (§8). Document that a glob in `readable`/`writable` is ignored by the OS layer.

### 5.5 Defaults (`DEFAULT_CONFIG`)

```jsonc
{
  "enabled": true,
  "failClosed": true,
  "readable": [
    "${WORKSPACE}", "/bin", "/sbin", "/usr", "/System", "/Library",
    "/Applications/Xcode.app", "/Applications/Xcode-beta.app",
    "/opt/homebrew", "/usr/local", "/etc", "/private/etc",
    "/dev/null", "/dev/urandom"
  ],
  "writable": ["${WORKSPACE}", "${TMPDIR}"],
  "denyRead": [
    "${HOME}/.ssh", "${HOME}/.aws", "${HOME}/.gnupg",
    "${HOME}/.config/gcloud", "${HOME}/.netrc", "${HOME}/.git-credentials"
  ],
  "denyWrite": [
    "${WORKSPACE}/.git/hooks", "${WORKSPACE}/.env", "${WORKSPACE}/.env.local"
  ],
  "environment": { "mode": "inherit", "deny": [] },
  "network": { "mode": "localhost" }
}
```

`/etc`, `/dev/null`, `/dev/urandom` added vs the original because most real
commands need them. `/Applications/Xcode*.app` is readable so macOS developer-tool
shims such as `/usr/bin/git` can load `libxcrun.dylib` when `xcode-select` points
at a full Xcode install; validate the minimal set during integration testing (§11).

---

## 6. Seatbelt profile generator (`src/seatbelt.ts`)

### 6.1 Public surface

```ts
export type NetworkMode = "none" | "localhost" | "all";
export interface SeatbeltProfileOptions {
  readable: string[]; writable: string[];
  denyRead: string[]; denyWrite: string[];
  network: NetworkMode;
}
export function renderSeatbeltProfile(o: SeatbeltProfileOptions): string;

// Lifecycle: build ONCE per session, reuse across commands, remove on shutdown.
export function createProfileFile(o: SeatbeltProfileOptions): Promise<{
  path: string;
  dispose(): Promise<void>;
}>;
```

### 6.2 Temp-file lifecycle (fixes the per-exec leak + TOCTOU)
- Create the profile **once** in `session_start` (or lazily on first exec), not
  on every `exec()` call.
- Use `mkdtemp(join(tmpdir(), "pi-seatbelt-"))` — never a fixed
  `/tmp/pi-seatbelt.sb` (predictable, world-writable, symlink-swappable).
- `chmod 0700` the temp dir; write the profile `0600`.
- `dispose()` removes the dir; call it from `session_shutdown`.
- Only regenerate the profile if config changes at runtime (§9 commands).

### 6.3 Profile template (fail-closed)

```lisp
(version 1)
(deny default)

;; Base system access. IMPORTANT: verify that importing bsd/system does not
;; over-grant relative to (deny default). If it does, inline the minimal
;; allows instead of importing. This MUST be checked in integration tests.
(import "bsd.sb")

(allow process-fork)
(allow process-exec)
(allow signal (target self))
(allow sysctl-read)

;; Explicit filesystem policy (subpath = prefix match on canonical paths).
(allow file-read*  <readable subpaths...>)
(allow file-write* <writable subpaths...>)

;; Deny rules LAST so they override the allows above (Seatbelt = last match wins).
(deny file-read*  <denyRead subpaths...>)
(deny file-write* <denyWrite subpaths...>)

;; Temp / runtime scratch.
(allow file-read* file-write*
  (subpath "/private/tmp")
  (subpath "/private/var/tmp")
  (subpath "/private/var/folders"))

<network rules per §6.4>
```

Correctness requirements (all covered by tests in §11):
- **Ordering matters.** Seatbelt applies the *last matching* rule. Deny rules
  must come **after** the allow rules so a denyRead inside a readable root wins.
  (The original placed them in generation order but this invariant was never
  stated — make it explicit and test it.)
- Paths are quoted with `JSON.stringify` (handles spaces/quotes).
- Paths passed to `(subpath …)` must be **canonical absolute** (realpath) — a
  `subpath` on a symlink does not match the resolved target. Canonicalize in the
  generator, consistent with the policy layer (§8).
- Empty rule lists emit **nothing** (never an empty `(allow file-read*)`, which
  is a syntax error).

### 6.4 Network (the fragile part — needs validation, not assumption)
The original's `(remote ip "localhost:*")` / `"127.0.0.1:*"` / `"::1:*"` is **not
reliably valid** Seatbelt syntax and Seatbelt cannot do hostname filtering.

- `all`:   `(allow network*)` — outbound and inbound.
- `none`:  emit no network allow → `(deny default)` blocks all sockets. (Also
  allow `(allow network* (local ip "localhost:*"))`? No — keep none = fully off;
  validate that local unix-socket IPC the shell needs still works, add
  `(allow network-bind (local ip "localhost:*"))` only if a test proves it's
  required.)
- `localhost`: attempt loopback-only. The candidate rule is:
  ```lisp
  (allow network-outbound (remote ip "localhost:*"))
  (allow network-inbound  (local  ip "localhost:*"))
  ```
  This **must be proven** by an integration test that (a) `curl 127.0.0.1:<port>`
  to a local listener succeeds and (b) `curl https://example.com` fails. **If the
  syntax proves unreliable on the target macOS version, `localhost` mode is a
  hard error at config-load time** (fail closed) rather than silently degrading
  to `all`. Document the tested macOS versions in the README.

Do not ship `localhost` mode until its test passes on the CI/dev macOS version.

---

## 7. Bash override (`src/bash.ts`)

### 7.1 Operations factory
Mirror the official example's `BashOperations` exactly (verified signature:
`exec(command, cwd, { onData, signal, timeout, env })`):

```ts
export function createSeatbeltBashOperations(profilePath: string): BashOperations {
  return {
    async exec(command, cwd, { onData, signal, timeout, env }) {
      if (process.platform !== "darwin") throw new Error("pi-seatbelt-sandbox: macOS only");
      if (!existsSync(cwd)) throw new Error(`cwd does not exist: ${cwd}`);

      const child = spawn(
        SANDBOX_EXEC_PATH,
        ["-f", profilePath, "/bin/bash", "-c", command],   // NOTE: -c, not -lc (§7.3)
        { cwd, env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      // ... stdout/stderr → onData, timeout → SIGKILL process group,
      //     signal.abort → SIGKILL, resolve { exitCode } on close.
      //     (Follow the reference example's kill/timeout/abort handling verbatim.)
    },
  };
}
```

`SANDBOX_EXEC_PATH` is the single trusted constant defined in
`src/sandbox-exec.ts`:

```ts
export const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
```

Both availability checks and process launches use this absolute path; `PATH` is
never used to locate the Seatbelt launcher.

### 7.2 Wiring (fixes gating + user_bash gap)
Follow the reference example's pattern — register a bash tool that falls back to
plain local bash when the sandbox is disabled, and **also** handle `user_bash`:

```ts
const localBash = createBashTool(ctx.cwd);

pi.registerTool({
  ...localBash,
  label: "bash (seatbelt)",
  async execute(id, params, signal, onUpdate, c) {
    if (!active) return localBash.execute(id, params, signal, onUpdate);   // gated
    const sb = createBashTool(ctx.cwd, { operations: createSeatbeltBashOperations(profilePath) });
    return sb.execute(id, params, signal, onUpdate);
  },
});

// Close the bypass: user `!command` bash must be sandboxed too.
pi.on("user_bash", () => {
  if (!active) return;
  return { operations: createSeatbeltBashOperations(profilePath) };
});
```

`active` is `true` only after `session_start` confirms macOS + `enabled` +
profile built (§9). When fail-closed and not-macOS, `active` stays false **and**
the tool's `execute` must refuse (§9.2) rather than silently run local bash.

### 7.3 `bash -c`, not `-lc`
Use `/bin/bash -c`. A login shell (`-l`) sources `~/.bash_profile` / `~/.profile`,
which (a) may be denied by `denyRead` and error, and (b) re-injects the user's
env/PATH, diverging from Pi's normal bash semantics. Inherit `env` from the
`exec` context as the example does.

---

## 8. File-tool path policy (`src/policy.ts` + `src/tool-guard.ts`)

### 8.1 Canonicalization (fixes the symlink-escape on new files)

```ts
function canon(p: string): string {
  const abs = resolve(p);
  try { return realpathSync(abs); }          // existing path: resolve symlinks
  catch {
    // Non-existent (e.g. write to a new file): realpath the nearest EXISTING
    // ancestor, then re-append the remaining segments. This prevents a
    // symlinked parent dir from escaping the writable root.
    const parent = dirname(abs);
    if (parent === abs) return abs;
    return join(canon(parent), basename(abs));
  }
}
```

`isInside(child, root)`: compare canonical paths; `child === root ||
child.startsWith(root + sep)` (the `+ sep` guards `/foo` vs `/foobar` — the
original got this right; keep it).

Glob support for policy (Seatbelt can't, but Layer B can): deny entries
containing `*` are matched with a globber (e.g. `picomatch`-style, or a tiny
in-house matcher — prefer zero-dep) against the canonical path. `readable`/
`writable` globs: treat a glob entry as matching if the canonical path matches
the glob OR is inside the glob's non-glob prefix. Keep this small and tested.

### 8.2 Checks

```ts
assertCanRead(path, policy):  denyRead match → block; not in any readable → block.
assertCanWrite(path, policy): denyWrite match → block; not in any writable → block.
```

### 8.3 tool_call handler (the whole Layer B)

```ts
const READERS = new Set(["read", "grep", "find", "ls"]);
const WRITERS = new Set(["write", "edit"]);

pi.on("tool_call", (event) => {
  if (!active) return;
  const name = event.toolName;
  const target = (event.input as { path?: string }).path;   // all six use `path`
  if (!target) return;                                       // nothing to check
  try {
    if (READERS.has(name)) assertCanRead(target, policy);
    else if (WRITERS.has(name)) assertCanWrite(target, policy);
    else return;                                             // bash/custom: Layer A handles
  } catch (e) {
    return { block: true, reason: (e as Error).message };
  }
});
```

Notes:
- Verified: `ToolCallEventResult = { block?: boolean; reason?: string }` and the
  contract is "to modify arguments, mutate `event.input` in place." We only ever
  block here; we don't mutate.
- Verified: `read`/`write`/`edit`/`grep`/`find`/`ls` inputs all carry a `path`
  field (read/write/edit also have others we don't need for path policy).
- `edit`/`write` create files → §8.1 canonicalization is what makes write checks
  correct for non-existent targets.
- `bash` tool_call is intentionally **not** path-checked here — Layer A (Seatbelt)
  enforces bash. Blocking bash paths in JS would be both incomplete and redundant.

---

## 9. Extension lifecycle & fail-closed

### 9.1 Entrypoint shape (verified against ExtensionAPI)

```ts
export default function seatbeltSandbox(pi: ExtensionAPI) {
  pi.registerFlag("no-seatbelt", { description: "Disable the Seatbelt sandbox", type: "boolean", default: false });

  let active = false;
  let policy: PathPolicy;
  let profile: { path: string; dispose(): Promise<void> } | undefined;
  let config: SeatbeltConfig;

  // register bash override + user_bash + tool_call here (they read `active`)

  pi.on("session_start", async (_e, ctx) => {
    config = loadConfig(ctx.cwd);
    if (!config.enabled || pi.getFlag("no-seatbelt")) { active = false; notifyDisabled(); return; }
    if (process.platform !== "darwin") { active = false; failClosedOrWarn(); return; }
    try { accessSync(SANDBOX_EXEC_PATH, constants.X_OK); }
    catch { active = false; failClosedOrWarn(); return; }
    try {
      policy  = buildPolicy(config, ctx.cwd);
      profile = await createProfileFile(toProfileOptions(config));
      active  = true;
      ctx.ui.setStatus("seatbelt", ctx.ui.theme.fg("accent", `🔒 seatbelt: net=${config.network.mode}`));
    } catch (err) { active = false; failClosed(err); }
  });

  pi.on("session_shutdown", async () => { await profile?.dispose(); });

  pi.registerCommand("seatbelt", { /* §10 */ });
}
```

### 9.2 Fail-closed semantics (fixes "throw crashes Pi")
Fail-closed must NOT be a `throw` in the factory (that can take down Pi). Instead:
- When `failClosed` is true and the sandbox cannot be established (non-macOS,
  missing `sandbox-exec`, profile build error): keep `active = false` **and** make
  the bash tool's `execute` (and `user_bash`) **return an error result** ("bash is
  disabled: Seatbelt sandbox unavailable") instead of falling back to local bash.
  Notify the user with `ctx.ui.notify(msg, "error")`.
- When `failClosed` is false: warn and fall back to unsandboxed local bash (opt-in
  degraded mode, matching the reference example's behavior).

So there are three states: **active** (sandboxed), **fail-closed** (bash refuses),
**degraded** (unsandboxed, only if `failClosed:false`).

---

## 10. Commands / UX

Slash commands are user-invoked (never agent-invokable), which automatically
satisfies "the agent must not change sandbox config."

- `/seatbelt` — show current state (active/fail-closed/degraded), readable/writable
  roots, deny lists, network mode. (Verified: `registerCommand(name, { description,
  handler: async (args, ctx) => … })`, `ctx.ui.notify(msg, level)`.)
- `/seatbelt network none|localhost|all` — change network mode for **this session**;
  regenerates the profile (dispose old, create new) and updates `active`.
- `/seatbelt allow-read <path>` / `/seatbelt allow-write <path>` — add a session-only
  root; regenerate profile. Session-only; not persisted.
- `/seatbelt off` — disable for this session (sets `active = false`; if
  `failClosed`, bash refuses; else degraded).

Persistence: session-only changes live in memory. **Permanent** changes require
the user to edit the config file by hand — the commands never write config to disk.
`args` is a raw string; parse subcommands manually (registerCommand has no
subcommand schema).

---

## 11. Security model & testing

### 11.1 Threat model (state plainly in README)
- **Layer A (bash) is OS-enforced**: even a fully compromised command cannot read/
  write outside the profile or open denied sockets.
- **Layer B (file tools) is advisory, in-process**: it prevents the agent from
  directing Pi's own file tools at forbidden paths. It is *not* an OS boundary and
  does not constrain arbitrary Node code or other extensions. Pi extensions run
  with full system access — this plugin reduces the built-in tools' blast radius,
  it does not sandbox Pi itself.
- Nested sandbox: a sandboxed `bash` cannot re-invoke `sandbox-exec` to widen its
  own profile (Seatbelt forbids loosening). Verify.

### 11.2 Tests (blocking for release)
Unit (any platform):
- `renderSeatbeltProfile`: rule ordering (deny after allow), quoting, empty-list
  omission, variable expansion, unknown-token → error.
- `policy`: inside/boundary (`/foo` vs `/foobar`), symlink parent escape on
  non-existent write target, deny-beats-allow, glob deny matching.

Integration (darwin-gated, real `sandbox-exec`):
1. read allowed root ✓ / read `${HOME}/.ssh` ✗
2. write in `${WORKSPACE}` ✓ / write outside ✗ / write `.env` ✗
3. network `none`: all sockets blocked; `all`: outbound works;
   **`localhost`: loopback works AND public egress blocked** (gates shipping
   localhost mode — §6.4).
4. deny-inside-allow: `denyRead` path within a `readable` root is actually denied
   (proves rule ordering).
5. `import "bsd.sb"` does not over-grant beyond `(deny default)` for a
   representative forbidden path.
6. profile temp dir is `0700`, removed on `session_shutdown`.
7. fail-closed: with `failClosed:true`, bash refuses when
   `/usr/bin/sandbox-exec` is unavailable or not executable — never runs
   unsandboxed. A fake `sandbox-exec` earlier in `PATH` must never be invoked.
8. `user_bash` path is sandboxed (not just the agent tool).

Manual smoke: `pi -e ./index.ts`, run a benign build (`npm ci` under
`network:"all"`), confirm normal workflows survive the default profile; tune the
default `readable` set from real failures.

---

## 12. Implementation phases

1. **Skeleton + config** — package.json (corrected deps), `config.ts` (load/merge/
   expand/validate), `/seatbelt` read-only command. Verify `pi -e` loads it.
2. **Seatbelt generator** — `seatbelt.ts` + unit tests + profile lifecycle
   (mkdtemp/0700/dispose). Land `none` and `all` network modes.
3. **Bash layer** — `bash.ts`, tool override with gating, `user_bash`,
   fail-closed states. Darwin integration tests (read/write/network none+all).
4. **Path policy** — `policy.ts` + `tool-guard.ts` + `tool_call` wiring + unit
   tests (incl. symlink escape).
5. **localhost network mode** — implement + prove with the loopback test; if it
   can't be proven on target macOS, ship it as a config error, not silently.
6. **Commands + README** — session-only mutation commands; README with the
   threat-model honesty section and tested-macOS-version note.

---

## 13. Open questions / risks

- **Seatbelt `localhost` filtering** may not be expressible reliably; §6.4 makes
  this a gated, test-proven feature, not an assumption.
- **`import "bsd.sb"` vs `system.sb`**: which base import gives a working shell
  without over-granting under `(deny default)`? Determined empirically in phase 3;
  fall back to an inline minimal allow-list if imports over-grant.
- **Default `readable` set**: `/etc`, `/dev/*`, dyld caches, `/private/var/db`
  may be needed by common tools; finalized from integration + smoke failures.
- **Config file trust**: a project-local `.pi/seatbelt.json` can *widen* the
  sandbox. Consider gating project-config widening behind Pi's `project_trust`
  event so an untrusted repo can't relax the sandbox silently. (Deferred; note in
  README.)
```
