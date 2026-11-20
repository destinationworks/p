import type { EmbeddingProvider } from "./provider.ts";
import { RemoteEmbeddingError } from "./remote-embedding-error.ts";

/** A busy remote is not retried sooner than this, even with `Retry-After: 0`. */
const MIN_BUSY_RETRY_MS = 1_000;

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Embedding request cancelled");
}

export interface FallbackEmbeddingProviderOptions {
  /** How long to stay on the local backend after the remote backend failed. */
  cooldownMs: number;
  /** Upper bound for a busy remote's Retry-After before trying it again. */
  busyRetryMs: number;
  /**
   * Prepares the local backend before its first use, for example by starting the
   * daemon-owned embedding server. Without it the local provider's own ensureReady runs.
   */
  prepareFallback?: (signal?: AbortSignal) => Promise<unknown>;
  onLog?: (level: "debug" | "error", message: string) => void;
  now?: () => number;
}

/**
 * Uses a remote embedding backend first and the local backend while the remote one
 * is unavailable or busy. Both backends must serve the same model, dimensions,
 * pooling and normalisation, so their vectors can share one index.
 *
 * The local backend is never prepared while the remote backend is healthy, so a
 * working remote keeps the local model out of memory entirely.
 */
export class FallbackEmbeddingProvider implements EmbeddingProvider {
  public readonly dim: number;
  private readonly remote: EmbeddingProvider;
  private readonly local: EmbeddingProvider;
  private readonly options: FallbackEmbeddingProviderOptions;
  private readonly now: () => number;
  private remoteRetryAt = 0;
  private remoteDegraded = false;
  /** Incremented on every remote failure, so a success that started earlier cannot end a newer cooldown. */
  private failureGeneration = 0;

  constructor(remote: EmbeddingProvider, local: EmbeddingProvider, options: FallbackEmbeddingProviderOptions) {
    if (remote.dim !== local.dim) {
      throw new Error(`Remote embedding dimension ${remote.dim} does not match local dimension ${local.dim}`);
    }
    this.dim = local.dim;
    this.remote = remote;
    this.local = local;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  /** True while requests go to the local backend because the remote one failed. */
  get usingFallback(): boolean {
    return this.remoteDegraded && this.now() < this.remoteRetryAt;
  }

  async ensureReady(signal?: AbortSignal): Promise<void> {
    if (this.usingFallback) await this.prepareLocal(signal);
  }

  encode(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.run((provider) => provider.encode(texts, signal), signal);
  }

  encodeQuery(text: string, signal?: AbortSignal): Promise<Float32Array> {
    return this.run((provider) => provider.encodeQuery(text, signal), signal);
  }

  async dispose(): Promise<void> {
    await Promise.all([this.remote.dispose?.(), this.local.dispose?.()]);
  }

  private async run<T>(operation: (provider: EmbeddingProvider) => Promise<T>, signal?: AbortSignal): Promise<T> {
    throwIfAborted(signal);
    if (!this.usingFallback) {
      const generation = this.failureGeneration;
      try {
        const result = await operation(this.remote);
        if (this.remoteDegraded && generation === this.failureGeneration) {
          this.remoteDegraded = false;
          this.options.onLog?.("debug", "Remote embedding backend recovered; local fallback no longer used");
        }
        return result;
      } catch (error) {
        if (signal?.aborted || !(error instanceof RemoteEmbeddingError)) throw error;
        if (error.kind !== "batch_rejected") this.markRemoteFailed(error);
      }
    }
    throwIfAborted(signal);
    await this.prepareLocal(signal);
    return operation(this.local);
  }

  private markRemoteFailed(error: RemoteEmbeddingError): void {
    this.failureGeneration++;
    const delay =
      error.kind === "busy"
        ? Math.max(
            MIN_BUSY_RETRY_MS,
            Math.min(error.retryAfterMs ?? this.options.busyRetryMs, this.options.busyRetryMs),
          )
        : this.options.cooldownMs;
    this.remoteRetryAt = this.now() + delay;
    if (!this.remoteDegraded) {
      this.options.onLog?.(
        "error",
        `Remote embedding backend ${error.kind}; using local embeddings for ${Math.round(delay / 1000)}s: ${error.message}`,
      );
    }
    this.remoteDegraded = true;
  }

  private async prepareLocal(signal?: AbortSignal): Promise<void> {
    if (this.options.prepareFallback) await this.options.prepareFallback(signal);
    else await this.local.ensureReady?.(signal);
  }
}
