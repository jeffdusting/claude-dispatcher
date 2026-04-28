#!/usr/bin/env python3
"""
LEO Advisory launch-buildout monitor.

Runs on a launchd schedule (every 4h during AEST business hours).
Pulls CBSA-121 and its full descendant tree from Paperclip, detects stalled
tasks (no update in >18h while in todo/in_progress/blocked) and any status
transitions since the last run, and posts a tight summary to the LEO
Discord thread if there is anything material to report.

Silent on clean runs — no "all good" spam.

State file: dispatcher/state/leo-monitor.json
Log:       dispatcher/logs/leo-monitor.log (captured by launchd)

Jeff Dusting, CBS Group. Chief of Staff infrastructure.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib import request, error

# -----------------------------------------------------------------------------
# Config
# -----------------------------------------------------------------------------

HOME = Path.home()
DISCORD_ENV = HOME / ".claude" / "channels" / "discord" / ".env"
STATE_FILE = HOME / "claude-workspace" / "generic" / "dispatcher" / "state" / "leo-monitor.json"

DISCORD_THREAD_ID = "1495754984246087780"  # LEO thread Jeff messages from
CBS_COMPANY_ID = "fafce870-b862-4754-831e-2cd10e8b203c"
CBSA_121_ID = "7a058380-e222-45f3-90d4-0dfa63abecfa"

STALL_HOURS = 18
ACTIVE_STATUSES = {"todo", "in_progress", "blocked"}

# Paperclip URL is hardcoded (matches B-007 chief-of-staff.md fix). Email and
# password fetched from 1Password via `op read`. On the laptop, this delegates
# to the 1Password 8 desktop app integration; on cloud (cos-dispatcher,
# cos-dispatcher-staging) it uses the staged OP_SERVICE_ACCOUNT_TOKEN.
# Pre-condition: 1Password 8 desktop must be signed in for launchd-scheduled
# runs to succeed; failure mode is `op read` exit non-zero, captured to the
# launchd StandardErrorPath log.
PAPERCLIP_URL = "https://org.cbslab.app"

# -----------------------------------------------------------------------------
# Env loading
# -----------------------------------------------------------------------------

def load_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        m = re.match(r"([A-Z_][A-Z0-9_]*)=(.*)", line)
        if m:
            out[m.group(1)] = m.group(2).strip().strip('"').strip("'")
    return out


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


DISCORD = load_env(DISCORD_ENV)
DISCORD_BOT_TOKEN = DISCORD.get("DISCORD_BOT_TOKEN", "")


def fail(msg: str) -> None:
    print(f"[leo-monitor] FATAL {msg}", file=sys.stderr)
    sys.exit(1)


try:
    PAPERCLIP_EMAIL = op_read("op://CoS-Dispatcher/paperclip-auth/username")
    PAPERCLIP_PASSWORD = op_read("op://CoS-Dispatcher/paperclip-auth/password")
except Exception as e:
    fail(f"missing Paperclip creds via op read: {e}")
if not DISCORD_BOT_TOKEN:
    fail(f"missing DISCORD_BOT_TOKEN in {DISCORD_ENV}")


# -----------------------------------------------------------------------------
# Logging
# -----------------------------------------------------------------------------

def log(msg: str) -> None:
    print(f"[leo-monitor {datetime.now(timezone.utc).isoformat()}] {msg}", flush=True)


# -----------------------------------------------------------------------------
# HTTP helpers
# -----------------------------------------------------------------------------

def http_json(
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: dict | None = None,
    raw_response: bool = False,
) -> Any:
    data = None
    hdrs = dict(headers or {})
    if body is not None:
        data = json.dumps(body).encode()
        hdrs.setdefault("content-type", "application/json")
    hdrs.setdefault("accept", "application/json")
    req = request.Request(url, data=data, headers=hdrs, method=method)
    try:
        with request.urlopen(req, timeout=30) as resp:
            if raw_response:
                return resp
            raw = resp.read()
            if not raw:
                return None
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw.decode("utf-8", errors="replace")
    except error.HTTPError as e:
        body_txt = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code} on {method} {url}: {body_txt[:500]}") from e


# -----------------------------------------------------------------------------
# Paperclip
# -----------------------------------------------------------------------------

def paperclip_auth() -> str:
    """Sign in and return the session cookie value."""
    url = f"{PAPERCLIP_URL}/api/auth/sign-in/email"
    data = json.dumps({"email": PAPERCLIP_EMAIL, "password": PAPERCLIP_PASSWORD}).encode()
    req = request.Request(
        url,
        data=data,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "origin": PAPERCLIP_URL,
            "referer": f"{PAPERCLIP_URL}/",
            "user-agent": "cbs-leo-monitor/1.0",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=30) as resp:
        set_cookie = resp.headers.get_all("Set-Cookie") or []
    for c in set_cookie:
        m = re.search(r"__Secure-better-auth\.session_token=([^;]+)", c)
        if m:
            return m.group(1)
    fail("paperclip auth: no session cookie returned")


def fetch_tasks(cookie: str) -> list[dict]:
    """Return parent CBSA-121 plus all descendants (recursive BFS)."""
    headers = {
        "cookie": f"__Secure-better-auth.session_token={cookie}",
        "origin": PAPERCLIP_URL,
        "referer": f"{PAPERCLIP_URL}/",
        "user-agent": "cbs-leo-monitor/1.0",
    }
    all_tasks: list[dict] = []
    seen_ids: set[str] = set()

    parent = http_json("GET", f"{PAPERCLIP_URL}/api/issues/{CBSA_121_ID}", headers=headers)
    if isinstance(parent, dict) and "issue" in parent:
        parent = parent["issue"]
    if isinstance(parent, dict) and parent.get("id"):
        all_tasks.append(parent)
        seen_ids.add(parent["id"])

    queue: list[str] = [CBSA_121_ID]
    while queue:
        pid = queue.pop(0)
        kids = http_json(
            "GET",
            f"{PAPERCLIP_URL}/api/companies/{CBS_COMPANY_ID}/issues?parentId={pid}",
            headers=headers,
        )
        items = kids if isinstance(kids, list) else kids.get("issues", []) if isinstance(kids, dict) else []
        for k in items:
            kid_id = k.get("id")
            if not kid_id or kid_id in seen_ids:
                continue
            seen_ids.add(kid_id)
            all_tasks.append(k)
            queue.append(kid_id)

    return all_tasks


# -----------------------------------------------------------------------------
# Analysis
# -----------------------------------------------------------------------------

def hours_since(iso: str) -> float:
    if not iso:
        return 0.0
    try:
        if iso.endswith("Z"):
            iso = iso[:-1] + "+00:00"
        dt = datetime.fromisoformat(iso)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).total_seconds() / 3600.0
    except Exception:
        return 0.0


def analyse(tasks: list[dict], prev_state: dict) -> tuple[list[dict], list[dict], dict]:
    """Return (stalled, transitions, next_state)."""
    stalled: list[dict] = []
    transitions: list[dict] = []
    next_state: dict[str, dict[str, str]] = {}

    prev_tasks = prev_state.get("tasks", {})

    for t in tasks:
        tid = t.get("id")
        ident = t.get("identifier", "")
        status = t.get("status", "")
        title = (t.get("title") or "")
        updated = t.get("updatedAt") or t.get("lastUpdated") or ""
        assignee = t.get("assigneeAgentId", "")
        hours = hours_since(updated)

        next_state[tid] = {
            "identifier": ident,
            "status": status,
            "updatedAt": updated,
        }

        # stall detection
        if status in ACTIVE_STATUSES and hours > STALL_HOURS:
            stalled.append(
                {
                    "identifier": ident,
                    "title": title,
                    "status": status,
                    "hours": round(hours, 1),
                    "assignee": assignee,
                }
            )

        # transition detection
        prev = prev_tasks.get(tid)
        if prev and prev.get("status") != status:
            transitions.append(
                {
                    "identifier": ident,
                    "title": title,
                    "from": prev.get("status"),
                    "to": status,
                }
            )
        elif not prev:
            # new task since last run
            if prev_state.get("tasks"):
                transitions.append(
                    {
                        "identifier": ident,
                        "title": title,
                        "from": "(new)",
                        "to": status,
                    }
                )

    return stalled, transitions, {"tasks": next_state, "ts": datetime.now(timezone.utc).isoformat()}


# -----------------------------------------------------------------------------
# Reporting
# -----------------------------------------------------------------------------

def format_summary(stalled: list[dict], transitions: list[dict]) -> str | None:
    if not stalled and not transitions:
        return None

    lines = ["**LEO launch — automated check**"]

    if stalled:
        lines.append("")
        lines.append(f"⚠️ **{len(stalled)} stalled** (no update in >{STALL_HOURS}h):")
        for s in sorted(stalled, key=lambda x: -x["hours"]):
            title = s["title"][:60]
            lines.append(f"• `{s['identifier']}` [{s['status']}] {s['hours']}h — {title}")

    if transitions:
        lines.append("")
        lines.append(f"**{len(transitions)} status change(s) since last check:**")
        for t in transitions[:8]:  # cap
            title = t["title"][:50]
            lines.append(f"• `{t['identifier']}` {t['from']} → {t['to']} — {title}")

    if len(lines) > 15:
        lines = lines[:14] + [f"• …{len(stalled) + len(transitions) - 12} more"]

    return "\n".join(lines)


def post_discord(content: str) -> None:
    url = f"https://discord.com/api/v10/channels/{DISCORD_THREAD_ID}/messages"
    headers = {
        "authorization": f"Bot {DISCORD_BOT_TOKEN}",
        "content-type": "application/json",
        "user-agent": "cbs-leo-monitor/1.0",
    }
    http_json("POST", url, headers=headers, body={"content": content})


# -----------------------------------------------------------------------------
# State
# -----------------------------------------------------------------------------

def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception as e:
        log(f"state load failed, starting fresh: {e}")
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(state, indent=2))
    tmp.replace(STATE_FILE)


# -----------------------------------------------------------------------------
# Main
# -----------------------------------------------------------------------------

def main() -> int:
    log("start")
    try:
        cookie = paperclip_auth()
        tasks = fetch_tasks(cookie)
        log(f"fetched {len(tasks)} tasks")
        prev = load_state()
        stalled, transitions, next_state = analyse(tasks, prev)
        log(f"stalled={len(stalled)} transitions={len(transitions)}")

        summary = format_summary(stalled, transitions)
        if summary:
            # Dedupe: don't re-post identical summaries within 3h
            last_summary = prev.get("last_summary")
            last_summary_ts = prev.get("last_summary_ts", "")
            if last_summary == summary and hours_since(last_summary_ts) < 3:
                log("identical summary within 3h — suppressing")
            else:
                post_discord(summary)
                next_state["last_summary"] = summary
                next_state["last_summary_ts"] = datetime.now(timezone.utc).isoformat()
                log("posted summary to Discord thread")
        else:
            log("nothing to report — silent")
            # preserve last_summary fields so dedupe still works across quiet runs
            if "last_summary" in prev:
                next_state["last_summary"] = prev["last_summary"]
                next_state["last_summary_ts"] = prev.get("last_summary_ts", "")

        save_state(next_state)
        log("done ok")
        return 0
    except Exception as e:
        log(f"ERROR {e}")
        traceback.print_exc()
        return 1


if __name__ == "__main__":
    sys.exit(main())
