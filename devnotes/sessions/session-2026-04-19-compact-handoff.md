# Session handoff — 2026-04-19 compact (before 86% context)

**Written pre-compact at ~12:30.** Picks up where tonight's marathon ends.
Post-compact session MUST read this file first.

## What to do when compact resumes

Keep continuing with TODOs. User's last instruction: *"continue with the
todo"*. Sweep chain is running unattended — watcher is already in
background; we're doing other useful work in parallel.

## The one big win to internalize

**jina-reranker-v1-tiny-en (33M) landed +4.9pp R@5 / +0.052 MRR on LoCoMo.**

This is the first real rerank signal on the RRF pipeline. Every prior
"rerank regresses on RRF" conclusion was based on CONTAMINATED data from
two bugs (silent no-op filename + TOUCH access_count drift), both fixed
tonight. Old conclusion — wrong. New conclusion — rerank meaningfully
helps, especially on harder corpora. Wall time 4-5 s/query is the
remaining cost barrier; `LOTL_RERANK_STRONG_SIGNAL_SKIP=on` is the
mitigation.

## What's running right now

| Task | State | ETA |
|---|---|---|
| Follow-up chain `bs4wjrdqv` (stages 7-14) | Stage 9 active | Stage 9 done ~16:50 |
| Background watcher PID 43070 | Polling sweep dir every 90 s | Auto-exits when Stage 9 done |
| jina-tiny-w73 | ✅ complete (R@5 56.9%, MRR 0.462) | — |
| jina-turbo-w73 | ⏸️ queued | ~14:20 |
| mxbai-rerank-xsmall-w73 | ⏸️ queued | ~16:50 |
| Stages 10-14 (MRR drift LoCoMo / all-flags / judge / polarity-corrected) | queued after Stage 9 | ~18:50 |
| Reruns chain R1-R5 | queued after follow-up | ~20:00-20:30 |

**Logs to peek at:**
- `/tmp/watch-rerankers.log` — auto-updated rerank diff tables
- `/tmp/follow-up-sweeps.log` — full follow-up chain output
- `evaluate/sweeps/rerank-at-w73-locomo-*/` — stage 9 per-config dirs

**Watcher command if it dies:**
```sh
bash evaluate/scripts/watch-rerankers.sh --interval 90 > /tmp/watch.log 2>&1 &
```

## The critical fixes landed tonight (all committed to dev)

| Commit | Fix | Impact |
|---|---|---|
| `9cba9bc` | Reranker filename auto-resolve (non-legacy models) | Rerank actually runs for non-cross-encoder models |
| `f766f9d` | `max_length=512` cap in tokenizer | Prevents 67 GB ModernBERT OOM |
| `b2c0f62` | `LOTL_RECALL_NO_TOUCH` env guard | A/B hygiene — no more access_count cross-contamination |
| `1e667bb` | Hono CVE overrides | 0 vulns in npm audit |
| `4baac79` | `release.sh` handles pre-release versions + dev branch | `/release 1.0.0` works from dev |
| `4b2e91c` | `src/graphify-out/` unleaked from npm tarball | 207→180 files, clean |
| `8f9c871` | `.code-review-graph/` + 5 other tool dirs properly ignored | No tool-state in PRs |
| `a7ecdf4` | 17/17 MCP tool smoke tests | Previously only 4/17 covered |
| `e73fcae` | `summarize-rerankers-now.sh` + `watch-rerankers.sh` | Live sweep monitoring |
| `2785571` | `devnotes/architecture/testing-runbook.md` | Reproducible A/B workflow |
| `11e9d5a` | CI + publish pipeline Node-only, 4 gated jobs | Release path actually works now |

Total: ~25 commits tonight since main chain started. All on `origin/dev`.

## State of key files

| File | Change |
|---|---|
| `src/memory/index.ts` | Added LOTL_RECALL_NO_TOUCH guard at line 1673-1686 |
| `src/llm/transformers-rerank.ts` | Filename auto-resolve + max_length cap |
| `src/store/constants.ts` | Env-override for RRF weights + rewrote stale rerank-blend comment |
| `src/cli/lotl.ts` | Many qmd→lotl fixes |
| `src/ast.ts`, `src/llm/*.ts`, `src/index.ts` | `[qmd]` → `[lotl]` log prefixes, jsdoc fixes |
| `.gitignore` | Added `.pi/`, `.vexp/`, `.serena/`, `.code-review-graph/`, `**/graphify-out/`, `__pycache__/` |
| `.graphifyignore` | Retitled Lotl, added devnotes/, tool dirs |
| `.github/workflows/publish.yml` | Rebuilt 4-job pipeline |
| `.github/workflows/ci.yml` | Added typecheck + build steps |
| `scripts/release.sh` | Pre-release-safe bump + dev-branch allowed |
| `scripts/regen-embedded-skill.mjs` | New helper (skill bundle rebuild) |
| `scripts/build.mjs` | Extracted from inline package.json |
| `package.json` | hono + @hono/node-server overrides; version 1.0.0-rc1 |
| `evaluate/scripts/` | 10 scripts total: sweep-flags.sh, sweep-flags-llm.sh, smoke-worker-bump.sh, compare-metrics.mjs, summarize-sweep.mjs, summarize-rerankers-now.sh, watch-rerankers.sh, chained-sweeps.sh, follow-up-sweeps.sh, reruns-chain.sh, mrr-drift-bisect.sh, probe-rerankers.mts |
| `evaluate/sweeps/configs/` | 12 configs covering every sweep type |
| `test/mcp.test.ts` | +237 lines of smoke tests for 13 previously-untested tools |
| `evaluate/SNAPSHOTS.md` | Repro footnote explaining 0.917 vs 0.907 |
| `CLAUDE.md` | qmd→lotl fixes |
| `.env.example` | 5 polarity bugs fixed + new env vars documented |

## Key devnotes to read on resume

In order of importance for tomorrow-morning triage:

1. `devnotes/sessions/session-2026-04-19-morning-triage.md` — Tomorrow's
   reading list with trust-map (contaminated vs clean data) + ready-to-apply
   Phase 4 graduation steps
2. `devnotes/architecture/testing-runbook.md` — HOW to reproduce every
   sweep we ran. 7 recipes, gotchas, interpretation checklist.
3. `devnotes/architecture/env-flag-polarity-reference.md` — canonical
   per-flag value table. `=on` isn't universal.
4. `devnotes/sessions/session-2026-04-19-overnight-sweeps.md` — full
   diary of what happened when
5. `devnotes/sessions/v1.0.0-ga-release-checklist.md` — post-reruns
   release path
6. `devnotes/architecture/phase5-kg-and-fact-aug-design.md` — Phase 5
   design (NOT IMPLEMENTED; needs sign-off before schema migration)

## Stage 9 baseline / jina-tiny numbers — lock these in memory

| Metric | baseline (no-rerank, 7/3 weights) | jina-tiny-w73 | Δ |
|---|---|---|---|
| R@5 | 52.0% | **56.9%** | **+4.9pp** |
| R@10 | 58.8% | 63.1% | +4.3pp |
| MRR | 0.411 | **0.462** | **+0.052** |
| Wall | 64 s | 8225 s (2h 17min) | — |

LoCoMo 10-conv, TOUCH-fix clean. These are the new canonical baselines
for future rerank A/Bs.

## Outstanding TODOs to pick up post-compact

User asked to "continue with the todo." Options by priority:

**High:**
1. **Wait for jina-turbo-w73 to complete** (~14:20). Compare to jina-tiny.
   If delta is flat or negative, jina-tiny (smaller, cheaper) wins.
2. **Check stage 10+ results as they land** via `/tmp/watch-rerankers.log`
   and `/tmp/follow-up-sweeps.log`.
3. **Un-park the bigger rerankers** if small-model signal continues
   (mxbai-rerank-base 184M, gte-reranker-modernbert 149M, tomaarsen-modernbert 150M).
   Uncomment entries at the bottom of `evaluate/sweeps/configs/reranker-sweep-phase3.txt`
   and run a fresh sweep.
4. **Fix the summarize-sweep.mjs overlay parser** — creates a ghost row
   when overlay starts with `LOTL_MEMORY_RRF_W_BM25=0.7 ...`. Cosmetic
   bug, data is correct, table mis-renders.

**Medium:**
5. **Run the full test suite** (`npx vitest run`) once Stage 9 finishes
   to catch any regression from today's code changes (rerank fix, TOUCH
   guard, test additions). Should be 758 pass / 17 skip still.
6. **Generate a fresh graphify graph** post-rerun-chain to verify the
   merged codebase is clean.
7. **Phase 4 graduation PR** — delete LHASH block + RECALL_DIVERSIFY
   clause once reruns confirm both are dead. See
   `v1.0.0-ga-release-checklist.md` section 2.

**Low:**
8. **Update SNAPSHOTS.md** with the new canonical numbers once reruns land.
9. **`compositeScore()` export in decay.ts** — exported but 0 callers. Delete.
10. **`memory_reflect` test** — smoke test landed, but a real integration
    test with a mock LLM would be nice.

## Rules that stick (no change tonight)

- Caveman style. No filler.
- Do not commit unless user asks. User has been explicitly asking tonight
  for every commit — keep that pattern.
- Zero-async at storage layer. Jiti-safe.
- mxbai-embed-xsmall-v1 q8 is permanent production default.
- Rerank off by default in production unless jina-turbo / mxbai-rerank-xsmall
  show bigger lift — then reconsider.
- Never commit `.env` / secrets / `mcp.token` / tool working dirs.
- Verify every flag's polarity against `env-flag-polarity-reference.md`
  before sweeping with it.

## Resume signal

After compact, if any user message arrives:
- First re-read THIS file (`session-2026-04-19-compact-handoff.md`) and
  the morning triage doc.
- Check rerank status via `bash evaluate/scripts/summarize-rerankers-now.sh`.
- Check follow-up chain progress via `/tmp/follow-up-sweeps.log`.
- Then continue with the top TODO from the list above.
