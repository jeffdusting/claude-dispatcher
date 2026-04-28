#!/usr/bin/env bash
# Phase D — Codespaces post-create setup.
#
# Installs the toolchain the River dispatcher development environment
# requires across the four production repos: Bun (pinned), age, the
# 1Password CLI, flyctl, and the gcloud CLI. Node and Python are
# provided by devcontainer features in devcontainer.json.
#
# Run by Codespaces automatically as part of postCreateCommand. Idempotent —
# safe to re-run if the container is rebuilt.

set -euo pipefail

BUN_VERSION="1.3.12"   # matches Phase A.3 production image (oven/bun:1.3.12)
log() { printf '[setup-codespace] %s\n' "$*"; }

# ── Bun (pinned) ─────────────────────────────────────────────────────────────
log "installing Bun ${BUN_VERSION}"
curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}"
for rc in ~/.bashrc ~/.zshrc; do
  grep -q 'BUN_INSTALL=' "$rc" 2>/dev/null || cat >>"$rc" <<'EOF'

# Bun (Phase D Codespaces)
export BUN_INSTALL="$HOME/.bun"
export PATH="$BUN_INSTALL/bin:$PATH"
EOF
done

# ── age ──────────────────────────────────────────────────────────────────────
log "installing age"
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends age

# ── 1Password CLI ────────────────────────────────────────────────────────────
log "installing 1Password CLI"
curl -fsSL https://downloads.1password.com/linux/keys/1password.asc \
  | sudo gpg --dearmor -o /usr/share/keyrings/1password-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main" \
  | sudo tee /etc/apt/sources.list.d/1password.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends 1password-cli
op --version

# ── flyctl ───────────────────────────────────────────────────────────────────
log "installing flyctl"
curl -fsSL https://fly.io/install.sh | sh
for rc in ~/.bashrc ~/.zshrc; do
  grep -q 'FLYCTL_INSTALL=' "$rc" 2>/dev/null || cat >>"$rc" <<'EOF'

# flyctl (Phase D Codespaces)
export FLYCTL_INSTALL="$HOME/.fly"
export PATH="$FLYCTL_INSTALL/bin:$PATH"
EOF
done

# ── gcloud CLI ───────────────────────────────────────────────────────────────
log "installing gcloud CLI"
curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
  | sudo gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
  | sudo tee /etc/apt/sources.list.d/google-cloud-sdk.list >/dev/null
sudo apt-get update -qq
sudo apt-get install -y --no-install-recommends google-cloud-cli

log "post-create complete"
log ""
log "First-use authentication (run interactively when needed):"
log "  gcloud auth login           # Google Cloud"
log "  op signin                   # 1Password (or set OP_SERVICE_ACCOUNT_TOKEN)"
log "  flyctl auth login           # Fly.io"
log ""
log "Codespaces secrets are test credentials only (Phase D §7.2)."
log "Production secrets remain in 1Password and are read by the deployed"
log "dispatcher via OP_SERVICE_ACCOUNT_TOKEN — never copy them into Codespaces."
