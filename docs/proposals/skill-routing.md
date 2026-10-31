# Proposal: per-turn skill routing (`<skill_routes>`)

- **Status:** Proposed — not implemented. Recorded on 2026-10-31 as a potential improvement; the owner deferred implementation.
- **Default if built:** off (`skillRouting: "off"`) until a paired benchmark A/B (`auto` vs `off`) on an open-weights model shows no quality loss and at most +2% tokens (§4.6).
- **Origin:** investigation of closed PR #90 (`feat/universal-testing-skills`, head `f896a4d0e`) and its later SkillGraph prototype patch, against `main` at `2a4d910bc` (#184). The prototype's SkillGraph never routed anything, so nothing from it is ported; this document describes a fresh design on current `main`.
- **Summary:** a deterministic per-turn router picks 1 (LIGHT) to 3 (STRICT) links to specific skill documents from the user's request and places them in the hidden runtime-context message next to that request, the same way `<project_rule_routes>` already works for rules. Cost: 0 tokens when nothing matches, about 80–180 tokens when something does; the system prompt and its cache prefix do not change. A prototype on 204 real skill documents routed a vitest request to `vitest/default-v4.md` and "What is 2+2?" to nothing, but also produced noise, so the threshold must be tuned on a fixed prompt set. Estimated size: about 15 new files, tests, and the `skillRouting` setting.

## 0. TL;DR

- **The #90 and prototype SkillGraph never routed anything.** It was an in-memory index that `skills.ts` exported. No tool, prompt, session hook, or test called it on real files. The prototype patch is byte-identical to #90's `skill-graph/` directory. Its title, facet, and query logic has defects that show up on main's own skill tree (§1.4).
- **Main already has the plumbing that SkillGraph lacked:**
  - `list_skills` and `read_skills` give traversal-safe virtual links.
  - Rules already get per-turn deterministic routing: `<project_rule_routes>` is written into a hidden runtime-context message that is cache-stable.
  - LIGHT and STRICT tiers are decided before the turn context is built.
- **The real gap on main.** With default `compiled` delivery, the model sees **no skill names at all**, only a pointer to `list_skills`. Small open-weights models rarely call a discovery tool on their own. `legacy` mode has the opposite problem: it pays for the full XML catalog on every request (about 11.7K chars for the owner's 26 skills).
- **Recommendation (Option B).** Re-implement SkillGraph as a bounded index built from the compiled skill records. A deterministic per-turn router writes at most 1 (LIGHT) or 3 (STRICT) candidate `skills/...` virtual links into the existing runtime-context message as `<skill_routes>`.
  - Cost: 0 tokens on unmatched turns, about 100–150 tokens on matched turns.
  - The system prompt does not change, so the KV-cache prefix stays intact.
  - It routes straight to leaf docs, which saves one or two tool round trips.
  - Do **not** cherry-pick `0a0804265`.
  - Setting `skillRouting: "auto" | "off"`; ship `"auto"` as the default only if the paired benchmark A/B passes (§4.6), otherwise `"off"`.

---

## 1. What SkillGraph did in #90 and the prototype

### 1.1 Provenance

| Commit (PR #90) | What it did | Relevance |
| --- | --- | --- |
| `c5f2d10f9` | Software-testing skill tree. Split `skills.ts` into `src/core/skills/{discovery,formatting,types}.ts`. Added `getBundledSkillsDir`, `scripts/sync-bundled-skills.js`, and system-prompt helpers | Source of the `skills.ts` cherry-pick conflict (§2.6) |
| `338c16daa` | Ignore discovery: escaped `\#`/`\!` handling and `toPosixPath` | Independent bug fix (§5) |
| `593c6e464`, `09b1ec5a4` | Load bundled skills (precedence project > user > bundled) | Bundled tree is dormant on main (§2.1) |
| `9a5fb6c72`, `2ad5a0ff7` | TDD rule bloat, then the lean universal prompt | §5 |
| `0a0804265` | Multi-tier skill-tree markdown plus `src/core/skills/skill-graph/*` (6 files, 529 lines) and `test/skill-graph.test.ts` | The SkillGraph |
| `399026bb4` | Learnings store, distiller, tools, `/memory` | Already on main (identical `src/core/learnings/`) |
| `02d892786`, `0ce39b5dc` | Dynamic execution modes, finish_work token relax | §5 |

The prototype patch has 7 new files, 639 lines. Every blob id matches `0a0804265` and `f896a4d0e`:

| File | Blob |
| --- | --- |
| `index.ts` | `f33f9c15b` |
| `skill-graph-builder.ts` | `435366a41` |
| `skill-graph-query.ts` | `ca0cfd108` |
| `skill-node.ts` | `7d9d00897` |
| `skillgraph.ts` | `7cc172762` |
| `types.ts` | `1cc105511` |
| `test/skill-graph.test.ts` | `69c45ef97` |

The patch is #90's module without the one-line `export *` in `skills.ts`. The skill-tree markdown and learnings landed on main through the unrelated bulk commit `8be4e198d` ("Implement event-sourced inventory engine"). Main's tree has since grown: 50 files differ from #90, +3233 lines.

### 1.2 Data model (`0a0804265:packages/coding-agent/src/core/skills/skill-graph/`)

- **`types.ts`**
  - `SkillNodeType` = `skill | protocol | language | framework | version | domain | reference`.
  - `SkillEdgeType` = `contains | specializes | version_of | references | depends_on`.
  - `SkillGraphMetadata` = `{language, framework, version, isDefaultVersion, tags, triggers}`.
  - `SkillQueryCriteria` = `{language, framework, version, topics, queryText, types, limit}`.
  - `SkillGraphMatch` = `{node, score, matchedReasons}`.
- **`skill-node.ts`**: `SkillGraphNode` class with de-duplicated outgoing and incoming edge lists.
- **`skill-graph-builder.ts`**
  - It takes `Skill[]` from `skills.ts`. Each `Skill` becomes a root node. The builder then synchronously walks the whole skill directory with `statSync`, which follows symlinks.
  - Every `.md` except `SKILL.md` becomes a node.
    - Its type is inferred from path prefixes (`languages/`, `frameworks/`, `protocols/`, `domains/`).
    - Language, framework, and version come from **substring** checks on the path (`includes("rust")`, `includes("go")`, `/v(\d+(\.\d+)?)/`).
    - `isDefaultVersion` comes from `default` or `modern` in the path.
  - Edges:
    - A `contains` edge always runs from the **root** to the doc, so the graph is a flat star.
    - `references` edges come from markdown links matched by `filePath.endsWith(target)`. This is O(N²), and every file is read a second time.
  - The `specializes`, `version_of`, and `depends_on` edge types are declared but never produced.
- **`skill-graph-query.ts`**: a linear scan with additive weights.

  | Criterion | Score |
  | --- | --- |
  | Language match | +30 |
  | Language mismatch | −20 |
  | Framework | +40 |
  | Version | +25, or +10 for a default fallback |
  | `queryText` **whole-string substring** of title / id / description | 30 / 20 / 15 |
  | Each topic-tag substring | +15 |

  It also has `traverse()` (BFS, depth 2), which nothing calls.
- **`skillgraph.ts`**: a facade with `build`, `query`, `findBestPlaybook({language, framework, topic})` (limit 1), and `toMermaid()`.

### 1.3 When the model sees what (prompt and token impact)

**Never.** The only integration is `export * from "./skills/skill-graph/index.ts"` in `skills.ts` (`git show 0a0804265 -- packages/coding-agent/src/core/skills.ts`). `git grep SkillGraph f896a4d0e` finds no consumer outside the module and its test.

In #90, the model saw skills only through:
- the `formatSkillsForPrompt` XML catalog: name, description, and location for every skill, on every request;
- a guideline that told it to consult the software-testing skill (`2ad5a0ff7`).

So SkillGraph's measured prompt and token impact was zero. Its *intended* value was never exercised. The test is vacuous: its fake `/fake/skills/...` paths do not exist, so the directory walk returns early. Only root nodes are ever built, and nothing below the root is indexed.

### 1.4 Defects found by running the prototype on main's tree (local probes, not committed)

Bundled tree: 9 roots → 97 nodes. All dirs: 35 roots → 184 nodes, 104–129 ms warm synchronous build.

1. **Titles are never parsed.** The code sets `let title = name;` and then checks `if (!title && …)`, so 0 of 88 docs get their heading. Every title is the file name.
2. **Nested `SKILL.md` routers are skipped** (`entry !== "SKILL.md"`). Examples are `languages/typescript/SKILL.md` and `api-and-database/SKILL.md`. These are the nodes with the best frontmatter metadata, and 0 of them are indexed.
3. **Substring facets give false positives.** `architecture-and-refactoring/input-validation/sanitization-and-trust-boundaries.md` is tagged `language: rust` because "t**rust**" contains "rust". `includes("go")` would hit names like mongo, algorithm, or category.
4. **Type inference order is wrong.** The check `startsWith("languages/")` runs first, so `languages/typescript/vitest/*.md` is typed `language`, not `framework`.
5. **Natural prompts never match.** `queryText` must be a substring of a title, id, or description. On a real prompt ("Add vitest tests for the retry backoff in src/queue.ts"), both the queryText and topics paths return `[]`. Only one-word queries work.
6. **Cross-references fail on the bundled tree.** 68 of its 97 doc links are `file:///packages/coding-agent/skills/...` (repo-absolute) and never resolve. Only 1 `references` edge was built for that tree, and 28 across all dirs.
7. **No bounds.** There is no cap on nodes, bytes, or depth. Symlinks are followed. Every byte of every file is read twice.
8. **Not part of compiled delivery.** `Skill.filePath` is a physical path. The graph has no notion of the `skills/<id>/…` virtual namespace, the freshness hashes, or the traversal checks that main's `read_skills` enforces.

The idea behind SkillGraph was sound: a multi-tier tree, version-aware selection, and routing to the leaf. The implementation is not portable as written.

---

## 2. What current main does for skills

### 2.1 Discovery

- **Locations.** `package-manager/defaultpackagemanager-methods/lockfile-analysis.ts:55-198` collects:
  - user `~/.p/agent/skills`;
  - user `~/.agents/skills`;
  - project `.p/skills`;
  - ancestor `.agents/skills`, only when the project is trusted;
  - plus settings `skills`, packages, and `--skill`.
- **Loading.** `skills.ts` (487-line legacy monolith, baselined at `scripts/file-structure-baseline.json:346`) runs `loadSkills`. It applies ignore rules, validates frontmatter, and resolves name collisions. Each `Skill` holds name, description, filePath, baseDir, sourceInfo, and disableModelInvocation.
- **Nested routers.** Discovery stops at the first `SKILL.md` in a directory (`skills.ts:194-221`). Nested `SKILL.md` files are resources of the parent skill, not separate skills. That fits a graph of sub-skills well.
- **Single-file skills.** Root `.md` files in `~/.p/agent/skills` and `.p/skills` are single-file skills, and their `baseDir` is the skills directory itself.
- **The bundled tree is dormant.** `packages/coding-agent/skills/` has 9 roots and 110 md files (284 KB). It is on main, but:
  - nothing loads it (`config.ts` has no `getBundledSkillsDir`);
  - it is not in the `package.json` `files`;
  - its routers use 68 `file:///packages/...` links that `read_skills` cannot follow.
- **Measured (`measure-skills.cjs`).**

  | Location | Roots | Description chars | Legacy XML chars | `.md` files |
  | --- | --- | --- | --- | --- |
  | `~/.agents/skills` | 22 | 6,077 | 9,656 | 70 (371 KB) |
  | `~/.p/agent/skills` | 4 | 1,406 | 2,086 | 24 (257 KB) |

### 2.2 Delivery

The mode comes from `projectInstructionMode` (`compiled`, the default; `legacy`; or `off`). It is resolved per prompt in `agent-session/project-instruction-fallback-delivery.ts`.

**`compiled` (the default)**
- **Skill records.** `project-instructions/content.ts:89-111` `buildSkillRecords` turns skills into records with:
  - `id = <slug>-<sha256(realpath)[0:8]>`;
  - virtual `link = skills/<id>/SKILL.md`;
  - the realpath'd `filePath`/`baseDir` and `rootHash`;
  - the requirement that the skill root sits directly in `baseDir`.

  Records are part of `inputHash` (`content.ts:29-50`). Skill changes re-render the version directory without an LLM recompile, because the compilation cache is keyed on `agentsHash` (`compilation-cache.ts`).
- **Catalog.** `prompt.ts:120-135` `renderSkillsCatalog` writes `skills/catalog.md` into the version directory, paginated at 128 KB.
- **System prompt.** It gets only two guidance lines (`prompt.ts:39-40`). `selectProjectInstructionPromptForTools` (`prompt.ts:42-55`) strips them when the tools are inactive. **No skill names reach the prompt.**
- **`list_skills`** (`tools/list-skills.ts`):
  - pages of 10 roots;
  - lexical scoring on name and description;
  - HMAC cursors bound to `inputHash` and the query hash;
  - path redaction;
  - a 32 KB result cap.
- **`read_skills`** (`tools/read-skills.ts` → `project-instructions/reader.ts:32-45,108-126`):
  - up to 32 links per call;
  - the catalog, its pages, and each `SKILL.md` are hash-checked;
  - sub-resources under the skill prefix are read live, with logical-link validation, a realpath containment check, and regular files only;
  - a 512 KB limit per call;
  - `requireFreshPreparedState` re-hashes sources and skill roots on every call.
- **Tool activation.** Both tools are registered and active only in compiled mode (`agent-session/agentsession-methods/runtime-build.ts:75-82,145`; `sdk-tool-policy.ts:36`). They are **not** in `LIGHT_DEFERRED_TOOL_NAMES` (`task-verification/task-tier.ts:35`), so they stay active in LIGHT.

**`legacy`**
- `system-prompt.ts:229-231` appends the full `<available_skills>` XML (name, description, physical location) to every request.
- Its guidance says to use the `read` tool.

**`off`**: no instructions and no skill tools.

### 2.3 Per-turn routing already exists, for rules

- **Router.** `project-instructions/routing.ts:108-145` `selectProjectInstructionRuleLinks` is a deterministic lexical router:
  - tokenizer with aliases and stopwords;
  - IDF-like trigger-frequency filter;
  - work-phase fallback;
  - up to 3 links;
  - exact link or id mention wins.
- **Rendering.** `renderProjectInstructionTurnContext` renders `<project_rule_routes>`.
- **Session wiring.**
  - `agentsession-methods/prompt-context.ts:35-68,87-123` builds it as part of `turnContextPrompt`.
  - `user-messaging.ts:152-163` persists it as a hidden `RUNTIME_CONTEXT_PROMPT_CUSTOM_TYPE` message next to the user message, so later turns replay a byte-identical prefix (the comment at `prompt-context.ts:112-113`).
  - `project-instruction-integrity.ts:13-24` strips that tag when replaying into legacy/off and from compaction summaries.
- **This is exactly the delivery channel SkillGraph never had.**

### 2.4 Tiers

- `task-tier.ts:154-168`: for a new prompt, `initialVerificationTier` sets STRICT for code-changing task kinds that require an effect, and LIGHT otherwise.
- `user-messaging.ts:98` (`beginVerificationTierPrompt`) runs **before** the turn context is built at `user-messaging.ts:152`. So `isLightTierActive(self)` already reflects the current prompt when routes are computed.
- #152 (`055120ecc`) added the LIGHT deferral pattern: a compact capped catalog (`system-prompt/deferred-tools-catalog.ts`, 600 chars, names-only overflow).

### 2.5 Other

- **Learnings.** `system-prompt.ts:83-84` puts `LearningsStore.formatForPrompt(5)` into every system prompt.
- **`/skill:name` expansion.** `thinking-level.ts:50` builds a `<skill name="…" location="…">` block and `message-utils.ts:13` parses it. The routing query must not be the expanded text (§4.5).
- **Stale docs.** `docs/skills.md` "How Skills Work" still describes the legacy XML flow, which does not match the compiled default.

### 2.6 Why the cherry-pick conflicts

Trial `git cherry-pick --no-commit 0a0804265` on `2a4d910bc` (in the throwaway worktree, then discarded):

- `UU packages/coding-agent/src/core/skills.ts`
- `UU packages/coding-agent/skills/software-testing/SKILL.md`
- `AA .../type-systems/typescript/contract-fidelity.md`
- `AA .../idempotency/command-key-registry.md`

Root causes:

- **`skills.ts`.** The diff's context is #90's *facade* `skills.ts`, created in `c5f2d10f9`. That facade imports `getBundledSkillsDir`, `./skills/discovery.ts`, and `./skills/types.ts`, none of which exist on main. Main kept the monolith and changed it independently (`4d8ceb5ae` #100, `9174df09e`). The one-line `export *` has no matching context.
- **Markdown.** `8be4e198d` added the same files independently, with different content. That causes the add/add conflicts, and main's `software-testing/SKILL.md` has diverged too.
- **Semantic conflict, even after a mechanical resolution.**
  - The builder consumes physical `Skill[]` and reads arbitrary paths, which bypasses the compiled virtual-link namespace and its freshness and traversal guarantees.
  - It would also need the #90 directory split, which AGENTS.md treats as a separate behaviour-preserving refactor.

Conclusion: re-implement on top of `ProjectInstructionSkillRecord`. Leave `skills.ts` untouched.

---

## 3. Options

Common to all options: the index source is `prepared.manifest.skills`, which has virtual links, realpath'd `baseDir`, and the `disableModelInvocation` filter already applied. It covers every skill location (`~/.agents/skills`, `.p/skills`, `~/.p/agent/skills`, `.agents/skills`, settings, packages) without migration.

### Option A: pull only (graph behind `list_skills` / `read_skills`)

`list_skills` ranks roots by `max(root score, best descendant score)` and returns an optional `entry` (best matching doc link). `read_skills` is unchanged.

- **Tokens.** 0 static change. Each use costs one `list_skills` round trip, its result (about 0.5–2 KB), and then `read_skills`.
- **Latency.** At least 2 model turns per use. On local models, each turn costs several seconds of prefill and decode.
- **Determinism.** High. Cursors stay bound to `inputHash`.
- **Small-model robustness.** Poor. It relies on spontaneous discovery calls, which is the failure mode today.
- **Test surface.** Small (`list-skills` tests).

### Option B: per-turn push routing (graph-backed `<skill_routes>` in the runtime-context message) — recommended

- **Tokens.** 0 on unmatched turns. On matched turns, at most 3 links (STRICT) or 1 link (LIGHT), about 300–700 chars (≈80–180 tokens). Routes are persisted with the user message, so the prefix cache is stable. The system prompt is unchanged, so there is no prefix invalidation.
- **Latency.** Saves the discovery turn. Routing straight to a leaf (for example the 2.0 KB `vitest/default-v4.md` instead of the 6.0 KB `software-testing/SKILL.md` → 1.8 KB TS router → leaf) saves one or two `read_skills` hops. The router is O(nodes × query terms), well under 1 ms for about 200 nodes. The index is built lazily on the first routed prompt, off the startup path, so #153's startup deadline is untouched.
- **Determinism.** A pure function of (index, query, workspace terms, seen links, tier), with link tie-breaks.
- **Small-model robustness.** Best. The model gets exact copyable links and the hint that one call accepts several.
- **Test surface.** Medium. The new modules are pure functions plus one session integration.
- **Risk.** Noisy routes waste a read. Mitigations are thresholds, tier caps, a golden negative corpus, and the off switch.

### Option C: static precomputed tree outline in the system prompt (tier-aware)

A capped compact outline in the system prompt, in the style of #152's deferred-tools catalog: `skill › sub-skill — 60-char summary`, about 800 chars, STRICT only.

- **Tokens.** About 200 tokens on every STRICT request. It grows with skills and gets truncated, and the owner already has 26 roots.
- **KV.** Static per tier. It changes on escalation, which already happens because the guidelines differ by tier.
- **Robustness.** Medium. It is a menu without per-task selection, and long menus degrade small models.
- **Test surface.** Small.
- **Role.** Useful only as a fallback for "nothing routed" turns. It is not the primary mechanism.

### Rejected variants

- **Inline the top doc's content into the turn.** Saves one more round trip, but costs about 500+ tokens per matched turn and puts unreviewed content in context when a route is wrong. It may be revisited as a measured experiment.
- **LLM or embedding-based routing.** Adds a model call or the indexing daemon to the prompt critical path, is non-deterministic, and hurts latency on local models.
- **Folding sub-doc hashes into `inputHash`.** Any edit to a skill doc would invalidate the version directory and make `read_skills` report "stale, reload". That is disruptive for little gain, because sub-resources are already read live.

### Summary

| Criterion | A pull | **B push routes** | C static outline |
| --- | --- | --- | --- |
| Tokens per request | 0 static, plus 2 extra turns per use | 0 unmatched, about 80–180 matched | about 200 every STRICT request |
| Latency | +2 model turns | −1 to −2 turns | 0 |
| Determinism | high | high | high |
| Small-model robustness | poor | good | medium |
| KV-cache impact | none | none (persisted turn message) | tier-switch only |
| Test surface | S | M | S |
| Skill-dir migration | none | none | none |

---

## 4. Recommended design (Option B, with A as phase 2)

### 4.1 Data flow

```
ResourceLoader.getSkills() ──> prepareProjectInstructions ──> manifest.skills (virtual links, realpaths)
                                                                  │  (unchanged; skills.ts untouched)
first prompt in compiled mode ──> session._skillGraphCache?.inputHash === manifest.inputHash ? reuse
                                   : buildSkillGraphIndex(manifest.skills)   (bounded scan; lazily)
user prompt ─ beginVerificationTierPrompt (tier known) ─> do__createRuntimeContextPrompts
   ├─ createProjectRuleTurnContext (existing <project_rule_routes>)
   └─ createSkillRouteTurnContext:
        guards: skillRouting!=="off" && delivery==="compiled" && active tools ∋ read_skills
        query  = raw user text (for /skill: expansions: args only, invoked skill root excluded)
        seen   = links routed or read_skills'd since last compaction (branch history)
        wterms = workspace terms (package.json deps, Cargo.toml, pyproject, go.mod), weak bonus only
        routes = selectSkillRoutes(index, {query, wterms, seen, tier})
        prompt = renderSkillRoutePrompt(routes)  ──> appended to turnContextPrompt after rules
user-messaging ──> hidden runtime-context message { content, details.skillRouteLinks }
model ──> read_skills(links: [...]) (existing tool, existing safety)
```

### 4.2 Index model (new, replaces #90's)

```ts
type SkillGraphNodeKind = "root" | "sub-skill" | "doc";
interface SkillGraphNode {
  link: string;          // skills/<id>/<posix rel path>; always under the record's read_skills prefix
  rootLink: string;      // skills/<id>/SKILL.md
  skillName: string;
  parentLink?: string;   // nearest ancestor SKILL.md (contains) within the skill
  kind: SkillGraphNodeKind;
  depth: number;
  title: string;         // first ATX heading after frontmatter; frontmatter name for sub-skills; record.name for root
  summary: string;       // ≤160 chars: frontmatter description, else first prose line
  pathTerms: readonly string[]; // tokenized dir + file segments (+ frontmatter name)
  textTerms: readonly string[]; // tokenized title + summary
  versionRole: "default" | "compat" | "plain"; // segment tokens default|modern|latest vs compat|legacy|deprecated
}
interface SkillGraphIndex {
  inputHash: string;
  nodes: readonly SkillGraphNode[];                 // sorted by link
  referencedBy: ReadonlyMap<string, readonly string[]>; // doc link -> router links (relative md links in SKILL.md files)
  documentFrequency: ReadonlyMap<string, number>;
  truncated: boolean;
}
```

Build rules:

- **Source.** One pass over `manifest.skills`.
  - If `basename(filePath) !== "SKILL.md"` (a single-file skill whose `baseDir` is a whole skills directory), add the root node only and **never scan**.
  - Otherwise scan `realpath(baseDir)`.
- **Scan.**
  - Use `lstat` and skip symlinks, dot entries, and `node_modules`.
  - Reject names containing `\` or control characters.
  - Depth ≤ 6; `.md` only.
  - Caps: 128 docs per skill and 512 globally. Hitting a cap sets `truncated`, which raises one diagnostic per session.
- **Reads.**
  - Docs: the first 4 KiB via `openSync`/`readSync`, never the whole file.
  - Nested and root `SKILL.md` routers: up to 64 KiB, to extract relative markdown links.
  - Frontmatter is parsed with the existing `utils/frontmatter.ts`. Do not re-implement YAML parsing; #179 just fixed unquoted colons there.
- **Facets.**
  - No substring guessing: terms come only from tokenized path segments and text. This fixes #1.4 items 3 and 4. Version roles come from **segment tokens**.
- **Edges.**
  - Each node has a `parentLink`: the nearest ancestor `SKILL.md`.
  - `referencedBy` keeps only relative links (`./`, `x/y.md`, `../`) that resolve, as posix paths, *inside the same skill prefix*.
  - `file:`, absolute, `http(s):`, and escaping links are ignored. This makes the bundled tree's `file:///` links inert until phase 3 fixes them.
- **Not built.** `specializes`, `version_of`, `depends_on`, `traverse`, and `toMermaid` have no consumer, and AGENTS.md says to delete dead code.

### 4.3 Router (deterministic)

- **Tokenizer.** Reuse the rules router's tokenizer: NFKC, lowercase, aliases (`tests→test`, …), and stopwords. Move `tokenize`, `ROUTING_TOKEN_ALIASES`, and `ROUTING_STOP_WORDS` from `routing.ts` (273 lines) into `routing-terms.ts`. This is a behaviour-preserving split, guarded by the existing rule-routing tests, and adds a small skill-specific stopword set (`skill`, `md`, `references`, `docs`, `guide`).
- **Exact mentions win.** A skill name as a token sequence, `skill:<name>`, or a node link in the query forces that node, mirroring `routing.ts:208-210`.
- **Score per node.**

  ```
  own = Σ_{t∈q} (pathTerms∋t ? 3·idf(t) : textTerms∋t ? 1.5·idf(t) : 0)
  ```

  - `hits` is the number of distinct query terms matched.
  - Workspace terms add `Σ 0.75·idf(t)` over `pathTerms`, and only when `hits ≥ 1`. They are never sufficient alone.
  - Propagation: `effective = own + 0.35·max(own of parent chain ∪ referencing routers)`.
  - Version: `default` +0.5. `compat` −1, unless the query contains a version token (`v\d+` or a bare major number).
- **Gate.**
  - Require `hits ≥ 2`, or `hits ≥ 1` on a path term with `idf ≥ ln(N/3)` (a rare, specific term).
  - Require `effective ≥ MIN_SCORE`: STRICT 6, LIGHT 9.
  - Constants live in `skill-graph-limits.ts` and are calibrated by the golden corpus test (§4.6).
- **Select.**
  - Sort by effective score (desc), then depth (desc), then link (asc).
  - Greedily take up to 3 routes in STRICT and 1 in LIGHT.
  - Skip a candidate when:
    - an ancestor or descendant of it is already picked;
    - a sibling in the same directory is already picked (one version per directory);
    - its link is in `seen`.
- **Feasibility probe** (local, not committed; simplified scoring, owner's real dirs, 204 nodes):

  | Prompt | Routes |
  | --- | --- |
  | "Add vitest tests for the retry backoff…" | → `vitest/default-v4.md` first. The compat sibling scored second, which the per-directory rule removes. |
  | "write proptest invariants for the rust parser" | → `rust/proptest-invariants.md` |
  | "fix flaky race condition in the saga orchestrator compensation step" | → `compensation/reverse-rollback.md`, `race-condition-barriers.md` |
  | "What is 2+2?" | → `[]` |
  | "rename the variable foo to bar in utils.py" | → 2 noise routes at the floor. This shows why the `hits ≥ 2` gate and the LIGHT threshold are needed. |
  | "create a jira ticket…" | → `twg-jira` tied with `twg-jira-resolve-merged-work`. Needs the exact-name and shorter-name tie-break. |

### 4.4 Rendering

```
<skill_routes>
Optional skill docs for this request; read_skills accepts several links in one call.
- `skills/software-testing-1a2b3c4d/languages/typescript/vitest/default-v4.md`: Vitest v4+ Modern Test Engineering (Default) [software-testing; entry `skills/software-testing-1a2b3c4d/SKILL.md`]
</skill_routes>
```

- The entry (root) link is shown once per skill, and only when the root itself is not routed or seen. Titles are single-line, ≤100 chars, with `<`, `>`, and backticks escaped.
- Physical paths are redacted with the `list_skills` redaction. Move `boundedSingleLine` and its patterns from `list-skills.ts` into a shared `project-instructions/skill-text.ts`.
- The block is capped at 700 chars. Lines that do not fit are dropped, never truncated mid-link.
- The cap is separate from the 4,996-char instruction envelope, because routes are not instruction content.

### 4.5 Files (each ≤300 lines, one runtime entity per file, erasable TS only, top-level imports only)

New, in `packages/coding-agent/src/core/project-instructions/`:

| File | ≈Lines | Responsibility |
| --- | --- | --- |
| `routing-terms.ts` | 110 | Tokenizer, aliases, and stopwords moved out of `routing.ts` (behaviour-preserving; `routing.ts` drops to about 170 lines) |
| `skill-graph-types.ts` | 50 | `SkillGraphNode`, `SkillGraphIndex`, `SkillRoute`, `SkillRoutingTier` |
| `skill-graph-limits.ts` | 20 | Caps (128/512/depth 6/4 KiB/64 KiB), scores, `SKILL_ROUTES_PROMPT_MAX_CHARS = 700` |
| `skill-graph-scan.ts` | 150 | Bounded lstat walk and head reads of one skill directory, returning raw doc records |
| `skill-graph-metadata.ts` | 120 | Title, summary, frontmatter, terms, version role |
| `skill-graph-links.ts` | 70 | Relative markdown link extraction and in-prefix resolution |
| `skill-graph-index.ts` | 130 | `buildSkillGraphIndex(records, inputHash)` (parents, `referencedBy`, document frequency) |
| `skill-graph-router.ts` | 170 | `selectSkillRoutes(index, options)` (scoring, gates, dedupe) |
| `skill-route-prompt.ts` | 70 | `renderSkillRoutePrompt(routes, seenRoots)` |
| `skill-text.ts` | 40 | Shared bounded single-line and path-redacting text (used by `list-skills.ts` too) |
| `skill-graph-workspace-terms.ts` | 90 | Weak terms from cwd-root `package.json` deps/devDeps (≤256 KiB), `Cargo.toml`, `pyproject.toml`/`requirements*.txt`, `go.mod` |

New, in `packages/coding-agent/src/core/agent-session/`:

| File | ≈Lines | Responsibility |
| --- | --- | --- |
| `agentsession-methods/skill-route-context.ts` | 100 | `createSkillRouteTurnContext(self, query)`: guards, lazy index cache keyed by `inputHash`, query extraction (`parseSkillBlock` for `/skill:` → args only), tier → caps, try/catch → one diagnostic and no routes |
| `agentsession-methods/project-rule-turn-context.ts` | 45 | `createProjectRuleTurnContext` moved out of `prompt-context.ts` (now 290 lines) to make room |
| `skill-route-history.ts` | 70 | `collectSeenSkillLinks(branchEntries)`: `details.skillRouteLinks` of runtime-context messages plus `read_skills` toolCall `links`, since the latest compaction or branch summary |

Changed:

- **`project-instructions/routing.ts`**: imports from `routing-terms.ts`.
- **`project-instructions/index.ts`**: exports `buildSkillGraphIndex`, `selectSkillRoutes`, `renderSkillRoutePrompt`, and types.
- **`tools/list-skills.ts`**: uses `skill-text.ts` (no behaviour change).
- **`agent-session/agentsession-methods/prompt-context.ts`**:
  - imports the moved `createProjectRuleTurnContext`;
  - calls `createSkillRouteTurnContext`;
  - appends `skillRoutesPrompt` after `rulesPrompt` in `turnContextPrompts`;
  - returns `skillRoutesPrompt` and `skillRouteLinks`;
  - `do__createRuntimeContextPromptMessage` gains an optional `skillRouteLinks` and writes `details.skillRouteLinks`.
- **`agent-session/agentsession-methods/user-messaging.ts`**: passes `runtimePrompts.skillRouteLinks` to the message factory.
- **`agent-session/state-types.ts`**: `RuntimeContextPrompts` gains `skillRoutesPrompt?` and `skillRouteLinks?`.
- **`agent-session/agentsessionstate.ts`** (240 lines): adds `_skillGraphCache?: { inputHash: string; index: SkillGraphIndex }`, `_skillWorkspaceTerms?`, and `_skillGraphDiagnosticReported`.
- **`agent-session/agentsession-methods/runtime-build.ts` (`do_reload`)**: clears `_skillGraphCache` and workspace terms.
- **`agent-session/project-instruction-integrity.ts`**: adds `"skill_routes"` to `PROJECT_INSTRUCTION_BLOCK_TAGS` and to `RUNTIME_ALLOWED_TAGS.compiled`, so legacy/off replay and compaction summaries strip stale virtual links.
- **`agent-session/agentsession-methods/project-memory.ts`** (`do__createTokenBreakdownForPrompt`): counts `skillRoutesPrompt` in `retrievedPrompt`. It is retrieved context, and this avoids a new `TokenBreakdown` field rippling into UI and tests.
- **Settings.**
  - `settings-manager/types.ts`: `skillRouting?: "auto" | "off"`, default `"auto"`, documented next to `enableSkillCommands` (line 145).
  - `settingsmanager-methods/feature-flags.ts` and `settingsmanager.ts`: getter and setter.
  - An interactive `/settings` toggle is optional; `settings.json` is enough for phase 1.
- **Docs.**
  - `packages/coding-agent/docs/skills.md`: rewrite "How Skills Work" for compiled (`list_skills`/`read_skills`/routes) versus legacy (XML), and add a "Skill routing" section.
  - `packages/coding-agent/docs/settings.md`: `skillRouting`.
- **`.changes/skill-routing.json`**: `coding-agent`, `Added`.
- **`docs/leanings/<date>-skillgraph-prototype-was-never-wired.md`**: records §1.3 and §1.4 (an unwired module, a vacuous test, substring facets) and the rule "a router must be proven on the real tree through the delivery channel".
- **Not touched:** `skills.ts`, `system-prompt.ts`, manifest schema, `inputHash`, and the cache layout.

### 4.6 Config, default, and rollout

- **`skillRouting: "auto"` (default).** Routes appear only in compiled delivery, with `read_skills` active and confident matches. `"off"` disables routing entirely.
  - No CLI flag; `--no-skills` already empties skills.
  - No SDK option; tests use harness `settings`.
- **On by default?** Yes, on the evidence available:
  - Today's default (compiled) exposes zero skill names.
  - The cost is 0 tokens on unmatched turns.
  - The prefix cache is not disturbed.
- **Condition for merge.** A paired A/B with `scripts/benchmark-agents.js`, routing `auto` versus `off`, on an open-weights model and the owner's real skill set.

  | Metric | Requirement |
  | --- | --- |
  | Pass/quality | No regression |
  | Mean tokens per task | ≤ +2% |
  | `read_skills` calls that read a routed but unused doc | Reported |

  If quality regresses, ship `"off"` and keep the code for tuning.
- **Phase 2 (Option A, separate PR).**
  - `list_skills` ranks roots by graph score.
  - Its results get an optional `entry` link to the best descendant. The output shape stays backward compatible, and the cursor stays bound to `inputHash` and the query.
- **Phase 3 (separate PR).** Ship the bundled tree:
  - add `skills` to package `files`;
  - load it at the lowest precedence;
  - honour `--no-skills`;
  - add an `enableBundledSkills` setting if needed;
  - convert its 68 `file:///packages/...` links to relative links;
  - add a test asserting that every bundled relative link resolves inside its skill.
- **Phase 4 (measured experiment only).** A names-only `Skills:` line on STRICT turns where nothing routed (Option C lite), or an "inline top doc" mode.

### 4.7 Failure modes and handling

| Failure | Effect | Handling |
| --- | --- | --- |
| Noisy route | Small model wastes one `read_skills` | Gates, LIGHT max 1 at threshold 9, per-directory/ancestor dedupe, golden negative corpus, `"off"` |
| Sub-doc edited, added, or removed mid-session | Stale title or route | Index keyed by `inputHash` and rebuilt on `/reload`. Content is always read live. A removed doc gives the existing "Instruction link does not exist" error. Documented. |
| Skill root edited | `read_skills` reports stale cache | Existing behaviour, same as `list_skills`. Routes are not freshness-checked per turn, to avoid double hashing. |
| Huge or odd skill dir (repo clone, `node_modules`) | Startup latency or memory | Lazy build, caps, skips, `truncated` diagnostic once |
| Single-file root `.md` skill (`baseDir` = skills dir) | Would index other skills | Never scan non-`SKILL.md` roots |
| Symlink or escape | Read outside the skill | lstat-skip symlinks. Links are derived from directory names under the prefix, and `read_skills` re-validates with realpath containment. |
| Prompt injection via doc titles | Malformed envelope | Bounded single-line, `<>`/backtick escaped, path-redacted. Trust is the same as `SKILL.md`, which the model reads anyway. |
| Mode switch or resume into legacy/off | Dead `skills/…` links | Tag stripped by the integrity filter. Compaction summaries strip it too. |
| `/skill:name args` | Routes duplicate the already-inlined skill | Route on the args only and exclude that skill's root |
| Index build throws (EACCES, invalid UTF-8) | — | Per-file errors are skipped. A whole-build failure gives one diagnostic, no routes, and the prompt proceeds. |
| Determinism drift | Flaky KV prefix or tests | No time or random input. Sorted nodes and link tie-breaks. Routes are persisted, never recomputed for old turns. |

### 4.8 Test plan (faux provider only; no real provider calls)

Unit tests (`packages/coding-agent/test/`, real temp-directory fixtures, no fs mocks):

- **`skill-graph-index.test.ts`**
  - Root, sub-skill, and doc kinds.
  - Heading titles: a regression for #1.4 item 1.
  - Nested `SKILL.md` frontmatter summary: item 2.
  - `trust-boundaries` has no `rust` term: item 3.
  - Version roles.
  - A single-file skill is not scanned.
  - Symlinks, dot directories, and `node_modules` are skipped.
  - Caps produce `truncated`, with 200 generated docs.
  - Relative links resolve. `file:///`, absolute, and `../` escaping links are ignored.
  - **Every node link is accepted by `readSkillLinks`** against a real prepared state, using the delivery fixture.
- **`skill-graph-router.test.ts`**: a golden table over a fixture tree shaped like the bundled one.
  - Positive cases:
    - vitest → `default-v4`, not compat;
    - "vitest v2" → compat;
    - proptest → rust doc;
    - saga compensation → doc;
    - exact skill name → root forced.
  - Negative cases: "What is 2+2?", "rename foo to bar in utils.py", "commit and push" → `[]`.
  - Workspace terms alone never route.
  - LIGHT gives at most 1 route and uses the higher threshold.
  - Seen links are suppressed.
  - Ancestor, descendant, and sibling dedupe.
  - Determinism: identical output across runs and with shuffled record order.
- **`skill-route-prompt.test.ts`**
  - Format.
  - 700-char cap with whole lines dropped.
  - Escaping of a title containing `</skill_routes>`.
  - Path redaction.
  - The entry link is shown once per skill.
- **`skill-route-history.test.ts`**
  - Seen links from runtime-context `details` and `read_skills` calls.
  - Reset after a compaction or branch-summary entry.
- **`skill-graph-workspace-terms.test.ts`**
  - Each manifest type.
  - Malformed `package.json` → `[]`.
  - The size cap.
- **Existing tests**
  - Extend `project-instruction-integrity-unit.test.ts`: `skill_routes` is kept in compiled mode and stripped in legacy/off and in summaries.
  - Rule-routing tests (`project-instruction-action-routing-chunks.test.ts` and related) must pass unchanged before and after the `routing-terms.ts` split.
  - The `list-skills` tests cover the `skill-text.ts` extraction.

Suite test (`test/suite/skill-routing-compiled-delivery.test.ts`, `createHarness` plus `createSessionProjectInstructionController`, `taskVerificationMode: "auto"`, skills fixture in the workspace `.p/skills`, requests captured as in `defer-extension-tools-light.test.ts`):

1. A STRICT prompt ("Add vitest tests for the retry backoff in src/queue.ts"):
   - The captured context has a hidden runtime-context message with `<skill_routes>` containing the `default-v4` virtual link and not the compat link.
   - `systemPrompt` is byte-identical to a no-route turn.
   - The faux model calls `read_skills` on the routed link. The tool result has the doc content, and the final text completes.
2. A second prompt on the same topic: no repeated route.
3. "What is 2+2?" (LIGHT): no `<skill_routes>`, and the retrieved token count is unchanged.
4. `settings: { skillRouting: "off" }`; then `projectInstructionMode: "legacy"`; then `excludeTools: ["read_skills"]`: none of them produce `<skill_routes>`.
5. Resume the persisted session into legacy: replayed context has no `skill_routes`.
6. Failure injection: one unreadable doc (chmod 000), and a `baseDir` deleted after preparation. The prompt still completes, healthy docs still route, and a single diagnostic is emitted.

Process:
- Run each touched test file, then `npm run test:unit`, then `npm run check`.
- Spawn an adversarial test-critic subagent, as AGENTS.md requires.
- Run a tmux `p` smoke in a workspace with the owner's skill dirs. Assert the routes from `/session` export or the hidden-message debug view.

---

## 5. Other #90 pieces: still worth porting?

- **`2ad5a0ff7` lean universal prompt: already effectively ported.**
  - `system-prompt/strict-guidelines.ts` contains the lean equivalents: incremental verification, transaction and rollback semantics, exact formats, focused versus full checks, and "consult loaded specialized skills".
  - `LIGHT_GUIDELINES` is leaner still.
  - `--no-skills` is already gone from `scripts/benchmark-agents.js`. It remains only in `p-cache-26-turn-smoke.js`, intentionally.
  - One small follow-up with neutral cost: in compiled delivery, reword the existing skills guideline to "use `<skill_routes>` / list_skills / read_skills for testing, architecture, or ecosystem playbooks". Skills are not "loaded" in the prompt there. Same length, no added tokens.
- **`9a5fb6c72` TDD rules: do not port.** #90 itself reverted them in `2ad5a0ff7`. Their content already lives in the software-testing skill (`protocols/*`, `references/tdd-and-invariants.md`). Option B delivers it on demand instead of on every STRICT request. "100% branch coverage" is this repository's own policy, not a universal agent rule.
- **`02d892786` / `0ce39b5dc` dynamic execution modes: superseded, do not port.**
  - `conversational`/`research`/`development` was derived from `mutationRevision` and the evidence count.
  - Main's adaptive LIGHT/STRICT tier (`task-tier.ts`, `task-verification-tier-session.ts`) covers the same ground with a deterministic prompt prior, effect escalation, and zero-effect text completion (`acceptZeroEffectTextCompletion`).
  - Controller reset is covered by `resetAfterSuccessfulCompletion` (`completion-lifecycle.ts`).
- **`338c16daa` ignore escaping: port as a separate small fix.**
  - On main, `prefixIgnorePattern` strips `\!` even at the root. So a root-level ignore line `\!bang.md` becomes the negation `!bang.md`, and the file is **not ignored**. Being fixed separately in branch `fix/ignore-escaped-bang-pattern`.
  - #90 strips the backslash only when there is a prefix. The `\#` cases already work on main.
  - Do **not** port its `toPosixPath` → `replaceAll("\\","/")` change. Main's `split(sep)` is correct per platform.
  - Needs a regression test in `skills.test.ts`; main has no ignore-file tests there.
- **`c5f2d10f9` skills split and bundled skills.**
  - The split is not needed for SkillGraph under this design. `skills.ts` is a 487-line baseline violation, so a separate behaviour-preserving split is still welcome.
  - Bundled-skill loading is phase 3.
- **`399026bb4` learnings: already on main.** It is identical, so there is nothing to port.

## 6. Open questions

- Where `p` should show the routes for operators, for example a `/skills routes` debug view. Not required for phase 1.
- Whether LIGHT should route at all for pure Q&A. The design allows 1 high-confidence route. The A/B should report LIGHT-only route hit rates.
- Whether skill routes should feed `tool_search`'s catalog-style overflow (Option C lite) when nothing routes. Deferred to phase 4, with measurement.
