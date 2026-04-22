# LongMemEval evaluation

Lotl memory pipeline against the [LongMemEval](https://github.com/xiaowu0162/longmemeval) benchmark (ICLR 2025).

## Dataset

```sh
# Download the _s dataset (47 sessions/question, ~500 questions)
curl -sL https://github.com/xiaowu0162/longmemeval/raw/main/data/longmemeval_s.json \
  -o evaluate/longmemeval/longmemeval_s.json

# (optional) Oracle variant — only evidence sessions, faster
curl -sL https://github.com/xiaowu0162/longmemeval/raw/main/data/longmemeval_oracle.json \
  -o evaluate/longmemeval/longmemeval_oracle.json
```

## CLI flags

```sh
npx tsx evaluate/longmemeval/eval.mts [flags]
```

| Flag | Purpose | Default |
|---|---|---|
| `--ds s\|oracle` | Dataset variant | `s` |
| `--limit N` | Limit questions evaluated | 0 (all) |
| `--workers N` | Parallel eval workers | 1 |
| `--no-llm` | Retrieval-only, skip generation | false |
| `--ingest-only` | Stop after Phase 1 ingest | false |
| `--llm gemini\|minimax\|poe` | Generator LLM provider | `gemini` |
| `--model NAME` | Override both extract + answer model | (provider default) |
| `--answer-model NAME` | Override answer model only | (provider default) |
| `--judge gemini\|poe` | Enable LLM-as-judge grading | off |
| `--judge-model NAME` | Override judge model | (provider default) |
| `--tag TAG` | Label for `results-<tag>.json` | (timestamp) |
| `--db-suffix SUFFIX` | DB file suffix — reuses existing ingest | "" |

## Env vars

All `QMD_*` vars documented in top-level [`.env.example`](../../.env.example).

Key eval-specific:
- `LOTL_ANSWER_TOP_K=10` — memories to LLM (Mem0 paper default)
- `LOTL_ANSWER_MAX_CHARS=6000` — per-memory char cap
- `LOTL_PROMPT_RULES=v11|v13` — answer prompt (v11 default; v13 for `--judge` runs)
- `LOTL_LME_WORKERS=2` — parallel workers
- `LOTL_RECALL_RAW=on` — skip post-fusion boosts (baseline eval mode)

## Three canonical recipes

### 1. Retrieval-only n=500 sanity (~30-60 min, no API)
```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_VEC_MIN_SIM=0.1 \
LOTL_RECALL_RAW=on \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 500 --no-llm --workers 2 --tag baseline-n500
```
Reports: rAny@5, R@5, R@10, MRR, NDCG@10, Cov-MRR.

### 2. Full eval with Gemini gen/judge (~30 min, ~15K Gemini calls — free tier)
```sh
GOOGLE_API_KEY=AIza... \
LOTL_EMBED_BACKEND=transformers \
LOTL_PROMPT_RULES=v13 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 500 --llm gemini --judge gemini --tag gemini-full
```

### 3. Full eval with Poe generator + strong judge (~30 min, ~25K Poe pts)
```sh
POE_API_KEY=psk_... \
LOTL_EMBED_BACKEND=transformers \
LOTL_PROMPT_RULES=v13 \
  npx tsx evaluate/longmemeval/eval.mts \
    --ds s --limit 500 --llm poe --judge poe --judge-model gpt-4o \
    --tag poe-gpt4o --db-suffix poe-gpt4o
```

## DB reuse

Passing `--db-suffix X` reuses `evaluate/longmemeval/dbs/lme-s-X.sqlite` if it
exists. Ingest is skipped per-scope when memories already present — so re-runs
with the same suffix are ~10x faster. Used heavily by the n=500 embedder sweep.

## Performance expectations (Ryzen 7 Pro 7840U, workers=2)

| Embedder | Params | n=500 wall |
|---|---|---|
| mxbai-xs q8 | 22M | ~25 min |
| gte-small | 30M | ~25 min |
| bge-large-en-v1.5 | 335M | ~2h 25m |
| UAE-Large-V1 | 335M | ~2h 25m |
| jina-v5-nano (direct-ORT, max_length=1024) | 239M | ~5h |

## Results

JSON output: `evaluate/longmemeval/results-<tag>.json` with per-question metrics,
ablation config, usage totals (Poe tokens + cost), and full summary.

## Related

- [`../scripts/sweep-n500-embedders.sh`](../scripts/sweep-n500-embedders.sh) — runs the canonical embedder sweep
- [`../CLEANUP_PLAN.md`](../CLEANUP_PLAN.md) — current release-ready work
- [`../locomo/README.md`](../locomo/README.md) — LoCoMo benchmark eval (different dataset)
