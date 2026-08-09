# pi-seatbelt-sandbox

macOS-only Pi extension that runs `bash` (agent and user `!`) through `sandbox-exec` and blocks built-in file tools from paths outside a configured policy.

## Install as a Pi package

```bash
pi install npm:pi-seatbelt-sandbox
# or directly from GitHub:
pi install git:github.com/thaodangspace/pi-seatbelt-sandbox
```

For a one-off local run from this checkout:

```bash
pi -e ./index.ts
# or disable explicitly
pi -e ./index.ts --no-seatbelt
```

Configuration is layered as defaults → trusted global policy → project restrictions:

- `~/.pi/agent/extensions/seatbelt.json`
- `<workspace>/.pi/seatbelt.json`

The global configuration defines the maximum privileges for the session. Project-local configuration may only narrow that policy: it cannot disable an enabled sandbox or fail-closed behavior, widen network access, add readable/writable roots outside the global allowance, or remove global deny rules. Project deny rules are added to the global deny rules. Any attempted widening is an explicit configuration error and the session fails closed. Explicit user actions such as `--no-seatbelt` and `/seatbelt off` remain separate from repository-controlled configuration.

Example:

```json
{
  "enabled": true,
  "failClosed": true,
  "readable": ["${WORKSPACE}", "/bin", "/usr", "/System", "/Library", "/Applications/Xcode.app", "/Applications/Xcode-beta.app", "/etc", "/private/etc", "/dev/null", "/dev/urandom"],
  "writable": ["${WORKSPACE}", "${TMPDIR}"],
  "denyRead": ["${HOME}/.ssh", "${HOME}/.aws"],
  "denyWrite": ["${WORKSPACE}/.git/hooks", "${WORKSPACE}/.env"],
  "network": { "mode": "localhost" }
}
```

Variables supported in path lists: `${WORKSPACE}`, `${HOME}`, `${TMPDIR}`. Unknown variables are config errors. Existing configuration files are validated before merging: unreadable files, invalid JSON, unknown keys, invalid nested objects, and unsupported values are configuration errors that put the session into fail-closed mode; the UI reports the source filename.

Path semantics:

- Non-glob paths are treated as subpath roots.
- Globs using `*`, `?`, and `**` are honored exactly by the in-process file-tool policy. For example, `src/**/*.ts` allows matching TypeScript files but does not allow `src/other.txt`. Square brackets are literal path characters, not glob syntax.
- Seatbelt itself does not understand globs; glob paths are omitted from the OS profile. Use non-glob readable/writable roots for OS-enforced bash access, and globs mainly to narrow or deny built-in file-tool access.
- Guarded file tools (`read`, `grep`, `find`, `ls`, `write`, `edit`) are blocked when their `path` input is missing, empty, or not a string. Write paths containing symbolic links are also rejected, except canonical platform aliases needed to reach a configured root (for example, macOS `/var` → `/private/var`). This is a preflight check and cannot eliminate races with later filesystem changes.

## Commands

- `/seatbelt` — show current session state and policy
- `/seatbelt network none|localhost|all` — change network mode for this session
- `/seatbelt allow-read <path>` — add a session-only readable root
- `/seatbelt allow-write <path>` — add a session-only writable root
- `/seatbelt off` — disable for this session (`failClosed:true` refuses bash)

## Security model / known limitations

Global config is the trusted policy ceiling. Project-local `.pi/seatbelt.json` is a restriction-only layer; widening attempts are rejected and fail closed. Review project configuration as untrusted input even though it cannot weaken the global policy. Explicit user actions are required to widen or disable the sandbox.

The runtime is bound to the workspace cwd captured at session start. Config, policy, and the Seatbelt profile are built from that workspace. While Seatbelt is enabled, bash from a later cwd outside that workspace is refused instead of running with a mismatched policy. Start or reload a session from another workspace to use that workspace's policy.

Layer A (`bash` and user `!`) is OS-enforced by macOS Seatbelt. The extension invokes the trusted `/usr/bin/sandbox-exec` directly, so `PATH` cannot shadow the Seatbelt launcher. Layer B (`read`/`write`/`edit`/`grep`/`find`/`ls`) is advisory and runs inside Pi's trusted Node process; it prevents the agent from asking built-in file tools for forbidden paths, but it is not an OS boundary.

Pi extension code is unsandboxed and runs with full user privileges. This extension does not automatically sandbox arbitrary extension code, MCP tools, or custom tools unless they explicitly route execution through this extension's sandboxed bash operations and/or implement equivalent path checks.

While active, the extension publishes its private profile path as `PI_SEATBELT_PROFILE` and the versioned marker `PI_SEATBELT_PROFILE_SCOPE=tool-subprocess-v1` in the Pi process environment. This profile is tied to the current interactive session/workspace and is intended only for tool subprocesses; it is not a portable whole-Pi or global scheduler policy. Global schedulers must create independent run-specific policies. The extension removes only values still owned by that profile instance before disposal; consumers must fail closed if the path or scope marker is absent or unreadable. The generated policy adds a final internal write deny for its exact profile directory, so a sandboxed subprocess cannot replace the reusable profile even when temporary storage is otherwise writable.

`localhost` network mode uses Seatbelt loopback rules. Integration tests pass on macOS 26.3.1 (build 25D771280a): loopback succeeds and public egress is blocked.

## Testing and release

Useful local checks:

```bash
npm run typecheck
npm run test:unit
npm run test:integration  # macOS + sandbox-exec only
npm pack --dry-run
```

See `RELEASE.md` for the publish checklist.
