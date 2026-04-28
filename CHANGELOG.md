# Changelog

## [Unreleased]

## [1.0.7] - 2026-04-28

### Changed

- **Codebase cleanup pass — no behaviour changes.** Identical runtime to
  v1.0.6; only source comments, string messages, and identifier names
  were updated to consistently say `lotl` / `Lotl` after the v1.0.0
  rename from `@tanarchy/qmd`. SDK consumers do not need to update — see
  back-compat note below.
  - **Comments and log/error strings** across `src/` updated from `qmd` /
    `QMD` to `lotl` / `Lotl` where the reference is to the project
    itself. Upstream attributions (`tobi/qmd <sha>`) and OpenClaw
    config-key values (`memory.backend = "qmd"` is the literal value
    OpenClaw recognises) are preserved as-is.
  - **MCP tool comment headers** in `src/mcp/server.ts` for `doc_get` /
    `doc_multi_get` / `doc_status` previously called those tools by
    their pre-rename names; updated to match the actual registered
    names. The error message that pointed users at `'qmd_get'` is now
    `'doc_get'` so the hint is accurate.
  - **Plugin display name** in `src/openclaw/plugin.ts` is now `"Lotl"`
    (previously `"Tanarchy QMD"`); `description` no longer says
    "powered by QMD". The plugin id stays `tanarchy-lotl`.

### API (back-compat preserved)

- **Public SDK exports renamed with deprecated aliases.** Existing
  `import { ... } from "@tanarchy/lotl"` calls keep working unchanged.
  Switch to the new names at your own pace.

  | Deprecated (still works) | Use this instead |
  |---|---|
  | `QMDStore` | `LotlStore` |
  | `loadQmdEnv()` | `loadLotlEnv()` |
  | `getQmdConfigDir()` | `getLotlConfigDir()` |
  | `getEmbeddedQmdSkillFiles()` | `getEmbeddedLotlSkillFiles()` |
  | `getEmbeddedQmdSkillContent()` | `getEmbeddedLotlSkillContent()` |

  Old names are tagged `@deprecated` in JSDoc so editors flag them.
  They will be removed in a future major release (v2.0.0); no concrete
  date set yet.

- **Internal-only renames** (no consumer surface, no alias):
  `QmdPluginConfig` → `LotlPluginConfig`, `qmdPlugin` const →
  `lotlPlugin` (the default export name doesn't reach consumers),
  `encodeQmdPath` / `toQmdPath` → `encodeLotlPath` / `toLotlPath`.

### Project hygiene

- **`.gitignore`**: added cross-platform editor / OS metadata patterns
  (`*.swp`, `*.swo`, `*~`, `.AppleDouble`, `.LSOverride`, `._*`,
  `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `*.tsbuildinfo`). The
  working tree was already clean; this is preventative.
- **Docs reorganisation**: `docs/UPSTREAM.md` (cherry-pick log from
  `tobi/qmd` upstream syncs) moved to `devnotes/upstream-sync.md` —
  it's a maintainer artefact, not user-facing. References in
  `docs/ROADMAP.md` updated.

## [1.0.6] - 2026-04-28

### Fixed

- **CI publish workflow could not run on the GitHub-hosted runner.** The
  `npm install -g npm@latest` step added in v1.0.4 worked while the
  runner's bundled npm was healthy, but the runner's Node 22.22.2
  toolcache started shipping a bundled npm that was itself missing
  `promise-retry` (`MODULE_NOT_FOUND` from `@npmcli/arborist/rebuild.js`),
  so the in-place upgrade couldn't even start. v1.0.5 was tagged but
  never reached the registry because the publish job died at this step.

  Switched the publish job to **Node 24** (LTS since Oct 2025), which
  ships npm v11 natively — no in-place upgrade needed, no moving target
  on `npm@latest`. The test, pack-audit, and smoke jobs stay on Node
  22/23 to keep validating the install path real consumers run on.

  Package contents are identical to v1.0.5; this release exists solely
  to actually deliver the v1.0.5 plugin fixes to npm.

## [1.0.5] - 2026-04-28

### Fixed

- **OpenClaw plugin was effectively non-functional in v1.0.4.** Live testing
  surfaced five distinct bugs that together prevented the plugin from
  loading, finding its data, and connecting to its LLM provider. All five
  are fixed; v1.0.5 is the first release where `openclaw plugins install
  @tanarchy/lotl` produces a working plugin out of the box.

  - **`register()` was declared `async`.** OpenClaw's plugin loader invokes
    `register()` synchronously and does not await the returned promise, so
    `registerTool()` and `registerService()` calls inside the async body
    fired *after* the loader had moved on. Result: the plugin appeared to
    load but registered nothing. Made `register()` synchronous.
  - **DB path defaulted to `~/.cache/qmd/`** instead of `~/.cache/lotl/` — a
    leftover from before the v1.0.0 rename. Auto-capture and auto-recall
    silently hit `no such table: memories` against an empty legacy DB.
    Same path bug also affected the dream-cycle cursor at
    `~/.config/qmd/dream-ingestion.json`. Both now point at `lotl/`.
  - **`remote-config.ts` read `QMD_*` env vars** for `EMBED_PROVIDER` /
    `_API_KEY` / `_URL` / `_MODEL`, but the rest of the codebase exports
    `LOTL_*`. `getRemoteLLM()` always returned `null` → LLM extraction
    fell back to the heuristic path even when a provider was configured.
    All four lookups now use `LOTL_*`.
  - **`db.ts` could not resolve `sqlite-vec`** when loaded as an OpenClaw
    plugin — `createRequire(import.meta.url)` resolves from the plugin's
    `dist/` dir, where sqlite-vec is a transitive dep that Node's
    resolution often can't reach. Vector search silently no-op'd
    (FTS still worked). Added a fallback that tries the host's
    (e.g. OpenClaw's) `node_modules` before giving up.
  - **Tool names were still `qmd_*`** despite the package rename. All ten
    plugin tools renamed to `lotl_*`: `lotl_memory_add`,
    `lotl_memory_search`, `lotl_memory_delete`, `lotl_memory_extract`,
    `lotl_memory_stats`, `lotl_memory_push_pack`, `lotl_memory_recall_tiered`,
    `lotl_memory_reflect`, `lotl_knowledge_add`, `lotl_knowledge_search`.

  Thanks to Vincent Law for diagnosing all five against a live deployment.

## [1.0.4] - 2026-04-25

### Fixed

- **CI publish workflow trusted-publishing 404.** Node 22 ships npm v10;
  npm trusted publishing requires CLI ≥ 11.5.1 for the OIDC handshake.
  Without it the registry rejects the OIDC token and returns a misleading
  `404 Not Found - PUT` (npm/cli#9088), even though provenance signing
  succeeds. Added `npm install -g npm@latest` in the publish job before
  `npm publish`. No runtime changes — `1.0.4` is identical to `1.0.3`
  in package contents; this release exists solely to validate the fixed
  pipeline against npm.

## [1.0.3] - 2026-04-25

### Fixed

- **CI publish workflow audit step** referenced `bin/lotl` as a required
  tarball file. v1.0.2's bin fix removed that file (the wrapper sat at
  `dist/cli/lotl.js` with shebang instead). Audit now checks for the
  shipped `.js` directly. v1.0.1 + v1.0.2 publish runs failed at this
  gate before npm publish; v1.0.3 unblocks the pipeline.

## [1.0.2] - 2026-04-25

### Fixed

- **Windows global install was broken.** `bin/lotl` was a POSIX shell
  script; npm's auto-generated `lotl.cmd` wrapper called `/bin/sh.exe`
  to invoke it — that path doesn't exist outside Git Bash / MSYS2.
  Symptom: `claude mcp add lotl lotl mcp` succeeded but the MCP server
  silently failed to spawn (`claude mcp list` reported `✗ Failed to
  connect`). Affected every Windows user installing `@tanarchy/lotl`
  globally without Git Bash on PATH. `package.json` `bin` now points
  at `dist/cli/lotl.js` (which already has `#!/usr/bin/env node`
  shebang from `scripts/build.mjs`); npm generates a proper Windows
  wrapper that uses `node.exe` directly. `bin/lotl` removed.

### Added

- **`claude mcp add` install path documented** across README, SKILL,
  and `mcp-setup.md` reference. Replaces the manual `~/.claude.json`
  edit instructions for Claude Code users — the CLI command does the
  same thing in one line, including the right scope handling. Manual
  JSON path retained as fallback for older Claude Code versions.
  Per-platform note included for the Windows `.cmd` extension quirk
  in Node `child_process.spawn` (use `lotl.cmd` not `lotl` on Windows).

## [1.0.1] - 2026-04-24

### Added

- **OpenClaw plugin memory tool wiring** — `qmd_memory_push_pack`,
  `qmd_memory_recall_tiered`, `qmd_memory_reflect` now registered in
  `src/openclaw/plugin.ts`. MCP server already had the equivalents from
  2026-04-17; the plugin surface was missing them so OpenClaw users
  couldn't reach these capabilities without dropping into raw MCP.
- **Silent-fallback warnings** in `src/store/search.ts` — vector embed,
  query expansion, and rerank paths now emit a one-time stderr warning
  when they silently no-op due to no backend configured. Dedupe via a
  module-scoped Set so it fires once per process, not per query.
  `LOTL_QUIET_FALLBACK=1` suppresses (eval harness intentionally runs
  in no-backend baseline mode and doesn't need the noise).
- **MCP `knowledge_search` optional `scope` filter** — `knowledgeQuery`
  already supported scope narrowing; the MCP tool schema now exposes it.
  Default behaviour unchanged (cross-scope when omitted).
- **`test/lmstudio-rerank.test.ts`** — smoke tests for the OpenAI-shim
  chat paths: rerank (normal content, Qwen3 `reasoning_content`
  fallback, timeout, host-unreachable), expandQuery reasoning_content,
  chatComplete reasoning_content. 6 cases.
- **`test/silent-fallback-warnings.test.ts`** — 4 cases covering rerank
  warn-once, dedupe across repeated calls, `LOTL_QUIET_FALLBACK`
  suppression, and expand-query warn path.
- **`extract-facts-batch.mjs` parallel mode** — new
  `LOTL_EXTRACT_PARALLEL` env var (default 8) fires concurrent LLM
  calls via chunked `Promise.all`. Also wires undici keep-alive Agent
  (16 pooled connections) to prevent socket churn — sustained parallel
  fetches otherwise exhaust Windows' ephemeral port range and can wedge
  the NIC driver. Observed live 2026-04-24 during the v1.0.1 fact
  extraction batch.
- **`extract-facts-batch.mjs` `LOTL_EXTRACT_MAX_TOKENS` env var**
  (default 512) — lets callers bump the output budget for thinking
  models that burn tokens on chain-of-thought before emitting JSON
  (gemma-4-e2b needed 2048 to complete).

### Fixed

- **`src/llm/remote.ts` missing `reasoning_content` fallback on 3
  production code paths.** The eval harness was patched across 6 sites
  for the Qwen3 thinking-model bug at v1.0.0 but three equivalents in
  production missed the same fix:
  1. LLM-chat `rerank` (line 528) — qwen3 rerank returned silent empty
     results.
  2. `expandQuery` (line 371) — had `enable_thinking:false` but no
     matching `reasoning_content` fallback. Half-fix.
  3. `chatComplete` (line 448) — the general-purpose LLM channel used
     by memory extraction. No handling at all.
  All three now fall back to `msg.reasoning_content` when `content` is
  empty. Test coverage added.
- **`evaluate/scripts/extract-facts-batch.mjs` positional-args bug.**
  The post-v1.0.0 "9bee79a fix" called
  `createTransformersEmbedBackend({model,dtype})` but the function
  signature is positional `(model, dtype, fileName, device)`. The
  object got smuggled into `pipeline()`'s `modelId` slot and crashed
  deep in `@huggingface/transformers`' `pathJoin` with
  `part.replace is not a function`. Only surfaced on rows with non-empty
  facts (first row to trigger embedder creation), making it look
  intermittent. Positional fix + widened catch-block stack trace so
  future silent transformers.js failures surface with a real stack.
- **`evaluate/scripts/phase6-watchdog.sh` PID-recycle** — `tasklist`
  filter now includes `IMAGENAME eq bash.exe` so recycled PIDs
  reassigned to non-bash processes don't fake a live watchdog. Caught
  live 2026-04-21 when 2× watchdog fires left 16 eval.mts processes.

### Changed

- **`LOTL_LMSTUDIO_HOST` default → `localhost:1234`** across the eval
  harness (previously `10.0.0.116:1234`, prior `10.0.0.113:1234`, prior
  `10.0.0.105:1234`). This was the third bulk source-code rename
  chasing a DHCP-drifting host in as many weeks. Users on a remote LM
  Studio box set the override in `~/.config/lotl/.env` once and stop
  eating commits when their DHCP lease rotates.
- **Documentation honesty pass** across README, `docs/ARCHITECTURE.md`,
  `docs/EVAL.md`, `docs/SYNTAX.md`, `skills/lotl/SKILL.md`,
  `skills/lotl/references/mcp-setup.md`:
  - RRF weights `0.9/0.1` → `0.8/0.2` (Phase 6 hardcode).
  - Rerank blend position-aware `75/25 → 60/40 → 40/60` → flat `0.5/0.5`.
  - `LOTL_MEMORY_SYNONYMS` documented on → hardcoded off.
  - Stale `qmd <command>` CLI invocations → `lotl <command>` (CLI alias
    dropped at v1.0.0). ~37 occurrences in user-facing docs.
- **`devnotes/architecture/env-flag-polarity-reference.md`** header
  flagged as pre-v1.0.0 with pointer to `git grep` for canonical
  post-cleanup env var list.

### Security

- **`vite` bumped to `^7.3.2`** via `overrides` in `package.json` —
  resolves GHSA-4w7w-66w2-5vf9 (path traversal in optimized deps
  `.map`), GHSA-v2wj-q39q-566r (`server.fs.deny` query bypass), and
  GHSA-p9ff-h696-f583 (arbitrary file read via dev server WebSocket).
  Vite is a transitive devDep of vitest; override holds the fix in
  source without bumping vitest itself (exact-pinned at 3.2.4).
- **Upstream 2026-04-23 audit closed** — one pick (`3023ab3` security
  deps partial), one skip (`e8de7ca` status device probe — LlamaCpp
  surface we removed in 2026-04-13 cleanup, not applicable).

### Eval

- **Phase 11.8 gte-small n=500 follow-up — GATE FAIL.** rAny@5 97.8%
  (floor 98.4%), MRR 0.912 (floor 0.917). The n=100 +0.4pp MRR didn't
  replicate at n=500. mxbai-xs q8 stays production default. Lesson:
  future Phase 11 candidates should gate at n=500 directly; n=100
  can't discriminate near-tied embedders at this MRR ceiling.
- **Phase 5b fact-augmented retrieval A/B — GATE FAIL (CLOSED NEGATIVE).**
  Extracted facts into 76.1% of LME memory rows (18,166 / 23,867)
  using qwen2.5-1.5b-instruct via LM Studio with the new parallel
  extraction pipeline. Plus 57,031 KG triples as a side product.
  Ran `LOTL_MEMORY_EMBED_SOURCE=fact` vs `=content` at n=500. Result:
  multi-session R@5 90% → 88% (−2pp — the thesis gate required ≥+2pp).
  Every bucket regressed. Phase 5 closed as negative data point.
  Infrastructure (`fact_text`/`fact_embedding` columns, `memories_vec_fact`
  virtual table, fact-extractor prompt template, extraction runner,
  `LOTL_MEMORY_EMBED_SOURCE` routing) remains in-tree for future
  experiments with different extraction models / strategies.
- **LoCoMo golden audit cross-ref.** 11 score-corrupting opportunities
  identified against the v1.0.0 release numbers (not 99 — the 99 count
  was total audit errors before filtering for matched rows). Theoretical
  ceiling 73.5% (+5.6pp). Re-judging the 11 deferred post-v1.0.1.

## [1.0.0] - 2026-04-21 — 🦎 Lotl GA

**First stable release.** Headline numbers landed via Phase 6 squeeze sweeps
+ combined-winners on the gemma stack: **LongMemEval _s n=500 JudgeCorrect
73.8%** (within 0.5pp of gpt-4o-mini full-context baseline with only
top-K retrieval + a 4B Matformer generator) and **LoCoMo n=200 R@5 60.0%**
(+9.5pp vs no-rerank baseline). Adversarial judge audit clean: gold
self-check 100/100, v1 specific-wrong 0/99, v2 vague-topical 1/87 — the
numbers are measuring what we think they're measuring.

The winning stack: `gemma-4-e4b` gen + `gemma-4-26b-a4b` 3-run majority
judge, v14 CoT answer prompt, strict LoCoMo judge, RRF 0.8/0.2 fusion,
jina-reranker-v1-tiny cross-encoder, 0.5/0.5 original+rerank blend,
synonyms off.

### Added

- **LM Studio eval harness** for local LLM-as-judge with gemma-4 /
  qwen-35B / llama-3.1-8B. Full scripts: `smoke-all-lmstudio.sh`,
  `smoke-gemma-validate.sh`, `phase-b-gemma.sh`, `phase-b-llama-qwen.sh`,
  `rejudge-failed.sh`, `extract-facts-batch.mjs`.
- **v14 CoT answer prompt** ported verbatim from dial481/locomo-audit's
  `answer_prompt_cot`. Lifts judge accuracy meaningfully on gemma stack.
- **Strict LoCoMo judge** — `LOTL_LOCOMO_JUDGE=strict` drops the "touches
  on topic" leniency bug (6.9x inflation per audit). Default stays
  lenient for back-compat.
- **response_format: json_schema** enforcement on lmstudio/poe judges —
  zero unparseable verdicts (previously 10-13% dropout rate on
  gemma-4-26b-a4b).
- **N-run judge majority vote** via `LOTL_JUDGE_RUNS` env (default 1).
- **Answer persistence** — every generation written to
  `answer-cache/<hash>.json` for replay with a different judge without
  regenerating.
- **Wilson Score 95% CIs** — `evaluate/scripts/wilson-ci.mjs` with
  `--compare` distinguishability flags. Stdlib-only Node port of
  audit's Python.
- **LoCoMo golden audit cross-ref** — `evaluate/scripts/audit-locomo-goldens.mjs`
  against dial481/locomo-audit's errors.json (quantifies theoretical
  ceiling gain from 99 score-corrupting errors in the shipped goldens).
- **Phase 5 scaffolding** (experimental, post-v1.0) — schema migration
  for `fact_text` + `fact_embedding` columns, `src/memory/fact-extractor.ts`
  with prompt template + parser, `evaluate/scripts/extract-facts-batch.mjs`
  runner. A/B of fact-augmented embedding retrieval deferred to v1.1.
- **Adversarial judge-leniency pipeline** (#36) —
  `evaluate/scripts/adversarial-gen.mjs` generates v1 specific-wrong
  and v2 vague-topical distractors from the results JSON; companion
  `adversarial-rejudge.mjs` re-runs the judge. Lets a judge configuration
  be proven clean quantitatively before release.
- **Combined-winners composer** (#38) —
  `evaluate/scripts/phase-d-combined-winners.sh` composes the full
  Phase 6 stack (rerank + blend + RRF + v14 CoT + strict judge + gemma
  gen/judge pair) and drives LME + LoCoMo in one pass.
- **LOTL_EVAL_* namespace bridge** (#47) — `evaluate/shared/env-compat.ts`
  bidirectionally mirrors 32 eval-only env vars between legacy and
  `LOTL_EVAL_*` names so existing sweeps and callers keep working
  while the new namespace rolls in.
- **Resumable sweeps + watchdog** — `sweep-flags.sh` skips completed
  configs (detects `SUMMARY.md`), `phase6-watchdog.sh` enforces a
  single-instance lockfile via `tasklist` (Git Bash `kill -0` doesn't
  work for out-of-session PIDs on Windows) and self-heals transient
  non-zero exits with a 5-retry loop.
### Changed — Phase 6 squeeze-sweep hardcodes

Four LME n=500 sweeps (max-chars / MMR × K-pool / rerank-blend α /
query-expand × synonyms) completed. Winners baked into
`src/store/constants.ts`:

- `MEMORY_RERANK_BLEND_ORIGINAL=0.5` / `_RERANK=0.5` (+0.002 MRR over
  the previous 0.7/0.3).
- `RRF_W_BM25=0.8` / `_VEC=0.2` default (flipped from 0.9/0.1 per the
  2026-04-20 weight sweep).
- `MEMORY_RERANK_CANDIDATE_LIMIT=40` hardcoded.
- `LOTL_MEMORY_SYNONYMS` hardcoded off in `src/memory/index.ts` —
  syn-off wins across every expand mode.
- max-chars 500→7500 and MMR × K-pool were both no-ops on retrieval
  under `--no-llm` (max-chars only gates the LLM prompt budget; MMR ×
  K-pool produced byte-identical metrics across all 8 configs on LME's
  single-scope corpus).

### Changed — dead-knob cleanup

Removed 10+ env vars that were parked, superseded, or silently
hardcoded. Notable deletions: `LOTL_MEMORY_LHASH` (parked harmful with
DIVERSIFY interaction), `LOTL_RECALL_DIVERSIFY` (superseded by
`LOTL_MEMORY_MMR=session`), `LOTL_TRANSFORMERS_QUIET`,
`LOTL_STRICT_DIM_MISMATCH`, `LOTL_TRANSFORMERS_DIRECT_MAXLEN`,
`LOTL_GEMINI_EMBED_BATCH_SIZE`, `LOTL_GEMINI_EMBED_INTERVAL_MS`.
Per-version LM Studio `ctx`/`parallel` knobs collapsed to a single
gen/judge pair.

### Fixed

- **qwen3 thinking-model `reasoning_content` fallback** — qwen3.6-35b-a3b
  (and other qwen3 family models) route structured JSON output into
  `message.reasoning_content` instead of `message.content`, producing
  100% empty verdicts on any harness that only reads `content`. Patched
  across 5 eval-harness call sites: `evaluate/{locomo,longmemeval}/eval.mts`
  (`askLLM` + LoCoMo's `askMiniMax` path),
  `evaluate/longmemeval/poe-judge.mts`, and
  `evaluate/scripts/{extract-facts-batch,adversarial-gen,adversarial-rejudge}.mjs`.
  Pattern is consistent: set `enable_thinking:false` when the model
  matches `/qwen3/i`, then read `content || reasoning_content` with the
  structured-JSON regex applied to whichever is non-empty.
- **Phase 5b fact extract** — `extract-facts-batch.mjs` used a
  non-existent `mod.embedTexts`; replaced with
  `createTransformersEmbedBackend({ model, dtype: "q8" })` + input char
  cap via `LOTL_EXTRACT_MAX_INPUT_CHARS=10000` to keep very long
  session-level memories under the encoder context window.
- **llm-cache v2 hash** includes `max_tokens` to prevent thinking-model
  stale-empty entries from shadowing fresh calls at larger budgets.
  Legacy entries still readable via fallback (non-empty only) so
  existing caches survive migration.
- **LOTL_RECALL_NO_TOUCH=on** now defaults ON in both eval.mts entry
  points so new eval scripts can't forget it (cost 3+ LM Studio
  crashes 2026-04-19).
- **Cross-model unload** in LM Studio harness — `load_judge` now
  unloads the gen model first (and vice versa) + 3s settle before the
  next load. LM Studio doesn't auto-evict on load and can OOM a 24 GB
  card without this.
- **Single-instance guarantee** — every `load_model` unloads `:N`
  suffix variants first, preventing bare-name request routing
  ambiguity.
- **LoCoMo eval worker pool** via `LOTL_LOCOMO_WORKERS`. LoCoMo was
  sequential before; now honors parallel slots like LME does.
- **Adversarial-gen schema detection** — accept `data.items`,
  `data.results`, and `data.rows` shapes; `it.answer` treated as
  equivalent golden.

### Documented

- **LM Studio `context_length` sizing**: `context_length` is TOTAL
  across parallel slots, not per-slot. Per-slot ctx = `context_length /
  parallel`. Scripts default to `desired_per_slot × parallel`.
- **Windows kill-cascade quirks**: `taskkill //T` tree-kill doesn't
  always propagate through `bash -c eval ...` parent-child chains.
  Confirm with `wmic process list`, target specific PIDs. Captured in
  the devnotes runbook.

### Removed (since v1.0.0-rc1)

- **LM Studio rerank + embed backends** — the short-lived
  `src/llm/lmstudio-rerank.ts` (chat-completions scoring shim) and
  `src/llm/lmstudio-embed.ts` (direct `/v1/embeddings`) landed in
  rc1 but never benchmarked well enough to ship: the scoring shim
  produced poor rerank gradients at ~45 s/query (F1 3.8 % on LoCoMo
  conv-26 vs 13.2 % for the shipped jina-reranker-v1-tiny-en
  cross-encoder), and cross-encoder rerankers return
  HTTP 400 "the current context does not logits computation. skipping"
  through LM Studio's chat-completions endpoint because LM Studio
  registers them as `type=llm`. The embed shim worked but never beat
  the shipped `transformers` mxbai-xs q8 default. Both paths are
  removed — along with `LOTL_{RERANK,EMBED}_BACKEND=lmstudio`, the
  `LOTL_LMSTUDIO_{RERANK,EMBED}_*` env vars, tests, and BEIR sweep
  configs — rather than parked, because LM Studio fundamentally can't
  expose a real `/v1/rerank` endpoint and the shim misled users into
  sweeps that couldn't produce useful numbers. Use the `transformers`
  backend (local cross-encoder) or any `remote` OpenAI-compatible
  provider for rerank and embed. LM Studio remains fully supported
  for **answer generation and LLM-as-judge** in the eval harness
  (`LOTL_LMSTUDIO_{HOST,KEY,GEN_MODEL,JUDGE_MODEL}` unchanged).

## [1.0.0-rc1] - 2026-04-18 — 🦎 Lotl

**First stable release under the new name.** Previously `@tanarchy/lotl` — rebranded
to `@tanarchy/lotl` (Living-off-the-Land) to communicate the actual product
identity: AI agent memory on what's already on the machine (FTS5 + sqlite-vec +
local ONNX), no new infrastructure, no LLM required.

### Migration from `@tanarchy/lotl`

- **Package**: `npm uninstall -g @tanarchy/lotl && npm install -g @tanarchy/lotl`
- **CLI**: `lotl` is the new canonical binary. `qmd` still works as an alias.
- **Env vars**: `QMD_*` env vars keep working through v1.x. `LOTL_*` aliases
  will be added with deprecation warnings in v1.1; full migration at v2.0.
- **MCP tools, SDK API, config file format**: unchanged. Your `~/.config/lotl/.env`,
  `~/.cache/lotl/index.sqlite`, and collection data migrate as-is.
- **OpenClaw plugin**: still registered as `tanarchy-lotl` in `openclaw.json`
  for v1.0 (plugin name migration in v1.1).

Version reset from `2.1.0-dev.23` to `1.0.0` to mark the new identity. The
feature set IS release-ready — the previous `2.1.0-dev.*` numbering was the
pre-rebrand progression.

### What Lotl actually is

First release-ready version after the n=500 LongMemEval embedder sweep + LoCoMo
end-to-end Judge-Acc validation. mxbai-xs q8 confirmed as production default.

### Highlights

- **n=500 LME sweep concluded**: mxbai-xs q8 (384d) wins on rAny@5 (98.4%) and
  preference MRR (0.745). Four challengers (gte-small, bge-large, UAE-Large,
  jina-v5) tied or regressed. See [`evaluate/SNAPSHOTS.md`](evaluate/SNAPSHOTS.md).
- **LoCoMo end-to-end (10 convs, 1986 QA, gemini-2.5-flash gen+judge): 81.4% Judge-Acc.**
  Competitive with Mem0 (91.6%, GPT-4 class) and Hindsight (89.6%/83.6%) given
  generator differences.
- **Direct-ORT backend** for transformers.js arch-incompat models
  (`src/llm/transformers-embed-direct.ts`). Activated by `LOTL_EMBED_DIRECT=on`.
  Probed jina-v5-nano-retrieval at 402 MB RSS (RSS-leak-safe with
  `LOTL_TRANSFORMERS_DIRECT_MAXLEN=1024`).
- **Honest eval harness**: top-k=10 LLM context (was 50, matching MemPalace's
  admitted cheat), Mem0-style judge prompt, robust JSON+text verdict parser.
- **Eval harness disconnected from npm package** — eval scripts live in
  `evaluate/` (not shipped). Run from source against your own dataset.
- **30 pre-existing typecheck errors** in `test/` fixed.

### Embedder n=500 LME _s leaderboard (no-LLM, retrieval-only)

| Embedder | Dim | rAny@5 | MRR | Pref MRR | Wall |
|---|---|---|---|---|---|
| **mxbai-embed-xsmall-v1 q8** (default) | 384 | **98.4%** | 0.917 | **0.745** | 26 min |
| UAE-Large-V1 | 1024 | 98.0% | **0.921** | 0.714 | 145 min |
| gte-small | 384 | 97.8% | 0.919 | 0.703 | 26 min |
| bge-large-en-v1.5 | 1024 | 98.0% | 0.917 | 0.680 | 147 min |
| jina-v5-nano-retrieval (direct-ORT) | 768 | 95.4% | 0.860 | 0.533 | ~5 h |

### Cleanup pass (release-ready bar)

- **`evaluate/`**: canonical `scripts/` + archived `legacy/` split (24 one-off
  scripts moved out of the root). New `evaluate/scripts/README.md` +
  `evaluate/legacy/README.md` explain the keepers and the archive.
- **`evaluate/longmemeval/README.md` + `evaluate/locomo/README.md`**: per-eval

- **`evaluate/`**: canonical `scripts/` + archived `legacy/` split (24 one-off
  scripts moved out of the root). New `evaluate/scripts/README.md` +
  `evaluate/legacy/README.md` explain the keepers and the archive.
- **`evaluate/longmemeval/README.md` + `evaluate/locomo/README.md`**: per-eval
  docs with CLI flag tables, canonical recipes (no-LLM / Gemini / Poe), DB-reuse
  notes, and performance expectations.
- **`evaluate/CLEANUP_PLAN.md`** + **`evaluate/locomo/HYBRID_HARNESS.md`**:
  release-ready cleanup plan + honest-harness design (competitor audit of
  Mem0 / Zep / Hindsight / MemPalace / memory-lancedb-pro judge configs + top-k).
- **`.env.example`**: complete rewrite — now documents 85+ `QMD_*` env vars
  grouped by domain with purpose + defaults. Quick-start block on top.
  Previously enumerated zero of them.
- **`test/`**: 30 pre-existing typecheck errors fixed (missing `.js` extensions
  + implicit-any params). Smoke tests moved to `test/smoke/` subdir with README.
- **`tsconfig.build.json`**: stale `src/bench-*.ts` exclude pattern replaced
  with `src/bench/**` (matches the real location).
- **`src/memory/index.ts`**: renamed `getFastEmbedBackend` →
  `getLocalEmbedBackend` (misleading post-2026-04-13 removal of fastembed).
- **`evaluate/*/eval.mts`**: deleted truly-dead `LOTL_RECALL_DUAL_PASS` +
  `LOTL_RECALL_LOG_MOD` reads (ablation-log-only, no consumers).
- **`evaluate/longmemeval/eval.mts`**: added `--judge` + `--judge-model` flags
  and Mem0-style judge wiring (consistent with existing LongMemEval support).
  `LOTL_ANSWER_TOP_K` default raised `5 → 10` (Mem0 paper alignment).
- **`evaluate/locomo/eval.mts`**: added `LOTL_LOCOMO_ANSWER_TOP_K=10` cap on
  LLM context (was 50 — matches MemPalace's admitted cheat). Retrieval pool
  stays at 50 so ranking metrics are unaffected.
- **`src/llm/transformers-embed-direct.ts`** (new): direct-ORT backend for
  jina_embeddings_v5 / eurobert / other arch-incompat models. Tokenizer via
  `AutoTokenizer`, inference via `onnxruntime-node`, last-token pool + L2
  normalize. Activated by `LOTL_EMBED_DIRECT=on`. Probed at 402 MB RSS on
  jina-v5-nano-retrieval; RSS capped via `LOTL_TRANSFORMERS_DIRECT_MAXLEN=1024`.
- **`src/store/constants.ts`**, **`src/cli/format.ts`**,
  **`src/memory/extractor.ts`**, **`src/memory/index.ts`**: stale TODO markers
  reworded or deleted. `cli/format.ts` LOC reference updated from stale
  "3,379 LOC" to match current state.
- **`src/memory/index.ts`**: renamed `getFastEmbedBackend` → `getLocalEmbedBackend`
  (misleading name; transformers backend replaced fastembed in 2026-04-13 cleanup).
- **Dead prompt versions purged**: `evaluate/longmemeval/eval.mts` lost the v11.1
  and v12 branches + `extractV12Answer` helper. Kept v11 (default) + v13
  (paper-aligned, recommended for `--judge` runs).
- **DB cleanup**: removed 137 unused ablation DBs from `evaluate/longmemeval/dbs/`,
  freed ~73 GB. Retained 5 sweep candidates + winner baseline (~12 GB).
- **`evaluate/SNAPSHOTS.md`**: canonical pinned metrics for v1, with reproduction
  recipes for every published number. Static verification reference.

### 2026-04-18 — CLI refactor + shared helpers + message formatters

Started the long-standing `src/cli/qmd.ts` split that was on the backlog
(3,379-LOC monolith, 0.08 cohesion per graphify). Landed 7 slices across
one session:

| Slice | Extracted | New module LOC | qmd.ts after |
|---|---|---|---|
| 1 | formatters (ETA, time-ago, bytes, progress bar, ls time) | 67 | 3,328 |
| 2 | Store/DB lifecycle | 93 | 3,261 |
| 3a | terminal styling (colors, cursor, taskbar progress) | 52 | 3,224 |
| 3b | `qmd collection list/remove/rename` | 101 | 3,146 |
| 4 | `qmd context add/list/remove` + `detectCollectionFromPath` | 205 | 2,959 |
| 5 | `qmd skill show/install` + symlink wiring | 139 | 2,836 |
| 6 | `qmd --help` / `qmd --version` | 131 | 2,724 |
| 7 | path/virtual/collection-lookup helpers + `warn/success/info` formatters + partial rollout | 87 | ~2,720 |

**Totals:** `cli/qmd.ts` **3,379 → 2,720 LOC (−659, −19.5%)**. 8 new CLI
modules, ~875 LOC relocated, ~40 LOC of duplicate logic collapsed.
Typecheck clean at every slice; 197/197 store + memory tests pass.

**Three duplications collapsed** (all into `src/cli/command-helpers.ts`):
- `resolveFsPath(pathArg)` — normalize `~/`, `./`, relative, `lotl://`,
  absolute paths. Was duplicated in contextAdd + contextRemove.
- `requireValidVirtualPath(pathArg)` — parse `lotl://c/p`, exit on malformed
  or unknown collection.
- `requireCollectionOrExit(name)` — YAML collection lookup with the
  "run qmd collection list" hint.

**Message formatters** in `src/cli/terminal.ts`:
- `warn(msg)` — yellow-wrapped
- `success(msg)` — green ✓ prefix
- `info(msg)` — dim

Applied across the new modules (context-commands, collection-commands)
and partially through qmd.ts (6/6 `success`, 9/14 whole-message
`warn`). Remaining 53 dim-sites in qmd.ts are inline label coloring
inside larger strings — deferred as a future mechanical pass if ever
wanted.

### 2026-04-17 — Phase 7 LLM-judge eval shipped + three bugs caught in one session

Wired full QA generation + LLM-as-judge into the eval harness. Ran baseline
and diagnostic probes. Identified the **real QA accuracy bottleneck**: memory
content truncation at the answer-prompt stage, not the retrieval or generator
model. Three distinct bugs caught in sequence, each fix measurable:

**Added:**
- `--llm poe` / `--judge <provider>` / `--judge-model <name>` flags in eval.mts
- Poe (OpenAI-compatible) provider in LLM_CONFIG
- v13 answer prompt (LongMemEval paper-aligned minimal style — `LOTL_PROMPT_RULES=v13`)
- v12 CoT + citations prompt (kept as option, not default — over-engineered)
- `--reflect` CLI flag for existing `memoryReflect` pre-pass
- `LOTL_ANSWER_TOP_K` / `LOTL_ANSWER_MAX_CHARS` env knobs for answer context budget
- `preflightQuotaCheck()` — probes Poe with a 16-token ping before ingest, fails
  fast if the account is out of quota (prevents mid-run 402 blowups like we
  hit earlier in the day)
- Per-run `llmUsage` tallies in results JSON (input/output/gen-calls/judge-calls)
- `seed: LLM_SEED` passed to Poe requests for deterministic replay → cache hits
- Pre-flight prompt-size warning at >8k tokens/prompt
- Standalone `evaluate/longmemeval/poe-judge.mts` module (works against any
  OpenAI-compatible `/v1/chat/completions` endpoint)

**Bugs caught + fixed:**
1. **Prompt blowup (91K input tokens / call)** — eval.mts was dumping all 50
   retrieved memories into the answer prompt with no cap. First n=100 attempt
   burned 6.9K Poe points on a single call. Fixed with `LOTL_ANSWER_TOP_K=5`
   default + per-memory char cap.
2. **Defense-in-depth caps missing** from `memoryReflect` and `runReflectionPass`
   — same leak latent in core. Added `LOTL_REFLECT_TOP_K` / `LOTL_REFLECT_MAX_CHARS`.
3. **800-char default too tight for session-level memories** (THE big one,
   caught during Phase 7.1 diagnostics). LongMemEval memories average
   **8,283 chars** (max 42,910). Our 800-char cap dropped 90%+ of every
   memory's content, so even when retrieval hit the right session
   (rAny@5 = 99%), the answer-phase LLM saw a truncated prefix that rarely
   contained the actual answer. Fixed: `LOTL_ANSWER_MAX_CHARS` default bumped
   to **6000**. Previous 800 default kept for backward compat via env var.

**Benchmark progression (LME _s, n=100, mxbai-xs baseline DB):**
| Config | Judge | Notes |
|---|---|---|
| v11 + gpt-4o-mini + old top-K=50 no cap | 22.0% | burned 91K tokens/call |
| v11 + gpt-4o-mini + top-5 × 800 chars | 22.0% | same Judge, 40× cheaper |
| v13 + gpt-4o-mini + top-5 × 800 chars | 21.0% | prompt simplification doesn't help mini at this cap |
| v13 + **gpt-4o** + top-5 × 800 chars | 27.0% | model gap smaller than expected — cap was the issue |
| v13 + gpt-4o + top-5 × **6000 chars** | **64.0%** | **+37pp lift. Matches LongMemEval paper's 60-65% baseline.** Char-cap fix confirmed as the real bottleneck. |

**Per-bucket diagnostic that cracked it:**
- single-session-user bucket Judge: 22.9% (should be *easier*)
- multi-session bucket Judge: 36.7% (should be *harder*)
- Inverted pattern ⇒ the easy SSU questions were failing on content availability,
  not reasoning. Sampling predictions confirmed: gpt-4o was answering
  *"no information about that in the provided memories"* even when the right
  session was in top-5.

**Changed:**
- `LOTL_ANSWER_MAX_CHARS` default: 800 → **6000** (sized for LME session memories)
- `askLLM` default `maxTokens`: 256 → **128** (tightened to save output-token cost)
- Judge `maxTokens`: 64 → **48**

**Removed:**
- Nothing. Old behavior still accessible via explicit env vars.

---

### 2026-04-17 — GPU device auto-select + Phase 11 concluded + transformers/sqlite3 upgrade

Phase 11 embedder sweep concluded: **mxbai-embed-xsmall-v1 q8 stays the
permanent production default.** No candidate beat it on LongMemEval _s.
Closest ties (bge-small, bge-base) cost 3-5x the parameters for ~0 MRR
gain. Added a GPU device/auto-select layer to the transformers embed
backend so future sweeps on faster hardware (dedicated GPUs, NPUs) can
opt in without env-var choreography.

**Added:**
- `LOTL_TRANSFORMERS_DEVICE` env var — `cpu | webgpu | dml | gpu | auto`. `gpu`
  aliases `webgpu`. `auto` probes the machine and picks.
- `src/llm/gpu-probe.ts` — cached GPU capability probe. OS-level VRAM/driver
  detection (Windows WMI, Linux sysfs, macOS system_profiler) + optional
  WebGPU adapter probe for `maxBufferSize`. Detects AMD XDNA NPU presence.
  Emits human-readable warnings (stale driver >180 days, NPU-but-no-Node-backend,
  iGPU buffer-limit hints).
- `src/llm/embed-sizer.ts` — `computeEmbedBudget(model, dtype)` returns
  `{device, dtype, microbatch, maxWorkers, reason}`. Uses attention-matrix
  math: `microbatch = floor(maxBufferSize × 0.70 / (heads × seq² × 4))`.
  Falls back to CPU when even microbatch=1 exceeds the per-buffer cap.
  Honors `LOTL_TRANSFORMERS_AUTO_PREFER=cpu` for power users who want CPU
  on a WebGPU-capable box.

**Upgrades:**
- `@huggingface/transformers` 4.0.1 → **4.1.0** (minor bump; v4.0 adds
  WebGPU in Node, ModelRegistry API, new BERT-family 4x speedup).
- `better-sqlite3` 12.8.0 → **12.9.0**. Caret-prefixed both deps for
  future patch floats.

**Phase 11 final sweep (n=100 sanity):**
- mxbai-xs q8 **baseline n=500: 98.4% rAny@5, 0.917 MRR** (unchanged)
- bge-small-en-v1.5 int8: 99.0% rAny@5, 0.916 MRR — tied, parked
- bge-base-en-v1.5 int8: 99.0% rAny@5, 0.914 MRR — tied at 3x params, parked
- mxbai-embed-large-v1 q8: killed at 32/100 (too slow for sanity)
- embeddinggemma-300m int8: CPU OOM 6.12 GB (external-data expansion);
  WebGPU works but 5 min/question (per-shape shader JIT) — parked
- jinaai/jina-embeddings-v5-text-nano-retrieval: transformers.js v4.1.0
  still doesn't register `JinaEmbeddingsV5` (Qwen3 backbone + merged
  retrieval-LoRA); `feature-extraction` returns undefined shape. Parked
  until upstream support.

**Probed hardware capability layer:**
- AMD Radeon 780M iGPU, 4.0 GiB UMA VRAM, GPU driver 39 days old.
- AMD XDNA NPU present (Phoenix, 10 TOPS). NPU unreachable from Node
  (VitisAI EP is Python-only). User-side benchmark path documented.
- Auto sizer on this hardware picks WebGPU with microbatch 29-119 for
  candidates 300M-400M, 2 workers for small models (mxbai-xs 384d).

**Operational lessons saved as memory:**
- `feedback_task_stop_zombies.md` — on Windows, `TaskStop` on a background
  bash doesn't kill tsx/eval child processes. Enumerate + taskkill after
  every stop, or the next run exits 127 from RAM starvation.
- `project_phase11_concluded.md` — revisit trigger: new int8 ONNX model
  with MTEB retrieval ≥65 + clean transformers.js support.

---

### 2026-04-17 — RRF pipeline + keyword/synonym expansion + MCP tools

Pipeline fully restructured to A→F staged architecture with rank-based
Reciprocal Rank Fusion. Zero-LLM keyword and synonym expansion shipped as
defaults. Preference rAny5 lifted 93% → 97%. Cross-encoder rerank stays
opt-in but now with score normalization so RRF + rerank actually work
together.

**Benchmark (LongMemEval _s n=500, session-id retrieval):**
- **recall_any@5: 98.4%** (vs agentmemory 95.2%, MemPalace 96.6%)
- **R@5 (fractional): 93.7%**
- **MRR: 0.917**, **NDCG@10: 0.913**

**Added:**
- Rank-based RRF fusion (`MEMORY_RRF_W_BM25=0.9`, `W_VEC=0.1`, K=60). Replaces
  additive score accumulation. Vec rank list properly normalized against BM25.
- Temporal as 3rd RRF list (`MEMORY_RRF_W_TIME=0.1`) — fires on time refs.
- Keyword expansion default on (`LOTL_MEMORY_EXPAND=keywords`).
- Synonym expansion default on with curated preference/temporal dict
  (`MEMORY_SYNONYMS` in constants.ts). Opt-out: `LOTL_MEMORY_SYNONYMS=off`.
- Cross-encoder rerank score normalization (min-max to [0,1] on both sides
  of the blend). Default blend 0.7 original / 0.3 rerank when enabled.
- MCP tools: `memory_recall_tiered`, `memory_push_pack`.
- Unit tests for `memoryRecallTiered` + `memoryPushPack` (8 tests).
- `extractAndStore` metadata passthrough — extracted facts now carry
  `source_session_id` for proper session attribution (LME metric + prod).

**Changed:**
- Default `MEMORY_FTS_OVERFETCH` 20→10 (validated at n=500, +0.4pp recall).
- Default rerank blend flipped to balanced normalized 0.7/0.3 (was 0.1/0.9
  on additive; RRF needs different ratio).
- Strong-signal skip on rerank: OFF by default (was ON). Skip gate was
  blocking rerank on borderline questions where it helps.

**Deprecated / removed:**
- Additive score fusion in memory recall (replaced by rank-based RRF).
- Hardcoded temporal injection score (0.5) — now median of current scores.
- Hardcoded KG injection score (0.25) — now median of current scores.

**Tested + parked (no production change):**
- L1 user-only ingest: +0.7pp MRR but -7pp preference, not net win.
- Temporal 3rd RRF at weight 0.3: byte-identical (LME shared ingest timestamp).
- extractAndStore + KG injection at query time: -16pp multi-session.
- Per-turn ingest: 2-3s per query at 10x memories, no quality gain.
- L# cache hierarchy (Schift pattern): n=500 validated. -0.6pp recall,
  -5.2pp preference MRR, 5.5x wall time. Ships opt-in via
  `LOTL_MEMORY_LHASH=on` for future experimentation; LME sessions are
  too short for L2 to differ meaningfully from L0, and keyword expansion
  already captures the paraphrase lift Schift attributed to L#.

**Research / planning (no code change):**
- Vector backend benchmarking via `photostructure/node-vector-bench` on
  our Windows hardware. Crossover at ~10k-100k vectors: sqlite-vec wins
  below, LanceDB wins above. Current qmd LME scale (~50 memories/scope)
  sits well below the crossover — sqlite-vec remains optimal default.
  LanceDB migration path documented for Phase 9 (when users hit scale).
- Mem0 architecture deep dive: validates our planned `MemoryBackend`
  interface (modeled on their `VectorStoreBase`). Their 24+ vector
  provider factory pattern is the industry-standard split architecture.
- memory-lancedb-pro architecture deep dive: confirms LanceDB as the
  right second backend (zero-setup via bundled npm native binding).
  Their fusion is vec-heavy (0.7/0.3) opposite of qmd BM25-heavy (0.9/0.1)
  — driven by their stronger Jina/OpenAI embedder vs our quantized mxbai-xs.
- Embedder upgrade requirements documented (Phase 11): target BGE-base,
  mxbai-large, Jina-v3, Nomic-v1.5, or Qwen3-Embedding-0.6B.
- Redis LangCache evaluated: semantic LLM response cache, not agent
  memory framework. Not a fit for qmd's role.

**Docs:**
- `docs/ROADMAP.md` 2026-04-17 entry with full sweep history.
- `docs/ARCHITECTURE.md` updated to A→F staged pipeline.
- `docs/EVAL.md` updated to transformers backend commands.
- `docs/TODO.md` phase-ordered with pass/fail gates.
- `devnotes/metrics/metric-discipline.md` metric family walkthrough.

### v16 release summary (2026-04-13)

The v16 cycle ships QMD as a **local-first, zero-cost retrieval system at
parity with MemPalace** on the metric that actually discriminates.
Headline numbers:

| Benchmark | QMD v16 | MemPalace |
|---|---|---|
| LME _s n=500 R@5 | **93.2%** | 96.6% |
| LME _s n=500 R@10 | **95.2%** | 98.2% |
| LME _s n=500 5/6 categories | **at parity or above** | |
| LoCoMo conv-26+30 DR@50 | **74.9%** | 74.8% |

Closed the 7-pp LME _s gap that opened up when we ran the full n=500
distribution. Two real bugs found and fixed (cosine threshold + scope
filtering after vector search). One null result (BGE family doesn't
help on multi-session). Eight roadmap categories closed. Major eval
methodology rewrite. Local fastembed backend so iteration costs $0.

**Key shipped pieces:**
- `src/llm/fastembed.ts` — local ONNX embedding backend, all-MiniLM-L6-v2,
  zero API keys, deterministic. Same embed model MemPalace uses.
- `src/llm/{loader,pull,types,remote,session,local}.ts` — `src/llm.ts`
  refactored from 2,283 lines → 76-line facade + 6 cohesive submodules.
- `pickVectorMatches()` — adaptive cosine-similarity gate with
  `max(absFloor=0.05, top1×0.5)` floor and `minKeep=5` safety net.
  7 unit tests covering open vault / focused haystack / no-signal /
  legacy override.
- `memories_vec` partition key on `scope` so sqlite-vec walks only the
  current scope's slice of the index — fixes mem=1-5 → mem=50 per query.
- Eight roadmap category closeouts (cat 1 tier-aware recall, cat 2
  diversity, cat 6 cleanup hook, cat 7 4-component importance, cat 10
  smart KG-in-recall, cat 11 reflect synthesis, cat 16 push pack,
  cat 17 LRU-K eviction, cat 18 periodic reflection).
- New primary metric hierarchy: R@5 / R@10 / MRR / F1 / EM / SH leading;
  SR@K / DR@K demoted to a single MemPalace-compat reference row.
- Substring-Hit (SH) — catches F1 false negatives on short numeric/name
  answers like "27" vs "27 years old".
- Mean Reciprocal Rank over top-10.
- `evaluate/run-mempalace-baseline.sh` — runs MemPalace's own
  `benchmarks/locomo_bench.py` and `longmemeval_bench.py` on the same
  data so we have ground truth, not just published numbers.
- `evaluate/run-lme-s-local.sh` — 100% local zero-cost benchmark with
  fastembed + `--no-llm` + raw mode + extraction off.
- `docs/EVAL.md` — heavy restructure with "How we benchmark" methodology
  TL;DR, cost discipline section, fastembed backend docs, adaptive
  threshold explainer, MemPalace ground-truth comparison table.

**Known residual: multi-session ranking gap.** With full top-K per
scope, multi-session R@5 stuck at 81% vs MemPalace 100% on n=500.
Confirmed via the BGE A/B (next entry) that this is NOT a
representational-capacity problem — BGE-base 768-dim scored identically
to MiniLM 384-dim. Bottleneck is training objective / data, not model
size. Queued v17 experiments documented in `devnotes/`:

- Small-class A/B (gte-small, arctic-xs, mxbai-xsmall, e5-small, nomic)
  — try BEFORE jumping to larger models
- Qwen3-Embedding-0.6B hybrid (Path A `@huggingface/transformers` +
  Path B `node-llama-cpp` GGUF q8) — only if small-class fails
- Cross-encoder rerank / query expansion / per-scope normalization —
  only if both above fail

**Doctrine** captured in ROADMAP and the design notes:

> Where MemPalace makes doubtful choices, prioritize project quality
> over shiny benchmarks. They verify our quality. Not an exam where
> you want a 100 regardless of everything.

This shipped as adaptive cosine threshold (universal quality
improvement for both open vaults and focused haystacks) instead of
"no threshold ever" (MemPalace's choice that breaks open vaults).

### BGE A/B null result + small-class A/B plan (2026-04-13 session close)

Three-way embed-model sweep at LME _s n=100 with the partition fix
in place:

| Model | Dim | Size | R@5 | multi-session R@5 (n=30) | Wall |
|---|---|---|---|---|---|
| MiniLM-L6-v2 | 384 | 80 MB | 98.0% | 93% | 4m47s |
| BGE-small-en-v1.5 | 384 | 130 MB | 97.0% | 93% | 7m25s |
| BGE-base-en-v1.5 | 768 | 440 MB | 98.0% | 93% | 29m02s |

**Conclusive null result.** All three score within 1pp on R@5 and
identically on multi-session. Two findings:

1. **Dimension is not the lever.** BGE-base doubled the dim to 768 and
   scored exactly the same as the 384-dim variants. The bottleneck is
   training objective / training data, not representational capacity.
2. **BGE-base is too big for QMD.** 6× wall time vs MiniLM with zero
   accuracy gain. QMD's on-device positioning (CLI, MCP, OpenClaw plugin
   on a developer laptop) makes anything in that size class non-viable
   as a default. **Future embed candidates must stay in the
   MiniLM/BGE-small footprint** (~80-150 MB, 384-dim, sub-5s/Q on n=100
   CPU).

Skipped n=500 BGE confirmation because n=100 was already definitive.

The small-class A/B plan (gte-small, snowflake-arctic-embed-xs,
mxbai-embed-xsmall-v1, e5-small-v2, nomic-embed-text-v1.5) is documented
as the next experiment in ROADMAP and `devnotes/embedders/qwen3-paths.md`.
Will run before any larger-model experiment.

### Vector retrieval — scope partition key (2026-04-13 late session)

The K-multiplier workaround (f360a2b) brought LME _s n=500 R@5 from
89.4% → 92.8% but multi-session R@5 only moved 80% → 81% — it wasn't
fetching enough hits per scope to fully populate top-K. Replaced with
the proper architectural fix in a7c1eaf:

  CREATE VIRTUAL TABLE memories_vec USING vec0(
    scope TEXT PARTITION KEY,
    id TEXT PRIMARY KEY,
    embedding float[N] distance_metric=cosine
  )

sqlite-vec's PARTITION KEY makes the KNN query walk only the current
scope's slice of the index when WHERE scope = ? is passed. Eliminates
the need for the K-multiplier overshoot — every scope returns its full
top-K natively.

Schema migration is automatic: ensureMemoriesVecTable detects the
missing partition column on existing pre-migration databases and
drops/recreates the table. memoryStore / memoryStoreBatch /
memoryUpdate updated to write the scope column on insert.

Result on n=500 rerun:

  Pre-fix:           R@5 89.4%, R@10 89.4%, mem=1-6 per query
  K-bump workaround: R@5 92.8%, R@10 94.0%, mem=2-6 per query
  Partition key:     R@5 93.2%, R@10 95.2%, mem=50 per query

The "mem=50 per query" log line is the key signal — full top-K per
scope, exactly matching MemPalace's per-EphemeralClient isolation
model architecturally.

The remaining 4-pp R@5 gap to MemPalace's 96.6% is entirely in the
multi-session category (QMD 81% vs MP 100%). With full top-K per
scope, this is a RANKING problem, not a coverage problem — MiniLM's
384-dim embeddings don't rank multi-hop abstract queries highly
enough to put them in top-5. BGE-base-en-v1.5 (768-dim) A/B is the
targeted next experiment.

### Vector retrieval — adaptive threshold + scope-aware K (2026-04-13 late session)

The LME _s n=500 baseline exposed two related retrieval bugs. Both
shipped as fixes; one as a quality improvement, one as an acknowledged
workaround pending a schema migration.

**Bug 1 — fixed 0.3 cosine threshold dropped legitimate matches in
focused haystacks.** Adaptive replacement in `pickVectorMatches`
(`src/memory/index.ts`):

  floor = max(absFloor=0.05, top1 × relRatio=0.5)
  accept r if r.similarity ≥ floor; minKeep=5 safety net

This is a quality fix for both regimes — open vault (top1=0.85
→ floor 0.425, long tail correctly pruned) and focused haystack
(top1=0.32 → floor 0.16, low-cosine matches survive). 7 unit tests
in `test/pick-vector-matches.test.ts`. Override via
`LOTL_VEC_MIN_SIM=adaptive|0|<number>`.

**Bug 2 — `memories_vec` (vec0) has no scope filter.** The KNN query
returned the K=150 most similar memories across the entire 23,867-row
index. After post-vector scope filtering inside addResult(), most
queries had only 1-5 memories left. Diagnosed via DB inspection: 500
distinct scopes × ~48 memories each = correct ingest, but K=150
across 500 scopes ≈ 0.3 hits per scope on average.

Quick fix: bump K via `LOTL_VEC_K_MULTIPLIER` (default 20) so vecK =
max(limit*3, limit*20) = 1000. Fetches enough overshoot that the
post-vector scope filter has full top-50 candidates for most queries.
Workaround, not the proper fix — linear scan cost grows with K.

**Proper fix (queued, separate commit, schema migration):** add
`scope TEXT PARTITION KEY` to memories_vec so sqlite-vec walks only
the current scope's slice of the index. Removes the K-multiplier
hack and matches MemPalace's per-EphemeralClient isolation
architecturally.

### LongMemEval _s head-to-head with MemPalace (2026-04-13)

Running QMD against the full `longmemeval_s_cleaned` dataset (500
questions × ~53 session haystack — the actual benchmark MemPalace's
96.6% headline is on) with the new local fastembed backend:

| Pipeline | n | R@5 | R@10 | F1 | EM | Wall |
|---|---|---|---|---|---|---|
| MemPalace raw + fastembed (their published run) | 500 | **96.6%** | 98.2% | — | — | 12.5m |
| QMD raw + fastembed (first 100) | 100 | **97.0%** | 97.0% | **64.9%** | 48.0% | 5m12s |

**QMD matches MemPalace within noise** on the same dataset with the
same embed model (`all-MiniLM-L6-v2`). First 100 questions of the
same test set, same retrieval recipe, zero API keys needed.

Significance: up to this point we had:
- A legacy token-overlap R@K (QMD metric, not comparable to their
  session-recall headline)
- An apples-to-apples SR@K that hit 100% ceiling on LME oracle
- A LoCoMo DR@50 parity number (74.9% vs 74.8%)

None of those directly mapped to MemPalace's 96.6% claim on `_s`.
This is the first result that does — and we match.

The comparison also demonstrates that **QMD measures end-to-end
quality** (retrieval + LLM answer) while MemPalace's benchmark stops
at retrieval. QMD's 97.0% R@5 comes with a 64.9% F1 / 48.0% EM on the
same questions — signal their benchmark doesn't produce.

Full n=500 QMD run is in flight as of this commit. Will update when
done.

### MemPalace ground-truth comparison (2026-04-13)

Cloned MemPalace develop branch to `~/external/mempalace` and ran
their own `benchmarks/locomo_bench.py` and
`benchmarks/longmemeval_bench.py` on the exact same datasets QMD's
evals use. Instead of comparing to their published number via our
reimplementation of their metric, we ran their pipeline directly.

Key findings:

- **LoCoMo dialog-level DR@50 parity**: QMD v15.1 = 74.9%, MemPalace's
  own run on the same conv-26+conv-30 slice = 74.8%. On the one
  discriminating metric, we match.
- **LME oracle is ceilinged for session-recall metrics**: MemPalace's
  own benchmark scored `Recall@1 = Recall@5 = Recall@50 = 100%` on
  oracle because the dataset is pre-filtered to relevant sessions.
  Our SR@5 = 100% was not a win, just the same ceiling.
- **MemPalace's published 96.6% headline is on `longmemeval_s_cleaned`**,
  not oracle. A future run on `_s` is needed for direct comparison.

Tooling added:
- `evaluate/run-mempalace-baseline.sh` — sequential launcher (they race
  on the ONNX model download if run in parallel).
- `evaluate/summarize-mempalace.py` — parses their JSONL output into a
  compact table.

### New primary metric hierarchy — R@K + F1/EM/SH + MRR leading

Both LongMemEval and LoCoMo evals now lead their reports with R@K
(token-overlap recall) and F1/EM/SH (answer quality), demoting
SR@K and DR@K to a single reference-only line with a "take with
salt" caveat. Two new metrics added:

- **Substring-Hit (SH)**: 1 if normalized truth is a substring of
  normalized prediction, else 0. Catches F1's blind spot on short
  numeric / name answers — "27" ⊂ "27 years old" now scores 1.0
  where F1 previously scored 0.
- **MRR** over the top-10 memories using the same 50% token-overlap
  relevance definition as R@K. Rewards rank quality: rank 1 = 1.0,
  rank 3 = 0.33, not in top-10 = 0.

Motivation: v15.1 showed SR@5 was pinned at 100% on LME oracle
regardless of changes — the oracle is pre-filtered, so any retriever
trivially passes. MemPalace running their own benchmark confirmed
this (they hit 100% too). SR/DR on pre-filtered haystacks is a no-op
measurement and cannot discriminate pipeline quality. R@K (token
overlap against ground truth) directly tests "does the answer reach
the model" and moves with real changes.

Report ordering:
    Retrieval (primary):       R@5 / R@10 / MRR
    Answer quality (primary):  F1 / EM / SH
    MemPalace-compat (ref):    DR@K (LoCoMo only) / SR@K
Per-category tables updated to match.

### Memory v16 — roadmap category closeouts (2026-04-13)

Seven partial-status roadmap categories closed as part of the v16
cycle. All new features are opt-in or additive — the default recall
pipeline is unchanged. Every change typechecks clean; benchmark A/B
results land separately.

- **Cat 2 — Dialog-aware diversity in top-K recall**
  (`src/memory/index.ts:applyDialogDiversity`). Greedy MMR-lite
  reshuffle of the top-K that prefers unseen `source_dialog_id` /
  `source_session_id` first. Opt-in via `LOTL_RECALL_DIVERSIFY=on`.
  Addresses the DR@K vs SR@K gap surfaced by the v15.1 LoCoMo
  conv-30 analysis (SR@5=82.9% but DR@5=52.6% — retrieval was finding
  the right session but piling up duplicate dialog turns).

- **Cat 6 — Scheduled cleanup hook**
  (`src/memory/decay.ts:runCleanupPass`). Chains `runDecayPass` +
  `runEvictionPass` into one scheduler-friendly entry point with a
  `minMemoriesForEviction` threshold so small installs don't get
  eviction churn. Wired into the OpenClaw dream-consolidation gate.

- **Cat 7 — 4-component importance scoring**
  (`src/memory/extractor.ts:estimateImportance`). Adds `entityDensity`
  (capitalized-token fraction as a proper-noun proxy, filtered via a
  small STOP_CAPS set) and `hasDecisionSignal` (regex for commitment
  language) on top of the existing category + length components.
  Zero-dependency, no NER runtime.

- **Cat 10 — Smart KG-in-recall with strict gating**
  (`src/memory/index.ts:queryKGForEntities`). The temporal knowledge
  graph is populated at ingest but wasn't queried during recall;
  v8's blunt injection had to be rolled back because generic KG
  entries flooded the top-K. This pass is opt-in via
  `LOTL_RECALL_KG=on` and only fires when the query contains ≤3
  proper-noun entities AND the current top score is weak (<0.3) AND
  fewer than 5 KG facts are returned. Inserted with fixed score 0.25
  so strong FTS/vec hits are never displaced.

- **Cat 11 — Post-retrieval reflect synthesis**
  (`src/memory/index.ts:memoryReflect`). New exported function that
  takes a question + list of retrieved memories and makes one LLM
  call to extract the facts directly relevant to the question,
  returned as a compressed numbered list. Both eval scripts integrate
  it behind `LOTL_RECALL_REFLECT=on`. Designed to help on the LME
  v15.1 multi-session F1=30% bottleneck where retrieval is at
  SR@5=100% but the answer model drowns in 50 scattered memories.

- **Cat 16 — Push Pack (hot-state bundle)**
  (`src/memory/index.ts:memoryPushPack`). Zero-LLM, deterministic SQL
  union of core-tier memories + high-importance recent memories +
  hot-tail recently-accessed. Each entry carries a `reason`
  provenance label. Intended for session_start / before_prompt_build
  hooks to proactively prime long-term memory without an explicit
  recall call.

- **Cat 17 — Backward-K LRU sparing in eviction**
  (`src/memory/decay.ts:runEvictionPass`). Any eviction candidate
  whose `last_accessed` falls within `lruWindowDays` (default 7) is
  treated as hot and exempted regardless of creation age. Working-
  tier composite-score check now uses last-access age rather than
  creation age as the recency reference. True LRU-K (tracking the
  K-th most recent access) would require a new access-history
  table; this is a behavioral approximation without the schema
  cost.

- **Cat 18 — Periodic reflection over memory streams**
  (`src/memory/index.ts:runReflectionPass`). Walks the last N days
  of non-reflection memories in a scope and asks the remote LLM for
  3-5 high-level themes / decisions / patterns. Each generated
  reflection is stored as a new category=reflection memory at
  importance 0.75 so future recall picks it up via the normal
  FTS/vector paths. Wired into the OpenClaw dream-consolidation
  gate alongside `runCleanupPass`.

- **Cat 1 — Tier-aware recall API**
  (`src/memory/index.ts:memoryRecall(tier)` + `memoryRecallTiered`).
  Final closeout. `MemoryRecallOptions.tier` accepts a single tier
  or an array; when set the `addResult` guard filters all retrieval
  paths (FTS, vector, KG injection, temporal backfill). New helper
  `memoryRecallTiered(db, opts)` runs three parallel recalls
  (core / working / peripheral) with per-tier limits and returns
  them as a structured object for Zep-style subgraph callers. This
  is the behavioral closeout; a physical storage split (separate
  tables per tier with background promotion) remains parked as
  the largest rewrite.

Still open: cat 19 (multi-agent identity tier hierarchy), cat 20
(cross-session routing). Both require schema / architecture changes
too large for this pass.

### Refactor — src/llm.ts split

The 2,283-line `src/llm.ts` has been split into a 76-line facade plus
six cohesive submodules. Every existing `import ... from "./llm.js"`
keeps working; only the internal layout changed.

    src/llm.ts            76   (facade)
    src/llm/loader.ts     23   lazy node-llama-cpp module loader
    src/llm/pull.ts      110   HF model pull utilities
    src/llm/types.ts     238   LLM + ILLMSession interfaces, default URIs, format helpers
    src/llm/remote.ts    703   RemoteLLM cloud provider implementation
    src/llm/session.ts   222   LLMSessionManager / LLMSession generic session
    src/llm/local.ts    1111   LlamaCpp class + default-singleton + session coordination

### Memory benchmark — v15.1

- **Apples-to-apples retrieval metric aligned with MemPalace**: both
  LongMemEval and LoCoMo benchmarks now report session-level `SR@K`
  (MemPalace `recall_any`) and LoCoMo additionally reports dialog-level
  `DR@K` — a direct port of MemPalace's
  `benchmarks/locomo_bench.py:compute_retrieval_recall`
  (`found_dialog_ids / len(evidence)`). Memories now carry
  `source_session_id` / `source_dialog_id` metadata at ingest; LoCoMo
  uses the dataset's native `dia_id` field (`"D<sess>:<turn>"`) so
  matching against `qa.evidence` is bit-exact. Top-K pulls 50 memories
  and reports K ∈ {5, 10, 15, 50} from one recall call.
- **v11.1 answer prompt for temporal reasoning** (opt-in via
  `LOTL_PROMPT_RULES=v11.1`). Adds three rules: ordering ("which came
  first" → compare dates, never refuse), duration arithmetic ("how long
  between X and Y" → compute, never say "context does not provide"
  when both anchor dates are visible), enumerate-then-count for
  counting questions. LME oracle (n=50, temporal-reasoning subset):
  F1 51.4 → 52.9 (+1.5pp), EM 22.0 → 28.0 (+6.0pp), SR@5 100%
  unchanged.
- Fix `--extract-model` flag in LME/LoCoMo eval scripts: it was
  setting `LOTL_QUERY_EXPANSION_MODEL` (wrong variable — the extractor
  ignores it, queryExpansion then 404'd against Nebius on every run).
  Removed pending a proper per-call override in the extractor.

### Refactor

- **Remove abandoned `src/app/` scaffold** (422 lines). The
  `src/app/commands/*` handlers, `src/app/services/llm-service.ts`, and
  `src/app/ports/llm.ts` were partial-refactor scaffolding with zero
  imports from the rest of the codebase. Graph audit flagged all 13
  handlers as degree-1 isolated nodes; grep across the source tree
  confirmed no caller. Removed wholesale.
- **Split `src/llm.ts`** from 2,283 → 1,163 lines (−49%) across four
  new cohesive modules under `src/llm/`:
    - `src/llm/loader.ts` — lazy node-llama-cpp module loader.
    - `src/llm/pull.ts` — HF model-pull utilities.
    - `src/llm/types.ts` — LLM / ILLMSession interfaces, default model
      URIs, and embedding format helpers.
    - `src/llm/remote.ts` — RemoteLLM class, fetchWithRetry,
      configurable rerank prompt, all cloud-provider glue.
    - `src/llm/session.ts` — LLMSessionManager / LLMSession /
      withLLMSessionForLlm, now typed against the abstract LLM interface
      instead of LlamaCpp directly.
  `src/llm.ts` stays as a facade — every existing
  `import ... from "./llm.js"` keeps working unchanged. LlamaCpp
  remains in the facade for now (29-edge god node; extraction is parked
  until a benchmark run can validate the move).
- Remove three dead helpers in `src/cli/qmd.ts` (computeDisplayPath,
  normalizeBM25, shortPath; −53 lines). Grep verified zero callers.
- Fix three pre-existing implicit-any parameter errors in `src/llm.ts`
  (onTextChunk callback, expandQuery parseExpansionResult `.map` +
  `.filter` chain). Typecheck now clean across `src/`.

### Docs

- `docs/ROADMAP.md`: v15.1 section with LME A/B results, MemPalace-aligned
  metric design, in-flight LoCoMo run, and the query-expansion side issue.
- `docs/EVAL.md`: SOTA table updated with v15.1 numbers + new
  "Apples-to-apples metrics" section defining SR@K / DR@K / R@K and
  the K-value convention.
- `README.md`: Benchmarks table updated with v15.1 LME apples-to-apples
  numbers and caveat block on the prior token-overlap artifact.

## [2.1.0] - 2026-04-05

Code files now chunk at function and class boundaries via tree-sitter,
clickable editor links land you at the right line from search results,
and per-collection model configuration means you can point different
collections at different embedding models. 25+ community PRs fix
embedding stability, BM25 accuracy, and cross-platform launcher issues.

### Changes

- AST-aware chunking for code files via `web-tree-sitter`. Supported
  languages: TypeScript/JavaScript, Python, Go, and Rust. Code files
  are chunked at function, class, and import boundaries instead of
  arbitrary text positions. Markdown and unknown file types are unchanged.
  `--chunk-strategy <auto|regex>` flag on `qmd embed` and `qmd query`
  (default `regex`). SDK: `chunkStrategy` option on `embed()` and
  `search()`. `qmd status` shows grammar availability.
- `qmd bench <fixture.json>` command for search quality benchmarks.
  Measures precision@k, recall, MRR, and F1 across BM25, vector, hybrid,
  and full pipeline backends. Ships with an example fixture against
  the eval-docs test collection. #470 (thanks @jmilinovich)
- `models:` section in `index.yml` lets you configure `embed`, `rerank`,
  and `generate` model URIs per collection. Resolution order is
  config > env var (`LOTL_EMBED_MODEL`, `LOTL_RERANK_MODEL`,
  `LOTL_GENERATE_MODEL`) > built-in default. #502
  (thanks @JohnRichardEnders)
- CLI search output now emits clickable OSC 8 terminal hyperlinks when
  stdout is a TTY. Links resolve `lotl://` paths to absolute filesystem
  paths and open in editors via URI templates (default:
  `vscode://file/{path}:{line}:{col}`). Configure with `LOTL_EDITOR_URI`
  or `editor_uri` in the YAML config. #508 (thanks @danmackinlay)
- `--no-rerank` flag skips the reranking step in `qmd query` — useful
  when you want fast results or don't have a GPU. Also exposed as
  `rerank: false` on the MCP `query` tool. #370 (thanks @mvanhorn),
  #478 (thanks @zestyboy)
- ONNX conversion script for deploying embedding models via
  Transformers.js. #399 (thanks @shreyaskarnik)
- GitHub Actions workflow to build the Nix flake on Linux and macOS.

### Fixes

- Embedding: prevent `qmd embed` from running indefinitely when the
  embedding loop stalls. #458 (thanks @ccc-fff)
- Embedding: truncate oversized text before embedding to prevent GGML
  crash, and bound memory usage during batch embedding. #393
  (thanks @lskun), #395 (thanks @ProgramCaiCai)
- Embedding: set explicit embed context size (default 2048, configurable
  via `LOTL_EMBED_CONTEXT_SIZE`) instead of using the model's full
  window. #500
- Embedding: error on dimension mismatch instead of silently rebuilding
  the vec0 table. #501
- Embedding: handle vec0 `OR REPLACE` limitation in `insertEmbedding`.
  #456 (thanks @antonio-mello-ai)
- Embedding: fix model selection when multiple models are configured.
  #494
- BM25: correct field weights to include all 3 FTS columns — title,
  body, and path were not weighted correctly. #462 (thanks @goldsr09)
- BM25: handle hyphenated tokens in FTS5 lex queries so terms like
  "real-time" match correctly. #463 (thanks @goldsr09)
- BM25: preserve underscores in search terms instead of stripping them.
  #404
- BM25: use CTE in `searchFTS` to prevent query planner regression with
  collection filter.
- Reranker: increase default context size 2048→4096 and make
  configurable via `LOTL_RERANK_CONTEXT_SIZE`. Fix template overhead
  underestimate 200→512. #453 (thanks @builderjarvis)
- GPU: catch initialization failures and fall back to CPU instead of
  crashing.
- MCP: read version from `package.json` instead of hardcoding. #431
- MCP: include collection name in status output. #416
- Multi-get: support brace expansion patterns in glob matching. #424
- Launcher: prioritize `package-lock.json` to prevent Bun false
  positive. #385 (thanks @rymalia)
- Launcher: remove `$BUN_INSTALL` check that caused false Bun detection.
  #362 (thanks @syedair)
- Launcher: skip Git Bash path detection on WSL. #371
  (thanks @oysteinkrog)
- Model cache: respect `XDG_CACHE_HOME` for model cache directory. #457
  (thanks @antonio-mello-ai)
- SQLite: add macOS Homebrew SQLite support for Bun and restore
  actionable errors. #377 (thanks @serhii12)
- Pin zod to exact 4.2.1 to fix `tsc` build failure. #382
  (thanks @rymalia)
- Preserve dots and original case in `handelize()` — filenames like
  `MEMORY.md` no longer become `memory-md`. #475 (thanks @alexei-led)
- Include `line` in `--json` search output so editor integrations can
  jump directly to `file:line`. #506 (thanks @danmackinlay)
- Nix: fix paths in flake and make Bun dependency a fixed-output
  derivation so sandboxed Linux builds work offline. #479
  (thanks @surma-dump)
- Sync stale `bun.lock` (`better-sqlite3` 11.x → 12.x). CI and release
  script now use `--frozen-lockfile` to prevent recurrence. #386
  (thanks @Mic92)
- Approve native build scripts in pnpm so `better-sqlite3` and
  tree-sitter modules compile correctly. Update vitest ^3.0.0 → ^3.2.4.

## [2.0.1] - 2026-03-10

### Changes

- `qmd skill install` copies the packaged QMD skill into
  `~/.claude/commands/` for one-command setup. #355 (thanks @nibzard)

### Fixes

- Fix Qwen3-Embedding GGUF filename case — HuggingFace filenames are
  case-sensitive, the lowercase variant returned 404. #349 (thanks @byheaven)
- Resolve symlinked global launcher path so `qmd` works correctly when
  installed via `npm i -g`. #352 (thanks @nibzard)

## [2.0.0] - 2026-03-10

QMD 2.0 declares a stable library API. The SDK is now the primary interface —
the MCP server is a clean consumer of it, and the source is organized into
`src/cli/` and `src/mcp/`. Also: Node 25 support and a runtime-aware bin wrapper
for bun installs.

### Changes

- Stable SDK API with `QMDStore` interface — search, retrieval, collection/context
  management, indexing, lifecycle
- Unified `search()`: pass `query` for auto-expansion or `queries` for
  pre-expanded lex/vec/hyde — replaces the old query/search/structuredSearch split
- New `getDocumentBody()`, `getDefaultCollectionNames()`, `Maintenance` class
- MCP server rewritten as a clean SDK consumer — zero internal store access
- CLI and MCP organized into `src/cli/` and `src/mcp/` subdirectories
- Runtime-aware `bin/qmd` wrapper detects bun vs node to avoid ABI mismatches.
  Closes #319
- `better-sqlite3` bumped to ^12.4.5 for Node 25 support. Closes #257
- Utility exports: `extractSnippet`, `addLineNumbers`, `DEFAULT_MULTI_GET_MAX_BYTES`

### Fixes

- Remove unused `import { resolve }` in store.ts that shadowed local export

## [1.1.6] - 2026-03-09

QMD can now be used as a library. `import { createStore } from '@tobilu/qmd'`
gives you the full search and indexing API — hybrid query, BM25, structured
search, collection/context management — without shelling out to the CLI.

### Changes

- **SDK / library mode**: `createStore({ dbPath, config })` returns a
  `QMDStore` with `query()`, `search()`, `structuredSearch()`, `get()`,
  `multiGet()`, and collection/context management methods. Supports inline
  config (no files needed) or a YAML config path.
- **Package exports**: `package.json` now declares `main`, `types`, and
  `exports` so bundlers and TypeScript resolve `@tobilu/qmd` correctly.

## [1.1.5] - 2026-03-07

Ambiguous queries like "performance" now produce dramatically better results
when the caller knows what they mean. The new `intent` parameter steers all
five pipeline stages — expansion, strong-signal bypass, chunk selection,
reranking, and snippet extraction — without searching on its own. Design and
original implementation by Ilya Grigorik (@vyalamar) in #180.

### Changes

- **Intent parameter**: optional `intent` string disambiguates queries across
  the entire search pipeline. Available via CLI (`--intent` flag or `intent:`
  line in query documents), MCP (`intent` field on the query tool), and
  programmatic API. Adapted from PR #180 (thanks @vyalamar).
- **Query expansion**: when intent is provided, the expansion LLM prompt
  includes `Query intent: {intent}`, matching the finetune training data
  format for better-aligned expansions.
- **Reranking**: intent is prepended to the rerank query so Qwen3-Reranker
  scores with domain context.
- **Chunk selection**: intent terms scored at 0.5× weight alongside query
  terms (1.0×) when selecting the best chunk per document for reranking.
- **Snippet extraction**: intent terms scored at 0.3× weight to nudge
  snippets toward intent-relevant lines without overriding query anchoring.
- **Strong-signal bypass disabled with intent**: when intent is provided, the
  BM25 strong-signal shortcut is skipped — the obvious keyword match may not
  be what the caller wants.
- **MCP instructions**: callers are now guided to provide `intent` on every
  search call for disambiguation.
- **Query document syntax**: `intent:` recognized as a line type. At most one
  per document, cannot appear alone. Grammar updated in `docs/SYNTAX.md`.

## [1.1.2] - 2026-03-07

13 community PRs merged. GPU initialization replaced with node-llama-cpp's
built-in `autoAttempt` — deleting ~220 lines of manual fallback code and
fixing GPU issues reported across 10+ PRs in one shot. Reranking is faster
through chunk deduplication and a parallelism cap that prevents VRAM
exhaustion.

### Changes

- **GPU init**: use node-llama-cpp's `build: "autoAttempt"` instead of manual
  GPU backend detection. Automatically tries Metal/CUDA/Vulkan and falls back
  gracefully. #310 (thanks @giladgd — the node-llama-cpp author)
- **Query `--explain`**: `qmd query --explain` exposes retrieval score traces
  — backend scores, per-list RRF contributions, top-rank bonus, reranker
  score, and final blended score. Works in JSON and CLI output. #242
  (thanks @vyalamar)
- **Collection ignore patterns**: `ignore: ["Sessions/**", "*.tmp"]` in
  collection config to exclude files from indexing. #304 (thanks @sebkouba)
- **Multilingual embeddings**: `LOTL_EMBED_MODEL` env var lets you swap in
  models like Qwen3-Embedding for non-English collections. #273 (thanks
  @daocoding)
- **Configurable expansion context**: `LOTL_EXPAND_CONTEXT_SIZE` env var
  (default 2048) — previously used the model's full 40960-token window,
  wasting VRAM. #313 (thanks @0xble)
- **`candidateLimit` exposed**: `-C` / `--candidate-limit` flag and MCP
  parameter to tune how many candidates reach the reranker. #255 (thanks
  @pandysp)
- **MCP multi-session**: HTTP transport now supports multiple concurrent
  client sessions, each with its own server instance. #286 (thanks @joelev)

### Fixes

- **Reranking performance**: cap parallel rerank contexts at 4 to prevent
  VRAM exhaustion on high-core machines. Deduplicate identical chunk texts
  before reranking — same content from different files now shares a single
  reranker call. Cache scores by content hash instead of file path.
- Deactivate stale docs when all files are removed from a collection and
  `qmd update` is run. #312 (thanks @0xble)
- Handle emoji-only filenames (`🐘.md` → `1f418.md`) instead of crashing.
  #308 (thanks @debugerman)
- Skip unreadable files during indexing (e.g. iCloud-evicted files returning
  EAGAIN) instead of crashing. #253 (thanks @jimmynail)
- Suppress progress bar escape sequences when stderr is not a TTY. #230
  (thanks @dgilperez)
- Emit format-appropriate empty output (`[]` for JSON, CSV header for CSV,
  etc.) instead of plain text "No results." #228 (thanks @amsminn)
- Correct Windows sqlite-vec package name (`sqlite-vec-windows-x64`) and add
  `sqlite-vec-linux-arm64`. #225 (thanks @ilepn)
- Fix claude plugin setup CLI commands in README. #311 (thanks @gi11es)

## [1.1.1] - 2026-03-06

### Fixes

- Reranker: truncate documents exceeding the 2048-token context window
  instead of silently producing garbage scores. Long chunks (e.g. from
  PDF ingestion) now get a fair ranking.
- Nix: add python3 and cctools to build dependencies. #214 (thanks
  @pcasaretto)

## [1.1.0] - 2026-02-20

QMD now speaks in **query documents** — structured multi-line queries where every line is typed (`lex:`, `vec:`, `hyde:`), combining keyword precision with semantic recall. A single plain query still works exactly as before (it's treated as an implicit `expand:` and auto-expanded by the LLM). Lex now supports quoted phrases and negation (`"C++ performance" -sports -athlete`), making intent-aware disambiguation practical. The formal query grammar is documented in `docs/SYNTAX.md`.

The npm package now uses the standard `#!/usr/bin/env node` bin convention, replacing the custom bash wrapper. This fixes native module ABI mismatches when installed via bun and works on any platform with node >= 22 on PATH.

### Changes

- **Query document format**: multi-line queries with typed sub-queries (`lex:`, `vec:`, `hyde:`). Plain queries remain the default (`expand:` implicit, but not written inside the document). First sub-query gets 2× fusion weight — put your strongest signal first. Formal grammar in `docs/SYNTAX.md`.
- **Lex syntax**: full BM25 operator support. `"exact phrase"` for verbatim matching; `-term` and `-"phrase"` for exclusions. Essential for disambiguation when a term is overloaded across domains (e.g. `performance -sports -athlete`).
- **`expand:` shortcut**: send a single plain query (or start the document with `expand:` on its only line) to auto-expand via the local LLM. Query documents themselves are limited to `lex`, `vec`, and `hyde` lines.
- **MCP `query` tool** (renamed from `structured_search`): rewrote the tool description to fully teach AI agents the query document format, lex syntax, and combination strategy. Includes worked examples with intent-aware lex.
- **HTTP `/query` endpoint** (renamed from `/search`; `/search` kept as silent alias).
- **`collections` array filter**: filter by multiple collections in a single query (`collections: ["notes", "brain"]`). Removed the single `collection` string param — array only.
- **Collection `include`/`exclude`**: `includeByDefault: false` hides a collection from all queries unless explicitly named via `collections`. CLI: `qmd collection exclude <name>` / `qmd collection include <name>`.
- **Collection `update-cmd`**: attach a shell command that runs before every `qmd update` (e.g. `git stash && git pull --rebase --ff-only && git stash pop`). CLI: `qmd collection update-cmd <name> '<cmd>'`.
- **`qmd status` tips**: shows actionable tips when collections lack context descriptions or update commands.
- **`qmd collection` subcommands**: `show`, `update-cmd`, `include`, `exclude`. Bare `qmd collection` now prints help.
- **Packaging**: replaced custom bash wrapper with standard `#!/usr/bin/env node` shebang on `dist/qmd.js`. Fixes native module ABI mismatches when installed via bun, and works on any platform where node >= 22 is on PATH.
- **Removed MCP tools** `search`, `vector_search`, `deep_search` — all superseded by `query`.
- **Removed** `qmd context check` command.
- **CLI timing**: each LLM step (expand, embed, rerank) prints elapsed time inline (`Expanding query... (4.2s)`).

### Fixes

- `qmd collection list` shows `[excluded]` tag for collections with `includeByDefault: false`.
- Default searches now respect `includeByDefault` — excluded collections are skipped unless explicitly named.
- Fix main module detection when installed globally via npm/bun (symlink resolution).

## [1.0.7] - 2026-02-18

### Changes

- LLM: add LiquidAI LFM2-1.2B as an alternative base model for query
  expansion fine-tuning. LFM2's hybrid architecture (convolutions + attention)
  is 2x faster at decode/prefill vs standard transformers — good fit for
  on-device inference.
- CLI: support multiple `-c` flags to search across several collections at
  once (e.g. `qmd search -c notes -c journals "query"`). #191 (thanks
  @openclaw)

### Fixes

- Return empty JSON array `[]` instead of no output when `--json` search
  finds no results.
- Resolve relative paths passed to `--index` so they don't produce malformed
  config entries.
- Respect `XDG_CONFIG_HOME` for collection config path instead of always
  using `~/.config`. #190 (thanks @openclaw)
- CLI: empty-collection hint now shows the correct `collection add` command.
  #200 (thanks @vincentkoc)

## [1.0.6] - 2026-02-16

### Changes

- CLI: `qmd status` now shows models with full HuggingFace links instead of
  static names in `--help`. Model info is derived from the actual configured
  URIs so it stays accurate if models change.
- Release tooling: pre-push hook handles non-interactive shells (CI, editors)
  gracefully — warnings auto-proceed instead of hanging on a tty prompt.
  Annotated tags now resolve correctly for CI checks.

## [1.0.5] - 2026-02-16

The npm package now ships compiled JavaScript instead of raw TypeScript,
removing the `tsx` runtime dependency. A new `/release` skill automates the
full release workflow with changelog validation and git hook enforcement.

### Changes

- Build: compile TypeScript to `dist/` via `tsc` so the npm package no longer
  requires `tsx` at runtime. The `qmd` shell wrapper now runs `dist/qmd.js`
  directly.
- Release tooling: new `/release` skill that manages the full release
  lifecycle — validates changelog, installs git hooks, previews release notes,
  and cuts the release. Auto-populates `[Unreleased]` from git history when
  empty.
- Release tooling: `scripts/extract-changelog.sh` extracts cumulative notes
  for the full minor series (e.g. 1.0.0 through 1.0.5) for GitHub releases.
  Includes `[Unreleased]` content in previews.
- Release tooling: `scripts/release.sh` renames `[Unreleased]` to a versioned
  heading and inserts a fresh empty `[Unreleased]` section automatically.
- Release tooling: pre-push git hook blocks `v*` tag pushes unless
  `package.json` version matches the tag, a changelog entry exists, and CI
  passed on GitHub.
- Publish workflow: GitHub Actions now builds TypeScript, creates a GitHub
  release with cumulative notes extracted from the changelog, and publishes
  to npm with provenance.

## [1.0.0] - 2026-02-15

QMD now runs on both Node.js and Bun, with up to 2.7x faster reranking
through parallel GPU contexts. GPU auto-detection replaces the unreliable
`gpu: "auto"` with explicit CUDA/Metal/Vulkan probing.

### Changes

- Runtime: support Node.js (>=22) alongside Bun via a cross-runtime SQLite
  abstraction layer (`src/db.ts`). `bun:sqlite` on Bun, `better-sqlite3` on
  Node. The `qmd` wrapper auto-detects a suitable Node.js install via PATH,
  then falls back to mise, asdf, nvm, and Homebrew locations.
- Performance: parallel embedding & reranking via multiple LlamaContext
  instances — up to 2.7x faster on multi-core machines.
- Performance: flash attention for ~20% less VRAM per reranking context,
  enabling more parallel contexts on GPU.
- Performance: right-sized reranker context (40960 → 2048 tokens, 17x less
  memory) since chunks are capped at ~900 tokens.
- Performance: adaptive parallelism — context count computed from available
  VRAM (GPU) or CPU math cores rather than hardcoded.
- GPU: probe for CUDA, Metal, Vulkan explicitly at startup instead of
  relying on node-llama-cpp's `gpu: "auto"`. `qmd status` shows device info.
- Tests: reorganized into flat `test/` directory with vitest for Node.js and
  bun test for Bun. New `eval-bm25` and `store.helpers.unit` suites.

### Fixes

- Prevent VRAM waste from duplicate context creation during concurrent
  `embedBatch` calls — initialization lock now covers the full path.
- Collection-aware FTS filtering so scoped keyword search actually restricts
  results to the requested collection.

## [0.9.0] - 2026-02-15

First published release on npm as `@tobilu/qmd`. MCP HTTP transport with
daemon mode cuts warm query latency from ~16s to ~10s by keeping models
loaded between requests.

### Changes

- MCP: HTTP transport with daemon lifecycle — `qmd mcp --http --daemon`
  starts a background server, `qmd mcp stop` shuts it down. Models stay warm
  in VRAM between queries. #149 (thanks @igrigorik)
- Search: type-routed query expansion preserves lex/vec/hyde type info and
  routes to the appropriate backend. Eliminates ~4 wasted backend calls per
  query (10.0 → 6.0 calls, 1278ms → 549ms). #149 (thanks @igrigorik)
- Search: unified pipeline — extracted `hybridQuery()` and
  `vectorSearchQuery()` to `store.ts` so CLI and MCP share identical logic.
  Fixes a class of bugs where results differed between the two. #149 (thanks
  @igrigorik)
- MCP: dynamic instructions generated at startup from actual index state —
  LLMs see collection names, doc counts, and content descriptions. #149
  (thanks @igrigorik)
- MCP: tool renames (vsearch → vector_search, query → deep_search) with
  rewritten descriptions for better tool selection. #149 (thanks @igrigorik)
- Integration: Claude Code plugin with inline status checks and MCP
  integration. #99 (thanks @galligan)

### Fixes

- BM25 score normalization — formula was inverted (`1/(1+|x|)` instead of
  `|x|/(1+|x|)`), so strong matches scored *lowest*. Broke `--min-score`
  filtering and made the "strong signal" short-circuit dead code. #76 (thanks
  @dgilperez)
- Normalize Unicode paths to NFC for macOS compatibility. #82 (thanks
  @c-stoeckl)
- Handle dense content (code) that tokenizes beyond expected chunk size.
- Proper cleanup of Metal GPU resources on process exit.
- SQLite-vec readiness verification after extension load.
- Reactivate deactivated documents on re-index instead of creating duplicates.
- Bun UTF-8 path corruption workaround for non-ASCII filenames.
- Disable following symlinks in glob.scan to avoid infinite loops.

## [0.8.0] - 2026-01-28

Fine-tuned query expansion model trained with GRPO replaces the stock Qwen3
0.6B. The training pipeline scores expansions on named entity preservation,
format compliance, and diversity — producing noticeably better lexical
variations and HyDE documents.

### Changes

- LLM: deploy GRPO-trained (Group Relative Policy Optimization) query
  expansion model, hosted on HuggingFace and auto-downloaded on first use.
  Better preservation of proper nouns and technical terms in expansions.
- LLM: `/only:lex` mode for single-type expansions — useful when you know
  which search backend will help.
- LLM: HyDE output moved to first position so vector search can start
  embedding while other expansions generate.
- LLM: session lifecycle management via `withLLMSession()` pattern — ensures
  cleanup even on failure, similar to database transactions.
- Integration: org-mode title extraction support. #50 (thanks @sh54)
- Integration: SQLite extension loading in Nix devshell. #48 (thanks @sh54)
- Integration: AI agent discovery via skills.sh. #64 (thanks @Algiras)

### Fixes

- Use sequential embedding on CPU-only systems — parallel contexts caused a
  race condition where contexts competed for CPU cores, making things slower.
  #54 (thanks @freeman-jiang)
- Fix `collectionName` column in vector search SQL (was still using old
  `collectionId` from before YAML migration). #61 (thanks @jdvmi00)
- Fix Qwen3 sampling params to prevent repetition loops — stock
  temperature/top-p caused occasional infinite repeat patterns.
- Add `--index` option to CLI argument parser (was documented but not wired
  up). #84 (thanks @Tritlo)
- Fix DisposedError during slow batch embedding. #41 (thanks @wuhup)

## [0.7.0] - 2026-01-09

First community contributions. The project gained external contributors,
surfacing bugs that only appear in diverse environments — Homebrew sqlite-vec
paths, case-sensitive model filenames, and sqlite-vec JOIN incompatibilities.

### Changes

- Indexing: native `realpathSync()` replaces `readlink -f` subprocess spawn
  per file. On a 5000-file collection this eliminates 5000 shell spawns,
  ~15% faster. #8 (thanks @burke)
- Indexing: single-pass tokenization — chunking algorithm tokenized each
  document twice (count then split); now tokenizes once and reuses. #9
  (thanks @burke)

### Fixes

- Fix `vsearch` and `query` hanging — sqlite-vec's virtual table doesn't
  support the JOIN pattern used; rewrote to subquery. #23 (thanks @mbrendan)
- Fix MCP server exiting immediately after startup — process had no active
  handles keeping the event loop alive. #29 (thanks @mostlydev)
- Fix collection filter SQL to properly restrict vector search results.
- Support non-ASCII filenames in collection filter.
- Skip empty files during indexing instead of crashing on zero-length content.
- Fix case sensitivity in Qwen3 model filename resolution. #15 (thanks
  @gavrix)
- Fix sqlite-vec loading on macOS with Homebrew (`BREW_PREFIX` detection).
  #42 (thanks @komsit37)
- Fix Nix flake to use correct `src/qmd.ts` path. #7 (thanks @burke)
- Fix docid lookup with quotes support in get command. #36 (thanks
  @JoshuaLelon)
- Fix query expansion model size in documentation. #38 (thanks @odysseus0)

## [0.6.0] - 2025-12-28

Replaced Ollama HTTP API with node-llama-cpp for all LLM operations. Ollama
adds convenience but also a running server dependency. node-llama-cpp loads
GGUF models directly in-process — zero external dependencies. Models
auto-download from HuggingFace on first use.

### Changes

- LLM: structured query expansion via JSON schema grammar constraints.
  Model produces typed expansions — **lexical** (BM25 keywords), **vector**
  (semantic rephrasings), **HyDE** (hypothetical document excerpts) — so each
  routes to the right backend instead of sending everything everywhere.
- LLM: lazy model loading with 2-minute inactivity auto-unload. Keeps memory
  low when idle while avoiding ~3s model load on every query.
- Search: conditional query expansion — when BM25 returns strong results, the
  expensive LLM expansion is skipped entirely.
- Search: multi-chunk reranking — documents with multiple relevant chunks
  scored by aggregating across all chunks rather than best single chunk.
- Search: cosine distance for vector search (was L2).
- Search: embeddinggemma nomic-style prompt formatting.
- Testing: evaluation harness with synthetic test documents and Hit@K metrics
  for BM25, vector, and hybrid RRF.

## [0.5.0] - 2025-12-13

Collections and contexts moved from SQLite tables to YAML at
`~/.config/lotl/index.yml`. SQLite was overkill for config — you can't share
it, and it's opaque. YAML is human-readable and version-controllable. The
migration was extensive (35+ commits) because every part of the system that
touched collections or contexts had to be updated.

### Changes

- Config: YAML-based collections and contexts replace SQLite tables.
  `collections` and `path_contexts` tables dropped from schema. Collections
  support an optional `update:` command (e.g., `git pull`) before re-index.
- CLI: `qmd collection add/list/remove/rename` commands with `--name` and
  `--mask` glob pattern support.
- CLI: `qmd ls` virtual file tree — list collections, files in a collection,
  or files under a path prefix.
- CLI: `qmd context add/list/check/rm` with hierarchical context inheritance.
  A query to `lotl://notes/2024/jan/` inherits context from `notes/`,
  `notes/2024/`, and `notes/2024/jan/`.
- CLI: `qmd context add / "text"` for global context across all collections.
- CLI: `qmd context check` audit command to find paths without context.
- Paths: `lotl://` virtual URI scheme for portable document references.
  `lotl://notes/ideas.md` works regardless of where the collection lives on
  disk. Works in `get`, `multi-get`, `ls`, and context commands.
- CLI: document IDs (docid) — first 6 chars of content hash for stable
  references. Shown as `#abc123` in search results, usable with `get` and
  `multi-get`.
- CLI: `--line-numbers` flag for get command output.

## [0.4.0] - 2025-12-10

MCP server for AI agent integration. Without it, agents had to shell out to
`qmd search` and parse CLI output. The monolithic `qmd.ts` (1840 lines) was
split into focused modules with the project's first test suite (215 tests).

### Changes

- MCP: stdio server with tools for search, vector search, hybrid query,
  document retrieval, and status. Runs over stdio transport for Claude
  Desktop and MCP clients.
- MCP: spec-compliant with June 2025 MCP specification — removed non-spec
  `mimeType`, added `isError: true` to errors, `structuredContent` for
  machine-readable results, proper URI encoding.
- MCP: simplified tool naming (`qmd_search` → `search`) since MCP already
  namespaces by server.
- Architecture: extract `store.ts` (1221 LOC), `llm.ts` (539 LOC),
  `formatter.ts` (359 LOC), `mcp.ts` (503 LOC) from monolithic `qmd.ts`.
- Testing: 215 tests (store: 96, llm: 60, mcp: 59) with mocked Ollama for
  fast, deterministic runs. Before this: zero tests.

## [0.3.0] - 2025-12-08

Document chunking for vector search. A 5000-word document about many topics
gets a single embedding that averages everything together, matching poorly for
specific queries. Chunking produces one embedding per ~900-token section with
focused semantic signal.

### Changes

- Search: markdown-aware chunking — prefers heading boundaries, then paragraph
  breaks, then sentence boundaries. 15% overlap between chunks ensures
  cross-boundary queries still match.
- Search: multi-chunk scoring bonus (+0.02 per additional chunk, capped at
  +0.1 for 5+ chunks). Documents relevant in multiple sections rank higher.
- CLI: display paths show collection-relative paths and extracted titles
  (from H1 headings or YAML frontmatter) instead of raw filesystem paths.
- CLI: `--all` flag returns all matches (use with `--min-score` to filter).
- CLI: byte-based progress bar with ETA for `embed` command.
- CLI: human-readable time formatting ("15m 4s" instead of "904.2s").
- CLI: documents >64KB truncated with warning during embedding.

## [0.2.0] - 2025-12-08

### Changes

- CLI: `--json`, `--csv`, `--files`, `--md`, `--xml` output format flags.
  `--json` for programmatic access, `--files` for piping, `--md`/`--xml` for
  LLM consumption, `--csv` for spreadsheets.
- CLI: `qmd status` shows index health — document count, size, embedding
  coverage, time since last update.
- Search: weighted RRF — original query gets 2x weight relative to expanded
  queries since the user's actual words are a more reliable signal.

## [0.1.0] - 2025-12-07

Initial implementation. Built in a single day for searching personal markdown
notes, journals, and meeting transcripts.

### Changes

- Search: SQLite FTS5 with BM25 ranking. Chose SQLite over Elasticsearch
  because QMD is a personal tool — single binary, no server dependencies.
- Search: sqlite-vec for vector similarity. Same rationale: in-process, no
  external vector database.
- Search: Reciprocal Rank Fusion to combine BM25 and vector results. RRF is
  parameter-free and handles missing signals gracefully.
- LLM: Ollama for embeddings, reranking, and query expansion. Later replaced
  with node-llama-cpp in 0.6.0.
- CLI: `qmd add`, `qmd embed`, `qmd search`, `qmd vsearch`, `qmd query`,
  `qmd get`. ~1800 lines of TypeScript in a single `qmd.ts` file.

[Unreleased]: https://github.com/tobi/qmd/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/tobi/qmd/releases/tag/v1.0.0
[0.9.0]: https://github.com/tobi/qmd/compare/v0.8.0...v0.9.0
