import { JsonHttpTimeoutError, postJson } from "./json-http-request.ts";
import type { EmbeddingProvider } from "./provider.ts";
import { formatEmbeddingQuery, queryInstructionForModel } from "./query-instruction.ts";
import { RemoteEmbeddingError } from "./remote-embedding-error.ts";

/**
 * Asks llm-orchestrator not to evict a model that is serving other requests.
 * The orchestrator answers 503 instead, and the caller embeds locally.
 */
export const SWITCH_POLICY_HEADER = "x-llm-orchestrator-switch-policy";
export const SWITCH_POLICY_IF_IDLE = "if-idle";

const ERROR_BODY_PREVIEW_CHARACTERS = 300;
/** Room for one vector as JSON float text (about 24 bytes per value) plus envelope. */
const RESPONSE_BYTES_PER_DIMENSION = 32;
const RESPONSE_BYTES_PER_VECTOR_OVERHEAD = 1024;
/** Statuses that reject this batch's content, not the endpoint. */
const BATCH_REJECTION_STATUSES = new Set([400, 413, 422]);

export interface OrchestratorEmbeddingProviderOptions {
  /** Orchestrator origin, for example `https://192.168.8.167:11450`. */
  url: string;
  /** Canonical orchestrator model name, for example `mini-pc-2/qwen3-embedding-0.6b`. */
  model: string;
  /** Embedding model identity used for the query instruction and the index compatibility group. */
  embeddingModel: string;
  dimensions: number;
  /** Returns the bearer token; called per request so credential rotation needs no restart. */
  apiKey: () => string;
  /** PEM trust anchors for the orchestrator's private CA. */
  ca?: string;
  timeoutMs: number;
  batchSize: number;
}

/**
 * Dense embeddings from llm-orchestrator's OpenAI-compatible `/v1/embeddings` endpoint.
 *
 * Every failure that a local backend can absorb is raised as RemoteEmbeddingError;
 * caller cancellation is re-raised unchanged so it is never mistaken for an outage.
 */
export class OrchestratorEmbeddingProvider implements EmbeddingProvider {
  public readonly dim: number;
  private readonly endpoint: URL;
  private readonly options: OrchestratorEmbeddingProviderOptions;
  private readonly queryInstruction: string | undefined;

  constructor(options: OrchestratorEmbeddingProviderOptions) {
    this.options = options;
    this.dim = options.dimensions;
    this.endpoint = new URL("/v1/embeddings", options.url);
    this.queryInstruction = queryInstructionForModel(options.embeddingModel);
  }

  async encode(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    const batchSize = Math.max(1, this.options.batchSize);
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += batchSize) {
      vectors.push(...(await this.request(texts.slice(offset, offset + batchSize), signal)));
    }
    return vectors;
  }

  async encodeQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    const [vector] = await this.request([formatEmbeddingQuery(this.queryInstruction, text)], signal);
    return vector;
  }

  private async request(input: string[], signal: AbortSignal | undefined): Promise<Float32Array[]> {
    if (signal?.aborted) throw signal.reason ?? new Error("Embedding request cancelled");
    if (input.length === 0) return [];
    let token: string;
    try {
      token = this.options.apiKey();
    } catch (error) {
      throw new RemoteEmbeddingError("rejected", `Orchestrator credential unavailable: ${describe(error)}`);
    }
    let response: Awaited<ReturnType<typeof postJson>>;
    try {
      response = await postJson(
        this.endpoint,
        { model: this.options.model, input, encoding_format: "base64" },
        {
          headers: { authorization: `Bearer ${token}`, [SWITCH_POLICY_HEADER]: SWITCH_POLICY_IF_IDLE },
          timeoutMs: this.options.timeoutMs,
          maxResponseBytes:
            input.length * (this.dim * RESPONSE_BYTES_PER_DIMENSION + RESPONSE_BYTES_PER_VECTOR_OVERHEAD),
          ca: this.options.ca,
          signal,
        },
      );
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      if (error instanceof JsonHttpTimeoutError) {
        throw new RemoteEmbeddingError("unavailable", `Orchestrator embeddings ${error.message}`);
      }
      throw new RemoteEmbeddingError("unavailable", `Orchestrator embeddings unreachable: ${describe(error)}`);
    }
    if (response.status < 200 || response.status >= 300) throw classifyHttpFailure(response);
    return this.parse(response.body, input.length);
  }

  private parse(body: string, expectedRows: number): Float32Array[] {
    let value: unknown;
    try {
      value = JSON.parse(body);
    } catch {
      throw new RemoteEmbeddingError("invalid_response", "Orchestrator embeddings response is not JSON");
    }
    const record = isRecord(value) ? value : undefined;
    if (record?.model !== this.options.model) {
      throw new RemoteEmbeddingError(
        "invalid_response",
        `Orchestrator served model ${String(record?.model)}; expected ${this.options.model}`,
      );
    }
    const data = record.data;
    if (!Array.isArray(data) || data.length !== expectedRows) {
      throw new RemoteEmbeddingError(
        "invalid_response",
        `Orchestrator returned ${Array.isArray(data) ? data.length : 0} vectors; expected ${expectedRows}`,
      );
    }
    const vectors = new Array<Float32Array | undefined>(expectedRows);
    for (const item of data) {
      const index = isRecord(item) ? item.index : undefined;
      if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= expectedRows) {
        throw new RemoteEmbeddingError("invalid_response", "Orchestrator returned an invalid vector index");
      }
      if (vectors[index]) throw new RemoteEmbeddingError("invalid_response", "Orchestrator returned a duplicate index");
      vectors[index] = normalize(this.decode(isRecord(item) ? item.embedding : undefined));
    }
    return vectors as Float32Array[];
  }

  private decode(embedding: unknown): Float32Array {
    let vector: Float32Array;
    if (typeof embedding === "string") {
      const bytes = Buffer.from(embedding, "base64");
      if (bytes.byteLength !== this.dim * Float32Array.BYTES_PER_ELEMENT) throw this.dimensionError();
      vector = new Float32Array(this.dim);
      for (let index = 0; index < this.dim; index++) vector[index] = bytes.readFloatLE(index * 4);
    } else if (Array.isArray(embedding) && embedding.every((item) => typeof item === "number")) {
      if (embedding.length !== this.dim) throw this.dimensionError();
      vector = Float32Array.from(embedding);
    } else {
      throw new RemoteEmbeddingError("invalid_response", "Orchestrator returned a malformed embedding");
    }
    if (!vector.every(Number.isFinite)) {
      throw new RemoteEmbeddingError("invalid_response", "Orchestrator returned a non-finite embedding value");
    }
    return vector;
  }

  private dimensionError(): RemoteEmbeddingError {
    return new RemoteEmbeddingError(
      "invalid_response",
      `Orchestrator embedding dimensions do not match configured dimension ${this.dim}`,
    );
  }
}

/** L2-normalise in place, matching the local server's `normalize: true`; idempotent for unit vectors. */
function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const value of vector) sum += value * value;
  const norm = Math.sqrt(sum);
  if (norm === 0) throw new RemoteEmbeddingError("invalid_response", "Orchestrator returned a zero vector");
  for (let index = 0; index < vector.length; index++) vector[index] /= norm;
  return vector;
}

function classifyHttpFailure(response: { status: number; headers: Record<string, unknown>; body: string }) {
  const preview = response.body.replace(/\s+/g, " ").slice(0, ERROR_BODY_PREVIEW_CHARACTERS);
  const message = `Orchestrator embeddings failed with HTTP ${response.status}: ${preview}`;
  if (response.status === 429 || response.status === 503) {
    return new RemoteEmbeddingError("busy", message, retryAfterMs(response.headers["retry-after"]));
  }
  if (BATCH_REJECTION_STATUSES.has(response.status)) return new RemoteEmbeddingError("batch_rejected", message);
  return new RemoteEmbeddingError(response.status >= 500 ? "unavailable" : "rejected", message);
}

/** Delay-seconds form of Retry-After only (RFC 9110); dates and junk are ignored. */
function retryAfterMs(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number(value) * 1000;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n]+/g, " ").slice(0, ERROR_BODY_PREVIEW_CHARACTERS);
}
