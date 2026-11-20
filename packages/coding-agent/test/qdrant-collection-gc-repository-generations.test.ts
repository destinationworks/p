import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectObsoleteQdrantCollections } from "../src/core/indexing-daemon/qdrant-collection-garbage-collector.ts";

const DAY_MS = 24 * 60 * 60_000;
const NOW = Date.UTC(2026, 10, 21, 0, 0, 0);
const PREFIX = "p_code_chunks";
const temporaryDirectories: string[] = [];

interface ReferenceFile {
  filename: "manifest.json" | "rebuild-checkpoint.json";
  collection: string;
  root: string;
  updatedAt?: string;
}

function createDataDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-qdrant-gc-generations-"));
  temporaryDirectories.push(directory);
  return directory;
}

function writeReference(dataDirectory: string, repositoryId: string, reference: ReferenceFile): void {
  const directory = path.join(dataDirectory, repositoryId);
  fs.mkdirSync(directory, { recursive: true });
  const { filename, ...contents } = reference;
  fs.writeFileSync(path.join(directory, filename), `${JSON.stringify(contents)}\n`);
}

function collection(repositoryHash: string, ageDays: number, suffix: string): string {
  return `${PREFIX}_${repositoryHash.repeat(16)}_${(NOW - ageDays * DAY_MS).toString(36)}-${suffix}`;
}

async function collect(
  dataDirectory: string,
  collections: string[],
  readLiveRepositories: () => Array<{ root: string; repositoryId: string | undefined }>,
): Promise<{ deleted: string[]; result: Awaited<ReturnType<typeof collectObsoleteQdrantCollections>> }> {
  const deleted: string[] = [];
  const result = await collectObsoleteQdrantCollections({
    dataDirectory,
    collectionPrefix: PREFIX,
    now: () => NOW,
    readLiveRepositories,
    collectionAdmin: {
      listCollections: async () => collections,
      deleteCollection: async (name) => {
        deleted.push(name);
      },
    },
  });
  return { deleted, result };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Qdrant collection GC repository liveness", () => {
  it("deletes collections whose manifests belong to disabled, missing or unregistered repositories", async () => {
    const dataDirectory = createDataDirectory();
    const live = collection("a", 5, "a11ce001");
    const disabled = collection("b", 5, "b0b0b0b0");
    const abandonedBuild = collection("c", 5, "c0c0c0c0");
    writeReference(dataDirectory, "live-id", { filename: "manifest.json", collection: live, root: "/work/live" });
    writeReference(dataDirectory, "disabled-id", {
      filename: "manifest.json",
      collection: disabled,
      root: "/work/disabled",
    });
    writeReference(dataDirectory, "gone-id", {
      filename: "rebuild-checkpoint.json",
      collection: abandonedBuild,
      root: "/work/gone",
    });

    const { deleted, result } = await collect(dataDirectory, [live, disabled, abandonedBuild], () => [
      { root: "/work/live", repositoryId: "live-id" },
    ]);

    expect(deleted).toEqual([disabled, abandonedBuild]);
    expect(result).toEqual({ deleted: 2, failed: 0, retained: 1 });
  });

  it.each([
    ["older than", "2026-10-31T00:00:00.000Z"],
    ["as recent as", "2026-11-20T00:00:00.000Z"],
  ])("deletes a remote-superseded generation %s the committed current generation", async (_case, updatedAt) => {
    const dataDirectory = createDataDirectory();
    const superseded = collection("a", 20, "0dd0dd00");
    const current = collection("d", 3, "c0ffee00");
    writeReference(dataDirectory, "old-remote-id", {
      filename: "manifest.json",
      collection: superseded,
      root: "/work/p",
      updatedAt,
    });
    writeReference(dataDirectory, "current-id", {
      filename: "manifest.json",
      collection: current,
      root: "/work/p",
      updatedAt: "2026-11-20T00:00:00.000Z",
    });

    const { deleted } = await collect(dataDirectory, [superseded, current], () => [
      { root: "/work/p", repositoryId: "current-id" },
    ]);

    expect(deleted).toEqual([superseded]);
  });

  it.each([
    ["has a pending rebuild checkpoint", "2026-10-31T00:00:00.000Z", true],
    ["has no valid update time", "not-a-date", false],
  ])("keeps an older-id generation that %s", async (_case, updatedAt, pendingRebuild) => {
    const dataDirectory = createDataDirectory();
    const previous = collection("a", 20, "0dd0dd00");
    const resumable = collection("a", 19, "0eee0eee");
    const current = collection("d", 3, "c0ffee00");
    writeReference(dataDirectory, "old-remote-id", {
      filename: "manifest.json",
      collection: previous,
      root: "/work/p",
      updatedAt,
    });
    if (pendingRebuild) {
      writeReference(dataDirectory, "old-remote-id", {
        filename: "rebuild-checkpoint.json",
        collection: resumable,
        root: "/work/p",
      });
    }
    writeReference(dataDirectory, "current-id", {
      filename: "manifest.json",
      collection: current,
      root: "/work/p",
      updatedAt: "2026-11-20T00:00:00.000Z",
    });

    const { deleted } = await collect(dataDirectory, [previous, resumable, current], () => [
      { root: "/work/p", repositoryId: "current-id" },
    ]);

    expect(deleted).toEqual(pendingRebuild ? [] : [resumable]);
  });

  it.each([
    ["the current directory does not exist", undefined],
    ["the current generation is still a rebuild checkpoint", "rebuild-checkpoint.json"],
    ["the current manifest is older than the candidate", "older-manifest"],
  ] as const)("keeps every generation of a live repository when %s", async (_case, currentState) => {
    const dataDirectory = createDataDirectory();
    const previous = collection("a", 20, "0dd0dd00");
    const pending = collection("d", 3, "c0ffee00");
    writeReference(dataDirectory, "old-remote-id", {
      filename: "manifest.json",
      collection: previous,
      root: "/work/p",
      updatedAt: "2026-11-20T00:00:00.000Z",
    });
    if (currentState === "rebuild-checkpoint.json") {
      writeReference(dataDirectory, "current-id", { filename: currentState, collection: pending, root: "/work/p" });
    } else if (currentState === "older-manifest") {
      writeReference(dataDirectory, "current-id", {
        filename: "manifest.json",
        collection: pending,
        root: "/work/p",
        updatedAt: "2026-11-01T00:00:00.000Z",
      });
    }

    const { deleted, result } = await collect(dataDirectory, [previous, pending], () => [
      { root: "/work/p", repositoryId: "current-id" },
    ]);

    expect(deleted).toEqual(currentState === undefined ? [pending] : []);
    expect(result.retained).toBe(currentState === undefined ? 1 : 2);
  });

  it("keeps every generation of an enabled repository whose volume is unreachable", async () => {
    const dataDirectory = createDataDirectory();
    const older = collection("a", 20, "0dd0dd00");
    const newer = collection("d", 3, "c0ffee00");
    for (const [repositoryId, name, updatedAt] of [
      ["old-remote-id", older, "2026-10-01T00:00:00.000Z"],
      ["new-remote-id", newer, "2026-11-20T00:00:00.000Z"],
    ]) {
      writeReference(dataDirectory, repositoryId, {
        filename: "manifest.json",
        collection: name,
        root: "/Volumes/offline/repo",
        updatedAt,
      });
    }

    const { deleted, result } = await collect(dataDirectory, [older, newer], () => [
      { root: "/Volumes/offline/repo", repositoryId: undefined },
    ]);

    expect(deleted).toEqual([]);
    expect(result.retained).toBe(2);
  });

  it.each([
    ["before", [[{ root: "/work/live", repositoryId: "live-id" }], []]],
    ["after", [[], [{ root: "/work/live", repositoryId: "live-id" }]]],
  ] as const)("protects a repository that is live only %s the collection inventory", async (_when, sequence) => {
    const dataDirectory = createDataDirectory();
    const live = collection("a", 5, "a11ce001");
    writeReference(dataDirectory, "live-id", { filename: "manifest.json", collection: live, root: "/work/live" });
    const readLiveRepositories = vi
      .fn<() => Array<{ root: string; repositoryId: string | undefined }>>()
      .mockReturnValueOnce([...sequence[0]])
      .mockReturnValueOnce([...sequence[1]]);

    const { deleted } = await collect(dataDirectory, [live], readLiveRepositories);

    expect(readLiveRepositories).toHaveBeenCalledTimes(2);
    expect(deleted).toEqual([]);
  });

  it("fails closed without deleting when the live repository set cannot be read", async () => {
    const dataDirectory = createDataDirectory();
    const orphan = collection("b", 5, "b0b0b0b0");
    const deleteCollection = vi.fn(async () => {});

    await expect(
      collectObsoleteQdrantCollections({
        dataDirectory,
        collectionPrefix: PREFIX,
        now: () => NOW,
        readLiveRepositories: () => {
          throw new Error("registry unreadable");
        },
        collectionAdmin: { listCollections: async () => [orphan], deleteCollection },
      }),
    ).rejects.toThrow("registry unreadable");
    expect(deleteCollection).not.toHaveBeenCalled();
  });
});
