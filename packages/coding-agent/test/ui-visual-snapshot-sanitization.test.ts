import { describe, expect, it } from "vitest";
import { sanitizeUIOutput } from "./helpers/ui-visual-snapshot-harness.ts";

describe("UI visual snapshot sanitization", () => {
  it("normalizes a branch name truncated before its closing parenthesis", () => {
    const output = "/Users/example/dev/p/packages/coding-agent (codex/requirement-audit-cert...";

    expect(sanitizeUIOutput(output)).toBe("~/dev/p/packages/coding-agent (main)");
  });

  it("normalizes a footer path truncated inside a long checkout path", () => {
    const ciFooter = "/home/gh-runner/actions-runner-destinationworks/_work/p/p/packages/coding-age...";

    expect(sanitizeUIOutput(ciFooter)).toBe("~/dev/p/packages/coding-agent (main)");
    expect(sanitizeUIOutput("/home/gh-runner/actions-runner-destinationworks/_work/p/p/pack...")).toBe(
      "~/dev/p/packages/coding-agent (main)",
    );
    expect(sanitizeUIOutput("~/work/some-very-long-checkout-directory/p/packages/coding-a...")).toBe(
      "~/dev/p/packages/coding-agent (main)",
    );
  });

  it("only rewrites a whole truncated path line, leaving other truncated text alone", () => {
    for (const output of [
      "Loading resources...",
      " /model...",
      "/model list of commands...",
      "see /home/user/project/packages/other...",
    ]) {
      expect(sanitizeUIOutput(output)).toBe(output);
    }
  });

  it("preserves truncated text outside the coding-agent footer", () => {
    const output = "Failure in packages/coding-agent (details...";

    expect(sanitizeUIOutput(output)).toBe(output);
  });
});
