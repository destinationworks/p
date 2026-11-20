import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FallbackEmbeddingProvider } from "../src/embed/fallback-embedding-provider.ts";
import { EmbeddingProviderHttp } from "../src/embed/http.ts";
import { loadWorkspaceCodeRagSettings } from "../src/rag/config.ts";
import { WorkspaceCodeRagService } from "../src/rag/service/workspacecoderagservice.ts";
import { FakeVectorStore } from "./fake-vector-store.ts";

let root: string;
let agentDir: string;
let workspace: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "p-remote-embedding-"));
  agentDir = path.join(root, "agent");
  workspace = path.join(root, "repo");
  fs.mkdirSync(agentDir);
  fs.mkdirSync(path.join(workspace, ".p"), { recursive: true });
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function writeUserConfig(config: Record<string, unknown>): string {
  const file = path.join(agentDir, "code-rag.json");
  fs.writeFileSync(file, JSON.stringify(config));
  return file;
}

function load(userConfig: Record<string, unknown>, repositoryConfig?: Record<string, unknown>) {
  if (repositoryConfig) fs.writeFileSync(path.join(workspace, ".p", "code-rag.json"), JSON.stringify(repositoryConfig));
  return loadWorkspaceCodeRagSettings({
    workspaceRoot: workspace,
    dataDirectory: path.join(agentDir, "code-rag"),
    userConfigPath: writeUserConfig(userConfig),
  });
}

const REMOTE = {
  remoteBackendsAllowed: true,
  remoteEmbeddingUrl: "https://192.168.8.167:11450",
  remoteEmbeddingModel: "mini-pc-2/qwen3-embedding-0.6b",
};

describe("remote embedding settings", () => {
  it("keeps embeddings local when no remote URL is configured", () => {
    const settings = load({});
    expect(settings.remoteEmbeddingUrl).toBeUndefined();
    expect(settings.remoteEmbeddingProvider).toBe("mini-pc-11450");
  });

  it("resolves the credential file next to code-rag.json and the private CA only when it exists", () => {
    const withoutCa = load(REMOTE);
    expect(withoutCa.remoteEmbeddingModelsConfig).toBe(path.join(agentDir, "models.json"));
    expect(withoutCa.remoteEmbeddingCaFile).toBeUndefined();

    fs.writeFileSync(path.join(agentDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\n");
    const withCa = load(REMOTE);
    expect(withCa.remoteEmbeddingCaFile).toBe(path.join(agentDir, "ca.pem"));
    expect(withCa.remoteEmbeddingUrl).toBe("https://192.168.8.167:11450");
  });

  it("keeps explicit credential, CA and timing settings", () => {
    const settings = load({
      ...REMOTE,
      remoteEmbeddingProvider: "lab",
      remoteEmbeddingModelsConfig: "/secure/models.json",
      remoteEmbeddingCaFile: "/secure/ca.pem",
      remoteEmbeddingTimeoutMs: 9_000,
      remoteEmbeddingCooldownMs: 8_000,
      remoteEmbeddingBusyRetryMs: 7_000,
    });
    expect(settings).toMatchObject({
      remoteEmbeddingProvider: "lab",
      remoteEmbeddingModelsConfig: "/secure/models.json",
      remoteEmbeddingCaFile: "/secure/ca.pem",
      remoteEmbeddingTimeoutMs: 9_000,
      remoteEmbeddingCooldownMs: 8_000,
      remoteEmbeddingBusyRetryMs: 7_000,
    });
  });

  it("requires the user to allow remote backends explicitly", () => {
    expect(() => load({ ...REMOTE, remoteBackendsAllowed: false })).toThrow(
      "remoteEmbeddingUrl requires remoteBackendsAllowed",
    );
  });

  it("does not let a repository opt its own source into a remote embedder", () => {
    expect(() => load({ ...REMOTE, remoteBackendsAllowed: false }, { remoteBackendsAllowed: true })).toThrow(
      "remoteEmbeddingUrl requires remoteBackendsAllowed",
    );
    expect(() => load({}, { remoteEmbeddingUrl: "https://attacker.example", remoteEmbeddingModel: "x" })).toThrow(
      "cannot set remoteEmbeddingUrl, remoteEmbeddingModel; remote embedding settings belong in the user config",
    );
  });

  it.each([
    "remoteEmbeddingUrl",
    "remoteEmbeddingModel",
    "remoteEmbeddingProvider",
    "remoteEmbeddingModelsConfig",
    "remoteEmbeddingCaFile",
    "remoteEmbeddingTimeoutMs",
    "remoteEmbeddingCooldownMs",
    "remoteEmbeddingBusyRetryMs",
  ])("rejects %s in a repository config", (key) => {
    const value = key.endsWith("Ms") ? 1_000 : "attacker-chosen";
    expect(() => load(REMOTE, { [key]: value })).toThrow(`cannot set ${key};`);
  });

  it("ignores a saved CA for a plain-HTTP loopback endpoint", () => {
    fs.writeFileSync(path.join(agentDir, "ca.pem"), "-----BEGIN CERTIFICATE-----\n");
    expect(load({ ...REMOTE, remoteEmbeddingUrl: "http://127.0.0.1:18801" }).remoteEmbeddingCaFile).toBeUndefined();
  });

  it.each([
    ["plain HTTP to a LAN host", "http://192.168.8.167:11450"],
    ["a path", "https://192.168.8.167:11450/v1"],
    ["a query", "https://192.168.8.167:11450/?token=x"],
    ["credentials", "https://user:secret@192.168.8.167:11450"],
    ["a non-URL", "192.168.8.167:11450"],
  ])("rejects a remote URL with %s", (_label, url) => {
    expect(() => load({ ...REMOTE, remoteEmbeddingUrl: url })).toThrow(/remoteEmbeddingUrl must be/);
  });

  it("accepts plain HTTP only on loopback", () => {
    expect(load({ ...REMOTE, remoteEmbeddingUrl: "http://127.0.0.1:18801" }).remoteEmbeddingUrl).toBe(
      "http://127.0.0.1:18801",
    );
  });

  it("requires the orchestrator model name and positive timings", () => {
    expect(() => load({ ...REMOTE, remoteEmbeddingModel: undefined })).toThrow("remoteEmbeddingModel is required");
    expect(() => load({ ...REMOTE, remoteEmbeddingCooldownMs: 0 })).toThrow(
      "remoteEmbeddingCooldownMs must be positive",
    );
    expect(() => load({ remoteEmbeddingTimeoutMs: -1 })).toThrow("remoteEmbeddingTimeoutMs must be positive");
  });
});

describe("repository service embedding provider selection", () => {
  function service() {
    return new WorkspaceCodeRagService({
      workspaceRoot: workspace,
      dataDirectory: path.join(agentDir, "code-rag"),
      userConfigPath: path.join(agentDir, "code-rag.json"),
      manageLocalBackends: false,
      vectorStore: new FakeVectorStore(),
    });
  }

  it("wraps the local provider with the orchestrator backend when configured", () => {
    writeUserConfig(REMOTE);
    const created = service();
    expect(created.embeddingProvider).toBeInstanceOf(FallbackEmbeddingProvider);
    expect(created.configurationError).toBeUndefined();
  });

  it("keeps the plain local provider without remote settings", () => {
    writeUserConfig({});
    expect(service().embeddingProvider).toBeInstanceOf(EmbeddingProviderHttp);
  });

  it("disables the service with a clear error when the configured CA file is unreadable", () => {
    writeUserConfig({ ...REMOTE, remoteEmbeddingCaFile: path.join(agentDir, "missing-ca.pem") });
    const created = service();
    expect(created.embeddingProvider).toBeInstanceOf(EmbeddingProviderHttp);
    expect(created.state).toBe("unavailable");
    expect(created.settings.enabled).toBe(false);
    expect(created.lastError?.code).toBe("RAG_BACKEND_UNAVAILABLE");
    expect(created.lastError?.message).toContain("missing-ca.pem");
  });
});
