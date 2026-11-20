import fs from "node:fs";
import path from "node:path";
import { computeRepositoryId, getRepositoryRefreshLockState } from "@dst0/p-code-index";
import { readCurrentIndexedRepos } from "../indexed-repos.ts";
import { canonicalizePath } from "../workspace-root.ts";
import { isDirectory } from "./helpers.ts";

/**
 * An enabled registry entry with the code-rag directory id it indexes into now. The id is
 * undefined when the root is unreachable (its parent is missing too, as on an unmounted volume):
 * the current generation is then unknown, so every generation for that root stays protected.
 */
export interface LiveRepository {
  root: string;
  repositoryId: string | undefined;
}

export interface CollectionProtectionSnapshot {
  collections: Set<string>;
  refreshInProgress: boolean;
}

interface CollectionReference {
  collection: string;
  root: string | undefined;
  updatedAt: number | undefined;
}

interface RepositoryDirectoryReferences {
  repositoryId: string;
  manifest: CollectionReference | undefined;
  checkpoint: CollectionReference | undefined;
}

export function readLiveRepositories(agentDir: string): LiveRepository[] {
  const repositories: LiveRepository[] = [];
  for (const entry of readCurrentIndexedRepos(agentDir)) {
    if (entry.decision !== "enabled") continue;
    const root = canonicalizePath(entry.path);
    if (isDirectory(root)) repositories.push({ root, repositoryId: computeRepositoryId(root) });
    else if (!isDirectory(path.dirname(root))) repositories.push({ root, repositoryId: undefined });
  }
  return repositories;
}

/**
 * Protects the collections of each live repository's current code-rag directory. A directory
 * for the same root under an older id (the `origin` remote changed) stays protected until the
 * current directory has a committed manifest at least as recent as its own.
 */
export function readCollectionProtectionSnapshot(
  dataDirectory: string,
  liveRepositories: LiveRepository[],
): CollectionProtectionSnapshot {
  const directories = new Map<string, RepositoryDirectoryReferences>();
  let refreshInProgress = false;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dataDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error("Cannot safely enumerate persisted Qdrant collection references", { cause: error });
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const repositoryDirectory = path.join(dataDirectory, entry.name);
    if (getRepositoryRefreshLockState(repositoryDirectory) === "active") refreshInProgress = true;
    directories.set(entry.name, {
      repositoryId: entry.name,
      manifest: readCollectionReference(path.join(repositoryDirectory, "manifest.json")),
      checkpoint: readCollectionReference(path.join(repositoryDirectory, "rebuild-checkpoint.json")),
    });
  }

  const collections = new Set<string>();
  const protect = (directory: RepositoryDirectoryReferences) => {
    for (const reference of [directory.manifest, directory.checkpoint]) {
      if (reference) collections.add(reference.collection);
    }
  };
  for (const live of liveRepositories) {
    const current = live.repositoryId === undefined ? undefined : directories.get(live.repositoryId);
    if (current) protect(current);
    const committedAt = current?.manifest?.updatedAt;
    for (const directory of directories.values()) {
      if (directory === current || !referencesRoot(directory, live.root)) continue;
      const directoryUpdatedAt = directory.manifest?.updatedAt;
      const superseded =
        committedAt !== undefined &&
        directory.checkpoint === undefined &&
        directoryUpdatedAt !== undefined &&
        committedAt >= directoryUpdatedAt;
      if (!superseded) protect(directory);
    }
  }
  return { collections, refreshInProgress };
}

function referencesRoot(directory: RepositoryDirectoryReferences, root: string): boolean {
  return directory.manifest?.root === root || directory.checkpoint?.root === root;
}

function readCollectionReference(filePath: string): CollectionReference | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw new Error("Cannot safely read Qdrant collection reference", { cause: error });
  }
  try {
    const value = JSON.parse(contents) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Collection reference is not an object");
    }
    const { collection, root, updatedAt } = value as { collection?: unknown; root?: unknown; updatedAt?: unknown };
    if (typeof collection !== "string" || collection.length === 0) throw new Error("Collection name is missing");
    const updatedAtMs = typeof updatedAt === "string" ? Date.parse(updatedAt) : Number.NaN;
    return {
      collection,
      root: typeof root === "string" ? root : undefined,
      updatedAt: Number.isFinite(updatedAtMs) ? updatedAtMs : undefined,
    };
  } catch (error) {
    throw new Error("Cannot safely read Qdrant collection reference", { cause: error });
  }
}
