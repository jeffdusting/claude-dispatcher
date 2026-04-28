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
import subprocess
import sys
from datetime import datetime, timezone
from urllib import request, error

CBS_COMPANY_ID = "fafce870-b862-4754-831e-2cd10e8b203c"
STALE_HEARTBEAT_MIN = 15  # minutes — invoke if older than this

# Paperclip URL is hardcoded (matches B-007 chief-of-staff.md fix). Email and
# password fetched from 1Password via `op read`. On the laptop, this delegates
# to the 1Password 8 desktop app integration; on cloud (cos-dispatcher,
# cos-dispatcher-staging) it uses the staged OP_SERVICE_ACCOUNT_TOKEN.
# Pre-condition: 1Password 8 desktop must be signed in for launchd-scheduled
# runs to succeed; failure mode is `op read` exit non-zero, captured to the
# launchd StandardErrorPath log.
PAPERCLIP_URL = "https://org.cbslab.app"


def op_read(ref: str) -> str:
    # Timeout is generous because the laptop's 1Password 8 desktop
    # integration may prompt for Touch ID on the first call after the auth
    # cache (~30 min) expires. Subsequent calls within the cache window
    # complete in <100 ms. Cloud uses OP_SERVICE_ACCOUNT_TOKEN which never
    # prompts.
    res = subprocess.run(
        ["op", "read", ref],
        capture_output=True,
        text=True,
        timeout=120,
    )
    if res.returncode != 0:
        raise RuntimeError(f"op read {ref} failed: {res.stderr.strip()}")
    return res.stdout.strip()


try:
    EMAIL = op_read("op://CoS-Dispatcher/paperclip-auth/username")
    PASSWORD = op_read("op://CoS-Dispatcher/paperclip-auth/password")
except Exception as e:
    print(f"FATAL: missing Paperclip credentials ({e})", file=sys.stderr)
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
