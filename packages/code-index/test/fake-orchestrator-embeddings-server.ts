import http from "node:http";
import type { AddressInfo } from "node:net";

export interface RecordedEmbeddingsRequest {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: { model?: unknown; input?: unknown; encoding_format?: unknown };
}

export interface FakeReply {
  status?: number;
  headers?: Record<string, string>;
  /** Raw body text; when absent `json` is serialised. */
  body?: string;
  json?: unknown;
  /** Never answer, to exercise client timeouts and cancellation. */
  hang?: boolean;
}

export type FakeHandler = (request: RecordedEmbeddingsRequest) => FakeReply;

/** Loopback HTTP server that speaks the orchestrator's `/v1/embeddings` shape for client tests. */
export class FakeOrchestratorEmbeddingsServer {
  readonly requests: RecordedEmbeddingsRequest[] = [];
  private readonly server: http.Server;
  private handler: FakeHandler;

  constructor(handler: FakeHandler) {
    this.handler = handler;
    this.server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const recorded: RecordedEmbeddingsRequest = {
          method: request.method ?? "",
          path: request.url ?? "",
          headers: request.headers,
          body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as RecordedEmbeddingsRequest["body"],
        };
        this.requests.push(recorded);
        const reply = this.handler(recorded);
        if (reply.hang) return;
        response.writeHead(reply.status ?? 200, { "content-type": "application/json", ...reply.headers });
        response.end(reply.body ?? JSON.stringify(reply.json));
      });
    });
  }

  setHandler(handler: FakeHandler): void {
    this.handler = handler;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

/** Encodes a vector the way llama-server answers `encoding_format: "base64"` (float32 little-endian). */
export function base64Vector(values: number[]): string {
  const bytes = Buffer.alloc(values.length * 4);
  for (const [index, value] of values.entries()) bytes.writeFloatLE(value, index * 4);
  return bytes.toString("base64");
}

/** A deterministic, non-normalised vector per input index so tests can check ordering and normalisation. */
export function vectorFor(index: number, dimensions: number): number[] {
  return Array.from({ length: dimensions }, (_, position) => (position === index % dimensions ? 3 : 0));
}

export function embeddingsReply(model: string, vectors: number[][], order?: number[]): FakeReply {
  const indexes = order ?? vectors.map((_, index) => index);
  return {
    json: {
      object: "list",
      model,
      data: indexes.map((index) => ({ object: "embedding", index, embedding: base64Vector(vectors[index]) })),
    },
  };
}
