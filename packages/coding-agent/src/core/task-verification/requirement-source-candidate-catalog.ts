import { citedRequirementSourcePaths } from "./requirement-source-citation-index.ts";
import type { TaskVerificationSourcePrompt } from "./types.ts";

export const MAX_REQUIREMENT_SOURCE_CANDIDATES = 8;

export interface RequirementSourceCandidate {
  path: string;
  referencedByPromptIds: string[];
}

export interface RequirementSourceCandidateCatalog {
  candidates: RequirementSourceCandidate[];
  overflow: boolean;
  overflowCandidate?: RequirementSourceCandidate;
}

// Only paths the user cites as sources ("according to X.md", "follow X.md") count toward the bound.
// Bare mentions, such as pasted logs or file lists, fill the remaining slots and never fail closed.
export function boundedRequirementSourceCandidateCatalog(
  prompts: readonly TaskVerificationSourcePrompt[],
  candidates: readonly RequirementSourceCandidate[],
): RequirementSourceCandidateCatalog {
  const citedPaths = citedRequirementSourcePaths(prompts, candidates);
  const cited = candidates.filter((candidate) => citedPaths.has(candidate.path));
  if (cited.length > MAX_REQUIREMENT_SOURCE_CANDIDATES) {
    return {
      candidates: cited.slice(0, MAX_REQUIREMENT_SOURCE_CANDIDATES),
      overflow: true,
      overflowCandidate: cited[MAX_REQUIREMENT_SOURCE_CANDIDATES],
    };
  }
  const citedSet = new Set(cited);
  const retainedMentions = new Set(
    candidates
      .filter((candidate) => !citedSet.has(candidate))
      .slice(0, MAX_REQUIREMENT_SOURCE_CANDIDATES - cited.length),
  );
  return {
    candidates: candidates.filter((candidate) => citedSet.has(candidate) || retainedMentions.has(candidate)),
    overflow: false,
  };
}

export function citedRequirementSourceOverflowMessage(
  catalog: RequirementSourceCandidateCatalog,
  totalCited?: number,
  engine: "evidence" | "audit" = "evidence",
): string {
  const paths = [...catalog.candidates, ...(catalog.overflowCandidate ? [catalog.overflowCandidate] : [])].map(
    (candidate) => candidate.path,
  );
  const total = totalCited === undefined ? "" : ` (${totalCited} cited, including ${paths.join(", ")}, ...)`;
  return [
    `The user cited more than ${MAX_REQUIREMENT_SOURCE_CANDIDATES} requirement sources${total}, so mutation stays blocked until that set is narrowed.`,
    engine === "audit" ? auditNarrowingInstructions() : narrowingInstructions(),
  ].join(" ");
}

export function criticalProofBoundaryOverflowMessage(sourcePaths: readonly string[]): string {
  return [
    `The selected requirement sources (${sourcePaths.join(", ")}) introduce more than four critical proof boundaries or exceed the ${MAX_REQUIREMENT_SOURCE_CANDIDATES}-source ledger, so mutation stays blocked until that set is narrowed.`,
    narrowingInstructions(),
  ].join(" ");
}

function narrowingInstructions(): string {
  return [
    "Ask the user in a plain-text reply (an ask_user answer does not count) which of these sources to drop, then end the turn (finish_work with status partial if this run requires finish_work).",
    "After the user's next message names those paths, call record_task_verification with action record_completion_checklist and deauthorized_source_paths (up to three per call; each call is saved even when sources remain, so repeat it until the set is small enough).",
    "The user can instead run /verify light to skip strict verification for this session. Read-only commands remain available.",
  ].join(" ");
}

function auditNarrowingInstructions(): string {
  return [
    "Cited sources accumulate across this task's prompts in audit mode and cannot be removed by a later prompt:",
    "finish this task and start a new one that cites fewer sources, or ask the user to run /verify light to skip strict verification for this session.",
    "Read-only commands remain available.",
  ].join(" ");
}
