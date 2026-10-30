import { contextCitesRequirementSource } from "./requirement-source-authority.ts";
import type { TaskVerificationSourcePrompt } from "./types.ts";

interface CitationCandidate {
  path: string;
  referencedByPromptIds: string[];
}

const CONTEXT_CHARS = 120;
// Every candidate path ends in one of these extensions, so its occurrences end 3-5 characters after a dot.
const EXTENSION_DOT_PATTERN = /\.(?=adoc|mdx?|rst|txt)/giu;
const EXTENSION_LENGTHS = [3, 4, 5];

/**
 * Returns the candidates that isAuthoritativeRequirementSourceCandidate accepts, scanning each prompt once
 * instead of once per candidate, so a pasted log with thousands of paths stays cheap.
 */
export function citedRequirementSourcePaths(
  prompts: readonly TaskVerificationSourcePrompt[],
  candidates: readonly CitationCandidate[],
): Set<string> {
  const cited = new Set<string>();
  for (const prompt of prompts) {
    const pathsByLowercase = new Map<string, string[]>();
    for (const candidate of candidates) {
      if (cited.has(candidate.path) || !candidate.referencedByPromptIds.includes(prompt.id)) continue;
      const lowercase = candidate.path.toLowerCase();
      pathsByLowercase.set(lowercase, [...(pathsByLowercase.get(lowercase) ?? []), candidate.path]);
    }
    if (pathsByLowercase.size === 0) continue;
    const text = prompt.text.toLowerCase();
    for (const [lowercasePath, starts] of occurrenceStarts(text, pathsByLowercase)) {
      let nextAllowedStart = 0;
      for (const start of starts) {
        if (start < nextAllowedStart) continue;
        const end = start + lowercasePath.length;
        nextAllowedStart = end;
        const before = text.slice(Math.max(0, start - CONTEXT_CHARS), start);
        if (contextCitesRequirementSource(before, text.slice(end, end + CONTEXT_CHARS))) {
          for (const path of pathsByLowercase.get(lowercasePath)!) cited.add(path);
          break;
        }
      }
    }
  }
  return cited;
}

// Bucket keys stay shorter than V8's 13-character sliced-string threshold, which keeps Map lookups cheap.
const SUFFIX_CHARS = 8;

function occurrenceStarts(
  text: string,
  pathsByLowercase: ReadonlyMap<string, readonly string[]>,
): Map<string, number[]> {
  const pathsBySuffix = new Map<string, string[]>();
  const shortPaths = new Set<string>();
  for (const path of pathsByLowercase.keys()) {
    if (path.length < SUFFIX_CHARS) {
      shortPaths.add(path);
      continue;
    }
    const suffix = path.slice(-SUFFIX_CHARS);
    const bucket = pathsBySuffix.get(suffix);
    if (bucket) bucket.push(path);
    else pathsBySuffix.set(suffix, [path]);
  }
  const starts = new Map<string, Set<number>>();
  for (const dot of text.matchAll(EXTENSION_DOT_PATTERN)) {
    for (const extensionLength of EXTENSION_LENGTHS) {
      const end = dot.index + extensionLength;
      const suffixed = end >= SUFFIX_CHARS ? pathsBySuffix.get(text.slice(end - SUFFIX_CHARS, end)) : undefined;
      for (const path of suffixed ?? []) recordStart(starts, text, path, end);
      for (let length = 1; length < SUFFIX_CHARS && length <= end; length += 1) {
        const path = text.slice(end - length, end);
        if (shortPaths.has(path)) recordStart(starts, text, path, end);
      }
    }
  }
  return new Map([...starts].map(([path, pathStarts]) => [path, [...pathStarts].sort((a, b) => a - b)]));
}

function recordStart(starts: Map<string, Set<number>>, text: string, path: string, end: number): void {
  const start = end - path.length;
  if (start < 0 || !text.startsWith(path, start)) return;
  const pathStarts = starts.get(path) ?? new Set<number>();
  pathStarts.add(start);
  starts.set(path, pathStarts);
}
