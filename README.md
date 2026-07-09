# pi-seatbelt-sandbox

macOS-only Pi extension that runs `bash` (agent and user `!`) through `sandbox-exec` and blocks built-in file tools from paths outside a configured policy.

## Install as a Pi package

```bash
pi install npm:pi-seatbelt-sandbox
# or directly from GitHub:
pi install git:github.com/dtonair/pi-seatbelt-sandbox
```

For a one-off local run from this checkout:

```bash
pi -e ./index.ts
# or disable explicitly
pi -e ./index.ts --no-seatbelt
```

Config files are merged as defaults → global → project:

- `~/.pi/agent/extensions/seatbelt.json`
- `<workspace>/.pi/seatbelt.json`

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

Variables supported in path lists: `${WORKSPACE}`, `${HOME}`, `${TMPDIR}`. Unknown variables are config errors. Globs are honored by the in-process file-tool policy; Seatbelt itself only receives non-glob prefix paths.

## Commands

- `/seatbelt` — show current session state and policy
- `/seatbelt network none|localhost|all` — change network mode for this session
- `/seatbelt allow-read <path>` — add a session-only readable root
- `/seatbelt allow-write <path>` — add a session-only writable root
- `/seatbelt off` — disable for this session (`failClosed:true` refuses bash)

## Security model

Project-local `.pi/seatbelt.json` can widen the sandbox for trusted projects; review it like other trusted project configuration.

Layer A (`bash`) is OS-enforced by macOS Seatbelt. Layer B (`read`/`write`/`edit`/`grep`/`find`/`ls`) is advisory and runs inside Pi's trusted Node process; it prevents the agent from asking built-in file tools for forbidden paths, but it is not an OS boundary and does not constrain arbitrary extension code. Pi extensions themselves run with full user privileges.

`localhost` network mode uses Seatbelt loopback rules. Integration tests pass on macOS 26.3.1 (build 25D771280a): loopback succeeds and public egress is blocked.
