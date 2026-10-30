import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ResourceDiagnostic } from "../src/core/diagnostics.ts";
import { loadSkillsFromDir } from "../src/core/skills.ts";
import { parseFrontmatter } from "../src/utils/frontmatter.ts";

const ONEPASSWORD_DESCRIPTION =
  "Read, use or update secrets in the BlueShadow 1Password account with the op CLI. Also use before touching the 1Password web app: its editor does not persist agent edits.";

const wrap = (frontmatterLines: string[]): string => `---\n${frontmatterLines.join("\n")}\n---\n\nBody text`;

describe("parseFrontmatter plain-scalar fallback", () => {
  it("keeps the full text after the first ': ' of an unquoted description", () => {
    const { frontmatter, body } = parseFrontmatter<Record<string, string>>(
      wrap(["name: onepassword-cli", `description: ${ONEPASSWORD_DESCRIPTION}`]),
    );
    expect(frontmatter).toEqual({ name: "onepassword-cli", description: ONEPASSWORD_DESCRIPTION });
    expect(body).toBe("Body text");
  });

  it("splits only on the first ': ' so later colons stay in the value", () => {
    const { frontmatter } = parseFrontmatter<Record<string, string>>(
      wrap(["name: x", "description: first: second: third  "]),
    );
    expect(frontmatter.description).toBe("first: second: third");
  });

  it("keeps YAML typing for sibling lines that parse strictly", () => {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(
      wrap([
        "name: x",
        "description: use the web app: its editor is broken",
        "disable-model-invocation: true",
        "priority: 3",
      ]),
    );
    expect(frontmatter).toEqual({
      name: "x",
      description: "use the web app: its editor is broken",
      "disable-model-invocation": true,
      priority: 3,
    });
  });

  it("ignores blank lines and comments around the repaired entries", () => {
    const { frontmatter } = parseFrontmatter<Record<string, string>>(
      wrap(["# leading comment", "name: x", "", "  # indented comment", "description: a web app: its editor"]),
    );
    expect(frontmatter).toEqual({ name: "x", description: "a web app: its editor" });
  });

  it("parses a strictly valid quoted value exactly, colon included", () => {
    const { frontmatter } = parseFrontmatter<Record<string, string>>(
      wrap(["name: x", 'description: "quoted: value with colon"', "other: 'single: quoted'"]),
    );
    expect(frontmatter.description).toBe("quoted: value with colon");
    expect(frontmatter.other).toBe("single: quoted");
  });

  it("does not use the fallback when strict YAML already parses", () => {
    const { frontmatter } = parseFrontmatter<Record<string, unknown>>(wrap(["name: x", "list:", "  - a", "  - b"]));
    expect(frontmatter.list).toEqual(["a", "b"]);
  });

  it.each([
    ["an indented continuation line", ["name: x", "description: web app: its editor", "  continued: line"]],
    ["a nested mapping", ["name: x", "meta:", "  description: web app: its editor"]],
    ["a list item", ["name: x", "description: web app: its editor", "- item"]],
    ["an indented list item", ["name: x", "description: web app: its editor", "  - item"]],
    ["a literal block scalar", ["name: x", "description: web app: its editor", "notes: |", "  more text"]],
    ["a folded block scalar", ["name: x", "description: web app: its editor", "notes: >-", "  more text"]],
    ["an unclosed flow sequence", ["name: x", "description: web app: its editor", "tags: [a, b"]],
    ["an unclosed flow mapping", ["name: x", "description: web app: its editor", "meta: {a: b"]],
    ["an unterminated double quote", ["name: x", "description: web app: its editor", 'other: "unterminated']],
    ["an anchor value", ["name: x", "description: web app: its editor", "other: &anchor value"]],
    ["a tag value", ["name: x", "description: web app: its editor", "other: !tag value"]],
    ["a key with no value", ["name: x", "description: web app: its editor", "empty:"]],
    ["a non-key line", ["name: x", "description: web app: its editor", "just some words"]],
    ["a duplicate key", ["name: x", "name: y", "description: web app: its editor"]],
  ])("still throws for %s", (_label, lines) => {
    expect(() => parseFrontmatter(wrap(lines))).toThrow();
  });

  it("reports the original YAML error position for a genuinely broken line", () => {
    expect(() => parseFrontmatter(wrap(["foo: [bar"]))).toThrow(/at line 1, column 10/);
  });
});

describe("skill loading with an unquoted colon in a plain description", () => {
  let skillsRoot: string;

  beforeEach(() => {
    skillsRoot = mkdtempSync(join(tmpdir(), "p-skill-plain-scalar-colon-"));
  });

  afterEach(() => {
    rmSync(skillsRoot, { recursive: true, force: true });
  });

  const writeSkill = (name: string, lines: string[]): string => {
    const dir = join(skillsRoot, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), wrap(lines));
    return dir;
  };

  it("loads the onepassword-cli frontmatter shape without a diagnostic", () => {
    const dir = writeSkill("onepassword-cli", ["name: onepassword-cli", `description: ${ONEPASSWORD_DESCRIPTION}`]);

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "test" });

    expect(diagnostics).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.name).toBe("onepassword-cli");
    expect(skills[0]?.description).toBe(ONEPASSWORD_DESCRIPTION);
    expect(skills[0]?.disableModelInvocation).toBe(false);
  });

  it("honours disable-model-invocation next to a repaired description", () => {
    const dir = writeSkill("manual-only", [
      "name: manual-only",
      "description: Manual only: invoke explicitly",
      "disable-model-invocation: true",
    ]);

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "test" });

    expect(diagnostics).toEqual([]);
    expect(skills[0]?.description).toBe("Manual only: invoke explicitly");
    expect(skills[0]?.disableModelInvocation).toBe(true);
  });

  it("still warns and skips a skill whose frontmatter is nested and invalid", () => {
    const dir = writeSkill("nested-invalid", [
      "name: nested-invalid",
      "description: web app: its editor",
      "metadata:",
      "  owner: a: b",
    ]);

    const { skills, diagnostics } = loadSkillsFromDir({ dir, source: "test" });

    expect(skills).toHaveLength(0);
    expect(diagnostics.some((d: ResourceDiagnostic) => d.type === "warning" && d.message.includes("at line"))).toBe(
      true,
    );
  });
});
