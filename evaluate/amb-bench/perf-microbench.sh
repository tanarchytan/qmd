#!/bin/bash
# Quick perf microbenchmark for memoryStoreBatch.
# Spawns qmd MCP HTTP server, runs 3 batched ingests with timing.

set -e
# qmd's bin/qmd shell wrapper does `exec node …`. Source nvm to put node on PATH.
[ -s "$HOME/.nvm/nvm.sh" ] && source "$HOME/.nvm/nvm.sh"
export PATH="$HOME/.local/bin:$PATH"
export INDEX_PATH=/tmp/qmd-perftest.sqlite
rm -f /tmp/qmd-perftest.sqlite*
export QMD_EMBED_BACKEND=transformers
export QMD_TRANSFORMERS_EMBED=mixedbread-ai/mxbai-embed-xsmall-v1
export QMD_TRANSFORMERS_DTYPE=q8
export QMD_TRANSFORMERS_QUIET=on
export QMD_VEC_MIN_SIM=0.1
export QMD_INGEST_EXTRACTION=off
export QMD_INGEST_REFLECTIONS=off
export QMD_INGEST_SYNTHESIS=off
export QMD_INGEST_PER_TURN=off
export QMD_RECALL_RAW=on
export QMD_ZE_COLLECTIONS=off

~/qmd-baselines/qmd/bin/qmd mcp --http --port 9900 2>/tmp/qmd-perftest-stderr.log &
PID=$!
trap "kill $PID 2>/dev/null; wait $PID 2>/dev/null" EXIT
sleep 4

# Initialize MCP session
SID=$(curl -s -i -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"perftest","version":"1"}}}' \
  http://127.0.0.1:9900/mcp \
  | tr -d '\r' | awk -F': ' '/^mcp-session-id:/ {print $2}')
echo "session: $SID"

call_tool() {
  local label="$1"
  local payload_file="$2"
  echo "--- $label ---"
  /usr/bin/time -f "%e seconds" curl -s -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SID" \
    --data-binary "@$payload_file" \
    http://127.0.0.1:9900/mcp > /dev/null
}

SCOPES_50=$(python3 -c 'import json; print(json.dumps([f"scope{i}" for i in range(50)]))')
# Toy short text — 80 bytes
ITEMS_32_TOY=$(python3 -c 'import json; print(json.dumps([{"text":f"sample text {i} about programming and unit tests","scope":"scope0","category":"other","skipHistory":True} for i in range(32)]))')
# Realistic LME session text — pull a real ~10KB session from the dataset
ITEMS_32_REALISTIC=$(python3 << 'PYEOF'
import json
data = json.load(open('/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json'))
real_sessions = []
for q in data[:5]:
    for sess in q['haystack_sessions'][:7]:
        real_sessions.append(json.dumps(sess))
        if len(real_sessions) >= 32:
            break
    if len(real_sessions) >= 32:
        break
items = [{"text": real_sessions[i], "scope": "scope1", "category": "other", "skipHistory": True} for i in range(32)]
print(json.dumps(items))
PYEOF
)
ITEMS_128_REALISTIC=$(python3 << 'PYEOF'
import json
data = json.load(open('/home/tanarchy/qmd-eval/evaluate/longmemeval/longmemeval_s_cleaned.json'))
real_sessions = []
for q in data[:30]:
    for sess in q['haystack_sessions']:
        real_sessions.append(json.dumps(sess))
        if len(real_sessions) >= 128:
            break
    if len(real_sessions) >= 128:
        break
items = [{"text": real_sessions[i], "scope": f"scope{i%10+2}", "category": "other", "skipHistory": True} for i in range(128)]
print(json.dumps(items))
PYEOF
)
ITEMS_128_MIXED=$(python3 -c 'import json; print(json.dumps([{"text":f"another text {i} discussing topic {i%5}","scope":f"scope{i%10+2}","category":"other","skipHistory":True} for i in range(128)]))')

# Write payloads to files
mkdir -p /tmp/qmd-perf-payloads
echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_register_scopes\",\"arguments\":{\"scopes\":$SCOPES_50,\"dimensions\":384}}}" > /tmp/qmd-perf-payloads/prewarm.json
echo "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_store_batch\",\"arguments\":{\"items\":$ITEMS_32_TOY}}}" > /tmp/qmd-perf-payloads/toy32.json
echo "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_store_batch\",\"arguments\":{\"items\":$ITEMS_32_REALISTIC}}}" > /tmp/qmd-perf-payloads/real32.json
echo "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_store_batch\",\"arguments\":{\"items\":$ITEMS_128_REALISTIC}}}" > /tmp/qmd-perf-payloads/real128.json
echo "{\"jsonrpc\":\"2.0\",\"id\":6,\"method\":\"tools/call\",\"params\":{\"name\":\"memory_store_batch\",\"arguments\":{\"items\":$ITEMS_128_MIXED}}}" > /tmp/qmd-perf-payloads/toy128.json

call_tool "memory_register_scopes (50 scopes pre-warm)" /tmp/qmd-perf-payloads/prewarm.json
call_tool "memory_store_batch (32 TOY 80-byte texts)" /tmp/qmd-perf-payloads/toy32.json
call_tool "memory_store_batch (32 REAL LME sessions ~10KB each)" /tmp/qmd-perf-payloads/real32.json
call_tool "memory_store_batch (128 REAL LME sessions ~10KB each)" /tmp/qmd-perf-payloads/real128.json
call_tool "memory_store_batch (128 toy items — control)" /tmp/qmd-perf-payloads/toy128.json

echo "--- stderr tail ---"
tail -20 /tmp/qmd-perftest-stderr.log
