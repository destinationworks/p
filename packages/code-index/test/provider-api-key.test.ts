import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProviderApiKey } from "../src/embed/provider-api-key.ts";

let directory: string;
let modelsPath: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-provider-key-"));
  modelsPath = path.join(directory, "models.json");
});

afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

function writeModels(value: unknown): void {
  fs.writeFileSync(modelsPath, typeof value === "string" ? value : JSON.stringify(value));
}

describe("orchestrator credential from p's models.json", () => {
  it("returns the trimmed apiKey of the named provider and re-reads it after rotation", () => {
    writeModels({ providers: { "mini-pc-11450": { apiKey: " first-token \n" }, other: { apiKey: "other" } } });
    expect(readProviderApiKey(modelsPath, "mini-pc-11450")).toBe("first-token");

    writeModels({ providers: { "mini-pc-11450": { apiKey: "rotated-token" } } });
    expect(readProviderApiKey(modelsPath, "mini-pc-11450")).toBe("rotated-token");
  });

  it.each([
    ["a missing provider", { providers: { other: { apiKey: "x" } } }],
    ["a missing providers object", { models: [] }],
    ["a blank key", { providers: { "mini-pc-11450": { apiKey: "  " } } }],
    ["a non-string key", { providers: { "mini-pc-11450": { apiKey: 42 } } }],
    ["a non-object provider", { providers: { "mini-pc-11450": "token" } }],
    ["a JSON array", []],
  ])("fails on %s without echoing file content", (_label, value) => {
    writeModels(value);
    expect(() => readProviderApiKey(modelsPath, "mini-pc-11450")).toThrow(
      `${modelsPath} has no apiKey for provider mini-pc-11450`,
    );
  });

  it("names the file but not its content when it is not JSON", () => {
    writeModels('{ "providers": { "mini-pc-11450": { "apiKey": "secret-token"');
    let message = "";
    try {
      readProviderApiKey(modelsPath, "mini-pc-11450");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe(`${modelsPath} is not valid JSON`);
    expect(message).not.toContain("secret-token");
  });

  it("reports an unreadable file", () => {
    expect(() => readProviderApiKey(modelsPath, "mini-pc-11450")).toThrow(`${modelsPath} is not readable`);
  });
});
