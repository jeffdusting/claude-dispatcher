#!/usr/bin/env bash
# spare-verify-backup.sh — Phase F warm-spare nightly backup verification.
#
# Pulls the latest age-encrypted snapshot from R2, decrypts to a scratch
# directory under /tmp, validates structure and JSON parsability, then
# deletes the scratch. Writes a heartbeat record to
# $SPARE_STATE_DIR/last-verify.json so the operator can confirm the spare
# is current without running the script by hand.
#
# Source of truth for credentials is 1Password via the operator's signed-in
# desktop session. Phase F.4 will add Keychain fallback (op-or-keychain.sh
# helper) so the verification continues to function during a 1Password
# outage. Until F.4 lands, an op outage produces a single FATAL log line
# and a non-zero exit — the launchd job fails noisily rather than silently.
#
# Exit codes:
#   0 — snapshot pulled, decrypted, and validated cleanly
#   1 — generic failure (op outage, network, age decrypt, tar extract)
#   2 — snapshot fetched but validation failed (missing projects/, bad JSON)
#
# Required (and resolved) at runtime:
#   op CLI installed and signed in (1Password 8 desktop session active)
#   age, rclone, jq installed and on PATH
#
# Schedule (laptop): nightly at 03:15 local via
#   ~/Library/LaunchAgents/com.river.spare-verify.plist
#
# Manual run (for diagnostics):
#   /Users/jeffdusting/claude-workspace/generic/dispatcher/scripts/spare-verify-backup.sh
#
# Australian spelling throughout. Set -u catches unset env vars; pipefail
# catches mid-pipeline failures (the age | tar pipeline is the obvious one).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$DISPATCHER_DIR/.." && pwd)"

# Heartbeat lives outside the dispatcher repo so it never accidentally lands
# in a commit. Default keeps it under the workspace logs/ dir alongside the
# launchd-stdout/stderr trail.
SPARE_STATE_DIR="${SPARE_STATE_DIR:-$WORKSPACE_DIR/logs/spare-verify}"
HEARTBEAT_FILE="$SPARE_STATE_DIR/last-verify.json"
SCRATCH_BASE="${SCRATCH_BASE:-/tmp/river-spare-verify}"

R2_BUCKET="${R2_BUCKET:-cos-backups}"
BACKUP_KEY_PREFIX="${BACKUP_KEY_PREFIX:-state}"

LOG_TAG="[spare-verify]"
TS_START="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

mkdir -p "$SPARE_STATE_DIR"

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
  jq -n \
    --arg ts_start "$TS_START" \
    --arg ts_end "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg status "$status" \
    --arg key "$key" \
    --arg detail "$detail" \
    --argjson size_bytes "$size_bytes" \
    --argjson json_count "$json_count" \
    --argjson exit_code "$exit_code" \
    '{startedAt:$ts_start,finishedAt:$ts_end,status:$status,snapshotKey:$key,detail:$detail,cipherBytes:$size_bytes,jsonFilesValidated:$json_count,exitCode:$exit_code}' \
    > "$HEARTBEAT_FILE.tmp"
  mv "$HEARTBEAT_FILE.tmp" "$HEARTBEAT_FILE"
}

fail() {
  local exit_code="$1"; shift
  local detail="$*"
  log "FATAL: $detail"
  write_heartbeat "fail" "" "$detail" 0 0 "$exit_code"
  exit "$exit_code"
}

SCRATCH_DIR=""
trap 'if [ -n "$SCRATCH_DIR" ] && [ -d "$SCRATCH_DIR" ]; then rm -rf "$SCRATCH_DIR"; fi' EXIT

# ── 1. Tooling pre-flight ────────────────────────────────────────────────────
for bin in op age rclone jq tar; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    fail 1 "missing required binary: $bin"
  fi
done

# ── 2. Resolve credentials ───────────────────────────────────────────────────
# Reads route through op-or-keychain.sh (Phase F.4) so a 1Password outage,
# locked desktop session, or biometric-prompt timeout fails over to the
# macOS Keychain cache. Successful op reads also refresh the Keychain so
# subsequent fallback calls remain current.

OPKC="$SCRIPT_DIR/op-or-keychain.sh"

PRIV_KEY=$("$OPKC" read "op://CoS-Dispatcher/backup-age-key/credential" 2>&1) \
  || fail 1 "op-or-keychain backup-age-key/credential failed: $PRIV_KEY"

R2_AK=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/access-key-id" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/access-key-id failed: $R2_AK"

R2_SK=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/secret-access-key failed: $R2_SK"

R2_EP=$("$OPKC" read "op://CoS-Dispatcher/r2-bucket-credentials/endpoint" 2>&1) \
  || fail 1 "op-or-keychain r2-bucket-credentials/endpoint failed: $R2_EP"

# rclone reads its config from RCLONE_CONFIG_<remote>_<key> env vars. Using
# inline env keeps the helper config-file-free on the spare.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_AK"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SK"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_EP"
export RCLONE_CONFIG_R2_REGION=auto

# ── 3. Locate the latest snapshot ────────────────────────────────────────────
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

# ── 4. Fetch into a scratch dir ──────────────────────────────────────────────
SCRATCH_DIR="$SCRATCH_BASE/$(date -u +%Y%m%dT%H%M%SZ)-$$"
mkdir -p "$SCRATCH_DIR/extract"
chmod 700 "$SCRATCH_BASE" "$SCRATCH_DIR"

CIPHER_PATH="$SCRATCH_DIR/snapshot.tar.age"
rclone copyto "r2:${R2_BUCKET}/${LATEST_KEY}" "$CIPHER_PATH" --quiet \
  || fail 1 "rclone copyto failed for $LATEST_KEY"

CIPHER_BYTES=$(stat -f%z "$CIPHER_PATH" 2>/dev/null || stat -c%s "$CIPHER_PATH")
log "fetched $CIPHER_BYTES bytes"

# ── 5. Decrypt + extract ─────────────────────────────────────────────────────
# Process substitution feeds the private key to age without ever landing on
# disk. age writes plaintext to stdout; tar consumes it directly.
if ! age -d -i <(printf '%s\n' "$PRIV_KEY") "$CIPHER_PATH" \
     | tar -xf - -C "$SCRATCH_DIR/extract"; then
  fail 1 "age decrypt or tar extract failed for $LATEST_KEY"
fi
unset PRIV_KEY

# ── 6. Validate structure ────────────────────────────────────────────────────
# Migration plan §5.2.4 requires the verification to confirm the snapshot is
# usable, not byte-identical. Three checks:
#   (a) at least one project descriptor present (state/projects/ on cloud
#       extracts to projects/ at the tar root because backup.sh tars
#       STATE_DIR contents not STATE_DIR itself)
#   (b) every JSON file under the extracted tree parses
#   (c) total file count above a sanity floor (10 — way below the 130 of
#       the production prefix at cutover; surfaces a corrupt or near-empty
#       tar without false-positiving on a quiet day)

# The cloud STATE_DIR layout (see docs/state-schemas.md) puts project
# descriptors under projects/, sessions under sessions/, etc. backup.sh
# does `tar -C "$STATE_DIR" -cf - .` so the tar root is the STATE_DIR
# contents. Verify by checking for the projects/ directory.
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

# Each JSON must parse. jq empty exits non-zero on parse failure; a single
# bad file fails the verification.
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

log "ok: $LATEST_KEY decrypted and validated ($JSON_COUNT JSON files, $TOTAL_FILES total)"
write_heartbeat "ok" "$LATEST_KEY" "" "$CIPHER_BYTES" "$JSON_COUNT" 0
