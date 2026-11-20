/**
 * Failure of a remote embedding backend that the caller may route around with the local backend.
 *
 * - `unavailable`: the endpoint could not be reached, timed out or failed with a server error.
 * - `busy`: the endpoint refused to switch its GPU away from other work right now.
 * - `rejected`: the endpoint refused the request (credentials, unknown model).
 * - `batch_rejected`: the endpoint refused this batch's content (for example an input it cannot
 *   truncate); other batches may still succeed.
 * - `invalid_response`: the endpoint answered, but not with the vectors this index requires.
 */
export type RemoteEmbeddingFailureKind = "unavailable" | "busy" | "rejected" | "batch_rejected" | "invalid_response";

export class RemoteEmbeddingError extends Error {
  readonly kind: RemoteEmbeddingFailureKind;
  readonly retryAfterMs: number | undefined;

  constructor(kind: RemoteEmbeddingFailureKind, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "RemoteEmbeddingError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}
