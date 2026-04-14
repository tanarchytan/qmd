"""
qmd memory provider for AMB (Agent Memory Benchmark).

Wraps `@tanarchy/qmd`, an on-device hybrid search + memory framework with
BM25 (FTS5) + dense vector (sqlite-vec) + RRF fusion + optional local
cross-encoder rerank — see https://github.com/tanarchytan/qmd.

Architecture
------------
qmd is a TypeScript/Node package, not a Python library. This adapter
spawns `qmd mcp --http --port N` as a subprocess in `initialize()` and
talks to it via the MCP protocol over HTTP. Every ingest call becomes
one `memory_store` MCP tool invocation; every retrieve call becomes
one `memory_recall`. The qmd process exits cleanly on `cleanup()`.

The `metadata` field on `memory_store` (added in qmd commit 2d85b8a)
is used to round-trip AMB's `Document.id` through qmd so retrieval
results can be mapped back to gold IDs for scoring.

qmd config (embedding model, recall mode, reranker, partition keys, etc.)
is controlled by environment variables passed through to the subprocess.
The default config used here matches qmd's 2026-04-14 production winner:
mxbai-xs q8 + loose-floor + transformers backend. Override via
`QmdMemoryProvider(env_overrides={...})` to bench config sweeps as
separate "providers" in the same AMB run.

Dependencies
------------
- `qmd` binary on PATH (or `QMD_BINARY` env var pointing at it).
  Install: `npm install -g @tanarchy/qmd` or build from source.
- Node.js >= 22.
- Python: `requests`, `mcp` (the MCP Python SDK).

Activation
----------
    from memory_bench.memory.qmd import QmdMemoryProvider

    # Default — qmd production config
    provider = QmdMemoryProvider()

    # Or with config overrides for a sweep
    provider_l1 = QmdMemoryProvider(
        name_suffix="l1",
        env_overrides={"QMD_INGEST_USER_ONLY": "on"},
    )
    provider_cerank = QmdMemoryProvider(
        name_suffix="cerank",
        env_overrides={
            "QMD_MEMORY_RERANK": "cross-encoder",
            "QMD_TRANSFORMERS_RERANK": "cross-encoder/ms-marco-MiniLM-L6-v2/onnx/model_quint8_avx2",
        },
    )
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from pathlib import Path

import requests

from ..models import Document
from .base import MemoryProvider


# qmd's 2026-04-14 production winner (sr5 98.4% on LongMemEval _s n=500).
# These env vars are forwarded to the qmd MCP subprocess unless overridden.
_DEFAULT_QMD_ENV: dict[str, str] = {
    "QMD_EMBED_BACKEND": "transformers",
    "QMD_TRANSFORMERS_EMBED": "mixedbread-ai/mxbai-embed-xsmall-v1",
    "QMD_TRANSFORMERS_DTYPE": "q8",
    "QMD_VEC_MIN_SIM": "0.1",
    "QMD_TRANSFORMERS_QUIET": "on",
}


def _find_free_port() -> int:
    """Pick an unused localhost port for the qmd MCP server."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _wait_for_health(url: str, timeout_s: float = 30.0) -> None:
    """Block until the qmd MCP HTTP server responds, or raise on timeout."""
    deadline = time.monotonic() + timeout_s
    last_err: Exception | None = None
    while time.monotonic() < deadline:
        try:
            r = requests.get(f"{url}/health", timeout=2)
            if r.status_code == 200:
                return
        except Exception as e:
            last_err = e
        time.sleep(0.3)
    raise RuntimeError(f"qmd MCP server did not become ready at {url} within {timeout_s}s: {last_err}")


class QmdMemoryProvider(MemoryProvider):
    """
    qmd via MCP HTTP transport.

    See module docstring for context. Each instance spawns its own qmd
    subprocess so config sweeps (different env_overrides) don't share state.
    """

    name = "qmd"
    description = (
        "On-device hybrid search + memory framework. SQLite FTS5 (BM25, porter "
        "stemmed) + sqlite-vec (dense, mxbai-xs q8 default 384d) + RRF fusion. "
        "Optional local ONNX cross-encoder rerank via transformers.js. "
        "Talks via MCP HTTP transport — wrapper spawns `qmd mcp --http` as a "
        "subprocess and pipes ingest/retrieve through the standard MCP tools."
    )
    kind = "local"
    provider = "qmd"
    variant = "local"
    link = "https://github.com/tanarchytan/qmd"
    logo = None
    # qmd MCP uses a single SQLite db with FTS5 + WAL; serialise calls to
    # avoid sqlite "database is locked" under heavy concurrency. Workers
    # can still ingest across multiple QmdMemoryProvider instances.
    concurrency = 2

    def __init__(
        self,
        name_suffix: str | None = None,
        env_overrides: dict[str, str] | None = None,
        binary: str | None = None,
        startup_timeout_s: float = 30.0,
    ):
        if name_suffix:
            self.name = f"qmd-{name_suffix}"
        self._env_overrides = env_overrides or {}
        self._binary = binary or os.environ.get("QMD_BINARY") or shutil.which("qmd")
        if not self._binary:
            raise RuntimeError(
                "qmd binary not found. Install via `npm install -g @tanarchy/qmd` "
                "or set QMD_BINARY=/path/to/qmd."
            )
        self._startup_timeout_s = startup_timeout_s
        self._proc: subprocess.Popen | None = None
        self._port: int | None = None
        self._url: str | None = None
        self._cache_dir: Path | None = None

    # -------------------------------------------------------------------
    # Lifecycle
    # -------------------------------------------------------------------

    def initialize(self) -> None:
        """Spawn the qmd MCP HTTP server and wait for it to come up."""
        self._port = _find_free_port()
        self._cache_dir = Path(tempfile.mkdtemp(prefix=f"qmd-amb-{self.name}-"))

        env = os.environ.copy()
        env.update(_DEFAULT_QMD_ENV)
        env.update(self._env_overrides)
        # Isolate qmd's index per provider instance so config sweeps don't
        # share the same sqlite db.
        env.setdefault("QMD_CACHE_DIR", str(self._cache_dir))

        self._proc = subprocess.Popen(
            [self._binary, "mcp", "--http", "--port", str(self._port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
        )
        self._url = f"http://127.0.0.1:{self._port}"
        try:
            _wait_for_health(self._url, timeout_s=self._startup_timeout_s)
        except Exception:
            self.cleanup()
            raise

    def cleanup(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            finally:
                self._proc = None
        if self._cache_dir is not None and self._cache_dir.exists():
            shutil.rmtree(self._cache_dir, ignore_errors=True)
            self._cache_dir = None
        self._port = None
        self._url = None

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        # qmd's storage is managed by initialize() via QMD_CACHE_DIR; nothing
        # to do per-prepare beyond a no-op. AMB calls prepare() after
        # initialize() so we just confirm the server is up.
        if self._url is None:
            self.initialize()

    # -------------------------------------------------------------------
    # MCP tool calls
    # -------------------------------------------------------------------

    def _call_tool(self, tool: str, arguments: dict) -> dict:
        """Invoke an MCP tool over HTTP and return its parsed result."""
        if self._url is None:
            raise RuntimeError("QmdMemoryProvider not initialized. Call initialize() first.")
        # MCP HTTP transport uses JSON-RPC 2.0 envelopes.
        payload = {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        r = requests.post(f"{self._url}/mcp", json=payload, timeout=60)
        r.raise_for_status()
        body = r.json()
        if "error" in body:
            raise RuntimeError(f"qmd MCP error on {tool}: {body['error']}")
        return body.get("result", {})

    # -------------------------------------------------------------------
    # MemoryProvider interface
    # -------------------------------------------------------------------

    def ingest(self, documents: list[Document]) -> None:
        for doc in documents:
            scope = doc.user_id or "global"
            metadata: dict = {"doc_id": doc.id}
            if doc.timestamp:
                metadata["timestamp"] = doc.timestamp
            self._call_tool(
                "memory_store",
                {
                    "text": doc.content,
                    "scope": scope,
                    "metadata": metadata,
                },
            )

    def retrieve(
        self,
        query: str,
        k: int = 10,
        user_id: str | None = None,
        query_timestamp: str | None = None,
    ) -> tuple[list[Document], dict | None]:
        scope = user_id or "global"
        result = self._call_tool(
            "memory_recall",
            {"query": query, "scope": scope, "limit": k},
        )
        # MCP tools return their structured payload under structuredContent.
        structured = result.get("structuredContent") or {}
        rows = structured.get("results", []) if isinstance(structured, dict) else []
        docs: list[Document] = []
        for row in rows:
            md = row.get("metadata") if isinstance(row, dict) else None
            if isinstance(md, str):
                try:
                    md = json.loads(md)
                except Exception:
                    md = None
            doc_id = (md or {}).get("doc_id") or row.get("id", "")
            docs.append(
                Document(
                    id=str(doc_id),
                    content=row.get("text", ""),
                    user_id=row.get("scope"),
                )
            )
        return docs, result
