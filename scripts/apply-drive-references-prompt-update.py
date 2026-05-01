#!/usr/bin/env python3
"""
Apply the Drive-references prompt update to Group Exec Technology and the
read-only Drive-awareness block to the other CBS-side agents per the Phase
Deliverable 3 Step 4 PR (`agent-instructions/group-exec-technology/AGENTS.md`
and `docs/runbooks/cbs-side-agents-drive-awareness.md`).

Operator-driven: run from the operator's shell with op CLI authenticated.
The script reads the current `adapterConfig.promptTemplate` for each
affected agent, idempotently inserts the read-only block (skipping agents
that already have it), and PATCHes back. Group Exec Technology gets the
full updated prompt content from `agent-instructions/group-exec-technology/AGENTS.md`.

Each pre-update prompt is stashed to `/tmp/g6-drive/prompt-backup-<agent-uuid>-<date>.txt`
for rollback.

Usage:
    cd ~/claude-workspace/generic/dispatcher
    python3 scripts/apply-drive-references-prompt-update.py
"""

from __future__ import annotations

import json
import os
import re
import sys
import subprocess
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

PAPERCLIP_URL = "https://org.cbslab.app"
DISPATCHER_ROOT = Path(__file__).resolve().parent.parent
GROUP_EXEC_TECH_ID = "d55043f4-cc83-4f0b-83e8-cb043f90d548"
DRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/1P7sAByjFLdlLg_bBtqAK7oraeHOwHCX4"
KANBAN_URL = "https://drive.google.com/file/d/1CoG4DjW_YF1ETjo2hJHRJohhiz111n2RcAN6oZXRkec/view"
BACKUP_DIR = Path("/tmp/g6-drive")
DATE_TAG = datetime.now(timezone.utc).strftime("%Y-%m-%d")

OTHER_CBS_AGENTS = {
    "01273fb5-3af2-4b2e-bf92-06da5dc8eb10": "CBS Executive",
    "d5df66da-202b-48d2-b97b-8cf2a5536604": "Office Management CBS",
    "1dcabe74-9a2b-41a1-b628-a8bf6bc1970a": "Tender Intelligence",
    "69aa7cc8-0fc0-46bf-a67e-36c67f6936c2": "Tender Coordination",
    "a0bb2e2a-3e16-4c86-8782-39723a12a17d": "Research CBS",
    "beb7d905-f343-4cb2-a61b-b6b75bcd50a9": "Governance CBS",
    "9f649467-c959-4ba1-9cef-d14ea5015491": "Compliance",
    "43468bee-d04c-41d2-b29b-1edc060d558f": "Pricing and Commercial",
    "31230e7a-f4f0-440f-a214-5abca42e7140": "Technical Writing",
    "7fff3b25-bce6-475d-9862-218e1ad2e3a8": "LEO Lead Advisor",
    "d8f1213a-1297-44b6-a574-e9908828eb23": "LEO Commercial Advisor",
    "cf9479ad-0566-4ef5-a34d-36c5fad9eae0": "LEO Content Producer",
    "7512c527-ac68-4e42-9123-7cad2500e5e3": "LEO Technical Architect",
    "0c7769a4-d215-41e7-9685-8fc5c40e2de1": "LEO Engagement Manager",
    "18821dea-4695-4e92-9d41-0c01c4e56786": "LEO Regulatory Analyst",
    "83f7b451-0f81-442b-befd-37b6ede5eb4b": "Tech Operations Engineer",
    "dbad7afd-64a4-4256-9ba9-df0fa20f08ab": "Tech QA & Verification",
}

READ_ONLY_BLOCK = f"""
## Programme documentation — read access

The River Programme's canonical documentation lives in CBS Drive at the
River_CBS folder:
{DRIVE_FOLDER_URL}

Reference the architecture, runbooks, diagnostics, and operator decisions
in that folder before proposing platform changes. The kanban
({KANBAN_URL})
records work in flight, planned, and deferred. Read-only — propose
kanban updates by surfacing change proposals via Discord; you do not
edit the kanban directly.

A proposal that contradicts a recorded operator decision (the OD-NNN
entries in 02 — Migration Plan & Decisions / 27-river-decisions-applied)
is rejected outright unless the operator explicitly supersedes it.
"""

READ_ONLY_MARKER = "## Programme documentation — read access"
GROUP_EXEC_MARKER = "## Programme documentation — canonical references"


def op_read(reference: str) -> str:
    res = subprocess.run(["op", "read", reference], capture_output=True, text=True, check=True)
    return res.stdout.strip()


def paperclip_auth() -> str:
    email = op_read("op://CoS-Dispatcher/paperclip-auth/username")
    password = op_read("op://CoS-Dispatcher/paperclip-auth/password")
    body = json.dumps({"email": email, "password": password}).encode()
    req = urllib.request.Request(
        f"{PAPERCLIP_URL}/api/auth/sign-in/email",
        data=body,
        headers={
            "content-type": "application/json",
            "accept": "application/json",
            "origin": PAPERCLIP_URL,
            "referer": f"{PAPERCLIP_URL}/",
            "user-agent": "apply-drive-references/1.0",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        for c in resp.headers.get_all("Set-Cookie") or []:
            m = re.search(r"__Secure-better-auth\.session_token=([^;]+)", c)
            if m:
                return m.group(1)
    sys.exit("paperclip auth: no session cookie returned")


def http_json(method: str, url: str, cookie: str, body: dict | None = None):
    data = json.dumps(body).encode() if body is not None else None
    headers = {
        "cookie": f"__Secure-better-auth.session_token={cookie}",
        "accept": "application/json",
        "origin": PAPERCLIP_URL,
        "referer": f"{PAPERCLIP_URL}/",
        "user-agent": "apply-drive-references/1.0",
    }
    if data is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return resp.status, json.loads(resp.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", errors="replace")


def patch_agent(cookie: str, agent_id: str, new_prompt: str) -> tuple[int, str]:
    status, full = http_json("GET", f"{PAPERCLIP_URL}/api/agents/{agent_id}", cookie)
    if status != 200 or not isinstance(full, dict):
        return status, f"agent fetch failed: {full!r}"
    cfg = full.get("adapterConfig") or {}
    cfg = {**cfg, "promptTemplate": new_prompt}
    body = {"adapterConfig": cfg}
    return http_json("PATCH", f"{PAPERCLIP_URL}/api/agents/{agent_id}", cookie, body)


def main() -> int:
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    cookie = paperclip_auth()

    # Step 1 — Group Exec Technology — apply the full updated prompt.
    geth_path = DISPATCHER_ROOT / "agent-instructions" / "group-exec-technology" / "AGENTS.md"
    if not geth_path.is_file():
        sys.exit(f"missing source: {geth_path}")
    new_prompt = geth_path.read_text()

    status, geth_full = http_json("GET", f"{PAPERCLIP_URL}/api/agents/{GROUP_EXEC_TECH_ID}", cookie)
    if status != 200 or not isinstance(geth_full, dict):
        sys.exit(f"GET Group Exec Technology failed: {status} {geth_full}")
    geth_old_prompt = (geth_full.get("adapterConfig") or {}).get("promptTemplate", "")

    backup_path = BACKUP_DIR / f"prompt-backup-{GROUP_EXEC_TECH_ID}-{DATE_TAG}.txt"
    backup_path.write_text(geth_old_prompt)
    print(f"[Group Exec Tech] backup: {backup_path}  ({len(geth_old_prompt)} chars)")

    if GROUP_EXEC_MARKER in geth_old_prompt:
        print(f"[Group Exec Tech] already applied — skipping PATCH")
    else:
        s, r = patch_agent(cookie, GROUP_EXEC_TECH_ID, new_prompt)
        print(f"[Group Exec Tech] PATCH -> HTTP {s}")
        if s != 200:
            sys.exit(f"PATCH failed: {r}")

    # Step 2 — other CBS-side agents — idempotently insert the read-only block.
    for agent_id, name in OTHER_CBS_AGENTS.items():
        s, full = http_json("GET", f"{PAPERCLIP_URL}/api/agents/{agent_id}", cookie)
        if s != 200 or not isinstance(full, dict):
            print(f"[{name}] GET failed: {s} {full}")
            continue
        old_prompt = (full.get("adapterConfig") or {}).get("promptTemplate", "")
        backup_path = BACKUP_DIR / f"prompt-backup-{agent_id}-{DATE_TAG}.txt"
        backup_path.write_text(old_prompt)

        if READ_ONLY_MARKER in old_prompt:
            print(f"[{name}] already applied — skipping")
            continue

        # Insert the read-only block. Heuristic: place after the first ## Hard Stop
        # Prohibitions section if present, otherwise immediately after the H1 title.
        insertion_point = None
        m = re.search(r"(## Hard Stop Prohibitions[\s\S]+?)(\n## )", old_prompt)
        if m:
            insertion_point = m.end(1) + 1
        else:
            m = re.search(r"^# .+?\n", old_prompt, re.MULTILINE)
            if m:
                insertion_point = m.end()
        if insertion_point is None:
            new_prompt = old_prompt + READ_ONLY_BLOCK
        else:
            new_prompt = old_prompt[:insertion_point] + READ_ONLY_BLOCK + old_prompt[insertion_point:]

        s2, r2 = patch_agent(cookie, agent_id, new_prompt)
        print(f"[{name}] PATCH -> HTTP {s2} (prompt {len(old_prompt)} -> {len(new_prompt)} chars)")
        if s2 != 200:
            print(f"  FAIL: {r2}")

    print("\nDONE — backups in /tmp/g6-drive/prompt-backup-<agent-uuid>-<date>.txt")
    return 0


if __name__ == "__main__":
    sys.exit(main())
