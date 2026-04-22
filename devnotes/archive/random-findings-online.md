# Building Your Own Agent Memory Framework: A Synthesized Blueprint

**Compiled from 15 sources — April 2026**

This document distills the best architectural patterns, retrieval strategies, benchmarks, storage decisions, and cost calculations from across the current agent memory landscape into a single reference for designing your own framework.

---

## 1. The Core Problem: Why Memory Is Hard

AI agents are stateless by default. Every session starts from zero. The naive fix — dump all history into the context window — works until it doesn't. At 32 conversation sessions it's fine. At 10,000 sessions and millions of tokens, it physically won't fit. The fundamental engineering challenge is **selective retrieval**: finding the 3 facts that matter out of 100,000 stored ones.

There are two distinct memory problems to solve:

**Personalization memory** is about remembering who the user is, their preferences, and conversation history. This is the simpler problem.

**Institutional knowledge memory** is about extracting lessons from experience, tracking entities and their relationships over time, and compounding domain knowledge across runs. This is the hard problem and where most systems fail.

A system that only does vector similarity search will miss things like "which vendors need special purchase order templates?" when the stored fact uses the word "format" instead of "template." Multi-strategy retrieval is the answer.

---

## 2. Architecture: The Eight Layers of Production Memory

Based on the Schift analysis of production RAG pipelines, a complete memory system requires eight layers. Most teams implement three and wonder why things break.

| # | Layer | What Breaks Without It |
|---|-------|----------------------|
| 1 | **Chunking strategy** | Sentences split mid-thought. Context lost at boundaries. |
| 2 | **Query enhancement** | Short queries miss relevant docs. Semantic mismatch between question and stored answer. |
| 3 | **Reranking** | Top-k results are noisy. The LLM hallucinates from irrelevant chunks. |
| 4 | **Multimodal extraction** | Tables become garbled text. PDF structure is lost. |
| 5 | **Evaluation pipeline** | No way to measure quality. No way to detect regressions. |
| 6 | **Index tuning** | Latency spikes at scale. Memory costs explode. |
| 7 | **Incremental updates** | Full re-index on every document change. |
| 8 | **Monitoring** | Quality degrades silently until a user complains. |

### Chunking (Layer 1) — The Ceiling Setter

Bad chunks mean bad retrieval. No reranker fixes this. Three strategies in sequence work best:

- **Structural**: Detect headings, numbered sections, document hierarchy. Split at semantic boundaries.
- **Agentic**: An LLM identifies chunk boundaries with topic labels. Expensive, but catches what rules miss.
- **Mechanical**: Fallback for flat text. Paragraph-based with sentence detection.

### Query Enhancement (Layer 2) — Fix the Question, Not the Search

Users type short queries. The actual answer often uses completely different terminology. Two proven approaches:

- **HyDE (Hypothetical Document Embeddings)**: Generate a fake answer with an LLM, embed that instead of the original query. The fake answer is semantically closer to the real document.
- **Query Expansion**: Generate 3 alternative phrasings. Search with all of them. Union the results.

Both add one LLM call of latency. Both measurably improve recall. Worth it for anything beyond simple lookups.

### Reranking (Layer 3) — The Highest-ROI Upgrade

A cross-encoder reranker takes the query and each candidate document, scores their relevance as a pair, and re-sorts. The implementation pattern:

1. Vector search: top_k=30 (deliberately over-fetch)
2. Reranker scores each (query, doc) pair
3. Return top 5 by reranker score

This is the single highest-ROI improvement to any existing retrieval pipeline. Preferred reranker models include `mixedbread-ai/mxbai-rerank-large-v2` (open-source via HuggingFace) and cross-encoder models from Cohere and Jina.

---

## 3. Retrieval Strategies: What Actually Works

The key lesson from all sources: **single-strategy retrieval is fragile**. The best systems combine multiple strategies and fuse results.

### Triple-Stream Retrieval (from agentmemory)

| Stream | What It Does | When It Fires |
|--------|-------------|---------------|
| **BM25** | Stemmed keyword matching with synonym expansion | Always on |
| **Vector** | Cosine similarity over dense embeddings | When an embedding provider is configured |
| **Graph** | Knowledge graph traversal via entity matching | When entities are detected in the query |

All three streams are fused with **Reciprocal Rank Fusion (RRF, k=60)** and session-diversified (max 3 results per session) to maximize coverage.

### TEMPR Multi-Strategy (from Hindsight)

Semantic search + keyword matching + graph traversal + temporal reasoning, combined through RRF. This is what achieves 91.4% on LongMemEval.

### L# Cache Hierarchy (from Schift)

Store the same conversation at three levels of detail:

- **L0**: Full session text (maximum context, maximum noise)
- **L1**: User turns only (strips assistant verbosity — strongest retrieval signal)
- **L2**: First 3 user turns (zero-cost summary proxy, no LLM call needed)

At query time, search each level independently, then merge with weights: `0.5 × L1 + 0.3 × L2 + 0.2 × L0`. This achieves 88% R@1 versus 85% for plain vector search. The 3x storage cost is trivial compared to the accuracy gain.

### What Doesn't Work

- **NLI-inferred graph edges**: In Schift's testing, adding Natural Language Inference edges (contradiction/entailment between session summaries) actually *reduced* R@5 from 96% to 93%. The signal-to-noise ratio was too low.
- **Hard temporal filtering**: Using strict date cutoffs filtered out correct results whose timestamps didn't align cleanly with questions. Soft temporal reranking (multiply score by recency decay factor) works better.
- **Retrieve-everything approaches**: MemPalace's strategy of setting top_k higher than the corpus size works at 32 sessions but collapses at scale. Not a real memory system.

---

## 4. Memory Data Model: Four-Tier Consolidation

The best pattern (from agentmemory) uses a four-tier memory consolidation pipeline inspired by human memory:

| Tier | Name | Function |
|------|------|----------|
| 1 | **Working** | Raw observations from the current session. High volume, high noise. |
| 2 | **Episodic** | Compressed session summaries. Facts extracted, noise removed. |
| 3 | **Semantic** | Consolidated facts across sessions. Entities resolved, relationships mapped. |
| 4 | **Procedural** | Extracted workflows and patterns. "How to do X" knowledge. |

Each tier has strength decay (Ebbinghaus-inspired) — memories that aren't recalled weaken over time and eventually get evicted. Memories that *are* recalled get reinforced.

### Memory Versioning and Auto-Forgetting

Memories should version, not accumulate:

```
v1: "Use Express for API routes"
v2: "Use Fastify instead of Express" (supersedes v1)
v3: "Use Hono instead of Fastify for Edge" (supersedes v2)
```

Only the latest version returns in search results. The full chain is preserved for audit.

Auto-forget mechanisms that keep memory clean:

| Mechanism | What It Does |
|-----------|-------------|
| **TTL expiry** | Memories with a `forgetAfter` date are deleted when expired |
| **Contradiction detection** | Near-duplicate memories (Jaccard > 0.9) — older one is demoted |
| **Low-value eviction** | Observations older than 90 days with importance < 3 are removed |
| **Per-project cap** | Projects capped at N observations; lowest importance evicted first |
| **Cascading staleness** | When a memory is superseded, related graph nodes/edges are flagged stale |

---

## 5. Knowledge Graph: Entity Resolution and Multi-Hop Reasoning

Pure vector search treats every memory as an isolated chunk. A knowledge graph connects them.

### Node Types Worth Tracking

Based on the Chronos and Hindsight architectures:

- **Entity nodes**: People, services, projects, files, concepts — each with embeddings and metadata
- **Relationship edges**: Typed and weighted (causes, fixes, imports, depends-on, authored-by, supersedes, contradicts)
- **Temporal metadata**: When the relationship was established, when it was last confirmed, validity window

### Graph Traversal for Retrieval

Adaptive Graph-Guided Retrieval (from Chronos) works like this:

1. Start at a seed node (the entity mentioned in the query)
2. Expand neighborhood based on edge weights
3. Filter by relevance to the query context
4. Calculate confidence based on information gain
5. If confidence is below threshold, increase depth and repeat
6. Optimal traversal depth is typically 3 hops (F1 peaks at ~89%)

Beyond depth 3, precision drops faster than recall improves.

### When Graph Retrieval Helps vs. Hurts

Graph traversal helps most for:
- Knowledge-update questions (what changed?)
- Multi-session reasoning (connecting dots across conversations)
- Entity-centric queries ("what do we know about service X?")

Graph traversal hurts when:
- The graph is too dense (too many noisy edges)
- Edges are semantically correct but not retrieval-relevant
- The haystack is small enough that vector search alone suffices

---

## 6. Storage Engine Selection

### pgvector vs. Dedicated Vector Engine

pgvector is a solid choice under 100K vectors. Beyond that, dedicated engines win decisively:

| Scale | Recommendation |
|-------|---------------|
| Under 100K vectors, single-digit QPS | pgvector — zero operational overhead |
| 100K–500K vectors, under 50 QPS | pgvector works; watch memory growth |
| 100K–500K vectors, over 100 QPS or sub-10ms needed | Dedicated engine starts to win |
| Over 500K vectors at any production QPS | Dedicated engine is the only answer |

The performance gap at 1M vectors: pgvector is roughly **100x slower** than FAISS HNSW, and **225x slower** than purpose-built Rust engines like Schift's. This comes from three engineering differences:

1. **Quantization**: SQ8 (8-bit scalar) reduces memory 4x with only ~1% recall loss. pgvector stores raw float32.
2. **Memory-mapped storage**: Purpose-built engines use mmap optimized for vector access patterns. pgvector shares memory with all other Postgres queries.
3. **SIMD scoring**: Dedicated engines can apply vectorized CPU instructions aggressively.

### Practical Quantization Trade-offs

| Format | Bits/dim | Memory (1M × 1024d) | Recall Loss |
|--------|----------|---------------------|-------------|
| F32 | 32 | 4.0 GB | baseline |
| SQ8 | 8 | 1.0 GB | ~1% |
| SQ4 | 4 | 0.5 GB | ~3% |
| SQ1 | 1 | 0.125 GB | ~3% at 97% recall |

**SQ8 is the right default.** The 1% recall loss is invisible in practice, and you get 4x memory savings.

### Recommended Storage Stack

For a self-hosted deployment, the practical stack would be:

- **A lightweight vector store** (LanceDB, ChromaDB, or similar) for vector storage at moderate scale
- **PostgreSQL** for metadata, entity resolution, and relational joins
- **BM25 index** (SQLite FTS5 or dedicated) for keyword matching
- **Knowledge graph edges** stored in PostgreSQL or a lightweight graph format

Keep vector search separate from relational queries. Do the vector search in the vector engine, then join results in PostgreSQL.

---

## 7. Embedding Model Selection and Cost

### Dimension Sweet Spot

From Schift's benchmarking on LongMemEval:

| Dimensions | R@1 | R@5 | R@10 | Notes |
|-----------|-----|-----|------|-------|
| 2048 | 82% | 95% | 98% | Diminishing returns; captures noise |
| **1024** | **85%** | **96%** | **98%** | **Sweet spot** |
| 384 | 79% | 94% | 99% | Surprisingly competitive at R@10 |
| 128 | 71% | 93% | 96% | Viable for edge/on-device scenarios |

**1024 dimensions is the sweet spot.** Higher dimensions don't help. 384d is surprisingly good if you need to save memory.

### Embedding Provider Options

| Provider | Model | Dimensions | Cost | Notes |
|----------|-------|-----------|------|-------|
| **Local (Xenova)** | all-MiniLM-L6-v2 | 384 | Free | +8pp recall over BM25-only, runs offline |
| **Gemini** | text-embedding-004 | 768 | Free tier (1500 RPM) | Best cost/performance ratio |
| **OpenAI** | text-embedding-3-small | 1536 | $0.02/1M tokens | Established baseline |
| **Voyage AI** | voyage-code-3 | 1024 | Paid | Optimized for code |
| **Cohere** | embed-english-v3.0 | 1024 | Free trial | Good general-purpose |

### Migrating Between Embedding Models

The Schift case study demonstrated zero-downtime embedding migration using learned projection matrices:

1. Sample 0.01%–1% of your corpus
2. Embed the sample with both old and new models
3. Train a projection matrix (43 minutes for 1,200 docs)
4. Apply matrix multiplication to all existing vectors (18 minutes for 12M vectors)
5. Result: 96.4% quality preservation, $0 re-embedding cost

This means you're never locked into an embedding provider. If a better free model appears, you can migrate in an afternoon.

---

## 8. Benchmarks: How to Measure Memory Quality

### The Two Benchmarks That Matter

**LongMemEval** is the standard. It evaluates five core memory tasks:

1. **Information Extraction**: Recall facts from within a session
2. **Multi-Session Reasoning**: Aggregate information across sessions
3. **Knowledge Updates**: Track changed information correctly
4. **Temporal Reasoning**: Handle time references ("last time we discussed X")
5. **Abstention**: Decline to answer when information was never mentioned

Published scores on LongMemEval (end-to-end QA accuracy unless noted):

| System | Score | Notes |
|--------|-------|-------|
| Hindsight | 91.4% | Full system, Gemini-3 |
| EverMemOS | 83.0% | Engram-inspired 3-phase memory |
| TiMem | 76.88% | Temporal hierarchical memory tree |
| Zep/Graphiti | 71.2% | Temporal knowledge graph |
| Mem0 | 67.6% | LongMemEval-S variant (not directly comparable) |
| Mem0 (full) | 49.0% | Full LongMemEval |
| MemPalace | 96.6%* | *Retrieval recall, not QA accuracy; raw ChromaDB without palace features |

**Critical note on metric mismatch**: Retrieval recall (did the right doc appear in top-k?) is always higher than end-to-end QA accuracy (did the system answer correctly?). Never compare them side-by-side.

**BEAM benchmark** tests memory at extreme scale (up to 10 million tokens), where context-stuffing is impossible:

| Scale | Hindsight | Honcho | RAG Baseline |
|-------|-----------|--------|-------------|
| 100K tokens | 73.4% | 63.0% | — |
| 1M tokens | 73.9% | 63.1% | — |
| 10M tokens | 64.1% | 40.6% | 24.9% |

Hindsight's accuracy actually *improved* from 500K to 1M tokens before degrading at 10M. That's what good retrieval architecture looks like.

### Three Evaluation Metrics for Your Own System

| Metric | What It Measures | How |
|--------|-----------------|-----|
| **Faithfulness** | Is the answer grounded in retrieved context? | LLM judges claim-by-claim |
| **Answer Relevancy** | Does the answer address the question? | LLM scores 0–10 |
| **Context Recall** | Did retrieval find the right documents? | Compare retrieved vs. ground truth |

Run these on 50–100 QA pairs. Automate in CI. Every pipeline change gets a regression check.

### AMB (Agent Memory Benchmark)

The open-source benchmark framework from Vectorize that addresses limitations of older benchmarks:

- Older benchmarks (LoCoMo, LongMemEval) were designed for 32K context windows
- Modern million-token windows make naive "dump everything" competitive on small datasets
- AMB tracks accuracy, speed, and token cost together
- Published everything: evaluation harness, judge prompts, answer generation prompts, exact models
- Leaderboard at agentmemorybenchmark.ai

---

## 9. Where Each System Breaks Down by Question Type

From Schift's category-level analysis:

| Question Type | Vector Search (1024d) | L# Cache | Notes |
|--------------|----------------------|----------|-------|
| Knowledge-update | 100% | 100% | Solved |
| Multi-session | 100% | 100% | Solved |
| Single-session-assistant | 100% | 100% | Solved |
| Single-session-preference | 100% | 100% | Solved |
| Single-session-user | 94% | 94% | Nearly solved |
| **Temporal reasoning** | **81%** | **81%** | **The remaining frontier** |

Temporal reasoning is the unsolved hard problem. Pure vector similarity doesn't encode "before" and "after." Soft temporal reranking (recency decay factors) is the best current approach, but it's still incomplete.

The LongMemEval research confirms this: commercial assistants collapse 30–45% on temporal and multi-session reasoning tasks even with augmented memory.

---

## 10. The Cherry-Picked Best Features for Your Framework

Taking the best ideas from each system:

| Feature | Source | Why It's Worth Stealing |
|---------|--------|----------------------|
| **Triple-stream retrieval (BM25 + vector + graph) with RRF fusion** | agentmemory, Hindsight | No single retrieval strategy handles all query types |
| **L# Cache hierarchy (L0/L1/L2 document levels)** | Schift, OpenViking | 88% R@1 vs 85% for plain vector; tiered loading saves 80–90% tokens |
| **Four-tier memory consolidation (working → episodic → semantic → procedural)** | agentmemory | Mirrors how humans actually consolidate knowledge |
| **Ebbinghaus-inspired strength decay with reinforcement** | agentmemory | Unused memories fade; recalled memories strengthen |
| **Cascading staleness propagation** | agentmemory | Superseded memories auto-flag related graph nodes as stale |
| **Mental models / reflect operation** | Hindsight | Periodic synthesis across all memories to surface insights |
| **Dialectic user modeling** | Honcho | Build a model of *how the user thinks*, not just what they said |
| **Trust scoring on memories** | Holographic | Memories confirmed across sessions gain weight; contradicted ones decay |
| **Cross-encoder reranking** | Hindsight, RetainDB, Schift | Single highest-ROI improvement to any retrieval pipeline |
| **HyDE query enhancement** | Schift | Generate hypothetical answer, embed that instead of the short query |
| **Privacy-first input sanitization** | agentmemory | Strip API keys, secrets, `<private>` tags before storage |
| **Citation provenance / JIT verification** | agentmemory | Trace any memory back to source observations and sessions |
| **Soft temporal reranking** | Schift (learned from failure) | Recency decay factor beats hard date cutoffs |
| **Content-hash incremental updates** | Schift | Hash documents on ingest; only re-process changed ones |
| **Disposition tuning (skepticism, literalism, empathy)** | Hindsight | Control how opinionated the agent's memory interpretation becomes |
| **Configurable token budget for context injection** | agentmemory, Hermes | Don't overflow context; inject only the top-K most relevant facts |

---

## 11. Cost Calculations for a Self-Hosted Setup

### Token Cost Comparison

| Approach | Tokens per Query | At 1000 queries/day (est.) |
|----------|-----------------|---------------------------|
| Dump everything into context | ~22,000 | Expensive and breaks at scale |
| agentmemory with hybrid search | ~1,571 | **92% reduction** |
| Chronos graph-based memory | ~12,234 | 7.3x more efficient than raw GPT-4.1 |

### Embedding Cost

With Gemini text-embedding-004 on the free tier (1500 requests/minute), embedding cost is literally $0 for most self-hosted workloads. If you exceed the free tier, projection-matrix migration from OpenAI to Gemini preserves 96.4% quality at zero re-embedding cost.

### Storage Cost

For small-to-moderate agent deployments (hundreds to low thousands of memories), most lightweight vector stores (LanceDB, ChromaDB, SQLite-based solutions) are effectively free on local storage. Even at 10x growth from a modest starting point, self-hosted vector storage cost is negligible.

The scale boundaries to watch:

- Under 100K vectors: lightweight vector stores are fine
- 100K–500K vectors: monitor memory growth, consider SQ8 quantization
- Over 500K: consider a dedicated vector engine

---

## 12. Practical Implementation Sequence

For someone building this on top of an existing agent setup with basic vector search:

**Phase 1 — Upgrade retrieval (highest ROI)**
- Add BM25 keyword search alongside existing vector search
- Implement RRF fusion to merge results from both streams
- Add a reranker step (mxbai-rerank-large-v2 via HuggingFace free tier)

**Phase 2 — Add memory lifecycle management**
- Implement memory versioning (supersedes chain)
- Add Ebbinghaus-inspired decay with reinforcement on recall
- Add auto-forget (TTL, contradiction detection, importance-based eviction)

**Phase 3 — Knowledge graph layer**
- Entity extraction from stored memories (LLM-powered)
- Relationship edges (depends-on, supersedes, related-to)
- Graph-enhanced retrieval for entity-centric queries

**Phase 4 — Synthesis and reflection**
- Periodic reflect operation that reads across all memories
- Surface higher-level insights and consolidate related facts
- Mental model updates as new memories arrive

**Phase 5 — Evaluation and monitoring**
- Build a test set of 50–100 QA pairs from your actual agent conversations
- Track Recall@10, NDCG@10, and MRR across pipeline changes
- Alert on quality regression

---

## 13. Systems Comparison: The Landscape at a Glance

| System | License | Retrieval | Knowledge Graph | Entity Resolution | Scale-Tested | Self-Hostable | LongMemEval |
|--------|---------|-----------|----------------|-------------------|-------------|--------------|-------------|
| **Hindsight** | MIT | Multi-strategy (TEMPR) | Multi-hop | Yes | 10M tokens (BEAM SOTA) | Yes + Cloud | 91.4% |
| **agentmemory** | Apache 2.0 | Triple-stream (BM25+vector+graph) | BFS traversal | LLM-powered | 240 observations tested | Yes (iii-engine) | N/A (own bench) |
| **Mem0** | Apache 2.0 | Semantic | No | Basic | Production | Cloud primarily | 49.0% |
| **Zep/Graphiti** | Open (Graphiti) | Semantic + KG | Temporal KG | Yes | Production | Via Graphiti | 63.8% |
| **Letta** | Apache 2.0 | Self-editing | Yes | Yes | Established | Yes + Cloud | N/A |
| **Honcho** | AGPL v3.0 | Dialectic modeling | No | Behavioral | Production | Cloud (AGPL risk) | N/A |
| **Holographic** | Open | HRR algebra | No | No | Local only | Yes (SQLite) | N/A |
| **Chronos** | Proprietary | Graph-guided (AGR) | Full graph (G=V,E) | Yes | Up to 100M LOC | Waitlist | N/A |
| **OpenViking** | Open (ByteDance) | Tiered L0/L1/L2 | No | No | Self-hosted | Yes | N/A |

---

## Sources

1. vectorize.io — MemPalace Alternatives, Benchmarks Debunked, Best AI Agent Memory Systems, Hermes Memory Explained, Hermes Providers Compared
2. schift.io — RAG Is Not Vector Search, pgvector analysis, LongMemEval benchmark results, Embedding migration case study, TypeScript framework rationale
3. github.com/rohitg00/agentmemory — Full architecture documentation and benchmarks
4. emergentmind.com — LongMemEval academic benchmark analysis with paper citations
5. chronos.so — Memory graph architecture, AGR traversal, multi-hop reasoning benchmarks
6. github.com/vectorize-io/agent-memory-benchmark — AMB benchmark framework
7. github.com/MemPalace/mempalace/issues/39 — Independent benchmark reproduction results


## Thoughts for implementation

This is a well-built pipeline. You've already implemented most of the foundational patterns (BM25+vec RRF, cross-encoder rerank, Weibull decay, KG, reflection). The gaps are mostly at the indexing and multi-session retrieval level, which aligns exactly with your 93% multi-session ceiling.

Here's what I see, mapped to specific spots in your architecture:

**1. Fact-augmented key expansion (your biggest missing piece for multi-session)**

The LongMemEval paper's Finding 2: expanding index keys with extracted user facts gives +4% recall and +5% QA accuracy. Right now your FTS5 index and vec0 embeddings are built from the raw memory text. If you also extracted atomic facts at ingest time and appended them to the indexed text, your FTS and vector search would have multiple retrieval pathways into the same memory.

Where it fits: Phase 1, between your current Phase 4 (bulk insert) and Phase 5 (opt-in side effects). Or more precisely, your `LOTL_INGEST_EXTRACTION` path in Phase 5 already extracts triples for the KG table, but those extracted facts don't feed back into the `memories_fts` or `memories_vec` indexes. The fix is to concatenate extracted facts onto the text *before* embedding and FTS indexing, not just store them separately in the `knowledge` table.

**2. Dual-representation storage (Supermemory's pattern that broke 80% on multi-session)**

Right now you store one representation per memory. Supermemory's architecture stores two: an atomic memory (clean, disambiguated, single fact) used for search, and the original source chunk injected into results for the LLM to read. This directly solves the information-loss problem that the LongMemEval paper flags: fact decomposition improves multi-session retrieval but loses detail needed for answering. By searching against the atomic version but returning the original alongside it, you get both.

Where it fits: Your `memories` table could gain a `source_text` column (or the current `text` column becomes the atomic version and a new column holds the original). Your `memoryRecall` results would then carry both, letting the downstream reader LLM see the full context while retrieval benefits from the cleaner representation.

**3. Temporal event dates (separate from storage timestamps)**

Your `created_at` and `last_accessed` track *when the memory was stored and used*. They don't track *when the event described in the memory happened*. Supermemory's dual-timestamp approach (`documentDate` vs `eventDate`) is what pushed their temporal reasoning from mediocre to 76-81%. For multi-session this matters too, because cross-session questions often have implicit temporal ordering.

Where it fits: Your `knowledge` table already has `valid_from` / `valid_until` on triples, so you understand the concept. The `memories` table needs an `event_date` column populated at ingest time, either by LLM extraction or heuristic (parsing dates from the text). Your temporal query expansion in Step 0 of recall could then filter or boost by event date rather than only by `created_at`.

**4. Memory-to-memory relationship edges**

Your current conflict resolution decides ADD/UPDATE/DELETE/NONE at ingest time, which is good for dedup. But it doesn't leave a trail. When memory B supersedes memory A, there's no edge connecting them. For multi-session questions that need aggregation across related memories, traversing explicit `supersedes` / `extends` / `derives` edges during recall would let you pull in the full cluster of related memories when one is hit.

Where it fits: A new `memory_relations` table (memory_id_a, memory_id_b, relation_type, confidence). Written during your Phase 2 cosine dedup when the LLM returns UPDATE (that's a `supersedes` edge). Your recall Step 5d (KG injection) could be extended to also do a single-hop expansion along memory relation edges when a retrieved memory has relations, similar to how you currently inject KG facts on weak retrieval.

**5. Your KG injection gates might be too conservative for multi-session**

Your three-condition gate requires: opt-in + proper-noun entity + top RRF score < 0.3. That last condition means KG facts only fire on *weak* retrieval. Multi-session questions often have *decent* retrieval (one relevant session found) but *incomplete* retrieval (the second session missed). A score of 0.4 would pass your gate and the KG injection never fires, even though the entity-linked facts from the other session would have helped.

Where it fits: Consider a second KG injection mode specifically for multi-session: instead of gating on "weak top-1 score," gate on "retrieval results come from fewer sessions than expected for a multi-hop question." If all your top-5 results come from the same session and the query looks like a comparison or aggregation, that's a signal to inject KG facts from other sessions.

**6. L# Cache pattern (you're halfway there)**

Your doc mentions L1 user-only ingest via `turnsToText(turns, userOnly)`. But you're storing one representation. The Schift L# Cache pattern stores three (L0 full session, L1 user turns only, L2 first 3 user turns) as separate vectors, searches all three in parallel, and merges with weights (0.5 L1 + 0.3 L2 + 0.2 L0). This got them from 85% to 88% R@1.

Where it fits: For conversation-sourced memories, you could store L0 and L1 as separate rows in `memories_vec` with a `level` tag in metadata. Your vec0 KNN in Step 3 would run twice (once per level) and the RRF fusion in Step 4 would merge with level-specific weights. Storage cost is 2x vectors for conversation memories, but your scope-partitioned vec0 keeps the KNN walks isolated.

**7. Your query expansion is zero-LLM only**

Your Step 0 does entity fan-out and keyword group fan-out, both without an LLM call. HyDE (generate a hypothetical answer, embed that) is the next tier up and specifically helps when the query uses different vocabulary than the stored memory. The LongMemEval paper found this particularly valuable for multi-session questions where the query describes a comparison but the individual sessions don't use comparison language.

Where it fits: A gated HyDE path in Step 0, only firing when a remote LLM is configured and the query looks like a multi-session or temporal question (you could detect this via keyword patterns similar to your `patterns.ts` classifier). The HyDE-generated text gets embedded alongside your existing sub-queries and feeds into the same RRF fusion.

**Prioritization for your multi-session ceiling:**

The first three (fact-augmented keys, dual-representation, event dates) directly target the multi-session gap and have the strongest empirical evidence behind them. Items 4 and 5 (relation edges, relaxed KG gates) are medium-effort and help with the aggregation aspect. Items 6 and 7 (L# Cache, HyDE) are nice-to-haves that improve the pipeline broadly but aren't multi-session-specific.