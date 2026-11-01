import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectFiles } from "../src/core/package-manager/package-installation.ts";
import { DefaultPackageManager, type ResolvedResource } from "../src/core/package-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

function skillBody(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}\n`;
}

describe("package manager ignore files: escaped and negated patterns", () => {
  let tempDir: string;
  let agentDir: string;
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    tempDir = mkdtempSync(join(tmpdir(), "pm-ignore-bang-"));
    process.env.HOME = tempDir;
    agentDir = join(tempDir, "agent");
    mkdirSync(agentDir, { recursive: true });
  });

  afterEach(() => {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function write(baseDir: string, relativePath: string, content: string): void {
    const fullPath = join(baseDir, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  function collectedNames(dir: string): string[] {
    return collectFiles(dir, /\.md$/)
      .map((file) => relative(dir, file).split(sep).join("/"))
      .sort();
  }

  describe("DefaultPackageManager.resolve", () => {
    function createPackageManager(settingsManager: SettingsManager): DefaultPackageManager {
      return new DefaultPackageManager({ cwd: tempDir, agentDir, settingsManager });
    }

    // resolve() also auto-discovers project and user resources; keep only this fixture's paths.
    function pathsUnder(resources: ResolvedResource[], dir: string): string[] {
      return resources
        .filter((resource) => resource.path.startsWith(`${dir}${sep}`))
        .map((resource) => relative(dir, resource.path).split(sep).join("/"))
        .sort();
    }

    it("skips an auto-discovered user prompt named with a leading bang when the ignore file escapes it", async () => {
      const promptsDir = join(agentDir, "prompts");
      write(promptsDir, ".gitignore", "\\!bang.md\n");
      write(promptsDir, "!bang.md", "Bang prompt");
      write(promptsDir, "keep.md", "Keep prompt");

      const result = await createPackageManager(SettingsManager.inMemory()).resolve();

      expect(pathsUnder(result.prompts, promptsDir)).toEqual(["keep.md"]);
    });

    it("skips configured skill paths named with a leading bang at the root and in nested ignore files", async () => {
      const skillsDir = join(agentDir, "skills");
      write(skillsDir, ".gitignore", "\\!root-bang-skill/\n");
      write(skillsDir, "!root-bang-skill/SKILL.md", skillBody("root-bang-skill"));
      write(skillsDir, "keep-skill/SKILL.md", skillBody("keep-skill"));
      write(skillsDir, "group/.gitignore", "\\!nested-bang-skill/\n");
      write(skillsDir, "group/!nested-bang-skill/SKILL.md", skillBody("nested-bang-skill"));
      write(skillsDir, "group/nested-keep-skill/SKILL.md", skillBody("nested-keep-skill"));

      const settingsManager = SettingsManager.inMemory();
      settingsManager.setSkillPaths(["skills"]);
      const result = await createPackageManager(settingsManager).resolve();

      expect(pathsUnder(result.skills, skillsDir)).toEqual(["group/nested-keep-skill/SKILL.md", "keep-skill/SKILL.md"]);
    });

    it("skips a root markdown skill file named with a leading bang when the ignore file escapes it", async () => {
      const skillsDir = join(agentDir, "skills");
      write(skillsDir, ".ignore", "\\!bang.md\n");
      write(skillsDir, "!bang.md", skillBody("bang-file"));
      write(skillsDir, "keep.md", skillBody("keep-file"));

      const settingsManager = SettingsManager.inMemory();
      settingsManager.setSkillPaths(["skills"]);
      const result = await createPackageManager(settingsManager).resolve();

      expect(pathsUnder(result.skills, skillsDir)).toEqual(["keep.md"]);
    });
  });

  describe("collectFiles", () => {
    it("ignores a root file literally named with a leading bang via \\!", () => {
      write(tempDir, ".gitignore", "\\!bang.md\n");
      write(tempDir, "!bang.md", "bang");
      write(tempDir, "bang.md", "plain");

      expect(collectedNames(tempDir)).toEqual(["bang.md"]);
    });

    it("ignores a nested file literally named with a leading bang via \\! and anchors it to that directory", () => {
      write(tempDir, "group/.gitignore", "\\!bang.md\n");
      write(tempDir, "group/!bang.md", "bang");
      write(tempDir, "group/keep.md", "keep");
      write(tempDir, "other/!bang.md", "other bang");

      expect(collectedNames(tempDir)).toEqual(["group/keep.md", "other/!bang.md"]);
    });

    it("keeps an unescaped leading ! as a negation at the root and in a nested directory", () => {
      write(tempDir, ".gitignore", "*.md\n!keep.md\n");
      write(tempDir, "keep.md", "keep");
      write(tempDir, "drop.md", "drop");
      write(tempDir, "group/.gitignore", "*.md\n!nested-keep.md\n");
      write(tempDir, "group/nested-keep.md", "keep");
      write(tempDir, "group/nested-drop.md", "drop");

      expect(collectedNames(tempDir)).toEqual(["group/nested-keep.md", "keep.md"]);
    });

    it("ignores a file literally named with a leading # via \\# at the root and in a nested directory", () => {
      write(tempDir, ".gitignore", "\\#hash.md\n");
      write(tempDir, "#hash.md", "hash");
      write(tempDir, "hash.md", "plain");
      write(tempDir, "group/.gitignore", "\\#nested.md\n");
      write(tempDir, "group/#nested.md", "nested hash");
      write(tempDir, "group/nested.md", "nested plain");

      expect(collectedNames(tempDir)).toEqual(["group/nested.md", "hash.md"]);
    });

    it("treats a line starting with an unescaped # as a comment", () => {
      write(tempDir, ".gitignore", "# keep.md\n");
      write(tempDir, "keep.md", "keep");

      expect(collectedNames(tempDir)).toEqual(["keep.md"]);
    });
  });
});
