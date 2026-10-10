# 2026-10-10 — Production glob dependency inherited a high-severity advisory

- **Symptom:** `npm audit --omit=dev` reported `braces`, `micromatch`, and `fast-glob` through code-index file discovery. The original moderate `undici` and `shell-quote` findings also needed lockfile updates.
- **Cause:** `packages/code-index` directly depended on `fast-glob`; its transitive `micromatch` depended on vulnerable `braces`. A root `brace-expansion` override does not fix the separate `braces` package.
- **Fix:** Use pinned `tinyglobby` for production discovery, preserve the existing explicit exclusions and no-symlink traversal contract, and update the affected pinned HTTP and shell dependencies and lockfiles.
- **Verification:** `npm audit --omit=dev --json` reports zero production advisories after lockfile refresh. Focused discovery, full tests, build/reinstall, and CI remain pending.
- **Remaining scope:** The full development dependency audit still reports five high findings under `shx -> shelljs -> fast-glob -> micromatch -> braces`. Those are not in the production dependency tree and need a separate toolchain migration or reviewed exception; do not describe the full audit as clean.
