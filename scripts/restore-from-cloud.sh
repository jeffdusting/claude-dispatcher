#!/usr/bin/env bash
# restore-from-cloud.sh — Phase F failover restore from R2.
#
# Pulls the freshest age-encrypted snapshot from R2, decrypts it, validates
# it, and either writes the contents into the target STATE_DIR (real
# restore) or reports what would be written (`--dry-run`). Designed for
# two callers: the operator-driven failover sequence
# (`failover-up.sh`), and the Phase F.3 dry-run drill which exercises the
# pull/decrypt/extract path without touching production state.
#
# Source of truth for credentials is 1Password via the operator's signed-in
# desktop session. Phase F.4 adds Keychain fallback (`op-or-keychain.sh`)
# so this script continues to function during a 1Password outage.
#
# Behaviour:
#   - Default target is the dispatcher's STATE_DIR
#     (`$DISPATCHER_DIR/state`); override via `--target=<dir>`.
#   - Refuses to overwrite a non-empty target unless `--force` is given.
#     The default reflects the failover-procedure expectation that the
#     spare's local state is stale and must be replaced wholesale.
#   - `--dry-run` extracts to a scratch dir, validates, prints summary,
#     and exits 0 without touching the target.
#   - `--key=<key>` pins to a specific snapshot (default: latest by
#     lexicographic sort, which matches the `YYYY/MM/DD/HH-MM-SS.tar.age`
#     key shape).
#   - Heartbeat record at
#     `<workspace>/logs/restore-from-cloud/last-restore.json` records
#     each invocation (success or failure) for operator-side audit.
#
# Exit codes:
#   0 — restore (or dry-run) completed cleanly
#   1 — infrastructure failure (op outage, network, age decrypt)
#   2 — validation failed (missing projects/, JSON parse error, sanity floor)
#   3 — pre-flight refusal (target non-empty without --force)
#
# Usage:
#   restore-from-cloud.sh                                   # restore latest into STATE_DIR
#   restore-from-cloud.sh --dry-run                         # validate-only against scratch
#   restore-from-cloud.sh --target=/tmp/restore-test        # restore into an alternate dir
#   restore-from-cloud.sh --key=state/2026/04/29/00-01-30.tar.age  # pin to a key
#   restore-from-cloud.sh --force                           # overwrite non-empty STATE_DIR
#
# Australian spelling throughout. set -u catches unset env vars; pipefail
# catches mid-pipeline failures (the age | tar pipeline being the obvious
# one).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$DISPATCHER_DIR/.." && pwd)"

DEFAULT_TARGET="$DISPATCHER_DIR/state"
HEARTBEAT_DIR="${HEARTBEAT_DIR:-$WORKSPACE_DIR/logs/restore-from-cloud}"
HEARTBEAT_FILE="$HEARTBEAT_DIR/last-restore.json"
SCRATCH_BASE="${SCRATCH_BASE:-/tmp/river-restore}"

R2_BUCKET="${R2_BUCKET:-cos-backups}"
BACKUP_KEY_PREFIX="${BACKUP_KEY_PREFIX:-state}"

LOG_TAG="[restore-from-cloud]"
TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# ─── Flag parsing ─────────────────────────────────────────────────

DRY_RUN=false
FORCE=false
TARGET="$DEFAULT_TARGET"
PINNED_KEY=""

print_usage() {
  sed -n '1,/^set -euo pipefail$/p' "$0" | grep '^#' | sed 's/^# \?//'
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)        DRY_RUN=true ;;
    --force)          FORCE=true ;;
    --target=*)       TARGET="${arg#--target=}" ;;
    --key=*)          PINNED_KEY="${arg#--key=}" ;;
    --help|-h)        print_usage; exit 0 ;;
    *)
      echo "$LOG_TAG unknown argument: $arg" >&2
      echo "$LOG_TAG usage: $(basename "$0") [--dry-run] [--target=<dir>] [--key=<key>] [--force]" >&2
      exit 1
      ;;
  esac
done

mkdir -p "$HEARTBEAT_DIR"

# ─── Helpers ──────────────────────────────────────────────────────

log() {
  printf '%s %s %s\n' "$LOG_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

write_heartbeat() {
  local status="$1"
  local key="${2:-}"
  local detail="${3:-}"
  local size_bytes="${4:-0}"
  local json_count="${5:-0}"
  local exit_code="${6:-0}"
  local mode
  if [ "$DRY_RUN" = true ]; then mode="dry-run"; else mode="restore"; fi
  jq -n \
    --arg ts_start "$TS_START" \
    --arg ts_end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status" \
    --arg mode "$mode" \
    --arg target "$TARGET" \
    --arg key "$key" \
    --arg detail "$detail" \
    --argjson size_bytes "$size_bytes" \
    --argjson json_count "$json_count" \
    --argjson exit_code "$exit_code" \
    '{startedAt:$ts_start,finishedAt:$ts_end,status:$status,mode:$mode,target:$target,snapshotKey:$key,detail:$detail,cipherBytes:$size_bytes,jsonFilesValidated:$json_count,exitCode:$exit_code}' \
    > "$HEARTBEAT_FILE.tmp"
  mv "$HEARTBEAT_FILE.tmp" "$HEARTBEAT_FILE"
}

fail() {
  local exit_code="$1"; shift
  local detail="$*"
  log "FATAL: $detail"
  write_heartbeat "fail" "${LATEST_KEY:-}" "$detail" 0 0 "$exit_code"
  exit "$exit_code"
}

SCRATCH_DIR=""
trap 'if [ -n "$SCRATCH_DIR" ] && [ -d "$SCRATCH_DIR" ]; then rm -rf "$SCRATCH_DIR"; fi' EXIT

# ─── 1. Tooling pre-flight ───────────────────────────────────────

for bin in op age rclone jq tar rsync; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail 1 "missing required binary: $bin"
  fi
done

# ─── 2. Target pre-flight ────────────────────────────────────────

if [ "$DRY_RUN" = false ]; then
  if [ -d "$TARGET" ] && [ -n "$(ls -A "$TARGET" 2>/dev/null || true)" ]; then
    if [ "$FORCE" = false ]; then
      log "target $TARGET is non-empty; pass --force to overwrite"
      write_heartbeat "fail" "" "target non-empty without --force" 0 0 3
      exit 3
    fi
    log "target $TARGET is non-empty; --force given, will overwrite"
  fi
  mkdir -p "$TARGET"
fi

# ─── 3. Resolve credentials via op-or-keychain (F.4) ─────────────

OPKC="$SCRIPT_DIR/op-or-keychain.sh"

PRIV_KEY=$("$OPKC" read "op://CoS-Dispatcher/backup-age-key/credential" 2>&1) \
  || fail 1 "op-or-keychain backup-age-key/credential failed: $PRIV_KEY"

R2_AK=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/access-key-id" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/access-key-id failed: $R2_AK"

R2_SK=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/secret-access-key failed: $R2_SK"

R2_EP=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/endpoint" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/endpoint failed: $R2_EP"

export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_AK"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SK"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_EP"
export RCLONE_CONFIG_R2_REGION=auto

# ─── 4. Locate the snapshot ──────────────────────────────────────

if [ -n "$PINNED_KEY" ]; then
  LATEST_KEY="$PINNED_KEY"
  log "pinned snapshot: $LATEST_KEY"
else
  log "listing r2:${R2_BUCKET}/${BACKUP_KEY_PREFIX}/"
  LATEST=$(rclone lsf "r2:${R2_BUCKET}/${BACKUP_KEY_PREFIX}/" \
             --recursive --files-only --format=p \
             2>/dev/null \
           | grep -E '\.tar\.age$' \
           | sort \
           | tail -n 1) \
    || fail 1 "rclone lsf failed listing r2:${R2_BUCKET}/${BACKUP_KEY_PREFIX}/"

  if [ -z "$LATEST" ]; then
    fail 1 "no .tar.age objects under r2:${R2_BUCKET}/${BACKUP_KEY_PREFIX}/"
  fi

  LATEST_KEY="${BACKUP_KEY_PREFIX}/${LATEST}"
  log "latest snapshot: $LATEST_KEY"
fi

# ─── 5. Fetch into a scratch dir ─────────────────────────────────

SCRATCH_DIR="$SCRATCH_BASE/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$SCRATCH_DIR/extract"
chmod 700 "$SCRATCH_BASE" "$SCRATCH_DIR"

CIPHER_PATH="$SCRATCH_DIR/snapshot.tar.age"
rclone copyto "r2:${R2_BUCKET}/${LATEST_KEY}" "$CIPHER_PATH" --quiet \
  || fail 1 "rclone copyto failed for $LATEST_KEY"

CIPHER_BYTES=$(stat -f%z "$CIPHER_PATH" 2>/dev/null || stat -c%s "$CIPHER_PATH")
log "fetched $CIPHER_BYTES bytes"

# ─── 6. Decrypt + extract ────────────────────────────────────────

if ! age -d -i <(printf '%s\n' "$PRIV_KEY") "$CIPHER_PATH" \
     | tar -xf - -C "$SCRATCH_DIR/extract"; then
  fail 1 "age decrypt or tar extract failed for $LATEST_KEY"
fi
unset PRIV_KEY

# ─── 7. Validate structure ───────────────────────────────────────

if [ ! -d "$SCRATCH_DIR/extract/projects" ]; then
  fail 2 "extracted tree missing projects/ — tar root is unexpected"
fi

JSON_COUNT=$(find "$SCRATCH_DIR/extract" -type f -name '*.json' | wc -l | tr -d ' ')
if [ "$JSON_COUNT" -lt 1 ]; then
  fail 2 "extracted tree has zero JSON files"
fi

TOTAL_FILES=$(find "$SCRATCH_DIR/extract" -type f | wc -l | tr -d ' ')
if [ "$TOTAL_FILES" -lt 10 ]; then
  fail 2 "extracted tree has only $TOTAL_FILES files — sanity floor is 10"
fi

PARSE_FAILS=0
while IFS= read -r f; do
  if ! jq empty "$f" >/dev/null 2>&1; then
    PARSE_FAILS=$((PARSE_FAILS + 1))
    log "json parse failed: ${f#$SCRATCH_DIR/extract/}"
  fi
done < <(find "$SCRATCH_DIR/extract" -type f -name '*.json')

if [ "$PARSE_FAILS" -gt 0 ]; then
  fail 2 "$PARSE_FAILS JSON file(s) failed to parse"
fi

log "validated $LATEST_KEY ($JSON_COUNT JSON files, $TOTAL_FILES total)"

# ─── 8. Apply (or report) ────────────────────────────────────────

if [ "$DRY_RUN" = true ]; then
  log "dry-run: skipping write into $TARGET"
  log "summary: would rsync from $SCRATCH_DIR/extract/ to $TARGET/ (--delete)"
else
  log "writing into $TARGET (--delete)"
  rsync -a --delete "$SCRATCH_DIR/extract/" "$TARGET/" \
    || fail 1 "rsync failed writing $TARGET"
  log "ok: restored $LATEST_KEY into $TARGET"
fi

write_heartbeat "ok" "$LATEST_KEY" "" "$CIPHER_BYTES" "$JSON_COUNT" 0
