import path from "node:path";
import { type CodeRagService, normalizeQdrantCollectionPrefix, WorkspaceCodeRagService } from "@dst0/p-code-index";

export interface DaemonServiceFactoryOptions {
  agentDir: string;
  /** Qdrant endpoint owned by the daemon; repository configs must not point elsewhere. */
  qdrantEndpointUrl: string;
  /** Normalised collection prefix owned by the daemon. */
  collectionPrefix: string;
  /** Starts the daemon-owned local embedding server when a remote embedder falls back to it. */
  prepareEmbeddingFallback: (signal?: AbortSignal) => Promise<unknown>;
}

/**
 * Builds repository services that use the daemon's backends instead of spawning their own.
 */
export function createDaemonServiceFactory(
  options: DaemonServiceFactoryOptions,
): (workspaceRoot: string) => CodeRagService {
  return (workspaceRoot) => {
    const service = new WorkspaceCodeRagService({
      workspaceRoot,
      dataDirectory: path.join(options.agentDir, "code-rag"),
      userConfigPath: path.join(options.agentDir, "code-rag.json"),
      manageLocalBackends: false,
      allowSearchRefresh: false,
      prepareEmbeddingFallback: options.prepareEmbeddingFallback,
    });
    if (service.settings.qdrantUrl !== options.qdrantEndpointUrl) {
      throw new Error("Repository qdrantUrl must match the daemon Qdrant endpoint");
    }
    if (normalizeQdrantCollectionPrefix(service.settings.collectionPrefix) !== options.collectionPrefix) {
      throw new Error("Repository collectionPrefix must match daemon ownership");
    }
    return service;
  };
}
