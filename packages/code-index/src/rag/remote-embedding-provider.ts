import fs from "node:fs";
import {
  FallbackEmbeddingProvider,
  type FallbackEmbeddingProviderOptions,
} from "../embed/fallback-embedding-provider.ts";
import { OrchestratorEmbeddingProvider } from "../embed/orchestrator-embedding-provider.ts";
import type { EmbeddingProvider } from "../embed/provider.ts";
import { readProviderApiKey } from "../embed/provider-api-key.ts";
import type { WorkspaceCodeRagSettings } from "./types.ts";

/**
 * Wraps the local embedding provider with the configured llm-orchestrator backend.
 * Without `remoteEmbeddingUrl` the local provider is returned unchanged.
 */
export function withRemoteEmbedding(
  settings: WorkspaceCodeRagSettings,
  local: EmbeddingProvider,
  options: Pick<FallbackEmbeddingProviderOptions, "prepareFallback" | "onLog"> = {},
): EmbeddingProvider {
  const { remoteEmbeddingUrl, remoteEmbeddingModel, remoteEmbeddingModelsConfig } = settings;
  if (!remoteEmbeddingUrl) return local;
  if (!remoteEmbeddingModel || !remoteEmbeddingModelsConfig) {
    throw new Error("Remote embedding settings were not resolved");
  }
  const providerName = settings.remoteEmbeddingProvider;
  const remote = new OrchestratorEmbeddingProvider({
    url: remoteEmbeddingUrl,
    model: remoteEmbeddingModel,
    embeddingModel: settings.embeddingModel,
    dimensions: settings.embeddingDimensions,
    apiKey: () => readProviderApiKey(remoteEmbeddingModelsConfig, providerName),
    ca: settings.remoteEmbeddingCaFile ? fs.readFileSync(settings.remoteEmbeddingCaFile, "utf-8") : undefined,
    timeoutMs: settings.remoteEmbeddingTimeoutMs,
    batchSize: settings.encodeBatchSize,
  });
  return new FallbackEmbeddingProvider(remote, local, {
    cooldownMs: settings.remoteEmbeddingCooldownMs,
    busyRetryMs: settings.remoteEmbeddingBusyRetryMs,
    ...options,
  });
}
