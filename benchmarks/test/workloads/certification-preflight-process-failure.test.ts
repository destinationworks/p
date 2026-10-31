import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { startCertifiedEgressProxy } from "../../src/harness/certified-egress-proxy.ts";
import type { CertifiedHarnessBinding } from "../../src/workloads/certification-binding.ts";
import {
  createAugmentedProjectInstructions,
  runCertifiedPreflights,
} from "../../src/workloads/certification-preflight.ts";
import { parseRunnerArgs } from "../../src/workloads/runner-options.ts";

test("preflight reports the failed agent process before an empty proxy cell", async () => {
  const root = mkdtempSync(join(tmpdir(), "preflight-process-failure-"));
  const proxy = await startCertifiedEgressProxy({
    upstreamBaseUrl: "http://127.0.0.1:11450/v1",
    expectedModel: "backend/model",
  });
  try {
    const source = join(root, "source.md");
    writeFileSync(source, "# Test instructions\n");
    const challenge = createAugmentedProjectInstructions(source, root, "preflight-process-failure-nonce");
    const options = parseRunnerArgs([
      "--certified",
      "--model",
      "surface/model",
      "--expected-resolved-model",
      "backend/model",
      "--runs",
      "3",
    ]);
    const binding = {
      projectInstructions: {
        path: challenge.augmentedPath,
        sha256: challenge.augmentedSha256,
        receiptSha256: challenge.receiptSha256,
      },
    } as CertifiedHarnessBinding;
    const dirs = Object.fromEntries(
      ["p", "pi", "kilo"].map((agent) => {
        const dir = join(root, "config", agent);
        mkdirSync(dir, { recursive: true });
        return [agent, dir];
      }),
    );
    await assert.rejects(
      runCertifiedPreflights(
        options,
        dirs,
        root,
        performance.now() + 310_000,
        challenge.receiptValue,
        binding,
        async (command, timeoutMs) => {
          assert.equal(timeoutMs, 300_000, "P compiled-instruction startup needs its own bounded allowance");
          assert.equal(
            command.env.P_BENCHMARK_PROJECT_INSTRUCTION_TASK_VERIFICATION_MODE,
            "off",
            "instruction parity must not trigger P's terminal task-verification tools",
          );
          return {
            stdout: "",
            stderr: "startup refused",
            code: 7,
            signal: null,
            timedOut: false,
            rawEventCount: 0,
            metricEventCount: 0,
            runtimeContexts: [],
            userTurns: [],
            elapsedMs: 1,
          };
        },
        proxy,
      ),
      /Certified p preflight process failed: exitCode=7/u,
    );
    await assert.rejects(
      runCertifiedPreflights(
        options,
        dirs,
        root,
        performance.now() + 10_000,
        challenge.receiptValue,
        binding,
        async () => ({
          stdout: "",
          stderr: "",
          code: 0,
          signal: null,
          timedOut: false,
          rawEventCount: 0,
          metricEventCount: 0,
          runtimeContexts: [],
          userTurns: [],
          elapsedMs: 1,
        }),
        proxy,
      ),
      /Certified p preflight proxy failed.*missing requests/u,
    );
  } finally {
    await proxy.close();
    rmSync(root, { recursive: true, force: true });
  }
});
