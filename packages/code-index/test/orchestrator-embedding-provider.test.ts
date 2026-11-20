import { afterEach, describe, expect, it } from "vitest";
import { EmbeddingProviderHttp } from "../src/embed/http.ts";
import {
  OrchestratorEmbeddingProvider,
  type OrchestratorEmbeddingProviderOptions,
  SWITCH_POLICY_HEADER,
} from "../src/embed/orchestrator-embedding-provider.ts";
import { RemoteEmbeddingError } from "../src/embed/remote-embedding-error.ts";
import {
  base64Vector,
  embeddingsReply,
  type FakeHandler,
  FakeOrchestratorEmbeddingsServer,
  vectorFor,
} from "./fake-orchestrator-embeddings-server.ts";

const MODEL = "mini-pc-2/qwen3-embedding-0.6b";
const DIMENSIONS = 4;
let server: FakeOrchestratorEmbeddingsServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

async function providerFor(handler: FakeHandler, overrides: Partial<OrchestratorEmbeddingProviderOptions> = {}) {
  server = new FakeOrchestratorEmbeddingsServer(handler);
  const url = await server.start();
  return new OrchestratorEmbeddingProvider({
    url,
    model: MODEL,
    embeddingModel: "Qwen/Qwen3-Embedding-0.6B",
    dimensions: DIMENSIONS,
    apiKey: () => "client-token",
    timeoutMs: 2_000,
    batchSize: 64,
    ...overrides,
  });
}

function inputsOf(index: number): string[] {
  const input = server?.requests[index]?.body.input;
  if (!Array.isArray(input)) throw new Error("request input was not an array");
  return input as string[];
}

async function failure(promise: Promise<unknown>): Promise<RemoteEmbeddingError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(RemoteEmbeddingError);
  return error as RemoteEmbeddingError;
}

describe("orchestrator embeddings request contract", () => {
  it("posts the canonical model, base64 encoding, bearer token and the if-idle switch policy", async () => {
    const provider = await providerFor((request) =>
      embeddingsReply(
        MODEL,
        (request.body.input as string[]).map((_, index) => vectorFor(index, DIMENSIONS)),
      ),
    );

    await provider.encode(["alpha", "beta"]);

    const request = server?.requests[0];
    expect(request?.method).toBe("POST");
    expect(request?.path).toBe("/v1/embeddings");
    expect(request?.body).toEqual({ model: MODEL, input: ["alpha", "beta"], encoding_format: "base64" });
    expect(request?.headers.authorization).toBe("Bearer client-token");
    expect(request?.headers[SWITCH_POLICY_HEADER]).toBe("if-idle");
  });

  it("reads the credential for every request so a rotated token applies without a restart", async () => {
    let token = "before-rotation";
    const provider = await providerFor(
      (request) =>
        embeddingsReply(
          MODEL,
          (request.body.input as string[]).map(() => vectorFor(0, DIMENSIONS)),
        ),
      { apiKey: () => token },
    );
    await provider.encode(["one"]);
    token = "after-rotation";
    await provider.encode(["two"]);

    expect(server?.requests.map((request) => request.headers.authorization)).toEqual([
      "Bearer before-rotation",
      "Bearer after-rotation",
    ]);
  });

  it("splits large inputs into batch-size requests and keeps input order", async () => {
    const provider = await providerFor(
      (request) =>
        embeddingsReply(
          MODEL,
          (request.body.input as string[]).map((text) => vectorFor(Number(text), DIMENSIONS)),
        ),
      { batchSize: 2 },
    );

    const vectors = await provider.encode(["0", "1", "2", "3", "4"]);

    expect(server?.requests.map((_, index) => inputsOf(index))).toEqual([["0", "1"], ["2", "3"], ["4"]]);
    expect(vectors.map((vector) => Array.from(vector).indexOf(1))).toEqual([0, 1, 2, 3, 0]);
  });

  it("formats queries exactly like the local provider so query and document spaces stay aligned", async () => {
    const provider = await providerFor(() => embeddingsReply(MODEL, [vectorFor(0, DIMENSIONS)]));
    const local = new EmbeddingProviderHttp("http://127.0.0.1:9", DIMENSIONS, false);
    let localQuery: string | undefined;
    (local as unknown as { encode: (texts: string[]) => Promise<Float32Array[]> }).encode = async (texts) => {
      localQuery = texts[0];
      return [new Float32Array(DIMENSIONS)];
    };

    await provider.encodeQuery("where are retries scheduled");
    await local.encodeQuery("where are retries scheduled");

    expect(inputsOf(0)).toEqual([localQuery]);
    expect(localQuery).toMatch(/^Instruct: .+\nQuery: where are retries scheduled$/);
  });

  it("sends nothing for an empty batch", async () => {
    const provider = await providerFor(() => ({ status: 500 }));
    await expect(provider.encode([])).resolves.toEqual([]);
    expect(server?.requests).toHaveLength(0);
  });
});

describe("orchestrator embeddings response validation", () => {
  it("decodes base64 float32 vectors, reorders by index and L2-normalises them", async () => {
    const provider = await providerFor(() =>
      embeddingsReply(
        MODEL,
        [
          [3, 4, 0, 0],
          [0, 0, 0, 2],
        ],
        [1, 0],
      ),
    );

    const [first, second] = await provider.encode(["a", "b"]);

    expect(Array.from(first)).toEqual([0.6000000238418579, 0.800000011920929, 0, 0]);
    expect(Array.from(second)).toEqual([0, 0, 0, 1]);
  });

  it("accepts plain float arrays when the server ignores encoding_format", async () => {
    const provider = await providerFor(() => ({
      json: { model: MODEL, data: [{ index: 0, embedding: [0, 2, 0, 0] }] },
    }));
    const [vector] = await provider.encode(["a"]);
    expect(Array.from(vector)).toEqual([0, 1, 0, 0]);
  });

  it.each([
    [
      "a different served model",
      { model: "mini-pc-2/other", data: [{ index: 0, embedding: base64Vector([1, 0, 0, 0]) }] },
      "served model mini-pc-2/other",
    ],
    ["too few vectors", { model: MODEL, data: [] }, "returned 0 vectors; expected 1"],
    ["a missing data array", { model: MODEL }, "returned 0 vectors; expected 1"],
    [
      "an out-of-range index",
      { model: MODEL, data: [{ index: 1, embedding: base64Vector([1, 0, 0, 0]) }] },
      "invalid vector index",
    ],
    [
      "a fractional index",
      { model: MODEL, data: [{ index: 0.5, embedding: base64Vector([1, 0, 0, 0]) }] },
      "invalid vector index",
    ],
    [
      "a short base64 vector",
      { model: MODEL, data: [{ index: 0, embedding: base64Vector([1, 0, 0]) }] },
      "do not match configured dimension 4",
    ],
    [
      "a long float vector",
      { model: MODEL, data: [{ index: 0, embedding: [1, 0, 0, 0, 0] }] },
      "do not match configured dimension 4",
    ],
    ["a malformed embedding", { model: MODEL, data: [{ index: 0, embedding: { values: [] } }] }, "malformed embedding"],
    [
      "a non-finite value",
      { model: MODEL, data: [{ index: 0, embedding: base64Vector([Number.NaN, 0, 0, 0]) }] },
      "non-finite",
    ],
    ["a zero vector", { model: MODEL, data: [{ index: 0, embedding: base64Vector([0, 0, 0, 0]) }] }, "zero vector"],
  ])("rejects %s as an invalid response", async (_label, json, message) => {
    const provider = await providerFor(() => ({ json }));
    const error = await failure(provider.encode(["a"]));
    expect(error.kind).toBe("invalid_response");
    expect(error.message).toContain(message);
  });

  it("rejects a duplicate index even when the vector count matches", async () => {
    const vector = base64Vector([1, 0, 0, 0]);
    const provider = await providerFor(() => ({
      json: {
        model: MODEL,
        data: [
          { index: 0, embedding: vector },
          { index: 0, embedding: vector },
        ],
      },
    }));
    const error = await failure(provider.encode(["a", "b"]));
    expect(error).toMatchObject({ kind: "invalid_response", message: expect.stringContaining("duplicate index") });
  });

  it("rejects a body that is not JSON", async () => {
    const provider = await providerFor(() => ({ body: "<html>proxy error</html>" }));
    expect(await failure(provider.encode(["a"]))).toMatchObject({ kind: "invalid_response" });
  });
});
