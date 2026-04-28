#!/bin/sh
# Container entrypoint. tini runs us as PID 1's child. We fetch secrets from
# 1Password using the service-account token (Fly secret OP_SERVICE_ACCOUNT_TOKEN
# staged in Phase B.2), export them as env vars for downstream consumers, start
# supercronic in the background for the hourly R2 backup cron (Phase B.3), and
# finally exec the dispatcher.
#
# Failures fetching mandatory secrets are fatal — the container exits and Fly
# attempts a restart. The architecture's "fail closed on resolution error"
# principle (architecture v2.1 §6.1) is enforced here.

set -eu

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  echo "[entrypoint] OP_SERVICE_ACCOUNT_TOKEN not set — cannot fetch secrets" >&2
  exit 1
fi

export OP_SERVICE_ACCOUNT_TOKEN

# ── B.3 backup secrets ───────────────────────────────────────────────────────
# age private key held in env only; backup.sh feeds it to age via process
# substitution. The public key is also placed in env (lighter than re-reading
# every backup tick) but originates in fly.toml [env].
BACKUP_AGE_PRIVATE_KEY=$(op read "op://CoS-Dispatcher/backup-age-key/credential")
export BACKUP_AGE_PRIVATE_KEY

if [ -z "${BACKUP_AGE_PUBLIC_KEY:-}" ]; then
  BACKUP_AGE_PUBLIC_KEY=$(op read "op://CoS-Dispatcher/backup-age-key/public-key")
  export BACKUP_AGE_PUBLIC_KEY
fi

# R2 bucket-scoped S3 credentials.
R2_ACCESS_KEY_ID=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/access-key-id")
R2_SECRET_ACCESS_KEY=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key")
R2_ENDPOINT=$(op read "op://CoS-Dispatcher/r2-bucket-credentials/endpoint")
export R2_ACCESS_KEY_ID R2_SECRET_ACCESS_KEY R2_ENDPOINT
: "${R2_BUCKET:=cos-backups}"
export R2_BUCKET

# ── Supercronic ──────────────────────────────────────────────────────────────
# Launched in the background. It logs each invocation to stdout; Fly captures
# stdout, so backup runs are visible in `fly logs` and shipped to R2 with the
# rest of dispatcher logs (Phase B.3 deliverable 4).
#
# tini reaps the supercronic child on shutdown via standard SIGCHLD handling.
mkdir -p "${STATE_DIR:-/data/state}"
supercronic /app/scripts/crontab &
SUPERCRONIC_PID=$!
echo "[entrypoint] supercronic started (pid ${SUPERCRONIC_PID})"

# ── Dispatcher ───────────────────────────────────────────────────────────────
exec bun run src/index.ts
