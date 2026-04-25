#!/usr/bin/env bash
# Schedule an autonomous continuation of this session.
#
# Usage from inside a Claude Code dispatcher session:
#
#   continue_when.sh --delay 900 --reason "short one-liner" --prompt "full prompt"
#
# Flags:
#   --delay N       seconds to wait before the dispatcher re-invokes us (60..3600)
#   --reason TEXT   short reason surfaced in Discord (max 200 chars)
#   --prompt TEXT   the prompt the dispatcher will fire back at us
#
# Environment requirements (set by the dispatcher):
#   CLAUDE_CONTINUE_FILE  — absolute path to write the continuation descriptor
#   CLAUDE_THREAD_ID      — Discord thread ID (sanity check)
#
# Behaviour:
#   - Writes a JSON descriptor to $CLAUDE_CONTINUE_FILE
#   - If already called this turn, the file is overwritten (last write wins)
#   - The dispatcher reads and deletes the file after the turn completes,
#     schedules setTimeout(delay), and re-invokes this session
#   - A user message in the thread supersedes the continuation — timer
#     is cancelled and the user message runs instead

set -euo pipefail

if [ -z "${CLAUDE_CONTINUE_FILE:-}" ]; then
  echo "continue_when.sh: CLAUDE_CONTINUE_FILE not set — not running under dispatcher?" >&2
  exit 1
fi
if [ -z "${CLAUDE_THREAD_ID:-}" ]; then
  echo "continue_when.sh: CLAUDE_THREAD_ID not set — not running under dispatcher?" >&2
  exit 1
fi

DELAY=""
REASON=""
PROMPT=""

while [ $# -gt 0 ]; do
  case "$1" in
    --delay)   DELAY="$2"; shift 2 ;;
    --reason)  REASON="$2"; shift 2 ;;
    --prompt)  PROMPT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0"
      exit 0
      ;;
    *)
      echo "continue_when.sh: unknown flag $1" >&2
      exit 2
      ;;
  esac
done

if [ -z "$DELAY" ] || [ -z "$REASON" ] || [ -z "$PROMPT" ]; then
  echo "continue_when.sh: --delay, --reason and --prompt are all required" >&2
  exit 2
fi

# Clamp delay (dispatcher will clamp again, but be defensive)
if ! [[ "$DELAY" =~ ^[0-9]+$ ]]; then
  echo "continue_when.sh: --delay must be an integer" >&2
  exit 2
fi
if [ "$DELAY" -lt 60 ]; then DELAY=60; fi
if [ "$DELAY" -gt 3600 ]; then DELAY=3600; fi

NOW_ISO=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Build the JSON using a here-doc + jq if available, otherwise python3
if command -v jq >/dev/null 2>&1; then
  jq -n \
    --arg tid "$CLAUDE_THREAD_ID" \
    --arg reason "$REASON" \
    --arg prompt "$PROMPT" \
    --arg createdAt "$NOW_ISO" \
    --argjson delay "$DELAY" \
    '{delay_seconds: $delay, reason: $reason, prompt: $prompt, thread_id: $tid, created_at: $createdAt}' \
    > "$CLAUDE_CONTINUE_FILE"
else
  python3 - <<PYEOF > "$CLAUDE_CONTINUE_FILE"
import json
print(json.dumps({
    "delay_seconds": int("$DELAY"),
    "reason": """$REASON""",
    "prompt": """$PROMPT""",
    "thread_id": "$CLAUDE_THREAD_ID",
    "created_at": "$NOW_ISO",
}, indent=2))
PYEOF
fi

echo "continue_when.sh: scheduled continuation in ${DELAY}s: ${REASON}"
