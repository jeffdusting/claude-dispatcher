#!/usr/bin/env bash
# check-spare-tooling.sh — Phase F.2 desktop spare tooling readiness check.
#
# Verifies the binaries the warm-spare workflow depends on are present and
# minimum-version-compliant. Run this on the operator's desktop before
# installing the spare-verify launchd job; the laptop is verified by virtue
# of having operated as the primary throughout Phase A through E.
#
# Usage:
#   scripts/check-spare-tooling.sh
#
# Exit codes:
#   0 — every required binary present and within version range
#   1 — at least one binary missing or below minimum version
#
# What it checks:
#   bun     >= 1.3.0  (matches the laptop and the cloud image)
#   age     any       (used to decrypt R2 snapshots)
#   op      >= 2.30   (1Password CLI; vault reads)
#   rclone  >= 1.66   (R2 listings and copies)
#   jq      any       (JSON validation in spare-verify-backup.sh)
#   tar     any       (snapshot extraction)
#   gcloud  any       (Drive SA key tooling for failover)
#   flyctl  any       (cloud-status checks during failover detection)
#
# What it does NOT check:
#   1Password 8 desktop sign-in state — that is a runtime concern surfaced
#   by spare-verify-backup.sh's first call to op read.

set -uo pipefail

LOG_TAG="[check-spare-tooling]"

PASS=0
FAIL=0

check_present() {
  local bin="$1"
  if command -v "$bin" >/dev/null 2>&1; then
    local path
    path=$(command -v "$bin")
    printf '%s OK  %-7s %s\n' "$LOG_TAG" "$bin" "$path"
    PASS=$((PASS + 1))
  else
    printf '%s FAIL %-7s not found on PATH\n' "$LOG_TAG" "$bin"
    FAIL=$((FAIL + 1))
  fi
}

check_min_version() {
  # check_min_version <bin> <version-cmd-args> <regex> <min-version>
  local bin="$1"
  local args="$2"
  local regex="$3"
  local min="$4"

  if ! command -v "$bin" >/dev/null 2>&1; then
    printf '%s FAIL %-7s not found on PATH\n' "$LOG_TAG" "$bin"
    FAIL=$((FAIL + 1))
    return
  fi

  local out actual
  out=$("$bin" $args 2>&1 | head -3)
  actual=$(printf '%s' "$out" | grep -oE "$regex" | head -1)

  if [ -z "$actual" ]; then
    printf '%s WARN %-7s present but version unparseable: %s\n' "$LOG_TAG" "$bin" "$out"
    PASS=$((PASS + 1))
    return
  fi

  # sort -V is the portable semver comparator. If the lower of the two is
  # the minimum, the actual is >= the minimum.
  local lower
  lower=$(printf '%s\n%s\n' "$actual" "$min" | sort -V | head -1)
  if [ "$lower" = "$min" ]; then
    printf '%s OK  %-7s %s (>= %s)\n' "$LOG_TAG" "$bin" "$actual" "$min"
    PASS=$((PASS + 1))
  else
    printf '%s FAIL %-7s %s (need >= %s)\n' "$LOG_TAG" "$bin" "$actual" "$min"
    FAIL=$((FAIL + 1))
  fi
}

echo "$LOG_TAG checking Phase F warm-spare tooling on $(hostname -s)"

check_min_version bun    '--version'  '[0-9]+\.[0-9]+\.[0-9]+' '1.3.0'
check_present     age
check_min_version op     '--version'  '[0-9]+\.[0-9]+\.[0-9]+' '2.30.0'
check_min_version rclone 'version'    'v[0-9]+\.[0-9]+\.[0-9]+' 'v1.66.0'
check_present     jq
check_present     tar
check_present     gcloud
check_present     flyctl

# Workspace structure — the install scripts assume a clone at the canonical
# laptop path. The desktop may use a different home directory.
WORKSPACE_DIR=""
for cand in "$HOME/claude-workspace/generic" "$HOME/Documents/claude-workspace/generic" "$HOME/code/claude-workspace/generic"; do
  if [ -d "$cand/dispatcher" ]; then
    WORKSPACE_DIR="$cand"
    break
  fi
done

if [ -n "$WORKSPACE_DIR" ]; then
  printf '%s OK  workspace found at %s\n' "$LOG_TAG" "$WORKSPACE_DIR"
  PASS=$((PASS + 1))
else
  printf '%s FAIL workspace not found under any of: ~/claude-workspace/generic, ~/Documents/..., ~/code/...\n' "$LOG_TAG"
  FAIL=$((FAIL + 1))
fi

echo "$LOG_TAG summary: $PASS pass, $FAIL fail"

if [ "$FAIL" -gt 0 ]; then
  echo "$LOG_TAG remediation: brew install bun age 1password-cli rclone jq google-cloud-sdk flyctl"
  exit 1
fi

echo "$LOG_TAG ready — proceed with scripts/install-spare-verify.sh"
exit 0
