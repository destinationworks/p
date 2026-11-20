import type { RepositoryServiceStatus } from "../src/core/indexing-service.ts";

// Every repository state the daemon can write to indexing-service-status.json, checked against
// RepositoryServiceStatus so tray tests cannot drift to state names the daemon never writes.

export type RepositoryServiceState = RepositoryServiceStatus["state"];

export const REPOSITORY_SERVICE_STATES = [
  "not_initialized",
  "initializing",
  "ready",
  "stale",
  "updating",
  "partial",
  "unavailable",
  "disabled",
  "queued",
  "error",
] as const satisfies readonly RepositoryServiceState[];

type UnlistedRepositoryServiceState = Exclude<RepositoryServiceState, (typeof REPOSITORY_SERVICE_STATES)[number]>;
type RequireNever<T extends never> = T;
/** Fails type-checking when RepositoryServiceStatus gains a state that the list above lacks. */
export type RepositoryServiceStatesAreExhaustive = RequireNever<UnlistedRepositoryServiceState>;

export type IndexingProgressPhase = NonNullable<RepositoryServiceStatus["progress"]>["phase"];

export const INDEXING_PROGRESS_PHASES = [
  "scanning",
  "preparing",
  "indexing",
  "finalizing",
] as const satisfies readonly IndexingProgressPhase[];

/** Fails type-checking when IndexingProgress gains a phase that the list above lacks. */
export type IndexingProgressPhasesAreExhaustive = RequireNever<
  Exclude<IndexingProgressPhase, (typeof INDEXING_PROGRESS_PHASES)[number]>
>;

/** The daemon sets these while a refresh runs (drain worker, progress updates, health-check repair). */
export const INDEXING_REPOSITORY_STATES: readonly RepositoryServiceState[] = ["initializing", "updating"];
