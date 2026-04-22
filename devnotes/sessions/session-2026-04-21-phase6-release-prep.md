# Session 2026-04-21 — Phase 6 squeeze sweeps + v1.0.0 release prep

Full-day session. LM Studio host returned (moved IP 10.0.0.105 → 10.0.0.113),
Phase 6 LME sweeps landed, combined-winners #38 produced the v1.0.0 GA
headline numbers, qwen3 thinking-model bug caught mid-flight, BEIR GGUF
sweep hit architectural limits. Release-ready at session close, waiting on
user `/release 1.0.0`.

## Headline numbers (v1.0.0 GA)

**Combined-winners (#38, gemma-4-e4b gen + gemma-4-26b-a4b 3-run majority judge, v14 CoT, strict LoCoMo judge, RRF 0.8/0.2 + jina-tiny rerank + blend 0.5/0.5 + syn off):**

| Benchmark | R@5 | MRR | JudgeCorrect | F1 |
|---|---|---|---|---|
| LongMemEval _s (n=500) | 86.2% | 0.888 | **73.8%** (n=488) | 20.4% |
| LoCoMo (n=200) | **60.0%** | 0.467 | — | 13.2% |

LoCoMo R@5 +9.5pp vs no-rerank baseline. LME JudgeCorrect within 0.5pp of gpt-4o-mini full-context (per locomo-audit) with only top-K retrieval + 4B Matformer gen.

**Adversarial judge leniency (#36):** gold self-check 100/100, v1 specific-wrong 0/99, v2 vague-topical 1/87. Judge clean.

## What shipped

Commits on `dev` since origin/main start (~26 commits, 115 files, +8.7k/−3.1k):

1. **Phase 6 hardcodes (`d0f5f4e`)** — 4 LME sweeps (max-chars / MMR×K / blend / expand-syn) completed. Winners baked into `src/store/constants.ts`:
   - `MEMORY_RERANK_BLEND_ORIGINAL=0.5` / `_RERANK=0.5` (+0.002 MRR over 0.7/0.3)
   - `MEMORY_RERANK_CANDIDATE_LIMIT=40` hardcoded
   - `RRF_W_BM25=0.8` / `_VEC=0.2` default flipped from 0.9/0.1
   - `MEMORY_SYNONYMS` hardcoded off in `src/memory/index.ts`
   - max-chars + MMR×K produced byte-identical metrics on LME single-scope → no-op under `--no-llm`

2. **Dead-knob cleanup (`2616d89` + `760c007`)** — removed 10+ env vars:
   - `LOTL_MEMORY_LHASH` (parked harmful), `LOTL_RECALL_DIVERSIFY` (superseded)
   - `LOTL_TRANSFORMERS_QUIET` / `LOTL_STRICT_DIM_MISMATCH` / `LOTL_TRANSFORMERS_DIRECT_MAXLEN` (all hardcoded)
   - `LOTL_GEMINI_EMBED_BATCH_SIZE` / `_INTERVAL_MS` (hardcoded)
   - Per-version LM Studio ctx/parallel collapsed to gen/judge pair

3. **Combined-winners #38 + #41 (`e8e3faf`)** — `phase-d-combined-winners.sh` composed the stack, ran LME + LoCoMo, wrote numbers to `evaluate/SNAPSHOTS.md` v1.0.0 GA section.

4. **Adversarial pipeline #36 (`e8e3faf`)** — `adversarial-gen.mjs` generates v1/v2 distractors, `adversarial-rejudge.mjs` re-runs the judge. Both committed with schema fixes (`5e0bf1a`).

5. **Qwen3 thinking-model fix (`14e30de` + `1ca0a04` + `ebfa572`)** — caught during #32 llama+qwen run. qwen3.6 routes structured JSON into `message.reasoning_content` instead of `message.content`. Patched 6 sites:
   - `evaluate/{locomo,longmemeval}/eval.mts` askLLM (primary)
   - `evaluate/locomo/eval.mts` askMiniMax path
   - `evaluate/longmemeval/poe-judge.mts`
   - `evaluate/scripts/{extract-facts-batch,adversarial-gen,adversarial-rejudge}.mjs`
   - `src/llm/lmstudio-rerank.ts` (defense before firing decoder-parallel sweep)
   - Pattern: `enable_thinking:false` when model matches `/qwen3/i` + fall back to `reasoning_content` when `content` empty

6. **LOTL_EVAL_* namespace bridge (`4519c7f`)** — `evaluate/shared/env-compat.ts` mirrors 32 eval-only env vars old↔new; legacy scripts keep working.

7. **Resumable sweeps + watchdog (`6c2ce39` + `33c4299` + `0a014f6`)**:
   - `sweep-flags.sh` skips completed configs (reads SUMMARY.md presence)
   - `phase6-watchdog.sh` lockfile guard via `tasklist` (Git Bash `kill -0` doesn't work for out-of-session PIDs — caught live)
   - 5-retry self-heal on transient non-zero exits

8. **LM Studio host move (`4798c6d`)** — 10.0.0.105 → 10.0.0.113 bulk-replaced everywhere.

9. **BEIR decoder-parallel script (`ebfa572`)** — `phase-d-beir-decoder-parallel.sh` for post-release BEIR salvage. Excludes qwen3 rerankers (thinking = too slow).

## Key incidents

### Overnight outage (2026-04-20 → 21 morning)
Claude Code crashed overnight — SIGHUP'd all background bash children. Phase 6 queue never fired, LoCoMo weight sweep stopped at 3/10, big ONNX rerankers at 1/4. Pass1.json saved. See `session-2026-04-20-lmstudio-outage.md` for handoff.

### LM Studio reappears at 10.0.0.113 (~10:00)
Physical reboot gave new IP. Bulk-replaced in commit `4798c6d`. Re-fired tomorrow's plan: gemma gen → judge → Phase 5b → combined-winners → adversarial.

### Phase 5b fact-extract partial failure (~11:30)
Smoke run at limit=100: `mod.embedTexts is not a function` (wrong import) + ctx overflow on long session-level memories. Fixed in `9bee79a` (use `createTransformersEmbedBackend` + input char cap at 10k). Not re-fired for release — Phase 5b is post-v1.0 experimental.

### Qwen3 judge returning empty verdicts (~16:00)
First fire of `phase-b-llama-qwen.sh` after LM Studio return: 100% `[judge] unparseable verdict` on every query. Systematic-debugging Phase 1-4:
- VRAM oversubscription ruled out (unloaded gemma-26b + llama-8b, still empty)
- Direct curl to qwen endpoint showed the JSON verdict was in `reasoning_content`, not `content`
- Patched askLLM, committed, skipped #32 rerun for release
- Required cache flush (llm-cache-llama-qwen.json has 220+ empty judge entries — noted for post-release redo)

### BEIR GGUF sweep architectural finding (~17:00)
`phase-d-beir-early-stop.sh` tried to run `jina-reranker-v1-tiny-en` via LM Studio `/v1/chat/completions` shim. Got 400 "the current context does not logits computation. skipping". Cross-encoders (jina-tiny, jina-v3, gte-modernbert, bge-v2-m3) fundamentally can't be shim'd — they need `/v1/rerank` which LM Studio doesn't expose. Phase 1 data (5 configs) aborted on this.

Salvage attempt: `phase-d-beir-decoder-parallel.sh` loads decoder rerankers one-at-a-time with high parallel slots (qwen3-0.6b at 32, qwen3-4b at 16, mxbai-v2-base at 32, mxbai-v2-large at 16). But qwen3-0.6b at parallel=32 ran ~47s per rerank query even with `enable_thinking:false` — LM Studio doesn't honor the flag for qwen3 rerankers either. Skipped both qwen3 variants; mxbai-v2 still in flight at session close (task `b5uwjxqul`).

### Skills system
User installed ~40 skills from skills.sh into `~/.claude/skills/`. Claude Code only scans at session start → new skills not invokable until next restart. Pre-restart skills active: `using-superpowers`, `systematic-debugging`, `verification-before-completion`, `requesting-code-review`, `finishing-a-development-branch` (all exercised this session).

## Post-release backlog

1. **#32 llama+qwen redo** — flush `llm-cache-llama-qwen.json` (contains 220+ empty verdicts), re-fire `phase-b-llama-qwen.sh` with reasoning_content fix live. Expected ~2h.
2. **#53 BEIR completion** — mxbai-v2 may land data from current run (`b5uwjxqul`); qwen3 rerankers permanently deferred. jina-v3 etc need `/v1/rerank` endpoint from LM Studio or ONNX-runtime alternative.
3. **Phase 5b fact-aug A/B** — re-fire extract-facts-batch (fixed), then combined-winners with `LOTL_MEMORY_EMBED_SOURCE=fact`. Expected +3-4pp per LME paper.
4. **#47 env rename full migration** — compat bridge shipped; follow-up to rename code callsites LOTL_X → LOTL_EVAL_X.
5. **Watchdog single-instance guard** has stale-PID-recycle hole — add `IMAGENAME eq bash.exe` filter to `tasklist` check (code review minor).
6. **Add lmstudio-rerank smoke tests** — empty content on thinking model, timeout, host-down (code review minor).

## Release path

```
/release 1.0.0     # user-invoked, skill blocks model-invocation
```

SNAPSHOTS + CHANGELOG filled, tests pass, typecheck clean, no working tree dirt, code reviewer signed off with "Ship it" (only 2 Important fixes landed in `1ca0a04`, 6 Minor deferred post-release).
