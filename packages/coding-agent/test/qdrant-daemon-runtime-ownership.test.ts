import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { QdrantCollectionAdmin, QdrantServerManager } from "@dst0/p-code-index";
import { afterEach, describe, expect, it, vi } from "vitest";
import { INDEXED_REPOS_FILE, INDEXED_REPOS_SCHEMA_VERSION } from "../src/core/indexed-repos.ts";
import { createQdrantDaemonRuntime } from "../src/core/indexing-daemon/qdrant-daemon-runtime.ts";

const UNPROVEN = "Skipping Qdrant collection GC because local storage ownership is unproven";
const temporaryDirectories: string[] = [];

function createRuntime(onLog = vi.fn()) {
  const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-qdrant-runtime-ownership-"));
  temporaryDirectories.push(agentDir);
  fs.mkdirSync(path.join(agentDir, "code-rag"));
  fs.writeFileSync(
    path.join(agentDir, INDEXED_REPOS_FILE),
    JSON.stringify({ schemaVersion: INDEXED_REPOS_SCHEMA_VERSION, repos: [] }),
  );
  const runtime = createQdrantDaemonRuntime({
    daemonOptions: {
      agentDir,
      qdrantBinary: "unused",
      qdrantDataDirectory: path.join(agentDir, "qdrant"),
      pythonExecutable: "unused",
      embeddingModel: "unused",
    },
    canDeleteCollections: () => true,
    onLog,
  });
  return { runtime, onLog };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { force: true, recursive: true });
});

describe("Qdrant daemon runtime ownership proof", () => {
  it("does not hold backend readiness on the ownership probe of a pre-existing server", async () => {
    vi.spyOn(QdrantServerManager.prototype, "ensureStarted").mockResolvedValue(false);
    let answerProbe: ((owned: boolean) => void) | undefined;
    vi.spyOn(QdrantServerManager.prototype, "isOwnedServerHealthy").mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          answerProbe = resolve;
        }),
    );
    const listCollections = vi.spyOn(QdrantCollectionAdmin.prototype, "listCollections").mockResolvedValue([]);
    const { runtime } = createRuntime();

    const outcome = await Promise.race([
      runtime.startMaintenance().then(() => "ready"),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 5_000)),
    ]);
    await vi.waitFor(() => expect(answerProbe).toBeDefined());
    expect(listCollections).not.toHaveBeenCalled();
    answerProbe?.(true);
    await vi.waitFor(() => expect(listCollections).toHaveBeenCalledOnce());
    await runtime.garbageCollector.stop();

    expect(outcome).toBe("ready");
  });

  it("probes an unproven pre-existing server once per retry window and never inventories it", async () => {
    vi.spyOn(QdrantServerManager.prototype, "ensureStarted").mockResolvedValue(false);
    const proveOwnership = vi.spyOn(QdrantServerManager.prototype, "isOwnedServerHealthy").mockResolvedValue(false);
    const listCollections = vi.spyOn(QdrantCollectionAdmin.prototype, "listCollections").mockResolvedValue([]);
    const { runtime, onLog } = createRuntime();

    for (let index = 0; index < 3; index += 1) await runtime.startMaintenance();
    await vi.waitFor(() => expect(onLog).toHaveBeenCalledWith("debug", UNPROVEN));
    await runtime.garbageCollector.stop();

    expect(proveOwnership).toHaveBeenCalledOnce();
    expect(onLog.mock.calls.filter(([, message]) => message === UNPROVEN)).toHaveLength(1);
    expect(listCollections).not.toHaveBeenCalled();
  });

  it.each([
    ["started by this daemon", true],
    ["already running", false],
  ])("collects on a server %s once the collector proves ownership", async (_case, startedByDaemon) => {
    vi.spyOn(QdrantServerManager.prototype, "ensureStarted").mockResolvedValue(startedByDaemon);
    const proveOwnership = vi.spyOn(QdrantServerManager.prototype, "isOwnedServerHealthy").mockResolvedValue(true);
    const listCollections = vi.spyOn(QdrantCollectionAdmin.prototype, "listCollections").mockResolvedValue([]);
    const { runtime, onLog } = createRuntime();

    await runtime.startMaintenance();
    await vi.waitFor(() =>
      expect(onLog).toHaveBeenCalledWith("debug", "Qdrant collection GC deleted 0, retained 0, failed 0"),
    );
    await runtime.garbageCollector.stop();

    expect(proveOwnership).toHaveBeenCalledOnce();
    expect(listCollections).toHaveBeenCalledOnce();
  });
});
