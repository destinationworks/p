import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { showTerminalNewLineHint } from "../src/modes/interactive/interactive-mode/interactivemode-methods/terminal-newline-hint.ts";
import { createUIRegressionHarness } from "./helpers/ui-visual-snapshot-harness.ts";

const ISOLATED_ENV_KEYS = ["TMUX", "TERM_PROGRAM"] as const;
const originalEnv = new Map(ISOLATED_ENV_KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  for (const key of ISOLATED_ENV_KEYS) delete process.env[key];
});

afterEach(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("InteractiveMode terminal new-line notice in the virtual terminal", () => {
  it("shows no notice when the terminal does not negotiate a keyboard protocol", async () => {
    const ui = await createUIRegressionHarness({ width: 80, height: 24 });
    try {
      await ui.flush();
      const before = ui.getViewport();

      await showTerminalNewLineHint(ui.mode);
      await ui.flush();

      expect(ui.getViewport()).toEqual(before);
      expect(ui.getViewport().join("\n")).not.toContain("may submit");
    } finally {
      ui.cleanup();
    }
  });

  it("renders the notice in at most two rows once a terminal reports no kitty protocol", async () => {
    const ui = await createUIRegressionHarness({ width: 80, height: 24 });
    try {
      const negotiating = ui.terminal as unknown as { waitForKeyboardProtocolNegotiation: () => Promise<boolean> };
      negotiating.waitForKeyboardProtocolNegotiation = async () => true;
      Object.defineProperty(ui.terminal, "kittyProtocolActive", { value: false });

      await showTerminalNewLineHint(ui.mode);
      await ui.flush();

      const rows = ui.getViewport().map((line) => line.trim());
      const first = rows.findIndex((row) => row.startsWith("Warning: Shift+Enter may submit in this terminal"));
      expect(first).toBeGreaterThanOrEqual(0);
      const last = rows.findIndex((row, index) => index >= first && row.endsWith("for a new line."));
      expect(last).toBeGreaterThanOrEqual(first);
      expect(last - first + 1).toBeLessThanOrEqual(2);
      expect(rows.slice(first, last + 1).join(" ")).toBe(
        "Warning: Shift+Enter may submit in this terminal (no kitty keyboard protocol). Use Ctrl+J or \\ then Enter for a new line.",
      );
    } finally {
      ui.cleanup();
    }
  });
});
