import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { referencedRequirementCandidates } from "../src/core/task-verification/referenced-requirement-sources.ts";
import {
  beforeEvidenceTool,
  callEvidenceVerification,
  createEvidenceHarness,
} from "./task-verification-evidence-test-harness.ts";

// Startup screen a user pasted to report a skill-frontmatter error (2026-10-30 session). It names ten
// home-anchored documents and no requirement source; the controller used to fail closed on it forever.
const PASTED_STARTUP_SCREEN = [
  "➜  p git:(main) ✗ p",
  "[Context]",
  "  ~/.p/agent/AGENTS.md, ~/AGENTS.md, AGENTS.md",
  "[Skill conflicts]",
  '  "reddit-publishing" collision:',
  "    ✓ project ~/dev/p/.p/skills/reddit-publishing/SKILL.md",
  "    ✗ ~/dev/p/.agents/skills/reddit-publishing/SKILL.md (skipped)",
  "    ✗ ~/.p/agent/skills/reddit-publishing/SKILL.md (skipped)",
  '  "test-output-discipline" collision:',
  "    ✓ path (temp) ~/dev/p/.agents/skills/test-output-discipline/SKILL.md",
  "    ✗ ~/.p/agent/skills/test-output-discipline/SKILL.md (skipped)",
  '  "cxi" collision:',
  "    ✓ path (temp) ~/.agents/skills/codex-mon/SKILL.md",
  "    ✗ ~/.agents/skills/cxi/SKILL.md (skipped)",
  "  ~/.agents/skills/onepassword-cli/SKILL.md",
  "    Nested mappings are not allowed in compact mappings at line 2, column 14:",
].join("\n");

const NINE_PLAIN_MENTIONS =
  "The docs build printed warnings for a.md, b.md, c.md, d.md, e.md, f.md, g.md, h.md and i.md; fix the warnings.";
const NINE_UNCITED_JAPANESE_LIST = `参照ファイル: ${Array.from({ length: 9 }, (_, index) => `SPEC-${index + 1}.md`).join(", ")}`;

describe("task verification with pasted path mentions", () => {
  it("does not treat home-anchored paths as workspace requirement sources", () => {
    const paths = referencedRequirementCandidates([{ id: "paste", text: PASTED_STARTUP_SCREEN }]).map(
      (candidate) => candidate.path,
    );
    expect(paths).toEqual(["AGENTS.md"]);
  });

  it("records a checklist and allows the edit after a pasted startup screen", async () => {
    const cwd = createRepository();
    const harness = createEvidenceHarness(cwd);
    try {
      await sendPrompt(harness, "fix ```", 100);
      await sendPrompt(harness, PASTED_STARTUP_SCREEN, 200);
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBeUndefined();

      const recorded = await callEvidenceVerification(harness.controller, {
        action: "record_completion_checklist",
        verification_scope: "non_runtime_content",
        completion_checklist: ["The skill frontmatter parses as YAML with name and description keys"],
      });
      expect(recorded).toContain("Completion checklist recorded");

      const edit = await beforeEvidenceTool(harness.agent, "edit", { path: "notes.md", edits: [] });
      expect(edit?.block).not.toBe(true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it.each([
    ["an English warning list", NINE_PLAIN_MENTIONS],
    ["an uncited non-English file list", NINE_UNCITED_JAPANESE_LIST],
  ])("does not fail closed on more than eight paths in %s", async (_label, prompt) => {
    const cwd = createRepository();
    const harness = createEvidenceHarness(cwd);
    try {
      await sendPrompt(harness, prompt, 100);
      expect(harness.controller.currentState.criticalProofObligationOverflow).toBeUndefined();

      const recorded = await callEvidenceVerification(harness.controller, {
        action: "record_completion_checklist",
        completion_checklist: ["The docs build reports no warnings"],
      });
      expect(recorded).toContain("Completion checklist recorded");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

function createRepository(): string {
  const cwd = mkdtempSync(join(tmpdir(), "p-pasted-path-mention-"));
  writeFileSync(join(cwd, "AGENTS.md"), "# Rules\n");
  writeFileSync(join(cwd, "notes.md"), "notes\n");
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
