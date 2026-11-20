import fs, { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  contentsOf,
  createIndexedFixture,
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

describe("in-place incremental refresh cleanup record", () => {
  it("keeps a committed refresh when cleanup fails and purges the leftovers on the next unchanged refresh", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    fixture.store.failNextDeleteFileVersions = true;

    const committed = await fixture.service.refresh();

    expect(committed.status.state).toBe("ready");
    expect(storedContents(fixture)).toContain("alpha-original-token");
    const hits = await visibleHits(fixture);
    expect(contentsOf(hits)).toContain("alpha-updated-token");
    expect(contentsOf(hits)).not.toContain("alpha-original-token");
    expect(existsSync(pendingCleanupPath(fixture))).toBe(true);

    const unchanged = await fixture.service.refresh();

    expect(unchanged.filesChanged).toBe(0);
    expect(storedContents(fixture)).not.toContain("alpha-original-token");
    expect(fixture.store.allContents()).toHaveLength(unchanged.status.indexedChunks);
    expect(existsSync(pendingCleanupPath(fixture))).toBe(false);
  });

  it("never lets a failing cleanup block later refreshes, and a rebuild drops the leftovers and the record", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    fixture.store.failDeleteFileVersions = true;

    await expect(fixture.service.refresh()).resolves.toMatchObject({ status: { state: "ready" } });
    await expect(fixture.service.refresh()).resolves.toMatchObject({ filesChanged: 0, status: { state: "ready" } });
    expect(recordedCleanupPaths(fixture)).toEqual(["alpha.ts"]);
    expect(storedContents(fixture)).toContain("alpha-original-token");

    const rebuilt = await fixture.service.rebuild();

    expect(rebuilt).toMatchObject({ fullRebuild: true, status: { state: "ready" } });
    expect(recordedCleanupPaths(fixture)).toBeUndefined();
    expect(contentsOf(await visibleHits(fixture))).toContain("alpha-updated-token");
    expect(storedContents(fixture)).not.toContain("alpha-original-token");
    expect(fixture.store.allContents()).toHaveLength(rebuilt.status.indexedChunks);
  });

  it("keeps purging the other paths when one path fails and records only the failed path", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    fixture.store.failNextDeleteFileVersions = true;

    await fixture.service.refresh();

    expect(recordedCleanupPaths(fixture)).toEqual(["alpha.ts"]);
    expect(storedContents(fixture)).toContain("alpha-original-token");
    expect(storedContents(fixture)).not.toContain("beta-original-token");
  });

  it("discards the record when a sparse generation replaces the collection", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    fixture.store.failDeleteFileVersions = true;
    await fixture.service.refresh();
    expect(recordedCleanupPaths(fixture)).toEqual(["alpha.ts"]);
    // Any further change now exceeds the change ratio, so the refresh copies the index into a new generation.
    fixture.service.settings.fullSparseRebuildChangeRatio = 0;
    writeFiles(fixture.root, { "beta.ts": UPDATED["beta.ts"] });

    const summary = await fixture.service.refresh();

    expect(fixture.store.createdCollections).toHaveLength(fixture.collectionsAfterIndex.length + 1);
    expect(recordedCleanupPaths(fixture)).toBeUndefined();
    expect(storedContents(fixture)).not.toMatch(/(alpha|beta)-original-token/);
    expect(fixture.store.allContents()).toHaveLength(summary.status.indexedChunks);
  });

  it("stops the start-of-refresh cleanup between paths when the refresh is cancelled", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, UPDATED);
    fixture.store.failDeleteFileVersions = true;
    await fixture.service.refresh();
    fixture.store.failDeleteFileVersions = false;
    expect(recordedCleanupPaths(fixture)).toEqual(["alpha.ts", "beta.ts"]);
    const controller = new AbortController();
    let deleteCalls = 0;
    fixture.store.onDeleteFileVersions = () => {
      deleteCalls += 1;
      controller.abort(new Error("Code RAG refresh cancelled"));
    };

    await fixture.service.refresh({}, controller.signal);

    expect(deleteCalls).toBe(1);
    expect(storedContents(fixture)).not.toContain("alpha-original-token");
    expect(storedContents(fixture)).toContain("beta-original-token");
    expect(recordedCleanupPaths(fixture)).toEqual(["beta.ts"]);

    fixture.store.onDeleteFileVersions = undefined;
    await fixture.service.refresh();
    expect(storedContents(fixture)).not.toContain("beta-original-token");
    expect(existsSync(pendingCleanupPath(fixture))).toBe(false);
  });

  it("discards the record when a missing collection forces a rebuild", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    fixture.store.failNextDeleteFileVersions = true;
    await fixture.service.refresh();
    expect(existsSync(pendingCleanupPath(fixture))).toBe(true);
    fixture.store.collections.clear();

    const summary = await fixture.service.refresh();

    expect(summary.fullRebuild).toBe(true);
    expect(existsSync(pendingCleanupPath(fixture))).toBe(false);
  });

  it("discards a malformed record without failing the refresh", async () => {
    const fixture = await createIndexedFixture();
    writeFileSync(pendingCleanupPath(fixture), "{not json");

    const summary = await fixture.service.refresh();

    expect(summary.status.state).toBe("ready");
    expect(existsSync(pendingCleanupPath(fixture))).toBe(false);
  });

  it("refuses to store new versions when the record cannot be read", async () => {
    const fixture = await createIndexedFixture();
    mkdirSync(pendingCleanupPath(fixture));
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });

    await expect(fixture.service.refresh()).rejects.toThrow(/EISDIR/);

    expect(fixture.store.upsertedPointIds).toHaveLength(0);
    expect(contentsOf(await visibleHits(fixture))).toContain("alpha-original-token");
  });

  it("removes its temporary file and stores nothing when the record cannot be committed", async () => {
    const fixture = await createIndexedFixture();
    writeFiles(fixture.root, { "alpha.ts": UPDATED["alpha.ts"] });
    const rename = fs.renameSync;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === pendingCleanupPath(fixture)) throw new Error("synthetic record commit failure");
      rename(from, to);
    });

    await expect(fixture.service.refresh()).rejects.toThrow("synthetic record commit failure");

    vi.restoreAllMocks();
    const repositoryEntries = readdirSync(dirname(pendingCleanupPath(fixture)));
    expect(repositoryEntries.filter((name) => name.startsWith("pending-file-cleanup"))).toEqual([]);
    expect(fixture.store.upsertedPointIds).toHaveLength(0);
    expect(contentsOf(await visibleHits(fixture))).toContain("alpha-original-token");
  });
});
