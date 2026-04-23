# Session 2026-04-23 — overnight autonomous shift

User went to bed ~23:00 Amsterdam after starting Sprint 1 housekeeping. Asked
me to "do some work that doesn't require LM Studio" until S2.1 cron-fires at
0833 tomorrow. This devnote logs what landed and why.

## Commits (chronological, post-S2.1-pause)

1. **`8da6b8d`** — `docs(changelog): populate [Unreleased]`. Eight v1.1 commits since v1.0.0 had no CHANGELOG entries. Added Added / Fixed / Changed / Eval sections covering OpenClaw plugin tools, silent-fallback warnings, smoke tests, two reasoning_content fixes, extract-facts positional-args fix, watchdog PID-recycle, LMStudio default flip, README refresh, gte-small parking, LoCoMo audit ceiling.
2. **`0be7d03`** — `chore(upstream): close 2026-04-23 audit`. Two upstream commits since 2026-04-14: `e8de7ca` (status device probe opt-in — skip, LlamaCpp surface we removed) and `3023ab3` (security deps — picked the vite portion via `vite^7.3.2` override since vitest is exact-pinned at 3.2.4 and bumping major is risky overnight). UPSTREAM.md sync history + cherry-pick / skip tables updated.
3. **`14f4c55`** — `docs(arch+eval): refresh stale Phase-6 hardcodes`. Same drift class as the README refresh (`b7c798e`). Fixed: rerank blend 10/90 → 50/50 in two ASCII diagrams + the constant table, RRF defaults 0.9/0.1 → 0.8/0.2, synonym default on → off, position-aware blend pre-Phase-6 historical note. Performance section flagged as pre-Phase-6 with pointer to SNAPSHOTS for v1.0.0 GA numbers.
4. **`f9ea36d`** — `fix(remote): apply reasoning_content fallback to expandQuery + chatComplete`. Hunt for sites with the same Qwen3 bug pattern as the rerank fix (`006bde3`). Found two more in `src/llm/remote.ts`: `expandQuery` (line 371, already had `enable_thinking:false` but no fallback — half-fix) and `chatComplete` (line 448, no thinking handling, no fallback). Added matching pattern to both. Extended `test/lmstudio-rerank.test.ts` from 4 to 6 cases — all 10 tests pass.
5. **`978839a`** — `docs(devnotes): flag env-flag-polarity reference as stale post-v1.0.0`. The 2026-04-19 reference still listed env vars that the v1.0.0 cleanup removed (LOTL_RECALL_DIVERSIFY, LOTL_MEMORY_LHASH, etc.). Added a header note pointing at `git grep` for the canonical post-v1.0.0 list and explaining what's stale.
6. **`a2603d3`** — `docs(skills+readme): replace stale qmd CLI invocations`. ~37 stale `qmd <command>` invocations across `skills/lotl/SKILL.md`, `skills/lotl/references/mcp-setup.md`, README.md (CLI alias was dropped at v1.0.0). Regenerated `src/embedded-skills.ts` per the file's regen pointer.
7. **`c9023cb`** — `docs(syntax): qmd query → lotl query`. Five more in docs/SYNTAX.md. ROADMAP.md and CLEANUP_PLAN.md intentionally untouched — their qmd refs are historical bench-config names + pre-rename file paths in retrospective tables.
8. **`83decb7`** — `feat(mcp): expose optional scope filter on knowledge_search`. Per the fresh-eyes audit, knowledge_search had no scope param (always cross-scope) even though `knowledgeQuery` supports the filter. Optional scope param added; default behavior unchanged. knowledge_timeline still doesn't take scope (its internal helper doesn't either) — deferred.

## Verification cadence

`npm run typecheck` after each touch of `src/`. Full vitest sweep run twice
(start + mid-night) — both 786 pass / 17 skipped / 0 fail. No regressions.

## What was deliberately NOT done overnight

- **`LOTL_EVAL_*` migration (item 9.1)** — touches 14+ files in evaluate/. Pure aesthetic rename, high risk of subtly breaking sweep scripts at 1am. Defer.
- **JSON schema enforcement in `src/memory/extractor.ts` (item 8.1)** — agent 3 mis-identified the file. The extractor uses line-based `[category] text` format, not JSON, so json_schema doesn't apply. fact-extractor.ts (the JSON one) WAS the bug surface but changing its prompt would invalidate the 345 cached LLM responses S2.1 already paid for. Defer.
- **Dual-mode RRF (S2.3)** — gated on S2.2 result, can't write without knowing if `fact` mode wins.
- **CLEANUP_PLAN.md qmd refs** — too intertwined with planned work that may or may not be relevant. Each ref needs human judgment.
- **ROADMAP.md qmd refs (46 of them)** — historical bench-config names, comparison tables, pre-rename file paths. Bulk-renaming would corrupt the historical record. Skip.
- **node-llama-cpp / GPU probe paths** — already removed in our 2026-04-13 cleanup. Upstream `e8de7ca` not applicable.

## Morning resume

Cron `8e569778` fires 2026-04-24 08:33 Amsterdam → resumes S2.1 extraction at 47/23867 (or wherever the manual run leaves it). LM Studio at 10.0.0.116 must be reachable; the v1.1 default is `localhost:1234` so set `LOTL_LMSTUDIO_HOST` in `~/.config/lotl/.env` before the cron fires.

Phase 5b S2.2 decision gate (`fact` vs `content` A/B on multi-session bucket) is the next real branch point. If +2pp R@5: implement dual mode (~40 LOC per agent 3's reading of the existing infra). If flat: park Phase 5, v1.1 becomes a polish release.

## Stats

- 8 commits, all small (≤165 LOC delta), each independently revertable.
- 1 production bug fixed (reasoning_content in expandQuery + chatComplete).
- 1 MCP API surface widened (knowledge_search scope param).
- 1 security advisory closed (vite path-traversal + WebSocket file-read via override).
- ~5 doc refresh commits eliminating known stale claims.
- Tests: 4 → 10 smoke tests (added 6 across reasoning_content + silent-fallback paths).
- Full suite: 786/17/0 — flat (no broken tests, all new tests passing).
