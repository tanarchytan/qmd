# Pluggable storage backend — future possibility

> **Status:** parked. Not on any version roadmap. Captured so the analysis
> isn't lost. Revisit when there's a real motivation (multi-tenant deployment,
> 1M+ memories per scope, concurrency requirements that SQLite can't meet).

## Why this came up

QMD currently runs on SQLite + sqlite-vec for everything: documents, memories,
FTS, vector embeddings, knowledge graph. Most other long-term-memory systems
(Mem0, Zep, Letta) run on Postgres or split across multiple stores
(Qdrant + Postgres, Postgres + Neo4j, etc.). On 2026-04-13 the question came
up: should QMD migrate to Postgres + pgvector to better support long-term
memory at scale and improve performance?

This note captures the thinking so we can resume the discussion later
without re-deriving it.

## Honest assessment of the current setup

| Capability | SQLite + sqlite-vec | Postgres + pgvector |
|---|---|---|
| Concurrent writes | serialized per-DB (WAL helps reads) | MVCC, real concurrency |
| Vector ANN | vec0 linear walk per partition | HNSW + IVFFlat indexes |
| Multi-tenant | one DB file per user; no native sharing | row-level security, shared instance |
| Replication / backup | `cp file.sqlite` | streaming replication, PITR |
| Working scale | comfortable to ~100k-1M memories per scope | comfortable at 10M+ per index |
| Background workers | in-process or sidecar | native via pg_cron, NOTIFY |
| Production ops | none | yes — auth, port, backups, upgrades |

**Where SQLite wins for QMD's current positioning:**

- Every shipped entry point (CLI, MCP stdio, MCP HTTP daemon, OpenClaw plugin,
  SDK) assumes "no infrastructure." A user runs `npm install` + a command
  and gets memory. Postgres breaks this.
- Filesystem-level workflows: `cp ~/.cache/lotl/index.sqlite backup/`, open
  in DB Browser to debug, `mkdtempSync` per test.
- The OpenClaw plugin model where the host process owns the DB.
- Right-now scale: LME _s n=500 = 23,867 vectors total, ~48 per scope. Not
  remotely close to a SQLite limit.

**Where SQLite would actually hurt at scale:**

- Multi-tenant SaaS where a shared memory infrastructure serves many
  customers from one process.
- 1M+ memories per scope (we're at ~50 today on benchmarks, ~10k on
  large user vaults).
- Concurrent write throughput from many agents writing to the same
  scope simultaneously (single-writer SQLite serializes).
- Cross-machine: SQLite has no built-in replication.

## What the rest of the field does (and why)

| System | Stack | Why multi-store |
|---|---|---|
| Zep | Postgres + Neo4j | Graph traversal that's hard in pure SQL |
| Mem0 | Qdrant + Postgres + Neo4j | Enterprise multi-tenant; vector + relational + graph |
| Letta | Postgres | Recall + archival tier needs cross-process concurrency |
| MemPalace | ChromaDB EphemeralClient | Benchmark-shaped, throw-away per-question |
| **QMD** | **SQLite + vec0** | **Local-first dev tool, embedded** |

Each is right for their use case. Migrating QMD to Postgres because Zep does
it would be cargo-culting — Zep needs it because of their graph layer, not
because Postgres is universally better.

## The middle path: pluggable backend (the proposal)

Instead of replacing SQLite, ship multiple storage backends behind one
interface. The memory layer (`src/memory/index.ts`) talks to a
`MemoryBackend` interface; the implementing class can be SQLite, pgvector,
Qdrant, or anything else.

```
src/store/backend/
  ├── sqlite-vec.ts       (current default — on-device, embedded)
  ├── pgvector.ts         (new — server-mode, multi-tenant)
  ├── qdrant.ts           (new — dedicated vector DB, best-in-class HNSW)
  └── chroma.ts           (new — MemPalace's choice, benchmark parity)
```

Configuration:

```sh
LOTL_STORAGE_BACKEND=sqlite-vec    # default, on-device
LOTL_STORAGE_BACKEND=pgvector      # PG_URL=postgres://...
LOTL_STORAGE_BACKEND=qdrant        # QDRANT_URL=http://...
```

The eval harness, MCP tools, OpenClaw plugin, and CLI all stay
backend-agnostic. Tests run against all backends. Benchmarks confirm
parity.

### Persona / backend mapping

| Persona | Backend | Why |
|---|---|---|
| CLI / OpenClaw plugin user | `sqlite-vec` | zero ops, file-based, default |
| Production SaaS deployment | `pgvector` | multi-tenant, real concurrency |
| Vector-DB native shop | `qdrant` / `lance` | best-in-class ANN at 1M+ |
| MemPalace-compat benchmarks | `chroma` | reproducibility against their scripts |

## What this would actually take

Rough estimate, in dependency order:

1. **Storage interface design** (1-2 days). Define `MemoryBackend` with the
   methods `memoryStore` / `memoryRecall` / `memoryUpdate` / `memoryForget` /
   etc. need. Refactor existing sqlite-vec code to implement it. No behavior
   change, no new features. **This is the foundational commit.**
2. **pgvector backend** (2-3 days). Schema migration: memories →
   regular table, memories_fts → tsvector, memories_vec → `vector(N)` with
   HNSW index. Implement scope filtering with WHERE clauses (much cleaner
   in PG than vec0 partition keys). Run all unit tests against a local
   PG container.
3. **Eval parity validation** (1 day). Run LME _s n=500 against both
   backends. Confirm R@K and F1 numbers are within noise. **This is the
   real go/no-go.**
4. **Optional: Qdrant backend** (1-2 days). HTTP client wrapper, schema
   mapping. Could also do Lance / Chroma in similar effort.
5. **Documentation** (half day). CLAUDE.md, README, EVAL.md. Document
   the trade-offs (when to use what backend).

**Total:** ~1 week for sqlite-vec + pgvector dual support, ~2 weeks if we
add qdrant and chroma.

## Risks and trade-offs

**Risks:**
- The interface might leak SQLite-isms (e.g. JSON columns, FTS5 phrase
  syntax). Forces compromise on API design.
- Two backends to test means CI matrix doubles.
- Schema-migration burden: changes to memory metadata or vector dims
  must propagate to all backends.
- Postgres adds an ops surface (connection pooling, auth, backups,
  upgrades) that some users will trip on even if they opted in.

**Mitigations:**
- Keep the interface minimal: store, recall, update, forget, batch. Higher
  level features (decay, eviction, knowledge graph) live above the backend.
- Backend-specific extras (HNSW build params, vacuum schedules) go in
  per-backend config sections, not the core interface.
- Default stays sqlite-vec. Postgres is opt-in. Local users see no
  difference.

## When to revisit

Concrete triggers that would move this from "parked" to "scheduled":

1. **Multi-tenant deployment becomes real.** Someone wants to run QMD
   as a hosted service for many customers. SQLite-per-customer doesn't
   compose well there.
2. **A user vault crosses 1M memories per scope** and recall starts
   slowing measurably. We'd see it in `qmd memory stats` first.
3. **Concurrent write throughput becomes a bottleneck.** This would
   show up as observed contention, not theoretical concern.
4. **A large user / customer says "we run Postgres, can we plug QMD
   into ours?"** That's market signal worth listening to.

Without one of these, the abstraction layer adds maintenance burden
without unlocking a use case.

## Order of operations (when we eventually do it)

1. Land the storage-backend interface as a refactor commit. **No new
   backend yet** — just a clean abstraction over the existing SQLite
   code. Ship and run the full benchmark suite to confirm zero
   behavior change.
2. Add pgvector as the second backend. Run benchmarks on both. If
   pgvector matches or beats SQLite on benchmark numbers AND adds the
   capabilities we wanted, ship it as documented opt-in.
3. Build the migration tool: `qmd migrate --from sqlite --to pgvector`.
   One-shot ingest from one backend to the other, verifies counts.
4. Document the persona/backend mapping in CLAUDE.md and README so
   users self-select the right backend.
5. Only **after** all of the above is stable, consider Qdrant / Lance /
   Chroma as additional backends. Each adds maintenance burden.

## Why we're parking it now (2026-04-13)

Right-now bottleneck on QMD's benchmark is **retrieval logic**, not storage.
The 89% → 92.8% → (expected ~95%) jump on LME _s n=500 came from fixing
scope filtering in the vec query, not from changing the engine. SQLite
+ sqlite-vec partition keys handle our current load without breaking a
sweat. Migrating now would solve a problem we don't have, at the cost
of breaking the on-device value proposition for the use case we do have.

When the bottleneck IS storage, this note is here. Until then,
sqlite-vec is the right call.
