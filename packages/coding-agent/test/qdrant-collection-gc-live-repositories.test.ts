import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorkspaceCodeRagService } from "@dst0/p-code-index";
import { afterEach, describe, expect, it } from "vitest";
import { INDEXED_REPOS_FILE, INDEXED_REPOS_SCHEMA_VERSION } from "../src/core/indexed-repos.ts";
import { readLiveRepositories } from "../src/core/indexing-daemon/qdrant-collection-protection.ts";

const temporaryDirectories: string[] = [];

function createDirectory(name: string): string {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), name)));
  temporaryDirectories.push(directory);
  return directory;
}

function createGitRepository(remote: string): string {
  const repository = createDirectory("p-gc-live-repository-");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, stdio: "pipe" });
  git("init", "--quiet");
  git("config", "gc.auto", "0");
  git("config", "maintenance.auto", "false");
  git("remote", "add", "origin", remote);
  return repository;
}

function writeRegistry(agentDir: string, contents: unknown): void {
  fs.writeFileSync(path.join(agentDir, INDEXED_REPOS_FILE), `${JSON.stringify(contents)}\n`);
}

function entry(repositoryPath: string, decision: "enabled" | "disabled") {
  return { path: repositoryPath, repoId: "registered-at-enable-time", decision, updatedAt: "2026-11-21T00:00:00.000Z" };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("live repositories for Qdrant collection GC", () => {
  it("returns enabled repositories with the directory id the indexing service uses, or none when unreachable", () => {
    const agentDir = createDirectory("p-gc-live-agent-");
    const repository = createGitRepository("https://example.invalid/team/live.git");
    const disabled = createGitRepository("https://example.invalid/team/disabled.git");
    const linkParent = createDirectory("p-gc-live-link-");
    const linked = path.join(linkParent, "linked");
    fs.symlinkSync(repository, linked);
    expect(fs.lstatSync(linked).isSymbolicLink()).toBe(true);
    writeRegistry(agentDir, {
      schemaVersion: INDEXED_REPOS_SCHEMA_VERSION,
      repos: [
        entry(linked, "enabled"),
        entry(disabled, "disabled"),
        entry(path.join(agentDir, "gone"), "enabled"),
        entry(path.join(agentDir, "unmounted-volume", "repo"), "enabled"),
      ],
    });
    const service = new WorkspaceCodeRagService({
      workspaceRoot: repository,
      dataDirectory: path.join(agentDir, "code-rag"),
      userConfigPath: path.join(agentDir, "code-rag.json"),
      manageLocalBackends: false,
      allowSearchRefresh: false,
    });

    expect(readLiveRepositories(agentDir)).toEqual([
      { root: repository, repositoryId: service.repoId },
      { root: path.join(agentDir, "unmounted-volume", "repo"), repositoryId: undefined },
    ]);
    expect(service.repoId).not.toBe("registered-at-enable-time");
  });

  it("follows a remote change instead of the id recorded when the repository was enabled", () => {
    const agentDir = createDirectory("p-gc-live-remote-agent-");
    const repository = createGitRepository("https://example.invalid/old/repo.git");
    writeRegistry(agentDir, { schemaVersion: INDEXED_REPOS_SCHEMA_VERSION, repos: [entry(repository, "enabled")] });
    const [before] = readLiveRepositories(agentDir);

    execFileSync("git", ["remote", "set-url", "origin", "https://example.invalid/new/repo.git"], { cwd: repository });
    const [after] = readLiveRepositories(agentDir);

    expect(after.root).toBe(before.root);
    expect(after.repositoryId).not.toBe(before.repositoryId);
  });

  it.each([
    ["is missing", undefined],
    ["is not JSON", "{not-json"],
    ["uses an older schema", JSON.stringify({ schemaVersion: 2, repos: [] })],
    ["is not an object", "[]"],
  ])("throws instead of treating a registry that %s as empty", (_case, contents) => {
    const agentDir = createDirectory("p-gc-live-invalid-agent-");
    const registryPath = path.join(agentDir, INDEXED_REPOS_FILE);
    if (contents !== undefined) fs.writeFileSync(registryPath, contents);

    expect(() => readLiveRepositories(agentDir)).toThrow();
    expect(contents === undefined ? fs.existsSync(registryPath) : fs.readFileSync(registryPath, "utf8")).toBe(
      contents === undefined ? false : contents,
    );
  });
});
