import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeRequirementSourceCandidates,
  MAX_REQUIREMENT_SOURCE_CANDIDATES,
  referencedRequirementCandidateCatalog,
} from "../src/core/task-verification/referenced-requirement-sources.ts";
import { isAuthoritativeRequirementSourceCandidate } from "../src/core/task-verification/requirement-source-authority.ts";
import { citedRequirementSourcePaths } from "../src/core/task-verification/requirement-source-citation-index.ts";
import {
  beforeEvidenceTool,
  callEvidenceVerification,
  createEvidenceHarness,
} from "./task-verification-evidence-test-harness.ts";

const MENTIONED_PATHS = Array.from({ length: MAX_REQUIREMENT_SOURCE_CANDIDATES + 2 }, (_, index) => `spec-${index}.md`);

describe("requirement-source candidate catalog", () => {
  it("keeps the first eight bare mentions without overflowing", () => {
    const catalog = referencedRequirementCandidateCatalog([{ id: "user-1", text: MENTIONED_PATHS.join(" ") }]);
    expect(catalog.overflow).toBe(false);
    expect(catalog.overflowCandidate).toBeUndefined();
    expect(catalog.candidates.map((candidate) => candidate.path)).toEqual(
      MENTIONED_PATHS.slice(0, MAX_REQUIREMENT_SOURCE_CANDIDATES),
    );
  });

  it("catalogs a cited source ahead of earlier bare mentions", () => {
    const mentions = MENTIONED_PATHS.slice(0, MAX_REQUIREMENT_SOURCE_CANDIDATES);
    const text = `The build printed ${mentions.join(", ")}. Implement according to SPEC.md.`;
    const paths = referencedRequirementCandidateCatalog([{ id: "user-1", text }]).candidates.map(
      (candidate) => candidate.path,
    );
    expect(paths).toEqual([...mentions.slice(0, MAX_REQUIREMENT_SOURCE_CANDIDATES - 1), "SPEC.md"]);
  });

  it("overflows at the ninth cited source even after bare mentions", () => {
    const cited = Array.from({ length: MAX_REQUIREMENT_SOURCE_CANDIDATES + 1 }, (_, index) => `SPEC-${index}.md`);
    const text = `See notes.md. Implement according to ${cited.join(", ")}.`;
    const catalog = referencedRequirementCandidateCatalog([{ id: "user-1", text }]);
    expect(catalog.overflow).toBe(true);
    expect(catalog.candidates.map((candidate) => candidate.path)).toEqual(cited.slice(0, -1));
    expect(catalog.overflowCandidate?.path).toBe(cited.at(-1));
  });

  it("finds the same cited sources as the per-candidate authority check", () => {
    const prompts = [
      {
        id: "user-1",
        text: [
          "The log printed a.md and data.md defines the API.",
          "Implement according to ./Docs/Long-Spec.MD, then see notes.mdx.",
          "notes.md is unrelated. Later: follow notes.md.",
          "Requirements in x.md, y.txt, guide.rst and very/long/path/to/manual.adoc.",
        ].join("\n"),
      },
      { id: "user-2", text: "Background: other.md. contract.md specifies the wire format." },
    ];
    const candidates = activeRequirementSourceCandidates(prompts);
    expect(candidates.length).toBeGreaterThan(8);
    const expected = candidates
      .filter((candidate) => isAuthoritativeRequirementSourceCandidate(prompts, candidate))
      .map((candidate) => candidate.path);
    // Pins the existing semantics, including substring hits ("a.md" inside "data.md defines").
    expect(expected).toEqual(["a.md", "data.md", "notes.md", "x.md", "y.txt", "guide.rst", "contract.md"]);
    expect([...citedRequirementSourcePaths(prompts, candidates)].sort()).toEqual(expected.sort());
  });

  it("lets the model select a mentioned source beyond the eight catalogued mentions", async () => {
    const ninth = MENTIONED_PATHS[MAX_REQUIREMENT_SOURCE_CANDIDATES]!;
    const cwd = createRepository([ninth]);
    const harness = createEvidenceHarness(cwd);
    try {
      await harness.emit({ type: "turn_start" });
      await harness.emit({
        type: "message_end",
        message: { role: "user", content: `参照ファイル: ${MENTIONED_PATHS.join(", ")}`, timestamp: 100 },
      });
      const recorded = await callEvidenceVerification(harness.controller, {
        action: "record_completion_checklist",
        authoritative_source_paths: [ninth],
        completion_checklist: ["The requested behavior remains stable"],
      });
      expect(recorded).toContain("Completion checklist recorded");
      expect(harness.controller.currentState.criticalProofSourceSelections?.map((item) => item.sourcePath)).toEqual([
        ninth,
      ]);
      const write = await beforeEvidenceTool(harness.agent, "write", { path: "src/a.ts", content: "export {};\n" });
      expect(write?.block).not.toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("rejects a selection that would grow the source ledger past eight before persisting it", async () => {
    const cited = Array.from({ length: MAX_REQUIREMENT_SOURCE_CANDIDATES }, (_, index) => `SPEC-${index}.md`);
    const cwd = createRepository([...cited, "extra.md"]);
    const harness = createEvidenceHarness(cwd);
    try {
      await harness.emit({ type: "turn_start" });
      await harness.emit({
        type: "message_end",
        message: { role: "user", content: `Implement according to ${cited.join(", ")}. See extra.md.`, timestamp: 100 },
      });
      const stateBefore = structuredClone(harness.controller.currentState);
      const rejected = await callEvidenceVerification(harness.controller, {
        action: "record_completion_checklist",
        authoritative_source_paths: ["extra.md"],
        completion_checklist: ["The requested behavior remains stable"],
      });
      expect(rejected).toContain(`would exceed the ${MAX_REQUIREMENT_SOURCE_CANDIDATES}-source ledger`);
      expect(harness.controller.currentState).toEqual(stateBefore);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function createRepository(sourcePaths: readonly string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "p-requirement-source-candidate-catalog-"));
  for (const sourcePath of sourcePaths) writeFileSync(join(cwd, sourcePath), "Preserve stable behavior.\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["config", "maintenance.auto", "false"], { cwd });
  execFileSync("git", ["config", "gc.auto", "0"], { cwd });
  execFileSync("git", ["config", "gc.autoDetach", "false"], { cwd });
  execFileSync("git", ["add", "."], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "fixture"], {
    cwd,
  });
  return cwd;
}
