#!/usr/bin/env bash
# Lotl PreCompact Hook for Claude Code / OpenClaw
#
# Fires before context compaction. Always blocks — forces the agent
# to save EVERYTHING before losing context.
#
# Pattern from MemPalace. Zero extra tokens.
#
# Install in .claude/settings.local.json:
# {
#   "hooks": {
#     "PreCompact": [{
#       "hooks": [{"type": "command", "command": "/path/to/hooks/lotl_precompact_hook.sh", "timeout": 30}]
#     }]
#   }
# }

LOG_FILE="${HOME}/.config/lotl/hook_state/hook.log"
mkdir -p "$(dirname "$LOG_FILE")"

SESSION_ID="${CLAUDE_SESSION_ID:-${OPENCLAW_SESSION_KEY:-default}}"
echo "[$(date '+%H:%M:%S')] Session $SESSION_ID: PRECOMPACT — emergency save triggered" >> "$LOG_FILE"

echo '{"decision": "block", "reason": "Context compaction imminent — save everything now. Use memory_extract with the full conversation text to capture all topics, decisions, preferences, facts, and reflections before context is lost. Use knowledge_store for any entity relationships."}'
