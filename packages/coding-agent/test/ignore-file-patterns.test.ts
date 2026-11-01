import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ignore from "ignore";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addIgnoreRules, prefixIgnorePattern } from "../src/core/ignore-file-patterns.ts";

function matcherFor(line: string, prefix: string): ReturnType<typeof ignore> {
  const pattern = prefixIgnorePattern(line, prefix);
  if (pattern === null) throw new Error(`pattern for ${JSON.stringify(line)} was dropped`);
  return ignore().add([pattern]);
}

describe("prefixIgnorePattern", () => {
  it("drops blank lines and unescaped comments", () => {
    expect(prefixIgnorePattern("", "")).toBeNull();
    expect(prefixIgnorePattern("   ", "sub/")).toBeNull();
    expect(prefixIgnorePattern("# comment", "")).toBeNull();
    expect(prefixIgnorePattern("#comment", "sub/")).toBeNull();
  });

  it("keeps the escape on a leading \\! so the root pattern stays a literal and not a negation", () => {
    expect(prefixIgnorePattern("\\!bang.md", "")).toBe("\\!bang.md");

    const ig = matcherFor("\\!bang.md", "");
    expect(ig.ignores("!bang.md")).toBe(true);
    expect(ig.ignores("bang.md")).toBe(false);
  });

  it("matches the literal ! name under a prefix and never turns the pattern into a negation", () => {
    const pattern = prefixIgnorePattern("\\!bang.md", "sub/");
    expect(pattern?.startsWith("!")).toBe(false);

    const ig = matcherFor("\\!bang.md", "sub/");
    expect(ig.ignores("sub/!bang.md")).toBe(true);
    expect(ig.ignores("sub/bang.md")).toBe(false);
    expect(ig.ignores("other/!bang.md")).toBe(false);
  });

  it("keeps a slash following an escaped bang literal instead of anchoring or negating", () => {
    expect(prefixIgnorePattern("\\!/x.md", "")).toBe("\\!/x.md");

    const ig = matcherFor("\\!/x.md", "");
    expect(ig.ignores("!/x.md")).toBe(true);
    expect(ig.ignores("x.md")).toBe(false);
  });

  it("keeps trailing spaces for the matcher to interpret and still ignores the escaped name", () => {
    expect(prefixIgnorePattern("\\!bang.md  ", "")).toBe("\\!bang.md  ");
    expect(matcherFor("\\!bang.md  ", "").ignores("!bang.md")).toBe(true);
    expect(matcherFor("\\!bang.md\\ ", "").ignores("!bang.md ")).toBe(true);
    expect(matcherFor("\\!bang.md\\ ", "").ignores("!bang.md")).toBe(false);
  });

  it("turns an unescaped leading ! into a prefixed negation and strips an anchoring slash", () => {
    expect(prefixIgnorePattern("!keep.md", "")).toBe("!keep.md");
    expect(prefixIgnorePattern("!keep.md", "sub/")).toBe("!sub/keep.md");
    expect(prefixIgnorePattern("!/keep.md", "sub/")).toBe("!sub/keep.md");

    const ig = ignore().add(["*.md", prefixIgnorePattern("!keep.md", "") as string]);
    expect(ig.ignores("keep.md")).toBe(false);
    expect(ig.ignores("drop.md")).toBe(true);
  });

  it("lets a negation re-include an escaped-bang name at the root and under a prefix", () => {
    expect(prefixIgnorePattern("!\\!keep.md", "")).toBe("!\\!keep.md");
    expect(prefixIgnorePattern("!\\!keep.md", "sub/")).toBe("!sub/\\!keep.md");

    const root = ignore().add(["\\!*.md", prefixIgnorePattern("!\\!keep.md", "") as string]);
    expect(root.ignores("!drop.md")).toBe(true);
    expect(root.ignores("!keep.md")).toBe(false);

    const nested = ignore().add(["sub/\\!*.md", prefixIgnorePattern("!\\!keep.md", "sub/") as string]);
    expect(nested.ignores("sub/!drop.md")).toBe(true);
    expect(nested.ignores("sub/!keep.md")).toBe(false);
  });

  it("keeps an escaped backslash before a bang untouched", () => {
    expect(prefixIgnorePattern("\\\\!x.md", "")).toBe("\\\\!x.md");
    expect(matcherFor("\\\\!x.md", "").ignores("\\!x.md")).toBe(true);
  });

  it("strips the anchoring slash of a plain pattern and applies the prefix", () => {
    expect(prefixIgnorePattern("/build/", "")).toBe("build/");
    expect(prefixIgnorePattern("/build/", "sub/")).toBe("sub/build/");
    expect(prefixIgnorePattern("dist", "sub/")).toBe("sub/dist");
  });

  it("keeps \\# so a file literally named with a leading # is ignored at the root and under a prefix", () => {
    expect(prefixIgnorePattern("\\#hash.md", "")).toBe("\\#hash.md");
    expect(prefixIgnorePattern("\\#hash.md", "sub/")).toBe("sub/\\#hash.md");

    expect(matcherFor("\\#hash.md", "").ignores("#hash.md")).toBe(true);
    expect(matcherFor("\\#hash.md", "").ignores("hash.md")).toBe(false);
    expect(matcherFor("\\#hash.md", "sub/").ignores("sub/#hash.md")).toBe(true);
  });
});

describe("addIgnoreRules", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ignore-file-patterns-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("reads .gitignore, .ignore and .fdignore from the directory and prefixes nested directories", () => {
    const nested = join(root, "group", "inner");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".gitignore"), "root-git.md\n\\!root-bang.md\n");
    writeFileSync(join(nested, ".ignore"), "nested-ignore.md\n\\!nested-bang.md\n!nested-keep.md\n");
    writeFileSync(join(nested, ".fdignore"), "nested-fd.md\n");

    const ig = ignore();
    addIgnoreRules(ig, root, root);
    addIgnoreRules(ig, nested, root);

    expect(ig.ignores("root-git.md")).toBe(true);
    expect(ig.ignores("!root-bang.md")).toBe(true);
    expect(ig.ignores("group/inner/nested-ignore.md")).toBe(true);
    expect(ig.ignores("group/inner/!nested-bang.md")).toBe(true);
    expect(ig.ignores("group/inner/nested-fd.md")).toBe(true);
    expect(ig.ignores("nested-ignore.md")).toBe(false);
    expect(ig.ignores("group/inner/nested-keep.md")).toBe(false);
  });

  it("handles CRLF line endings and still keeps the escape on a root escaped-bang line", () => {
    writeFileSync(join(root, ".gitignore"), "# comment\r\n\\!bang.md\r\n!keep.md\r\n");

    const ig = ignore();
    addIgnoreRules(ig, root, root);

    expect(ig.ignores("!bang.md")).toBe(true);
    expect(ig.ignores("bang.md")).toBe(false);
  });

  it("ignores directories without ignore files and unreadable ignore entries", () => {
    mkdirSync(join(root, ".gitignore"));

    const ig = ignore();
    expect(() => addIgnoreRules(ig, root, root)).not.toThrow();
    expect(() => addIgnoreRules(ig, join(root, "missing"), root)).not.toThrow();
    expect(ig.ignores("anything.md")).toBe(false);
  });
});
