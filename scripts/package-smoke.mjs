import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const workspace = await mkdtemp(join(tmpdir(), "pi-seatbelt-package-")).catch((error) => {
  throw new Error(`could not create package smoke-test directory: ${error}`);
});

try {
  const packResult = execFileSync(
    "npm",
    ["pack", "--json", "--pack-destination", workspace],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  const packMetadata = JSON.parse(packResult)[0];
  const tarball = packMetadata?.filename;
  if (typeof tarball !== "string") throw new Error("npm pack did not return a tarball filename");

  const packageFiles = packMetadata.files?.map(({ path }) => path) ?? [];
  const unexpectedFiles = packageFiles.filter((path) =>
    /^(?:\.github|test|scripts|node_modules)(?:\/|$)|(?:^|\/)(?:\.env|.*\.secret)(?:$|\/)/.test(path),
  );
  if (unexpectedFiles.length > 0) {
    throw new Error(`published package contains unexpected files: ${unexpectedFiles.join(", ")}`);
  }

  const fixture = join(workspace, "fixture");
  execFileSync(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--prefix", fixture, join(workspace, tarball)],
    { stdio: "inherit" },
  );

  const installedPackage = join(fixture, "node_modules", "pi-seatbelt-sandbox");
  const entrypoint = join(installedPackage, "index.ts");
  if (!existsSync(entrypoint)) throw new Error(`published entrypoint is missing: ${entrypoint}`);

  // Node intentionally refuses type stripping directly inside node_modules.
  // Copy the package installed from the tarball outside node_modules while
  // retaining the fixture's node_modules for its peer dependency resolution.
  const extractedPackage = join(fixture, "package-check");
  await cp(installedPackage, extractedPackage, { recursive: true });
  const extractedEntrypoint = join(extractedPackage, "index.ts");
  execFileSync(
    process.execPath,
    ["--experimental-strip-types", "-e", `await import(${JSON.stringify(pathToFileURL(extractedEntrypoint).href)})`],
    { stdio: "inherit" },
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log("Package smoke test passed");
