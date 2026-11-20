import { getGitInfo } from "../discover.ts";
import { hashText } from "./service/helpers.ts";

/**
 * Names the per-repository code-rag directory: a hash of the canonical workspace root and its
 * `origin` remote. A remote change therefore starts a new directory and leaves the previous one,
 * with its manifest and Qdrant collection, behind.
 */
export function computeRepositoryId(canonicalWorkspaceRoot: string): string {
  return hashText(`${canonicalWorkspaceRoot}\0${getGitInfo(canonicalWorkspaceRoot).remote}`);
}
