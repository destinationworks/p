import type { IndexingTrayService } from "./indexing-tray-manager.ts";

/** Tray service for daemons that must not show a tray, such as library and test daemons. */
export const NO_INDEXING_TRAY: IndexingTrayService = {
  start: () => false,
  stop: () => {},
  isRunning: () => false,
};
