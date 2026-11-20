import http from "node:http";
import https from "node:https";

export interface JsonHttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

export interface JsonHttpRequestOptions {
  headers: Record<string, string>;
  timeoutMs: number;
  maxResponseBytes: number;
  /** PEM trust anchors for HTTPS. Undefined keeps Node's default trust store. */
  ca?: string;
  signal?: AbortSignal;
}

/** Thrown when the request exceeds its deadline; distinct from caller cancellation. */
export class JsonHttpTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`request timed out after ${timeoutMs} ms`);
    this.name = "JsonHttpTimeoutError";
  }
}

/**
 * POST a JSON body and collect the response text.
 *
 * Uses node:http(s) instead of global fetch so a private CA can be trusted per request
 * without NODE_EXTRA_CA_CERTS, which launchd jobs do not inherit from the login shell.
 */
export function postJson(url: URL, body: unknown, options: JsonHttpRequestOptions): Promise<JsonHttpResponse> {
  const signal = options.signal;
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  const payload = Buffer.from(JSON.stringify(body), "utf-8");
  const transport = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, response?: JsonHttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (response) resolve(response);
      else reject(error);
    };
    const request = transport.request(
      url,
      {
        method: "POST",
        headers: {
          ...options.headers,
          "content-type": "application/json",
          "content-length": String(payload.byteLength),
        },
        ...(url.protocol === "https:" && options.ca ? { ca: options.ca } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let received = 0;
        response.on("data", (chunk: Buffer) => {
          received += chunk.byteLength;
          if (received > options.maxResponseBytes) {
            request.destroy(new Error(`response exceeded ${options.maxResponseBytes} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () =>
          finish(undefined, {
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        response.on("error", (error) => finish(error));
      },
    );
    const onAbort = () => {
      const reason = signal?.reason ?? new Error("Request cancelled");
      request.destroy(reason instanceof Error ? reason : new Error(String(reason)));
      finish(reason);
    };
    const timer = setTimeout(() => {
      const error = new JsonHttpTimeoutError(options.timeoutMs);
      request.destroy(error);
      finish(error);
    }, options.timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    request.on("error", (error) => finish(error));
    request.end(payload);
  });
}
