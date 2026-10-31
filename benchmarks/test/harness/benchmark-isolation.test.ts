import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  benchmarkSandboxExecutable,
  createBenchmarkSandboxProfile,
  createSandboxedBenchmarkCommand,
} from "../../src/harness/benchmark-isolation.ts";
import { certifiedCandidateEnvironment } from "../../src/harness/certified-candidate-environment.ts";

test(
  "sandbox profile limits a child to its workspace and candidate runtime",
  { skip: !benchmarkSandboxExecutable() },
  () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-isolation-proof-"));
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const forbidden = join(root, "forbidden");
    const auth = join(root, "auth");
    const priorResults = join(root, "prior-results");
    mkdirSync(workspace);
    mkdirSync(runtime);
    mkdirSync(forbidden);
    mkdirSync(auth);
    mkdirSync(priorResults);
    try {
      writeFileSync(join(workspace, "workspace.txt"), "workspace\n");
      writeFileSync(join(runtime, "runtime.txt"), "runtime\n");
      writeFileSync(join(forbidden, "oracle.txt"), "oracle\n");
      writeFileSync(join(auth, "auth.json"), "credential\n");
      writeFileSync(join(priorResults, "result.json"), "prior\n");
      const read = (path: string) => {
        const command = createSandboxedBenchmarkCommand({ workspace, runtime }, "/bin/cat", [path]);
        return spawnSync(command.executable, command.args, { cwd: workspace, encoding: "utf8" });
      };
      const workspaceResult = read(join(workspace, "workspace.txt"));
      const runtimeResult = read(join(runtime, "runtime.txt"));
      const forbiddenResult = read(join(forbidden, "oracle.txt"));
      const authResult = read(join(auth, "auth.json"));
      const priorResult = read(join(priorResults, "result.json"));
      assert.equal(
        workspaceResult.status,
        0,
        `${workspaceResult.error?.message ?? ""} signal=${workspaceResult.signal ?? ""} stderr=${workspaceResult.stderr ?? ""}`,
      );
      assert.equal(
        runtimeResult.status,
        0,
        `${runtimeResult.error?.message ?? ""} signal=${runtimeResult.signal ?? ""} stderr=${runtimeResult.stderr ?? ""}`,
      );
      assert.equal(workspaceResult.stdout, "workspace\n");
      assert.equal(runtimeResult.stdout, "runtime\n");
      assert.notEqual(forbiddenResult.status, 0);
      assert.notEqual(authResult.status, 0);
      assert.notEqual(priorResult.status, 0);
      const nodeProbe = join(workspace, "probe.js");
      writeFileSync(
        nodeProbe,
        'import fs from "node:fs"; process.stdout.write(fs.readFileSync(process.argv[2], "utf8"));\n',
      );
      const nodeCommand = createSandboxedBenchmarkCommand({ workspace, runtime }, process.execPath, [
        nodeProbe,
        join(runtime, "runtime.txt"),
      ]);
      const nodeResult = spawnSync(nodeCommand.executable, nodeCommand.args, {
        cwd: workspace,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      });
      assert.equal(
        nodeResult.status,
        0,
        `${nodeResult.error?.message ?? ""} signal=${nodeResult.signal ?? ""} stderr=${nodeResult.stderr ?? ""}`,
      );
      assert.equal(nodeResult.stdout, "runtime\n");
      const nodeForbiddenCommand = createSandboxedBenchmarkCommand({ workspace, runtime }, process.execPath, [
        nodeProbe,
        join(forbidden, "oracle.txt"),
      ]);
      const nodeForbiddenResult = spawnSync(nodeForbiddenCommand.executable, nodeForbiddenCommand.args, {
        cwd: workspace,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      });
      assert.notEqual(nodeForbiddenResult.status, 0);

      const nodeWriteProbe = join(workspace, "write-probe.js");
      writeFileSync(nodeWriteProbe, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "payload");\n');
      const writeRuntimeCommand = createSandboxedBenchmarkCommand({ workspace, runtime }, process.execPath, [
        nodeWriteProbe,
        join(runtime, "forbidden-write.txt"),
      ]);
      const writeRuntimeResult = spawnSync(writeRuntimeCommand.executable, writeRuntimeCommand.args, {
        cwd: workspace,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      });
      assert.notEqual(writeRuntimeResult.status, 0);

      const writeWorkspaceCommand = createSandboxedBenchmarkCommand({ workspace, runtime }, process.execPath, [
        nodeWriteProbe,
        join(workspace, "allowed-write.txt"),
      ]);
      const writeWorkspaceResult = spawnSync(writeWorkspaceCommand.executable, writeWorkspaceCommand.args, {
        cwd: workspace,
        encoding: "utf8",
        env: { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" },
      });
      assert.equal(writeWorkspaceResult.status, 0);
      assert.equal(createBenchmarkSandboxProfile({ workspace, runtime }).includes(forbidden), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test(
  "certified candidate can verify a tracked requirement with real Git inside containment",
  { skip: !benchmarkSandboxExecutable() },
  () => {
    const root = mkdtempSync(join(tmpdir(), "benchmark-tracked-requirement-"));
    const workspace = join(root, "workspace");
    const runtime = join(root, "runtime");
    const configDir = join(root, "config");
    for (const directory of [workspace, runtime, configDir]) mkdirSync(directory);
    try {
      writeFileSync(join(workspace, "requirements.md"), "Synthetic requirement.\n");
      writeFileSync(join(workspace, "untracked.md"), "Not an authoritative requirement.\n");
      const gitEnv = {
        PATH: "/usr/bin:/bin",
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_TERMINAL_PROMPT: "0",
      };
      for (const args of [
        ["init", "--quiet", "--initial-branch=main"],
        ["config", "--local", "gc.auto", "0"],
        ["config", "--local", "gc.autoDetach", "false"],
        ["config", "--local", "maintenance.auto", "false"],
        ["add", "--", "requirements.md"],
      ]) {
        const result = spawnSync("/usr/bin/git", args, { cwd: workspace, env: gitEnv, encoding: "utf8" });
        assert.equal(result.status, 0, result.stderr);
      }
      const probe = join(workspace, "verify-git.js");
      writeFileSync(
        probe,
        'import { spawnSync } from "node:child_process"; const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", process.argv[2]], { encoding: "utf8" }); process.stderr.write(result.stderr ?? ""); process.exit(result.status ?? 1);\n',
      );
      const environment = certifiedCandidateEnvironment(configDir, runtime);
      const runProbe = (document: string) => {
        const command = createSandboxedBenchmarkCommand({ workspace, runtime, configDir }, process.execPath, [
          probe,
          document,
        ]);
        return spawnSync(command.executable, command.args, { cwd: workspace, env: environment, encoding: "utf8" });
      };
      const tracked = runProbe("requirements.md");
      assert.equal(tracked.status, 0, `signal=${tracked.signal ?? ""} stderr=${tracked.stderr}`);
      assert.equal(tracked.stderr, "");
      const untracked = runProbe("untracked.md");
      assert.notEqual(untracked.status, 0);
      assert.match(untracked.stderr, /did not match any file/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
