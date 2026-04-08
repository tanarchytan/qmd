#!/usr/bin/env bash
# QMD Save Hook for Claude Code / OpenClaw
#
# Fires on the "Stop" event. Every SAVE_INTERVAL human messages,
# blocks the agent and asks it to save key topics/decisions/facts
# to QMD's memory system.
#
# Pattern from MemPalace. Zero extra tokens — the hook is a bash script.
# The agent does the actual extraction using memory_extract.
#
# Install in .claude/settings.local.json:
# {
#   "hooks": {
#     "Stop": [{
#       "matcher": "*",
#       "hooks": [{"type": "command", "command": "/path/to/hooks/qmd_save_hook.sh", "timeout": 30}]
#     }]
#   }
# }

SAVE_INTERVAL="${QMD_SAVE_INTERVAL:-15}"
STATE_DIR="${HOME}/.config/qmd/hook_state"
mkdir -p "$STATE_DIR"

# Get session ID from environment (Claude Code sets this)
SESSION_ID="${CLAUDE_SESSION_ID:-${OPENCLAW_SESSION_KEY:-default}}"
STATE_FILE="$STATE_DIR/${SESSION_ID}.json"
LOG_FILE="$STATE_DIR/hook.log"

# Read current state
if [ -f "$STATE_FILE" ]; then
  EXCHANGES=$(jq -r '.exchanges // 0' "$STATE_FILE" 2>/dev/null || echo "0")
  LAST_SAVE=$(jq -r '.last_save // 0' "$STATE_FILE" 2>/dev/null || echo "0")
  STOP_ACTIVE=$(jq -r '.stop_active // false' "$STATE_FILE" 2>/dev/null || echo "false")
else
  EXCHANGES=0
  LAST_SAVE=0
  STOP_ACTIVE="false"
fi

EXCHANGES=$((EXCHANGES + 1))
SINCE_SAVE=$((EXCHANGES - LAST_SAVE))

# Log
echo "[$(date '+%H:%M:%S')] Session $SESSION_ID: $EXCHANGES exchanges, $SINCE_SAVE since last save" >> "$LOG_FILE"

# If stop_active flag is set, we're returning from a save — let the agent through
if [ "$STOP_ACTIVE" = "true" ]; then
  echo '{"stop_active": false, "exchanges": '"$EXCHANGES"', "last_save": '"$EXCHANGES"'}' > "$STATE_FILE"
  echo '{}'
  exit 0
fi

# Check if it's time to save
if [ "$SINCE_SAVE" -ge "$SAVE_INTERVAL" ]; then
  echo "[$(date '+%H:%M:%S')] TRIGGERING SAVE at exchange $EXCHANGES" >> "$LOG_FILE"
  echo '{"stop_active": true, "exchanges": '"$EXCHANGES"', "last_save": '"$LAST_SAVE"'}' > "$STATE_FILE"
  echo '{"decision": "block", "reason": "Time to save your learnings. Use memory_extract to capture key topics, decisions, preferences, and facts from our conversation so far. Then use knowledge_store for any entity relationships worth tracking."}'
  exit 0
fi

# Not time yet — update state and let through
echo '{"stop_active": false, "exchanges": '"$EXCHANGES"', "last_save": '"$LAST_SAVE"'}' > "$STATE_FILE"
echo '{}'
