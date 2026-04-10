# QMD Provider for MemoryBench

Adapter that lets [MemoryBench](https://github.com/supermemoryai/memorybench) benchmark QMD's memory system against Mem0, Zep, Supermemory, etc.

## Prerequisites

```bash
npm install -g @tanarchy/qmd@dev
qmd --help  # verify install
```

## Setup

```bash
# 1. Clone memorybench
git clone https://github.com/supermemoryai/memorybench
cd memorybench
npm install

# 2. Copy provider
cp -r /path/to/qmd/evaluate/memorybench-provider src/providers/qmd
```

**3. Register provider** — edit `src/providers/index.ts`:

```typescript
import { QmdProvider } from "./qmd"

const providers: Record<string, new () => Provider> = {
  // ... existing providers
  qmd: QmdProvider,
}
```

**4. Add type** — edit `src/types/provider.ts`:

```typescript
export type ProviderName = "supermemory" | "mem0" | "zep" | "filesystem" | "rag" | "qmd"
```

## Run

```bash
npx memorybench run --provider qmd --benchmark locomo
npx memorybench run --provider qmd --benchmark longmemeval
npx memorybench run --provider qmd --benchmark convomem
```

## How It Works

| MemoryBench Phase | QMD Command |
|---|---|
| `ingest` | `qmd memory extract <conversation>` per session |
| `awaitIndexing` | No-op (QMD indexes synchronously) |
| `search` | `qmd memory recall <query>` |
| `clear` | Delete temp SQLite database |

Each `containerTag` gets its own isolated SQLite database via `INDEX_PATH`.

## MemScore

MemoryBench produces a composite score: `accuracy% / latencyMs / contextTokens`.

QMD advantages:
- **Hybrid search** (FTS5 + vector + Weibull decay) should produce high accuracy
- **Synchronous indexing** means zero indexing latency
- **Compact memories** (extracted, not raw conversation) keep token counts low
