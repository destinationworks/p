export const maxRequestBytes = 16 * 1024 * 1024;
export const maxBufferedRequestBytes = maxRequestBytes * 2;
export const maxConcurrentRequests = 4;
export const requestTimeoutMillis = 30_000;
export const forwardRequestHeaders = new Set(["accept", "content-type", "user-agent"]);
export const hopHeaders = new Set(
  "api-key authorization connection host keep-alive proxy-authenticate proxy-authorization te trailer transfer-encoding upgrade x-api-key".split(
    " ",
  ),
);
