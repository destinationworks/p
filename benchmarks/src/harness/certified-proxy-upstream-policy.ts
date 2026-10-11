import type { CertifiedEgressProxyOptions } from "./certified-egress-proxy.ts";

export function assertCertifiedProxyUpstreamOptions(options: CertifiedEgressProxyOptions): void {
  const upstream = new URL(options.upstreamBaseUrl);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    (upstream.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname)) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !options.expectedModel
  ) {
    throw new Error("Invalid certified proxy upstream configuration");
  }
}
