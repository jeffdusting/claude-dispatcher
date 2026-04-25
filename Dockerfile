# syntax=docker/dockerfile:1
# oven/bun:1 is Debian slim with Bun pre-installed. Using the official Bun
# image avoids a manual Bun install step and gives us a known-good Bun 1.x.
# To hard-pin, replace with a digest: oven/bun@sha256:<digest>
FROM oven/bun:1

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    jq \
    git \
    gnupg \
  && rm -rf /var/lib/apt/lists/*

# ── 1Password CLI ─────────────────────────────────────────────────────────────
# Installed from the official 1Password apt repo (stable channel).
# Version resolves to latest stable at build time — run `op --version` in the
# built image to record the exact version in your SBOM.
# To hard-pin: replace with a direct .deb download:
#   curl -sSfLo /tmp/op.deb \
#     https://cache.agilebits.com/dist/1P/op2/pkg/v<VER>/op_linux_amd64_v<VER>.deb
RUN curl -sS https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor \
      | tee /usr/share/keyrings/1password-archive-keyring.gpg > /dev/null \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main" \
      | tee /etc/apt/sources.list.d/1password.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends 1password-cli \
  && rm -rf /var/lib/apt/lists/* \
  && op --version

# ── Claude Code CLI ───────────────────────────────────────────────────────────
# Claude Code is distributed as an npm package. oven/bun:1 does not ship
# Node.js, so we install Node.js 22 LTS from NodeSource first.
# Bun is the dispatcher runtime; Node/npm are only here for the claude binary.
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
  && apt-get install -y --no-install-recommends nodejs \
  && rm -rf /var/lib/apt/lists/* \
  && npm install -g @anthropic-ai/claude-code \
  && claude --version

WORKDIR /app

# ── App dependencies ──────────────────────────────────────────────────────────
# Copy lockfile + manifest before source so bun install is layer-cached
# independently of source changes.
COPY package.json bun.lock ./
RUN bun install --production

# ── Source code ───────────────────────────────────────────────────────────────
COPY . .

# ── Knowledge base ────────────────────────────────────────────────────────────
# Bake the River knowledge base from a named external build context.
#
# Build command:
#   docker build \
#     --build-context kb=/Users/jeffdusting/Desktop/Projects2/River \
#     -t cos-dispatcher .
#
# The kb path must contain (at minimum):
#   knowledge-base/
#   agent-roster/  (or agent-config/ / agent-instructions/ if renamed)
#   Paperclip user guide/
#
# For local testing without the KB (healthcheck smoke-test only):
#   mkdir -p /tmp/empty-kb && docker build --build-context kb=/tmp/empty-kb -t cos-dispatcher .
COPY --from=kb . /app/knowledge-base/

# ── Healthcheck port ──────────────────────────────────────────────────────────
EXPOSE 8080

# ── Entrypoint ────────────────────────────────────────────────────────────────
# entrypoint.sh is a stub that runs the dispatcher directly.
# t06 will add 1Password secret-fetch logic before the exec.
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
