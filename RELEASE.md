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

The peer range is intentionally `>=0.80.0 <1`: the extension currently uses
Pi's stable extension/tool APIs from the 0.x SDK line, while a future Pi 1.x
release may change those APIs. CI tests the latest matching SDK in the lockfile;
changes to the peer range require a compatibility review and test update.

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
