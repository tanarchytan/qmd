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
    export LOTL_BINARY=/home/tanarchy/qmd-baselines/qmd/bin/qmd

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
_LOTL_ADAPTER_TARGET = Path.home() / "qmd-baselines" / "amb" / "src" / "memory_bench" / "memory" / "qmd.py"
_LOTL_ADAPTER_SOURCE = Path(__file__).parent / "qmd.py"
if _LOTL_ADAPTER_SOURCE.exists() and not _LOTL_ADAPTER_TARGET.exists():
    print(f"Installing qmd adapter into AMB: {_LOTL_ADAPTER_TARGET}")
    _LOTL_ADAPTER_TARGET.write_text(_LOTL_ADAPTER_SOURCE.read_text())

from memory_bench.dataset.longmemeval import LongMemEvalDataset  # noqa: E402
from memory_bench.dataset.locomo import LoComoDataset  # noqa: E402
from memory_bench.memory.qmd import QmdMemoryProvider  # noqa: E402
from memory_bench.models import Document, Query  # noqa: E402


# -----------------------------------------------------------------------------
# Scoring — mirrors evaluate/longmemeval/eval.mts metric definitions exactly
# so AMB-driven results are directly comparable to our historical native-eval
# numbers. Three metric families:
#
#   1. Session-id recall (sr@k) — apples-to-apples with MemPalace recall_any.
#      k ∈ {5, 10, 15, 50}. Hits when any retrieved memory's id matches any
#      gold session id.
#
#   2. Content recall (r@k) — token-overlap. k ∈ {5, 10}. Mirrors native
#      computeRecallAtK: 1 if any single top-k memory has ≥50% gold-token
#      overlap, OR if the top-k union has ≥70% overlap. mrr_content uses the
#      same relevance bar at top-10.
#
#   3. Answer-quality proxies (f1 / em / sh) — native LME computes these
#      against an LLM-generated `prediction` string. We don't generate, so
#      we treat the **union of top-5 retrieved memory text** as the
#      "prediction" and run the same definitions (computeF1, computeEM,
#      computeSubstringHit) against it. This is metric-continuity with the
#      historical eval at the cost of being a content-availability proxy
#      rather than true answer quality.
#
# All scoring is offline. No LLM calls.
# -----------------------------------------------------------------------------

_SR_KS = (5, 10, 15, 50)   # session-id recall@k (matches native eval.mts)
_R_KS = (5, 10)            # content recall@k (matches native eval.mts)
_MRR_K = 10                # MRR over top-10 (matches native eval.mts)


def _tokenize_native(text) -> list[str]:
    """Mirrors evaluate/longmemeval/eval.mts:131 tokenize() — lowercase,
    strip non-word chars, split on whitespace, drop empties. Returns a list
    (NOT a set) because order matters for the EM definition."""
    return [t for t in re.sub(r"[^\w\s]", " ", str(text or "").lower()).split() if t]


def _gold_to_str(gold) -> str:
    """LoCoMo can hand back ints / floats / lists / dicts as gold answers.
    Coerce to a single string for tokenization."""
    if isinstance(gold, str):
        return gold
    if isinstance(gold, (list, tuple)):
        return " ".join(_gold_to_str(g) for g in gold)
    return str(gold)


def _memory_hits_truth(text: str, truth_tokens: list[str]) -> bool:
    """Mirrors native memoryHitsTruth(): true iff this memory's tokens cover
    ≥50% of the gold-truth tokens. Used as the relevance bar for r@k and MRR."""
    if not truth_tokens:
        return True
    mem_tokens = set(_tokenize_native(text))
    hits = sum(1 for t in truth_tokens if t in mem_tokens)
    return (hits / len(truth_tokens)) >= 0.5


def _content_recall_at_k(retrieved: list[Document], gold_answers: list, k: int) -> int:
    """Mirrors native computeRecallAtK(): 1 if any single top-k memory passes
    memoryHitsTruth (≥50% individual coverage) OR the top-k union covers ≥70%
    of the gold tokens. Take max over gold_answers."""
    if not retrieved or not gold_answers:
        return 0
    top_k = retrieved[:k]
    for gold in gold_answers:
        truth_tokens = _tokenize_native(_gold_to_str(gold))
        if not truth_tokens:
            continue
        # Per-doc 50% threshold
        if any(_memory_hits_truth(doc.content, truth_tokens) for doc in top_k):
            return 1
        # Union 70% threshold
        all_tokens: set[str] = set()
        for doc in top_k:
            all_tokens.update(_tokenize_native(doc.content))
        total_hits = sum(1 for t in truth_tokens if t in all_tokens)
        if (total_hits / len(truth_tokens)) >= 0.70:
            return 1
    return 0


def _content_mrr(retrieved: list[Document], gold_answers: list, k: int = _MRR_K) -> float:
    """Mirrors native computeMRR(): 1/rank of first memory in top-k that
    passes memoryHitsTruth, max over gold_answers."""
    if not retrieved or not gold_answers:
        return 0.0
    top_k = retrieved[:k]
    best = 0.0
    for gold in gold_answers:
        truth_tokens = _tokenize_native(_gold_to_str(gold))
        if not truth_tokens:
            best = max(best, 1.0)
            continue
        for i, doc in enumerate(top_k):
            if _memory_hits_truth(doc.content, truth_tokens):
                best = max(best, 1.0 / (i + 1))
                break
    return best


def _build_prediction(retrieved: list[Document], k: int = 5) -> str:
    """No LLM in this harness — treat the concatenation of top-k retrieved
    memory text as the 'prediction' for the native f1/em/sh definitions.
    Yields a content-availability proxy directly comparable to the native
    eval.mts numbers in the limit where the LLM perfectly extracts the
    answer from any context."""
    return " ".join(doc.content for doc in retrieved[:k])


def _native_f1(prediction: str, gold_answers: list) -> float:
    """Mirrors native computeF1(prediction, groundTruth). Token-level F1
    between prediction tokens and gold tokens. Returns max over gold_answers."""
    p = _tokenize_native(prediction)
    if not gold_answers:
        return 0.0
    best = 0.0
    for gold in gold_answers:
        t = _tokenize_native(_gold_to_str(gold))
        if not p and not t:
            best = max(best, 1.0); continue
        if not p or not t:
            continue
        ts = set(t)
        overlap = sum(1 for x in p if x in ts)
        if overlap == 0:
            continue
        prec = overlap / len(p)
        rec = overlap / len(t)
        best = max(best, (2 * prec * rec) / (prec + rec))
    return best


def _native_em(prediction: str, gold_answers: list) -> int:
    """Mirrors native computeEM(): tokenized prediction joined equals
    tokenized gold joined (whole-string match after tokenization).
    Returns max over gold_answers. Almost always 0 in retrieval-only mode
    because the 'prediction' is the full union of retrieved doc text — but
    keep it for metric continuity with historical native eval."""
    p_joined = " ".join(_tokenize_native(prediction))
    if not gold_answers:
        return 0
    for gold in gold_answers:
        t_joined = " ".join(_tokenize_native(_gold_to_str(gold)))
        if p_joined == t_joined:
            return 1
    return 0


def _native_sh(prediction: str, gold_answers: list) -> int:
    """Mirrors native computeSubstringHit(): tokenized prediction joined
    contains tokenized gold joined as a substring. Catches short factual
    answers (counts, names, dates) that F1 under-counts."""
    p_joined = " ".join(_tokenize_native(prediction))
    if not gold_answers:
        return 0
    if not p_joined:
        return 0
    for gold in gold_answers:
        t_joined = " ".join(_tokenize_native(_gold_to_str(gold)))
        if not t_joined:
            return 1  # empty gold = trivial hit
        if t_joined in p_joined:
            return 1
    return 0


def score_query(retrieved: list[Document], gold_ids: list[str], gold_answers: list) -> dict:
    """Compute the full historical metric set for a single query. Returns a
    flat dict. Provider must return enough candidates to support max(_SR_KS)
    = 50 (we ask providers for k=20 by default; sr15/sr50 will saturate at
    sr20 for sparse-hit cases — explicitly note in summary)."""
    gold_set = set(gold_ids) if gold_ids else set()

    # Rank of first session-id hit for sr@k + mrr_session
    rank_first_sr: int | None = None
    for i, doc in enumerate(retrieved):
        if doc.id in gold_set:
            rank_first_sr = i + 1
            break

    metrics: dict = {}

    # 1. Session-id recall @ k (apples-to-apples with MemPalace recall_any)
    for k in _SR_KS:
        metrics[f"sr{k}"] = int(rank_first_sr is not None and rank_first_sr <= k)
    metrics["mrr_session"] = (1.0 / rank_first_sr) if rank_first_sr else 0.0

    # 2. Content recall @ k (mirrors native computeRecallAtK)
    for k in _R_KS:
        metrics[f"r{k}"] = _content_recall_at_k(retrieved, gold_answers, k)
    metrics["mrr"] = _content_mrr(retrieved, gold_answers, k=_MRR_K)  # native MRR semantics

    # 3. Answer-quality proxies — native f1/em/sh against top-5 union as "prediction"
    prediction = _build_prediction(retrieved, k=5)
    metrics["f1"] = _native_f1(prediction, gold_answers)
    metrics["em"] = _native_em(prediction, gold_answers)
    metrics["sh"] = _native_sh(prediction, gold_answers)

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
        print(
            f"  done — sr5={overall['sr5']:.1%} sr10={overall['sr10']:.1%} sr15={overall['sr15']:.1%} sr50={overall['sr50']:.1%}"
            f"  r5={overall['r5']:.1%} r10={overall['r10']:.1%}  mrr={overall['mrr']:.3f}"
            f"  f1={overall['f1']:.3f} em={overall['em']:.1%} sh={overall['sh']:.1%}"
            f"  retrieve_wall={retrieve_wall:.1f}s"
        )
        if len(by_category) > 1:
            print(f"  per-category (n={n}):")
            print(f"    {'category':<32} {'n':<4} {'sr5':<7} {'sr10':<7} {'sr15':<7} {'r5':<7} {'r10':<7} {'mrr':<7} {'f1':<7} {'em':<7} {'sh':<7}")
            for cat in sorted(by_category.keys()):
                c = by_category[cat]
                print(
                    f"    {cat:<32} {c['n']:<4} "
                    f"{c['sr5']:<7.1%} {c['sr10']:<7.1%} {c['sr15']:<7.1%} "
                    f"{c['r5']:<7.1%} {c['r10']:<7.1%} {c['mrr']:<7.3f} "
                    f"{c['f1']:<7.3f} {c['em']:<7.1%} {c['sh']:<7.1%}"
                )

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
        ("qmd-l1", {"LOTL_INGEST_USER_ONLY": "on"}),
        ("qmd-cerank", {
            "LOTL_MEMORY_RERANK": "cross-encoder",
            "LOTL_TRANSFORMERS_RERANK": "cross-encoder/ms-marco-MiniLM-L6-v2/onnx/model_quint8_avx2",
        }),
    ]

    datasets: list[tuple[str, object, str]] = [
        ("longmemeval", LongMemEvalDataset(), "s"),
        ("locomo", LoComoDataset(), "locomo10"),
    ]

    only_configs = {c.strip() for c in os.environ.get("AMB_CONFIGS", "").split(",") if c.strip()}
    if only_configs:
        configs = [c for c in configs if c[0] in only_configs]
    only_datasets = {d.strip() for d in os.environ.get("AMB_DATASETS", "").split(",") if d.strip()}
    if only_datasets:
        datasets = [d for d in datasets if d[0] in only_datasets]

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

    # Print final comparison table — flat overview across all (config, dataset) cells.
    # Mirrors the historical native-eval columns (sr5, sr10, sr15, r5, r10, mrr, f1, em, sh)
    # so AMB-driven numbers can be slotted into the ROADMAP retable directly.
    print("\n\n=== FINAL ===")
    print(
        f"{'config':<16} {'dataset':<12} {'n':<5} "
        f"{'sr5':<7} {'sr10':<7} {'sr15':<7} {'r5':<7} {'r10':<7} {'mrr':<7} "
        f"{'f1':<7} {'em':<7} {'sh':<7} {'wall':<8}"
    )
    for s in summaries:
        o = s.get("overall", {})
        wall = f"{s['ingest_wall_s'] + s['retrieve_wall_s']:.0f}s"
        print(
            f"{s['config']:<16} {s['dataset']:<12} {s['n']:<5} "
            f"{o.get('sr5', 0):<7.1%} {o.get('sr10', 0):<7.1%} {o.get('sr15', 0):<7.1%} "
            f"{o.get('r5', 0):<7.1%} {o.get('r10', 0):<7.1%} {o.get('mrr', 0):<7.3f} "
            f"{o.get('f1', 0):<7.3f} {o.get('em', 0):<7.1%} {o.get('sh', 0):<7.1%} "
            f"{wall:<8}"
        )


if __name__ == "__main__":
    main()
