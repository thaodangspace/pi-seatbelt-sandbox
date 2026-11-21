import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const workflowsDir = fileURLToPath(new URL("../.github/workflows", import.meta.url));
const workflowFiles = readdirSync(workflowsDir).filter((name) => /\.ya?ml$/.test(name));

interface Workflow {
  file: string;
  text: string;
  runBlocks: string[];
  usesLines: string[];
}

function parseWorkflow(file: string): Workflow {
  const text = readFileSync(join(workflowsDir, file), "utf8");
  const lines = text.split("\n");
  const runBlocks: string[] = [];
  const usesLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const uses = /^\s*(?:- )?uses:\s*(.+)$/.exec(line);
    if (uses) usesLines.push(uses[1].trim());

    const start = /^(\s*)(?:- )?run:\s?(.*)$/.exec(line);
    if (!start) continue;
    const bodyIndent = start[1].length + (line.trimStart().startsWith("- ") ? 2 : 0);
    const inline = start[2];
    if (inline && inline !== "|" && inline !== ">") {
      runBlocks.push(inline);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const nested = lines[j];
      if (nested.trim() === "") continue;
      if (nested.length - nested.trimStart().length <= bodyIndent) break;
      body.push(nested);
    }
    runBlocks.push(body.join("\n"));
  }

  return { file, text, runBlocks, usesLines };
}

const workflows = workflowFiles.map(parseWorkflow);

describe("GitHub Actions workflows", () => {
  it("finds the workflow files", () => {
    expect(workflows.map(({ file }) => file).sort()).toEqual(["ci.yml", "release.yml"]);
  });

  it("pins every action to a commit SHA with a release comment", () => {
    for (const workflow of workflows) {
      expect(workflow.usesLines.length).toBeGreaterThan(0);
      for (const uses of workflow.usesLines) {
        // Local composite actions and docker references are not versioned by SHA.
        if (uses.startsWith("./") || uses.startsWith("docker://")) continue;
        expect(uses, `${workflow.file}: ${uses}`).toMatch(/^[\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+$/);
      }
    }
  });

  it("uses GitHub expression syntax instead of bare shell substitution for contexts", () => {
    // `${steps.x.outputs.y}` is a bash "bad substitution" at runtime and only
    // surfaces when the job runs. In a `run:` block those references must be
    // written as `${{ steps.x.outputs.y }}` (or passed through `env:`).
    const contextRef = /\$\{(?:steps|github|inputs|secrets|matrix|needs|jobs|vars)\.[^}]*\}/;
    for (const workflow of workflows) {
      for (const block of workflow.runBlocks) {
        const match = contextRef.exec(block);
        expect(match?.[0], `${workflow.file} run block: ${match?.[0] ?? ""}`).toBeUndefined();
      }
    }
  });

  it("keeps the release workflow able to publish and release", () => {
    const release = workflows.find(({ file }) => file === "release.yml");
    expect(release).toBeDefined();
    expect(release?.text).toContain("id-token: write"); // npm provenance, trusted publishing
    expect(release?.text).toContain("contents: write"); // tag and GitHub release
    expect(release?.text).toContain("npm publish --provenance");
    expect(release?.text).toContain("npm audit --audit-level=high");
    expect(release?.text).toContain("npm run test:integration");
    expect(release?.text).toContain("runs-on: macos-latest");
  });

  it("does not publish over a version that is already on the registry", () => {
    const release = workflows.find(({ file }) => file === "release.yml");
    expect(release?.text).toContain("npm view");
    expect(release?.text).toContain("already_published");
  });
});
