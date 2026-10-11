export function certifiedProxyForwardErrorKind(error: unknown): string {
  if (error instanceof Error && error.message === "Certified proxy client disconnected") return "client-disconnect";
  if (error instanceof Error && "code" in error && error.code === "ECONNRESET") return "upstream-reset";
  return "forward-error";
}
