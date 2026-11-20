import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { IndexingDaemon } from "../src/core/indexing-daemon/indexingdaemon.ts";
import { do_reconcile } from "../src/core/indexing-daemon/indexingdaemon-methods/lifecycle.ts";
import { do_watchRegistry } from "../src/core/indexing-daemon/indexingdaemon-methods/status-monitoring.ts";
import type { IndexingTrayService } from "../src/core/indexing-tray-manager.ts";

/** Minimal stub satisfying the IndexingDaemon shape needed by do_reconcile/do_watchRegistry. */
function makeDaemonStub(
  agentDir: string,
  trayManager: IndexingTrayService,
  overrides: Record<string, unknown> = {},
): IndexingDaemon {
  return {
    disposed: false,
    quiescing: false,
    registryWatcher: null,
    runtimes: new Map(),
    options: { agentDir },
    trayManager,
    watchFactory: vi.fn(),
    syncRegistry: vi.fn().mockResolvedValue(undefined),
    writeStatus: vi.fn(),
    startDrain: vi.fn(),
    handleRegistryWatchError: vi.fn(),
    ...overrides,
  } as unknown as IndexingDaemon;
}

function makeTray() {
  const start = vi.fn(() => true);
  const stop = vi.fn(() => {});
  const isRunning = vi.fn(() => false);
  return {
    start,
    stop,
    isRunning,
  };
}

describe("indexing daemon tray integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-daemon-tray-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("do_reconcile tray management", () => {
    it("starts tray when enableTray is true (default)", async () => {
      const tray = makeTray();
      const daemon = makeDaemonStub(tempDir, tray);
      await do_reconcile(daemon);
      expect(tray.start).toHaveBeenCalledOnce();
      expect(tray.stop).not.toHaveBeenCalled();
    });

    it("stops tray when enableTray is false in code-rag.json", async () => {
      fs.writeFileSync(path.join(tempDir, "code-rag.json"), JSON.stringify({ enableTray: false }));
      const tray = makeTray();
      const daemon = makeDaemonStub(tempDir, tray);
      await do_reconcile(daemon);
      expect(tray.stop).toHaveBeenCalledOnce();
      expect(tray.start).not.toHaveBeenCalled();
    });

    it("stops tray when enableIndexingTray is false in settings.json", async () => {
      fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify({ enableIndexingTray: false }));
      const tray = makeTray();
      const daemon = makeDaemonStub(tempDir, tray);
      await do_reconcile(daemon);
      expect(tray.stop).toHaveBeenCalledOnce();
    });

    it("skips when daemon is disposed", async () => {
      const tray = makeTray();
      const daemon = makeDaemonStub(tempDir, tray, { disposed: true });
      await do_reconcile(daemon);
      expect(tray.start).not.toHaveBeenCalled();
      expect(tray.stop).not.toHaveBeenCalled();
    });
  });

  describe("do_watchRegistry tray toggle on config change", () => {
    it("starts tray on code-rag.json change when enabled", () => {
      const tray = makeTray();
      let watchCallback: ((event: string, filename: string | null) => void) | undefined;

      const mockWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
      const daemon = makeDaemonStub(tempDir, tray, {
        watchFactory: (_dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
          watchCallback = cb;
          return mockWatcher;
        },
      });

      do_watchRegistry(daemon);
      expect(watchCallback).toBeDefined();

      // Simulate code-rag.json change with tray enabled (default)
      watchCallback!("change", "code-rag.json");
      expect(tray.start).toHaveBeenCalledOnce();
    });

    it("stops tray on settings.json change when disabled", () => {
      fs.writeFileSync(path.join(tempDir, "settings.json"), JSON.stringify({ enableIndexingTray: false }));
      const tray = makeTray();
      let watchCallback: ((event: string, filename: string | null) => void) | undefined;

      const mockWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
      const daemon = makeDaemonStub(tempDir, tray, {
        watchFactory: (_dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
          watchCallback = cb;
          return mockWatcher;
        },
      });

      do_watchRegistry(daemon);
      watchCallback!("change", "settings.json");
      expect(tray.stop).toHaveBeenCalledOnce();
    });

    it("does not toggle tray on unrelated file changes", () => {
      const tray = makeTray();
      let watchCallback: ((event: string, filename: string | null) => void) | undefined;

      const mockWatcher = Object.assign(new EventEmitter(), { close: vi.fn() });
      const daemon = makeDaemonStub(tempDir, tray, {
        watchFactory: (_dir: string, _opts: unknown, cb: (e: string, f: string | null) => void) => {
          watchCallback = cb;
          return mockWatcher;
        },
      });

      do_watchRegistry(daemon);
      watchCallback!("change", "some-other-file.json");
      expect(tray.start).not.toHaveBeenCalled();
      expect(tray.stop).not.toHaveBeenCalled();
    });
  });
  describe("tray start during daemon start", () => {
    function makeStartableDaemon(tray: IndexingTrayService): IndexingDaemon {
      const qdrantDataDirectory = path.join(tempDir, "qdrant");
      // A persisted collection makes start() run Qdrant maintenance before the registry sync.
      fs.mkdirSync(path.join(qdrantDataDirectory, "storage", "collections", "persisted"), { recursive: true });
      const daemon = new IndexingDaemon({
        agentDir: tempDir,
        qdrantBinary: "unused",
        qdrantDataDirectory,
        pythonExecutable: "unused",
        embeddingModel: "unused",
        trayManager: tray,
        disposeBackends: async () => {},
      });
      vi.spyOn(daemon, "watchRegistry").mockImplementation(() => {});
      vi.spyOn(daemon, "writeStatus").mockImplementation(() => {});
      return daemon;
    }

    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve = () => {};
      const promise = new Promise<void>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }

    it("starts the tray before Qdrant maintenance and the registry sync finish", async () => {
      // After a restart the sync took minutes (Qdrant startup plus every repository), and the
      // tray only appeared once it finished.
      const tray = makeTray();
      const daemon = makeStartableDaemon(tray);
      expect(daemon.collectQdrantGarbageOnStart).toBe(true);
      const maintenance = deferred();
      const sync = deferred();
      vi.spyOn(daemon, "startQdrantMaintenance").mockReturnValue(maintenance.promise);
      const syncRegistry = vi.spyOn(daemon, "syncRegistry").mockReturnValue(sync.promise);
      const starting = daemon.start();
      try {
        expect(tray.start).toHaveBeenCalledOnce();
        maintenance.resolve();
        await vi.waitFor(() => expect(syncRegistry).toHaveBeenCalledOnce());
        expect(daemon.writeStatus).not.toHaveBeenCalled();
        sync.resolve();
        await starting;
        expect(tray.start).toHaveBeenCalledOnce();
        expect(daemon.writeStatus).toHaveBeenCalled();
        expect(tray.stop).not.toHaveBeenCalled();
      } finally {
        maintenance.resolve();
        sync.resolve();
        await daemon.stop();
      }
      expect(tray.stop).toHaveBeenCalledOnce();
    });

    it.each(["tray start", "Qdrant maintenance", "registry sync"] as const)(
      "stops the tray and releases the lock when the %s fails",
      async (failingStep) => {
        const tray = makeTray();
        const failure = new Error(`${failingStep} failed`);
        if (failingStep === "tray start") {
          tray.start.mockImplementation(() => {
            throw failure;
          });
        }
        const daemon = makeStartableDaemon(tray);
        const maintenance = vi.spyOn(daemon, "startQdrantMaintenance");
        if (failingStep === "Qdrant maintenance") maintenance.mockRejectedValue(failure);
        else maintenance.mockResolvedValue(undefined);
        const syncRegistry = vi.spyOn(daemon, "syncRegistry");
        if (failingStep === "registry sync") syncRegistry.mockRejectedValue(failure);
        else syncRegistry.mockResolvedValue(undefined);
        await expect(daemon.start()).rejects.toBe(failure);
        expect(tray.start).toHaveBeenCalledOnce();
        expect(tray.stop).toHaveBeenCalledOnce();
        expect(syncRegistry).toHaveBeenCalledTimes(failingStep === "registry sync" ? 1 : 0);
        expect(fs.existsSync(path.join(tempDir, "indexing-service", "daemon.lock"))).toBe(false);
      },
    );

    it("leaves the tray alone when another daemon holds the lock", async () => {
      // The running daemon owns the tray: a second instance must neither start nor stop it.
      const lockPath = path.join(tempDir, "indexing-service", "daemon.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "running-daemon" }));
      const tray = makeTray();
      const daemon = makeStartableDaemon(tray);
      await expect(daemon.start()).rejects.toThrow(`already running with pid ${process.pid}`);
      expect(tray.start).not.toHaveBeenCalled();
      expect(tray.stop).not.toHaveBeenCalled();
      expect(JSON.parse(fs.readFileSync(lockPath, "utf8")).token).toBe("running-daemon");
    });
  });

  describe("tray ownership", () => {
    it("a daemon constructed without a tray manager never launches a tray, even with one installed", () => {
      // Only the service entry point wires the real tray. Library and test daemons used to spawn
      // whatever p-indexing-tray they found, leaving stray menu-bar items behind.
      const binDir = path.join(tempDir, "indexing-service", "bin");
      fs.mkdirSync(binDir, { recursive: true });
      // A runnable stand-in: an empty file would make spawn throw ENOEXEC and hide the bug.
      fs.writeFileSync(path.join(binDir, "p-indexing-tray"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      fs.writeFileSync(path.join(tempDir, "indexing-service", "indexing_tray.py"), "");
      const savedDisplay = process.env.DISPLAY;
      process.env.DISPLAY = ":0";
      try {
        const daemon = new IndexingDaemon({
          agentDir: tempDir,
          qdrantBinary: "unused",
          qdrantDataDirectory: path.join(tempDir, "qdrant"),
          pythonExecutable: "unused",
          embeddingModel: "unused",
        });
        expect(daemon.trayManager.start()).toBe(false);
        expect(daemon.trayManager.isRunning()).toBe(false);
        expect(() => daemon.trayManager.stop()).not.toThrow();
      } finally {
        if (savedDisplay === undefined) delete process.env.DISPLAY;
        else process.env.DISPLAY = savedDisplay;
      }
    });
  });
});
