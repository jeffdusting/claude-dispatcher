#!/usr/bin/env bash
# state-push.sh — Push dispatcher state snapshot to Cloudflare R2.
#
# Runs on the Fly (primary) machine every 15 minutes via cron.
# Produces a single tar.gz at R2_BUCKET/dispatcher/state-latest.tar.gz.
# Spares pull from this path via state-pull.sh.
#
# Required environment variables (from 1Password at boot, or fly secrets):
#   R2_BUCKET        — Cloudflare R2 bucket name
#   R2_ENDPOINT      — R2 endpoint URL (https://<accountid>.r2.cloudflarestorage.com)
#   AWS_ACCESS_KEY_ID     — R2 read-write key (cloud only)
#   AWS_SECRET_ACCESS_KEY — R2 read-write secret
#
# Install on Fly machine (run once after first deploy):
#   crontab -e
#   Add: */15 * * * * /app/dispatcher/scripts/state-push.sh >> /data/claude-workspace/generic/logs/state-push.log 2>&1

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$SCRIPT_DIR/.."
STATE_DIR="$DISPATCHER_DIR/state"
LOG_TAG="[state-push]"
SNAPSHOT="/tmp/dispatcher-state-latest.tar.gz"

echo "$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"

# Verify required env vars are set
for var in R2_BUCKET R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "$LOG_TAG ERROR: $var is not set" >&2
    exit 1
  fi
done

# Verify the dispatcher is actually the primary — don't push stale spare state.
ROLE="${DISPATCHER_ROLE:-primary}"
if [[ "$ROLE" != "primary" ]]; then
  echo "$LOG_TAG SKIP: DISPATCHER_ROLE=$ROLE — only primary pushes state"
  exit 0
fi

# Build the snapshot. Excludes:
#   - worker output dirs (regeneratable)
#   - ingest channel archives (large, spare catches up post-promotion)
#   - seeds (already in git)
#   - machine-local PID file
tar -czf "$SNAPSHOT" \
  --exclude='*.DS_Store' \
  --exclude='*.lock' \
  --exclude='*.tmp' \
  --exclude='*.part' \
  --exclude='channels' \
  --exclude='seeds' \
  --exclude='dispatcher.pid' \
  -C "$STATE_DIR" \
  sessions.json \
  health.json \
  ingest-cursors.json \
  known-channels.json \
  thread_sessions.json \
  projects \
  continuations \
  project-kickoff-inbox \
  2>/dev/null || true

SNAPSHOT_SIZE=$(du -sh "$SNAPSHOT" | cut -f1)
echo "$LOG_TAG snapshot size: $SNAPSHOT_SIZE"

# Push to R2
aws s3 cp "$SNAPSHOT" \
  "s3://${R2_BUCKET}/dispatcher/state-latest.tar.gz" \
  --endpoint-url "${R2_ENDPOINT}" \
  --quiet

echo "$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) done — pushed $SNAPSHOT_SIZE to R2"
rm -f "$SNAPSHOT"
