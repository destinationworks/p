import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { valid, validRange } from "semver";
import type { PathMetadata } from "./types.ts";

export function getEnv(): NodeJS.ProcessEnv {
  if (process.platform !== "linux" || Object.keys(process.env).length > 0) {
    return process.env;
  }
  try {
    const data = readFileSync("/proc/self/environ", "utf-8");
    const env: NodeJS.ProcessEnv = {};
    for (const entry of data.split("\0")) {
      const idx = entry.indexOf("=");
      if (idx > 0) {
        env[entry.slice(0, idx)] = entry.slice(idx + 1);
      }
    }
    return env;
  } catch {
    return process.env;
  }
}

export function isOfflineModeEnabled(): boolean {
  const value = process.env.P_OFFLINE;
  if (!value) return false;
  return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

export function isExactNpmVersion(version: string | undefined): boolean {
  return valid(version ?? "") !== null;
}

export function getNpmVersionRange(version: string | undefined): string | undefined {
  return version ? (validRange(version) ?? undefined) : undefined;
}

export function resourcePrecedenceRank(m: PathMetadata): number {
  if (m.origin === "package") return 4;
  const scopeBase = m.scope === "project" ? 0 : 2;
  return scopeBase + (m.source === "local" ? 0 : 1);
}

export function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

export function getHomeDir(): string {
  return process.env.HOME || homedir();
}

export function getExtensionTempFolder(agentDir: string): string {
  const tempFolder = join(agentDir, "tmp", "extensions");
  mkdirSync(tempFolder, { recursive: true, mode: 0o700 });
  chmodSync(tempFolder, 0o700);
  return tempFolder;
}

export function isPattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-") || s.includes("*") || s.includes("?");
}

export function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

export function hasGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

export function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
  const plain: string[] = [];
  const patterns: string[] = [];
  for (const entry of entries) {
    if (isPattern(entry)) {
      patterns.push(entry);
    } else {
      plain.push(entry);
    }
  }
  return { plain, patterns };
}
