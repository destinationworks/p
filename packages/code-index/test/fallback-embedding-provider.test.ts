import { describe, expect, it, vi } from "vitest";
import { FallbackEmbeddingProvider } from "../src/embed/fallback-embedding-provider.ts";
import type { EmbeddingProvider } from "../src/embed/provider.ts";
import { RemoteEmbeddingError, type RemoteEmbeddingFailureKind } from "../src/embed/remote-embedding-error.ts";

class ScriptedProvider implements EmbeddingProvider {
  readonly dim: number;
  readonly label: number;
  readonly calls: string[] = [];
  failures: Error[] = [];
  ensureReady = vi.fn(async () => {});
  dispose = vi.fn(async () => {});

  constructor(label: number, dim = 2) {
    this.label = label;
    this.dim = dim;
  }

  async encode(texts: string[]): Promise<Float32Array[]> {
    this.calls.push(`encode:${texts.join(",")}`);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return texts.map(() => Float32Array.of(this.label, 0));
  }

  async encodeQuery(text: string): Promise<Float32Array> {
    this.calls.push(`query:${text}`);
    const failure = this.failures.shift();
    if (failure) throw failure;
    return Float32Array.of(this.label, 0);
  }
}

function remoteFailure(kind: RemoteEmbeddingFailureKind, retryAfterMs?: number): RemoteEmbeddingError {
  return new RemoteEmbeddingError(kind, `remote ${kind}`, retryAfterMs);
}

function setup(options: { prepareFallback?: () => Promise<void> } = {}) {
  let now = 1_000_000;
  const remote = new ScriptedProvider(1);
  const local = new ScriptedProvider(2);
  const logs: string[] = [];
  const provider = new FallbackEmbeddingProvider(remote, local, {
    cooldownMs: 300_000,
    busyRetryMs: 60_000,
    now: () => now,
    onLog: (level, message) => logs.push(`${level}: ${message}`),
    ...options,
  });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { remote, local, logs, provider, advance };
}

describe("remote-first embedding with local fallback", () => {
  it("never prepares or calls the local backend while the remote backend is healthy", async () => {
    const { remote, local, provider } = setup();

    await provider.ensureReady();
    const vectors = await provider.encode(["a", "b"]);
    const query = await provider.encodeQuery("q");

    expect(vectors.map((vector) => vector[0])).toEqual([1, 1]);
    expect(query[0]).toBe(1);
    expect(remote.calls).toEqual(["encode:a,b", "query:q"]);
    expect(local.calls).toEqual([]);
    expect(local.ensureReady).not.toHaveBeenCalled();
  });

  it("embeds the failed batch locally and stays local for the cooldown after an outage", async () => {
    const prepareFallback = vi.fn(async () => {});
    const { remote, local, provider, advance, logs } = setup({ prepareFallback });
    remote.failures = [remoteFailure("unavailable")];

    const first = await provider.encode(["a"]);
    advance(299_999);
    const second = await provider.encode(["b"]);

    expect([first[0][0], second[0][0]]).toEqual([2, 2]);
    expect(remote.calls).toEqual(["encode:a"]);
    expect(local.calls).toEqual(["encode:a", "encode:b"]);
    expect(prepareFallback).toHaveBeenCalledTimes(2);
    expect(local.ensureReady).not.toHaveBeenCalled();
    expect(provider.usingFallback).toBe(true);
    expect(logs).toEqual([
      "error: Remote embedding backend unavailable; using local embeddings for 300s: remote unavailable",
    ]);
  });

  it("returns to the remote backend after the cooldown and logs the recovery once", async () => {
    const { remote, local, provider, advance, logs } = setup();
    remote.failures = [remoteFailure("invalid_response")];
    await provider.encode(["a"]);

    advance(300_000);
    const recovered = await provider.encode(["b"]);
    await provider.encode(["c"]);

    expect(recovered[0][0]).toBe(1);
    expect(remote.calls).toEqual(["encode:a", "encode:b", "encode:c"]);
    expect(local.calls).toEqual(["encode:a"]);
    expect(provider.usingFallback).toBe(false);
    expect(logs).toHaveLength(2);
    expect(logs[1]).toBe("debug: Remote embedding backend recovered; local fallback no longer used");
  });

  it("does not repeat the degradation log when a retried remote is still down", async () => {
    const { remote, provider, advance, logs } = setup();
    remote.failures = [remoteFailure("unavailable"), remoteFailure("unavailable")];
    await provider.encode(["a"]);
    advance(300_000);
    await provider.encode(["b"]);

    expect(remote.calls).toEqual(["encode:a", "encode:b"]);
    expect(logs).toHaveLength(1);
  });

  it.each([
    [7_000, 7_000],
    [600_000, 60_000],
    [undefined, 60_000],
    [0, 1_000],
  ])("retries a busy remote after min(Retry-After %s, busyRetryMs)", async (retryAfterMs, expectedDelay) => {
    const { remote, provider, advance } = setup();
    remote.failures = [remoteFailure("busy", retryAfterMs)];
    await provider.encode(["a"]);

    advance(expectedDelay - 1);
    await provider.encode(["b"]);
    advance(1);
    await provider.encode(["c"]);

    expect(remote.calls).toEqual(["encode:a", "encode:c"]);
  });

  it("uses the local provider's own ensureReady when no fallback preparation hook is given", async () => {
    const { remote, local, provider } = setup();
    remote.failures = [remoteFailure("rejected")];
    await provider.encodeQuery("q");

    expect(local.ensureReady).toHaveBeenCalledTimes(1);
    expect(local.calls).toEqual(["query:q"]);
  });

  it("prepares the local backend in ensureReady only while falling back", async () => {
    const prepareFallback = vi.fn(async () => {});
    const { remote, provider } = setup({ prepareFallback });
    await provider.ensureReady();
    expect(prepareFallback).not.toHaveBeenCalled();

    remote.failures = [remoteFailure("unavailable")];
    await provider.encode(["a"]);
    prepareFallback.mockClear();
    await provider.ensureReady();
    expect(prepareFallback).toHaveBeenCalledTimes(1);
  });

  it("propagates errors that are not remote outages instead of hiding them behind the fallback", async () => {
    const { remote, local, provider } = setup();
    const bug = new TypeError("cannot read properties of undefined");
    remote.failures = [bug];

    await expect(provider.encode(["a"])).rejects.toBe(bug);
    expect(local.calls).toEqual([]);
    expect(provider.usingFallback).toBe(false);
  });

  it("propagates cancellation without falling back even if the remote reports an outage", async () => {
    const { remote, local, provider } = setup();
    const controller = new AbortController();
    remote.encode = async () => {
      controller.abort(new Error("cancelled"));
      throw remoteFailure("unavailable");
    };

    await expect(provider.encode(["a"], controller.signal)).rejects.toThrow("remote unavailable");
    expect(local.calls).toEqual([]);
    expect(provider.usingFallback).toBe(false);
  });

  it("keeps the cooldown when a success that started before a newer failure finishes late", async () => {
    const { remote, local, provider, logs } = setup();
    let finishSlow: (vectors: Float32Array[]) => void = () => {};
    const slow = new Promise<Float32Array[]>((resolve) => {
      finishSlow = resolve;
    });
    remote.encode = async (texts) => {
      remote.calls.push(`encode:${texts.join(",")}`);
      if (texts[0] === "slow") return slow;
      throw remoteFailure("unavailable");
    };

    const late = provider.encode(["slow"]);
    await provider.encode(["fails"]);
    finishSlow([Float32Array.of(1, 0)]);
    await late;
    await provider.encode(["after"]);

    expect(provider.usingFallback).toBe(true);
    expect(local.calls).toEqual(["encode:fails", "encode:after"]);
    expect(logs.filter((line) => line.includes("recovered"))).toEqual([]);
  });

  it("embeds a rejected batch locally without putting the remote into a cooldown", async () => {
    const { remote, local, provider, logs } = setup();
    remote.failures = [remoteFailure("batch_rejected")];

    await provider.encode(["uncuttable"]);
    await provider.encode(["next"]);

    expect(local.calls).toEqual(["encode:uncuttable"]);
    expect(remote.calls).toEqual(["encode:uncuttable", "encode:next"]);
    expect(provider.usingFallback).toBe(false);
    expect(logs).toEqual([]);
  });

  it("does not start the local backend for a request cancelled while falling back", async () => {
    const prepareFallback = vi.fn(async () => {});
    const { remote, local, provider } = setup({ prepareFallback });
    remote.failures = [remoteFailure("unavailable")];
    await provider.encode(["a"]);
    prepareFallback.mockClear();
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    await expect(provider.encode(["b"], controller.signal)).rejects.toBe(reason);
    expect(prepareFallback).not.toHaveBeenCalled();
    expect(local.calls).toEqual(["encode:a"]);
  });

  it("logs a new degradation after a recovery", async () => {
    const { remote, provider, advance, logs } = setup();
    remote.failures = [remoteFailure("unavailable")];
    await provider.encode(["a"]);
    advance(300_000);
    await provider.encode(["b"]);
    remote.failures = [remoteFailure("busy", 5_000)];
    await provider.encode(["c"]);

    expect(logs.map((line) => line.split(":")[0])).toEqual(["error", "debug", "error"]);
    expect(logs[2]).toContain("busy; using local embeddings for 5s");
  });

  it("refuses to combine backends with different dimensions", () => {
    expect(
      () =>
        new FallbackEmbeddingProvider(new ScriptedProvider(1, 4), new ScriptedProvider(2, 2), {
          cooldownMs: 1,
          busyRetryMs: 1,
        }),
    ).toThrow("Remote embedding dimension 4 does not match local dimension 2");
  });

  it("disposes both backends", async () => {
    const { remote, local, provider } = setup();
    await provider.dispose();
    expect(remote.dispose).toHaveBeenCalledTimes(1);
    expect(local.dispose).toHaveBeenCalledTimes(1);
  });
});
