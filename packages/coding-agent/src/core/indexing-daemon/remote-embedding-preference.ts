import fs from "node:fs";
import path from "node:path";

/**
 * True when the user's code-rag.json routes embeddings to a remote backend first.
 *
 * The daemon then starts the local embedding server only when a repository service
 * falls back to it, instead of loading the local model before every refresh. Settings
 * validation stays with the repository services; an invalid file here means "local".
 */
export function userConfigPrefersRemoteEmbedding(agentDir: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(fs.readFileSync(path.join(agentDir, "code-rag.json"), "utf8"));
  } catch {
    return false;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return (
    config.remoteBackendsAllowed === true &&
    typeof config.remoteEmbeddingUrl === "string" &&
    config.remoteEmbeddingUrl.trim().length > 0
  );
}
