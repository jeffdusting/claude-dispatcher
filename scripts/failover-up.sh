#!/usr/bin/env bash
# failover-up.sh — Promote a warm spare to primary dispatcher.
#
# Replaces the v1-era promote-to-primary.sh. Aligned with the B.3 backup
# format (age-encrypted tar from R2) and the F.1 spare topology
# (laptop plist Disabled=true, restore script, age-key vault).
#
# Sequence (matches docs/warm-spare-failover.md §4):
#   1. Pre-flight — confirm the cloud is unreachable, OR `--force` for
#      a planned drill. Refuses by default if `flyctl checks list` shows
#      a passing check, since a spurious promotion creates split-brain
#      risk. The dispatcher has no public IP (Discord-bot-only surface),
#      so the flyctl check status is the authoritative signal — public
#      DNS will not resolve `cos-dispatcher.fly.dev` and a public-DNS
#      probe always fails regardless of cloud state.
#   2. Restore latest state from R2 into the laptop STATE_DIR via
#      restore-from-cloud.sh (--force because spare state is expected
#      non-empty post-verify-job activity).
#   3. Materialise Discord production token and access.json from
#      1Password into ~/.claude/channels/discord/ — skipped if both
#      already exist and --force is not set.
#   4. launchctl load -w the dispatcher plist (clears Disabled=true and
#      the launchd disabled-job DB entry).
#   5. Wait for /health to return ok within 60 seconds.
#   6. Optionally stop the flapping cloud machine via flyctl.
#
# `--dry-run` runs steps 1, 2 (in dry-run mode), 3 (report-only), and
# skips 4, 5, 6.
#
# Exit codes:
#   0 — promotion (or dry-run) completed cleanly
#   1 — infrastructure failure
#   2 — pre-flight refused (cloud appears up; pass --force)
#   3 — health verification timed out
#
# Usage:
#   failover-up.sh                    # genuine promotion (cloud is down)
#   failover-up.sh --force            # planned drill or known-stale cloud
#   failover-up.sh --dry-run          # exercises the path without changes
#   failover-up.sh --stop-cloud       # also stop the cloud machine
#
# Australian spelling throughout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$DISPATCHER_DIR/.." && pwd)"

FLY_APP="${FLY_APP:-cos-dispatcher}"
PLIST="${PLIST:-$HOME/Library/LaunchAgents/com.river.generic-dispatcher.plist}"
DISCORD_DIR="${DISCORD_DIR:-$HOME/.claude/channels/discord}"
HEALTH_PORT="${HEALTH_PORT:-3000}"
HEALTH_TIMEOUT_SECONDS="${HEALTH_TIMEOUT_SECONDS:-60}"

LOG_TAG="[failover-up]"
TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EVENT_DIR="${EVENT_DIR:-$WORKSPACE_DIR/logs/failover}"
EVENT_FILE="$EVENT_DIR/last-failover.json"

DRY_RUN=false
FORCE=false
STOP_CLOUD=false

print_usage() {
  sed -n '1,/^set -euo pipefail$/p' "$0" | grep '^#' | sed 's/^# \?//'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=true ;;
    --force)      FORCE=true ;;
    --stop-cloud) STOP_CLOUD=true ;;
    --help|-h)    print_usage; exit 0 ;;
    *)
      echo "$LOG_TAG unknown argument: $arg" >&2
      echo "$LOG_TAG usage: $(basename "$0") [--dry-run] [--force] [--stop-cloud]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$EVENT_DIR"

log() {
  printf '%s %s %s\n' "$LOG_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

write_event() {
  local status="$1"
  local detail="${2:-}"
  local exit_code="${3:-0}"
  local mode
  if [ "$DRY_RUN" = true ]; then mode="dry-run"; else mode="promote"; fi
  jq -n \
    --arg ts_start "$TS_START" \
    --arg ts_end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status" \
    --arg mode "$mode" \
    --arg detail "$detail" \
    --argjson exit_code "$exit_code" \
    '{startedAt:$ts_start,finishedAt:$ts_end,status:$status,mode:$mode,detail:$detail,exitCode:$exit_code}' \
    > "$EVENT_FILE.tmp"
  mv "$EVENT_FILE.tmp" "$EVENT_FILE"
}

fail() {
  local exit_code="$1"; shift
  local detail="$*"
  log "FATAL: $detail"
  write_event "fail" "$detail" "$exit_code"
  exit "$exit_code"
}

# ─── 1. Pre-flight ───────────────────────────────────────────────

log "step 1: pre-flight — checking flyctl status of $FLY_APP"

CLOUD_HEALTHY=false
if command -v flyctl >/dev/null 2>&1; then
  CHECK_STATUS=$(flyctl checks list -a "$FLY_APP" 2>/dev/null \
                 | awk 'NR>2 && $0 !~ /^─/ {print $3}' | head -n 1 || true)
  MACHINE_STATE=$(flyctl machines list -a "$FLY_APP" --json 2>/dev/null \
                 | jq -r '[.[] | select(.state=="started")] | length' 2>/dev/null || echo "0")
  log "flyctl checks first row status: ${CHECK_STATUS:-unknown}; started machines: $MACHINE_STATE"
  if [ "$CHECK_STATUS" = "passing" ] && [ "$MACHINE_STATE" -ge 1 ]; then
    CLOUD_HEALTHY=true
  fi
else
  log "WARN: flyctl not on PATH — cannot confirm cloud state; trust operator's --force decision"
fi

if [ "$CLOUD_HEALTHY" = true ] && [ "$FORCE" = false ]; then
  log "cloud passing check + started machine — refusing to promote without --force"
  log "if this is a planned drill or known-stale cloud, re-run with --force"
  write_event "refused" "cloud appears healthy; --force not given" 2
  exit 2
fi

if [ "$CLOUD_HEALTHY" = true ]; then
  log "cloud appears healthy but --force given; continuing"
else
  log "cloud unhealthy or unreachable — proceeding with promotion"
fi

# ─── 2. Restore state from R2 ────────────────────────────────────

log "step 2: restoring latest state from R2"

RESTORE_FLAGS=("--force")
if [ "$DRY_RUN" = true ]; then
  RESTORE_FLAGS+=("--dry-run")
fi

if ! "$SCRIPT_DIR/restore-from-cloud.sh" "${RESTORE_FLAGS[@]}"; then
  fail 1 "restore-from-cloud.sh failed (see $WORKSPACE_DIR/logs/restore-from-cloud/last-restore.json)"
fi

# ─── 3. Materialise Discord credentials ──────────────────────────

log "step 3: materialising Discord credentials into $DISCORD_DIR"

if [ "$DRY_RUN" = true ]; then
  log "dry-run: would write $DISCORD_DIR/.env and $DISCORD_DIR/access.json from 1Password"
else
  mkdir -p "$DISCORD_DIR"
  chmod 700 "$DISCORD_DIR"

  OPKC="$SCRIPT_DIR/op-or-keychain.sh"

  TOKEN=$("$OPKC" read "op://CoS-Dispatcher/discord-bot/credential" 2>&1) \
    || fail 1 "op-or-keychain discord-bot/credential failed: $TOKEN"

  printf 'DISCORD_BOT_TOKEN=%s\n' "$TOKEN" > "$DISCORD_DIR/.env.tmp"
  unset TOKEN
  chmod 600 "$DISCORD_DIR/.env.tmp"
  mv "$DISCORD_DIR/.env.tmp" "$DISCORD_DIR/.env"

  ACCESS=$("$OPKC" read "op://CoS-Dispatcher/discord-bot/access-config-json" 2>&1) \
    || fail 1 "op-or-keychain discord-bot/access-config-json failed: $ACCESS"

  printf '%s' "$ACCESS" > "$DISCORD_DIR/access.json.tmp"
  unset ACCESS
  chmod 600 "$DISCORD_DIR/access.json.tmp"
  mv "$DISCORD_DIR/access.json.tmp" "$DISCORD_DIR/access.json"

  log "wrote $DISCORD_DIR/.env (DISCORD_BOT_TOKEN) and $DISCORD_DIR/access.json"
fi

# ─── 4. Load the dispatcher plist ────────────────────────────────

log "step 4: loading $PLIST"

if [ ! -f "$PLIST" ]; then
  fail 1 "plist not found at $PLIST"
fi

if [ "$DRY_RUN" = true ]; then
  log "dry-run: skipping launchctl load -w"
else
  if ! launchctl load -w "$PLIST"; then
    fail 1 "launchctl load -w $PLIST failed"
  fi
  log "plist loaded; dispatcher should be starting"
fi

# ─── 5. Verify local /health ─────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  log "step 5: dry-run — skipping local /health verification"
else
  log "step 5: waiting up to ${HEALTH_TIMEOUT_SECONDS}s for local /health"

  ELAPSED=0
  HEALTH_OK=false
  while [ "$ELAPSED" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if curl -fsS --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/health" >/dev/null 2>&1; then
      HEALTH_OK=true
      break
    fi
    sleep 5
    ELAPSED=$((ELAPSED + 5))
  done

  if [ "$HEALTH_OK" = false ]; then
    fail 3 "local /health did not return ok within ${HEALTH_TIMEOUT_SECONDS}s"
  fi

  log "local /health ok (after ${ELAPSED}s)"

  AGGREGATE=$(curl -fsS --max-time 5 "http://127.0.0.1:${HEALTH_PORT}/health/integrations" 2>/dev/null | jq -r .aggregate 2>/dev/null || echo "")
  if [ "$AGGREGATE" != "ok" ]; then
    log "WARN: /health/integrations aggregate is '$AGGREGATE' (expected 'ok'); inspect by hand"
  else
    log "/health/integrations aggregate ok"
  fi
fi

# ─── 6. Optionally stop the cloud machine ────────────────────────

if [ "$STOP_CLOUD" = true ]; then
  log "step 6: stopping cloud machine"
  if [ "$DRY_RUN" = true ]; then
    log "dry-run: would run flyctl machine stop on every started machine in $FLY_APP"
  else
    if ! command -v flyctl >/dev/null 2>&1; then
      log "WARN: flyctl not on PATH; skip cloud stop and run by hand"
    else
      MACHINES=$(flyctl machines list -a "$FLY_APP" --json 2>/dev/null \
                 | jq -r '.[] | select(.state=="started") | .id' 2>/dev/null || true)
      if [ -z "$MACHINES" ]; then
        log "no started cloud machines to stop"
      else
        for mid in $MACHINES; do
          log "flyctl machine stop $mid -a $FLY_APP"
          flyctl machine stop "$mid" -a "$FLY_APP" || log "WARN: stop failed for $mid"
        done
      fi
    fi
  fi
else
  log "step 6: --stop-cloud not given; cloud machine left as-is"
fi

# ─── 7. Done ─────────────────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  log "dry-run complete — no changes applied"
else
  log "promotion complete — laptop is now primary"
fi

write_event "ok" "" 0
