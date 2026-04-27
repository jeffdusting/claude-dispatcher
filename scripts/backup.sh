#!/usr/bin/env bash
# B.3 hourly snapshot script. Tars STATE_DIR, encrypts with age public key,
# uploads to Cloudflare R2, then re-fetches and decrypt-verifies the
# round-trip before declaring success. On any failure, appends a tier-2
# alert to STATE_DIR/pending-tier2-alerts.jsonl which the dispatcher's
# escalator drains on its next sweep tick.
#
# Required environment:
#   STATE_DIR                  state directory (volume mount)
#   BACKUP_AGE_PUBLIC_KEY      age recipient (public, in fly.toml env)
#   BACKUP_AGE_PRIVATE_KEY     age identity (fetched from 1Password at boot)
#   R2_ENDPOINT                S3-compat endpoint URL
#   R2_BUCKET                  bucket name (defaults to cos-backups)
#   R2_ACCESS_KEY_ID           S3-compat access key (Fly secret)
#   R2_SECRET_ACCESS_KEY       S3-compat secret key (Fly secret)
#
# Optional:
#   BACKUP_LOG_FILE            jsonl audit log (defaults STATE_DIR/backup.jsonl)
#   BACKUP_VERIFY_DIR          scratch dir for verification (defaults /dev/shm/backup-verify)
#
# Exit codes: 0 success; non-zero failure (alert already raised).
#
# Wired via dispatcher/scripts/crontab → supercronic.

set -euo pipefail

: "${STATE_DIR:?STATE_DIR not set}"
: "${BACKUP_AGE_PUBLIC_KEY:?BACKUP_AGE_PUBLIC_KEY not set}"
: "${BACKUP_AGE_PRIVATE_KEY:?BACKUP_AGE_PRIVATE_KEY not set}"
: "${R2_ENDPOINT:?R2_ENDPOINT not set}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set}"

R2_BUCKET="${R2_BUCKET:-cos-backups}"
BACKUP_LOG_FILE="${BACKUP_LOG_FILE:-${STATE_DIR}/backup.jsonl}"
BACKUP_VERIFY_DIR="${BACKUP_VERIFY_DIR:-/dev/shm/backup-verify}"

NOW_TS=$(date -u +%Y%m%dT%H%M%SZ)
DATE_PATH=$(date -u +%Y/%m/%d/%H-%M-%S)
KEY="state/${DATE_PATH}.tar.age"
TMP=$(mktemp -d)
TARFILE="${TMP}/state.tar"
CIPHER="${TMP}/state.tar.age"
PENDING_ALERTS="${STATE_DIR}/pending-tier2-alerts.jsonl"

cleanup() {
  rm -rf "$TMP" "$BACKUP_VERIFY_DIR" 2>/dev/null || true
}
trap cleanup EXIT

log_line() {
  # Append a single JSONL audit line. Fields: ts, event, key, sizeBytes, durationMs, error?
  local payload="$1"
  printf '%s\n' "$payload" >> "$BACKUP_LOG_FILE"
}

raise_tier2() {
  local summary="$1"
  local jq_summary
  jq_summary=$(printf '%s' "$summary" | jq -Rs .)
  printf '{"category":"backup-failure","summary":%s,"level":"tier-2"}\n' "$jq_summary" \
    >> "$PENDING_ALERTS"
}

fail() {
  local stage="$1"
  local detail="$2"
  log_line "$(jq -cn \
    --arg ts "$NOW_TS" --arg stage "$stage" --arg key "$KEY" --arg detail "$detail" \
    '{ts:$ts, event:"backup_failed", stage:$stage, key:$key, error:$detail}')"
  raise_tier2 "$stage failed for $KEY: $detail"
  exit 1
}

# ── 1. tar STATE_DIR ─────────────────────────────────────────────────────────
T0=$(date +%s%3N)
tar -cf "$TARFILE" -C "$STATE_DIR" . 2>"${TMP}/tar.err" \
  || fail "tar" "$(cat "${TMP}/tar.err" 2>/dev/null || echo unknown)"
TAR_SIZE=$(stat -c%s "$TARFILE" 2>/dev/null || stat -f%z "$TARFILE")

# ── 2. encrypt with age ──────────────────────────────────────────────────────
age -r "$BACKUP_AGE_PUBLIC_KEY" -o "$CIPHER" "$TARFILE" 2>"${TMP}/age.err" \
  || fail "encrypt" "$(cat "${TMP}/age.err" 2>/dev/null || echo unknown)"
CIPHER_SIZE=$(stat -c%s "$CIPHER" 2>/dev/null || stat -f%z "$CIPHER")

# ── 3. upload to R2 (S3-compat via aws-cli or s5cmd) ─────────────────────────
# We use rclone because it's the lightest single-binary R2-aware client and
# carries no Python dependency. Config is supplied inline via env vars to
# avoid a config file on disk.
export RCLONE_CONFIG_R2_TYPE=s3
export RCLONE_CONFIG_R2_PROVIDER=Cloudflare
export RCLONE_CONFIG_R2_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export RCLONE_CONFIG_R2_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export RCLONE_CONFIG_R2_ENDPOINT="$R2_ENDPOINT"
export RCLONE_CONFIG_R2_REGION=auto
export RCLONE_CONFIG_R2_NO_CHECK_BUCKET=true

rclone copyto "$CIPHER" "r2:${R2_BUCKET}/${KEY}" \
  --s3-no-check-bucket \
  --s3-no-head \
  --no-traverse \
  2>"${TMP}/rclone.err" \
  || fail "upload" "$(cat "${TMP}/rclone.err" 2>/dev/null || echo unknown)"

# ── 4. round-trip verification ───────────────────────────────────────────────
# Re-fetch the just-written object, decrypt with the private key from 1Password
# (held in BACKUP_AGE_PRIVATE_KEY env, never written to non-tmpfs disk),
# extract, validate at least one JSON file parses.
mkdir -p "$BACKUP_VERIFY_DIR"
chmod 700 "$BACKUP_VERIFY_DIR"

VERIFY_CIPHER="${BACKUP_VERIFY_DIR}/state.tar.age"
rclone copyto "r2:${R2_BUCKET}/${KEY}" "$VERIFY_CIPHER" \
  --s3-no-check-bucket \
  --no-traverse \
  2>"${TMP}/rclone-fetch.err" \
  || fail "verify-fetch" "$(cat "${TMP}/rclone-fetch.err" 2>/dev/null || echo unknown)"

# Decrypt via process substitution — private key never lands on disk.
VERIFY_TAR="${BACKUP_VERIFY_DIR}/state.tar"
age -d -i <(printf '%s\n' "$BACKUP_AGE_PRIVATE_KEY") "$VERIFY_CIPHER" > "$VERIFY_TAR" \
  2>"${TMP}/age-d.err" \
  || fail "verify-decrypt" "$(cat "${TMP}/age-d.err" 2>/dev/null || echo unknown)"

VERIFY_EXTRACT="${BACKUP_VERIFY_DIR}/extract"
mkdir -p "$VERIFY_EXTRACT"
tar -xf "$VERIFY_TAR" -C "$VERIFY_EXTRACT" 2>"${TMP}/tar-x.err" \
  || fail "verify-extract" "$(cat "${TMP}/tar-x.err" 2>/dev/null || echo unknown)"

# Find at least one .json file and validate it parses. We do not require a
# specific file to exist — fresh STATE_DIRs may have only seeds — but if any
# exist they must be parseable.
JSON_COUNT=0
JSON_INVALID=0
while IFS= read -r -d '' f; do
  JSON_COUNT=$((JSON_COUNT + 1))
  if ! jq empty "$f" >/dev/null 2>&1; then
    JSON_INVALID=$((JSON_INVALID + 1))
  fi
done < <(find "$VERIFY_EXTRACT" -type f -name '*.json' -print0 2>/dev/null)

if [ "$JSON_INVALID" -gt 0 ]; then
  fail "verify-jsonparse" "${JSON_INVALID}/${JSON_COUNT} JSON files failed to parse"
fi

T1=$(date +%s%3N)
DURATION=$((T1 - T0))

log_line "$(jq -cn \
  --arg ts "$NOW_TS" --arg key "$KEY" \
  --argjson tar "$TAR_SIZE" --argjson cipher "$CIPHER_SIZE" \
  --argjson jsonCount "$JSON_COUNT" --argjson durationMs "$DURATION" \
  '{ts:$ts, event:"backup_ok", key:$key, tarBytes:$tar, cipherBytes:$cipher, jsonValidated:$jsonCount, durationMs:$durationMs}')"

echo "backup ok: ${KEY} (cipher ${CIPHER_SIZE} bytes, ${DURATION} ms, ${JSON_COUNT} JSON files validated)"
