# Env-flag polarity reference

Complete table of every `process.env.LOTL_*` read in `src/`, with the EXACT
value the code checks for. Grep-sourced from `src/` 2026-04-19.

> ⚠️ **Stale post-v1.0.0** — the v1.0.0 dead-knob cleanup
> (commits `2616d89` + `760c007`) removed several env vars listed below:
> `LOTL_RECALL_DIVERSIFY` (superseded by `LOTL_MEMORY_MMR=session`),
> `LOTL_MEMORY_LHASH` (parked harmful), `LOTL_STRICT_DIM_MISMATCH`
> (hardcoded auto-reindex), `LOTL_TRANSFORMERS_QUIET`,
> `LOTL_TRANSFORMERS_DIRECT_MAXLEN`, plus several `LOTL_GEMINI_EMBED_*` knobs.
> Phase 6 ALSO hardcoded `LOTL_MEMORY_SYNONYMS=off` and
> `LOTL_MEMORY_RERANK_BLEND_ORIGINAL/RERANK=0.5/0.5` in
> `src/store/constants.ts` + `src/memory/index.ts`.
> For the post-v1.0.0 canonical list, run `git grep "process.env.LOTL_" src/`.
> This devnote is preserved as a 2026-04-19 snapshot — still the best record
> of WHY each polarity is what it is, just outdated on the WHICH.

**Why this exists:** today (2026-04-19) we caught **5 silent-no-op bugs** in
Phase 1 sweeps because I assumed `=on` enables every flag. It doesn't.
Some flags need specific values (`=session`, `=rank`, `=cross-encoder`),
some are default-ON and need `=off` to disable. If you're writing a sweep
config or reading `.env.example`, start here.

## Boolean enables — set exactly `=on`

| Env var | Purpose |
|---|---|
| `LOTL_RECALL_PROFILE` | per-stage timing to stderr |
| `LOTL_RECALL_RAW` | skip all post-fusion boosts (eval baselines) |
| `LOTL_RECALL_DIVERSIFY` | inter-session diversification (same codepath as MMR=session) |
| `LOTL_RECALL_KG` | KG fact injection on weak recall (requires `!RAW`) |
| `LOTL_RECALL_KG_RAW` | KG fact injection (bypasses RAW check) |
| `LOTL_RECALL_REFLECT` | LLM reflection pre-pass (requires `useLLM`) |
| `LOTL_RECALL_NO_TOUCH` | skip recall-time `access_count` increment (**eval A/B hygiene**) |
| `LOTL_MEMORY_LHASH` | L0/L1/L2 cache hierarchy blend (**crashes LoCoMo** — delete candidate) |
| `LOTL_RERANK_STRONG_SIGNAL_SKIP` | skip rerank when vec/fts strongly agree |
| `LOTL_EMBED_DIRECT` | use direct-ORT backend (jina-v5 / nomic-v1.5) |
| `LOTL_STRICT_DIM_MISMATCH` | hard-error on embedding-dim mismatch instead of warning |

## Enum enables — need specific string values

| Env var | Values | Purpose |
|---|---|---|
| `LOTL_MEMORY_MMR` | `session` | Session-level MMR diversification. `=on` is a **no-op**. |
| `LOTL_MEMORY_SCOPE_NORM` | `rank` | Per-scope rank normalization. `=on` is a **no-op**. |
| `LOTL_MEMORY_RERANK` | `on` OR `cross-encoder` | Either enables rerank (cross-encoder is historical alias). |
| `LOTL_MEMORY_EXPAND` | `keywords` (default), `entities`, anything else = disabled | Missing var falls back to `keywords`. |
| `LOTL_TRANSFORMERS_AUTO_PREFER` | `cpu` | Override auto-sizer's GPU-first preference. |

## Default-ON, set `=off` to disable

| Env var | Default behavior | How to disable |
|---|---|---|
| `LOTL_MEMORY_SYNONYMS` | BM25 synonym expansion ON | `=off` (`=on` is a **no-op**) |
| `LOTL_LLM_CACHE` | LLM call caching ON | `=off` |
| `LOTL_TRANSFORMERS_QUIET` | Silent transformers.js mode ON | `=off` |

## Provider selection (string value routes config)

| Env var | Accepted values |
|---|---|
| `LOTL_EMBED_BACKEND` | `transformers` OR `remote` (default) |
| `LOTL_EMBED_PROVIDER` | `api` / `url` / `gemini` / `ollama` / `vllm` / `lm-studio` / `lemonade` |
| `LOTL_RERANK_BACKEND` | `transformers` (default) / `remote` |
| `LOTL_RERANK_PROVIDER` | `api` / `url` / `gemini` / `ollama` / `vllm` |
| `LOTL_RERANK_MODE` | `llm` / `rerank` |
| `LOTL_QUERY_EXPANSION_PROVIDER` | same shape as EMBED_PROVIDER |

## Numeric knobs (parsed via `Number()` / `parseInt()`)

| Env var | Default | Notes |
|---|---|---|
| `LOTL_MEMORY_RRF_W_BM25` | `0.9` | Weights sum isn't enforced; violating by convention is OK |
| `LOTL_MEMORY_RRF_W_VEC` | `0.1` | Both swept and documented 2026-04-18/19 |
| `LOTL_VEC_MIN_SIM` | adaptive (per-query) | Set to a number to override adaptive gate |
| `LOTL_TRANSFORMERS_RERANK_MAXLEN` | `512` | Caps tokenizer truncation — prevents 67 GB OOM on ModernBERT |
| `LOTL_TRANSFORMERS_DIRECT_MAXLEN` | `1024` | Same purpose for jina-v5 direct-ORT path |
| `LOTL_REFLECT_TOP_K` | `10` | Max memories sent to reflect-LLM |
| `LOTL_REFLECT_MAX_CHARS` | `800` | Per-memory char cap on reflect input |
| `LOTL_CHUNK_SIZE_TOKENS` | `900` | Indexed-doc chunk target |
| `LOTL_CHUNK_WINDOW_TOKENS` | `200` | Chunk overlap |
| `LOTL_GEMINI_EMBED_BATCH_SIZE` | `5` | Ingest-time Gemini batching |
| `LOTL_GEMINI_EMBED_INTERVAL_MS` | `15000` | Rate-limit pause between batches |
| `LOTL_EMBED_MICROBATCH` | auto-sized | ONNX inference batch |
| `LOTL_EMBED_MAX_WORKERS` | auto-sized | ONNX session pool size |

## Path / URI knobs

| Env var | Default |
|---|---|
| `LOTL_CONFIG_DIR` | `~/.config/lotl` |
| `LOTL_TRANSFORMERS_CACHE_DIR` | `~/.cache/lotl/transformers` |
| `LOTL_EDITOR_URI` | unset (CLI `$EDITOR`) |

## Known polarity footguns — caught and fixed

1. **`LOTL_MEMORY_SYNONYMS=on`** was a no-op in Phase 1 sweep. Correct inverse test: `=off`.
2. **`LOTL_MEMORY_SCOPE_NORM=on`** was a no-op. Code checks `=== "rank"`.
3. **`LOTL_MEMORY_EXPAND=keywords`** was a no-op vs baseline (it IS the default). Only meaningful value changes are `=entities` or an unrecognized string (disables expansion).
4. **`LOTL_TRANSFORMERS_RERANK_FILE=model_quint8_avx2`** hardcoded as factory default → silent no-op for all non-legacy rerankers. Fixed to auto-resolve.
5. **Reranker `max_length`** uncapped → 67 GB OOM on ModernBERT 8192-token context. Fixed to cap at 512.

## How to add a new flag without repeating these mistakes

1. Pick one polarity per flag and stick to it (`=on` / value-enum / `!= off`). Don't mix.
2. If you add a value-enum flag, document every accepted value — `=on` is not one.
3. If the flag is default-ON, name it as a DISABLE flag (e.g., `LOTL_DISABLE_X=on`) or document the `=off` requirement prominently.
4. Add to `.env.example` with the exact value the code accepts, not "on".
5. Add to this table when you land the PR.

## Where the polarity patterns live

`src/memory/index.ts` — the majority of retrieval-path flags.
`src/store/constants.ts` — numeric knobs + synonyms map.
`src/llm/transformers-*.ts` — model/dtype/file selection.
`src/env.ts` — config-dir + OpenClaw plugin bridge.
