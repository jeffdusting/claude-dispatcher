#!/usr/bin/env bash
# promote-to-primary.sh — Promote this machine to primary dispatcher.
#
# Run when the Fly cloud machine is confirmed down. Promotes the spare
# (desktop or laptop) by:
#   1. Verifying this machine is currently in spare mode.
#   2. Confirming the cloud is actually down (refuses if cloud is up, unless --force).
#   3. Pulling the freshest state snapshot from R2.
#   4. Fetching the production Discord token from 1Password.
#   5. Setting DISPATCHER_ROLE=primary in ~/.zshrc.
#   6. Restarting the dispatcher.
#   7. Verifying the health endpoint returns 200.
#
# --demote runs the reverse path:
#   Pushes accumulated state to R2, stops the dispatcher, clears the Discord
#   token, restores DISPATCHER_ROLE=spare in ~/.zshrc, and re-enables the
#   state-pull cron.
#
# Usage:
#   promote-to-primary.sh [--force]         # promote spare → primary
#   promote-to-primary.sh --demote          # demote primary → spare
#   promote-to-primary.sh --demote --force  # demote even if cloud appears down
#   promote-to-primary.sh --help
#
# Config (set in environment or edit defaults below):
#   FLY_APP         — Fly app name (default: dispatcher-cos)
#   R2_BUCKET       — Cloudflare R2 bucket name
#   R2_ENDPOINT     — R2 endpoint URL
#   HEALTHCHECK_PORT — local health server port (default: 3000)
#   OP_DISCORD_TOKEN_REF — 1Password secret reference for the Discord bot token
#   DISCORD_ENV_FILE — path to the Discord .env file (default: ~/.claude/channels/discord/.env)
#   ZSHRC           — shell init file to update (default: ~/.zshrc)
#   STATE_PULL_CRON — cron line to restore on demote (see INSTALL CRON below)

set -euo pipefail

# ─── Defaults ─────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$SCRIPT_DIR/.."
STATE_DIR="$DISPATCHER_DIR/state"
LOG_DIR="$(dirname "$DISPATCHER_DIR")/logs"
PID_FILE="$DISPATCHER_DIR/state/dispatcher.pid"

FLY_APP="${FLY_APP:-dispatcher-cos}"
HEALTHCHECK_PORT="${HEALTHCHECK_PORT:-3000}"
OP_DISCORD_TOKEN_REF="${OP_DISCORD_TOKEN_REF:-op://Private/CoS Cloud Discord Bot/token}"
DISCORD_ENV_FILE="${DISCORD_ENV_FILE:-$HOME/.claude/channels/discord/.env}"
ZSHRC="${ZSHRC:-$HOME/.zshrc}"
STATE_PULL_SCRIPT="$SCRIPT_DIR/state-pull.sh"
STATE_PUSH_SCRIPT="$SCRIPT_DIR/state-push.sh"

# Cron entry for the spare state-pull (15 min cadence). Restored on demote.
STATE_PULL_CRON="*/15 * * * * $STATE_PULL_SCRIPT >> $LOG_DIR/state-pull.log 2>&1"

# ─── Flags ────────────────────────────────────────────────────────

DEMOTE=false
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --demote) DEMOTE=true ;;
    --force)  FORCE=true ;;
    --help|-h)
      sed -n '1,/^# Config/p' "$0" | grep '^#' | sed 's/^# \?//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      echo "Usage: $0 [--force] | --demote [--force] | --help" >&2
      exit 1
      ;;
  esac
done

# ─── Helpers ──────────────────────────────────────────────────────

log() { echo "[$(date -u +%H:%M:%SZ)] $*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
confirm() {
  local msg="$1"
  printf "%s [y/N] " "$msg"
  read -r answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

# Returns the current DISPATCHER_ROLE from the live environment (exported)
# or by grepping ~/.zshrc. Prefers the live value since we may have already sourced.
current_role() {
  echo "${DISPATCHER_ROLE:-$(grep -oP 'DISPATCHER_ROLE=\K\w+' "$ZSHRC" 2>/dev/null | tail -1 || echo 'primary')}"
}

# Update DISPATCHER_ROLE=<old> → DISPATCHER_ROLE=<new> in ZSHRC.
update_role_in_zshrc() {
  local new_role="$1"
  if grep -q 'DISPATCHER_ROLE=' "$ZSHRC"; then
    # Replace existing line
    sed -i.bak "s/export DISPATCHER_ROLE=.*/export DISPATCHER_ROLE=$new_role/" "$ZSHRC"
    log "Updated DISPATCHER_ROLE=$new_role in $ZSHRC (backup: $ZSHRC.bak)"
  else
    # Append if missing
    echo "" >> "$ZSHRC"
    echo "export DISPATCHER_ROLE=$new_role" >> "$ZSHRC"
    log "Appended DISPATCHER_ROLE=$new_role to $ZSHRC"
  fi
}

# Stop the dispatcher gracefully (SIGTERM → SIGKILL after timeout).
stop_dispatcher() {
  local pid=""

  if [[ -f "$PID_FILE" ]]; then
    pid=$(cat "$PID_FILE" 2>/dev/null || true)
  fi

  # Also try pkill as a fallback
  if [[ -z "$pid" ]]; then
    pid=$(pgrep -f "bun run src/index.ts" | head -1 || true)
  fi

  if [[ -z "$pid" ]]; then
    log "No running dispatcher found (already stopped)"
    return 0
  fi

  log "Sending SIGTERM to PID $pid..."
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while kill -0 "$pid" 2>/dev/null; do
    sleep 1
    ((waited++))
    if (( waited >= 10 )); then
      log "Grace period elapsed — sending SIGKILL to PID $pid"
      kill -KILL "$pid" 2>/dev/null || true
      break
    fi
  done

  rm -f "$PID_FILE"
  log "Dispatcher stopped"
}

# Start the dispatcher in the background tmux session.
start_dispatcher() {
  cd "$DISPATCHER_DIR/.."
  if tmux has-session -t generic-dispatcher 2>/dev/null; then
    log "Killing stale tmux session..."
    tmux kill-session -t generic-dispatcher 2>/dev/null || true
    sleep 1
  fi
  "$DISPATCHER_DIR/start.sh" --tmux
  log "Dispatcher started in tmux session 'generic-dispatcher'"
}

# Push current state to R2 (used during demotion to hand state back to cloud).
push_state_to_r2() {
  if [[ -z "${R2_BUCKET:-}" || -z "${R2_ENDPOINT:-}" ]]; then
    log "WARNING: R2_BUCKET or R2_ENDPOINT not set — skipping state push to R2"
    log "  Export R2_BUCKET and R2_ENDPOINT before running, or push manually:"
    log "  $STATE_PUSH_SCRIPT"
    return 0
  fi
  log "Pushing state to R2..."
  DISPATCHER_ROLE=primary "$STATE_PUSH_SCRIPT"
}

# Pull freshest state from R2 (used during promotion).
pull_state_from_r2() {
  if [[ -z "${R2_BUCKET:-}" || -z "${R2_ENDPOINT:-}" ]]; then
    log "WARNING: R2_BUCKET or R2_ENDPOINT not set — skipping state pull from R2"
    log "  Export R2_BUCKET and R2_ENDPOINT and run: $STATE_PULL_SCRIPT"
    return 0
  fi
  log "Pulling freshest state from R2..."
  DISPATCHER_ROLE=spare "$STATE_PULL_SCRIPT"
}

# Check whether the Fly cloud machine is currently responding.
# Returns 0 (cloud is UP) or 1 (cloud is DOWN).
check_cloud_health() {
  if ! command -v fly &>/dev/null; then
    log "fly CLI not found — cannot verify cloud health; use --force to override"
    return 1
  fi
  local status
  status=$(fly status --app "$FLY_APP" 2>&1 || true)
  if echo "$status" | grep -q "started"; then
    return 0  # cloud appears UP
  fi
  return 1  # cloud appears DOWN
}

# Curl the local healthcheck and print the response.
check_local_health() {
  local url="http://localhost:$HEALTHCHECK_PORT/health"
  local response
  response=$(curl -sf --max-time 5 "$url" 2>/dev/null || true)
  if [[ -n "$response" ]]; then
    log "Health check OK: $response"
    return 0
  fi
  return 1
}

# ─── Promote ──────────────────────────────────────────────────────

do_promote() {
  log "=== PROMOTE: spare → primary ==="

  # 1. Verify currently spare
  local role
  role=$(current_role)
  if [[ "$role" != "spare" ]]; then
    if [[ "$FORCE" == "true" ]]; then
      log "WARNING: current role is '$role' (not spare) — continuing due to --force"
    else
      die "Current DISPATCHER_ROLE='$role'. Only run promote on a spare machine. Use --force to override."
    fi
  fi
  log "Current role: $role"

  # 2. Sanity check: confirm cloud is actually down
  log "Checking cloud health (fly status --app $FLY_APP)..."
  if check_cloud_health; then
    if [[ "$FORCE" == "true" ]]; then
      log "WARNING: cloud appears to be UP — proceeding anyway due to --force"
      log "WARNING: Two active primaries will cause split-brain Discord connection!"
      confirm "Are you sure you want to proceed?" || { log "Aborted."; exit 1; }
    else
      die "Cloud machine appears to be UP. Do not promote while cloud is healthy.\n       Use --force if you are certain the cloud is down and fly status is wrong."
    fi
  else
    log "Cloud appears to be down — safe to promote"
  fi

  # 3. Stop the spare sync cron
  log "Removing state-pull cron entry..."
  crontab -l 2>/dev/null | grep -v "state-pull" | crontab - 2>/dev/null || true
  log "State-pull cron removed"

  # 4. Pull freshest state snapshot from R2
  pull_state_from_r2

  # 5. Fetch production Discord token from 1Password
  log "Fetching Discord token from 1Password ($OP_DISCORD_TOKEN_REF)..."
  if command -v op &>/dev/null; then
    local token
    token=$(op read "$OP_DISCORD_TOKEN_REF" 2>/dev/null || true)
    if [[ -n "$token" ]]; then
      mkdir -p "$(dirname "$DISCORD_ENV_FILE")"
      printf 'DISCORD_BOT_TOKEN=%s\n' "$token" > "$DISCORD_ENV_FILE"
      log "Discord token written to $DISCORD_ENV_FILE"
    else
      die "Failed to read Discord token from 1Password. Check OP_DISCORD_TOKEN_REF and that you are signed in (op signin)."
    fi
  else
    die "op CLI not found. Install 1Password CLI and sign in, then retry.\n       Or manually write DISCORD_BOT_TOKEN=<token> to $DISCORD_ENV_FILE and re-run with --force."
  fi

  # 6. Set DISPATCHER_ROLE=primary in ~/.zshrc
  update_role_in_zshrc "primary"

  # 7. Export in current shell so the restarted process sees it
  export DISPATCHER_ROLE=primary

  # 8. Restart dispatcher
  stop_dispatcher
  sleep 1
  start_dispatcher

  # 9. Wait for health endpoint to come up
  log "Waiting for health endpoint (up to 30s)..."
  local attempts=0
  until check_local_health || (( ++attempts >= 30 )); do
    sleep 1
  done

  if (( attempts >= 30 )); then
    log "WARNING: health endpoint did not respond within 30s"
    log "  Check: tail -f $LOG_DIR/dispatcher.log"
    log "  Or:    tmux attach -t generic-dispatcher"
  fi

  echo ""
  log "=== PROMOTION COMPLETE ==="
  log "  Role: primary"
  log "  Dispatcher: running (tmux attach -t generic-dispatcher)"
  log "  Discord: bot should appear online within ~30s"
  log "  Verify: curl http://localhost:$HEALTHCHECK_PORT/health"
  echo ""
  log "  To demote back after cloud recovers:"
  log "    $0 --demote"
}

# ─── Demote ───────────────────────────────────────────────────────

do_demote() {
  log "=== DEMOTE: primary → spare ==="

  # 1. Verify currently primary
  local role
  role=$(current_role)
  if [[ "$role" != "primary" ]]; then
    if [[ "$FORCE" == "true" ]]; then
      log "WARNING: current role is '$role' (not primary) — continuing due to --force"
    else
      die "Current DISPATCHER_ROLE='$role'. Only run --demote on the active primary. Use --force to override."
    fi
  fi
  log "Current role: $role"

  # 2. Verify cloud is actually back up before demoting
  if [[ "$FORCE" != "true" ]]; then
    log "Checking cloud health (fly status --app $FLY_APP)..."
    if ! check_cloud_health; then
      die "Cloud machine does not appear to be up. Demote only when cloud is confirmed healthy.\n       Use --force to override."
    fi
    log "Cloud is up — safe to demote"
  fi

  # 3. Push accumulated state to R2 so cloud can import it
  push_state_to_r2

  # 4. Stop the dispatcher
  stop_dispatcher

  # 5. Clear the production Discord token from this machine
  log "Clearing Discord token from $DISCORD_ENV_FILE..."
  if [[ -f "$DISCORD_ENV_FILE" ]]; then
    printf 'DISCORD_BOT_TOKEN=\n' > "$DISCORD_ENV_FILE"
    log "Discord token cleared (file kept with empty value)"
  fi

  # 6. Set DISPATCHER_ROLE=spare in ~/.zshrc
  update_role_in_zshrc "spare"
  export DISPATCHER_ROLE=spare

  # 7. Re-enable state-pull cron
  log "Re-enabling state-pull cron (*/15 * * * *)..."
  local current_crontab
  current_crontab=$(crontab -l 2>/dev/null || true)
  if echo "$current_crontab" | grep -q "state-pull"; then
    log "state-pull cron already present — skipping"
  else
    (echo "$current_crontab"; echo "$STATE_PULL_CRON") | crontab -
    log "state-pull cron added"
  fi

  echo ""
  log "=== DEMOTION COMPLETE ==="
  log "  Role: spare"
  log "  Dispatcher: stopped"
  log "  Discord token: cleared"
  log "  State-pull cron: enabled (*/15 * * * *)"
  echo ""
  log "  The cloud machine is now the active primary."
  log "  This machine will sync state from R2 every 15 minutes."
  log "  To restart the spare dispatcher (optional):"
  log "    cd $(dirname "$DISPATCHER_DIR") && $DISPATCHER_DIR/start.sh --tmux"
}

# ─── Main ─────────────────────────────────────────────────────────

if [[ "$DEMOTE" == "true" ]]; then
  do_demote
else
  do_promote
fi
