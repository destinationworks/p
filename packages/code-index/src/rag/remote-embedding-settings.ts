import fs from "node:fs";
import path from "node:path";

/**
 * Remote embedding backend (llm-orchestrator `/v1/embeddings`) settings from code-rag.json.
 * Unset `remoteEmbeddingUrl` keeps embeddings local.
 */
export interface RemoteEmbeddingSettings {
  remoteEmbeddingUrl?: string;
  /** Canonical orchestrator model name serving `embeddingModel`, e.g. `mini-pc-2/qwen3-embedding-0.6b`. */
  remoteEmbeddingModel?: string;
  /** Provider entry in models.json whose apiKey authenticates to the orchestrator. */
  remoteEmbeddingProvider: string;
  remoteEmbeddingModelsConfig?: string;
  remoteEmbeddingCaFile?: string;
  remoteEmbeddingTimeoutMs: number;
  remoteEmbeddingCooldownMs: number;
  remoteEmbeddingBusyRetryMs: number;
}

export const DEFAULT_REMOTE_EMBEDDING_SETTINGS: RemoteEmbeddingSettings = {
  remoteEmbeddingProvider: "mini-pc-11450",
  remoteEmbeddingTimeoutMs: 120_000,
  remoteEmbeddingCooldownMs: 5 * 60_000,
  remoteEmbeddingBusyRetryMs: 60_000,
};

export const REMOTE_EMBEDDING_STRING_KEYS = [
  "remoteEmbeddingUrl",
  "remoteEmbeddingModel",
  "remoteEmbeddingProvider",
  "remoteEmbeddingModelsConfig",
  "remoteEmbeddingCaFile",
] as const;

export const REMOTE_EMBEDDING_NUMBER_KEYS = [
  "remoteEmbeddingTimeoutMs",
  "remoteEmbeddingCooldownMs",
  "remoteEmbeddingBusyRetryMs",
] as const;

const REMOTE_EMBEDDING_KEYS = new Set<string>([...REMOTE_EMBEDDING_STRING_KEYS, ...REMOTE_EMBEDDING_NUMBER_KEYS]);

/**
 * A repository must not redirect its own source text to a remote endpoint, so these
 * keys are accepted only from the user's code-rag.json.
 */
export function rejectRepositoryRemoteEmbeddingSettings(repositoryConfig: Record<string, unknown>, configPath: string) {
  const offending = Object.keys(repositoryConfig).filter((key) => REMOTE_EMBEDDING_KEYS.has(key));
  if (offending.length > 0) {
    throw new Error(
      `Repository code RAG config ${configPath} cannot set ${offending.join(", ")}; remote embedding settings belong in the user config`,
    );
  }
}

/** Validates the remote embedding settings and fills paths relative to the user config directory. */
export function resolveRemoteEmbeddingSettings<T extends RemoteEmbeddingSettings>(
  settings: T,
  options: { remoteBackendsAllowed: boolean; userConfigPath: string },
): T {
  for (const key of REMOTE_EMBEDDING_NUMBER_KEYS) {
    const value = settings[key];
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Code RAG ${key} must be positive`);
  }
  if (settings.remoteEmbeddingUrl === undefined) return settings;
  if (!options.remoteBackendsAllowed) {
    throw new Error("Code RAG remoteEmbeddingUrl requires remoteBackendsAllowed to be explicitly enabled");
  }
  let url: URL;
  try {
    url = new URL(settings.remoteEmbeddingUrl);
  } catch {
    throw new Error("Code RAG remoteEmbeddingUrl must be an absolute https:// origin");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const schemeAllowed = url.protocol === "https:" || (url.protocol === "http:" && loopback);
  if (!schemeAllowed || url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("Code RAG remoteEmbeddingUrl must be an https:// origin without path, query or credentials");
  }
  if (!settings.remoteEmbeddingModel) {
    throw new Error("Code RAG remoteEmbeddingModel is required when remoteEmbeddingUrl is set");
  }
  const agentDirectory = path.dirname(options.userConfigPath);
  return {
    ...settings,
    remoteEmbeddingUrl: url.origin,
    remoteEmbeddingModelsConfig: settings.remoteEmbeddingModelsConfig ?? path.join(agentDirectory, "models.json"),
    remoteEmbeddingCaFile: settings.remoteEmbeddingCaFile ?? defaultCaFile(url, agentDirectory),
  };
}

/** The orchestrator's private CA saved next to code-rag.json, if present; otherwise Node's default trust store. */
function defaultCaFile(url: URL, agentDirectory: string): string | undefined {
  const caFile = path.join(agentDirectory, "ca.pem");
  return url.protocol === "https:" && fs.existsSync(caFile) ? caFile : undefined;
}
