#!/usr/bin/env bash
# install-spare-verify.sh — install the warm-spare nightly backup verification
# launchd job from scripts/spare-verify.plist.template.
#
# Idempotent: if the plist already exists in ~/Library/LaunchAgents/, this
# unloads, rewrites, and reloads. Use --uninstall to remove.
#
# Usage:
#   scripts/install-spare-verify.sh             # install or refresh
#   scripts/install-spare-verify.sh --uninstall # remove
#
# The plist template carries three placeholder tokens: __DISPATCHER_DIR__,
# __WORKSPACE_DIR__, __HOME__. This script substitutes them with absolute
# paths derived from the script's own location plus the current $HOME.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
DISPATCHER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
WORKSPACE_DIR="$(cd "$DISPATCHER_DIR/.." && pwd)"
TEMPLATE="$SCRIPT_DIR/spare-verify.plist.template"

LAUNCH_AGENTS_DIR="$HOME/Library/LaunchAgents"
PLIST_PATH="$LAUNCH_AGENTS_DIR/com.river.spare-verify.plist"
LABEL="com.river.spare-verify"

LOG_DIR="$WORKSPACE_DIR/logs"

action="${1:-install}"

case "$action" in
  --uninstall)
    if [ -f "$PLIST_PATH" ]; then
      echo "[install-spare-verify] unloading $LABEL"
      launchctl unload "$PLIST_PATH" 2>/dev/null || true
      rm "$PLIST_PATH"
      echo "[install-spare-verify] removed $PLIST_PATH"
    else
      echo "[install-spare-verify] $PLIST_PATH not present — nothing to remove"
    fi
    exit 0
    ;;
  install|"")
    ;;
  *)
    echo "usage: $0 [--uninstall]" >&2
    exit 2
    ;;
esac

if [ ! -f "$TEMPLATE" ]; then
  echo "[install-spare-verify] template not found at $TEMPLATE" >&2
  exit 1
fi

mkdir -p "$LAUNCH_AGENTS_DIR" "$LOG_DIR"

# Render the plist with absolute paths. sed with delimiter `|` keeps the
# substitution readable even with `/` in the paths.
sed \
  -e "s|__DISPATCHER_DIR__|$DISPATCHER_DIR|g" \
  -e "s|__WORKSPACE_DIR__|$WORKSPACE_DIR|g" \
  -e "s|__HOME__|$HOME|g" \
  "$TEMPLATE" > "$PLIST_PATH"

# launchctl load is idempotent only if the job is unloaded first.
launchctl unload "$PLIST_PATH" 2>/dev/null || true
launchctl load "$PLIST_PATH"

echo "[install-spare-verify] installed $PLIST_PATH"
echo "[install-spare-verify] next run: $(launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null \
  | grep -E 'next run|state' | sed 's/^[[:space:]]*//' | head -2)"
echo "[install-spare-verify] heartbeat: $LOG_DIR/spare-verify/last-verify.json"
