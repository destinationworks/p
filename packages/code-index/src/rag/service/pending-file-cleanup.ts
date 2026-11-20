import fs from "node:fs";
import path from "node:path";
import type { IndexManifest, RagVectorStore } from "../types.ts";
import { fileIdFor } from "./helpers.ts";

/**
 * Write-ahead record of repository paths whose stored chunks may not match the committed manifest.
 *
 * An in-place refresh upserts new file versions before it commits the manifest and deletes the old
 * versions only afterwards. Search hides every chunk whose file hash differs from the committed
 * manifest, so this record is needed only to reclaim those hidden chunks after a cancelled or failed
 * refresh, including a file that later reverts to its committed contents.
 */
const PENDING_FILE_CLEANUP_FILE = "pending-file-cleanup.json";
const PENDING_FILE_CLEANUP_VERSION = 1;

interface PendingFileCleanupRecord {
  version: typeof PENDING_FILE_CLEANUP_VERSION;
  paths: string[];
}

export function pendingFileCleanupPath(repositoryDirectory: string): string {
  return path.join(repositoryDirectory, PENDING_FILE_CLEANUP_FILE);
}

/**
 * Returns the recorded paths. A malformed record yields no paths: its hidden leftovers cannot be located
 * without a full scan, stay invisible to search, and are dropped by the next sparse generation copy.
 */
export function readPendingFileCleanup(repositoryDirectory: string): string[] {
  let contents: string;
  try {
    contents = fs.readFileSync(pendingFileCleanupPath(repositoryDirectory), "utf-8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    return [];
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Partial<PendingFileCleanupRecord>;
  if (record.version !== PENDING_FILE_CLEANUP_VERSION || !Array.isArray(record.paths)) return [];
  return record.paths.every((entry) => typeof entry === "string") ? record.paths : [];
}

/** Durably adds paths to the record before any of their new chunks reach the vector store. */
export function recordPendingFileCleanup(repositoryDirectory: string, paths: string[]): void {
  writePendingFileCleanup(repositoryDirectory, [...readPendingFileCleanup(repositoryDirectory), ...paths]);
}

function writePendingFileCleanup(repositoryDirectory: string, paths: string[]): void {
  const record: PendingFileCleanupRecord = { version: PENDING_FILE_CLEANUP_VERSION, paths: [...new Set(paths)].sort() };
  const recordPath = pendingFileCleanupPath(repositoryDirectory);
  const temporaryPath = `${recordPath}.${process.pid}.tmp`;
  try {
    const file = fs.openSync(temporaryPath, "w", 0o600);
    try {
      fs.writeFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
      fs.fsyncSync(file);
    } finally {
      fs.closeSync(file);
    }
    fs.renameSync(temporaryPath, recordPath);
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

/**
 * Deletes every stored version of the recorded paths that the committed manifest does not reference.
 * A failing path does not stop the others; failed paths, and paths skipped after an abort, stay recorded
 * so preemption is never delayed by a long cleanup. The first failure is rethrown after the record is updated.
 */
export async function purgePendingFileVersions(
  repositoryDirectory: string,
  vectorStore: RagVectorStore,
  manifest: IndexManifest,
  repoId: string,
  signal: AbortSignal,
): Promise<void> {
  if (!fs.existsSync(pendingFileCleanupPath(repositoryDirectory))) return;
  const remaining: string[] = [];
  let firstFailure: unknown;
  for (const filePath of readPendingFileCleanup(repositoryDirectory)) {
    if (signal.aborted) {
      remaining.push(filePath);
      continue;
    }
    const committedHash = manifest.files[filePath]?.hash;
    try {
      await vectorStore.deleteFileVersions(manifest.collection, repoId, fileIdFor(repoId, filePath), committedHash);
    } catch (error) {
      remaining.push(filePath);
      firstFailure ??= error;
    }
  }
  if (remaining.length === 0) discardPendingFileCleanup(repositoryDirectory);
  else writePendingFileCleanup(repositoryDirectory, remaining);
  if (firstFailure !== undefined) throw firstFailure;
}

/** Removes the record once its paths are purged or a new generation without leftovers has been committed. */
export function discardPendingFileCleanup(repositoryDirectory: string): void {
  try {
    fs.unlinkSync(pendingFileCleanupPath(repositoryDirectory));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}
