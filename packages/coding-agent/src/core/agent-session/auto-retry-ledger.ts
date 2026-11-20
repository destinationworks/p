import type { SessionManager } from "../session-manager/sessionmanager.ts";
import type { AgentSessionEvent } from "./session-types.ts";

/**
 * Custom session entries recording each auto-retry decision. Without them the session JSONL shows only the failed
 * assistant message, so a log cannot tell whether p scheduled a retry, gave up, or was stalled before retrying.
 * Custom entries never enter the model context.
 */
export const AUTO_RETRY_CUSTOM_TYPE = "auto_retry";

const MAX_PERSISTED_ERROR_CHARS = 500;

type AutoRetryEvent = Extract<AgentSessionEvent, { type: "auto_retry_start" | "auto_retry_end" }>;

type AutoRetryLedgerEntry =
  | {
      version: 1;
      phase: "scheduled";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      reason: Extract<AutoRetryEvent, { type: "auto_retry_start" }>["reason"];
      error: string;
    }
  | { version: 1; phase: "recovered"; attempt: number }
  | { version: 1; phase: "exhausted" | "cancelled"; attempt: number; error: string };

export const RETRY_CANCELLED_ERROR = "Retry cancelled";

function autoRetryLedgerEntry(event: AutoRetryEvent): AutoRetryLedgerEntry {
  if (event.type === "auto_retry_start") {
    return {
      version: 1,
      phase: "scheduled",
      attempt: event.attempt,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      reason: event.reason,
      error: event.errorMessage.slice(0, MAX_PERSISTED_ERROR_CHARS),
    };
  }
  if (event.success) return { version: 1, phase: "recovered", attempt: event.attempt };
  const error = event.finalError ?? "Unknown error";
  return {
    version: 1,
    phase: error === RETRY_CANCELLED_ERROR ? "cancelled" : "exhausted",
    attempt: event.attempt,
    error: error.slice(0, MAX_PERSISTED_ERROR_CHARS),
  };
}

export function persistAutoRetryEvent(sessionManager: SessionManager, event: AgentSessionEvent): void {
  if (event.type !== "auto_retry_start" && event.type !== "auto_retry_end") return;
  sessionManager.appendCustomEntry(AUTO_RETRY_CUSTOM_TYPE, autoRetryLedgerEntry(event));
}
