#!/usr/bin/env python3
"""
LEO heartbeat kicker.

Paperclip's heartbeat scheduler has been observed to drop LEO agents after
one or two runs, leaving them idle until manually invoked. This script
force-invokes any LEO agent whose last heartbeat is older than 15 minutes.

Runs under launchd every 15 min. Idempotent — if an agent has heartbeated
recently, the script skips it. Silent on clean runs.

Jeff Dusting, CBS Group. Chief of Staff infrastructure.
"""
from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib import request, error

HOME = Path.home()
SECRETS = HOME / "claude-workspace" / "generic" / ".secrets" / "paperclip-auth.env"

CBS_COMPANY_ID = "fafce870-b862-4754-831e-2cd10e8b203c"
STALE_HEARTBEAT_MIN = 15  # minutes — invoke if older than this


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
if not (PAPERCLIP_URL and EMAIL and PASSWORD):
    print("FATAL: missing Paperclip credentials", file=sys.stderr)
    sys.exit(1)


def log(msg: str) -> None:
    print(f"[leo-kicker {datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


def auth() -> str:
    req = request.Request(
        f"{PAPERCLIP_URL}/api/auth/sign-in/email",
        data=json.dumps({"email": EMAIL, "password": PASSWORD}).encode(),
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "origin": PAPERCLIP_URL,
            "referer": f"{PAPERCLIP_URL}/",
            "user-agent": "cbs-leo-kicker/1.0",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=30) as resp:
        for c in resp.headers.get_all("Set-Cookie") or []:
            m = re.search(r"__Secure-better-auth\.session_token=([^;]+)", c)
            if m:
                return m.group(1)
    raise RuntimeError("auth failed")


def http(method: str, url: str, cookie: str, body: dict | None = None) -> tuple[int, str]:
    hdrs = {
        "cookie": f"__Secure-better-auth.session_token={cookie}",
        "accept": "application/json",
        "origin": PAPERCLIP_URL,
        "referer": f"{PAPERCLIP_URL}/",
        "user-agent": "cbs-leo-kicker/1.0",
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


def minutes_since(iso: str) -> float:
    if not iso:
        return float("inf")
    try:
        dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        return (datetime.now(timezone.utc) - dt).total_seconds() / 60.0
    except Exception:
        return float("inf")


def main() -> int:
    try:
        cookie = auth()
        status, raw = http("GET", f"{PAPERCLIP_URL}/api/companies/{CBS_COMPANY_ID}/agents", cookie)
        if status != 200:
            log(f"list agents failed: {status}")
            return 1
        data = json.loads(raw)
        agents = data if isinstance(data, list) else data.get("agents", [])
        leo = [a for a in agents if "LEO" in (a.get("name") or "")]

        invoked = 0
        skipped = 0
        for a in leo:
            mins = minutes_since(a.get("lastHeartbeatAt", ""))
            paused = a.get("pauseReason")
            status_ = a.get("status", "")

            # skip if actively running or paused
            if status_ == "running" or paused:
                skipped += 1
                continue

            if mins < STALE_HEARTBEAT_MIN:
                skipped += 1
                continue

            # invoke
            s, _ = http(
                "POST",
                f"{PAPERCLIP_URL}/api/agents/{a['id']}/heartbeat/invoke",
                cookie,
                body={},
            )
            if s in (200, 202, 204):
                log(f"invoked {a.get('name','?'):<30} (last HB {mins:.1f} min ago)")
                invoked += 1
            else:
                log(f"invoke FAILED {s}: {a.get('name','?')}")

        if invoked == 0 and skipped == len(leo):
            log(f"all {len(leo)} agents fresh — no-op")
        else:
            log(f"invoked={invoked} skipped={skipped} of {len(leo)}")
        return 0
    except Exception as e:
        log(f"ERROR {e}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
