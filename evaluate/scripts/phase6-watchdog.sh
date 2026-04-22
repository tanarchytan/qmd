#!/usr/bin/env bash
# Phase 6 watchdog — wraps phase6-queue.sh with a heartbeat so the agent
# can detect death every 2h and re-invoke cleanly.
#
# Heartbeat: `evaluate/logs/phase6-heartbeat.txt` is updated every 60s with
# `<unix-ts> <status>`. Status is "ALIVE <pid>" while running, "DONE <rc>"
# on clean exit, "DIED <rc>" on non-zero exit.
#
# Resume safety: the underlying sweep-flags.sh detects an existing
# incomplete sweep dir with the same --name prefix and reuses it, and
# run_one_lme / run_one_locomo skip configs whose lme.json / locomo.json
# already exist and are non-partial. So a re-invocation after a crash
# picks up exactly where the previous run died, no redone configs.
#
# Usage:
#   bash evaluate/scripts/phase6-watchdog.sh           # fires queue, runs until done
#   bash evaluate/scripts/phase6-watchdog.sh --status  # prints heartbeat + exits
#
# Agent self-check: read heartbeat, compare to `date +%s`. Stale (>10 min
# gap) + no ALIVE status → queue died, re-invoke the watchdog.

set -uo pipefail
cd "$(dirname "$0")/../.."

HEARTBEAT=evaluate/logs/phase6-heartbeat.txt
DATE_TAG=$(date +%Y%m%d)
LOG=evaluate/logs/phase6-queue-${DATE_TAG}.log

mkdir -p "$(dirname "$LOG")"

# --status: dump current heartbeat + brief progress, exit
if [[ "${1:-}" == "--status" ]]; then
  if [[ -f "$HEARTBEAT" ]]; then
    hb=$(cat "$HEARTBEAT"); now=$(date +%s); hb_ts=${hb%% *}; hb_status=${hb#* }
    age=$((now - hb_ts))
    echo "heartbeat: $hb_status  (age ${age}s)"
  else
    echo "heartbeat: MISSING (watchdog never ran)"
  fi
  echo ""
  echo "sweep dirs with SUMMARY.md:"
  for d in evaluate/sweeps/*phase6*/SUMMARY.md; do
    [[ -f "$d" ]] && echo "  $(dirname $d | xargs basename) ✓"
  done
  echo ""
  echo "in-progress sweep configs (no lme.json yet):"
  for d in evaluate/sweeps/*phase6-lme-*/*/; do
    [[ -d "$d" ]] && [[ ! -f "$d/lme.json" ]] && echo "  $(basename $(dirname $d))/$(basename $d)"
  done
  exit 0
fi

# Single-instance guard: two watchdogs racing will spawn two phase6-queues
# and two parallel eval chains, which corrupts result files (same --tag,
# racing writes). Caught live 2026-04-21 when I fired the watchdog twice
# back-to-back and ended up with 16 eval.mts processes.
#
# NOTE: `kill -0 <pid>` doesn't work in Git Bash for processes outside the
# current MSYS session — returns "No such process" even when tasklist
# confirms the PID is alive. Use a Windows-aware check via tasklist.
is_pid_alive() {
  local pid=$1
  [[ -z "$pid" ]] && return 1
  tasklist //FI "PID eq $pid" //NH 2>/dev/null | grep -q "$pid"
}

LOCKFILE=evaluate/logs/phase6-watchdog.lock
if [[ -f "$LOCKFILE" ]]; then
  OLD_PID=$(cat "$LOCKFILE" 2>/dev/null || echo "")
  if is_pid_alive "$OLD_PID"; then
    echo "[watchdog] another instance alive at pid $OLD_PID — exiting 0" >&2
    exit 0
  fi
  echo "[watchdog] stale lock at pid '$OLD_PID' — claiming" >&2
fi
echo $$ > "$LOCKFILE"
trap 'rm -f "$LOCKFILE"' EXIT

# Outer loop: self-heal up to MAX_RETRIES transient crashes. If the queue
# exits 0 we're done; if non-zero, wait 30s and re-spawn — sweep-flags.sh
# resume logic means no redone configs, just picks up the first incomplete.
MAX_RETRIES=5
retries=0

while [[ $retries -lt $MAX_RETRIES ]]; do
  bash evaluate/scripts/phase6-queue.sh --skip-wait >> "$LOG" 2>&1 &
  QUEUE_PID=$!
  echo "[$(date -Is)] watchdog attempt $((retries+1))/$MAX_RETRIES — queue pid=$QUEUE_PID" >> "$LOG"

  # Heartbeat loop — write every 60s while queue alive
  while kill -0 "$QUEUE_PID" 2>/dev/null; do
    echo "$(date +%s) ALIVE pid=$QUEUE_PID attempt=$((retries+1))" > "$HEARTBEAT"
    sleep 60
  done

  wait "$QUEUE_PID" 2>/dev/null
  RC=$?
  if [[ $RC -eq 0 ]]; then
    echo "$(date +%s) DONE $RC" > "$HEARTBEAT"
    echo "[$(date -Is)] queue completed rc=$RC" >> "$LOG"
    exit 0
  fi

  retries=$((retries+1))
  echo "$(date +%s) RETRY rc=$RC attempt=$retries/$MAX_RETRIES" > "$HEARTBEAT"
  echo "[$(date -Is)] queue exited rc=$RC — retry $retries/$MAX_RETRIES in 30s" >> "$LOG"
  sleep 30
done

echo "$(date +%s) GAVE_UP rc=$RC after $MAX_RETRIES retries" > "$HEARTBEAT"
echo "[$(date -Is)] gave up after $MAX_RETRIES retries — check $LOG for root cause" >> "$LOG"
exit 1
