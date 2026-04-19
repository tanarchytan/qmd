# Morning brief — 2026-04-20 08:30 Amsterdam

Paused overnight 23:00–08:30. LM Studio idle. Local rerank Stage 9 ran
overnight (should have finished ~06:00).

## Overnight code landed (no LM Studio needed)

12 commits from ~00:00 → ~03:00. All pushed to `dev`. Summary:

| Commit | What |
|---|---|
| `ca27ec1` | `LOTL_RECALL_NO_TOUCH=on` default in eval.mts (prevents today's cascade) |
| `38b2d26` | `llm-cache` v2 hash (max_tokens in key) + legacy fallback |
| `95a1dfa` | Wilson Score 95% CIs script (`evaluate/scripts/wilson-ci.mjs`) |
| `4bd5b00` | N-run judge majority vote via `LOTL_JUDGE_RUNS` |
| `567e24e` | LoCoMo golden audit vs errors.json (`audit-locomo-goldens.mjs`) |
| `a99925e` | Phase 5 schema migration + `fact-extractor.ts` |
| `ef94316` | `extract-facts-batch.mjs` batch runner (untested — waits for LLM) |
| `40100ad` | `phase-b-llama-qwen.sh` cross-stack baseline runner |
| `5cc777f` | Runbook + CHANGELOG updates |

See `git log 5cc777f..HEAD` for exact range; also reverse-chron via `git log --oneline -20`.

## Fire order — 08:30 → evening

### 1. Check rerank Stage 9 (local workstation, no LM Studio needed)

```sh
bash evaluate/scripts/summarize-rerankers-now.sh
```

Expected: 7 configs all completed overnight (baseline + jina-tiny + jina-turbo
+ mxbai-xsmall + mxbai-base + gte-modernbert + tomaarsen-modernbert). Pick
winner via MRR + R@5 lift.

### 2. Phase B gemma clean run (LM Studio, ~2.5h)

```sh
bash evaluate/scripts/phase-b-gemma.sh
```

Loads gemma-4-e4b gen + gemma-4-26b-a4b judge. Clean cache (fresh from yesterday).
Schema-forced JSON judge → 0 dropouts. `LOTL_RECALL_NO_TOUCH=on` baked in.

Expected outputs:
- `evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass{1,2}.json`
- `evaluate/locomo/results-phase-b-locomo-v14-gemma-pass{1,2}.json`

### 3. Phase B llama+qwen cross-stack baseline (LM Studio, ~2h)

```sh
bash evaluate/scripts/phase-b-llama-qwen.sh
```

Same workload, prior stack. Separate cache file. For fair cross-stack comparison.

### 4. Wilson CI comparison (instant)

```sh
node evaluate/scripts/wilson-ci.mjs --compare \
  evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass2.json \
  evaluate/longmemeval/results-phase-b-lme-v14-llama-qwen-pass2.json
```

Tells us if gemma's smoke +6pp LoCoMo win actually holds at n=500 LME / n=200 LoCoMo.

### 5. LoCoMo golden audit against Phase B results

```sh
node evaluate/scripts/audit-locomo-goldens.mjs \
  evaluate/locomo/results-phase-b-locomo-v14-gemma-pass2.json
```

Shows how much of our "wrong" verdicts are actually caused by the audit-identified
bad goldens. Gives us the theoretical ceiling.

### 6. Phase 5 batch extraction (LM Studio, ~5 min on gemma-e4b)

Tests + completes tasks #43 (KG injection) + #44 (fact-aug embedding):

```sh
node evaluate/scripts/extract-facts-batch.mjs \
  evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite \
  --provider lmstudio --limit 100
```

Start small (`--limit 100`). If the extraction prompt produces clean
`{facts, triples}` JSON, remove `--limit` and run full. Writes to
`memories.fact_text` + `memories.fact_embedding` BLOB.

After a successful extraction, we still need to:
- Wire `LOTL_MEMORY_EMBED_SOURCE=fact|content|dual` in `memoryRecall`
  (requires a 2nd `memories_vec_fact` virtual table — scoped ~1h work)
- Call `knowledge_add` from the batch script for triples (scoped ~30 min)

### 7. Combined-winners run + release

Once Phases 5a/5b + rerank winner are picked, compose the best stack:

```sh
# Pseudocode — actual config assembled post-step-1
LOTL_MEMORY_RERANK=on LOTL_TRANSFORMERS_RERANK_MODEL=<winner> \
LOTL_MEMORY_EMBED_SOURCE=fact LOTL_MEMORY_KG=on \
  bash evaluate/scripts/phase-b-gemma.sh
```

Then SNAPSHOTS.md + CHANGELOG + release per Phase F.

## Known pending

- **#36 adversarial plausibility** — needs LLM generation of v1 (specific-wrong)
  + v2 (vague-topical) wrong answers. Scoped but not scripted yet.
- **#47 LOTL_EVAL_* prefix rename** — deferred; too risky to do while user asleep.

## Watch out

- If LM Studio crashes at any point, the scripts handle kill+unload
  cleanly via the `unload_all_instances` helper + 3s VRAM settle. Just
  re-launch.
- llm-cache-gemma.json and llm-cache-llama-qwen.json are SEPARATE. Don't
  conflate. Each Phase B stack uses its own.
- Rerank decision should land before #38 combined-winners.
