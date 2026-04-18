# Baselines audit — what's runnable for QMD comparison

Audit done 2026-04-14 night. Goal: determine which competitor systems we can
actually benchmark against on **the same LongMemEval _s_cleaned dataset** we
use for QMD, so the comparison is apples-to-apples instead of citing
published numbers from different setups.

## Repos cloned to `~/qmd-eval/baselines/`

| Repo | URL | Status |
|---|---|---|
| **mempalace** | `github.com/milla-jovovich/mempalace` | ✅ cloned, **has native LME bench** |
| **mem0** | `github.com/mem0ai/mem0` | ✅ cloned, no native LME (uses LOCOMO) |
| **letta** | `github.com/letta-ai/letta` | ✅ cloned, no native LME (agent-state focused) |
| **hindsight** | `github.com/superlinear-ai/hindsight` | ❌ empty repo on master / wrong URL — README originally cited this URL but the actual canonical source is unconfirmed |

## What's directly runnable tonight

### 1. MemPalace — runnable, free, ~12-15 min wall

**Why it's runnable:** ships its own `benchmarks/longmemeval_bench.py` that
takes the same `longmemeval_s_cleaned.json` file we already have at
`~/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json`. Standalone
Python — only chromadb + fastembed deps. Can run in `--mode raw` (no LLM,
no API key) which is how they get their published 96.6% R@5 headline.

**Setup steps (10-15 min):**
```bash
cd ~/qmd-eval/baselines/mempalace
python3 -m venv .venv
source .venv/bin/activate
pip install -e .
pip install chromadb fastembed
```

**Run:**
```bash
source .venv/bin/activate
python benchmarks/longmemeval_bench.py \
  ~/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json \
  --mode raw --limit 500
```

**Expected output:** R@5 ≈ 96.6%, R@10 ≈ 98.2%, multi-session R@5 ≈ 100%
per their published numbers.

**Apples-to-apples caveats:**
- They use ChromaDB EphemeralClient (per-question fresh DB) — equivalent
  to QMD's `scope = question_id` partition key. No advantage either way.
- They use the LongMemEval-published "session granularity" by default
  (one doc per session). We use the same default.
- Their default embed is fastembed `all-MiniLM-L6-v2` (384d). That's
  the exact baseline we kicked off the night with at 93.2% R@5 / 81%
  multi-session before swapping to mxbai-xs q8 then arctic-s q8.
- **Free, reproducible, takes ~15 min.** No reason not to run it.

**Optional (~$1, +reranker):** `--mode hybrid_v4_haiku` adds Haiku rerank
for the 100% R@5 number. Needs an Anthropic API key.

### 2. mem0 — needs adapter, not runnable as-is

**Why not runnable directly:** mem0's eval is LOCOMO, not LongMemEval. They
have no LME harness. Their API shape (`Memory.add()` / `Memory.search()`)
maps cleanly to LME ingest+retrieve, but the harness has to be written.

**What an adapter would look like:**
```python
from mem0 import Memory
m = Memory()
for sess in entry["haystack_sessions"]:
    m.add(sess_text, user_id=question_id)
hits = m.search(entry["question"], user_id=question_id, limit=50)
# score against ground truth
```

**Cost:** Mem0 calls an LLM at ingest time (extraction). Per-question
LLM cost × 500 questions × ~50 sessions/question = significant. Default
extractor uses GPT-4o-mini; ~$5-15 to run n=500.

**Time to write adapter:** ~1-2 hours of careful work. Out of scope for
tonight given phase 4/5 are running.

**Realistic plan:** queue for tomorrow morning. Their published LOCOMO
numbers are well-known (~30-45% R@5 on LOCOMO) but we'd want LME numbers
to compare against ours.

### 3. Letta — needs major adapter, agent-shaped not retrieval-shaped

**Why not runnable directly:** Letta is built around stateful agents with
recall + archival memory tiers. The agent self-directs retrieval via tool
calls. There's no plain `search()` API — you create an agent, give it the
sessions as context, and ask it the question. The agent then decides which
memories to look up. That's fundamentally a different evaluation shape than
LongMemEval expects.

**Cost:** very high. Each question requires running an agent end-to-end with
LLM calls for tool dispatch, retrieval, and answer synthesis. ~$20-50 to
run n=500.

**Realistic plan:** **skip** unless we want to write a major adapter. The
comparison is also unfair — Letta is optimizing for agent reasoning quality,
not pure retrieval recall. They don't publish LongMemEval numbers because
LME isn't the right benchmark for their architecture.

### 4. Hindsight — source unverified

**Why not runnable:** the URL I cited in the README earlier
(`superlinear-ai/hindsight`) doesn't host a real repo. Cloning gives an
empty git directory with no commits. The 91.4% LongMemEval number cited in
our `docs/EVAL.md` SOTA table came from a paper or write-up I haven't been
able to re-find. **Action:** README updated to mark this entry as
"architectural target, source-unconfirmed" and ask for help locating the
canonical link.

## Realistic deliverable for tonight

**What I can do without disrupting phase 4/5:**

1. ✅ Clone all 4 repos (done — `~/qmd-eval/baselines/`)
2. ✅ Audit each one's eval methodology (this doc)
3. ✅ Fix the bad Hindsight URL in README
4. ⏳ Stage MemPalace venv + install (defer run until phase 4/5 finish to
   avoid CPU contention)
5. ⏳ Run MemPalace `--mode raw --limit 500` in the post-phase 5 window
6. ⏳ Compile a comparison table once we have both sides

**What needs another session:**

- mem0 adapter (1-2 hours)
- Letta adapter (4+ hours, may not be worth it)
- Hindsight verification (research, not code)

## Comparison table (to fill in after MemPalace run)

| System | R@5 | R@10 | multi-session R@5 | Wall | Notes |
|---|---|---|---|---|---|
| MemPalace raw (their published) | 96.6% | 98.2% | 100% | ~12.5 min | reference |
| MemPalace raw (our run) | TBD | TBD | TBD | TBD | apples-to-apples |
| **QMD mxbai-xs q8 baseline** | **94.2%** | **94.4%** | **82%** | **15m12s** | tonight |
| **QMD arctic-s q8 baseline** | **93.2%** | **95.4%** | **84.2%** 🏆 | **~25m** | tonight, ceiling break |
| Mem0 (LME, our adapter run) | — | — | — | — | adapter pending |
| Letta (skip) | — | — | — | — | wrong eval shape |
| Hindsight (cited published) | 91.4% | — | — | — | source unconfirmed |

## Honest summary

**The headline claim** ("compare to all the major systems") **is a 1-week
project, not a 1-night project.** What we CAN do tonight is run MemPalace's
own LongMemEval bench against the same data file, which is a clean
apples-to-apples comparison and confirms (or revises) their published
96.6% number on our hardware.

The 12-14pp gap between QMD's 84.2% multi-session and MemPalace's published
100% multi-session is the most important single comparison in the project.
Re-running MemPalace tonight on the same data file lets us answer:
- Is their 100% multi-session real on our hardware? (validate)
- What's their R@5 distribution by category? (might show different
  bottlenecks than QMD has)
- Does ChromaDB's EphemeralClient really equal our partition-key approach,
  or is there a setup difference we're missing?

**If the MemPalace run reproduces ~96.6% R@5 / ~100% multi:** the gap is
real and the v17 priority is closing it via cross-encoder rerank +
4-parallel-path retrieval (per ROADMAP cat 2).

**If it reproduces lower than published:** something in our hardware /
fastembed version / Python env differs from theirs, and the gap is
narrower than we thought.

Either result is valuable.
