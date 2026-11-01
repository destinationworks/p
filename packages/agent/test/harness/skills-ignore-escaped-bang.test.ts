import { describe, expect, it } from "vitest";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { loadSkills } from "../../src/harness/skills.ts";
import { createTempDir } from "./session-test-utils.ts";

function skillBody(name: string): string {
  return `---\nname: ${name}\ndescription: ${name} skill\n---\nBody of ${name}\n`;
}

async function loadedNames(env: NodeExecutionEnv): Promise<string[]> {
  const { skills } = await loadSkills(env, "skills");
  return skills.map((skill) => skill.name).sort();
}

describe("loadSkills ignore files: escaped and negated patterns", () => {
  it("ignores a root skill directory literally named with a leading bang via \\!", async () => {
    const env = new NodeExecutionEnv({ cwd: createTempDir() });
    await env.createDir("skills/!bang-skill", { recursive: true });
    await env.createDir("skills/keep-skill", { recursive: true });
    await env.writeFile("skills/.gitignore", "\\!bang-skill/\n");
    await env.writeFile("skills/!bang-skill/SKILL.md", skillBody("bang-skill"));
    await env.writeFile("skills/keep-skill/SKILL.md", skillBody("keep-skill"));

    expect(await loadedNames(env)).toEqual(["keep-skill"]);
  });

  it("ignores a nested skill directory literally named with a leading bang via \\!", async () => {
    const env = new NodeExecutionEnv({ cwd: createTempDir() });
    await env.createDir("skills/group/!bang-skill", { recursive: true });
    await env.createDir("skills/group/keep-skill", { recursive: true });
    await env.createDir("skills/other/!bang-skill", { recursive: true });
    await env.writeFile("skills/group/.gitignore", "\\!bang-skill/\n");
    await env.writeFile("skills/group/!bang-skill/SKILL.md", skillBody("group-bang"));
    await env.writeFile("skills/group/keep-skill/SKILL.md", skillBody("group-keep"));
    await env.writeFile("skills/other/!bang-skill/SKILL.md", skillBody("other-bang"));

    expect(await loadedNames(env)).toEqual(["group-keep", "other-bang"]);
  });

  it("keeps an unescaped leading ! as a negation and \\# as a literal hash", async () => {
    const env = new NodeExecutionEnv({ cwd: createTempDir() });
    await env.createDir("skills/drop-a", { recursive: true });
    await env.createDir("skills/drop-keep", { recursive: true });
    await env.createDir("skills/#hash-skill", { recursive: true });
    await env.createDir("skills/plain", { recursive: true });
    await env.writeFile("skills/.gitignore", "drop-*/\n!drop-keep/\n\\#hash-skill/\n");
    await env.writeFile("skills/drop-a/SKILL.md", skillBody("drop-a"));
    await env.writeFile("skills/drop-keep/SKILL.md", skillBody("drop-keep"));
    await env.writeFile("skills/#hash-skill/SKILL.md", skillBody("hash-skill"));
    await env.writeFile("skills/plain/SKILL.md", skillBody("plain"));

    expect(await loadedNames(env)).toEqual(["drop-keep", "plain"]);
  });
});
