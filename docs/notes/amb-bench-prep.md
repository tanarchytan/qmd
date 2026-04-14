# AMB cross-bench — prep notes (2026-04-14)

Scoping doc for using `vectorize-io/agent-memory-benchmark` (AMB) as the harness
to bench mem0 / Hindsight / bm25 / hybrid against the same `longmemeval_s_cleaned.json`
data we use for qmd, and score retrieval-only (sr5 + r5), skipping AMB's
generation + judge LLM steps.

User constraint: **skip the LLM part of AMB**, use AMB only as a harness for
ingest + retrieve, then score retrieval ourselves.

## AMB architecture (verified by reading the code, not the README)

Cloned to `~/qmd-baselines/amb/`. Layout:

```
src/memory_bench/
  dataset/{base,longmemeval,locomo,beam,personamem,membench,memsim,lifebench}.py
  memory/{base,bm25,hybrid_search,mem0,mem0_cloud,hindsight,mastra,mastra_om,
          cognee,supermemory,ogham}.py
  llm/{base,gemini,openai,groq}.py
  models.py    # Document, Query, AnswerResult, JudgeResult, QueryResult, EvalSummary
  judge.py     # the part we skip
  server.py
```

The pipeline is `ingest → retrieve → generate (LLM) → judge (LLM)`. We want
to call only the first two and score retrieval ourselves.

### Clean abstraction = no fork needed

`MemoryProvider` (abstract, in `memory/base.py`):

```python
class MemoryProvider(ABC):
    name: str
    kind: str  # "local" | "cloud"

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None: ...

    @abstractmethod
    def ingest(self, documents: list[Document]) -> None: ...

    @abstractmethod
    def retrieve(self, query: str, k: int = 10, user_id: str | None = None,
                 query_timestamp: str | None = None) -> tuple[list[Document], dict | None]: ...
```

`Dataset` (abstract, in `dataset/base.py`):

```python
class Dataset(ABC):
    @abstractmethod
    def load_queries(self, split: str, category: str | None = None,
                     limit: int | None = None) -> list[Query]: ...
    @abstractmethod
    def load_documents(self, split: str, category: str | None = None,
                       limit: int | None = None, ids: set[str] | None = None,
                       user_ids: set[str] | None = None) -> list[Document]: ...
```

`Query.gold_ids` are the LongMemEval `answer_session_ids` (verified in
`dataset/longmemeval.py`). The Document IDs are `{question_id}_{session_id}`.
Matching `d.id in q.gold_ids` is sr5-equivalent for AMB-driven runs.

**This means we don't fork AMB.** We import `LongMemEvalDataset` and the
provider classes directly into a thin wrapper script and skip the runner
entirely.

### LME dataset adapter is ready to point at our local file

`dataset/longmemeval.py` honors `LONGMEMEVAL_DATA_PATH` env var. Set it to
`/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json`
and AMB uses the exact same file we already use for qmd's eval. No
re-download, no schema drift.

## Provider availability matrix

For each shipped provider, can we run it locally without a paid cloud key?

| Provider | Local? | Cloud key? | Deps | In cross-bench? |
|---|---|---|---|---|
| **`bm25`** | ✅ | — | `rank_bm25` | ✅ keyword sanity vs our FTS5 |
| **`hybrid_search`** | ✅ | — | `qdrant-client`, `sentence-transformers`, Qwen3-Embedding-0.6B (~2.5 GB d/l) | ✅ direct comparison to qmd's hybrid path |
| **`mem0`** (local variant) | ✅ | **needs `GEMINI_API_KEY`** for fact extraction at ingest | `mem0ai`, `qdrant-client`, `sentence-transformers` | ✅ the cross-system data point user asked for |
| `mem0_cloud` | ❌ | mem0 cloud key | — | ❌ skip |
| `hindsight` | ❌ | Vectorize cloud key (paid) | `hindsight-client-api` | ❌ skip; cite their published 91.4% with caveat |
| `mastra` | ❌ | mastra cloud | — | ❌ skip |
| `mastra_om` | ❌ | mastra cloud | — | ❌ skip |
| `cognee` | ❌ | cognee cloud | — | ❌ skip |
| `supermemory` | ❌ | supermemory cloud | — | ❌ skip |
| `ogham` | ❌ | ogham cloud | — | ❌ skip |

**Realistic cross-bench: 3 providers** — `bm25`, `hybrid_search`, `mem0`.

That's actually decent coverage:
- **bm25**: keyword baseline (sanity-check our FTS5 BM25 numbers).
- **hybrid_search**: dense + sparse with Qwen3-Embedding-0.6B 1024d, RRF
  fusion. Architecturally similar to qmd, different model. Tells us whether
  the dimension-sweet-spot claim from Schift (1024d > 384d) holds on LME
  retrieval-recall.
- **mem0**: LLM-extracted memory pattern. Their ingest goes through Gemini
  to extract facts from raw conversation. Different category of system from
  qmd / hybrid_search; the cross-system data point that matters.

**Hindsight handling: excluded from the cross-bench.** Their AMB adapter
(`hindsight.py`) talks to Vectorize's paid cloud service via
`hindsight_client_api`. There is no local install path. We are not
pursuing a Vectorize trial. Their published 91.4% LME number is
end-to-end QA accuracy on Gemini-3, not retrieval recall, so it stays
in the ROADMAP retable for reference only with cells marked n/a.

## Wrapper script architecture

~150 lines of Python in `~/qmd-baselines/amb-bench/run.py`. Sketch:

```python
import os, json, time, tempfile
from pathlib import Path

os.environ["LONGMEMEVAL_DATA_PATH"] = "/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json"
# GEMINI_API_KEY must be set by the caller for mem0

from memory_bench.dataset.longmemeval import LongMemEvalDataset
from memory_bench.memory.bm25 import BM25MemoryProvider
from memory_bench.memory.hybrid_search import HybridSearchMemoryProvider
from memory_bench.memory.mem0 import Mem0MemoryProvider

def compute_r5(retrieved_docs, gold_answers):
    # token-overlap on retrieved doc text vs gold answer string
    # mirror evaluate/longmemeval/eval.mts r5 logic exactly
    ...

dataset = LongMemEvalDataset()
docs = dataset.load_documents("s")
queries = dataset.load_queries("s")

PROVIDERS = [
    ("bm25", BM25MemoryProvider),
    ("hybrid_search", HybridSearchMemoryProvider),
    ("mem0", Mem0MemoryProvider),
]

for name, ProviderCls in PROVIDERS:
    print(f"=== {name} ===")
    provider = ProviderCls()
    store = Path(tempfile.mkdtemp(prefix=f"amb-{name}-"))
    provider.prepare(store_dir=store)

    t0 = time.time()
    provider.ingest(docs)
    ingest_wall = time.time() - t0

    per_q = []
    t0 = time.time()
    for q in queries:
        retrieved, _ = provider.retrieve(q.query, k=5, user_id=q.user_id)
        sr5 = int(any(d.id in q.gold_ids for d in retrieved))
        r5 = compute_r5(retrieved, q.gold_answers)
        per_q.append({
            "qid": q.id,
            "question_type": q.meta.get("question_type"),
            "sr5": sr5, "r5": r5,
            "gold_ids": list(q.gold_ids),
            "retrieved_ids": [d.id for d in retrieved],
        })
    retrieve_wall = time.time() - t0

    out = {
        "provider": name,
        "n": len(queries),
        "ingest_wall_s": ingest_wall,
        "retrieve_wall_s": retrieve_wall,
        "per_question": per_q,
    }
    with open(f"results-amb-{name}.json", "w") as f:
        json.dump(out, f, indent=2)
    print(f"  done — sr5={sum(x['sr5'] for x in per_q)/len(per_q):.1%}")
```

**Output format**: per-provider JSON file with the same per-question shape
our `report-sr5.py` understands — feed it through to get per-category sr5
+ r5 tables matching the qmd retable.

## Install plan

```bash
# 1. AMB editable install with uv (their package manager)
cd ~/qmd-baselines/amb
uv sync                         # pulls all provider deps including qdrant, sentence-transformers, mem0ai

# 2. Set API keys
export GEMINI_API_KEY=...       # we already have this from earlier in night cycle

# 3. Point AMB at our local LME data
export LONGMEMEVAL_DATA_PATH=/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json

# 4. First run downloads Qwen3-Embedding-0.6B (~2.5 GB) on first hybrid_search use
uv run python amb-bench/run.py
```

**Disk cost**: ~3-4 GB total
- AMB src + venv: ~500 MB
- sentence-transformers cached models: ~2.5 GB (Qwen3) + ~100 MB (multi-qa-MiniLM)
- Qdrant on-disk store: ~200 MB per provider

**Wall budget for n=500 cross-bench**:
- bm25: ~2 min (no embed, no LLM)
- hybrid_search: ~20-30 min (Qwen3 embed is bigger than mxbai-xs)
- mem0: **unknown** — ingest does ~10 sessions × 500 questions = 5000 Gemini calls
  for fact extraction. At Gemini Flash free tier ~100 RPM that's ~50 min wall
  at minimum, possibly hours if TPM throttles. May need paid quota or a smaller
  subset for mem0.

## Risks & open questions

1. **mem0 Gemini call volume.** The biggest unknown. mem0's ingest pattern
   makes one LLM call per ingested doc (or chunk). At 5000+ docs per n=500
   run this is the dominant cost. Mitigation: run mem0 on a smaller slice
   (n=100 or n=200) for the first pass, then scale if quota allows.

2. **AMB Document.id format.** Verified in source: `{question_id}_{session_id}`.
   `Query.gold_ids` is `[f"{question_id}_{answer_session_id}"]` — clean
   match for sr5 scoring.

3. **`HybridSearchMemoryProvider` first-run latency.** Qwen3-Embedding-0.6B
   is ~2.5 GB. On Windows-hosted WSL2 with slow first-token sentence-
   transformers loads, expect ~2-5 min just to start. Cache under
   `~/.cache/huggingface/`.

4. **Mem0 isolation unit.** AMB's LME adapter uses `question_id` as
   `isolation_unit`, so each question gets its own bank. mem0 supports per-
   user isolation natively (`user_id=question_id`). Verified in source.
   Should "just work" but we'll find out at first run.

5. **The L1+per-turn run currently in flight** is taking ~50 min not 25.
   If it crashes WSL, the AMB cross-bench is the next priority anyway.

## What this prep gives us

The deliverable from running this cross-bench is a new ROADMAP retable row
for each of `bm25`, `hybrid_search`, `mem0`, with sr5 + per-category sr5 +
r5 + ingest/retrieve wall, all measured against the same data file as our
qmd numbers. That answers the user's question: how does qmd actually fare
against the systems we've been comparing against, on the same metric, on
the same data, on the same hardware.

## Decision needed before starting

1. **Slice size for mem0**: full n=500 (slow, may rate-limit), or n=100/200
   first to scope wall time + quota burn?
2. **Hindsight**: cite published number with caveat, or apply for Vectorize
   trial?
3. **Order of operations**: install AMB now (heavy first-time deps), or
   wait for the L1+per-turn run to finish first to keep WSL load down?

Recommendation: n=100 mem0 first, cite Hindsight's published number with
caveat, wait for L1+per-turn to finish before installing AMB to avoid
load-stacking that has crashed WSL twice this cycle.
