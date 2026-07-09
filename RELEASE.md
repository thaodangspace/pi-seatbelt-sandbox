# Release checklist

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
4. Inspect the package contents:
   ```bash
   npm pack --dry-run
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
