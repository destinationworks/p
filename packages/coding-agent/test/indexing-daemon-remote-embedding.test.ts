import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { EmbeddingServerManager, type FallbackEmbeddingProvider, QdrantServerManager } from "@dst0/p-code-index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userConfigPrefersRemoteEmbedding } from "../src/core/indexing-daemon/remote-embedding-preference.ts";
import { IndexingDaemon } from "../src/core/indexing-daemon.ts";

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "p-daemon-remote-embedding-"));
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const REMOTE_CONFIG = {
  remoteBackendsAllowed: true,
  remoteEmbeddingUrl: "https://192.168.8.167:11450",
  remoteEmbeddingModel: "mini-pc-2/qwen3-embedding-0.6b",
};

function writeConfig(value: unknown): void {
  fs.writeFileSync(path.join(root, "code-rag.json"), typeof value === "string" ? value : JSON.stringify(value));
}

function daemon(): IndexingDaemon {
  return new IndexingDaemon({
    agentDir: root,
    qdrantBinary: "unused",
    qdrantDataDirectory: path.join(root, "qdrant"),
    pythonExecutable: "unused",
    embeddingModel: "Qwen/Qwen3-Embedding-0.6B",
    qdrantGarbageCollector: { start: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
  });
}

describe("remote-first embedding preference", () => {
  it.each([
    ["no config file", undefined, false],
    ["invalid JSON", "{", false],
    ["a JSON array", [], false],
    ["no remote URL", { remoteBackendsAllowed: true }, false],
    ["remote backends not allowed", { ...REMOTE_CONFIG, remoteBackendsAllowed: false }, false],
    ["a blank URL", { ...REMOTE_CONFIG, remoteEmbeddingUrl: "  " }, false],
    ["an opted-in remote URL", REMOTE_CONFIG, true],
  ])("with %s returns %s", (_label, config, expected) => {
    if (config !== undefined) writeConfig(config);
    expect(userConfigPrefersRemoteEmbedding(root)).toBe(expected);
  });
});

describe("indexing daemon with a remote embedding backend", () => {
  it("does not load the local embedding model before refreshes when remote embeddings are preferred", async () => {
    writeConfig(REMOTE_CONFIG);
    vi.spyOn(QdrantServerManager.prototype, "ensureStarted").mockResolvedValue(true);
    const ensureEmbedding = vi.spyOn(EmbeddingServerManager.prototype, "ensureStarted").mockResolvedValue(true);

    await daemon()._ensureBackendsRaw();

    expect(ensureEmbedding).not.toHaveBeenCalled();
  });

  it("still loads the local embedding model eagerly without remote embeddings", async () => {
    writeConfig({});
    vi.spyOn(QdrantServerManager.prototype, "ensureStarted").mockResolvedValue(true);
    const ensureEmbedding = vi.spyOn(EmbeddingServerManager.prototype, "ensureStarted").mockResolvedValue(true);

    await daemon()._ensureBackendsRaw();

    expect(ensureEmbedding).toHaveBeenCalledOnce();
  });

  async function fakeOrchestrator(
    status: number,
  ): Promise<{ url: string; headers: http.IncomingHttpHeaders[]; close: () => Promise<void> }> {
    const headers: http.IncomingHttpHeaders[] = [];
    fs.writeFileSync(
      path.join(root, "models.json"),
      JSON.stringify({ providers: { "mini-pc-11450": { apiKey: "test-client-token" } } }),
    );
    const server = http.createServer((request, response) => {
      headers.push(request.headers);
      request.resume();
      request.on("end", () => {
        if (status !== 200) {
          response.writeHead(status, { "retry-after": "30" }).end("busy");
          return;
        }
        const vector = Buffer.alloc(1024 * 4);
        vector.writeFloatLE(1, 0);
        response.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            model: REMOTE_CONFIG.remoteEmbeddingModel,
            data: [{ index: 0, embedding: vector.toString("base64") }],
          }),
        );
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return {
      url: `http://127.0.0.1:${port}`,
      headers,
      close: () => new Promise((resolve) => server.close(() => resolve())),
    };
  }

  function localEmbeddingServer() {
    return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      expect(String(input)).toBe("http://127.0.0.1:18742/embed");
      return new Response(JSON.stringify({ embeddings: [Array.from({ length: 1024 }, (_, i) => (i === 1 ? 1 : 0))] }));
    });
  }

  it("starts the daemon-owned local embedding server only when the remote embedder is busy", async () => {
    const orchestrator = await fakeOrchestrator(503);
    try {
      writeConfig({ ...REMOTE_CONFIG, remoteEmbeddingUrl: orchestrator.url });
      const repository = path.join(root, "repo");
      fs.mkdirSync(repository);
      const ensureEmbedding = vi.spyOn(EmbeddingServerManager.prototype, "ensureStarted").mockResolvedValue(true);
      const localFetch = localEmbeddingServer();
      const service = daemon().serviceFactory(repository) as unknown as {
        embeddingProvider: { encode(texts: string[]): Promise<Float32Array[]> };
      };

      const [vector] = await service.embeddingProvider.encode(["fallback"]);

      expect(vector[1]).toBe(1);
      expect(orchestrator.headers).toHaveLength(1);
      expect(orchestrator.headers[0]?.authorization).toBe("Bearer test-client-token");
      expect(orchestrator.headers[0]?.["x-llm-orchestrator-switch-policy"]).toBe("if-idle");
      expect(ensureEmbedding).toHaveBeenCalledOnce();
      expect(localFetch).toHaveBeenCalledOnce();
    } finally {
      await orchestrator.close();
    }
  });

  it("leaves the local embedding server stopped while the remote embedder is healthy", async () => {
    const orchestrator = await fakeOrchestrator(200);
    try {
      writeConfig({ ...REMOTE_CONFIG, remoteEmbeddingUrl: orchestrator.url });
      const repository = path.join(root, "repo");
      fs.mkdirSync(repository);
      const ensureEmbedding = vi.spyOn(EmbeddingServerManager.prototype, "ensureStarted").mockResolvedValue(true);
      const localFetch = localEmbeddingServer();
      const service = daemon().serviceFactory(repository) as unknown as {
        embeddingProvider: FallbackEmbeddingProvider;
      };

      const [vector] = await service.embeddingProvider.encode(["remote"]);

      expect(vector[0]).toBe(1);
      expect(orchestrator.headers).toHaveLength(1);
      expect(ensureEmbedding).not.toHaveBeenCalled();
      expect(localFetch).not.toHaveBeenCalled();
    } finally {
      await orchestrator.close();
    }
  });

  it("rejects a repository whose Qdrant settings escape daemon ownership", () => {
    writeConfig({ collectionPrefix: "other_prefix" });
    const repository = path.join(root, "repo");
    fs.mkdirSync(repository);
    expect(() => daemon().serviceFactory(repository)).toThrow(
      "Repository collectionPrefix must match daemon ownership",
    );
  });
});
