# Release checklist

## Security and dependency policy

- Run `npm audit --audit-level=high`. Critical and high findings block a
  release. Moderate findings must be triaged in the release PR; a moderate
  finding that is reachable from the published extension also blocks release
  until fixed or explicitly accepted by a maintainer.
- The published package has no runtime dependencies; the Pi SDK is a peer
  dependency. The development dependency and lockfile are still audited so
  CI catches vulnerabilities in tests, tooling, and the SDK used to validate
  the extension.
- Dependency and GitHub Actions updates are reviewed through weekly Dependabot
  pull requests. Actions in CI are pinned to commit SHAs and must retain a
  release comment when updated.
- At the time of this policy's introduction, the audit reported high findings
  through `undici`, `brace-expansion`, `nanoid`, and `postcss`, plus moderate
  findings through `@earendil-works/pi-coding-agent` and `protobufjs`. The
  lockfile update to the current matching SDK and patched transitive versions
  resolves those findings; `npm audit` must remain clean before publishing.

The initial findings were dev/peer dependency findings, not dependencies
shipped in the extension tarball. Their paths and remediations were:

| Advisory package | Dependency path | Remediation |
| --- | --- | --- |
| `undici` | Pi SDK → `undici` | Pi SDK 0.84.1 → `undici` 8.9.0 |
| `brace-expansion` | Pi SDK → `minimatch` → `brace-expansion` | 5.0.9 |
| `nanoid` | Vitest → Vite → PostCSS → `nanoid` | 3.3.18 |
| `postcss` | Vitest → Vite → `postcss` | 8.5.26 |
| `protobufjs` | Pi SDK → Pi AI → Google GenAI → `protobufjs` | 7.6.5 |

The extension's runtime code does not import these packages; the Pi SDK is
loaded as a peer by the host. The CI audit remains intentionally blocking so a
new high or critical finding cannot be merged silently.

A later audit drift reported ten findings, four of them high, through packages
nested in the Pi SDK plus the Vitest/Vite toolchain:

| Advisory package | Dependency path | Remediation |
| --- | --- | --- |
| `undici` | Pi SDK → `undici` | Pi SDK 1.6.0 → `undici` 8.12.4 |
| `minimatch` | Pi SDK → `minimatch` | Pi SDK 1.6.0 → `minimatch` 11.0.3 |
| `brace-expansion` | Pi SDK → `brace-expansion` | Pi SDK 1.6.0 → `brace-expansion` 5.0.12 |
| `fast-xml-parser` | Pi SDK → Pi AI → AWS SDK → `fast-xml-parser` | Pi SDK 1.6.0 → patched line |
| `source-map-js` | Vitest → Vite → `source-map-js` | 1.2.4 |
| `vite`, `@vitest/mocker` | Vitest → `vite` | Vitest 4.1.12 → `vite` 8.3.8 |

`@earendil-works/pi-coding-agent` resolves to exactly the patched transitive
versions, so `npm audit fix` on the remaining toolchain packages (Vitest, Vite,
`source-map-js`) is enough to keep the audit clean again.

The peer range is `>=0.80.0 <2`: the extension uses Pi's stable extension/tool
APIs (`ExtensionAPI`, `ExtensionContext`, `ExtensionCommandContext`,
`createBashTool`, `BashOperations`, `CONFIG_DIR_NAME`, `getAgentDir`), which the
1.x SDK line kept. The upper bound was widened from `<1` to `<2` so the audited
dev dependency can track Pi 1.x; the lower bound is unchanged, so existing Pi
0.x hosts stay supported. CI tests the latest matching SDK in the lockfile;
changes to the peer range require a compatibility review and test update.

## Publishing a release

The `Release` workflow (`.github/workflows/release.yml`) publishes to npm. The
version in `package.json` is the release switch:

1. Open a `release: vX.Y.Z` pull request that bumps `version` in `package.json`
   (keep `package-lock.json` in sync with `npm install --package-lock-only`)
   and lists what changed. This is the only step a maintainer has to write by
   hand, and it is reviewable like any other change.
2. Merge it into `main`. The workflow then:
   - reads `name`/`version` from `package.json` and stops unless that exact
     version is missing from npm, so ordinary merges publish nothing;
   - rejects a tag/version mismatch and a commit that is not on `main`;
   - runs the release gates on a macOS runner: `typecheck`, unit tests,
     `npm audit --audit-level=high`, `npm pack --dry-run`, the sandbox
     integration tests, and the tarball smoke test;
   - publishes with `npm publish --provenance`;
   - verifies the new version is readable from the registry, then creates the
     `vX.Y.Z` tag and a GitHub release with generated notes and the tarball.

Pushing a `vX.Y.Z` tag also triggers the workflow, which is the recovery path
when the automatic run failed after publishing; the version guard makes it a
no-op once the version is live. `workflow_dispatch` runs every gate plus a
publish dry run without publishing, which is how to rehearse the pipeline.

### One-time setup

The workflow needs credentials; pick one and configure it before the first
release:

- **npm trusted publishing (preferred, no long-lived secret).** On
  <https://www.npmjs.com/package/pi-seatbelt-sandbox/access>, add a trusted
  publisher: repository `thaodangspace/pi-seatbelt-sandbox`, workflow
  `release.yml`, environment `npm-publish`. The workflow already requests
  `id-token: write` and upgrades npm, which is what OIDC publishing needs.
- **Repository secret `NPM_TOKEN`.** A granular npm access token with read and
  write access to the package, stored as an environment or repository secret.
  When the secret is present the workflow uses it instead of OIDC.

Also create the `npm-publish` environment in repository settings and add
required reviewers. The job then waits for a human approval between the merge
and the publish, while everything else stays automatic. Keep `main` protected so
a version bump always travels through a pull request and a green CI run.

### Manual fallback

Do not publish by hand unless the workflow is broken. The manual path is:

1. Update `package.json` version and keep `package-lock.json` in sync.
2. Run local checks:
   ```bash
   npm ci
   npm run typecheck
   npm run test:unit
   ```
3. On macOS with `sandbox-exec` available and nested sandboxing allowed, run:
   ```bash
   npm run test:integration
   ```
4. Inspect the package contents and run the tarball smoke test:
   ```bash
   npm pack --dry-run
   npm run test:package
   ```
5. Commit the release change and tag it:
   ```bash
   git tag vX.Y.Z
   ```
6. Publish if desired:
   ```bash
   npm publish
   ```

Do not publish if unit tests fail. Treat macOS integration failures as release blockers unless they are clearly caused by the local/CI host disallowing nested `sandbox-exec`.
