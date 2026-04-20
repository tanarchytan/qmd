# Tomorrow's LM Studio game plan — 2026-04-21

Everything that requires LM Studio, ordered to minimize model-load swaps
(which cost ~3-8s + VRAM settle) and maximize path-to-release.

## Pre-flight (5 min)

```sh
curl -sS http://10.0.0.105:1234/v1/models            # confirm host up
ls evaluate/sweeps/*phase6*/SUMMARY.md               # confirm Phase 6 landed overnight
node evaluate/scripts/summarize-phase6.mjs           # print ranking + winners-per-lever
```

From the Phase 6 winners, **compose the combined-winners stack** in one pass:

- RRF ratio: 8/2 or 9/1 (from today's LME weight sweep; no change expected)
- Rerank: on, `jinaai/jina-reranker-v1-tiny-en` (Stage 9 default; may bump to BEIR top-3 via #53 after release)
- MMR: pick winner from sweep #54
- Rerank candidate limit: pick winner from sweep #54
- Rerank blend α: pick winner from sweep #55
- Expand: pick winner from sweep #56
- Synonyms: pick winner from sweep #56
- ANSWER_MAX_CHARS: pick winner from sweep #57

Edit `evaluate/scripts/phase-d-combined-winners.sh` to set these explicitly,
then `--dry-run` to verify env.

## Load-order (minimize swaps)

GPU has room for one model at a time. The order below loads each model
once, does all its work, then unloads.

### Step 1 — `google/gemma-4-26b-a4b` (judge, ~19 GB) — ~20 min

- **#33** Phase B gemma JUDGE-ONLY rerun from `pass1.json` gen cache
  - `LOTL_EVAL_LMSTUDIO_JUDGE_MODEL=google/gemma-4-26b-a4b`
  - Writes `results-phase-b-lme-v14-gemma-pass2.json` (superseding the aborted 54 KB partial)

### Step 2 — `google/gemma-4-e4b` (gen, ~6 GB Matformer 4B active) — ~40 min

- **Phase 5b fact-extract batch** (populates `fact_text` + `fact_embedding`)
  - `node evaluate/scripts/extract-facts-batch.mjs evaluate/longmemeval/dbs/lme-s-mxbai-n500-v17.sqlite --provider lmstudio --limit 100`
  - Smoke at limit=100; if clean, drop `--limit` for full pass (adds ~15 min)
  - Also writes KG triples via `knowledgeStore()` — unblocks Phase 5a on future runs
- **#38** combined-winners GEN pass
  - `bash evaluate/scripts/phase-d-combined-winners.sh --full`
  - Writes results JSONs for LME + LoCoMo

### Step 3 — `google/gemma-4-26b-a4b` (judge) — ~30 min

- **#38** combined-winners JUDGE pass (3-run majority vote)
- **Wilson CI compare** (instant, no LLM)
  - `node evaluate/scripts/wilson-ci.mjs --compare \\`
    `  evaluate/longmemeval/results-phase-b-lme-v14-gemma-pass2.json \\`
    `  evaluate/longmemeval/results-phase-d-combined-winners-pass2.json`
- **LoCoMo golden audit** (instant)
  - `node evaluate/scripts/audit-locomo-goldens.mjs evaluate/locomo/results-phase-d-combined-winners-pass2.json`
- **#36 adversarial plausibility** (judge-leniency test, ~15 min)
  - `node evaluate/scripts/adversarial-gen.mjs evaluate/longmemeval/results-phase-d-combined-winners-pass1.json --provider lmstudio --limit 100`
  - Then re-judge v1_wrong / v2_wrong predictions against the same judge; compare accept rate vs golden

### Step 4 — `meta-llama-3.1-8b-instruct` (gen, ~5 GB) — ~20 min

- **#32** Phase B llama+qwen cross-stack GEN pass
  - Uses own llm-cache (llm-cache-llama-qwen.json) to avoid polluting gemma cache

### Step 5 — `qwen/qwen3.6-35b-a3b` (judge, ~21 GB) — ~60 min

- **#32** Phase B llama+qwen cross-stack JUDGE pass
- Wilson CI vs gemma stack

### Step 6 — BEIR top-3 GGUF rerankers (#53) — ~60-90 min

Each reranker loads once (all GGUF already downloaded). Sweep runs all
configs in `rerank-lmstudio-gguf.txt` sequentially; LM Studio handles per-
config model swaps internally.

- `bash evaluate/scripts/sweep-flags.sh evaluate/sweeps/configs/rerank-lmstudio-gguf.txt --corpus locomo --name beir-top3-gguf`
- Expected unstable step: jina-reranker-v3 (may need llama.cpp fork, skip on fail)
- Expected unstable step: bge-reranker-v2-m3 (LM Studio autodetected as embed — may need manual reclassify in UI)

### Step 7 — release prep (no LM Studio)

- **#41** fill the TBD cells in `evaluate/SNAPSHOTS.md` v1.0.0 GA section
- Also update `docs/ROADMAP.md` + `CHANGELOG.md` with landed numbers
- **#42** cut v1.0.0 via `/release 1.0.0` skill

## Total LM Studio wall: ~4-5 hours

## Parallel-izable (if two hosts ever become available)

- Step 4/5 (llama+qwen) is independent of Step 2/3 (gemma)
- Step 6 (BEIR GGUF) is independent of everything else

## Risk flags / contingencies

- **jina-reranker-v3 load fails** (llama.cpp fork required) → skip that config; BEIR results still cover 2nd + 3rd best
- **bge-v2-m3 rejected by `/v1/chat/completions`** → manually reclassify in LM Studio UI (Model → Set as LLM), re-fire just that one config
- **LM Studio crashes mid-run** → `unload_all_instances` + 3s settle; resume script (each script has its own cache)
- **Gemma-26b OOM on 24 GB** → reduce `parallel` slots from 3 to 2 in phase-b-gemma.sh

## What NOT to do tomorrow

- Don't run big ONNX rerankers (#49-51) — Phase 6 sweeps already tested jina-tiny on LoCoMo; big rerankers are post-v1.0 exploration
- Don't touch env-rename migration (#47) — compat bridge is shipped, full rename is post-release
- Don't re-embed with embedding-gemma (embed-gemma-ab.txt) — parked as post-v1.0 A/B

## Release path

```
Step 1-3 (gemma) → Step 4-5 (llama+qwen) → Wilson CI → audit → #36 adversarial
              → #41 fill SNAPSHOTS → #42 release
```

The critical path is Steps 1-3 + #41 + #42. Everything else (#53 BEIR
sweep, #32 cross-stack) is validation / follow-up and can land same-day
or post-release.
