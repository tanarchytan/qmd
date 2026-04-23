# Follow-ups from 2026-04-23 night shift

Things I noticed but deliberately did NOT act on overnight (single-actor
without code review). Each is small, none is urgent. Pick up when there's
appetite.

## Code

- **Same silent-fallback warn pattern in `src/memory/index.ts:315, 348, 462`.** `getLocalEmbedBackend` returns `null` silently when `LOTL_EMBED_BACKEND !== "transformers"` AND `embedText` returns `null` when both local + remote are unconfigured. Mirror the `warnFallbackOnce` helper added to `src/store/search.ts` (commit `8f972da`). Skipped overnight because memory/index.ts is large + the eval harness path runs through it; risk of unexpected stderr noise during sweeps if `LOTL_QUIET_FALLBACK=1` is forgotten.
- **`knowledge_timeline` MCP tool has no scope filter.** Companion to the `knowledge_search` scope add (commit `83decb7`). Requires extending `knowledgeTimeline(db, subject)` in `src/memory/knowledge.ts:188` to accept `scope?: string` then plumbing it to the SQL. ~10 LOC. Defer until someone asks.
- **`extract-facts-batch.mjs` failure counter conflates two modes.** Currently increments `failed` for both real exceptions AND silent `parsed === null` (line 169). Could split into `failed` vs `unparseable` for clearer post-run diagnostics. Won't change behavior; would inform the LLM-cache cleanup pattern from this session (we ended up flushing 31 empty cache entries by hand).

## Docs

- **`docs/ROADMAP.md` has 46 `qmd` references.** All are intentional historical context (bench-config names like `qmd-default`, comparison-table column headers, pre-rename file paths). Bulk-rename would corrupt the historical record. Leave as-is.
- **`evaluate/CLEANUP_PLAN.md` has mixed qmd refs.** Some are stale (`src/cli/qmd.ts:159`), some intentional (CLI flag value `--judge-style qmd`). Each needs human judgment. Defer.
- **`docs/ROADMAP.md` (2440 lines) likely has more stale Phase-6 hardcode references** beyond the ones fixed in `b7c798e` + `14f4c55`. Not audited overnight — too easy to corrupt the historical record without a focused read.

## Eval

- **#32 llama+qwen rerun** — still queued. Needs cache flush + LM Studio. Independent of S2.1.
- **LoCoMo 11-question re-judge** — 11 score-corrupting opportunities identified by `audit-locomo-goldens.mjs`, ceiling 73.5%. Re-judging needs LM Studio.
- **`LOTL_EVAL_*` migration (item 9.1)** — 14+ files. Aesthetic rename. Safer with focused review.
- **JSON schema enforcement on extractAndStore (item 8.1)** — agent 3 mis-identified the file. The file uses line-based format, not JSON; schema doesn't apply directly. fact-extractor.ts (real JSON path) would benefit but changing prompt invalidates 345 cached entries.

## Phase 5 next steps (gated on S2.1 done + S2.2 result)

- **Pass S2.2** (≥+2pp R@5 on multi-session bucket fact vs content): implement `LOTL_MEMORY_EMBED_SOURCE=dual` (~40 LOC at `src/memory/index.ts:1310-1317`). Then S2.4 (dual A/B), S2.5 (KG re-test).
- **Fail S2.2**: park Phase 5b. v1.1 ships as polish release with the 9 bug-fix + doc commits already landed.

## What I already covered (so future agents don't redo)

- README + SKILL + SYNTAX `qmd` → `lotl` (commits `a2603d3`, `c9023cb`)
- ARCHITECTURE + EVAL Phase-6 hardcode refresh (`14f4c55`)
- env-flag-polarity stale flag note (`978839a`)
- Two more reasoning_content sites (`f9ea36d`)
- vite^7.3.2 security override (`0be7d03`)
- knowledge_search scope param (`83decb7`)
- CHANGELOG [Unreleased] populate (`8da6b8d`)
