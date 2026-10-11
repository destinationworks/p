import assert from "node:assert/strict";
import { test } from "node:test";
import { commandForAgent } from "../../src/workloads/agent-command.ts";
import { parseRunnerArgs } from "../../src/workloads/runner-options.ts";

test("Kilo run commands pass a stable non-default title without hiding the prompt", () => {
  const options = parseRunnerArgs([
    "--agents",
    "kilo",
    "--kilo-model",
    "provider/model",
    "--expected-resolved-model",
    "resolved/model",
  ]);
  for (const [probe, continued] of [
    [true, false],
    [false, false],
    [false, true],
  ] as const) {
    const prompt = "fixture private prompt";
    const command = commandForAgent(
      "kilo",
      options,
      { prompt, timeoutSeconds: 60, isProbe: probe },
      "/tmp/kilo-config",
      "/tmp/kilo-workspace",
      continued,
    );
    const titlePosition = command.args.indexOf("--title");
    assert.ok(titlePosition >= 0);
    assert.equal(command.args[titlePosition + 1], "P benchmark");
    assert.equal(command.args.at(-1), prompt);
    assert.equal(command.args.filter((arg) => arg === "--title").length, 1);
  }
});
