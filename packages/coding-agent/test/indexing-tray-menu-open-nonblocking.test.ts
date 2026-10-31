import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Regression guard for the reported 10-15 s right-click delay: the macOS tray used to read and
// decode its JSON files inside menuWillOpen on the main thread. The menu must now be built from
// cached state only, and every blocking call must sit inside a background-queue closure.

const swiftDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "tray", "macos");
const managerSource = fs.readFileSync(path.join(swiftDir, "status_item_manager.swift"), "utf8");

const BLOCKING_TOKENS = [
  "Data(contentsOf",
  "String(contentsOf",
  "contentsOfFile",
  "FileManager",
  "Process(",
  "launchctl",
  "ServiceControl",
  "loadFileSnapshot",
  "loadSnapshot",
  "readDataToEndOfFile",
  "NSAppleScript",
  "Thread.sleep",
  "waitUntilExit",
  ".wait(",
  ".sync",
  "flock(",
  "open(",
];

function matchingBrace(source: string, openIndex: number): number {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return index;
  }
  throw new Error("unbalanced braces");
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start + signature.length);
  return source.slice(open + 1, matchingBrace(source, open));
}

/** Drops the bodies of `<queue>.async { ... }` / `.asyncAfter(...) { ... }` closures. */
function withoutBackgroundClosures(body: string): string {
  let result = body;
  const pattern = /\.async(?:After\([^)]*\))?\s*\{/;
  for (let match = pattern.exec(result); match; match = pattern.exec(result)) {
    const open = match.index + match[0].length - 1;
    result = result.slice(0, match.index) + result.slice(matchingBrace(result, open) + 1);
  }
  return result;
}

describe("macOS tray menu opens without blocking work", () => {
  it.each([
    "func menuWillOpen(",
    "func requestFileRefresh(",
    "func requestServiceRefresh(",
    "func applyCacheToButton(",
    "func cacheIsStale(",
  ])("%s runs no disk, subprocess or wait call on the calling thread", (signature) => {
    const onCallingThread = withoutBackgroundClosures(functionBody(managerSource, signature));
    for (const token of BLOCKING_TOKENS) {
      expect(onCallingThread, `${signature} contains ${token}`).not.toContain(token);
    }
  });

  it("builds the menu from the cache and only schedules refreshes", () => {
    const body = functionBody(managerSource, "func menuWillOpen(");
    expect(body).toContain("files?.status");
    expect(body).toContain("requestFileRefresh()");
    expect(body).toContain("requestServiceRefresh(force: true)");
    expect(body).not.toContain("reloadStatus");
  });

  it("performs the file reads and launchctl probe on utility queues, not on the main thread", () => {
    expect(managerSource).toMatch(/fileQueue\.async \{[^}]*loadFileSnapshot\(/s);
    expect(managerSource).toMatch(/serviceQueue\.async \{[^}]*ServiceControl\.loadSnapshot\(/s);
    expect(managerSource).toContain("qos: .utility");
  });

  it("closes the descriptor captured for each file source, never a reassigned property", () => {
    expect(managerSource).toContain("setCancelHandler { close(descriptor) }");
    expect(managerSource).not.toMatch(/\b(?:self\.)?fileDescriptor\s*(?:=|\))/);
    expect(managerSource).not.toContain("self?.fileDescriptor");
  });

  it("keeps the blocking helpers out of the AppKit menu code entirely", () => {
    const menuBuilder = fs.readFileSync(path.join(swiftDir, "menu_builder.swift"), "utf8");
    for (const token of ["Data(contentsOf", "Process(", "launchctl", "FileManager", "ServiceControl"]) {
      expect(menuBuilder).not.toContain(token);
    }
  });
});
