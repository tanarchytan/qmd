# QMD Provider for MemoryBench

Adapter for [MemoryBench](https://github.com/supermemoryai/memorybench). Benchmarks QMD memory against Mem0, Zep, Supermemory.

**Note:** For standalone evaluation, use `evaluate/locomo/eval.mts` instead — it's simpler and doesn't require MemoryBench.

## Prerequisites

- Node.js 22+ with `@tanarchy/qmd` source available
- `QMD_PROJECT_DIR` env var pointing to QMD repo root
- `~/.config/qmd/.env` with embed/rerank provider config

## How It Works

Uses a batch worker process (Node via tsx) for each operation. Single cold-start per batch, all memory ops run in one process.

| Phase | QMD Function |
|---|---|
| `ingest` | `extractAndStore()` per session, fallback `memoryStore()` per message |
| `awaitIndexing` | No-op (synchronous) |
| `search` | `memoryRecall()` with FTS + vector + rerank |
| `clear` | Delete temp SQLite DB |

## Standalone LoCoMo Eval (Recommended)

Skip MemoryBench entirely. Direct QMD + LLM evaluation:

```bash
# From QMD repo root, in WSL (sqlite-vec needs Linux):
npx tsx evaluate/locomo/eval.mts --conv conv-26 --llm gemini

# Ingest only (cached for reruns)
npx tsx evaluate/locomo/eval.mts --conv conv-26 --ingest-only

# Quick test
npx tsx evaluate/locomo/eval.mts --conv conv-26 --limit 20 --llm gemini
```

Current score: **F1=27.7%** on conv-26 (199 questions), up from 8.2% baseline.
