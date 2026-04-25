#!/bin/sh
set -e

# t06: fetch secrets from 1Password Service Account here before exec.
# Required env vars to inject:
#   DISCORD_TOKEN
#   GOOGLE_APPLICATION_CREDENTIALS_JSON  (or write a credentials file)
#   Any other dispatcher env vars.
# Example (once OP_SERVICE_ACCOUNT_TOKEN is in fly secrets):
#   export DISCORD_TOKEN=$(op read "op://cos-dispatcher/discord-bot/token")

exec bun run src/index.ts
