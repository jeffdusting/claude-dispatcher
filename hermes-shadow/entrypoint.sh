#!/bin/sh
# Hermes shadow entrypoint. tini runs us as PID 1's child. Boots as root,
# fetches secrets from 1Password, materialises Hermes config + Anthropic key,
# drops privileges to the shadow user, exec's uvicorn to host the runner.
#
# Read-only contract: Hermes Agent has Anthropic API key (for reasoning) and
# its own ~/.hermes/ memory + skill state. NO Discord credential, NO mail
# credential, NO calendar credential, NO Drive credential, NO Paperclip
# credential. Architectural enforcement of the §13.5.2 read-only rule.
#
# Fail-closed: if any vault read fails, the container exits and Fly
# attempts a restart (matches cos-dispatcher's posture).

set -eu

if [ -z "${OP_SERVICE_ACCOUNT_TOKEN:-}" ]; then
  echo "[entrypoint] OP_SERVICE_ACCOUNT_TOKEN not set — cannot fetch secrets" >&2
  exit 1
fi

export OP_SERVICE_ACCOUNT_TOKEN

mkdir -p "${STATE_DIR:-/data/state}" \
         "${HERMES_HOME:-/data/.hermes}" \
         "${COMPARISON_REGISTER_DIR:-/data/state/hermes-shadow-comparison}" \
         "${SHADOW_INPUT_DIR:-/data/state/hermes-shadow-input}"
chown -R shadow:shadow /data

# ── Anthropic API key ────────────────────────────────────────────────────────
# Same vault item the dispatcher uses for Alex's runtime. Pilot keeps Claude
# Opus 4.7 same as live Alex so the comparison isolates framework variables.
ANTHROPIC_API_KEY=$(op read "op://CoS-Dispatcher/alex-morgan-runtime/credential")
export ANTHROPIC_API_KEY

# ── Shadow API token (POST endpoint auth) ────────────────────────────────────
# A simple bearer token cos-dispatcher includes when POSTing inbound messages
# to the shadow's /shadow/inbound endpoint. Stored in vault so the dispatcher
# and shadow share a secret without burning it in env.
SHADOW_API_TOKEN=$(op read "op://CoS-Dispatcher/hermes-shadow/api-token")
export SHADOW_API_TOKEN

# ── Hermes config ────────────────────────────────────────────────────────────
# Point Hermes at Claude Opus 4.7 as its LLM provider. The Hermes CLI's
# `hermes model` subcommand sets this in ~/.hermes/config.toml; we write the
# config directly so the agent boots ready to go.
HERMES_CFG="${HERMES_HOME}/config.toml"
if [ ! -s "${HERMES_CFG}" ]; then
  echo "[entrypoint] writing Hermes config at ${HERMES_CFG}"
  cat > "${HERMES_CFG}" <<EOF
[llm]
provider = "anthropic"
model = "claude-opus-4-7"
api_key_env = "ANTHROPIC_API_KEY"

[memory]
home = "${HERMES_HOME}"

[skills]
home = "${HERMES_HOME}/skills"

# Discord, Slack, etc. gateways DISABLED. Shadow operates via the
# dispatcher-fork-to-shadow HTTP endpoint pattern, not via Hermes' built-in
# messaging platforms. Architectural enforcement of read-only contract.
[gateway]
enabled = false
EOF
  chown shadow:shadow "${HERMES_CFG}"
fi

# ── Drop privileges + start runner ───────────────────────────────────────────
export HOME=/home/shadow
exec gosu shadow uvicorn runner:app --host 0.0.0.0 --port 8080 --workers 1 --app-dir /app
