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


# qmd's 2026-04-14 production winner (sr5 98.4% on LongMemEval _s n=500),
# matched against the env vars the native eval harness (evaluate/longmemeval/
# eval.mts) sets when running RAW retrieval-only benchmarks. Critically:
# the *INGEST_*=off and RECALL_RAW=on flags disable the LLM-based extraction
# / reflection / synthesis paths that fire by default and would try to reach
# a non-configured LLM (causing per-doc hangs of ~10s+).
#
# These env vars are forwarded to the qmd MCP subprocess unless overridden.
_DEFAULT_QMD_ENV: dict[str, str] = {
    # Embed backend (production winner)
    "QMD_EMBED_BACKEND": "transformers",
    "QMD_TRANSFORMERS_EMBED": "mixedbread-ai/mxbai-embed-xsmall-v1",
    "QMD_TRANSFORMERS_DTYPE": "q8",
    "QMD_VEC_MIN_SIM": "0.1",
    "QMD_TRANSFORMERS_QUIET": "on",
    # Disable LLM-based ingest paths — we're benching retrieval, not ingest.
    # Without these, qmd tries to extract facts / reflect / consolidate via
    # the configured remote LLM on every memory_store, hanging ~10s/doc.
    "QMD_INGEST_EXTRACTION": "off",
    "QMD_INGEST_REFLECTIONS": "off",
    "QMD_INGEST_SYNTHESIS": "off",
    "QMD_INGEST_PER_TURN": "off",
    # RAW recall mode: skip rerank, return cosine-sorted top-K directly.
    # We score sr5 ourselves so we don't want any additional reranker pass.
    "QMD_RECALL_RAW": "on",
    # Don't try to use ZeroEntropy as a remote collection store.
    "QMD_ZE_COLLECTIONS": "off",
}


def _find_free_port() -> int:
    """Pick an unused localhost port for the qmd MCP server."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _find_node_bin_dir() -> str | None:
    """Locate the directory containing `node` so we can add it to PATH.

    qmd's bin/qmd shell wrapper does `exec node …`. Python subprocess.Popen
    inherits the parent process env, which on nvm-managed systems does not
    include node's bin dir unless the parent shell sourced ~/.nvm/nvm.sh.
    Returns the directory containing the node binary, or None if not found.
    """
    # 1. Already on PATH? (system install or pre-sourced shell)
    found = shutil.which("node")
    if found:
        return os.path.dirname(found)
    # 2. nvm convention: $NVM_BIN points at <node version>/bin
    nvm_bin = os.environ.get("NVM_BIN")
    if nvm_bin and os.path.exists(os.path.join(nvm_bin, "node")):
        return nvm_bin
    # 3. Last resort: scan ~/.nvm/versions/node/*/bin for the latest
    home = os.path.expanduser("~")
    nvm_versions = os.path.join(home, ".nvm", "versions", "node")
    if os.path.isdir(nvm_versions):
        candidates = sorted(os.listdir(nvm_versions), reverse=True)
        for v in candidates:
            cand = os.path.join(nvm_versions, v, "bin")
            if os.path.exists(os.path.join(cand, "node")):
                return cand
    return None


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
        # MCP session state — populated by _handshake() on first tool call.
        self._session_id: str | None = None
        self._next_request_id: int = 0

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
        # qmd's bin/qmd shell wrapper does `exec node …`. The Python
        # subprocess inherits AMB's venv environment, which on nvm-managed
        # systems does not include node's bin dir. Prepend it so the wrapper
        # can find node.
        node_dir = _find_node_bin_dir()
        if node_dir:
            env["PATH"] = node_dir + os.pathsep + env.get("PATH", "")
        # Isolate qmd's SQLite index per provider instance so config sweeps
        # don't share the same db. qmd reads INDEX_PATH (src/store/path.ts:210)
        # — NOT the QMD_CACHE_DIR env var, which doesn't exist in qmd. Without
        # this, all 3 configs in a sweep would write to ~/.cache/qmd/index.sqlite
        # and the second + third configs would dedup against the first config's
        # rows, producing byte-identical results that mask the L1/cerank effect.
        env["INDEX_PATH"] = str(self._cache_dir / "index.sqlite")

        # Pipe qmd's stderr to a per-instance log file so we can debug
        # startup/runtime failures after the process exits. Writes go to
        # the cache dir and are cleaned up alongside it.
        stderr_log = open(self._cache_dir / "qmd-stderr.log", "wb")
        self._stderr_log = stderr_log
        self._proc = subprocess.Popen(
            [self._binary, "mcp", "--http", "--port", str(self._port)],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=stderr_log,
        )
        self._url = f"http://127.0.0.1:{self._port}"
        try:
            _wait_for_health(self._url, timeout_s=self._startup_timeout_s)
        except Exception as e:
            # Capture the qmd stderr tail so the caller knows WHY startup failed
            stderr_tail = ""
            try:
                with open(self._cache_dir / "qmd-stderr.log", "r") as f:
                    stderr_tail = f.read()[-1500:]
            except Exception:
                pass
            self.cleanup()
            raise RuntimeError(f"{e}\nqmd stderr (tail):\n{stderr_tail}")

    def cleanup(self) -> None:
        if self._proc is not None:
            try:
                self._proc.terminate()
                self._proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self._proc.kill()
            finally:
                self._proc = None
        if getattr(self, "_stderr_log", None) is not None:
            try: self._stderr_log.close()
            except Exception: pass
            self._stderr_log = None
        if self._cache_dir is not None and self._cache_dir.exists():
            shutil.rmtree(self._cache_dir, ignore_errors=True)
            self._cache_dir = None
        self._port = None
        self._url = None
        self._session_id = None
        self._next_request_id = 0

    def prepare(self, store_dir: Path, unit_ids: set[str] | None = None, reset: bool = True) -> None:
        # qmd's storage is managed by initialize() via QMD_CACHE_DIR; nothing
        # to do per-prepare beyond a no-op. AMB calls prepare() after
        # initialize() so we just confirm the server is up.
        if self._url is None:
            self.initialize()

    # -------------------------------------------------------------------
    # MCP HTTP transport — JSON-RPC over POST /mcp
    # -------------------------------------------------------------------
    # qmd uses MCP's StreamableHTTP transport. Sessions are mandatory:
    # the first call must be `initialize`, the server returns
    # `mcp-session-id` in the response headers, and every subsequent
    # JSON-RPC call must include that header. We hand-roll the handshake
    # here to avoid pulling the full mcp Python SDK as an AMB dependency.

    _MCP_PROTOCOL_VERSION = "2024-11-05"

    def _next_id(self) -> int:
        self._next_request_id += 1
        return self._next_request_id

    def _post_jsonrpc(self, body: dict, *, expect_response: bool = True) -> tuple[dict | None, dict[str, str]]:
        """POST a JSON-RPC envelope to /mcp and return (parsed_body, headers).

        Includes the MCP session header on every call after the handshake.
        StreamableHTTP requires the Accept header to advertise both JSON and SSE.
        """
        if self._url is None:
            raise RuntimeError("QmdMemoryProvider not initialized. Call initialize() first.")
        headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream",
        }
        if self._session_id is not None:
            headers["mcp-session-id"] = self._session_id
        r = requests.post(f"{self._url}/mcp", json=body, headers=headers, timeout=60)
        if r.status_code >= 400:
            raise RuntimeError(f"qmd MCP HTTP {r.status_code}: {r.text[:300]}")
        if not expect_response:
            return None, dict(r.headers)
        # StreamableHTTP can reply with either application/json (single
        # response) or text/event-stream (one or more SSE events). For
        # simple request/response we only need the first JSON payload.
        ctype = r.headers.get("content-type", "")
        if "text/event-stream" in ctype:
            # Parse the first `data: {...}` line out of the SSE stream.
            for line in r.text.splitlines():
                if line.startswith("data:"):
                    return json.loads(line[5:].strip()), dict(r.headers)
            raise RuntimeError(f"qmd MCP SSE response had no data lines: {r.text[:300]}")
        return r.json(), dict(r.headers)

    def _handshake(self) -> None:
        """Run the MCP initialize handshake and record the session id."""
        if self._session_id is not None:
            return
        init_body = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "initialize",
            "params": {
                "protocolVersion": self._MCP_PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": {"name": "amb-bench-qmd-adapter", "version": "0.1.0"},
            },
        }
        _, headers = self._post_jsonrpc(init_body)
        # Header names from requests are case-insensitive but we store the
        # mcp-session-id verbatim — qmd reads it back the same way.
        sid = headers.get("mcp-session-id") or headers.get("Mcp-Session-Id")
        if not sid:
            raise RuntimeError("qmd MCP handshake did not return mcp-session-id header")
        self._session_id = sid
        # Per MCP spec, send notifications/initialized after the initialize
        # response so the server knows the client is ready. This is a
        # notification (no `id` field, no expected response body).
        notify_body = {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        }
        self._post_jsonrpc(notify_body, expect_response=False)

    def _call_tool(self, tool: str, arguments: dict) -> dict:
        """Invoke an MCP tool over HTTP and return its parsed result payload."""
        if self._session_id is None:
            self._handshake()
        body = {
            "jsonrpc": "2.0",
            "id": self._next_id(),
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        }
        parsed, _ = self._post_jsonrpc(body)
        if parsed is None:
            raise RuntimeError(f"qmd MCP {tool} returned no body")
        if "error" in parsed:
            raise RuntimeError(f"qmd MCP error on {tool}: {parsed['error']}")
        return parsed.get("result", {})

    # -------------------------------------------------------------------
    # MemoryProvider interface
    # -------------------------------------------------------------------

    # Batch size for memory_store_batch calls. The qmd MCP tool batches the
    # embed call internally so larger batches are strictly faster on the embed
    # side, and the new bulk multi-VALUES insert path collapses N row inserts
    # into one SQL statement per table per batch. 128 is a good balance:
    # ~4x fewer roundtrips than 32 and JSON-RPC payloads stay reasonable
    # (~1 MB for 128 LME session texts).
    _INGEST_BATCH_SIZE = 128

    # Embedding dimension — used to pre-warm vec0 partitions before ingest.
    # mxbai-xs is 384d. Override via env if you swap embed model.
    _EMBED_DIMENSIONS = 384

    def _maybe_user_only(self, content: str) -> str:
        """L1 (user-turns-only) ingest filter. Both LME and LoCoMo serialize
        Document.content as `json.dumps(turns)`. When QMD_INGEST_USER_ONLY=on
        is set in env_overrides, parse the JSON, filter to turns with
        role == "user", re-serialize. Falls back to unmodified content if the
        parse fails or no role field is present (e.g. LoCoMo uses speaker_a/
        speaker_b not role, so filtering is a noop there)."""
        if self._env_overrides.get("QMD_INGEST_USER_ONLY") != "on":
            return content
        try:
            turns = json.loads(content)
            if not isinstance(turns, list):
                return content
            user_turns = [t for t in turns if isinstance(t, dict) and t.get("role") == "user"]
            if not user_turns:
                return content  # no role split → don't strip everything, keep as-is
            return json.dumps(user_turns)
        except (json.JSONDecodeError, TypeError):
            return content

    def ingest(self, documents: list[Document]) -> None:
        """Batched ingest via memory_store_batch + pre-warmed vec0 partitions.

        Three optimizations stack here, mirroring AMB hybrid_search's pattern:

        1. **Pre-warm vec0 partitions** via memory_register_scopes — eliminates
           the per-scope cold-allocation cost (~30-50ms each) from the per-batch
           insert path. Caller knows all scope keys upfront from doc.user_id.

        2. **Larger batches (128 vs 32)** — 4x fewer JSON-RPC roundtrips,
           lets transformers.js batch-encode 128 texts per forward pass.

        3. **Per-item flags**: skipHistory=True (no audit trail needed for
           bench), category="other" (skips the per-item regex classifier).

        L1 filtering (user-turns-only) is applied here because qmd's library
        memoryStore path doesn't read QMD_INGEST_USER_ONLY (that var is only
        honored by evaluate/longmemeval/eval.mts). Doing it in the adapter is
        the smallest-scope fix and lets us test L1 through AMB without
        changing qmd's library API.
        """
        # Pre-warm partitions for the full scope set in one tool call.
        # Idempotent — re-registering existing scopes is a no-op on the qmd side.
        unique_scopes = sorted({doc.user_id or "global" for doc in documents})
        try:
            self._call_tool(
                "memory_register_scopes",
                {"scopes": unique_scopes, "dimensions": self._EMBED_DIMENSIONS},
            )
        except Exception:
            # Older qmd builds without memory_register_scopes — fall through
            # to the per-batch cold-alloc path. Not fatal, just slower.
            pass

        for i in range(0, len(documents), self._INGEST_BATCH_SIZE):
            chunk = documents[i:i + self._INGEST_BATCH_SIZE]
            items = []
            for doc in chunk:
                metadata: dict = {"doc_id": doc.id}
                if doc.timestamp:
                    metadata["timestamp"] = doc.timestamp
                items.append({
                    "text": self._maybe_user_only(doc.content),
                    "scope": doc.user_id or "global",
                    "metadata": metadata,
                    # Bench doesn't need history tracking — skip the
                    # per-item memory_history INSERT.
                    "skipHistory": True,
                    # Skip the per-item classifier regex pass.
                    "category": "other",
                })
            self._call_tool("memory_store_batch", {"items": items})

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
