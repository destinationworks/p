import { fauxAssistantMessage, fauxToolCall } from "@dst0/p-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

// The 2026-11-18 strict-tier run opened with this probe and the evidence gate rejected it as a mutation.
const PROBE = "pwd && ls -la && node --version && npm --version";

function toolResultTexts(harness: Harness): Array<{ tool: string; isError: boolean; text: string }> {
  return harness.sessionManager.getEntries().flatMap((entry) => {
    if (entry.type !== "message" || entry.message.role !== "toolResult") return [];
    const text = entry.message.content.map((part) => (part.type === "text" ? part.text : "")).join(" ");
    return [{ tool: entry.message.toolName, isError: entry.message.isError, text }];
  });
}

describe("evidence gate lets the run's toolchain probe through before the checklist (#195)", () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  it("runs the real bash tool for the probe instead of demanding a completion checklist", async () => {
    const harness = await createHarness({ taskVerificationMode: "evidence" });
    harnesses.push(harness);
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: PROBE }), { stopReason: "toolUse" }),
      fauxAssistantMessage("checked"),
    ]);

    await harness.session.prompt("check which node and npm versions this machine has");

    const [probe] = toolResultTexts(harness);
    expect(probe?.tool).toBe("bash");
    expect(probe?.text).not.toContain("completion checklist");
    expect(probe?.isError).toBe(false);
    expect(probe?.text).toMatch(/v\d+\.\d+\.\d+/u);
  });

  it("still gates a mutating command before the checklist", async () => {
    const harness = await createHarness({ taskVerificationMode: "evidence" });
    harnesses.push(harness);
    harness.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: "node --version && touch created.txt" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("stopped"),
    ]);

    await harness.session.prompt("check node and create a marker file");

    const [blocked] = toolResultTexts(harness);
    expect(blocked?.isError).toBe(true);
    expect(blocked?.text).toContain("completion checklist");
  });
});
