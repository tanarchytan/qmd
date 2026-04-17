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


## Findings by David (Human)

### 1. Competitor architectures — metadata vs vectors split

| System | Metadata store | Vector store | Split or unified? |
|--------|---------------|-------------|-------------------|
| **Mem0** | SQLite (`history.db` for audit/versioning) | Pluggable: Qdrant (default, local at `/tmp/qdrant`), pgvector, Chroma, 20+ providers via factory pattern | **Split.** SQLite for history/audit, vector DB for embeddings. VectorStoreBase abstract interface. |
| **Zep/Graphiti** | Neo4j (knowledge graph, entities, communities, temporal edges) | Neo4j Lucene (BM25 + semantic via BGE-m3 embeddings stored as node properties) | **Unified in Neo4j.** Both graph structure and embeddings live in the same Neo4j instance. |
| **Letta/MemGPT** | PostgreSQL (agent state, conversations, metadata) | pgvector extension on the same PostgreSQL | **Unified in Postgres.** Metadata and vectors in one database via pgvector extension. |
| **agentmemory** | In-memory Map (KV store via iii-engine) | In-memory vector index (iii-engine) | **Unified in iii-engine.** Single in-process engine handles both. No separate vector store. |
| **Hindsight** | Embedded PostgreSQL (pg0) for structured knowledge, entities, relationships | Same PostgreSQL with vector support | **Unified in embedded Postgres.** |
| **Supermemory** | Not disclosed (proprietary) | Not disclosed | Unknown |
| **MemPalace** | SQLite (knowledge graph triples) | ChromaDB (single collection for all drawers) | **Split.** SQLite for KG, ChromaDB for vectors. |

The pattern: **most production systems that split do SQLite/Postgres for metadata + a dedicated vector store.** Mem0's architecture is the closest precedent for what you're planning. Their `VectorStoreBase` abstract interface with 20+ provider adapters via factory pattern is exactly the `MemoryBackend` interface you have on your TODO.

### 2. sqlite-vec at scale — what Alex Garcia says

From Alex Garcia's v0.1.0 blog post, direct benchmarks at 100k vectors on disk:

| Dimensions | Element type | Query latency (avg) |
|-----------|-------------|-------------------|
| 3072 | float32 | 214ms |
| 1536 | float32 | 105ms |
| 1024 | float32 | ~85ms (interpolated) |
| 768 | float32 | <75ms |
| 384 | float32 | <75ms |
| 3072 | bit | 11ms |

His "golden target" is sub-100ms. At your 384d float32, you're comfortably under that at 100k vectors. His honest assessment: "most applications of local AI aren't working with billions of vectors. Most deal with thousands, maybe hundreds of thousands."

**ANN/HNSW status:** Not yet in sqlite-vec. Alex says it will "eventually gain some form of ANN indexes in the near future" and points to GitHub issue #25. Current approach is brute-force only. For HNSW on SQLite, there's a separate project **vectorlite** that wraps hnswlib and provides 3x-100x faster queries than sqlite-vec at the cost of lower recall, but it's a different extension entirely.

**Key finding from vectorlite benchmarks:** At 20k vectors, vectorlite with HNSW is 8x-80x faster than sqlite-vec brute force depending on dimensions. The gap grows with dataset size since sqlite-vec is linear scan and HNSW is logarithmic.

### 3. LanceDB specifics for your constraints

**Node.js SDK:** Yes, native bindings via napi-rs. Works from Node/TypeScript directly.

**Latency at scale (from LanceDB FAQ and benchmarks):**
- Brute-force KNN on 100k vectors of 1000d: <20ms (their own benchmark)
- Sub-100ms without a vector index for datasets under 100k
- With IVF-PQ index at billion scale: <10ms claimed
- Enterprise benchmark: 25ms vector search, 50ms with metadata filtering

**Concurrent writers:** Yes. This is the biggest advantage over sqlite-vec for your multi-agent use case.

**Install footprint:** Rust-backed native bindings. The napi-rs approach means it ships prebuilt binaries for major platforms (Windows x64, macOS arm64/x64, Linux x64). No Python dependency. Fits your "Node.js only, no Python runtime" constraint.

**Storage model:** File-based (Lance/Arrow columnar format). Would coexist fine at `~/.cache/qmd/lancedb/` next to your SQLite file.

**Cold start:** Memory-mapped files mean first query may need to fault pages in from disk. On SSD this is fast. On HDD it would be noticeable. No published cold-start numbers found.

**Multi-tenancy:** Table-per-collection. Each agent/scope could be a separate table. Isolation is clean.

**The node-vector-bench project (photostructure)** benchmarks LanceDB vs USearch vs sqlite-vec at 1k through 2M vectors in Node.js specifically. Their profiles go up to 512d which matches your 384d neighborhood. This is probably the most directly relevant benchmark for your decision since it's Node.js, the same runtime you'd use.

### 4. Option assessment against your constraints

| Constraint | sqlite-vec (keep) | LanceDB | Chroma | Qdrant |
|-----------|-------------------|---------|--------|--------|
| Zero-setup (npm install) | Already there | Native bindings ship prebuilt | Needs Python or Docker server | Needs Docker server |
| Node.js only | Yes (better-sqlite3) | Yes (napi-rs) | REST client only (needs server process) | REST client (needs server) |
| Windows + macOS + Linux | Yes | Yes (prebuilt binaries) | Server dep complicates Windows | Docker required |
| Concurrent writers | No (WAL = 1 writer) | Yes | Yes (server) | Yes (server) |
| HNSW/ANN | No (brute force only) | Yes (IVF-PQ, IVF-HNSW-PQ) | Yes (hnswlib) | Yes (HNSW + quantization) |
| Embedded (no server) | Yes | Yes | No (needs server for persistence) | No (server only) |
| 100k vector latency (384d) | <75ms brute force | <20ms brute force, faster with index | ~20ms p50 (cloud), variable local | ~2.4ms (but requires server) |

### 5. Recommendation based on research

**Chroma and Qdrant both fail your "zero-setup, Node.js only, no server" constraint.** Chroma's embedded mode is Python-only. Their JS client requires a running Chroma server. Qdrant is server-only. Both would break your `npm install` story.

**LanceDB is the only candidate that matches all your constraints.** Embedded, file-based, native Node.js bindings, concurrent writers, HNSW support, cross-platform prebuilt binaries. It's essentially "sqlite-vec but with ANN indexes and concurrent write support."

**Option D (keep sqlite-vec and tune) remains viable longer than you might think.** At 384d float32, sqlite-vec handles 100k vectors in <75ms. Your current per-scope partition means most queries scan far less than 100k. Unless you're genuinely hitting multi-agent concurrent write contention today, the "problem" might still be theoretical. The node-vector-bench project could give you real numbers to decide.

**The pragmatic path:** Keep sqlite-vec as default (it works, it's proven, zero-setup). Add LanceDB as the second `MemoryBackend` adapter. Gate it behind a config flag (`QMD_VECTOR_BACKEND=lancedb`). Benchmark both at LME n=500 to confirm no regression, then stress-test at 100k+ to measure the actual crossover point. Ship both, let users choose based on their workload.

---

## Claude's follow-up research (2026-04-17)

Verified David's findings + added gaps. Key corrections / additions:

### Chroma Node.js embedded mode — CONFIRMED NO

David's finding is correct. The `chromadb` npm package is **HTTP-client only**. `PersistentClient` is a Python feature. Node.js Chroma requires a running server process (Python or Docker). Fails our zero-setup constraint. [Chroma Cookbook](https://cookbook.chromadb.dev/core/clients/), [chromadb npm](https://www.npmjs.com/package/chromadb).

### memory-lancedb-pro — found the canonical repo

- Primary: [`CortexReach/memory-lancedb-pro`](https://github.com/CortexReach/memory-lancedb-pro) — Enhanced LanceDB memory plugin for OpenClaw.
- Forks exist: `aaronx-hu`, `kvc0769` (Volcengine variant), `fryeggs` (multi-client: OpenClaw + Claude Code + Codex).
- Bundles `@lancedb/lancedb ^0.26.2` as an npm dependency — **no manual install needed, LanceDB ships prebuilt via npm**.
- Features: RRF fusion of BM25 + vec, cross-encoder rerank (Jina/SiliconFlow/Voyage/Pinecone), MMR diversity, multi-scope isolation, recency boost, time decay.
- Demo project: [`lancedb/openclaw-lancedb-demo`](https://github.com/lancedb/openclaw-lancedb-demo) — "local-first memory layer pattern for OpenClaw... get started in just a few minutes."
- Official skill manifest: [`openclaw/skills`](https://github.com/openclaw/skills/blob/main/skills/aaronx-hu/memory-lancedb-pro/SKILL.md).

**Takeaway:** LanceDB Node binding is genuinely zero-setup — `npm install` grabs the prebuilt native lib. No cmake, no Docker, no Python. The memory-lancedb-pro setup UX we've been admiring is basically "npm install + one env var."

### vectorlite — viable sqlite-vec alternative inside SQLite

The DIY HNSW path for SQLite is [`vectorlite`](https://github.com/1yefuwang1/vectorlite), npm package available.

- 357 GitHub stars, last release v0.2.0 Aug 2024 (maintained but slow).
- Prebuilt for Windows-x64, Linux-x64, macOS-x64, macOS-arm64.
- Benchmark vs sqlite-vec: **8x-100x faster queries** (depending on dimensions), **6x-16x slower inserts**.
- At 3000 vectors / 384d: ~15x faster queries than sqlite-vec.
- Known limitations: **no transaction support**, ARM 3-4x slower than x64 on macOS, in-memory indexing (with disk serialization).
- Caveat: ingest-heavy workloads (like our LME per-question ingest) would pay the 6-16x insertion penalty.

**Takeaway:** vectorlite would give us HNSW without leaving the SQLite ecosystem. Could be a smaller-delta change than LanceDB. But the insertion penalty matters — our LME bench ingests ~100-500 memories per question before recall. Worth benchmarking before choosing.

### sqlite-vec — active development but no HNSW yet

- Alex Garcia's v0.1.0 blog confirmed: brute-force only, ANN coming "eventually" (GitHub issue #25).
- Alternative: [sqlite.ai](https://www.sqlite.ai/sqlite-vector) builds a different vector extension ("blazing fast and memory efficient") — worth tracking.

### node-vector-bench — exists but no published numerical results

David cited [`photostructure/node-vector-bench`](https://github.com/photostructure/node-vector-bench) as the most relevant benchmark. Fetched the repo — it has SVG charts but **no raw numerical tables in the README**. Qualitative conclusions published:

- **sqlite-vec**: exact recall, fast insert, "slow at scale" — best for small datasets needing exact results
- **USearch**: high/consistent recall, fast queries, slow build (graph construction) — best for read-heavy with build-time budget
- **LanceDB**: recall degrades at scale without tuning, fast query with tuned index, fast build — best for large datasets exceeding RAM

**To get actual numbers we'd need to run the benchmark locally.** Not hard — it's Node.js, we have the stack. Could be a Phase 10 task if Phase 6 (fact-augmented keys) doesn't land.

### Mem0's architecture — confirmed split pattern

- **24+ vector store providers** (Qdrant default, pgvector, Chroma, etc.) behind a `VectorStoreBase` abstract interface.
- `VectorStoreConfig` unified config, provider-specific configs (`QdrantConfig`, etc.), `VectorStoreFactory` for dynamic instantiation.
- **SQLite tracks memory change history + audit trails** (the `history.db`), separate from vectors.
- Known bug ([#4290](https://github.com/mem0ai/mem0/issues/4290)): history.db uses relative `memory.db` path + vector_store.db uses `process.cwd()` — production deployments hit this.

**Takeaway:** their architecture is exactly what the "proposed split" in this doc describes. They also confirm the `MemoryBackend` interface pattern is the industry-standard approach.

### Final recommendation (unchanged + reinforced)

1. **Ship LanceDB as second adapter** via `MemoryBackend` interface. Zero-setup claim holds (prebuilt via npm). Concurrent writers solve the multi-agent story. HNSW handles scale.
2. **Keep sqlite-vec as default** for existing users / zero-migration cost.
3. **Optional: benchmark vectorlite as third option** — smaller code delta if we want HNSW without leaving SQLite. Worth one afternoon of n=500 + stress test.
4. **Deprecate Chroma from consideration.** Node client is HTTP-only; server dependency breaks our setup story.
5. **Monitor sqlite-vec for ANN support** — Alex's GitHub issue #25. If it lands, the decision inverts.

Sources (most-cited):
- [CortexReach/memory-lancedb-pro](https://github.com/CortexReach/memory-lancedb-pro)
- [LanceDB blog: OpenClaw Memory from Zero to LanceDB Pro](https://www.lancedb.com/blog/openclaw-memory-from-zero-to-lancedb-pro)
- [Mem0 DeepWiki: Storage Backends](https://deepwiki.com/mem0ai/mem0/5-vector-stores)
- [vectorlite GitHub](https://github.com/1yefuwang1/vectorlite)
- [node-vector-bench](https://github.com/photostructure/node-vector-bench)
- [Chroma Cookbook: Clients](https://cookbook.chromadb.dev/core/clients/)

---

## Deep dive: Mem0's architecture (2026-04-17)

Mem0 is the closest precedent for what we're planning. Their split architecture
shipped across 24+ vector providers is the reference design.

### Stack (Python vs Node)

**Python Mem0:**
- Vector store: **pluggable, required configuration** (24+ providers: Qdrant default, PGVector, Chroma, Pinecone, Weaviate, Milvus, Redis/Valkey, Elasticsearch, etc.). No in-memory default — Python users must pick one.
- History: SQLite (`history.db`) — always SQLite, not pluggable.
- Graph: optional Neo4j (for graph memory feature).

**Node/TypeScript Mem0:**
- Vector store default: **SQLite-backed in-memory** (only in Node, not Python). Hardcodes path to `process.cwd()/vector_store.db`. This is what runs when you `npm install mem0ai` and do nothing else.
- History: SQLite (`memory.db`), also defaulting to `process.cwd()`.
- No graph memory in Node SDK yet.

**Key takeaway:** Mem0 Node actually ships a SQLite-backed vector store as
default, same as qmd today. The difference is it's their weakest path —
the pluggable Python providers get all the features (metadata filtering,
HNSW, hybrid search). The Node in-memory store is "good enough for
getting started."

### The `VectorStoreBase` interface (their MemoryBackend)

File: `mem0/vector_stores/base.py`. Abstract class that all providers
implement. Core operations:

```
add(vectors, payloads, ids)       // insert with metadata + explicit ids
search(query_vector, limit, filter)  // cosine sim + optional payload filter
update(id, vector, payload)       // mutable entries
delete(id)                        // hard delete
list(filters, limit)              // iterate filtered subset
get(id)                           // single fetch
```

Payload = arbitrary JSON metadata stored alongside each vector. Used for
filtering at search time (e.g. `{user_id: "X"}` filter).

**Factory pattern:** `VectorStoreFactory.create(config)` dispatches on
`config.provider` string → imports the provider module → instantiates
with `config.config` subfield.

**Config shape:**
```yaml
vector_store:
  provider: qdrant   # or pgvector, chroma, etc.
  config:
    host: localhost
    port: 6333
    collection_name: mem0
history:
  provider: sqlite
  config:
    path: ~/.mem0/history.db
```

### Issue #4290 — the cautionary tale

Real production bug: `historyDbPath` in user config is **ignored** in
OSS mode. Both `memory.db` (history) and `vector_store.db` (in-memory
vec) hardcode to `process.cwd()`. Consequences:
1. Launch mem0 from any non-writable cwd → crash.
2. Two different mem0 processes in the same cwd → they stomp each
   other's DB files.
3. Can't relocate DBs to a proper cache dir.

qmd avoids all three (we use `~/.cache/qmd/index.sqlite` always,
single file, single writer). But the lesson for our multi-backend
work: **let users configure paths explicitly, never silently
defaulting to cwd**.

### What Mem0 does well (worth borrowing)

1. **VectorStoreBase is clean.** Six methods, payload-in-metadata design, explicit IDs. The API surface is small enough to adapter-adapt.
2. **Factory pattern with config dispatch.** Adding a new backend doesn't touch existing code — just add a provider class + register in factory.
3. **History separation.** Mem0 keeps an audit log ("what changed when") separate from the vector data. qmd has `memory_history` table in the same SQLite — could be a separate SQLite in production to avoid hot-write contention with vector writes.
4. **Consistent payload filtering.** Every provider supports `filter={key: value}` → SQL WHERE equivalent at the backend. qmd's scope/category/tier params are the equivalent.

### What Mem0 does poorly (avoid)

1. **No default recommendation.** Python docs don't say "start here." Users pick a provider, download a docker image, deploy a Qdrant server, then connect. qmd's one-`npm install` story is genuinely better.
2. **In-memory store is a toy.** The Node default uses SQLite as a glorified flat file — no FTS5, no indexing. qmd already has more sophisticated default than Mem0 does.
3. **History path bugs.** Path handling in OSS mode is broken (#4290). Lesson: explicit path config with fallback to `~/.cache/{app}/`, never to `process.cwd()`.
4. **Graph memory only in Python.** Node users don't get KG. qmd has KG in both code paths — a clear advantage.

### Implications for qmd's multi-backend plan

**What our `MemoryBackend` interface should look like** (inspired by `VectorStoreBase`):

```ts
interface MemoryBackend {
  // Core CRUD (matches Mem0 VectorStoreBase)
  add(id: string, text: string, embedding: Float32Array, metadata: Record<string, unknown>): Promise<void>;
  get(id: string): Promise<Memory | null>;
  update(id: string, patch: Partial<MemoryPatch>): Promise<void>;
  delete(id: string): Promise<void>;

  // Search (add FTS + vec — our hybrid is richer than Mem0's)
  searchFts(query: string, limit: number, filter: Filter): Promise<RankedHit[]>;
  searchVec(embedding: Float32Array, limit: number, filter: Filter): Promise<RankedHit[]>;

  // Batch
  addBatch(items: Memory[]): Promise<void>;

  // Lifecycle
  close(): Promise<void>;
}

interface Filter {
  scope?: string;
  category?: string;
  tier?: string;
  // arbitrary metadata: { [key]: value }
}
```

**Factory** in `src/store/backend-factory.ts`:
```ts
createBackend(config: BackendConfig): MemoryBackend {
  switch (config.provider) {
    case "sqlite-vec":  return new SqliteVecBackend(config);  // existing
    case "lancedb":     return new LanceDBBackend(config);    // new
    case "vectorlite":  return new VectorliteBackend(config); // optional
  }
}
```

**Config shape** (mirrors `~/.config/qmd/.env`):
```
QMD_VECTOR_BACKEND=sqlite-vec          # or lancedb, vectorlite
QMD_VECTOR_PATH=~/.cache/qmd/vectors/  # backend-specific storage dir
```

**Crucial difference from Mem0:** qmd is hybrid search native. The backend
must expose BOTH BM25 and vec search (or back off to FTS5 + vec0 on the
sqlite-vec path). Mem0 treats BM25 as a separate concern (some providers
like PGVector support hybrid natively, others don't). Our `MemoryBackend`
needs hybrid as first-class.

### Concrete sequencing for Phase 9 (if we do this)

1. Extract the current sqlite-vec path behind `SqliteVecBackend` class implementing `MemoryBackend`. Zero behavior change. Typecheck + full test suite pass.
2. Write `LanceDBBackend` — `@lancedb/lancedb` for vec, keep SQLite for FTS5 + metadata (two-DB approach: primary SQLite, secondary LanceDB, joined by `id`).
3. Benchmark both at LME n=500. Must match 98.4% rAny@5 baseline within noise.
4. Stress test at 100k memories per scope. Measure query p50/p95, write throughput.
5. Document in `.env.example`. Ship as opt-in. Default stays sqlite-vec.
6. Revisit if enough users ask for multi-agent concurrent writes.

**What NOT to do:** rewrite in one big PR. Each phase is a commit or two,
each independently validated against LME.

### Sources for this deep dive

- [Mem0 Node Quickstart](https://docs.mem0.ai/open-source/node-quickstart)
- [Mem0 DeepWiki: Storage Backends](https://deepwiki.com/mem0ai/mem0/5-vector-stores)
- [Mem0 DeepWiki: Vector Store Providers](https://deepwiki.com/mem0ai/mem0/5.2-vector-store-providers)
- [Mem0 Issue #4290 (path bugs)](https://github.com/mem0ai/mem0/issues/4290)
- [Mem0 Core Architecture](https://deepwiki.com/mem0ai/mem0/2-core-architecture)