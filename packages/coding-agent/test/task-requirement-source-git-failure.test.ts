import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectRequirementSourceFile } from "../src/core/task-verification/requirement-source-file.ts";

const UNTRACKED_MESSAGE = "Requirement source must be a Git-tracked file: SPEC.md";
const temporaryDirectories: string[] = [];
const ENV_KEYS = ["PATH", "LC_ALL", "GIT_DIR", "GIT_CEILING_DIRECTORIES"] as const;
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const originalPath = process.env.PATH;

beforeEach(() => {
  // Keep repository discovery inside each temp workspace, whatever the host environment sets.
  delete process.env.GIT_DIR;
  process.env.GIT_CEILING_DIRECTORIES = realpathSync(tmpdir());
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function workspace(initGit: boolean, track: boolean): string {
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "p-requirement-source-git-"));
  temporaryDirectories.push(cwd);
  writeFileSync(join(cwd, "SPEC.md"), "# Spec\n\nPreserve stable behavior.\n");
  if (initGit) {
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["config", "maintenance.auto", "false"], { cwd });
    execFileSync("git", ["config", "gc.auto", "0"], { cwd });
    if (track) execFileSync("git", ["add", "SPEC.md"], { cwd });
  }
  return cwd;
}

function shadowGit(script: string): void {
  const bin = mkdtempSync(join(tmpdir(), "p-fake-git-"));
  temporaryDirectories.push(bin);
  mkdirSync(bin, { recursive: true });
  const fake = join(bin, "git");
  writeFileSync(fake, `#!/bin/sh\n${script}\n`);
  chmodSync(fake, 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
}

/** A fake `git` that fails the way the macOS xcrun shim does inside a sandbox. */
function shadowGitWithFailingShim(stderr: string, exitCode: number): void {
  shadowGit(`echo ${JSON.stringify(stderr)} >&2\nexit ${exitCode}`);
}

describe("requirement source Git tracking", () => {
  it("accepts a tracked source", () => {
    const result = inspectRequirementSourceFile(workspace(true, true), "SPEC.md", 4_096);
    expect(typeof result).not.toBe("string");
  });

  it("still reports a genuinely untracked source as untracked", () => {
    expect(inspectRequirementSourceFile(workspace(true, false), "SPEC.md", 4_096)).toBe(UNTRACKED_MESSAGE);
  });

  it("runs git in the C locale so a translated untracked message is still recognized", () => {
    const cwd = workspace(true, false);
    process.env.LC_ALL = "de_DE.UTF-8";
    // Answers in German unless the caller forces LC_ALL=C, like a git build with translations installed.
    shadowGit(
      [
        'if [ "$LC_ALL" = "C" ]; then',
        "  echo \"error: pathspec 'SPEC.md' did not match any file(s) known to git\" >&2",
        "else",
        "  echo \"Fehler: Pfadspezifikation 'SPEC.md' stimmte mit keinen git-bekannten Dateien überein\" >&2",
        "fi",
        "exit 1",
      ].join("\n"),
    );
    expect(inspectRequirementSourceFile(cwd, "SPEC.md", 4_096)).toBe(UNTRACKED_MESSAGE);
  });

  it("reports a workspace that is not a Git repository as a Git failure, not as an untracked file", () => {
    const result = inspectRequirementSourceFile(workspace(false, false), "SPEC.md", 4_096);
    expect(result).not.toBe(UNTRACKED_MESSAGE);
    expect(result).toMatch(/Cannot verify that requirement source SPEC\.md is Git-tracked because git failed/u);
    expect(result).toContain("not a git repository");
  });

  it("surfaces a git executable that exits 1 for a reason other than an unmatched path", () => {
    const cwd = workspace(true, true);
    shadowGitWithFailingShim("xcrun: error: unable to load libxcrun (file system sandbox blocked open())", 1);
    const result = inspectRequirementSourceFile(cwd, "SPEC.md", 4_096);
    expect(result).not.toBe(UNTRACKED_MESSAGE);
    expect(result).toContain("exit 1: xcrun: error: unable to load libxcrun");
    expect(result).toContain("The file may still be tracked");
  });

  it("reports a missing git executable instead of calling the source untracked", () => {
    const cwd = workspace(true, true);
    process.env.PATH = mkdtempSync(join(tmpdir(), "p-empty-path-"));
    temporaryDirectories.push(process.env.PATH);
    const result = inspectRequirementSourceFile(cwd, "SPEC.md", 4_096);
    expect(result).not.toBe(UNTRACKED_MESSAGE);
    expect(result).toMatch(/because git failed \(.*ENOENT/u);
  });

  it("does not treat a glob-like file name as tracked because a matching file is", () => {
    const cwd = workspace(true, true);
    writeFileSync(join(cwd, "*.md"), "# Untracked\n");
    expect(inspectRequirementSourceFile(cwd, "*.md", 4_096)).toBe(
      "Requirement source must be a Git-tracked file: *.md",
    );
  });

  it("only accepts git's unmatched-path message as untracked when git exits 1", () => {
    const cwd = workspace(true, false);
    shadowGit(`echo "error: pathspec 'SPEC.md' did not match any file(s) known to git" >&2\nexit 2`);
    expect(inspectRequirementSourceFile(cwd, "SPEC.md", 4_096)).toContain("because git failed (exit 2");
  });

  it("reports git's fatal line rather than a leading trace line", () => {
    const cwd = workspace(true, true);
    shadowGit(
      [
        'echo "12:00:00.000 trace: built-in: git ls-files" >&2',
        'echo "fatal: index file corrupt" >&2',
        "exit 128",
      ].join("\n"),
    );
    expect(inspectRequirementSourceFile(cwd, "SPEC.md", 4_096)).toContain("exit 128: fatal: index file corrupt");
  });

  it("redacts a git error that carries a secret and bounds its length", () => {
    const cwd = workspace(true, true);
    shadowGit(`echo "fatal: bad numeric config value 'ghp_${"a".repeat(36)}' for 'core.compression'" >&2\nexit 128`);
    const redacted = inspectRequirementSourceFile(cwd, "SPEC.md", 4_096);
    expect(redacted).toContain("[git error redacted");
    expect(redacted).not.toContain("ghp_");

    shadowGit(`echo "fatal: ${"x".repeat(500)}" >&2\nexit 128`);
    const long = inspectRequirementSourceFile(cwd, "SPEC.md", 4_096) as string;
    expect(long).toContain(`exit 128: fatal: ${"x".repeat(193)}).`);
    expect(long).not.toContain("x".repeat(194));
  });

  it("reports a git process killed by a signal", () => {
    const cwd = workspace(true, true);
    shadowGit("kill -TERM $$");
    expect(inspectRequirementSourceFile(cwd, "SPEC.md", 4_096)).toContain("because git failed (terminated by SIGTERM)");
  });
});
