import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import { startCertifiedEgressProxy } from "../../src/harness/certified-egress-proxy.ts";

const model = "mini-pc/sokann-qwen-27b-cache";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

async function close(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function within<T>(promise: Promise<T>, message: string): Promise<T> {
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setInterval(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearInterval(timer);
  }
}

test("a cell budget preserves a slow model response beyond the default proxy deadline", async (context) => {
  let finishResponse: (() => void) | undefined;
  let announceRequest: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    announceRequest = resolve;
  });
  const upstream = createServer((request, reply) => {
    request.resume();
    finishResponse = () => {
      reply.writeHead(200, { "content-type": "text/event-stream" });
      reply.end(`data: ${JSON.stringify({ model })}\n\n`);
    };
    announceRequest?.();
  });
  const port = await listen(upstream);
  const proxy = await startCertifiedEgressProxy({
    upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
    expectedModel: model,
  });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    for (const invalid of [0, Number.NaN, 86_400_001]) {
      assert.throws(() => proxy.beginCell("invalid", invalid), /timeout/u);
    }
    proxy.beginCell("slow-model", 60_000);
    const pending = fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model, messages: [] }),
    })
      .then(async (response) => ({ status: response.status, body: await response.text() }))
      .catch((error: unknown) => error);
    await within(requestSeen, "Proxy did not forward the slow-model request");
    context.mock.timers.tick(30_001);
    assert.ok(finishResponse);
    finishResponse();
    assert.deepEqual(await within(pending, "Slow-model response did not finish"), {
      status: 200,
      body: `data: ${JSON.stringify({ model })}\n\n`,
    });
    assert.equal(proxy.endCell("slow-model").requestCount, 1);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});

test("a cell budget still terminates a stalled completion and cannot certify it", async (context) => {
  let announceRequest: (() => void) | undefined;
  const requestSeen = new Promise<void>((resolve) => {
    announceRequest = resolve;
  });
  const upstream = createServer((request) => {
    request.resume();
    announceRequest?.();
  });
  const port = await listen(upstream);
  const proxy = await startCertifiedEgressProxy({
    upstreamBaseUrl: `http://127.0.0.1:${port}/v1`,
    expectedModel: model,
  });
  try {
    context.mock.timers.enable({ apis: ["setTimeout"] });
    proxy.beginCell("stalled-model", 60_000);
    const pending = fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model, messages: [] }),
    }).catch((error: unknown) => error);
    await within(requestSeen, "Proxy did not forward the stalled-model request");
    context.mock.timers.tick(60_001);
    assert.ok((await within(pending, "Stalled-model request did not terminate")) instanceof Error);
    assert.throws(() => proxy.endCell("stalled-model"), /pending|rejected|response model evidence/u);
  } finally {
    await proxy.close();
    await close(upstream);
  }
});
