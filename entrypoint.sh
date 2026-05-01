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

# ── WR Workspace SA (Alex Morgan runtime) ────────────────────────────────────
# Service account with Workspace domain-wide delegation that impersonates
# `jeffdusting@waterroads.com.au`. Powers the `google-workspace-jeff` skill —
# Alex's Gmail (drafts-only) and Calendar (read+write) capability. The SA JSON
# is materialised to a per-volume path with restrictive permissions; the path
# is exposed to workers via WR_ALEX_MORGAN_SA_KEY_PATH so the skill's helper
# scripts can read it. Fail-closed: if the vault read fails, the container
# exits and Fly restarts (matches architecture v2.1 §6.1).
SECRETS_DIR=/data/.secrets
mkdir -p "${SECRETS_DIR}"
chown dispatcher:dispatcher "${SECRETS_DIR}"
chmod 700 "${SECRETS_DIR}"
WR_ALEX_MORGAN_SA_KEY_PATH="${SECRETS_DIR}/wr-alex-morgan-gcp-sa.json"
op read "op://CoS-Dispatcher/drive-wr-alex-morgan/sa-json" > "${WR_ALEX_MORGAN_SA_KEY_PATH}"
chown dispatcher:dispatcher "${WR_ALEX_MORGAN_SA_KEY_PATH}"
chmod 600 "${WR_ALEX_MORGAN_SA_KEY_PATH}"
export WR_ALEX_MORGAN_SA_KEY_PATH

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

# loadAccess() reads access.json on every inbound message; sweepRetention()
# reads it on boot. The file must exist before primary-mode init runs.
# B-013: ACCESS_FILE points at /data/discord/access.json (set in fly.toml)
# so /access slash-command mutations survive redeploys. The vault item
# discord-bot/access-config-json holds the canonical seed value; we only
# materialise it on first boot of a new volume — subsequent boots leave the
# volume copy alone so runtime mutations are preserved. The default falls
# back to the legacy in-image path so the laptop layout is unchanged.
ACCESS_FILE="${ACCESS_FILE:-${DISCORD_ENV_DIR}/access.json}"
ACCESS_DIR=$(dirname "${ACCESS_FILE}")
mkdir -p "${ACCESS_DIR}"
chown -R dispatcher:dispatcher "${ACCESS_DIR}"
chmod 700 "${ACCESS_DIR}"
if [ ! -s "${ACCESS_FILE}" ]; then
  echo "[entrypoint] seeding ${ACCESS_FILE} from 1Password (first-boot or empty)"
  op read "op://CoS-Dispatcher/discord-bot/access-config-json" > "${ACCESS_FILE}"
  chown dispatcher:dispatcher "${ACCESS_FILE}"
  chmod 600 "${ACCESS_FILE}"
else
  ACCESS_FILE_BYTES=$(stat -c%s "${ACCESS_FILE}" 2>/dev/null || stat -f%z "${ACCESS_FILE}")
  echo "[entrypoint] ${ACCESS_FILE} present (${ACCESS_FILE_BYTES} bytes) — preserving runtime mutations"
fi
# Export so config.ts envOr() picks it up after the gosu privilege drop.
export ACCESS_FILE

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
