# LoCoMo evaluation

Lotl memory pipeline against the [LoCoMo benchmark](https://github.com/snap-research/locomo) (canonical long-term conversational memory eval from Snap Research).

See [`HYBRID_HARNESS.md`](./HYBRID_HARNESS.md) for the honest-harness rationale
(why top-k=10 not top-k=50, judge prompt choices, etc.).

## Dataset

```sh
curl -sL https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json \
  -o evaluate/locomo/locomo10.json
```

10 conversations, sample IDs: `conv-26`, `conv-30`, `conv-41`–`conv-50`.
Up to 32 sessions per conversation. Questions are categorized single-hop,
multi-hop, temporal, open-domain, adversarial.

## CLI flags

```sh
npx tsx evaluate/locomo/eval.mts [flags]
```

| Flag | Purpose | Default |
|---|---|---|
| `--limit N` | Limit QA pairs per conv | 0 (all) |
| `--conv SAMPLE_ID` | Only evaluate one conv (e.g. `conv-26`) | all |
| `--no-llm` | Retrieval-only, skip generation | false |
| `--ingest-only` | Stop after Phase 1 ingest | false |
| `--llm gemini\|minimax\|poe` | Generator LLM provider | `gemini` |
| `--judge gemini\|poe` | Enable LLM-as-judge grading (Mem0-style CORRECT/WRONG) | off |
| `--judge-model NAME` | Override judge model | (provider default) |
| `--tag TAG` | Label for results file | (none) |
| `--db-suffix SUFFIX` | DB file suffix — reuses existing ingest | "" |
| `--model NAME` | Override extract + answer model | (provider default) |
| `--answer-model NAME` | Override answer model only | (provider default) |

## Env vars

All `QMD_*` vars in top-level [`.env.example`](../../.env.example).

Key LoCoMo-specific:
- `LOTL_LOCOMO_ANSWER_TOP_K=10` — memories to LLM (Mem0 paper default; was 50 pre-2026-04-18)
- `LOTL_RECALL_RAW=on` — skip post-fusion boosts (baseline mode)
- `LOTL_RECALL_REFLECT=on` — LLM reflection pre-pass on pool

## Three canonical recipes

### 1. Retrieval-only single conv (~5-10 min, no API)
```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_VEC_MIN_SIM=0.1 \
  npx tsx evaluate/locomo/eval.mts --conv conv-26 --no-llm
```
Reports: R@5, R@10, MRR, SR@5/10/15/50, DR@5/10/15/50, F1.

### 2. Full eval with Gemini (~20-30 min, free tier)
```sh
GOOGLE_API_KEY=AIza... \
LOTL_EMBED_BACKEND=transformers \
  npx tsx evaluate/locomo/eval.mts --llm gemini --judge gemini --tag gemini-full
```

### 3. Full eval with Poe judge (~30 min, ~25K Poe pts)
```sh
POE_API_KEY=psk_... \
LOTL_EMBED_BACKEND=transformers \
  npx tsx evaluate/locomo/eval.mts --llm poe --judge poe --judge-model gpt-4o \
    --tag poe-gpt4o --db-suffix poe-gpt4o
```

## Honest-harness notes

See [`HYBRID_HARNESS.md`](./HYBRID_HARNESS.md). Key choices:

1. **`LOTL_LOCOMO_ANSWER_TOP_K=10`** — avoids MemPalace's admitted top-k=50 cheat
   (LoCoMo has up to 32 sessions — top-50 = whole-conv leak).
2. **Retrieval pool = 50 but LLM context = 10** — ranking metrics (R@5/R@10/MRR)
   sliced from the 50-wide pool for robustness; LLM sees only top-10 like Mem0.
3. **Judge prompt** — ports Lotl's strict "CORRECT/WRONG" style. Competitor-parity
   modes (`--judge-style mem0|zep`) are in backlog.

## DB reuse

Passing `--db-suffix X` reuses `evaluate/locomo/dbs/conv-<id>-X.sqlite` if it
exists. Each conv has its own DB. Ingest is skipped when memories already
present per scope.

## Performance expectations

| Config | Per-conv wall | Full 10 convs |
|---|---|---|
| Retrieval-only, mxbai-xs | ~1-3 min | ~15-30 min |
| With Gemini gen + judge | ~3-10 min | ~60-120 min |
| With Poe gpt-4o-mini gen + gpt-4o judge | ~5-15 min | ~90-180 min |

## Results

Output: `evaluate/locomo/results-<tag>.json`. Fields per QA: question,
answer (gold), prediction, top-10 memories, R@K, MRR, F1, EM, SH, judge verdict,
category (single-hop / multi-hop / temporal / open-domain / adversarial).

Category 5 (adversarial) uses a different scoring rule — "refuse if the gold
answer is a refusal" — handled by both F1 and the judge prompt.

## Related

- [`HYBRID_HARNESS.md`](./HYBRID_HARNESS.md) — honest harness design
- [`../scripts/sweep-locomo-convs.sh`](../scripts/sweep-locomo-convs.sh) — conv-26+30 sweep across embedders
- [`../CLEANUP_PLAN.md`](../CLEANUP_PLAN.md) — release-ready work
- [`../longmemeval/README.md`](../longmemeval/README.md) — LongMemEval benchmark eval (different dataset)
