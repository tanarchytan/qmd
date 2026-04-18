# Phase 5 design — KG population + fact-augmented embedding keys

**Status:** draft, pre-implementation. Written 2026-04-19 while the Phase 1-4
sweeps run. Finalize before any code lands.

## Goal

Two LLM-coupled experiments on the same one-time ingest pass:

- **5a — KG injection A/B** — does `LOTL_MEMORY_KG=on` actually lift recall or
  Cov@5 when the knowledge graph is populated?
- **5b — Fact-augmented embedding keys** — does embedding extracted facts
  (instead of raw session text) widen cosine separation enough to make
  vec-heavy RRF weights win?

Both need LLM extraction at ingest time. Shared infrastructure. One Gemini
pass populates both the KG triples AND the fact-text column. Total cost
estimate: **$0.50-2 one-off on LME n=500**, $0 for everything after.

## Extraction contract

One prompt, two outputs. Per session:

```
You are extracting structured memories from a conversation turn. Output JSON:

{
  "facts": ["atomic fact 1", "atomic fact 2", ...],   // ≤20 tokens each, self-contained, no pronouns
  "triples": [                                         // subject-predicate-object
    {"subject": "user", "predicate": "likes", "object": "hiking"},
    ...
  ]
}

Rules:
- Facts capture user-specific preferences, decisions, or stable state
- Triples should use canonical entity names (lowercase, underscored)
- Facts and triples are complementary: a triple is the graph view of a fact
- Return {"facts": [], "triples": []} if the turn has no new information
```

Model: `gemini-2.5-flash` (free tier, deterministic at temperature=0, seed=42).
Cache the response keyed by SHA-256(turn_text) so re-runs are free.

## Schema changes

Add two columns to `memories`:

```sql
ALTER TABLE memories ADD COLUMN fact_text TEXT;
ALTER TABLE memories ADD COLUMN fact_embedding BLOB;   -- 384d f32 same as content embedding
```

Migrations: `src/store/db-init.ts` — guard with `PRAGMA table_info(memories)`
check so running against v17-style DBs adds the columns in-place. No data
migration; fact columns are NULL for pre-Phase-5 memories.

## Retrieval-time selection

New env var `LOTL_MEMORY_EMBED_SOURCE=fact|content|dual` (default `content`):

- `content` (current behavior) — vec side queries `content_embedding`
- `fact` — vec side queries `fact_embedding` if non-null, else falls back to content
- `dual` — query both, blend via RRF as a 3rd list alongside BM25+vec-content

Implementation anchor: `src/memory/index.ts` (around the vec query call
inside `memoryRecall`). One conditional on the column name passed to
sqlite-vec's `MATCH` clause.

## Phase 5a (KG A/B) execution

After ingest:

```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_MEMORY_KG=on \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --workers 4 \
    --db-suffix mxbai-kg-populated --tag kg-on --no-llm
```

**Primary metric:** Cov@5 and Cov-MRR (session-id metrics are blind to KG
injection because `kg:*` memories have no `session_id`).
**Kill criterion:** KG triples populated AND Cov@5 lift < 2pp AND pref-MRR
lift < 1pp → KG injection stays off by default forever. Tools remain for
user-initiated `knowledge_add` / `knowledge_search`.

## Phase 5b (fact-aug) execution

```sh
LOTL_EMBED_BACKEND=transformers \
LOTL_EMBED_MODEL=mixedbread-ai/mxbai-embed-xsmall-v1 \
LOTL_MEMORY_EMBED_SOURCE=fact \
  npx tsx evaluate/longmemeval/eval.mts --ds s --limit 500 --workers 4 \
    --db-suffix mxbai-fact-embed --tag fact-aug-vec --no-llm
```

Then re-run the BM25/vec weight sweep against the fact-aug DB:

```sh
# configs/fact-aug-weight-sweep.txt — same shape as flag-x-weight-sweep.txt
# but anchored against --db-suffix mxbai-fact-embed
bash evaluate/scripts/sweep-flags.sh \
  evaluate/sweeps/configs/fact-aug-weight-sweep.txt \
  --corpus lme --limit 500
```

**Hypothesis:** fact-aug vec cosine separation widens (currently ~0.80
between unrelated conversations per ROADMAP analysis). At 3/7 or 1/9
weights, fact-aug should NOT crash the way raw-content vec did.

**Success criterion:** at least one fact-aug + weight combo ≥ baseline
MRR AND fact-aug 9/1 ≥ baseline content 9/1 (fact-aug isn't strictly worse).
**Kill criterion:** fact-aug MRR < baseline content MRR at every weight point
→ compressed-cosine hypothesis was wrong. Revert schema, mark ROADMAP
Phase 6 as closed-null.

## Cost accounting

| Step | LLM calls | $ estimate |
|---|---|---|
| Ingest extraction (n=500 LME × avg ~47 sessions) | ~23,500 calls | ~$0.50 gemini-2.5-flash |
| Re-embed all fact_text via mxbai-xs (local) | 0 | $0 |
| Phase 5a retrieval A/B | 0 (no-LLM) | $0 |
| Phase 5b retrieval A/B + weight sweep | 0 | $0 |
| **Total** | — | **~$0.50** |

Cap at **$5 hard ceiling**; if we exceed, something is wrong with prompt
length or caching.

## Risks + open questions

1. **Extraction noise** — if Gemini produces junk triples (hallucinated
   entities, wrong predicates), KG injection hurts recall. Mitigation:
   validate triples against a gold-label sample (50 manually-checked) before
   accepting the full ingest. Reject the pass if ≥30% are wrong.

2. **Compressed-cosine persists** — fact-aug may NOT widen the cosine band
   if Gemini-flash produces similar short phrases across sessions. Test at
   n=50 first before committing to the full ingest.

3. **Ingest latency** — 23K Gemini calls at free-tier rate-limit ~60 rpm
   (1 qps) = ~6.5 h wall. Use batched requests if available, or parallelize
   up to the rate limit. Alternatively use gpt-4o-mini (4500 rpm free) for
   ingest-time extraction, switch to Gemini for the A/B if costs argue.

4. **Schema migration rollback** — if Phase 5b kills, we need to drop
   `fact_text` / `fact_embedding` columns. SQLite column drops are
   non-trivial — better: leave columns as nullable and always-NULL for
   production DBs; the code path reverts to `content_embedding` fallback.

5. **Cache invalidation** — if the extraction prompt changes, all cached
   responses are stale. Key the cache by `sha256(prompt_template + turn_text)`
   not just turn_text.

## Dependencies to resolve first

- [ ] Phase 1-4 sweeps finalize — confirm no untested flag makes Phase 5
      unnecessary (e.g., if reranker alone lifts MRR to 0.94+, fact-aug may
      not be worth the LLM cost)
- [ ] Gemini API key in `.env` for the ingest pass
- [ ] Decide gpt-4o-mini vs gemini-flash for ingest (latency vs cost)
- [ ] Schema migration tested on a throwaway DB before v17 DB is touched

## Deferred

- Multi-fact per session (current design: 1-3 facts per session, then pick
  the top-scored or concatenate). Pick one behavior pre-implementation.
- Auto fact-aug on `memory_store` at runtime (currently design assumes
  batch ingest only — runtime extraction is a second deployment concern).
- OpenClaw integration — if Phase 5b ships, how does it work for end users
  running as a plugin with no global LLM config? Deferred until Phase 5b
  validates.
