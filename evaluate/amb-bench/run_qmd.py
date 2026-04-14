"""
qmd × AMB cross-dataset bench runner.

Runs the qmd memory provider through AMB's LongMemEvalDataset and
LoComoDataset adapters, scoring sr5 (session-id recall@5) and r5
(token-overlap content availability) ourselves against Query.gold_ids
and Query.gold_answers. Skips AMB's generate + judge LLM steps entirely.

Supports config sweeps: bench `qmd-default`, `qmd-l1`, `qmd-cerank`, etc.
in one run, each as a separate logical "provider" with its own
QmdMemoryProvider subprocess.

Usage
-----
    # Point at our local data files so AMB's adapters skip HF download
    export LONGMEMEVAL_DATA_PATH=/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json
    export LOCOMO_DATA_PATH=/home/tanarchy/qmd-eval/evaluate/locomo/locomo10.json

    # Tell the qmd adapter where the binary lives
    export QMD_BINARY=/home/tanarchy/qmd-baselines/qmd/bin/qmd

    # Run from inside AMB's venv so memory_bench is importable
    cd ~/qmd-baselines/amb
    uv run python /mnt/c/.../evaluate/amb-bench/run_qmd.py

Output
------
Per (config, dataset) JSON file at `results-amb-{config}-{dataset}.json`
with the same per-question shape report-sr5.py understands, plus
ingest_wall_s and retrieve_wall_s.
"""

from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import defaultdict
from dataclasses import asdict
from pathlib import Path

# Add AMB src to path so we can import its modules without uv
sys.path.insert(0, str(Path.home() / "qmd-baselines" / "amb" / "src"))

# This script lives in our repo on /mnt/c, but the qmd adapter we wrote
# lives in evaluate/amb-bench/qmd.py — drop it next to AMB's other
# memory providers so its relative imports (..models, .base) resolve.
_QMD_ADAPTER_TARGET = Path.home() / "qmd-baselines" / "amb" / "src" / "memory_bench" / "memory" / "qmd.py"
_QMD_ADAPTER_SOURCE = Path(__file__).parent / "qmd.py"
if _QMD_ADAPTER_SOURCE.exists() and not _QMD_ADAPTER_TARGET.exists():
    print(f"Installing qmd adapter into AMB: {_QMD_ADAPTER_TARGET}")
    _QMD_ADAPTER_TARGET.write_text(_QMD_ADAPTER_SOURCE.read_text())

from memory_bench.dataset.longmemeval import LongMemEvalDataset  # noqa: E402
from memory_bench.dataset.locomo import LoComoDataset  # noqa: E402
from memory_bench.memory.qmd import QmdMemoryProvider  # noqa: E402
from memory_bench.models import Document, Query  # noqa: E402


# -----------------------------------------------------------------------------
# Scoring — retrieval (sr@k, r@k, mrr) + answer-availability (sh, f1)
#
# All scoring runs OFFLINE against the retrieved doc list and the dataset's
# gold_ids / gold_answers. No LLM calls. Mirrors what an LLM-free retrieval
# benchmark would compute.
# -----------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[^\w\s'-]")
_KS = (1, 5, 10, 20)  # k values to compute sr@k and r@k for


def _tokenize(text: str) -> set[str]:
    """Lowercase, strip punctuation, split on whitespace, drop very short tokens."""
    cleaned = _TOKEN_RE.sub(" ", text.lower())
    return {t for t in cleaned.split() if len(t) >= 2}


def _gold_to_str(gold) -> str:
    """LoCoMo can hand back ints / floats / lists / dicts as gold answers.
    Coerce to a single string for tokenization."""
    if isinstance(gold, str):
        return gold
    if isinstance(gold, (list, tuple)):
        return " ".join(_gold_to_str(g) for g in gold)
    return str(gold)


def _token_overlap_at_k(retrieved: list[Document], gold_answers: list, k: int) -> int:
    """1 if ≥70% of any gold answer's tokens appear in the union of the top-k
    retrieved doc texts, OR any single top-k doc contains ≥70% of any gold
    answer (mirrors evaluate/longmemeval/eval.mts r5 logic)."""
    if not retrieved or not gold_answers:
        return 0
    top_k = retrieved[:k]
    union_tokens: set[str] = set()
    for doc in top_k:
        union_tokens.update(_tokenize(doc.content))
    for gold in gold_answers:
        gold_tokens = _tokenize(_gold_to_str(gold))
        if not gold_tokens:
            continue
        if len(gold_tokens & union_tokens) / len(gold_tokens) >= 0.70:
            return 1
        for doc in top_k:
            doc_tokens = _tokenize(doc.content)
            if not doc_tokens:
                continue
            if len(gold_tokens & doc_tokens) / len(gold_tokens) >= 0.70:
                return 1
    return 0


def _substring_hit(retrieved: list[Document], gold_answers: list, k: int = 5) -> int:
    """1 if any gold answer string appears (case-insensitive) as a substring
    of any top-k retrieved doc. Catches short factual answers (counts, dates,
    yes/no) that token-overlap under-counts. Used by LoCoMo for short answers."""
    if not retrieved or not gold_answers:
        return 0
    top_k = retrieved[:k]
    for gold in gold_answers:
        needle = _gold_to_str(gold).strip().lower()
        if not needle or len(needle) < 2:
            continue
        for doc in top_k:
            if needle in doc.content.lower():
                return 1
    return 0


def _token_f1(retrieved: list[Document], gold_answers: list, k: int = 5) -> float:
    """Token-level F1 between the union of top-k retrieved doc tokens and the
    best-matching gold answer's tokens. Returns the max F1 over gold answers."""
    if not retrieved or not gold_answers:
        return 0.0
    top_k = retrieved[:k]
    pred_tokens: set[str] = set()
    for doc in top_k:
        pred_tokens.update(_tokenize(doc.content))
    best = 0.0
    for gold in gold_answers:
        gold_tokens = _tokenize(_gold_to_str(gold))
        if not gold_tokens or not pred_tokens:
            continue
        common = len(gold_tokens & pred_tokens)
        if common == 0:
            continue
        precision = common / len(pred_tokens)
        recall = common / len(gold_tokens)
        f1 = 2 * precision * recall / (precision + recall)
        best = max(best, f1)
    return best


def score_query(retrieved: list[Document], gold_ids: list[str], gold_answers: list) -> dict:
    """Compute all metrics for a single query. Returns a flat dict keyed by
    metric name. The retriever should return enough candidates to support the
    largest k in _KS (we ask providers for k=20)."""
    gold_set = set(gold_ids) if gold_ids else set()

    # Rank of first session-id hit (1-indexed). None if no hit in the list.
    rank_first_sr: int | None = None
    for i, doc in enumerate(retrieved):
        if doc.id in gold_set:
            rank_first_sr = i + 1
            break

    metrics: dict = {}
    for k in _KS:
        metrics[f"sr{k}"] = int(rank_first_sr is not None and rank_first_sr <= k)
    metrics["mrr"] = (1.0 / rank_first_sr) if rank_first_sr else 0.0
    for k in (1, 5, 10):
        metrics[f"r{k}"] = _token_overlap_at_k(retrieved, gold_answers, k)
    metrics["sh"] = _substring_hit(retrieved, gold_answers, k=5)
    metrics["f1"] = _token_f1(retrieved, gold_answers, k=5)
    return metrics


# -----------------------------------------------------------------------------
# Bench runner
# -----------------------------------------------------------------------------

def run_provider_on_dataset(
    config_name: str,
    env_overrides: dict[str, str],
    dataset_name: str,
    dataset,
    split: str,
    out_dir: Path,
    limit: int | None = None,
) -> dict:
    """Spawn a fresh qmd subprocess for this config, ingest the dataset,
    score every query, write a result JSON, return the summary dict."""
    print(f"\n=== {config_name} × {dataset_name}/{split} ===")
    out_path = out_dir / f"results-amb-{config_name}-{dataset_name}-{split}.json"
    if out_path.exists():
        print(f"  already exists, skipping: {out_path}")
        with open(out_path) as f:
            return json.load(f)

    provider = QmdMemoryProvider(
        name_suffix=config_name.replace("qmd-", "") if config_name.startswith("qmd-") else config_name,
        env_overrides=env_overrides,
    )
    provider.initialize()
    try:
        # Load queries first (limit applies here — restricts the question set).
        # Then load only the documents needed by those queries via user_ids
        # filter (LME's user_id is question_id, LoCoMo's is sample_id). Without
        # this, passing limit=20 to load_documents caps the TOTAL doc count at
        # 20 which for LME means we only get 20 of ~25,000 sessions and every
        # right session falls outside the loaded set → sr5 = 0%.
        #
        # Some adapters (LoCoMoDataset) don't implement the user_ids parameter.
        # Fall back to limit-based load when user_ids isn't accepted.
        queries = dataset.load_queries(split=split, limit=limit)
        documents = None
        if queries and any(q.user_id for q in queries):
            user_ids = {q.user_id for q in queries if q.user_id}
            try:
                documents = dataset.load_documents(split=split, user_ids=user_ids)
            except TypeError:
                pass  # adapter doesn't support user_ids — fall through
        if documents is None:
            documents = dataset.load_documents(split=split, limit=limit)
        print(f"  loaded {len(documents)} docs, {len(queries)} queries")

        # Ingest
        provider.prepare(store_dir=Path("/tmp/amb-qmd-bench"), unit_ids=None)
        t0 = time.time()
        provider.ingest(documents)
        ingest_wall = time.time() - t0
        print(f"  ingest done in {ingest_wall:.1f}s")

        # Retrieve k=20 (max k we score @) + compute all metrics per query.
        # Both LME and LoCoMo expose category info on Query.meta — LME uses
        # `question_type`, LoCoMo uses `category`. Stash whichever exists so
        # the per-category breakdown works for both.
        per_q = []
        t0 = time.time()
        for i, q in enumerate(queries):
            retrieved, _ = provider.retrieve(q.query, k=20, user_id=q.user_id)
            metrics = score_query(retrieved, q.gold_ids, q.gold_answers)
            category = None
            if q.meta:
                category = q.meta.get("question_type") or q.meta.get("category")
            per_q.append({
                "query_id": q.id,
                "category": category,
                **metrics,
                "gold_ids": list(q.gold_ids),
                "retrieved_ids": [d.id for d in retrieved],
            })
            if (i + 1) % 50 == 0:
                cur_sr5 = sum(x["sr5"] for x in per_q) / len(per_q)
                print(f"  [{i + 1}/{len(queries)}] sr5={cur_sr5:.1%}")
        retrieve_wall = time.time() - t0

        n = len(per_q)
        # Aggregate overall + per-category
        metric_keys = [k for k in per_q[0].keys() if k not in ("query_id", "category", "gold_ids", "retrieved_ids")] if per_q else []
        overall = {k: (sum(x[k] for x in per_q) / n if n else 0.0) for k in metric_keys}
        by_category: dict[str, dict] = {}
        cat_buckets: dict[str, list] = defaultdict(list)
        for r in per_q:
            cat = r["category"] or "uncategorized"
            cat_buckets[cat].append(r)
        for cat, rows in cat_buckets.items():
            cat_n = len(rows)
            by_category[cat] = {"n": cat_n, **{k: sum(x[k] for x in rows) / cat_n for k in metric_keys}}

        # Print compact summary line + per-category table
        print(f"  done — sr5={overall['sr5']:.1%} sr10={overall['sr10']:.1%} mrr={overall['mrr']:.3f} r5={overall['r5']:.1%} sh={overall['sh']:.1%} f1={overall['f1']:.3f} retrieve_wall={retrieve_wall:.1f}s")
        if len(by_category) > 1:
            print(f"  per-category (n={n}):")
            print(f"    {'category':<32} {'n':<5} {'sr5':<7} {'sr10':<7} {'mrr':<7} {'r5':<7} {'sh':<7} {'f1':<7}")
            for cat in sorted(by_category.keys()):
                c = by_category[cat]
                print(f"    {cat:<32} {c['n']:<5} {c['sr5']:<7.1%} {c['sr10']:<7.1%} {c['mrr']:<7.3f} {c['r5']:<7.1%} {c['sh']:<7.1%} {c['f1']:<7.3f}")

        summary = {
            "config": config_name,
            "dataset": dataset_name,
            "split": split,
            "n": n,
            "overall": overall,
            "by_category": by_category,
            "ingest_wall_s": ingest_wall,
            "retrieve_wall_s": retrieve_wall,
            "per_question": per_q,
        }
        out_dir.mkdir(parents=True, exist_ok=True)
        with open(out_path, "w") as f:
            json.dump(summary, f, indent=2)
        print(f"  wrote {out_path}")
        return summary
    finally:
        provider.cleanup()


def main() -> None:
    out_dir = Path.home() / "qmd-baselines" / "amb-results"

    # Config sweep — each runs through both datasets.
    configs: list[tuple[str, dict[str, str]]] = [
        ("qmd-default", {}),
        ("qmd-l1", {"QMD_INGEST_USER_ONLY": "on"}),
        # cross-encoder rerank (may be added once we have eval data on it)
        # ("qmd-cerank", {
        #     "QMD_MEMORY_RERANK": "cross-encoder",
        #     "QMD_TRANSFORMERS_RERANK": "cross-encoder/ms-marco-MiniLM-L6-v2/onnx/model_quint8_avx2",
        # }),
    ]

    datasets: list[tuple[str, object, str]] = [
        ("longmemeval", LongMemEvalDataset(), "s"),
        ("locomo", LoComoDataset(), "locomo10"),
    ]

    # Quick smoke-test mode — env-driven so we can sanity check on a tiny slice
    limit = int(os.environ.get("AMB_LIMIT", "0")) or None
    if limit:
        print(f"(running with AMB_LIMIT={limit})")

    summaries = []
    for cfg_name, env_overrides in configs:
        for ds_name, ds, split in datasets:
            try:
                s = run_provider_on_dataset(
                    cfg_name, env_overrides, ds_name, ds, split, out_dir, limit=limit
                )
                summaries.append(s)
            except Exception as e:
                print(f"  FAILED: {cfg_name} × {ds_name}: {e!r}")

    # Print final comparison table
    print("\n\n=== FINAL ===")
    print(f"{'config':<20} {'dataset':<15} {'n':<6} {'sr5':<8} {'r5':<8} {'wall':<10}")
    for s in summaries:
        wall = f"{s['ingest_wall_s'] + s['retrieve_wall_s']:.0f}s"
        print(f"{s['config']:<20} {s['dataset']:<15} {s['n']:<6} {s['sr5_overall']:<8.1%} {s['r5_overall']:<8.1%} {wall:<10}")


if __name__ == "__main__":
    main()
