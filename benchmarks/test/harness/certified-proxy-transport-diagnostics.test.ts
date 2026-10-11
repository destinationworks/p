import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { startCertifiedEgressProxy } from "../../src/harness/certified-egress-proxy.ts";
import { certifiedProxyForwardErrorKind } from "../../src/harness/certified-proxy-forward-error.ts";

test("proxy transport labels expose no exception message or payload", () => {
  assert.equal(certifiedProxyForwardErrorKind(new Error("Certified proxy client disconnected")), "client-disconnect");
  assert.equal(
    certifiedProxyForwardErrorKind(Object.assign(new Error("contains secret"), { code: "ECONNRESET" })),
    "upstream-reset",
  );
  assert.equal(certifiedProxyForwardErrorKind(new Error("contains secret")), "forward-error");
});

test("a reset upstream completion fails certification with a payload-free transport reason", async () => {
  const upstream = createServer((request) => request.socket.destroy());
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const address = upstream.address();
  assert.ok(address && typeof address !== "string");
  const proxy = await startCertifiedEgressProxy({
    upstreamBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    expectedModel: "expected/model",
  });
  try {
    proxy.beginCell("transport-reset");
    const secretCanary = "private-request-payload-must-not-leak";
    const response = await fetch(`${proxy.baseUrl}/chat/completions`, {
      method: "POST",
      body: JSON.stringify({ model: "expected/model", messages: [{ role: "user", content: secretCanary }] }),
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), "");
    let failure: unknown;
    try {
      proxy.endCell("transport-reset");
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    assert.match(failure.message, /requests=1 pending=0 rejected=1 rejectionKind=upstream-reset/u);
    assert.doesNotMatch(failure.message, /private-request-payload-must-not-leak/u);
  } finally {
    await proxy.close();
    upstream.closeAllConnections();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});
