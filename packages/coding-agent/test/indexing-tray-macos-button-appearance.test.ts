import { describe, expect, it } from "vitest";
import {
  canCompileTrayLogic,
  type Json,
  trayStatus as status,
  useTrayLogicHarness,
} from "./tray-macos-logic-test-harness.ts";

// The menu-bar button must only be re-rendered when what it shows changes: every image or tooltip
// assignment re-renders the status item and ships a snapshot to the menu bar host.

describe.skipIf(!canCompileTrayLogic)("macOS tray button appearance (compiled Swift)", () => {
  const { one } = useTrayLogicHarness();

  describe("trayButtonAppearance", () => {
    const appearance = (service: string, processRunning: boolean, statusData: Json | null) =>
      one({ kind: "buttonAppearance", service, processRunning, status: statusData });

    it("shows the indexing dot and progress for a live daemon, idle otherwise", () => {
      expect(appearance("loaded", true, status("indexing", { progress: { percent: 42.9 } }))).toEqual({
        isIndexing: true,
        isError: false,
        toolTip: "Indexing: alpha (42%)",
      });
      expect(appearance("loaded", true, status("ready"))).toEqual({
        isIndexing: false,
        isError: false,
        toolTip: "P Code Indexing (Idle)",
      });
    });

    it("marks a repository error, a stopped service, and a service that has not started yet", () => {
      expect(appearance("loaded", true, status("error"))).toMatchObject({ isError: true });
      expect(appearance("notLoaded", true, status("indexing"))).toEqual({
        isIndexing: false,
        isError: true,
        toolTip: "P Code Indexing (Stopped)",
      });
      expect(appearance("loaded", false, status("indexing"))).toEqual({
        isIndexing: false,
        isError: false,
        toolTip: "P Code Indexing (Starting)",
      });
    });

    describe("trayButtonUpdates", () => {
      const state = (service: string, processRunning: boolean, statusData: Json | null) => ({
        service,
        processRunning,
        status: statusData,
      });
      const tick = (percent: number, updatedAt: string) =>
        state("loaded", true, status("indexing", { progress: { percent }, updatedAt }));
      const updates = (shown: Json | undefined, next: Json) => one({ kind: "buttonUpdates", shown, next });

      it("draws both icon and tooltip the first time", () => {
        expect(updates(undefined, state("loaded", true, status("ready")))).toEqual({ image: true, toolTip: true });
      });

      it("touches nothing for status-file churn that does not change what the button shows", () => {
        // The daemon rewrites the status file on every progress tick and the tray reloads it every
        // two seconds; only a visible change may re-render the menu-bar item.
        expect(updates(tick(42.1, "2026-10-31T00:00:01Z"), tick(42.8, "2026-10-31T00:00:09Z"))).toEqual({
          image: false,
          toolTip: false,
        });
        expect(updates(state("loaded", true, status("ready")), state("loaded", true, status("ready")))).toEqual({
          image: false,
          toolTip: false,
        });
      });

      it("updates only the tooltip when the visible progress changes", () => {
        expect(updates(tick(42.8, "2026-10-31T00:00:01Z"), tick(43.0, "2026-10-31T00:00:01Z"))).toEqual({
          image: false,
          toolTip: true,
        });
      });

      it("redraws the icon when indexing starts, an error appears, or the service stops", () => {
        const idle = state("loaded", true, status("ready"));
        expect(updates(idle, tick(10, "2026-10-31T00:00:01Z"))).toEqual({ image: true, toolTip: true });
        expect(updates(idle, state("loaded", true, status("error")))).toEqual({ image: true, toolTip: false });
        expect(updates(idle, state("notLoaded", true, status("ready")))).toEqual({ image: true, toolTip: true });
      });
    });
  });
});
