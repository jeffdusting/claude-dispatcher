#!/usr/bin/env bash
# state-pull.sh — Pull dispatcher state snapshot from Cloudflare R2.
#
# Runs on spare machines (desktop/laptop) every 15 minutes via cron.
# Fetches the snapshot pushed by state-push.sh and extracts it into
# the spare's state directory, keeping it ready for promotion.
#
# Required environment variables (fetched at login via `op` CLI from 1Password):
#   R2_BUCKET             — Cloudflare R2 bucket name
#   R2_ENDPOINT           — R2 endpoint URL (https://<accountid>.r2.cloudflarestorage.com)
#   AWS_ACCESS_KEY_ID     — R2 read-only key (spare machines get read-only creds)
#   AWS_SECRET_ACCESS_KEY — R2 read-only secret
#
# Install on desktop/laptop (run once after cloning the repo):
#   crontab -e
#   Add: */15 * * * * /Users/<you>/claude-workspace/generic/dispatcher/scripts/state-pull.sh >> /Users/<you>/claude-workspace/generic/logs/state-pull.log 2>&1
#
# To remove (during promotion):
#   crontab -l | grep -v state-pull | crontab -

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$SCRIPT_DIR/.."
STATE_DIR="$DISPATCHER_DIR/state"
LOG_TAG="[state-pull]"
SNAPSHOT="/tmp/dispatcher-state-latest.tar.gz"

echo "$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) starting"

# Only pull in spare mode — skip silently if promoted to primary.
ROLE="${DISPATCHER_ROLE:-primary}"
if [[ "$ROLE" != "spare" ]]; then
  echo "$LOG_TAG SKIP: DISPATCHER_ROLE=$ROLE — only spare pulls state"
  exit 0
fi

# Verify required env vars
for var in R2_BUCKET R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  if [[ -z "${!var:-}" ]]; then
    echo "$LOG_TAG ERROR: $var is not set — source 1Password env or set vars manually" >&2
    exit 1
  fi
done

# Pull from R2
echo "$LOG_TAG pulling from R2..."
aws s3 cp \
  "s3://${R2_BUCKET}/dispatcher/state-latest.tar.gz" \
  "$SNAPSHOT" \
  --endpoint-url "${R2_ENDPOINT}" \
  --quiet

SNAPSHOT_SIZE=$(du -sh "$SNAPSHOT" | cut -f1)
echo "$LOG_TAG snapshot size: $SNAPSHOT_SIZE"

# Extract into the state directory. --overwrite replaces files atomically.
mkdir -p "$STATE_DIR"
tar -xzf "$SNAPSHOT" \
  -C "$STATE_DIR" \
  --overwrite

echo "$LOG_TAG $(date -u +%Y-%m-%dT%H:%M:%SZ) done — applied $SNAPSHOT_SIZE from R2"
rm -f "$SNAPSHOT"
