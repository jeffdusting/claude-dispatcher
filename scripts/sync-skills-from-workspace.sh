#!/bin/sh
# sync-skills-from-workspace.sh — mirror workspace `skills/` into the
# dispatcher's `.claude/skills/` build context so the SKILL.md files ship
# in the cos-dispatcher Docker image and are readable from the agent's
# runtime at `$DISPATCHER_DIR/.claude/skills/<name>/SKILL.md`.
#
# Workspace `skills/` (`~/claude-workspace/generic/skills/`) remains the
# canonical source-of-truth per OD-031. This script is the deploy-time
# mirror — run it before `fly deploy` whenever a SKILL.md has changed.
#
# Idempotent and safe to re-run; uses rsync's --delete to keep the mirror
# strictly in sync with the workspace source.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
DISPATCHER_DIR=$(cd "${SCRIPT_DIR}/.." && pwd)
WORKSPACE_SKILLS="${WORKSPACE_SKILLS:-${DISPATCHER_DIR}/../skills}"
DISPATCHER_SKILLS="${DISPATCHER_DIR}/.claude/skills"

if [ ! -d "${WORKSPACE_SKILLS}" ]; then
  echo "[sync-skills] workspace skills dir not found at ${WORKSPACE_SKILLS}" >&2
  exit 1
fi

mkdir -p "${DISPATCHER_SKILLS}"
rsync -a --delete \
  --exclude '.DS_Store' \
  --exclude '*.pyc' \
  --exclude '__pycache__' \
  "${WORKSPACE_SKILLS}/" "${DISPATCHER_SKILLS}/"

echo "[sync-skills] mirrored ${WORKSPACE_SKILLS} → ${DISPATCHER_SKILLS}"
ls -1 "${DISPATCHER_SKILLS}" | sed 's/^/  /'
