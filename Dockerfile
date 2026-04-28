# syntax=docker/dockerfile:1
# Bun is hard-pinned per Migration Plan §4.3.1. Bump deliberately when needed —
# do not float the tag back to oven/bun:1.
FROM oven/bun:1.3.12

# ── System dependencies ───────────────────────────────────────────────────────
# tini reaps zombies and forwards signals so bun (PID > 1) gets clean SIGTERM
# from Fly during deploys/restarts; without it, the dispatcher's child Claude
# Code subprocesses can be left orphaned on shutdown.
# gosu drops privileges from the root entrypoint to the unprivileged
# `dispatcher` user before exec'ing bun. Required because the claude CLI
# refuses --permission-mode bypassPermissions when its parent process runs
# as root (Phase E.1 prerequisite).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    unzip \
    jq \
    git \
    gnupg \
    rsync \
    tini \
    age \
    gosu \
  && rm -rf /var/lib/apt/lists/* \
  && gosu --version | head -1

# ── rclone ────────────────────────────────────────────────────────────────────
# B.3 backup uploader. R2 is S3-compatible; rclone has a native R2 preset and
# is a single Go binary with no Python dependency.
RUN curl -fsSL https://downloads.rclone.org/rclone-current-linux-amd64.zip -o /tmp/rclone.zip \
  && unzip -j /tmp/rclone.zip 'rclone-*-linux-amd64/rclone' -d /usr/local/bin/ \
  && chmod +x /usr/local/bin/rclone \
  && rm /tmp/rclone.zip \
  && rclone --version | head -1

# ── supercronic ───────────────────────────────────────────────────────────────
# B.3 hourly cron driver. Single Go binary; logs to stdout (Fly captures it);
# does not fork a daemon (compatible with tini PID 1 + bun foreground).
ARG SUPERCRONIC_VERSION=0.2.32
ARG SUPERCRONIC_SHA1=7da26ce6ab48d75e97f7204554afe7c80779d4e0
RUN curl -fsSL "https://github.com/aptible/supercronic/releases/download/v${SUPERCRONIC_VERSION}/supercronic-linux-amd64" \
      -o /usr/local/bin/supercronic \
  && echo "${SUPERCRONIC_SHA1}  /usr/local/bin/supercronic" | sha1sum -c - \
  && chmod +x /usr/local/bin/supercronic \
  && supercronic -version 2>&1 | head -1

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

# ── Non-root user ─────────────────────────────────────────────────────────────
# UID 1000 / GID 1000. claude refuses --permission-mode bypassPermissions for
# root, so the long-running bun process and its claude subprocesses must run
# as a non-root user. The entrypoint stays root briefly to chown the Fly
# volume mount and fetch 1Password secrets, then drops privileges via gosu.
RUN useradd --uid 1000 --create-home --home-dir /home/dispatcher --shell /bin/bash dispatcher

WORKDIR /app

# ── App dependencies ──────────────────────────────────────────────────────────
# Copy lockfile + manifest before source so bun install is layer-cached
# independently of source changes.
COPY package.json bun.lock ./
RUN bun install --production

# ── Source code ───────────────────────────────────────────────────────────────
COPY . .

# Knowledge-base note: the architecture (v2.1 §3.5) accesses River KB content
# at runtime via Supabase pgvector with Voyage embeddings. The dispatcher
# itself does not read from any baked /app/knowledge-base/ path; the prior
# `COPY --from=kb` build-context step was removed in the Phase E.1 cleanup.

RUN chmod +x /app/entrypoint.sh /app/scripts/backup.sh \
  && chown -R dispatcher:dispatcher /app

# ── Healthcheck port ──────────────────────────────────────────────────────────
EXPOSE 8080

# ── Entrypoint ────────────────────────────────────────────────────────────────
# tini runs as PID 1 and execs entrypoint.sh as root. The entrypoint chowns
# /data so the dispatcher user owns the Fly volume tree, fetches secrets from
# 1Password, starts supercronic in the background, then exec's bun under the
# dispatcher user via gosu.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/app/entrypoint.sh"]
