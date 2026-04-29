#!/usr/bin/env bash
# op-or-keychain.sh — Read a secret from 1Password with macOS Keychain
# fallback.
#
# Phase F.4 deliverable. Removes the 1Password SPOF for spare-verify
# and failover sequences (Δ I-009): when the 1Password 8 desktop session
# is locked, the desktop app is unresponsive, or the macOS biometric
# prompt times out before the operator approves it, this helper falls
# back to a previously-cached value in the macOS Keychain. Callers see
# the same surface as `op read` — secret on stdout, exit 0 on success.
#
# Design:
#   - Caller passes an op:// reference. Helper attempts `op read` first
#     with a five-second timeout (covers both unresponsive-desktop and
#     biometric-prompt-timeout failure modes).
#   - On op success: emits the secret to stdout AND refreshes the
#     Keychain cache so subsequent fallback calls remain current.
#   - On op failure: queries the macOS Keychain for the cached value
#     and emits it to stdout. Logs which path was taken to
#     <workspace>/logs/keychain-fallback.log so the operator can audit
#     how often fallback fired.
#   - Keychain entries are stored in the operator's login keychain with
#     service `com.river.spare-fallback` and account `<op-path>`.
#     `security add-generic-password -A` grants "all programs"
#     unprompted access; this matches the existing trust model where
#     the four scoped secrets land in plaintext under
#     `~/.claude/channels/discord/` when the dispatcher runs.
#   - Only the four operationally-critical secrets are eligible for
#     fallback (architecture v2.1 §3.2 / Migration Plan §9.2):
#       - op://CoS-Dispatcher/backup-age-key/credential
#       - op://CoS-Dispatcher/r2-bucket-credentials/access-key-id
#       - op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key
#       - op://CoS-Dispatcher/r2-bucket-credentials/endpoint
#       - op://CoS-Dispatcher/discord-bot/credential
#       - op://CoS-Dispatcher/discord-bot/access-config-json
#       - op://CoS-Dispatcher/anthropic-api/credential
#     A non-allow-listed path is rejected to keep the fallback surface
#     bounded — broader 1Password reads must continue to use `op read`
#     directly so an operator-noticeable error still surfaces during a
#     real outage.
#
# Subcommands:
#   read <op-path>   Resolve via op-then-keychain. Stdout = secret.
#   sync <op-path>   Force op read + Keychain refresh; no stdout.
#                    Used for one-shot init or by spare-verify-backup
#                    on the warm path.
#   sync-all         Refresh every allow-listed entry in one pass.
#                    Recommended after spare bring-up and after each
#                    secret rotation.
#   list             Print the allow-list and which entries are
#                    currently cached in the Keychain.
#
# Exit codes:
#   0  success
#   1  generic failure (both paths exhausted, allow-list violation,
#      missing tooling)
#
# Usage:
#   scripts/op-or-keychain.sh read op://CoS-Dispatcher/backup-age-key/credential
#   scripts/op-or-keychain.sh sync-all
#
# Australian spelling throughout.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$DISPATCHER_DIR/.." && pwd)"

LOG_FILE="${LOG_FILE:-$WORKSPACE_DIR/logs/keychain-fallback.log}"
KEYCHAIN_SERVICE="${KEYCHAIN_SERVICE:-com.river.spare-fallback}"
OP_TIMEOUT_SECONDS="${OP_TIMEOUT_SECONDS:-5}"

LOG_TAG="[op-or-keychain]"

# Allow-list of op:// paths eligible for Keychain fallback. Stored as a
# whitespace-separated string for set -e portability across bash 3.2 (the
# system default on macOS).
ALLOWED_PATHS="\
op://CoS-Dispatcher/backup-age-key/credential \
op://CoS-Dispatcher/r2-bucket-credentials/access-key-id \
op://CoS-Dispatcher/r2-bucket-credentials/secret-access-key \
op://CoS-Dispatcher/r2-bucket-credentials/endpoint \
op://CoS-Dispatcher/discord-bot/credential \
op://CoS-Dispatcher/discord-bot/access-config-json \
op://CoS-Dispatcher/anthropic-api/credential\
"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LOG_TAG" "$*" \
    >> "$LOG_FILE"
}

err() {
  printf '%s %s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$LOG_TAG" "$*" >&2
  log "$*"
}

is_allowed() {
  local path="$1"
  case " $ALLOWED_PATHS " in
    *" $path "*) return 0 ;;
    *)           return 1 ;;
  esac
}

have_macos_security() {
  command -v security >/dev/null 2>&1
}

require_op() {
  if ! command -v op >/dev/null 2>&1; then
    err "FATAL: 1Password \`op\` CLI not on PATH"
    exit 1
  fi
}

# Try `op read <path>` with a hard timeout. Captures stdout into the
# named variable; returns non-zero on op error or timeout.
#
# Bash 3.2 has no `mapfile`/`readarray`, no native timeout builtin. We use
# a subshell + wait pattern with the system `perl -e 'alarm'` shim if
# `timeout` is missing (macOS doesn't ship GNU coreutils' `timeout`).
op_read_with_timeout() {
  local path="$1"
  local out
  if command -v gtimeout >/dev/null 2>&1; then
    out=$(gtimeout "$OP_TIMEOUT_SECONDS" op read "$path" 2>/dev/null) || return 1
  elif command -v timeout >/dev/null 2>&1; then
    out=$(timeout "$OP_TIMEOUT_SECONDS" op read "$path" 2>/dev/null) || return 1
  else
    out=$(perl -e 'alarm shift; exec @ARGV' "$OP_TIMEOUT_SECONDS" op read "$path" 2>/dev/null) || return 1
  fi
  printf '%s' "$out"
}

keychain_set() {
  local path="$1"
  local value="$2"
  if ! have_macos_security; then
    log "no-keychain: skipping refresh for $path (Linux host)"
    return 0
  fi
  # -U updates if exists; -A grants unprompted access to every program
  # running as the operator (matches the existing trust model — see
  # script header). Stderr suppressed to avoid the standard "added to
  # keychain" noise on every refresh; failures still surface via exit
  # code.
  if ! security add-generic-password \
       -U \
       -A \
       -s "$KEYCHAIN_SERVICE" \
       -a "$path" \
       -w "$value" \
       2>/dev/null; then
    err "WARN: keychain refresh failed for $path"
    return 1
  fi
  return 0
}

keychain_get() {
  local path="$1"
  if ! have_macos_security; then
    return 1
  fi
  security find-generic-password \
    -s "$KEYCHAIN_SERVICE" \
    -a "$path" \
    -w 2>/dev/null
}

resolve_read() {
  local path="$1"
  if ! is_allowed "$path"; then
    err "FATAL: $path is not on the Keychain-fallback allow-list (use \`op read\` directly)"
    exit 1
  fi

  require_op

  # Primary path: op read with timeout.
  local value
  if value=$(op_read_with_timeout "$path"); then
    log "ok via op: $path"
    keychain_set "$path" "$value" || true
    printf '%s' "$value"
    return 0
  fi

  # Fallback path: keychain.
  if value=$(keychain_get "$path"); then
    log "ok via keychain (op unavailable): $path"
    printf '%s' "$value"
    return 0
  fi

  err "FATAL: both op and keychain failed for $path (no cached value)"
  return 1
}

resolve_sync() {
  local path="$1"
  if ! is_allowed "$path"; then
    err "FATAL: $path is not on the Keychain-fallback allow-list"
    exit 1
  fi
  require_op
  local value
  if ! value=$(op read "$path" 2>/dev/null); then
    err "FATAL: op read failed for $path during sync"
    return 1
  fi
  if keychain_set "$path" "$value"; then
    log "synced: $path"
    return 0
  fi
  err "FATAL: keychain_set failed for $path during sync"
  return 1
}

resolve_sync_all() {
  local fail=0
  for path in $ALLOWED_PATHS; do
    if resolve_sync "$path"; then
      printf '  ok    %s\n' "$path"
    else
      printf '  FAIL  %s\n' "$path"
      fail=1
    fi
  done
  return "$fail"
}

resolve_list() {
  printf 'Keychain service: %s\n' "$KEYCHAIN_SERVICE"
  if ! have_macos_security; then
    printf '\n(Linux host — Keychain unavailable; this helper degrades to a thin op-read wrapper)\n'
    return 0
  fi
  printf '\nAllow-listed paths and current Keychain status:\n'
  for path in $ALLOWED_PATHS; do
    if security find-generic-password \
         -s "$KEYCHAIN_SERVICE" \
         -a "$path" \
         -w >/dev/null 2>&1; then
      printf '  cached    %s\n' "$path"
    else
      printf '  missing   %s\n' "$path"
    fi
  done
}

# ─── Entry point ─────────────────────────────────────────────────

if [ "$#" -lt 1 ]; then
  printf '%s\n' "Usage: $(basename "$0") {read|sync|sync-all|list} [op-path]" >&2
  exit 1
fi

CMD="$1"; shift || true

case "$CMD" in
  read)
    if [ "$#" -ne 1 ]; then
      err "FATAL: \`read\` requires an op:// path"
      exit 1
    fi
    resolve_read "$1"
    ;;
  sync)
    if [ "$#" -ne 1 ]; then
      err "FATAL: \`sync\` requires an op:// path"
      exit 1
    fi
    resolve_sync "$1"
    ;;
  sync-all)
    resolve_sync_all
    ;;
  list)
    resolve_list
    ;;
  --help|-h|help)
    sed -n '1,/^set -euo pipefail$/p' "$0" | grep '^#' | sed 's/^# \?//'
    ;;
  *)
    err "FATAL: unknown subcommand: $CMD"
    exit 1
    ;;
esac
