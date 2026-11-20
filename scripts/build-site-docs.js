#!/usr/bin/env node

// Generates the tracked packages/site/src/docsData.json from packages/coding-agent/docs (docs.json
// plus every top-level *.md). `--check` regenerates it in memory instead and fails, naming the drifted
// docs, when the file on disk differs. CI runs the check before `npm run build`, because the build
// rewrites the file and a later comparison would only compare it with itself.
//
// Usage: node scripts/build-site-docs.js [--check] [repository root]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const DOCS_DIR = "packages/coding-agent/docs";
export const DOCS_DATA_PATH = "packages/site/src/docsData.json";
export const REGENERATE_COMMAND = "node scripts/build-site-docs.js";

export function buildDocsData(docsDir) {
  const docsConfig = JSON.parse(fs.readFileSync(path.join(docsDir, "docs.json"), "utf-8"));
  const files = {};
  // Sorted explicitly so the output does not depend on the platform's directory order.
  for (const file of fs
    .readdirSync(docsDir)
    .filter((name) => name.endsWith(".md") && fs.statSync(path.join(docsDir, name)).isFile())
    .sort()) {
    files[file] = fs.readFileSync(path.join(docsDir, file), "utf-8");
  }
  return { navigation: docsConfig.navigation, redirects: docsConfig.redirects || [], files };
}

export function serializeDocsData(docsData) {
  return JSON.stringify(docsData, null, 2);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Compares freshly generated docs data with the committed file's text (undefined when it is absent).
 * Returns one line per problem, naming each drifted doc; an empty list means the file is current.
 */
export function findDocsDataDrift(expected, committedText) {
  if (committedText === undefined) return [`${DOCS_DATA_PATH} does not exist`];
  if (committedText === serializeDocsData(expected)) return [];

  let committed;
  try {
    committed = JSON.parse(committedText);
  } catch (error) {
    return [`${DOCS_DATA_PATH} is not valid JSON (${error.message})`];
  }

  const problems = [];
  const committedFiles = isRecord(committed?.files) ? committed.files : {};
  for (const [file, content] of Object.entries(expected.files)) {
    if (!Object.hasOwn(committedFiles, file)) problems.push(`${DOCS_DIR}/${file} is new (not in docsData.json)`);
    else if (committedFiles[file] !== content) problems.push(`${DOCS_DIR}/${file} changed`);
  }
  for (const file of Object.keys(committedFiles)) {
    if (!Object.hasOwn(expected.files, file)) problems.push(`${DOCS_DIR}/${file} was removed (still in docsData.json)`);
  }
  for (const field of ["navigation", "redirects"]) {
    if (!isDeepStrictEqual(committed?.[field], expected[field])) problems.push(`${DOCS_DIR}/docs.json ${field} changed`);
  }
  if (problems.length === 0) {
    problems.push("its formatting, key order, or extra fields differ from the generator output");
  }
  return problems;
}

export function docsDataDriftMessage(problems) {
  return [
    `${DOCS_DATA_PATH} is out of date with ${DOCS_DIR}:`,
    ...problems.map((problem) => `  ${problem}`),
    `Run \`${REGENERATE_COMMAND}\` and commit ${DOCS_DATA_PATH}.`,
  ].join("\n");
}

function readIfPresent(file) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
}

function parseArguments(args) {
  const roots = args.filter((arg) => !arg.startsWith("-"));
  const unknown = args.filter((arg) => arg.startsWith("-") && arg !== "--check");
  if (unknown.length > 0 || roots.length > 1) {
    throw new Error(`Unexpected arguments: ${[...unknown, ...roots.slice(1)].join(" ")}`);
  }
  return { check: args.includes("--check"), root: roots[0] ? path.resolve(roots[0]) : ROOT };
}

/** Runs the generator or the check and returns the process exit code. */
export function runBuildSiteDocs(args) {
  let options;
  try {
    options = parseArguments(args);
  } catch (error) {
    console.error(`${error.message}\nUsage: ${REGENERATE_COMMAND} [--check] [repository root]`);
    return 1;
  }

  const docsDir = path.join(options.root, DOCS_DIR);
  const outputPath = path.join(options.root, DOCS_DATA_PATH);
  if (!fs.existsSync(path.join(docsDir, "docs.json"))) {
    console.error("docs.json not found at", path.join(docsDir, "docs.json"));
    return 1;
  }

  const docsData = buildDocsData(docsDir);
  if (options.check) {
    const problems = findDocsDataDrift(docsData, readIfPresent(outputPath));
    if (problems.length > 0) {
      console.error(docsDataDriftMessage(problems));
      return 1;
    }
    console.log(`${DOCS_DATA_PATH} is up to date with ${Object.keys(docsData.files).length} docs.`);
    return 0;
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serializeDocsData(docsData), "utf-8");
  console.log(`Successfully generated docsData.json with ${Object.keys(docsData.files).length} files.`);
  return 0;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runBuildSiteDocs(process.argv.slice(2));
}
