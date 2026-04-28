#!/usr/bin/env bash
# send-sms.sh — Send an SMS to a named recipient (or raw E.164 number) via
# the shared CoS Twilio account. On-demand only: this script is invoked by
# the Chief of Staff when a human explicitly requests an SMS alert.
#
# Usage:
#   send-sms.sh --to jeff --message "Leaving early — call if urgent"
#   send-sms.sh --to sarah --message "Board pack uploaded to Drive"
#   send-sms.sh --to +61412345678 --message "Ad-hoc alert"
#   send-sms.sh --to jeff --from "CoS" --message "Paperclip down"
#
# Flags:
#   --to <name|+E164>   Required. Named recipient resolved from
#                        sms-contacts.env, or raw E.164 number.
#   --message <text>     Required. Body. >160 chars will be truncated
#                        unless --long is passed (Twilio will segment and
#                        bill per-segment).
#   --from <label>       Optional. Prepended to the message as "[<label>] ".
#                        Useful so the recipient knows which system sent it.
#   --long               Allow messages >160 chars (multi-segment).
#   --dry-run            Print what would be sent; do not call Twilio.
#   -h, --help           Show this help.
#
# Exit codes:
#   0  Sent successfully (Twilio returned a message SID)
#   1  Usage / configuration error
#   2  Twilio API error

set -euo pipefail

# Credentials are read from 1Password via the `op` CLI:
#   op://CoS-Dispatcher/twilio/{account-sid,auth-token,from-number}
#   op://CoS-Dispatcher/twilio-contacts/<name>-mobile
#
# Authentication: laptop uses the 1Password 8 desktop integration;
# Fly machines source OP_SERVICE_ACCOUNT_TOKEN via the staged secret.

usage() {
  sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

# --- Parse args ---
TO=""
MESSAGE=""
FROM_LABEL=""
ALLOW_LONG=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --to) TO="$2"; shift 2 ;;
    --message) MESSAGE="$2"; shift 2 ;;
    --from) FROM_LABEL="$2"; shift 2 ;;
    --long) ALLOW_LONG=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage 0 ;;
    *) echo "Unknown flag: $1" >&2; usage 1 ;;
  esac
done

if [[ -z "${TO}" || -z "${MESSAGE}" ]]; then
  echo "ERROR: --to and --message are required." >&2
  usage 1
fi

# --- Load Twilio credentials from 1Password ---
if ! command -v op >/dev/null 2>&1; then
  echo "ERROR: 'op' CLI not found on PATH." >&2
  echo "       Install via: brew install --cask 1password-cli" >&2
  exit 1
fi

TWILIO_ACCOUNT_SID="$(op read "op://CoS-Dispatcher/twilio/account-sid" 2>/dev/null || true)"
TWILIO_AUTH_TOKEN="$(op read "op://CoS-Dispatcher/twilio/auth-token" 2>/dev/null || true)"
TWILIO_FROM_NUMBER="$(op read "op://CoS-Dispatcher/twilio/from-number" 2>/dev/null || true)"

if [[ -z "${TWILIO_ACCOUNT_SID}" || -z "${TWILIO_AUTH_TOKEN}" || -z "${TWILIO_FROM_NUMBER}" ]]; then
  echo "ERROR: Twilio credentials missing from op://CoS-Dispatcher/twilio." >&2
  echo "       Ensure 'op' is signed in (laptop: 1Password 8 app focused; Fly: OP_SERVICE_ACCOUNT_TOKEN set)." >&2
  exit 1
fi

# --- Resolve recipient ---
if [[ "${TO}" =~ ^\+[0-9]{8,15}$ ]]; then
  TO_NUMBER="${TO}"
else
  TO_LOWER="$(echo "${TO}" | tr '[:upper:]' '[:lower:]')"
  TO_NUMBER="$(op read "op://CoS-Dispatcher/twilio-contacts/${TO_LOWER}-mobile" 2>/dev/null || true)"

  if [[ -z "${TO_NUMBER}" ]]; then
    echo "ERROR: No mobile configured for '${TO}'." >&2
    echo "       Expected vault field op://CoS-Dispatcher/twilio-contacts/${TO_LOWER}-mobile" >&2
    exit 1
  fi
fi

# --- Build body ---
BODY="${MESSAGE}"
if [[ -n "${FROM_LABEL}" ]]; then
  BODY="[${FROM_LABEL}] ${MESSAGE}"
fi

BODY_LEN=${#BODY}
if (( BODY_LEN > 160 )) && (( ALLOW_LONG == 0 )); then
  BODY="${BODY:0:157}..."
  echo "WARN: Message truncated to 160 chars. Pass --long to allow multi-segment." >&2
fi

# --- Send (or dry-run) ---
if (( DRY_RUN == 1 )); then
  echo "DRY-RUN — would send:"
  echo "  From: ${TWILIO_FROM_NUMBER}"
  echo "  To:   ${TO_NUMBER}  (${TO})"
  echo "  Body: ${BODY}"
  echo "  Len:  ${#BODY}"
  exit 0
fi

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST \
  "https://api.twilio.com/2010-04-01/Accounts/${TWILIO_ACCOUNT_SID}/Messages.json" \
  -u "${TWILIO_ACCOUNT_SID}:${TWILIO_AUTH_TOKEN}" \
  --data-urlencode "From=${TWILIO_FROM_NUMBER}" \
  --data-urlencode "To=${TO_NUMBER}" \
  --data-urlencode "Body=${BODY}")

HTTP_CODE=$(echo "${RESPONSE}" | tail -n1)
BODY_JSON=$(echo "${RESPONSE}" | sed '$d')

if [[ "${HTTP_CODE}" != "200" && "${HTTP_CODE}" != "201" ]]; then
  echo "ERROR: Twilio API returned HTTP ${HTTP_CODE}" >&2
  echo "${BODY_JSON}" >&2
  exit 2
fi

SID=$(echo "${BODY_JSON}" | sed -n 's/.*"sid"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
echo "OK — sent to ${TO_NUMBER} (${TO}). SID: ${SID}"
exit 0
