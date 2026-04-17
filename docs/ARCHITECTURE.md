# qmd memory architecture

How qmd's memory framework actually works, end-to-end. Covers ingest,
recall, reranking, decay/dream consolidation, knowledge graph, and the
tiered storage model. Source-file references at the end of each section.

> **On benchmark metrics:** see `docs/notes/metrics.md` for the full
> walkthrough of `recall_any@K` (binary, what
> agentmemory/mem0/MemPalace publish as "R@K") vs `R@K` (fractional,
> LongMemEval paper definition) vs `Cov@K` (qmd-specific token-overlap
> content coverage, **NOT** comparable externally) vs LLM-judge QA
> accuracy (what Supermemory/Hindsight publish, requires `evaluate_qa.py`).
> The eval harness in `evaluate/longmemeval/eval.mts` reports all three
> retrieval families side-by-side. **Never compare a qmd "R@5" to a
> competitor's "R@5" without checking which family each one is in** —
> see the 2026-04-15 ROADMAP entry for the day this rule cost us six
> hours.

## Overview

qmd is a memory framework for AI agents. It does the things you'd expect
a real memory framework to do — hybrid retrieval, knowledge graph,
temporal decay, tiered storage, reflection synthesis, conflict
resolution, conversation import — and ships them as one cohesive
package. SQLite is its current storage primitive, but the framework
identity is the **memory layer**, not the database underneath.

What qmd does today:

- **Hybrid retrieval** — BM25 + dense vectors fused via weighted Reciprocal Rank
  Fusion, with adaptive cosine floors, post-RRF boosts, and optional
  cross-encoder rerank
- **Temporal knowledge graph** — subject/predicate/object triples with
  validity windows, queryable point-in-time, auto-invalidating on
  contradiction
- **Tiered storage with Weibull decay** — composite recency / frequency
  / intrinsic scoring, three-tier promotion (peripheral → working →
  core), LRU-K-style eviction
- **Conflict resolution** — exact + cosine + LLM-judged ADD/UPDATE/
  DELETE/NONE merging
- **Reflection synthesis** — Generative-Agents pattern that distills
  recent memory into compressed lessons stored as new memories
- **Multi-format conversation import** — five conversation formats
  normalized into the same memory layer
- **Dream consolidation** — a single bundled call (decay + eviction +
  reflection) that mirrors the OpenClaw "dream" pattern
- **Canonical CRUD MCP surface** — 26 tools across `memory_*`,
  `knowledge_*`, `doc_*` namespaces, aligned with the de-facto naming
  used by mem0 / Letta / MemPalace

It happens to run on **SQLite + sqlite-vec + FTS5** today because that
combination is embedded, atomic, portable, and requires zero infra.
Future backends (LanceDB, pgvector) are documented as a pluggable path
in the roadmap. The storage layer is replaceable; the memory framework
is the value.

## Storage layer

One SQLite database, opened via `better-sqlite3`. sqlite-vec is loaded
as an extension at db open. Tables (all owned by qmd's memory layer):

| Table | Purpose | Notes |
|---|---|---|
| `memories` | Canonical row per memory: id, text, content_hash, category, scope, importance, tier, access_count, created_at, last_accessed, metadata (JSON) | Every other table joins to this |
| `memories_fts` | FTS5 virtual table over `memories.text` | Porter stemmer, BM25 ranking |
| `memories_vec` | vec0 virtual table, `scope TEXT PARTITION KEY` + `id TEXT PRIMARY KEY` + `embedding float[N] distance_metric=cosine` | Partitioned by scope so KNN queries walk only the active scope's slice |
| `memory_history` | Audit log: id, memory_id, action (ADD/UPDATE/DELETE), old_value, new_value, timestamp | Skippable per ingest call via `skipHistory` |
| `knowledge` | Temporal triples: subject, predicate, object, valid_from, valid_until, scope, confidence | Used by KG-in-recall + entity queries |
| `content_vectors` | Doc-store table — separate from memory layer, used by the document-search half of qmd | Not part of the memory pipeline |

**Files:** `src/store/db-init.ts` (schema), `src/memory/index.ts`
(table init + CRUD), `src/db.ts` (extension load).

---

## Phase 1 — Ingest

Two entry points:

- **`memoryStore(db, options)`** — single memory, full dedup pipeline
  (hash + cosine + LLM conflict resolution)
- **`memoryStoreBatch(db, items)`** — bulk ingest, hash-only dedup,
  multi-VALUES INSERT, opt-in chunking via `chunk: true`

Both accept structured `turns` + `userOnly` for L1-style ingest (joins
turns to text via `turnsToText` before dedup). The OpenClaw plugin and
AMB adapter both go through `memoryStoreBatch`.

### Ingest pipeline

```
input item(s)
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 0 — chunking expansion (opt-in via chunk:true)        │
│   - turns → text via turnsToText(turns, userOnly)           │
│   - if text > 1536 chars: split via chunkDocument()         │
│   - each chunk inherits scope + metadata.doc_id (auto UUID) │
│   - chunk_seq + chunk_pos added per chunk                   │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 1 — hash dedup (single SQL round-trip)                │
│   SELECT id FROM memories WHERE content_hash IN (...)       │
│   Skip any item whose hash already exists                   │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 2 — cosine dedup (single-store path only)             │
│   findSimilarMemory(db, embedding, threshold=0.9)           │
│   If hit: ask remote LLM (if configured) to decide:         │
│     ADD / UPDATE / DELETE / NONE                            │
│   batch path skips this for speed                           │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 3 — batched embedding                                 │
│   embedTextBatch() routes through getFastEmbedBackend()     │
│   - local: TransformersEmbedBackend (mxbai-xs q8 default)   │
│   - remote: OpenAI/ZeroEntropy/SiliconFlow/Gemini/Nebius    │
│   Inside: split into micro-batches of QMD_EMBED_MICROBATCH  │
│   (default 32) to bound transformers.js WASM heap           │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 4 — bulk insert (single transaction)                  │
│   classify category (regex patterns) — opt out via "other"  │
│   multi-VALUES INSERT into `memories` (one statement)       │
│   multi-VALUES INSERT into `memory_history` (skippable)     │
│   per-row INSERT into `memories_vec` (vec0 doesn't bulk)    │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ Phase 5 — opt-in side effects (eval/plugin only, gated)     │
│   QMD_INGEST_EXTRACTION   → extractAndStore (LLM facts)     │
│   QMD_INGEST_REFLECTIONS  → extractReflections              │
│   QMD_INGEST_SYNTHESIS    → consolidateEntityFacts          │
│   All three off by default for benchmark fairness           │
└─────────────────────────────────────────────────────────────┘
```

**Files:** `src/memory/index.ts` (`memoryStore`, `memoryStoreBatch`,
`embedTextBatch`, `embedInMicroBatches`), `src/store/chunking.ts`
(`chunkDocument`), `src/memory/patterns.ts` (`classifyMemory` regex),
`src/memory/extractor.ts` (LLM extraction).

### Knowledge graph extraction (optional, off by default)

When `QMD_INGEST_EXTRACTION` is on, `extractAndStore` uses either the
configured remote LLM or a heuristic fallback to pull subject-predicate-
object triples out of the text. Each triple becomes a row in `knowledge`
with `valid_from = now`. If a new triple contradicts an existing one
(same subject + predicate, different object), the old row is closed
out by setting `valid_until = now`. This gives a **temporal knowledge
graph** without a separate graph store.

**Files:** `src/memory/knowledge.ts`, `src/memory/extractor.ts`.

---

## Phase 2 — Recall (the hot path)

Single entry point: `memoryRecall(db, options)`. Returns a ranked array
of `MemoryRecallResult`. Optional profiling via `QMD_RECALL_PROFILE=on`
emits per-stage timing as JSON to stderr.

### Recall pipeline (restructured 2026-04-16)

Six stages with clean separation between retrieval, fusion, boosts,
and reranking. All scores on a uniform RRF scale (~0.003-0.033).

```
query string + scope + category + tier + limit
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE A — Independent retrieval (parallel)                   │
│                                                             │
│  A0. Query expansion (optional, QMD_MEMORY_EXPAND)          │
│      entities → proper-noun fan-out                         │
│      keywords → top-N keyword group fan-out                 │
│      Q0 (original) always included; max 3 sub-queries       │
│                                                             │
│  A1. FTS5 BM25 ──────────┐  A2. Vec KNN ─────────────────┐ │
│  │ memories_fts MATCH ?   │  │ embedQuery() per sub-query │ │
│  │ ORDER BY rank          │  │ sqlite-vec cosine KNN      │ │
│  │ LIMIT k * 10           │  │ Adaptive cosine floor      │ │
│  │ → ftsRanks: Map<id,    │  │ → vecRanks: Map<id,        │ │
│  │   1-indexed position>  │  │   1-indexed position>      │ │
│  └────────────────────────┘  └────────────────────────────┘ │
│                                                             │
│  Both lists are rank positions (not raw scores).            │
│  Scope/category/tier filtering applied at retrieval time.   │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE B — RRF fusion                                         │
│   score(id) = w_bm25 × 1/(K + bm25_rank)                    │
│             + w_vec  × 1/(K + vec_rank)                      │
│   K = 60, w_bm25 = 0.8, w_vec = 0.2 (validated at n=500)   │
│   Items in only one list get that list's score (no penalty)  │
│   All scores now on uniform ~0.003-0.033 scale               │
│                                                             │
│   Always runs, even in RAW mode — RRF is the base scoring.  │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE C — Post-fusion boosts (gated by !RAW)                 │
│   All multiplicative (scale-invariant):                     │
│   C1. Keyword overlap:  score × (1 + 0.4 × overlap_ratio)  │
│   C2. Quoted phrase:    score × 1.6 per matched phrase      │
│   C3. Decay (Weibull):  score × composite                   │
│   C4. Temporal:         score × (1 + 0.4 × proximity)      │
│       + time-window memory injection at median(scores)      │
│                                                             │
│   RAW=on skips all boosts for fair eval baselines.          │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE D — Sort by score                                      │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE E — Rerank (optional, QMD_MEMORY_RERANK=on)            │
│   Backend: QMD_RERANK_BACKEND=transformers (local ONNX       │
│     cross-encoder ms-marco-MiniLM-L6) or remote              │
│   Strong-signal skip OFF by default (opt-in via              │
│     QMD_RERANK_STRONG_SIGNAL_SKIP=on)                        │
│   Min-max normalize logits → blend 10% RRF + 90% rerank     │
│   (0.1/0.9 validated at n=500: MRR 0.937 vs 0.920 baseline) │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
┌─────────────────────────────────────────────────────────────┐
│ STAGE F — Post-rerank                                        │
│   F1. KG injection (QMD_MEMORY_KG=on)                       │
│       Gates: opt-in + proper-noun entity + weak top score    │
│       Injects up to 5 facts at median(current_scores)        │
│   F2. Dialog diversity (QMD_MEMORY_MMR=session)              │
│       MMR-lite reshuffle preferring unseen sessions          │
│   F3. Touch access counts (batched transaction)             │
└─────────────────────────────────────────────────────────────┘
   │
   ▼
ranked MemoryRecallResult[] → caller
```

**Files:** `src/memory/index.ts` (`memoryRecall`), `src/llm/transformers-embed.ts`, `src/llm/transformers-rerank.ts`, `src/store/constants.ts` (all tunables).

### Memory recall tunables (src/store/constants.ts)

All hardcoded — validated at n=500 LME 2026-04-16. No env var overrides
for production tunables (avoids accidental misconfiguration).

| Constant | Value | Purpose |
|---|---|---|
| MEMORY_RRF_K | 60 | RRF smoothing constant |
| MEMORY_RRF_W_BM25 | 0.8 | BM25 list weight in RRF fusion |
| MEMORY_RRF_W_VEC | 0.2 | Vec list weight (low — mxbai-xs vec is weak on LME) |
| MEMORY_FTS_OVERFETCH | 10 | FTS candidate pool = limit × 10 |
| MEMORY_VEC_K_MULTIPLIER | 3 | Vec candidate pool = limit × 3 |
| MEMORY_RERANK_BLEND_ORIGINAL | 0.1 | Original score weight in rerank blend |
| MEMORY_RERANK_BLEND_RERANK | 0.9 | Cross-encoder score weight |
| STRONG_SIGNAL_MIN_SCORE | 0.85 | Rerank skip gate (off by default) |
| STRONG_SIGNAL_MIN_GAP | 0.15 | Rerank skip gap threshold |

### Doc-store search tunables (also in constants.ts)

These apply to the document search pipeline (`src/store/search.ts`),
NOT memory recall. Hardcoded, no env overrides.

| Constant | Value | Purpose |
|---|---|---|
| RRF_K | 60 | Doc-store RRF smoothing |
| WEIGHT_FTS | 2.0 | Doc-store BM25 weight |
| WEIGHT_VEC | 1.0 | Doc-store vec weight |
| BLEND_RRF_TOP3/TOP10/REST | 0.75/0.60/0.40 | Position-aware blend |
| RERANK_CANDIDATE_LIMIT | 40 | Docs sent to reranker |
| CHUNK_SIZE_TOKENS | 900 | Doc-store chunking (env-configurable) |
| CHUNK_WINDOW_TOKENS | 200 | Break-point search window (env-configurable) |

---

## Phase 3 — Maintenance / Dream consolidation

Three operations that run on demand (CLI, MCP tool, or OpenClaw plugin
hook). All three are exposed as a single bundled call: **`qmd dream`**
or `memory_dream` (MCP) → runs decay → eviction → reflection in order.

### Weibull decay (the heart of tiered memory)

Each memory has three component scores that combine into a single
`composite` score used for tier promotion / demotion / eviction:

```
composite = 0.4 × recency + 0.3 × frequency + 0.3 × intrinsic
```

- **recency** — Weibull survival function on (now - last_accessed).
  Weibull is preferred over a flat exponential because it has a
  configurable shape parameter that captures "memories age slowly at
  first, then fall off a cliff". Shape = 1.5, scale = 30 days.
- **frequency** — log-scaled access_count (Mastra-style).
- **intrinsic** — importance × category weight × length-bonus.

A `runDecayPass(db, options)` walks all memories in scope, recomputes
composite, and shifts tiers:

```
peripheral ─── composite ≥ 0.6 ──→ working
working    ─── composite ≥ 0.8 ──→ core
core       ─── composite < 0.4 ──→ working
working    ─── composite < 0.3 ──→ peripheral
```

Three tiers, two boundaries. Promotion is sticky (high bar) and
demotion is loose (lower bar). Tiered recall (`memoryRecall` with the
`tier` filter) lets callers retrieve only from a specific tier — used
by the Hindsight pattern and OpenClaw's "core memory always-on" use case.

**Files:** `src/memory/decay.ts` (`runDecayPass`, `getDecayScore`,
`promoteMemory`, `demoteMemory`).

### Eviction

`runEvictionPass(db, options)` runs an LRU-K-flavored eviction with a
single-field backward window (`lruWindowDays`, default 7). It only
fires when the total memory count exceeds `minMemoriesForEviction`
(default 1000), so small installs never lose data.

The "true LRU-K" implementation requires a separate access_log table to
track the K-th most recent access — qmd's current implementation is a
single-field approximation. The docstring is honest about this.

### Reflection synthesis (Generative-Agents pattern)

`runReflectionPass(db, options)` walks the last N days of memories in
the active scope, asks the configured remote LLM for high-level themes
/ decisions / patterns, and stores each reflection as a new memory of
category `reflection`. Future recall picks them up via the normal FTS +
vec paths.

Skipped silently when no remote LLM is configured. Returns
`{reflections: N, skipped, reason}`.

### Dream consolidation = bundled call

```
qmd dream [scope]           # CLI
memory_dream { scope? }     # MCP tool

  ↓

runCleanupPass(db, opts)     # decay + optional eviction
runReflectionPass(db, opts)  # LLM synthesis (no-op without remote)
```

The OpenClaw plugin auto-fires `qmd dream` on `agent_end` when the
session-count threshold (5 sessions) and time threshold (1 hour) are
both hit. Mirrors the "dream" pattern from informal community plugins
(`OpenClawDreams`, `openclaw-auto-dream`).

**Files:** `src/memory/decay.ts` (`runCleanupPass`), `src/memory/index.ts`
(`runReflectionPass`), `src/openclaw/plugin.ts` (`agent_end` hook),
`src/cli/qmd.ts` (`qmd dream` command).

---

## Knowledge graph (when present)

The `knowledge` table is a temporal triple store: `subject - predicate -
object` with `valid_from` and optional `valid_until`. Three operations:

- **`knowledgeStore(db, triple)`** — adds a triple, auto-invalidates
  any contradicting prior triple by setting its `valid_until = now`
- **`knowledgeQuery(db, filter)`** — query by any subset of
  subject/predicate/object, optionally filtered to `as_of` timestamp
  for temporal point-in-time queries
- **`knowledgeInvalidate(db, id)`** — explicit invalidation

The KG can also be **injected into recall results** via `QMD_MEMORY_KG=on`
(back-compat: `QMD_RECALL_KG_RAW=on` and `QMD_RECALL_KG=on` still work).
Three conditions must all be true to fire:
1. Opt-in via env
2. Query contains ≥ 1 proper-noun entity
3. Top score is weak (relative to RRF scale — uses dynamic threshold)
KG facts are injected at `median(current_scores)` (scale-adaptive).

**Files:** `src/memory/knowledge.ts`, recall integration in
`src/memory/index.ts`.

---

## Tiered storage

Three tiers, one table:

| Tier | Decay threshold | Use case |
|---|---|---|
| **peripheral** | composite < 0.3 | new + low-importance, default landing |
| **working** | 0.3 ≤ composite < 0.8 | active memories the agent uses |
| **core** | composite ≥ 0.8 | always-on, always-recalled |

Tier is a column on `memories`, written by `runDecayPass`. Callers can
filter at retrieval time via `memoryRecall({tier: "core"})`. The Hindsight
"mental model" pattern is implemented as a `tier=core` query that returns
the always-on context block.

`runTieredRecall(db, options)` is a separate API that pulls a balanced
mix from all three tiers in one call (e.g. 5 from core + 10 from working
+ 5 from peripheral). Not currently wired into the eval harness.

**Files:** `src/memory/decay.ts`, `src/memory/index.ts` (tier filter +
`runTieredRecall`).

---

## End-to-end ASCII flow (one diagram for everything)

```
┌────────────────────── INGEST ─────────────────────┐  ┌──────── DREAM ───────┐
│                                                   │  │                      │
│  caller (CLI / MCP / OpenClaw / SDK / eval harness)│  │  agent_end hook OR  │
│       │                                            │  │  qmd dream CLI OR   │
│       ▼                                            │  │  memory_dream MCP   │
│  memoryStore / memoryStoreBatch                    │  │       │              │
│       │                                            │  │       ▼              │
│       ├─ Phase 0  turns→text + chunking           │  │  runCleanupPass     │
│       ├─ Phase 1  hash dedup                       │  │   ├─ runDecayPass   │
│       ├─ Phase 2  cosine dedup (single only)       │  │   │   ├ Weibull     │
│       ├─ Phase 3  embedTextBatch (micro 32)        │  │   │   ├ promote     │
│       ├─ Phase 4  bulk INSERT memories+fts+vec     │  │   │   └ demote      │
│       └─ Phase 5  opt-in extract/reflect/synth     │  │   └─ runEviction    │
│                                                    │  │       (LRU-K-lite)  │
│                                                    │  │                      │
│  → memories table + memories_fts + memories_vec    │  │  runReflectionPass  │
│  → optional: knowledge table                       │  │   (Generative-Agts) │
│                                                    │  │   → new memories    │
└────────────────────────────────────────────────────┘  │     of cat=reflection│
                                                        │                      │
                  ▲                                     │  Touches all tiers,  │
                  │                                     │  shifts boundaries.  │
                  │                                     └──────────────────────┘
┌────────────────────── RECALL ─────────────────────┐
│                                                    │
│  query + scope + category + tier + limit           │
│       │                                            │
│       ▼                                            │
│  memoryRecall                                      │
│       │                                            │
│       ├─ A0  query expansion (entities/keywords)   │
│       ├─ A1  FTS5 BM25 → ftsRanks ─┐              │
│       │                             │ parallel     │
│       ├─ A2  embed → vec0 KNN → vecRanks ┘         │
│       │        scope-partitioned + cosine floor    │
│       ├─ B   RRF fusion (rank-based, 0.8/0.2)     │
│       │        scores on ~0.003-0.033 scale        │
│       ├─ C   post-fusion boosts (gated by !RAW)    │
│       │        keyword / phrase / decay / temporal  │
│       ├─ D   sort                                  │
│       ├─ E   rerank (QMD_MEMORY_RERANK=on)         │
│       │        10% RRF + 90% cross-encoder blend   │
│       ├─ F1  KG injection (QMD_MEMORY_KG=on)       │
│       ├─ F2  dialog diversity (MMR-lite)           │
│       └─ F3  touch access counts (batched)         │
│                                                    │
│  → MemoryRecallResult[] (sorted, top-K)            │
└────────────────────────────────────────────────────┘
```

---

## Provider matrix

What each phase actually uses, and where it can go remote vs local:

| Phase | Step | Local default | Remote option |
|---|---|---|---|
| Ingest | embed | mxbai-xs q8 (transformers.js, ONNX) | OpenAI / ZeroEntropy / SiliconFlow / Gemini / Nebius |
| Ingest | classify | regex patterns (`patterns.ts`) | — |
| Ingest | extract triples | heuristic fallback | remote LLM (`extractor.ts`) |
| Ingest | conflict resolution | cosine threshold only | remote LLM ADD/UPDATE/DELETE/NONE |
| Recall | embed query | mxbai-xs q8 | same as ingest |
| Recall | FTS | SQLite FTS5 (porter stemmer) | — |
| Recall | rerank | ms-marco-MiniLM-L6 q8 (cross-encoder, transformers.js) | ZeroEntropy zerank, SiliconFlow bge, etc |
| Recall | reflect synthesis | n/a | remote LLM (`memoryReflect`) |
| Dream | decay | Weibull formula (decay.ts) | — |
| Dream | eviction | LRU-K-lite (decay.ts) | — |
| Dream | reflection | n/a (skipped without LLM) | remote LLM |

---

## Why each piece exists (one-line justification)

| Piece | Why it's in the pipeline |
|---|---|
| **FTS5** | Free, exact, lexical recall; no model dependency |
| **sqlite-vec** | Embedded ANN, no separate vector server |
| **RRF fusion** | Combines BM25 + vector without needing relevance scores on the same scale |
| **Strong-signal gate** | Skips expensive expansion and rerank when top-1 is already confident — saves ~30% wall on easy questions with zero quality loss |
| **Cross-encoder rerank** | Joint scoring of (query, passage) pairs catches cases bi-encoder cosine misses; used as 40/60 blend not full replacement so failures degrade gracefully |
| **Adaptive cosine floor** | Per-query threshold prevents the "tight distribution → empty pool" failure mode |
| **Dialog/session diversity** | Prevents one chatty session from hogging all top-K slots |
| **KG injection (3-gate)** | Recovers entity-anchored facts when text retrieval is weak; the 3 gates prevent the v8 "blunt injection" failure mode |
| **Tiered storage (Weibull)** | Lets recall filter by importance without sweeping the full table; promotes high-frequency memories |
| **Reflection synthesis** | Generative-Agents pattern — distills recent memory into compressed lessons |
| **Chunking** | Multi-vector coverage of long documents (mxbai-xs's 512-token cap would otherwise truncate) |
| **L1 user-only ingest** | Schift's L# cache pattern — strips assistant turns to focus the embedding centroid on the user's preference statements |

---

## Source file map

```
src/
├── memory/
│   ├── index.ts          ← memoryStore/Batch, memoryRecall, runReflectionPass, hot path
│   ├── decay.ts          ← Weibull formula, runDecayPass, runCleanupPass, eviction
│   ├── knowledge.ts      ← temporal KG triples
│   ├── extractor.ts      ← LLM + heuristic extraction
│   ├── patterns.ts       ← 16-regex zero-LLM classifier
│   └── import.ts         ← conversation format normalization (5 formats)
├── store/
│   ├── db-init.ts        ← schema, vec table init, dim-mismatch heal
│   ├── chunking.ts       ← chunkDocument (token-aware break points)
│   ├── constants.ts      ← all tunables (RRF k, weights, blend, chunk sizes)
│   └── ...
├── llm/
│   ├── transformers-embed.ts   ← mxbai-xs q8 backend (default local)
│   ├── transformers-rerank.ts  ← ms-marco-MiniLM-L6 cross-encoder
│   ├── remote.ts               ← OpenAI/ZE/SF/Gemini/Poe providers
│   ├── cache.ts                ← LLM response cache
│   ├── gpu-probe.ts            ← OS-level VRAM/driver/NPU detector
│   └── embed-sizer.ts          ← device + microbatch + worker budgeter (QMD_TRANSFORMERS_DEVICE=auto)
├── mcp/server.ts          ← canonical CRUD MCP tool surface (26 tools)
├── openclaw/plugin.ts     ← OpenClaw integration + dream gate
└── cli/                   ← CLI split across focused modules (2026-04-18 refactor)
    ├── qmd.ts                  ← dispatcher + remaining command handlers
    ├── db-state.ts             ← Store/DB singleton and lifecycle
    ├── terminal.ts             ← ANSI colors, cursor, taskbar progress, warn/success/info
    ├── format.ts               ← ETA/time-ago/bytes/progress bar formatters
    ├── command-helpers.ts      ← resolveFsPath / requireValidVirtualPath / requireCollectionOrExit
    ├── collection-commands.ts  ← qmd collection list/remove/rename
    ├── context-commands.ts     ← qmd context add/list/remove + detectCollectionFromPath
    ├── skill-commands.ts       ← qmd skill show/install
    └── help-version.ts         ← qmd --help / --version
```

---

## Performance (LongMemEval _s n=500, mxbai-xs q8, 2026-04-17)

### Without rerank (production default)

With rank-based RRF + keyword expansion + synonym expansion (all default):

| Bucket | n | recall_any@5 | R@5 (frac) | MRR | NDCG@10 |
|---|---|---|---|---|---|
| knowledge-update | 78 | 99% | 97% | 0.955 | 0.958 |
| multi-session | 133 | 99% | 90% | 0.950 | 0.911 |
| single-session-assistant | 56 | 100% | 100% | 1.000 | 1.000 |
| single-session-preference | 30 | **97%** | **97%** | 0.745 | 0.800 |
| single-session-user | 70 | 100% | 100% | 0.898 | 0.923 |
| temporal-reasoning | 133 | 96% | 89% | 0.876 | 0.873 |
| **OVERALL** | 500 | **98.4%** | **93.7%** | **0.917** | **0.913** |

Wall: ~15 min (workers=2, microbatch=64, Windows native).

### With rerank (QMD_MEMORY_RERANK=on, normalized 0.7/0.3 blend)

| Metric | No rerank | With rerank | Delta |
|---|---|---|---|
| recall_any@5 | 98.4% | 98.0% | -0.4pp |
| R@5 (fractional) | 93.7% | **93.8%** | +0.1pp |
| MRR | **0.917** | 0.911 | -0.6pp |
| NDCG@10 | **0.913** | 0.912 | tied |
| preference MRR | **0.745** | 0.740 | -0.5pp |
| temporal MRR | 0.876 | **0.896** | +2.0pp |

Wall: ~17 min (+15% for cross-encoder forward pass).

**Verdict:** rerank on the proper RRF pipeline is near-neutral — helps
temporal (+2pp MRR), slight regression elsewhere. The old additive
pipeline's 0.1/0.9 rerank blend (MRR 0.937) was an artifact of the
broken first stage. Ship rerank as opt-in; default off.

### vs competitors (same dataset, live-reproduced)

| System | recall_any@5 | MRR | NDCG@10 |
|---|---|---|---|
| **qmd (no rerank, default)** | **98.4%** | **0.917** | **0.913** |
| qmd (with rerank) | 98.0% | 0.911 | 0.912 |
| MemPalace raw | 96.6% | — | — |
| agentmemory hybrid | 95.2% | 0.882 | 0.879 |

### Progress over time (LongMemEval _s n=500, mxbai-xs q8)

| Date | recall_any@5 | R@5 | MRR | NDCG@10 | Key change |
|---|---|---|---|---|---|
| 2026-04-12 | 88.0% | — | — | — | initial run (fastembed MiniLM) |
| 2026-04-13 | 94.2% | — | 0.833 | 0.828 | mxbai-xs q8 + cosine gate |
| 2026-04-14 | 98.2% | — | — | — | sr5 metric audit (partition key) |
| 2026-04-15 | 97.6% | 92.9% | 0.919 | 0.917 | metric rigor (fractional R@K, NDCG fix) |
| 2026-04-16 | 98.0% | 93.6% | 0.920 | 0.920 | ftsOverfetch 20→10 sweep |
| **2026-04-17** | **98.4%** | **93.7%** | **0.917** | **0.913** | RRF + keyword + synonym expansion |

### Per-stage latency (QMD_RECALL_PROFILE=on)

- FTS5: 1-15 ms (uniformly cheap)
- embed_wait: 5-2400 ms (variable — WASM thread contention with workers)
- vec0: 1-3 ms (uniformly cheap)
- rerank: 5-50 ms per candidate (cross-encoder forward pass)

**Profile note:** embed_wait variance is queue contention on the single
transformers.js WASM thread — multiple worker async slots fight for the
embed pipeline. Bench-specific; single-agent production workloads don't
hit it.

### Design rationale for RRF weights (0.8 BM25 / 0.2 vec)

Vec (mxbai-embed-xsmall-v1 384d q8) is too weak to contribute
meaningfully to ranking on LME. Swept at n=100:

| RRF weights | rAny@5 | R@5 | s-user rAny5 |
|---|---|---|---|
| 1.0/0.0 (BM25-only) | 99% | 93.5% | 99% |
| 0.9/0.1 | 99% | 94.4% | 99% |
| **0.8/0.2** | **99%** | **95.0%** | **99%** |
| 0.7/0.3 | 97% | 92.8% | 96% |
| 0.4/0.6 | 90% | 86.3% | 86% |

More vec weight → s-user collapses (vec pushes wrong sessions above
correct BM25 matches). 0.8/0.2 is the sweet spot: tiny vec contribution
helps multi-session fractional recall without hurting binary recall.
Path to better vec: fact-augmented embedding keys (see ROADMAP).

---

## What's NOT in the pipeline (deliberate omissions)

- **No graph DB** — temporal KG lives in a SQLite table
- **No vector server** — sqlite-vec extension instead
- **No message queue** — synchronous in-process
- **No file watcher** — `qmd update` is on-demand
- **No backend abstraction** — single sqlite-vec implementation; pluggable
  backend interface is parked under TODO §4 until a second backend is
  needed
- **No cron** — `qmd dream` runs on demand or via OpenClaw's
  `agent_end` hook

---

## See also

- `docs/ROADMAP.md` — version history, technique tables, A/B results
- `docs/EVAL.md` — how to run LongMemEval + LoCoMo
- `docs/TODO.md` — open optimization queue
- `~/.claude/playbooks/code-navigation-stack.md` — graphify + Serena +
  vexp playbook (not part of qmd; agent tooling)

---

## Appendix A — qmd ↔ SQLite integration

This section answers two related questions: **how does qmd plug into
SQLite**, and **what does qmd actually do on top of SQLite**? The
short version: SQLite + two extensions handle storage and indexing,
qmd adds the orchestration, scoring, and lifecycle.

### Layer cake

```
┌─────────────────────────────────────────────────────────────┐
│  Caller                                                      │
│  ─ agent (Claude Code, OpenClaw, custom MCP client)          │
│  ─ CLI (`qmd memory recall ...`)                             │
│  ─ SDK (`createStore().memorySearch(...)`)                   │
│  ─ eval harness (longmemeval/eval.mts, AMB adapter)          │
└──────────────────────┬───────────────────────────────────────┘
                       │ MCP / CLI / direct API
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  qmd MCP server  (src/mcp/server.ts)                         │
│  26 canonical tools: memory_add, memory_search, memory_get,  │
│  memory_list, memory_delete, memory_dream, memory_reflect,   │
│  knowledge_add, doc_search, doc_get, briefing, ...           │
│  Stdio + StreamableHTTP transport                            │
└──────────────────────┬───────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  qmd memory layer  (src/memory/index.ts + sub-modules)       │
│                                                              │
│  ┌──────────────┐ ┌──────────────┐ ┌─────────────────────┐  │
│  │ ingest       │ │ recall       │ │ maintenance / dream │  │
│  │ - dedup      │ │ - expand     │ │ - Weibull decay     │  │
│  │ - chunk      │ │ - FTS+vec    │ │ - LRU-K eviction    │  │
│  │ - embed      │ │ - RRF fuse   │ │ - reflection        │  │
│  │ - classify   │ │ - boost      │ │ - tier promotion    │  │
│  │ - extract KG │ │ - rerank     │ │                     │  │
│  └──────────────┘ │ - KG inject  │ └─────────────────────┘  │
│                   │ - diversify  │                          │
│                   └──────────────┘                          │
│                                                              │
│  Plus: knowledge graph (knowledge.ts), classifier patterns,  │
│  conversation import (5 formats), embed cache (LRU 100)      │
└──────────────────────┬───────────────────────────────────────┘
                       │ better-sqlite3 (sync, blocking)
                       ▼
┌─────────────────────────────────────────────────────────────┐
│  SQLite core  (better-sqlite3 + sqlite-vec extension)        │
│                                                              │
│  Tables in `~/.cache/qmd/index.sqlite`:                      │
│                                                              │
│  ┌────────────────────┐  ┌───────────────────────────────┐   │
│  │ memories           │  │ memories_fts  (FTS5 virtual)  │   │
│  │ - id PK            │  │ - mirrors memories.text       │   │
│  │ - text             │  │ - porter stemmer + BM25       │   │
│  │ - content_hash     │  │ - rebuilt on UPDATE/DELETE    │   │
│  │ - category         │  └───────────────────────────────┘   │
│  │ - scope            │                                      │
│  │ - importance       │  ┌───────────────────────────────┐   │
│  │ - tier             │  │ memories_vec  (vec0 virtual)  │   │
│  │ - access_count     │  │ - PARTITION KEY = scope       │   │
│  │ - created_at       │  │ - id TEXT PRIMARY KEY         │   │
│  │ - last_accessed    │  │ - embedding float[N]          │   │
│  │ - metadata (JSON)  │  │ - distance_metric=cosine      │   │
│  └────────────────────┘  └───────────────────────────────┘   │
│                                                              │
│  ┌────────────────────┐  ┌───────────────────────────────┐   │
│  │ memory_history     │  │ knowledge                     │   │
│  │ - audit log        │  │ - subject/predicate/object    │   │
│  │ - skippable        │  │ - valid_from / valid_until    │   │
│  │   per ingest       │  │ - scope-isolated              │   │
│  └────────────────────┘  └───────────────────────────────┘   │
│                                                              │
│  Plus PRAGMAs: WAL journal, NORMAL sync, mmap_size,          │
│  cache_size, foreign_keys ON                                 │
└─────────────────────────────────────────────────────────────┘
```

### What SQLite handles vs what qmd handles

| Concern | Owner | Notes |
|---|---|---|
| Row storage | SQLite | one db file, WAL mode |
| BM25 ranking | FTS5 extension | porter stemmer, automatic rank() |
| ANN vector search | sqlite-vec extension | vec0 virtual table, scope-partitioned |
| Cosine distance | sqlite-vec | `distance_metric=cosine` flag at table create |
| Concurrency | SQLite WAL | N readers, 1 writer; better-sqlite3 calls block JS thread briefly |
| Persistence | SQLite | flush via WAL checkpoint on close |
| **Hash dedup** | qmd | `content_hash` column + single-roundtrip `IN (...)` lookup |
| **Cosine dedup** | qmd | uses vec0 KNN to find similar then thresholds |
| **Chunking** | qmd | `chunkDocument()` splits long text before embed |
| **Embedding** | qmd | calls TransformersEmbedBackend or remote provider |
| **RRF fusion** | qmd | merges FTS5 ranks + vec0 KNN ranks into a unified score |
| **Strong-signal gate** | qmd | normalizes top-1 score, decides whether to skip rerank/expansion |
| **Cross-encoder rerank** | qmd | calls TransformersRerankBackend; SQLite is uninvolved |
| **Decay scoring** | qmd | Weibull formula in `decay.ts`, writes back to `tier` column |
| **LRU eviction** | qmd | LRU-K-flavored backward window scan in `decay.ts` |
| **Knowledge graph** | qmd | temporal triples in a regular SQLite table — no graph DB |
| **Classification** | qmd | regex patterns in `patterns.ts` (16 categories) |
| **Reflection synthesis** | qmd → remote LLM | calls Gemini/etc, stores result as new memory |
| **Multi-format conversation import** | qmd | 5 conversation formats normalized in `import.ts` |
| **Tier filtering** | qmd | column lookup, no special index |
| **Audit log** | SQLite + qmd | qmd writes rows, SQLite stores them |

**The pattern: SQLite + extensions handle the boring storage primitives
(rows, indexes, BM25, cosine distance). qmd handles the interesting
parts (when to dedup, what to chunk, how to fuse rankings, when to
rerank, when to skip, how to age memories, how to consolidate them).**
SQLite is intentionally a dumb store; all the "memory framework" logic
lives in `src/memory/`.

### Why one db file

- **Embedded** — no server, no install, no infra. The whole memory
  layer is `~/.cache/qmd/index.sqlite` plus the model cache.
- **Atomic** — backups, snapshots, and migration are all `cp index.sqlite`
- **Single source of truth** — text, vectors, FTS index, knowledge graph,
  audit log, history all in one transactional store
- **Portable** — works identically on macOS, Linux, Windows, WSL, VMs
- **No network** — entire pipeline can run offline (with local embed)

The trade-off is the SQLite single-writer model. qmd accepts this
because the framework's primary deployment shape is **single agent →
single db**, where there's only one writer at a time. Multi-agent
same-machine workloads (the eval harness with `--workers > 2`) hit
contention; per-scope DB partitioning is the documented future fix
(see `~/.claude/plans/backend-perfection-2026-04-15.md`) but parked
until a real production workload demands it.

### Extension load order

At db open (in `src/db.ts`):

```
1. better-sqlite3 opens the file (WAL mode, NORMAL sync)
2. sqlite-vec extension loaded via db.loadExtension('vec0.dll')
3. PRAGMAs applied: foreign_keys=ON, mmap_size, cache_size
4. Schema init runs (CREATE TABLE IF NOT EXISTS for memories +
   FTS5 + vec0 + knowledge + memory_history)
5. Dim-mismatch check on memories_vec — auto-heal if embed model
   dimension changed (drop stale vec table + content_vectors, warn,
   recreate)
```

After this, all qmd operations are direct SQL prepared statements via
better-sqlite3. No ORM, no query builder.

### What qmd is NOT (positioning, not capability gaps)

- **Not an agent framework** — qmd provides memory primitives; agents
  drive them via MCP / CLI / SDK. Pair with OpenClaw, Letta, or your
  own loop.
- **Not a workflow engine** — synchronous in-process pipelines, no
  job queue, no scheduler. Cron is your problem.
- **Not a hosted service** — local-first by design. Every call runs in
  the caller's process. There's no qmd cloud.
- **Not bound to SQLite forever** — sqlite-vec + FTS5 is the current
  default backend because it's embedded and zero-infra. Pluggable
  storage (LanceDB, pgvector) is on the roadmap as the framework grows
  beyond single-agent shapes.

qmd's identity is the memory framework — hybrid retrieval, KG, decay,
tiers, reflection, conflict resolution, the orchestration that ties
them together. SQLite is an implementation detail of today's default
backend, not the product.
