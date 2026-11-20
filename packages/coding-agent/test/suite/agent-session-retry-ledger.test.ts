import type { AgentTool } from "@dst0/p-agent-core";
import { type Context, fauxAssistantMessage, fauxThinking, fauxToolCall } from "@dst0/p-ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { AUTO_RETRY_CUSTOM_TYPE } from "../../src/core/agent-session/auto-retry-ledger.ts";
import { createHarness, type Harness } from "./harness.ts";

const STREAM_CUT = "Stream ended without finish_reason";

function retryLedger(harness: Harness): unknown[] {
  return harness.sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === AUTO_RETRY_CUSTOM_TYPE)
    .map((entry) => (entry.type === "custom" ? entry.data : undefined));
}

/** Assistant messages and retry entries in log order, e.g. `assistant:error`, `auto_retry:scheduled`. */
function entryKinds(harness: Harness): string[] {
  return harness.sessionManager.getEntries().flatMap((entry) => {
    if (entry.type === "message" && entry.message.role === "assistant")
      return [`assistant:${entry.message.stopReason}`];
    if (entry.type === "custom" && entry.customType === AUTO_RETRY_CUSTOM_TYPE) {
      return [`auto_retry:${(entry.data as { phase: string }).phase}`];
    }
    return [];
  });
}

const echoTool: AgentTool = {
  name: "echo",
  label: "Echo",
  description: "Echo text back",
  parameters: Type.Object({ text: Type.String() }),
  execute: async () => ({ content: [{ type: "text", text: "echoed" }], details: {} }),
};

describe("auto-retry decisions are persisted to the session log", () => {
  const harnesses: Harness[] = [];
  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.cleanup();
  });

  async function harnessWith(maxRetries: number, baseDelayMs = 1): Promise<Harness> {
    const harness = await createHarness({
      tools: [echoTool],
      completionMode: "implicit",
      settings: { retry: { enabled: true, maxRetries, baseDelayMs } },
    });
    harnesses.push(harness);
    return harness;
  }

  it("records the scheduled retry and its recovery, and keeps both out of the model context", async () => {
    const harness = await harnessWith(3);
    const contexts: Context[] = [];
    harness.setResponses([
      fauxAssistantMessage([fauxThinking("partial plan")], { stopReason: "error", errorMessage: STREAM_CUT }),
      (context) => {
        contexts.push(context);
        return fauxAssistantMessage("recovered");
      },
    ]);

    await harness.session.prompt("test");

    expect(retryLedger(harness)).toEqual([
      {
        version: 1,
        phase: "scheduled",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 1,
        reason: "transient",
        error: STREAM_CUT,
      },
      { version: 1, phase: "recovered", attempt: 1 },
    ]);
    expect(JSON.stringify(contexts[0]?.messages)).not.toContain(AUTO_RETRY_CUSTOM_TYPE);
    expect(JSON.stringify(harness.sessionManager.buildSessionContext().messages)).not.toContain(AUTO_RETRY_CUSTOM_TYPE);
    expect(entryKinds(harness)).toEqual([
      "assistant:error",
      "auto_retry:scheduled",
      "assistant:stop",
      "auto_retry:recovered",
    ]);
  });

  it("records a second scheduled retry after tool turns that follow an earlier recovery", async () => {
    // Shape of the 2026-11-18 run: a recovered retry, several tool turns, then the stream is cut again.
    const harness = await harnessWith(3);
    harness.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "a" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "error decoding response body" }),
      fauxAssistantMessage([fauxToolCall("echo", { text: "b" })], { stopReason: "toolUse" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_CUT }),
      fauxAssistantMessage("done"),
    ]);

    await harness.session.prompt("test");

    expect(harness.faux.state.callCount).toBe(5);
    expect(retryLedger(harness)).toEqual([
      expect.objectContaining({ phase: "scheduled", attempt: 1, error: "error decoding response body" }),
      { version: 1, phase: "recovered", attempt: 1 },
      expect.objectContaining({ phase: "scheduled", attempt: 1, error: STREAM_CUT }),
      { version: 1, phase: "recovered", attempt: 1 },
    ]);
  });

  it("records exhaustion with the final error", async () => {
    const harness = await harnessWith(2);
    harness.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_CUT }),
    ]);

    await harness.session.prompt("test");

    expect(retryLedger(harness)).toEqual([
      expect.objectContaining({ phase: "scheduled", attempt: 1, delayMs: 1 }),
      expect.objectContaining({ phase: "scheduled", attempt: 2, delayMs: 2 }),
      { version: 1, phase: "exhausted", attempt: 2, error: STREAM_CUT },
    ]);
  });

  it("records a cancelled retry", async () => {
    const harness = await harnessWith(3, 10_000);
    harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_CUT })]);
    const scheduled = new Promise<void>((resolve) => {
      const unsubscribe = harness.session.subscribe((event) => {
        if (event.type === "auto_retry_start") {
          unsubscribe();
          resolve();
        }
      });
    });

    const running = harness.session.prompt("test");
    await scheduled;
    harness.session.abortRetry();
    await running;

    expect(retryLedger(harness)).toEqual([
      expect.objectContaining({ phase: "scheduled", attempt: 1, delayMs: 10_000 }),
      { version: 1, phase: "cancelled", attempt: 1, error: "Retry cancelled" },
    ]);
  });

  it("records nothing for a non-retryable error", async () => {
    const harness = await harnessWith(3);
    harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "invalid_api_key" })]);

    await harness.session.prompt("test");

    expect(retryLedger(harness)).toEqual([]);
  });

  it("records nothing when retry is disabled", async () => {
    const harness = await createHarness({ completionMode: "implicit", settings: { retry: { enabled: false } } });
    harnesses.push(harness);
    harness.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_CUT })]);

    await harness.session.prompt("test");

    expect(harness.faux.state.callCount).toBe(1);
    expect(retryLedger(harness)).toEqual([]);
  });

  it("records exhaustion when a retry attempt fails without an error message", async () => {
    const harness = await harnessWith(3);
    harness.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: STREAM_CUT }),
      fauxAssistantMessage("", { stopReason: "error" }),
    ]);

    await harness.session.prompt("test");

    expect(retryLedger(harness)).toEqual([
      expect.objectContaining({ phase: "scheduled", attempt: 1 }),
      { version: 1, phase: "exhausted", attempt: 1, error: "Unknown error" },
    ]);
  });

  it("bounds a long final error in the exhausted entry", async () => {
    const harness = await harnessWith(1);
    const longError = `overloaded_error ${"y".repeat(2_000)}`;
    harness.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "overloaded_error" }),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: longError }),
    ]);

    await harness.session.prompt("test");

    const exhausted = retryLedger(harness).at(-1) as { phase: string; error: string };
    expect(exhausted.phase).toBe("exhausted");
    expect(exhausted.error).toBe(longError.slice(0, 500));
  });

  it("bounds a long provider error in the persisted entry", async () => {
    const harness = await harnessWith(1);
    const longError = `overloaded_error ${"x".repeat(2_000)}`;
    harness.setResponses([
      fauxAssistantMessage("", { stopReason: "error", errorMessage: longError }),
      fauxAssistantMessage("recovered"),
    ]);

    await harness.session.prompt("test");

    const [scheduled] = retryLedger(harness) as Array<{ error: string }>;
    expect(scheduled?.error.length).toBe(500);
    expect(longError.startsWith(scheduled!.error)).toBe(true);
  });
});
