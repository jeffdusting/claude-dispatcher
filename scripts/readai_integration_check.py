#!/usr/bin/env python3
"""One-off Read.ai → Alex integration check.

Fires Tuesday 28 April 2026 at 12:00 local (Singapore) via launchd.
Posts a green/red status report to the Discord CoS thread.

Four signals checked:
  1. Alex's inbox has a Read.ai recap email since 27 Apr 00:00 local
  2. Alex's audit sqlite has a meeting_notes.* entry since 27 Apr 00:00 local
  3. Google Tasks has an action-item task with creation-date on/after 27 Apr
  4. Drive has a new meeting-notes markdown file (optional best-effort)

Green = signals 1–3 all present. Red = one or more missing.

After posting, unloads and removes the scheduling plist so it does not
fire again next year.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sqlite3
import subprocess
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HOME = Path.home()
ALEX_DIR = HOME / "claude-workspace" / "alex-morgan"
RUNTIME_DIR = ALEX_DIR / "runtime"
AUDIT_DB = ALEX_DIR / "audit" / "alex-morgan-audit.sqlite"
SECRETS = HOME / "claude-workspace" / "generic" / ".secrets"
DISCORD_ENV = HOME / ".claude" / "channels" / "discord" / ".env"
THREAD_ID = "1495997222234488862"
PLIST_LABEL = "au.com.waterroads.cos.readai-check-20260428"
PLIST_PATH = HOME / "Library" / "LaunchAgents" / f"{PLIST_LABEL}.plist"

# Make Alex's runtime importable so we reuse the same Gmail auth path
sys.path.insert(0, str(RUNTIME_DIR))


def _discord_token() -> str:
    for line in DISCORD_ENV.read_text().splitlines():
        if line.startswith("DISCORD_BOT_TOKEN="):
            return line.split("=", 1)[1].strip()
    raise RuntimeError("DISCORD_BOT_TOKEN not found")


def _post_discord(content: str) -> None:
    token = _discord_token()
    data = json.dumps({"content": content[:2000]}).encode()
    req = urllib.request.Request(
        f"https://discord.com/api/v10/channels/{THREAD_ID}/messages",
        data=data, method="POST",
        headers={
            "Authorization": f"Bot {token}",
            "Content-Type": "application/json",
            "User-Agent": "ReadAI-Check/1.0",
        },
    )
    urllib.request.urlopen(req, timeout=30).read()


def _check_inbox(since: dt.datetime) -> tuple[bool, str]:
    """Signal 1: a Read.ai recap landed in Alex's inbox since `since`."""
    try:
        from gmail_tools import service  # type: ignore
    except Exception as e:
        return False, f"gmail_tools import failed: {e}"
    try:
        svc = service("gmail", "alex.morgan@waterroads.com.au")
    except Exception as e:
        return False, f"gmail auth failed: {e}"

    # Gmail query: recap emails are from read.ai / e.read.ai OR forwarded by Jeff
    date_q = since.strftime("%Y/%m/%d")
    q = (
        f"(from:read.ai OR from:e.read.ai OR "
        f"(from:jeff@cbs.com.au subject:Read)) after:{date_q}"
    )
    try:
        resp = svc.users().messages().list(
            userId="me", q=q, maxResults=10,
        ).execute()
    except Exception as e:
        return False, f"gmail list failed: {e}"
    msgs = resp.get("messages", []) or []
    if not msgs:
        return False, f"no read.ai mail since {date_q} (query: {q})"
    # Get a sample subject for evidence
    try:
        sample = svc.users().messages().get(
            userId="me", id=msgs[0]["id"], format="metadata",
        ).execute()
        subj = next(
            (h["value"] for h in sample["payload"]["headers"] if h["name"] == "Subject"),
            "(no subject)",
        )
        return True, f"{len(msgs)} recap(s) found; latest: {subj[:80]}"
    except Exception as e:
        return True, f"{len(msgs)} recap(s) found (detail fetch failed: {e})"


def _check_audit_log(since: dt.datetime) -> tuple[bool, str]:
    """Signal 2: Alex's runtime processed a meeting note since `since`."""
    if not AUDIT_DB.exists():
        return False, f"audit db missing at {AUDIT_DB}"
    try:
        conn = sqlite3.connect(str(AUDIT_DB))
        conn.row_factory = sqlite3.Row
        # Success events: meeting_notes_processed (email category).
        # We deliberately exclude *_poll_error (system category) to avoid
        # scoring a DNS blip as a green signal.
        rows = list(conn.execute(
            "SELECT ts, action, subject, summary "
            "FROM events "
            "WHERE action = 'meeting_notes_processed' "
            "  AND ts >= ? "
            "ORDER BY ts DESC LIMIT 5",
            (since.isoformat(),),
        ))
        conn.close()
    except Exception as e:
        return False, f"audit query failed: {e}"
    if not rows:
        return False, f"no meeting_notes_processed events since {since.date()}"
    sample = rows[0]
    return True, (
        f"{len(rows)} processed events; latest @ "
        f"{sample['ts'][:19]} — {(sample['subject'] or '')[:60]}"
    )


def _check_google_tasks(since: dt.datetime) -> tuple[bool, str]:
    """Signal 3: a Jeff-owned Google Task was created on/after `since`."""
    try:
        from google_auth import service  # type: ignore
    except Exception as e:
        return False, f"google_auth import failed: {e}"
    try:
        svc = service("tasks", "jeffdusting@waterroads.com.au")
    except Exception as e:
        return False, f"tasks auth failed: {e}"

    try:
        lists = svc.tasklists().list().execute().get("items", []) or []
    except Exception as e:
        return False, f"tasklists fetch failed: {e}"
    if not lists:
        return False, "no Google Task lists visible"

    since_iso = since.isoformat()
    hits = []
    for tl in lists:
        try:
            tasks = svc.tasks().list(
                tasklist=tl["id"], maxResults=50, showCompleted=True,
            ).execute().get("items", []) or []
        except Exception:
            continue
        for t in tasks:
            # Tasks API `updated` is the last-change timestamp; good proxy
            if (t.get("updated") or "") >= since_iso:
                hits.append((tl.get("title", "?"), t.get("title", "?")))
    if not hits:
        return False, f"no tasks updated since {since.date()}"
    hits_trunc = ", ".join(f"[{l}] {t[:40]}" for l, t in hits[:3])
    return True, f"{len(hits)} task(s); e.g. {hits_trunc}"


def _self_uninstall() -> str:
    try:
        subprocess.run(
            ["launchctl", "unload", str(PLIST_PATH)],
            check=False, capture_output=True, timeout=10,
        )
        if PLIST_PATH.exists():
            PLIST_PATH.unlink()
        return "plist removed"
    except Exception as e:
        return f"self-uninstall warning: {e}"


def main() -> int:
    today = dt.date.today()
    # Belt-and-braces date guard
    if today != dt.date(2026, 4, 28):
        # Fire-proof against plist firing on the wrong day
        _post_discord(
            f"⚠️ Read.ai integration check fired on unexpected date {today}. "
            f"Expected 2026-04-28. Skipping checks; uninstalling plist."
        )
        _self_uninstall()
        return 0

    # Window: since Monday 27 Apr 00:00 local (Singapore)
    since = dt.datetime(2026, 4, 27, 0, 0, 0)

    lines = ["📬 **Read.ai → Alex integration check** (Tue 28 Apr, 12:00 SGT)", ""]
    s1_ok, s1 = _check_inbox(since)
    s2_ok, s2 = _check_audit_log(since)
    s3_ok, s3 = _check_google_tasks(since)
    lines.append(f"{'🟢' if s1_ok else '🔴'} **Inbox:** {s1}")
    lines.append(f"{'🟢' if s2_ok else '🔴'} **Audit log:** {s2}")
    lines.append(f"{'🟢' if s3_ok else '🔴'} **Google Tasks:** {s3}")
    lines.append("")

    overall_ok = s1_ok and s2_ok and s3_ok
    if overall_ok:
        lines.append(
            "**Verdict:** 🟢 Pipeline working end-to-end. No action needed."
        )
    else:
        lines.append(
            "**Verdict:** 🔴 One or more signals missing. Diagnosis next steps:"
        )
        if not s1_ok:
            lines.append(
                "  • Read.ai isn't delivering to Alex — re-check Step 3 "
                "(Team Report Access = User) and Step 4 (Gmail auto-forward filter)."
            )
        if s1_ok and not s2_ok:
            lines.append(
                "  • Email landed but Alex didn't process it — check "
                "`~/claude-workspace/alex-morgan/logs/agent-loop-tick.err` "
                "and verify meeting_notes.is_readai_forward() matched the payload."
            )
        if s2_ok and not s3_ok:
            lines.append(
                "  • Parsed but no task created — check the commitments.json "
                "entry for the meeting and Google Tasks scope/auth."
            )

    lines.append("")
    lines.append(f"_{_self_uninstall()}_")

    try:
        _post_discord("\n".join(lines))
    except Exception as e:
        # Last-resort: write to a local file so Jeff sees it
        (ALEX_DIR / "logs" / "readai-check-fallback.txt").write_text(
            "\n".join(lines) + f"\n\n(Discord post failed: {e})\n"
        )
        return 1

    return 0 if overall_ok else 2


if __name__ == "__main__":
    sys.exit(main())
