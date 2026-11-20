import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import type { EmbeddingProvider } from "../src/embed/provider.ts";
import { type SemanticSearchHit, WorkspaceCodeRagService } from "../src/index.ts";
import { FakeVectorStore } from "./fake-vector-store.ts";

/** Shared fixture for in-place incremental refresh tests: a three-file repository indexed into a fake store. */

const temporaryDirectories: string[] = [];

export function removeIncrementalRefreshFixtures(): void {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
}

export class CountingEmbeddingProvider implements EmbeddingProvider {
  dim = 3;
  encodeCalls = 0;
  onEncodeCall: ((call: number) => void) | undefined;

  async encode(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    this.encodeCalls += 1;
    this.onEncodeCall?.(this.encodeCalls);
    if (signal?.aborted) throw signal.reason;
    return texts.map((text) => new Float32Array([text.length % 7, text.length % 11, 1]));
  }

  async encodeQuery(): Promise<Float32Array> {
    return new Float32Array([1, 1, 1]);
  }
}

export const ORIGINAL = {
  "alpha.ts": "export function alphaHandler() {\n\treturn 'alpha-original-token';\n}\n",
  "beta.ts": "export function betaHandler() {\n\treturn 'beta-original-token';\n}\n",
  "gamma.ts": "export function gammaHandler() {\n\treturn 'gamma-original-token';\n}\n",
};

export const UPDATED = {
  "alpha.ts": "export function alphaHandler() {\n\treturn 'alpha-updated-token';\n}\n",
  "beta.ts": "export function betaHandler() {\n\treturn 'beta-updated-token';\n}\n",
};

export interface IncrementalRefreshFixture {
  root: string;
  data: string;
  store: FakeVectorStore;
  embedding: CountingEmbeddingProvider;
  service: WorkspaceCodeRagService;
  collectionsAfterIndex: string[];
}

function createService(
  root: string,
  data: string,
  store: FakeVectorStore,
  embedding: EmbeddingProvider,
): WorkspaceCodeRagService {
  return new WorkspaceCodeRagService({
    workspaceRoot: root,
    dataDirectory: data,
    embeddingProvider: embedding,
    vectorStore: store,
    allowSearchRefresh: false,
    settings: {
      enabled: true,
      autoRefresh: false,
      embeddingDimensions: 3,
      embeddingModel: "test-embedding-v1",
      embeddingPooling: "last-non-padding-token",
      embeddingNormalization: "l2",
      // Keep every refresh below the generation-copy thresholds, even after several changed files.
      fullSparseRebuildChangeRatio: 1,
      sparseRebuildDriftRatio: 1,
      preparationMaxWorkers: 1,
      preparationWorkerMemoryBytes: 1024 * 1024,
      preparationMemoryReserveBytes: 1024 * 1024,
    },
  });
}

export async function createIndexedFixture(): Promise<IncrementalRefreshFixture> {
  const directory = mkdtempSync(join(tmpdir(), "p-rag-in-place-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "repo");
  const data = join(directory, "data");
  mkdirSync(root);
  writeFiles(root, ORIGINAL);
  const store = new FakeVectorStore();
  const embedding = new CountingEmbeddingProvider();
  const service = createService(root, data, store, embedding);
  await service.rebuild();
  embedding.encodeCalls = 0;
  store.upsertedPointIds.length = 0;
  return { root, data, store, embedding, service, collectionsAfterIndex: [...store.createdCollections] };
}

export function writeFiles(root: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(root, name), content);
}

/** Searches through a separate service, as an agent process reading the committed manifest from disk would. */
export async function visibleHits(fixture: IncrementalRefreshFixture): Promise<SemanticSearchHit[]> {
  const reader = createService(fixture.root, fixture.data, fixture.store, new CountingEmbeddingProvider());
  try {
    const response = await reader.search({ query: "handler", freshness: "allow_stale", limit: 20 });
    return response.results;
  } finally {
    await reader.dispose();
  }
}

export function contentsOf(hits: SemanticSearchHit[]): string {
  return hits.map((hit) => hit.content).join("\n");
}

export function storedContents(fixture: IncrementalRefreshFixture): string {
  return fixture.store.allContents().join("\n");
}

/** Cancels the refresh when the second changed file starts embedding, after the first file was stored. */
export async function cancelAfterFirstChangedFile(fixture: IncrementalRefreshFixture): Promise<void> {
  const controller = new AbortController();
  fixture.embedding.onEncodeCall = (call) => {
    if (call === 2) controller.abort(new Error("Code RAG refresh cancelled"));
  };
  await expect(fixture.service.refresh({}, controller.signal)).rejects.toThrow("cancelled");
  fixture.embedding.onEncodeCall = undefined;
  expect(fixture.embedding.encodeCalls).toBe(2);
  expect(fixture.store.upsertedPointIds).toHaveLength(1);
}

export function pendingCleanupPath(fixture: IncrementalRefreshFixture): string {
  return join(fixture.data, fixture.service.repoId, "pending-file-cleanup.json");
}

/** Paths left in the cleanup record, or undefined when no record exists. */
export function recordedCleanupPaths(fixture: IncrementalRefreshFixture): string[] | undefined {
  const recordPath = pendingCleanupPath(fixture);
  if (!existsSync(recordPath)) return undefined;
  return (JSON.parse(readFileSync(recordPath, "utf-8")) as { paths: string[] }).paths;
}
