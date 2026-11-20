import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_WORKSPACE_CODE_RAG_SETTINGS,
  getQdrantCollectionCreatedAt,
  QdrantCollectionAdmin,
} from "@dst0/p-code-index";
import {
  type LiveRepository,
  readCollectionProtectionSnapshot,
  readLiveRepositories,
} from "./qdrant-collection-protection.ts";

export const QDRANT_COLLECTION_GC_INTERVAL_MS = 24 * 60 * 60_000;
/** A probe that times out under load must not postpone collection for a whole day. */
export const QDRANT_COLLECTION_GC_OWNERSHIP_RETRY_MS = 15 * 60_000;

export interface QdrantCollectionGcResult {
  deleted: number;
  failed: number;
  retained: number;
}

interface CollectObsoleteQdrantCollectionsOptions {
  dataDirectory: string;
  collectionPrefix: string;
  collectionAdmin: Pick<QdrantCollectionAdmin, "listCollections" | "deleteCollection">;
  readLiveRepositories: () => LiveRepository[];
  canDeleteCollections?: () => boolean;
  now?: () => number;
}

interface CreateQdrantCollectionGarbageCollectorOptions {
  agentDir: string;
  collectionPrefix: string;
  qdrantUrl: string;
  getApiKey: () => string | undefined;
  isOwnedStorage: () => Promise<boolean>;
  canDeleteCollections: () => boolean;
  onLog: (level: "debug" | "error", message: string) => void;
}

export class QdrantCollectionGarbageCollector {
  private readonly collect: () => Promise<QdrantCollectionGcResult>;
  private readonly onLog?: (level: "debug" | "error", message: string) => void;
  private readonly isOwnedStorage?: () => Promise<boolean>;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private runPromise: Promise<void> | undefined;
  private stopped = false;

  constructor(
    collect: () => Promise<QdrantCollectionGcResult>,
    onLog?: (level: "debug" | "error", message: string) => void,
    isOwnedStorage?: () => Promise<boolean>,
  ) {
    this.collect = collect;
    this.onLog = onLog;
    this.isOwnedStorage = isOwnedStorage;
  }

  async start(): Promise<void> {
    if (this.stopped || this.timer) return;
    if (this.runPromise) return this.runPromise;
    let nextRunDelayMs = QDRANT_COLLECTION_GC_INTERVAL_MS;
    const operation = (async () => {
      if (this.isOwnedStorage && !(await this.isOwnedStorage())) {
        this.onLog?.("debug", "Skipping Qdrant collection GC because local storage ownership is unproven");
        nextRunDelayMs = QDRANT_COLLECTION_GC_OWNERSHIP_RETRY_MS;
        return;
      }
      if (this.stopped) return;
      const result = await this.collect();
      this.onLog?.(
        "debug",
        `Qdrant collection GC deleted ${result.deleted}, retained ${result.retained}, failed ${result.failed}`,
      );
    })()
      .catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        this.onLog?.("error", `Qdrant collection GC failed: ${message}`);
      })
      .finally(() => {
        if (this.runPromise === operation) this.runPromise = undefined;
        this.schedule(nextRunDelayMs);
      });
    this.runPromise = operation;
    return operation;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.runPromise;
  }

  private schedule(delayMs: number): void {
    if (this.stopped || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.start();
    }, delayMs);
  }
}

export function createQdrantCollectionGarbageCollector(
  options: CreateQdrantCollectionGarbageCollectorOptions,
): QdrantCollectionGarbageCollector {
  let collectionAdmin: QdrantCollectionAdmin | undefined;
  return new QdrantCollectionGarbageCollector(
    async () => {
      collectionAdmin ??= new QdrantCollectionAdmin({
        url: options.qdrantUrl,
        timeoutMs: DEFAULT_WORKSPACE_CODE_RAG_SETTINGS.searchTimeoutMs,
        apiKey: options.getApiKey(),
      });
      return collectObsoleteQdrantCollections({
        dataDirectory: path.join(options.agentDir, "code-rag"),
        collectionPrefix: options.collectionPrefix,
        collectionAdmin,
        readLiveRepositories: () => readLiveRepositories(options.agentDir),
        canDeleteCollections: options.canDeleteCollections,
      });
    },
    options.onLog,
    options.isOwnedStorage,
  );
}

export async function collectObsoleteQdrantCollections(
  options: CollectObsoleteQdrantCollectionsOptions,
): Promise<QdrantCollectionGcResult> {
  const before = readCollectionProtectionSnapshot(options.dataDirectory, options.readLiveRepositories());
  const collections = await options.collectionAdmin.listCollections();
  const after = readCollectionProtectionSnapshot(options.dataDirectory, options.readLiveRepositories());
  const protectedCollections = new Set([...before.collections, ...after.collections]);
  const now = options.now?.() ?? Date.now();
  const result: QdrantCollectionGcResult = { deleted: 0, failed: 0, retained: 0 };
  const snapshotsAllowDeletion = !before.refreshInProgress && !after.refreshInProgress;
  for (const collection of collections) {
    if (protectedCollections.has(collection)) {
      result.retained += 1;
      continue;
    }
    const createdAt = getQdrantCollectionCreatedAt(collection, options.collectionPrefix);
    if (
      !snapshotsAllowDeletion ||
      !(options.canDeleteCollections?.() ?? true) ||
      createdAt === undefined ||
      now - createdAt < QDRANT_COLLECTION_GC_INTERVAL_MS
    ) {
      result.retained += 1;
      continue;
    }
    try {
      await options.collectionAdmin.deleteCollection(collection);
      result.deleted += 1;
    } catch {
      result.failed += 1;
      result.retained += 1;
    }
  }
  return result;
}

export function hasPersistedQdrantCollections(qdrantDataDirectory: string): boolean {
  try {
    return fs
      .readdirSync(path.join(qdrantDataDirectory, "storage", "collections"), { withFileTypes: true })
      .some((entry) => entry.isDirectory());
  } catch {
    return false;
  }
}
