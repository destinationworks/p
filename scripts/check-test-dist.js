#!/usr/bin/env node

// Fail fast before ./test.sh when the checkout lacks the built workspace output that part of the
// suite loads at runtime: extensions resolve `@dst0/*` through node_modules to `packages/*/dist`, and
// the indexing reinstall tests spawn the built daemon. `./reinstall.sh` builds only the centralized
// runtime under ~/.p/install, never this checkout, so a fresh worktree has no `dist` until
// `npm run build` runs in it (as CI does).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_DIST_ENTRYPOINTS = [
  "packages/tui/dist/index.js",
  "packages/ai/dist/index.js",
  "packages/agent/dist/index.js",
  "packages/code-index/dist/index.js",
  "packages/coding-agent/dist/index.js",
  "packages/coding-agent/dist/indexing-service-daemon.js",
];

function distDirectory(entrypoint) {
  const parts = entrypoint.split("/");
  return parts.slice(0, parts.indexOf("dist") + 1).join("/");
}

export function findDistProblems(root = ROOT, entrypoints = REQUIRED_DIST_ENTRYPOINTS) {
  const problems = [];
  const reportedLinks = new Set();
  for (const entrypoint of entrypoints) {
    const directory = distDirectory(entrypoint);
    const details = fs.lstatSync(path.join(root, directory), { throwIfNoEntry: false });
    if (details?.isSymbolicLink()) {
      if (!reportedLinks.has(directory)) problems.push(`${directory} is a symlink`);
      reportedLinks.add(directory);
    } else if (!fs.statSync(path.join(root, entrypoint), { throwIfNoEntry: false })?.isFile()) {
      problems.push(`missing ${entrypoint}`);
    }
  }
  return problems;
}

export function distProblemMessage(problems, root = ROOT) {
  return [
    `This checkout has no usable workspace build output for ./test.sh (${root}):`,
    ...problems.map((problem) => `  ${problem}`),
    "Run `npm run build` in this checkout first, as CI does, and again after changing package sources.",
    "`./reinstall.sh` builds only the centralized runtime under ~/.p/install. Do not symlink its dist",
    "(daemon provenance rejects it) or copy it (it is the committed snapshot, not this checkout).",
  ].join("\n");
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : ROOT;
  const problems = findDistProblems(root);
  if (problems.length > 0) {
    console.error(distProblemMessage(problems, root));
    process.exitCode = 1;
  }
}
