# Multi-agent + dedicated vector backend — planning notes

Status: planning only. Nothing implemented. Captures the motivation,
open questions, and the research data we need to gather before picking
an implementation path.

## Motivation

Current architecture: **single SQLite file with sqlite-vec virtual
table**. Works great for:
- Local-first, zero-setup (one file, no servers)
- Single-agent workloads (OpenClaw plugin, Claude Code)
- Benchmarks (LongMemEval _s hits 98.4% rAny@5)

Current architecture limits we're seeing or anticipating:
1. **Single-writer SQLite** — WAL mode helps but still one writer at a
   time. Multi-agent workloads (several OpenClaw agents writing
   simultaneously) serialize.
2. **sqlite-vec is an extension, not a first-class vector store** —
   no HNSW, no IVF, linear scan within scope partition. Fine at
   ~10k memories per scope, wobbly at 100k+.
3. **No cross-agent vector search** at scale — `scope = 'global'` works
   but linear scan over the whole index becomes a latency tax.
4. **No obvious path to sharding** — one SQLite file can't shard across
   machines. Production deployments with agent fleets need this.

## Proposed split

Keep SQLite for what it's good at, add a vector backend for what it's bad at:

```
┌─────────────────────────────────────────────────┐
│ SQLite (keep)                                   │
│ - memories table (text, metadata, timestamps)   │
│ - FTS5 (BM25 lexical search)                    │
│ - knowledge graph (subject/predicate/object)    │
│ - decay state, tier, access_count               │
│ - store_collections, contexts                   │
└─────────────────────────────────────────────────┘
            │
            │  joined via id
            ▼
┌─────────────────────────────────────────────────┐
│ Vector store (NEW, pluggable)                   │
│ - id → embedding mapping                        │
│ - approximate nearest neighbor (HNSW/IVF)       │
│ - scope partitioning (collection per agent?)    │
│ - local-first option (LanceDB) or process       │
│   colocated (Chroma client mode)                │
└─────────────────────────────────────────────────┘
```

Ranking pipeline unchanged:
- FTS5 still produces BM25 ranks → ftsRanks map
- Vector store produces cosine ranks → vecRanks map
- Same RRF fusion (0.9/0.1) weights
- Same post-fusion boosts + rerank

## Candidate vector backends

Gather research data for each:

### Option A: LanceDB (Rust-backed, embedded)

- **Architecture:** embedded, file-based (Arrow columnar format)
- **JS SDK:** yes, native bindings via napi-rs
- **HNSW + IVF:** both supported
- **Multi-tenancy:** table-per-collection, can be isolated per agent
- **Cloud option:** S3 + cloud-native support for scale-out
- **License:** Apache 2.0
- **Concurrent writers:** yes (unlike sqlite single-writer)

**Research questions:**
- Install footprint on Windows + macOS + Linux
- Cold-start latency (first query after load)
- Per-query latency at 10k, 100k, 1M vectors per scope
- Memory overhead per collection (we'd have many collections)
- How does `~/.cache/qmd/lancedb/` coexist with sqlite in `~/.cache/qmd/`
- Does the memory-lancedb-pro reference (user mentioned) have a working
  setup script we can study

### Option B: Chroma (Python-native, JS client)

- **Architecture:** client-server, but has embedded/persistent mode
- **JS client:** yes, REST API against local server
- **HNSW:** yes (via hnswlib)
- **Multi-tenancy:** collection-based
- **Cloud option:** Chroma Cloud
- **License:** Apache 2.0
- **Setup:** requires running Chroma server (docker or pip install)

**Research questions:**
- Can we run Chroma embedded (no separate server process) from Node?
- If client-server, what's the cold-start for `pip install chromadb`?
- How does this fit the "zero-setup local-first" story qmd currently has?
- Does Chroma's `EphemeralClient` (in-memory) scale to our workloads?

### Option C: Qdrant (Rust-backed, server)

- **Architecture:** server, gRPC + REST
- **JS client:** official @qdrant/js-client-rest
- **HNSW:** yes, with scalar/binary quantization
- **Multi-tenancy:** collection-based
- **Cloud option:** Qdrant Cloud
- **License:** Apache 2.0

**Research questions:**
- Embedded mode available? (research: probably no, it's server-only)
- Docker setup effort for local dev
- When does the server overhead pay off (scale threshold)

### Option D: Keep sqlite-vec but tune

- Investigate sqlite-vec v0.1+ improvements (vec0 vs vec1 format)
- Measure actual per-scope latency at production scales
- Maybe the "problem" is imagined — qmd's scope partition key could
  already be enough.

**Research questions:**
- What does sqlite-vec author say about 100k+ vectors per virtual table?
- Is there an IVF equivalent coming?
- Benchmark: sqlite-vec at 10k/100k vs LanceDB at same counts

## Research data I need from you

1. **Competitor architectures** — how do these systems split metadata vs vectors?
   - memory-lancedb-pro (you already mentioned)
   - mem0 (uses Qdrant by default I believe, or does it abstract?)
   - Mastra / Letta / MemGPT
   - Zep / Graphiti
   - agentmemory (in-memory Map currently — what's their production path?)
   - Supermemory / Hindsight

2. **Multi-agent patterns** — which systems support:
   - Multiple agents writing concurrently to the same memory store
   - Per-agent isolation with optional cross-agent read
   - Cross-agent knowledge sharing (facts learned by agent A
     auto-available to agent B if same scope)

3. **Scale references** — published numbers at:
   - 1k / 10k / 100k / 1M memories per agent
   - Query latency at each scale
   - Storage overhead (bytes per memory)

4. **memory-lancedb-pro deep dive**
   - Their setup-memory.sh script (you praised its UX)
   - How they handle LanceDB install on user machines
   - Their scope/collection model

5. **sqlite-vec production reports**
   - Anyone running sqlite-vec at 100k+ vectors with sub-100ms p95?
   - HNSW variants for SQLite (sqlite-hnsw exists?)

## What's NOT in scope for this note

- Actually implementing — that's a phase of its own
- Choosing a backend now — gather data first
- Committing to Chroma vs LanceDB — both might be supportable via
  a backend abstraction (`MemoryBackend` interface is already in TODO)

## Proposed next steps

1. You collect research data for the questions above (bulleted notes
   are fine; paste links + quotes).
2. I read it, summarize the tradeoffs per backend.
3. We pick one OR implement `MemoryBackend` interface with two adapters
   (sqlite-vec as today, plus LanceDB or Chroma).
4. Benchmark side-by-side at current LME n=500 — backend swap must not
   regress the 98.4% rAny@5 baseline.
5. Scale stress test at 100k+ memories per scope — the real reason for
   the change.

## Design constraints we must preserve

- Zero-API-setup for local dev (currently just `npm install`)
- Node.js only (no Python runtime required)
- ESM-compatible (no top-level await in import chain)
- Windows + macOS + Linux
- `~/.cache/qmd/` as the single cache root
- Reproducibility for benchmarks (deterministic given same inputs)
- Backward compatible: existing SQLite DBs should migrate or coexist
