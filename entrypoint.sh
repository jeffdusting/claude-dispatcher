#!/bin/sh
# Container entrypoint. tini runs us as PID 1's child. We start as root so we
# can chown the Fly volume mount (first-boot of a new volume is root-owned)
# and fetch secrets from 1Password using the service-account token (Fly secret
# OP_SERVICE_ACCOUNT_TOKEN staged in Phase B.2). We then start supercronic in
# the background under the dispatcher user (Phase B.3 hourly R2 backup) and
# finally exec the dispatcher under the dispatcher user via gosu.
#
# The privilege-drop is required because the claude CLI refuses
# --permission-mode bypassPermissions when its parent process runs as root
# (Phase E.1 prerequisite).
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

# ── Volume initialisation ────────────────────────────────────────────────────
# Fly mounts the volume at /data on every boot. On first boot of a new
# volume the mount point is root-owned; the dispatcher user (UID 1000)
# cannot write there. Idempotent chown: cheap on subsequent boots.
mkdir -p "${STATE_DIR:-/data/state}" "${LOG_DIR:-/data/logs}" \
         "${OUTBOX_DIR:-/data/outbox}" "${ATTACHMENT_DIR:-/data/attachments}"
chown -R dispatcher:dispatcher /data

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

# ── Anthropic API key ────────────────────────────────────────────────────────
# Inherited by every claude subprocess the dispatcher spawns. Without this the
# Claude CLI inside the worker cannot authenticate (laptop relies on Claude
# Code's interactive OAuth state in $HOME/.claude/; the cloud container has
# no interactive login path so the API-key env var is the only option).
ANTHROPIC_API_KEY=$(op read "op://CoS-Dispatcher/anthropic-api/credential")
export ANTHROPIC_API_KEY

# ── Drop privileges ──────────────────────────────────────────────────────────
# HOME must be set explicitly: gosu propagates the parent environ but does
# not synthesise HOME for the target user. claude and bun both read $HOME
# (claude writes to $HOME/.claude/, bun caches under $HOME/.bun).
export HOME=/home/dispatcher

# ── Discord bot token ────────────────────────────────────────────────────────
# config.ts loadToken() reads DISCORD_BOT_TOKEN from $HOME/.claude/channels/
# discord/.env (the Discord plugin's existing layout). Write the file from
# 1Password before launching the dispatcher so the module-import-time
# loadToken() call resolves cleanly in primary mode. 0700 dir / 0600 file,
# owned by the dispatcher user.
DISCORD_ENV_DIR="${HOME}/.claude/channels/discord"
DISCORD_ENV_FILE="${DISCORD_ENV_DIR}/.env"
mkdir -p "${DISCORD_ENV_DIR}"
DISCORD_BOT_TOKEN_VAL=$(op read "op://CoS-Dispatcher/discord-bot/credential")
printf 'DISCORD_BOT_TOKEN=%s\n' "${DISCORD_BOT_TOKEN_VAL}" > "${DISCORD_ENV_FILE}"
unset DISCORD_BOT_TOKEN_VAL
chown -R dispatcher:dispatcher "${HOME}/.claude"
chmod 700 "${DISCORD_ENV_DIR}"
chmod 600 "${DISCORD_ENV_FILE}"

# ── Supercronic ──────────────────────────────────────────────────────────────
# Run under the dispatcher user so backup.sh writes to /data as the same user
# that owns the tree. tini reaps the supercronic child on shutdown via
# standard SIGCHLD handling.
gosu dispatcher supercronic /app/scripts/crontab &
SUPERCRONIC_PID=$!
echo "[entrypoint] supercronic started (pid ${SUPERCRONIC_PID})"

# ── Dispatcher ───────────────────────────────────────────────────────────────
# Drop privileges and exec bun. claude subprocesses inherit the dispatcher
# user, which satisfies the bypassPermissions root-refusal check.
exec gosu dispatcher bun run src/index.ts
