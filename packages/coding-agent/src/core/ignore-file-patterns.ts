import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { IgnoreMatcher } from "./package-manager/types.ts";

const IGNORE_FILE_NAMES = [".gitignore", ".ignore", ".fdignore"];

/**
 * Convert one line of a `.gitignore`-style file into a pattern for the `ignore` matcher, rooted at
 * `rootDir` instead of the file's own directory (`prefix` is the file's directory relative to
 * `rootDir`, with a trailing slash, or empty at the root). Returns null for blank lines and comments.
 *
 * A leading `\!` escapes a name that literally starts with `!`. The backslash is kept in every case:
 * stripping it at the root (empty prefix) would leave a leading `!`, which the matcher reads as a
 * negation. Only an unescaped leading `!` is a negation, and its `!` is moved in front of the prefix.
 */
export function prefixIgnorePattern(line: string, prefix: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#") && !trimmed.startsWith("\\#")) return null;

  let pattern = line;
  let negated = false;

  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }

  if (pattern.startsWith("/")) {
    pattern = pattern.slice(1);
  }

  const prefixed = prefix ? `${prefix}${pattern}` : pattern;
  return negated ? `!${prefixed}` : prefixed;
}

/** Add the rules of `.gitignore`, `.ignore` and `.fdignore` found directly in `dir`, rooted at `rootDir`. */
export function addIgnoreRules(ig: IgnoreMatcher, dir: string, rootDir: string): void {
  const relativeDir = relative(rootDir, dir);
  const prefix = relativeDir ? `${relativeDir.split(sep).join("/")}/` : "";

  for (const filename of IGNORE_FILE_NAMES) {
    const ignorePath = join(dir, filename);
    if (!existsSync(ignorePath)) continue;
    try {
      const content = readFileSync(ignorePath, "utf-8");
      const patterns = content
        .split(/\r?\n/)
        .map((line) => prefixIgnorePattern(line, prefix))
        .filter((line): line is string => Boolean(line));
      if (patterns.length > 0) {
        ig.add(patterns);
      }
    } catch {}
  }
}
