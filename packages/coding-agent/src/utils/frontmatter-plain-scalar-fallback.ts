import { parse } from "yaml";

// A top-level `key: value` line: no indentation, a simple key, and a non-empty value.
const FLAT_ENTRY = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):[ \t]+(\S.*)$/;

// A plain scalar cannot start with a YAML indicator (flow, quote, block scalar, anchor, tag, ...)
// or be a bare sequence/complex-key marker. Such values need real YAML parsing, so they are never repaired.
const NON_PLAIN_START = /^(?:[[\]{},"'|>&*!%@`#]|[-?:](?:\s|$))/;

const isIgnorable = (line: string): boolean => line.trim() === "" || line.trimStart().startsWith("#");

// A line that matches FLAT_ENTRY parses to a single-entry map or throws; read the value positionally so
// YAML key coercion (`123:`, `true:`) cannot hide it.
const parseEntryStrictly = (line: string): { value: unknown } | undefined => {
  try {
    return { value: Object.values(parse(line) as Record<string, unknown>)[0] };
  } catch {
    return undefined;
  }
};

/**
 * Lenient retry for frontmatter that strict YAML rejected only because an unquoted plain value
 * contains `: ` (for example `description: ... the web app: its editor ...`).
 *
 * Every non-empty, non-comment line must be a flat top-level `key: value` line with a plain scalar
 * value and a unique key; otherwise `undefined` is returned so the caller keeps the strict YAML error.
 * Lines that strict YAML parses on their own keep their YAML type (`true`, `3`, quoted strings); only
 * lines it rejects are taken literally, splitting on the first `: ` and trimming surrounding whitespace.
 */
export const parseFlatPlainScalarMapping = (yamlString: string): Record<string, unknown> | undefined => {
  const entries = new Map<string, unknown>();
  for (const line of yamlString.split("\n")) {
    if (isIgnorable(line)) continue;
    const match = FLAT_ENTRY.exec(line);
    if (!match) return undefined;
    const key = match[1] as string;
    const literal = (match[2] as string).trim();
    if (entries.has(key) || NON_PLAIN_START.test(literal)) return undefined;
    const strict = parseEntryStrictly(line);
    entries.set(key, strict ? strict.value : literal);
  }
  return Object.fromEntries(entries);
};
