#!/bin/bash
# ============================================
# Script: start.sh
# Purpose: Production startup for the Generic Dispatcher
#          Auto-restarts on crash with backoff
# ============================================
# Usage:
#   ./start.sh               # Run in foreground
#   ./start.sh --tmux         # Launch in a tmux session
#   ./start.sh --stop         # Stop the tmux session
# ============================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TMUX_SESSION="generic-dispatcher"
LOG_DIR="$SCRIPT_DIR/../logs"
PID_FILE="$SCRIPT_DIR/state/dispatcher.pid"
MAX_RESTARTS=10
RESTART_WINDOW=600  # 10 minutes
INITIAL_BACKOFF=2
MAX_BACKOFF=60

mkdir -p "$LOG_DIR" "$SCRIPT_DIR/state"

# ─── Commands ──────────────────────────────────────────────────

if [[ "${1:-}" == "--tmux" ]]; then
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    echo "Session '$TMUX_SESSION' already running. Use --stop first."
    exit 1
  fi
  tmux new-session -d -s "$TMUX_SESSION" "$SCRIPT_DIR/start.sh"
  echo "Started in tmux session '$TMUX_SESSION'"
  echo "  Attach: tmux attach -t $TMUX_SESSION"
  echo "  Stop:   $SCRIPT_DIR/start.sh --stop"
  exit 0
fi

if [[ "${1:-}" == "--stop" ]]; then
  if tmux has-session -t "$TMUX_SESSION" 2>/dev/null; then
    tmux send-keys -t "$TMUX_SESSION" C-c
    sleep 2
    tmux kill-session -t "$TMUX_SESSION" 2>/dev/null || true
    echo "Stopped '$TMUX_SESSION'"
  else
    echo "No session '$TMUX_SESSION' running"
  fi
  # Also kill by PID if lingering
  if [[ -f "$PID_FILE" ]]; then
    PID=$(cat "$PID_FILE")
    kill "$PID" 2>/dev/null && echo "Killed PID $PID" || true
    rm -f "$PID_FILE"
  fi
  exit 0
fi

# ─── Restart Loop ──────────────────────────────────────────────

restart_count=0
window_start=$(date +%s)
backoff=$INITIAL_BACKOFF

while true; do
  now=$(date +%s)

  # Reset counter if outside the restart window
  if (( now - window_start > RESTART_WINDOW )); then
    restart_count=0
    window_start=$now
    backoff=$INITIAL_BACKOFF
  fi

  # Check if too many restarts
  if (( restart_count >= MAX_RESTARTS )); then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Too many restarts ($MAX_RESTARTS in ${RESTART_WINDOW}s). Giving up." | tee -a "$LOG_DIR/dispatcher.log"
    exit 1
  fi

  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Starting dispatcher (attempt $((restart_count + 1)))..." | tee -a "$LOG_DIR/dispatcher.log"

  # Run the dispatcher
  cd "$SCRIPT_DIR"
  bun run src/index.ts &
  CHILD_PID=$!
  echo "$CHILD_PID" > "$PID_FILE"

  # Wait for it to exit
  wait $CHILD_PID
  EXIT_CODE=$?

  rm -f "$PID_FILE"

  # Clean exit (SIGTERM/SIGINT) — don't restart
  if [[ $EXIT_CODE -eq 0 || $EXIT_CODE -eq 130 || $EXIT_CODE -eq 143 ]]; then
    echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Dispatcher exited cleanly (code $EXIT_CODE)." | tee -a "$LOG_DIR/dispatcher.log"
    exit 0
  fi

  restart_count=$((restart_count + 1))
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Dispatcher crashed (code $EXIT_CODE). Restarting in ${backoff}s..." | tee -a "$LOG_DIR/dispatcher.log"

  sleep $backoff
  backoff=$((backoff * 2))
  if (( backoff > MAX_BACKOFF )); then
    backoff=$MAX_BACKOFF
  fi
done
