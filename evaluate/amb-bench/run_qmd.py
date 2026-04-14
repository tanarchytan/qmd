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
# Scoring (mirror evaluate/longmemeval/eval.mts r5 + sr5 logic)
# -----------------------------------------------------------------------------

_TOKEN_RE = re.compile(r"[^\w\s'-]")


def _tokenize(text: str) -> set[str]:
    """Lowercase, strip punctuation, split on whitespace, drop very short tokens."""
    cleaned = _TOKEN_RE.sub(" ", text.lower())
    return {t for t in cleaned.split() if len(t) >= 2}


def compute_r5(retrieved: list[Document], gold_answers: list) -> int:
    """Token-overlap r5: 1 if ≥70% of any gold answer's tokens appear in any
    retrieved doc text, OR any single retrieved doc text contains ≥70% of any
    gold answer. Mirrors eval.mts r5 logic at session-id metric audit.

    LoCoMo gold answers can be ints/floats/lists, not just strings, so
    coerce everything to str before tokenizing."""
    if not retrieved or not gold_answers:
        return 0
    retrieved_tokens: set[str] = set()
    for doc in retrieved:
        retrieved_tokens.update(_tokenize(doc.content))
    for gold in gold_answers:
        gold_str = str(gold) if not isinstance(gold, str) else gold
        gold_tokens = _tokenize(gold_str)
        if not gold_tokens:
            continue
        overlap = len(gold_tokens & retrieved_tokens) / len(gold_tokens)
        if overlap >= 0.70:
            return 1
        # Also check per-doc — a single doc containing the answer tokens
        for doc in retrieved:
            doc_tokens = _tokenize(doc.content)
            if not doc_tokens:
                continue
            per_doc = len(gold_tokens & doc_tokens) / len(gold_tokens)
            if per_doc >= 0.70:
                return 1
    return 0


def compute_sr5(retrieved: list[Document], gold_ids: list[str]) -> int:
    """Session-id recall_any@5: 1 if any retrieved doc's id matches any gold id."""
    if not retrieved or not gold_ids:
        return 0
    gold = set(gold_ids)
    return int(any(d.id in gold for d in retrieved))


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
        # Then load only the documents needed by those queries: AMB's load_documents
        # supports user_ids filter, and for both LME and LoCoMo the user_id (=
        # isolation unit) is the question/conversation scope. Without this filter,
        # passing limit=20 to load_documents caps the TOTAL doc count at 20 which
        # for LME means we only get 20 of ~25,000 sessions and every right session
        # falls outside the loaded set → sr5 = 0%.
        queries = dataset.load_queries(split=split, limit=limit)
        if queries and any(q.user_id for q in queries):
            user_ids = {q.user_id for q in queries if q.user_id}
            documents = dataset.load_documents(split=split, user_ids=user_ids)
        else:
            documents = dataset.load_documents(split=split, limit=limit)
        print(f"  loaded {len(documents)} docs, {len(queries)} queries")

        # Ingest
        provider.prepare(store_dir=Path("/tmp/amb-qmd-bench"), unit_ids=None)
        t0 = time.time()
        provider.ingest(documents)
        ingest_wall = time.time() - t0
        print(f"  ingest done in {ingest_wall:.1f}s")

        # Retrieve + score
        per_q = []
        t0 = time.time()
        for i, q in enumerate(queries):
            retrieved, _ = provider.retrieve(q.query, k=5, user_id=q.user_id)
            sr5 = compute_sr5(retrieved, q.gold_ids)
            r5 = compute_r5(retrieved, q.gold_answers)
            per_q.append({
                "query_id": q.id,
                "question_type": q.meta.get("question_type") if q.meta else None,
                "sr5": sr5,
                "r5": r5,
                "gold_ids": list(q.gold_ids),
                "retrieved_ids": [d.id for d in retrieved],
            })
            if (i + 1) % 50 == 0:
                cur_sr5 = sum(x["sr5"] for x in per_q) / len(per_q)
                print(f"  [{i + 1}/{len(queries)}] sr5={cur_sr5:.1%}")
        retrieve_wall = time.time() - t0

        n = len(per_q)
        sr5_mean = sum(x["sr5"] for x in per_q) / n if n else 0.0
        r5_mean = sum(x["r5"] for x in per_q) / n if n else 0.0
        print(f"  done — sr5={sr5_mean:.1%} r5={r5_mean:.1%} retrieve_wall={retrieve_wall:.1f}s")

        summary = {
            "config": config_name,
            "dataset": dataset_name,
            "split": split,
            "n": n,
            "sr5_overall": sr5_mean,
            "r5_overall": r5_mean,
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
