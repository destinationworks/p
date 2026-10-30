import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeRequirementSourceCandidates,
  prepareReferencedRequirementSources,
} from "../src/core/task-verification/referenced-requirement-sources.ts";
import { isAuthoritativeRequirementSourceCandidate } from "../src/core/task-verification/requirement-source-authority.ts";
import { citedRequirementSourcePaths } from "../src/core/task-verification/requirement-source-citation-index.ts";
import {
  beforeEvidenceTool,
  callEvidenceVerification,
  createEvidenceHarness,
} from "./task-verification-evidence-test-harness.ts";

const specs = (count: number, prefix = "SPEC") => Array.from({ length: count }, (_, i) => `${prefix}-${i + 1}.md`);

describe("requirement-source overflow recovery", () => {
  it("narrows twelve cited sources over several saved deauthorization calls", async () => {
    const cited = specs(12);
    const cwd = createRepository(cited);
    const harness = createEvidenceHarness(cwd);
    try {
      // One cue per source: the cue window is 120 characters, so a long comma list would only cite its head.
      await sendPrompt(harness, cited.map((path) => `Implement according to ${path}.`).join(" "), 100);
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBe(true);
      expect(await checklist(harness, [])).toContain("The user cited more than 8 requirement sources (12 cited");

      await sendPrompt(harness, `Do not use ${cited.slice(0, 3).join(", ")} as requirement sources.`, 200);
      const first = await checklist(harness, cited.slice(0, 3));
      expect(first).toContain("(9 cited");
      expect(harness.controller.currentState.criticalProofDeauthorizedSourcePaths).toEqual(cited.slice(0, 3));
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBe(true);

      await sendPrompt(harness, `Also do not use ${cited[3]} as a requirement source.`, 300);
      expect(await checklist(harness, [cited[3]!])).toContain("Completion checklist recorded");
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBeUndefined();
      const write = await beforeEvidenceTool(harness.agent, "write", { path: "src/a.ts", content: "export {};\n" });
      expect(write?.block).not.toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("blocks a newly cited source instead of dropping it when the selection ledger is full", async () => {
    const mentioned = specs(8, "m");
    const cwd = createRepository([...mentioned, "NEW.md"]);
    const harness = createEvidenceHarness(cwd);
    try {
      await sendPrompt(harness, `Notes: ${mentioned.join(", ")}.`, 100);
      for (const group of [mentioned.slice(0, 3), mentioned.slice(3, 6), mentioned.slice(6)]) {
        expect(await checklist(harness, [], group)).toMatch(/Completion checklist recorded|already recorded/u);
      }
      expect(harness.controller.currentState.criticalProofSourceSelections).toHaveLength(8);

      await sendPrompt(harness, "Also implement according to NEW.md.", 200);
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBe(true);
      const write = await beforeEvidenceTool(harness.agent, "write", { path: "src/a.ts", content: "export {};\n" });
      expect(write?.reason).toContain("-source ledger");
      expect(write?.reason).toContain("deauthorized_source_paths");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("gives the audit engine instructions for its own tool, not the evidence engine's", () => {
    const prompts = [{ id: "user-1", text: `Implement according to ${specs(9).join(", ")}.` }];
    const message = prepareReferencedRequirementSources(".", prompts, [], []);
    expect(message).toContain("The user cited more than 8 requirement sources");
    expect(message).toContain("/verify light");
    expect(message).not.toContain("record_completion_checklist");
    expect(message).not.toContain("record_task_verification");
  });
});

describe("batch citation index", () => {
  it("cites every case-colliding variant that the per-candidate check cites", () => {
    const prompts = [{ id: "user-1", text: "Implement according to Docs/A.md and docs/a.md." }];
    const candidates = activeRequirementSourceCandidates(prompts);
    expect(candidates.map((candidate) => candidate.path).sort()).toEqual(["Docs/A.md", "docs/a.md"]);
    expect([...citedRequirementSourcePaths(prompts, candidates)].sort()).toEqual(["Docs/A.md", "docs/a.md"]);
  });

  it("matches the per-candidate check on case-folded extensions", () => {
    const prompts = [{ id: "user-1", text: "Implement according to manual.RST and guide.rſt, then see notes.TXT." }];
    const candidates = activeRequirementSourceCandidates(prompts);
    const expected = candidates
      .filter((candidate) => isAuthoritativeRequirementSourceCandidate(prompts, candidate))
      .map((candidate) => candidate.path)
      .sort();
    expect(expected.length).toBeGreaterThan(0);
    expect([...citedRequirementSourcePaths(prompts, candidates)].sort()).toEqual(expected);
  });

  it("stays fast for thousands of short distinct paths", () => {
    const names = Array.from({ length: 4_000 }, (_, i) => `${i.toString(36).padStart(3, "a")}.md`);
    const prompts = [
      { id: "user-1", text: `${names.map((name) => `warning in ${name}`).join("\n")}\nFollow ${names[7]}.` },
    ];
    const candidates = activeRequirementSourceCandidates(prompts);
    const startedAt = performance.now();
    const cited = citedRequirementSourcePaths(prompts, candidates);
    expect(performance.now() - startedAt).toBeLessThan(3_000);
    expect(cited.has(names[7]!)).toBe(true);
    expect(cited.has(names[8]!)).toBe(false);
  });
});

async function checklist(
  harness: ReturnType<typeof createEvidenceHarness>,
  deauthorized: readonly string[],
  authoritative: readonly string[] = [],
): Promise<string> {
  return callEvidenceVerification(harness.controller, {
    action: "record_completion_checklist",
    completion_checklist: ["The requested behavior remains stable"],
    ...(deauthorized.length > 0 ? { deauthorized_source_paths: deauthorized } : {}),
    ...(authoritative.length > 0 ? { authoritative_source_paths: authoritative } : {}),
  });
}

function createRepository(sourcePaths: readonly string[]): string {
  const cwd = mkdtempSync(join(tmpdir(), "p-requirement-source-overflow-recovery-"));
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

async function sendPrompt(
  harness: ReturnType<typeof createEvidenceHarness>,
  content: string,
  timestamp: number,
): Promise<void> {
  await harness.emit({ type: "turn_start" });
  await harness.emit({ type: "message_end", message: { role: "user", content, timestamp } });
}
