# Hermes shadow app — runs Hermes Agent (Nous Research) against Discord
# messages mirrored from cos-dispatcher's Jeff partition. Read-only — never
# posts back to Discord, never sends mail, never mutates calendar, never
# writes to Drive. Outputs land in /data/state/hermes-shadow-comparison/.
#
# Hermes Agent is pinned to v2026.4.30 (sha 0c35092ac...) per operator
# decision 2026-05-02. Pin not float — pilot week observability.

FROM python:3.11-slim

# ── System dependencies ───────────────────────────────────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl ca-certificates git gnupg tini gosu \
  && rm -rf /var/lib/apt/lists/*

# ── 1Password CLI ─────────────────────────────────────────────────────────────
# Same vault access pattern as cos-dispatcher — service-account token at
# OP_SERVICE_ACCOUNT_TOKEN, secrets fetched at boot.
RUN curl -sS https://downloads.1password.com/linux/keys/1password.asc \
      | gpg --dearmor \
      | tee /usr/share/keyrings/1password-archive-keyring.gpg > /dev/null \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/1password-archive-keyring.gpg] https://downloads.1password.com/linux/debian/amd64 stable main" \
      | tee /etc/apt/sources.list.d/1password.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends 1password-cli \
  && rm -rf /var/lib/apt/lists/* \
  && op --version

# ── Hermes Agent — pinned ──────────────────────────────────────────────────────
ARG HERMES_TAG=v2026.4.30
ARG HERMES_SHA=0c35092accdc4e306e982c7b1913bf97b9bb3d3d
RUN git clone --depth 1 --branch ${HERMES_TAG} https://github.com/NousResearch/hermes-agent.git /opt/hermes-agent \
  && cd /opt/hermes-agent \
  && git rev-parse HEAD | grep -q "^${HERMES_SHA}" || (echo "Hermes commit pin mismatch — expected ${HERMES_SHA}" && exit 1) \
  && pip install --no-cache-dir -e .

# ── Shadow runner deps ─────────────────────────────────────────────────────────
COPY hermes-shadow/requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir -r /tmp/requirements.txt

# ── Non-root user ─────────────────────────────────────────────────────────────
RUN groupadd -g 1000 shadow \
  && useradd -m -u 1000 -g 1000 -s /bin/bash shadow \
  && mkdir -p /data /home/shadow/.hermes \
  && chown -R shadow:shadow /data /home/shadow

# ── App code ──────────────────────────────────────────────────────────────────
COPY hermes-shadow/runner.py /app/runner.py
COPY hermes-shadow/skill_gate.py /app/skill_gate.py
COPY hermes-shadow/entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

EXPOSE 8080

ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]
