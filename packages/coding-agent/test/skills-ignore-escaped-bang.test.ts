import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "../src/core/skills.ts";

function skillBody(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}\n`;
}

describe("loadSkillsFromDir ignore files: escaped and negated patterns", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "skills-ignore-bang-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function write(relativePath: string, content: string): void {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  function loadedNames(): string[] {
    return loadSkillsFromDir({ dir: root, source: "test" })
      .skills.map((skill) => skill.name)
      .sort();
  }

  it("ignores a root-level skill directory literally named with a leading bang via \\!", () => {
    write(".gitignore", "\\!bang-skill/\n");
    write("!bang-skill/SKILL.md", skillBody("bang-skill"));
    write("keep-skill/SKILL.md", skillBody("keep-skill"));

    expect(loadedNames()).toEqual(["keep-skill"]);
  });

  it("ignores a root-level markdown skill file literally named with a leading bang via \\!", () => {
    write(".ignore", "\\!bang.md\n");
    write("!bang.md", skillBody("bang-file"));
    write("keep.md", skillBody("keep-file"));

    expect(loadedNames()).toEqual(["keep-file"]);
  });

  it("does not let \\!name ignore the unescaped sibling name", () => {
    write(".gitignore", "\\!bang.md\n");
    write("bang.md", skillBody("plain-bang"));

    expect(loadedNames()).toEqual(["plain-bang"]);
  });

  it("ignores an escaped-bang skill directory from a nested ignore file", () => {
    write("group/.gitignore", "\\!bang-skill/\n");
    write("group/!bang-skill/SKILL.md", skillBody("nested-bang"));
    write("group/keep-skill/SKILL.md", skillBody("nested-keep"));

    expect(loadedNames()).toEqual(["nested-keep"]);
  });

  it("anchors a nested escaped-bang pattern to its own directory", () => {
    write("group/.gitignore", "\\!bang-skill/\n");
    write("group/!bang-skill/SKILL.md", skillBody("group-bang"));
    write("other/!bang-skill/SKILL.md", skillBody("other-bang"));

    expect(loadedNames()).toEqual(["other-bang"]);
  });

  it("still treats an unescaped leading ! as a negation that re-includes a skill", () => {
    write(".gitignore", "drop-*/\n!drop-keep/\n");
    write("drop-a/SKILL.md", skillBody("drop-a"));
    write("drop-keep/SKILL.md", skillBody("drop-keep"));
    write("plain/SKILL.md", skillBody("plain"));

    expect(loadedNames()).toEqual(["drop-keep", "plain"]);
  });

  it("still treats an unescaped leading ! in a nested ignore file as a prefixed negation", () => {
    write("group/.gitignore", "drop-*/\n!drop-keep/\n");
    write("group/drop-a/SKILL.md", skillBody("drop-a"));
    write("group/drop-keep/SKILL.md", skillBody("drop-keep"));

    expect(loadedNames()).toEqual(["drop-keep"]);
  });

  it("ignores a file literally named with a leading # via \\# at the root and in a nested directory", () => {
    write(".gitignore", "\\#hash.md\n");
    write("#hash.md", skillBody("root-hash"));
    write("hash.md", skillBody("root-plain"));

    expect(loadedNames()).toEqual(["root-plain"]);

    write("group/.gitignore", "\\#nested-skill/\n");
    write("group/#nested-skill/SKILL.md", skillBody("nested-hash"));
    write("group/keep-skill/SKILL.md", skillBody("nested-keep"));

    expect(loadedNames()).toEqual(["nested-keep", "root-plain"]);
  });

  it("treats a line starting with an unescaped # as a comment", () => {
    write(".gitignore", "# keep-me/\n");
    write("keep-me/SKILL.md", skillBody("keep-me"));

    expect(loadedNames()).toEqual(["keep-me"]);
  });

  it("keeps ignoring an escaped-bang name when the line has trailing spaces", () => {
    write(".gitignore", "\\!bang.md   \n");
    write("!bang.md", skillBody("bang-trailing"));
    write("keep.md", skillBody("keep-trailing"));

    expect(loadedNames()).toEqual(["keep-trailing"]);
  });

  it("keeps a slash after an escaped bang literal instead of anchoring or negating", () => {
    write(".gitignore", "\\!/dir-skill/\n");
    write("!/dir-skill/SKILL.md", skillBody("literal-bang-dir"));
    write("dir-skill/SKILL.md", skillBody("plain-dir"));

    expect(loadedNames()).toEqual(["plain-dir"]);
  });
});
