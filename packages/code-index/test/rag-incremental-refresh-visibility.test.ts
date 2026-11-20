import fs, { unlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelAfterFirstChangedFile,
  contentsOf,
  createIndexedFixture,
  ORIGINAL,
  pendingCleanupPath,
  recordedCleanupPaths,
  removeIncrementalRefreshFixtures,
  storedContents,
  UPDATED,
  visibleHits,
  writeFiles,
} from "./incremental-refresh-fixture.ts";

afterEach(() => {
  vi.restoreAllMocks();
  removeIncrementalRefreshFixtures();
});

describe("in-place incremental refresh visibility", () => {
  it("keeps every committed file version searchable when a refresh is cancelled after upserting one file", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);

    await cancelAfterFirstChangedFile(fixture);

    const hits = await visibleHits(fixture);
    expect(hits.map((hit) => hit.path).sort()).toEqual(["alpha.ts", "beta.ts", "gamma.ts"]);
    expect(contentsOf(hits)).toContain("alpha-original-token");
    expect(contentsOf(hits)).toContain("beta-original-token");
    expect(contentsOf(hits)).not.toMatch(/updated-token/);
    expect(storedContents(fixture)).toMatch(/updated-token/);
  });

  it("completes a cancelled refresh in place on the next run and leaves only committed chunks", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    await cancelAfterFirstChangedFile(fixture);

    const summary = await fixture.service.refresh();

    expect(summary.status.state).toBe("ready");
    expect(fixture.store.createdCollections).toEqual(fixture.collectionsAfterIndex);
    const hits = await visibleHits(fixture);
    expect(contentsOf(hits)).toContain("alpha-updated-token");
    expect(contentsOf(hits)).toContain("beta-updated-token");
    expect(storedContents(fixture)).not.toMatch(/(alpha|beta)-original-token/);
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
    expect(fs.existsSync(pendingCleanupPath(fixture))).toBe(false);
  });

  it("purges a cancelled refresh's orphans after the files revert to their committed contents", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    await cancelAfterFirstChangedFile(fixture);
    writeFiles(fixture.root, { "alpha.ts": ORIGINAL["alpha.ts"], "beta.ts": ORIGINAL["beta.ts"] });

    const summary = await fixture.service.refresh();

    expect(summary.filesChanged).toBe(0);
    const hits = await visibleHits(fixture);
    expect(contentsOf(hits)).toContain("alpha-original-token");
    expect(contentsOf(hits)).toContain("beta-original-token");
    expect(storedContents(fixture)).not.toMatch(/updated-token/);
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
  });

  it("purges an added file's uncommitted chunks after the file disappears again", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, {
      "delta.ts": "export function deltaHandler() {\n\treturn 'delta-added-token';\n}\n",
      "epsilon.ts": "export function epsilonHandler() {\n\treturn 'epsilon-added-token';\n}\n",
    });
    await cancelAfterFirstChangedFile(fixture);
    expect(storedContents(fixture)).toMatch(/(delta|epsilon)-added-token/);
    expect(contentsOf(await visibleHits(fixture))).not.toMatch(/added-token/);
    unlinkSync(join(fixture.root, "delta.ts"));
    unlinkSync(join(fixture.root, "epsilon.ts"));

    const summary = await fixture.service.refresh();

    expect(summary.filesAdded).toBe(0);
    expect(storedContents(fixture)).not.toMatch(/added-token/);
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
  });

  it("keeps a deleted file searchable until the manifest commit removes it", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    unlinkSync(join(fixture.root, "gamma.ts"));
    await cancelAfterFirstChangedFile(fixture);

    expect(contentsOf(await visibleHits(fixture))).toContain("gamma-original-token");

    await fixture.service.refresh();

    expect(fixture.store.createdCollections).toEqual(fixture.collectionsAfterIndex);
    const hits = await visibleHits(fixture);
    expect(contentsOf(hits)).toContain("alpha-updated-token");
    expect(contentsOf(hits)).not.toContain("gamma-original-token");
    expect(storedContents(fixture)).not.toContain("gamma-original-token");
  });

  it("keeps the old versions visible when the manifest commit fails and reclaims the new ones later", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to).endsWith("manifest.json") && String(from).includes(".tmp")) {
        throw new Error("synthetic manifest commit failure");
      }
      rename(from, to);
    });

    await expect(fixture.service.refresh()).rejects.toThrow("synthetic manifest commit failure");

    vi.restoreAllMocks();
    expect(storedContents(fixture)).toContain("alpha-updated-token");
    expect(contentsOf(await visibleHits(fixture))).toContain("alpha-original-token");
    expect(contentsOf(await visibleHits(fixture))).not.toContain("alpha-updated-token");
    writeFiles(fixture.root, { "alpha.ts": ORIGINAL["alpha.ts"] });
    const summary = await fixture.service.refresh();
    expect(storedContents(fixture)).not.toContain("alpha-updated-token");
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
  });

  it("hides stored chunks whose file version or path is absent from the committed manifest", async () => {
    const fixture = await createIndexedFixture();
    const collection = [...fixture.store.collections.values()][0];
    const alpha = [...collection.values()].find((point) => point.payload.path === "alpha.ts");
    if (!alpha) throw new Error("alpha.ts was not indexed");
    collection.set("stale-version", {
      ...alpha,
      id: "stale-version",
      payload: {
        ...alpha.payload,
        fileHash: "not-the-committed-hash",
        chunkHash: "stale-version-chunk",
        content: "stale-version-token",
      },
    });
    collection.set("unknown-path", {
      ...alpha,
      id: "unknown-path",
      payload: { ...alpha.payload, path: "ghost.ts", chunkHash: "unknown-path-chunk", content: "unknown-path-token" },
    });

    const hits = await visibleHits(fixture);

    expect(contentsOf(hits)).toContain("alpha-original-token");
    expect(contentsOf(hits)).not.toContain("stale-version-token");
    expect(contentsOf(hits)).not.toContain("unknown-path-token");
  });

  it("keeps a committed refresh when cancelled during cleanup and finishes the cleanup on the next run", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    const controller = new AbortController();
    fixture.store.onDeleteFileVersions = () => controller.abort(new Error("Code RAG refresh cancelled"));

    const summary = await fixture.service.refresh({}, controller.signal);

    expect(summary.status.state).toBe("ready");
    const hits = contentsOf(await visibleHits(fixture));
    expect(hits).toContain("alpha-updated-token");
    expect(hits).toContain("beta-updated-token");
    expect(hits).not.toContain("beta-original-token");
    expect(storedContents(fixture)).not.toContain("alpha-original-token");
    expect(storedContents(fixture)).toContain("beta-original-token");
    expect(recordedCleanupPaths(fixture)).toEqual(["beta.ts"]);

    fixture.store.onDeleteFileVersions = undefined;
    await fixture.service.refresh();
    expect(storedContents(fixture)).not.toContain("beta-original-token");
    expect(recordedCleanupPaths(fixture)).toBeUndefined();
  });

  it("commits a refresh whose cancellation arrives after its last changed file was stored", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    unlinkSync(join(fixture.root, "gamma.ts"));
    const controller = new AbortController();

    const summary = await fixture.service.refresh(
      {
        onProgress: (progress) => {
          if (progress.phase === "indexing" && progress.processedFiles === 2) controller.abort();
        },
      },
      controller.signal,
    );

    expect(controller.signal.aborted).toBe(true);
    expect(summary.status.state).toBe("ready");
    const hits = await visibleHits(fixture);
    expect(contentsOf(hits)).toContain("beta-updated-token");
    expect(contentsOf(hits)).not.toContain("gamma-original-token");
    expect(recordedCleanupPaths(fixture)).toEqual(["alpha.ts", "beta.ts", "gamma.ts"]);

    const next = await fixture.service.refresh();
    expect(recordedCleanupPaths(fixture)).toBeUndefined();
    expect(fixture.store.allContents()).toHaveLength(next.status.indexedChunks);
  });

  it("updates one changed file in place without creating a collection or copying unchanged chunks", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });

    const summary = await fixture.service.refresh();

    expect(summary.chunksEmbedded).toBe(1);
    expect(fixture.store.createdCollections).toEqual(fixture.collectionsAfterIndex);
    expect(fixture.store.upsertedPointIds).toHaveLength(1);
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
  });
});
