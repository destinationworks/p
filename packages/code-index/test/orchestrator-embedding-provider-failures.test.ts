import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  OrchestratorEmbeddingProvider,
  type OrchestratorEmbeddingProviderOptions,
} from "../src/embed/orchestrator-embedding-provider.ts";
import { RemoteEmbeddingError } from "../src/embed/remote-embedding-error.ts";
import {
  embeddingsReply,
  type FakeHandler,
  FakeOrchestratorEmbeddingsServer,
  vectorFor,
} from "./fake-orchestrator-embeddings-server.ts";

const MODEL = "mini-pc-2/qwen3-embedding-0.6b";
let server: FakeOrchestratorEmbeddingsServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

function options(url: string, overrides: Partial<OrchestratorEmbeddingProviderOptions> = {}) {
  return {
    url,
    model: MODEL,
    embeddingModel: "Qwen/Qwen3-Embedding-0.6B",
    dimensions: 4,
    apiKey: () => "client-token",
    timeoutMs: 2_000,
    batchSize: 64,
    ...overrides,
  };
}

async function providerFor(handler: FakeHandler, overrides: Partial<OrchestratorEmbeddingProviderOptions> = {}) {
  server = new FakeOrchestratorEmbeddingsServer(handler);
  return new OrchestratorEmbeddingProvider(options(await server.start(), overrides));
}

async function settle(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
}

describe("orchestrator embeddings HTTP failure classification", () => {
  it.each([
    [503, { "retry-after": "7" }, "busy", 7_000],
    [429, { "retry-after": "2" }, "busy", 2_000],
    [503, {}, "busy", undefined],
    [503, { "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT" }, "busy", undefined],
    [500, {}, "unavailable", undefined],
    [502, {}, "unavailable", undefined],
    [503, { "retry-after": "" }, "busy", undefined],
    [503, { "retry-after": " 0 " }, "busy", 0],
    [503, { "retry-after": "-1" }, "busy", undefined],
    [503, { "retry-after": "1.5" }, "busy", undefined],
    [503, { "retry-after": "0x10" }, "busy", undefined],
    [401, {}, "rejected", undefined],
    [404, {}, "rejected", undefined],
    [400, {}, "batch_rejected", undefined],
    [413, {}, "batch_rejected", undefined],
    [422, {}, "batch_rejected", undefined],
  ])("maps HTTP %i with %j to %s", async (status, headers, kind, retryAfterMs) => {
    const provider = await providerFor(() => ({ status, headers, json: { error: { message: "worker busy\nretry" } } }));
    const error = await settle(provider.encode(["a"]));
    expect(error).toBeInstanceOf(RemoteEmbeddingError);
    expect(error).toMatchObject({ kind, retryAfterMs });
    expect((error as Error).message).toContain(`HTTP ${status}: {"error":{"message":"worker busy\\nretry"}}`);
  });

  it("reports an unreadable credential as rejected without sending a request", async () => {
    const provider = await providerFor(() => ({ status: 200 }), {
      apiKey: () => {
        throw new Error("models.json has no apiKey for provider mini-pc-11450");
      },
    });
    const error = await settle(provider.encode(["a"]));
    expect(error).toMatchObject({ kind: "rejected", message: expect.stringContaining("credential unavailable") });
    expect(server?.requests).toHaveLength(0);
  });
});

describe("orchestrator embeddings transport failures", () => {
  it("treats a refused connection as unavailable", async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, "127.0.0.1", resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const provider = new OrchestratorEmbeddingProvider(options(`http://127.0.0.1:${port}`));

    const error = await settle(provider.encode(["a"]));
    expect(error).toMatchObject({ kind: "unavailable", message: expect.stringContaining("unreachable") });
  });

  it("treats a server that never answers as unavailable after the request deadline", async () => {
    const provider = await providerFor(() => ({ hang: true }), { timeoutMs: 150 });
    const started = Date.now();
    const error = await settle(provider.encode(["a"]));
    expect(error).toMatchObject({ kind: "unavailable", message: expect.stringContaining("timed out after 150 ms") });
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("treats an oversized response as unavailable instead of buffering it", async () => {
    const provider = await providerFor(() => ({ body: "x".repeat(200 * 1024) }));
    const error = await settle(provider.encode(["a"]));
    expect(error).toMatchObject({ kind: "unavailable", message: expect.stringContaining("exceeded") });
  });
});

describe("orchestrator embeddings cancellation", () => {
  it("rejects with the caller's reason before sending when already aborted", async () => {
    const provider = await providerFor(() => ({ status: 200 }));
    const controller = new AbortController();
    const reason = new Error("refresh superseded");
    controller.abort(reason);

    expect(await settle(provider.encode(["a"], controller.signal))).toBe(reason);
    expect(await settle(provider.encodeQuery("q", controller.signal))).toBe(reason);
    expect(server?.requests).toHaveLength(0);
  });

  it("rejects with the caller's reason, not a fallback-eligible error, when aborted in flight", async () => {
    const provider = await providerFor(() => ({ hang: true }), { timeoutMs: 10_000 });
    const controller = new AbortController();
    const reason = new Error("daemon quiescing");
    const pending = settle(provider.encode(["a"], controller.signal));
    while ((server?.requests.length ?? 0) === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort(reason);

    const error = await pending;
    expect(error).toBe(reason);
    expect(error).not.toBeInstanceOf(RemoteEmbeddingError);
  });

  it("rejects with the caller's reason when aborted synchronously during invocation, before any listener exists", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted while reading the credential");
    const provider = await providerFor(() => ({ status: 200 }), {
      apiKey: () => {
        controller.abort(reason);
        return "client-token";
      },
    });

    expect(await settle(provider.encode(["a"], controller.signal))).toBe(reason);
    expect(server?.requests).toHaveLength(0);
  });

  it("stops between batches when cancelled after awaited work", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled after the first batch");
    const provider = await providerFor(
      (request) => {
        controller.abort(reason);
        return embeddingsReply(
          MODEL,
          (request.body.input as string[]).map(() => vectorFor(0, 4)),
        );
      },
      { batchSize: 1 },
    );

    expect(await settle(provider.encode(["first", "second"], controller.signal))).toBe(reason);
    expect(server?.requests).toHaveLength(1);
  });
});
