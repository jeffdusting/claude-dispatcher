#!/usr/bin/env python3
"""
Enable rapid heartbeats on LEO Advisory agents.

Context
-------
As of 2026-04-22, all LEO specialist agents (Commercial, Engagement Manager,
Technical Architect, Regulatory Analyst, Content Producer, Lead Advisor) had
`heartbeat.enabled=false` and `intervalSec=86400`. They only woke on
@-mention. That left 5 Wave 1 tasks stalled at 24h.

This script:
  1. Backs up current heartbeat config per agent to JSON.
  2. Enables scheduled heartbeats at 900s (15 min) intervals.
  3. Invokes one immediate heartbeat on each to re-register the agent in
     Paperclip's scheduler rotation.

Usage
-----
    python3 leo-enable-heartbeats.py           # dry-run (default)
    python3 leo-enable-heartbeats.py --apply   # actually patch + invoke

Jeff Dusting, CBS Group. Chief of Staff infrastructure.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib import request, error

HOME = Path.home()
SECRETS = HOME / "claude-workspace" / "generic" / ".secrets" / "paperclip-auth.env"
BACKUP_DIR = HOME / "claude-workspace" / "generic" / "dispatcher" / "state"
BACKUP_FILE = BACKUP_DIR / f"leo-heartbeat-backup-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"

CBS_COMPANY_ID = "fafce870-b862-4754-831e-2cd10e8b203c"
TARGET_INTERVAL_SEC = 900  # 15 minutes


def load_env(p: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not p.exists():
        return out
    for line in p.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"([A-Z_][A-Z0-9_]*)=(.*)", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


ENV = load_env(SECRETS)
PAPERCLIP_URL = ENV.get("PAPERCLIP_URL", "").rstrip("/")
EMAIL = ENV.get("PAPERCLIP_EMAIL", "")
PASSWORD = ENV.get("PAPERCLIP_PASSWORD", "")
if not PAPERCLIP_URL or not EMAIL or not PASSWORD:
    print("FATAL: missing Paperclip credentials", file=sys.stderr)
    sys.exit(1)


def auth() -> str:
    data = json.dumps({"email": EMAIL, "password": PASSWORD}).encode()
    req = request.Request(
        f"{PAPERCLIP_URL}/api/auth/sign-in/email",
        data=data,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "origin": PAPERCLIP_URL,
            "referer": f"{PAPERCLIP_URL}/",
            "user-agent": "cbs-leo-enable-heartbeats/1.0",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=30) as resp:
        set_cookies = resp.headers.get_all("Set-Cookie") or []
    for c in set_cookies:
        m = re.search(r"__Secure-better-auth\.session_token=([^;]+)", c)
        if m:
            return m.group(1)
    raise RuntimeError("no session cookie in sign-in response")


def http(method: str, url: str, cookie: str, body: dict | None = None) -> tuple[int, str]:
    hdrs = {
        "cookie": f"__Secure-better-auth.session_token={cookie}",
        "accept": "application/json",
        "origin": PAPERCLIP_URL,
        "referer": f"{PAPERCLIP_URL}/",
        "user-agent": "cbs-leo-enable-heartbeats/1.0",
    }
    data = None
    if body is not None:
        hdrs["content-type"] = "application/json"
        data = json.dumps(body).encode()
    req = request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with request.urlopen(req, timeout=30) as resp:
            return resp.status, resp.read().decode("utf-8", errors="replace")
    except error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Actually patch + invoke. Default is dry-run.")
    args = parser.parse_args()

    cookie = auth()

    # list agents
    status, raw = http("GET", f"{PAPERCLIP_URL}/api/companies/{CBS_COMPANY_ID}/agents", cookie)
    if status != 200:
        print(f"FATAL: list agents returned {status}: {raw[:200]}", file=sys.stderr)
        return 1
    agents_raw = json.loads(raw)
    agents = agents_raw if isinstance(agents_raw, list) else agents_raw.get("agents", [])

    # filter to LEO agents
    leo_agents = [a for a in agents if "LEO" in (a.get("name") or "")]
    print(f"Found {len(leo_agents)} LEO agents of {len(agents)} total CBS agents")
    print()

    # backup current configs
    backup: dict[str, dict] = {}
    for a in leo_agents:
        backup[a["id"]] = {
            "name": a.get("name"),
            "runtimeConfig": a.get("runtimeConfig", {}),
            "lastHeartbeatAt": a.get("lastHeartbeatAt"),
            "status": a.get("status"),
        }

    if args.apply:
        BACKUP_DIR.mkdir(parents=True, exist_ok=True)
        BACKUP_FILE.write_text(json.dumps(backup, indent=2))
        print(f"Backup written to {BACKUP_FILE}")
        print()
    else:
        print("(dry-run — no backup written, no patches applied)")
        print()

    print(f"{'AGENT':<30} {'CURRENT':<25} {'NEW':<20} {'PATCH':<6} {'INVOKE':<6}")
    print("-" * 95)

    for a in sorted(leo_agents, key=lambda x: x.get("name", "")):
        name = a.get("name", "")[:28]
        aid = a["id"]
        hb = (a.get("runtimeConfig") or {}).get("heartbeat") or {}
        cur_enabled = hb.get("enabled", False)
        cur_interval = hb.get("intervalSec", 0)
        cur_desc = f"enabled={cur_enabled} int={cur_interval}"

        new_hb = {
            "enabled": True,
            "intervalSec": TARGET_INTERVAL_SEC,
            "cooldownSec": hb.get("cooldownSec", 10),
            "wakeOnDemand": hb.get("wakeOnDemand", True),
            "maxConcurrentRuns": hb.get("maxConcurrentRuns", 1),
        }
        new_desc = f"enabled=True int={TARGET_INTERVAL_SEC}"

        if not args.apply:
            print(f"{name:<30} {cur_desc:<25} {new_desc:<20} {'dry':<6} {'dry':<6}")
            continue

        # PATCH runtimeConfig.heartbeat
        patch_body = {"runtimeConfig": {**(a.get("runtimeConfig") or {}), "heartbeat": new_hb}}
        status, raw = http("PATCH", f"{PAPERCLIP_URL}/api/agents/{aid}", cookie, body=patch_body)
        patch_ok = "OK" if status in (200, 204) else f"FAIL {status}"

        # invoke heartbeat to re-register in scheduler
        invoke_ok = "-"
        if status in (200, 204):
            s2, r2 = http("POST", f"{PAPERCLIP_URL}/api/agents/{aid}/heartbeat/invoke", cookie, body={})
            invoke_ok = "OK" if s2 in (200, 202, 204) else f"FAIL {s2}"

        print(f"{name:<30} {cur_desc:<25} {new_desc:<20} {patch_ok:<6} {invoke_ok:<6}")

    print()
    if args.apply:
        print(f"Applied. Backup at {BACKUP_FILE}")
        print(f"To revert: patch each agent's runtimeConfig.heartbeat to the values in the backup file.")
    else:
        print("Dry-run complete. Re-run with --apply to enact changes.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
