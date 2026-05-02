"""Emergent-skill gate (R-940 §6.4 / §13.1).

Hermes Agent autonomously emits skill markdown files into ~/.hermes/skills/
when it completes a complex task. The gate watches that directory and
classifies each newly-emitted skill into one of two categories:

  - permissive — skill is in a pre-approved category and remains active.
  - sensitive — skill is in a category that requires operator review;
    the gate moves the skill to ~/.hermes/skills/.queued-for-review/ so
    it does not auto-activate, and writes an audit entry to
    /data/state/hermes-skill-gate-audit.jsonl for the operator's week-1
    review pass.

Permissive categories (auto-activate):
  - research, summarisation, file-handling, data-extraction,
    analysis, reading.

Sensitive categories (queue for review):
  - mail-composition, calendar-mutation, counterparty-contact,
    drafts-creation, external-write, financial, governance.

When a skill's category cannot be inferred from its content, the gate
defaults to sensitive — fail-closed for the pilot.

The gate's classifier is intentionally simple — keyword matching on the
skill's title and first 500 characters. The pilot's purpose is to surface
emergent skills to the operator, not to operate as a sophisticated
moderator. Real classification happens at week-1 review.
"""

from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal


PERMISSIVE_KEYWORDS = [
    "research",
    "summarise",
    "summarize",
    "summary",
    "extract",
    "analyse",
    "analyze",
    "analysis",
    "read",
    "list",
    "search",
    "fetch",
    "retrieve",
    "compile",
]

SENSITIVE_KEYWORDS = [
    # mail
    "mail",
    "email",
    "draft",
    "send",
    "reply",
    "compose",
    "outbound",
    # calendar
    "calendar",
    "meeting",
    "schedule",
    "invitation",
    "invite",
    "rsvp",
    # counterparty
    "counterparty",
    "contact",
    "negotiation",
    "client",
    "vendor",
    "supplier",
    # external write
    "post",
    "publish",
    "submit",
    "lodge",
    "file",
    # financial / governance
    "invoice",
    "payment",
    "contract",
    "tender",
    "board",
    "governance",
    "regulatory",
    "compliance",
]


Category = Literal["permissive", "sensitive", "unknown"]


def classify_skill(title: str, body: str) -> tuple[Category, str]:
    """Return (category, reason). Defaults to sensitive when unclear."""
    text = (title + "\n" + body[:500]).lower()
    sensitive_hits = [k for k in SENSITIVE_KEYWORDS if re.search(rf"\b{re.escape(k)}\b", text)]
    permissive_hits = [k for k in PERMISSIVE_KEYWORDS if re.search(rf"\b{re.escape(k)}\b", text)]
    if sensitive_hits:
        return ("sensitive", f"sensitive keyword(s): {', '.join(sensitive_hits[:3])}")
    if permissive_hits:
        return ("permissive", f"permissive keyword(s): {', '.join(permissive_hits[:3])}")
    return ("sensitive", "no recognised category — fail-closed")


def gate_skill_file(skill_path: Path, audit_path: Path, queue_dir: Path) -> dict:
    """Process one emergent-skill file. Returns the audit entry."""
    title = skill_path.stem
    try:
        body = skill_path.read_text(encoding="utf8", errors="replace")
    except Exception as e:
        body = ""
        read_error = str(e)
    else:
        read_error = None
    category, reason = classify_skill(title, body)
    entry = {
        "ts": datetime.now(timezone.utc).isoformat(),
        "skillName": title,
        "skillPath": str(skill_path),
        "category": category,
        "reason": reason,
        "bodyLen": len(body),
        "readError": read_error,
    }
    if category == "sensitive":
        queue_dir.mkdir(parents=True, exist_ok=True)
        target = queue_dir / skill_path.name
        try:
            shutil.move(str(skill_path), str(target))
            entry["action"] = "queued"
            entry["queuedAt"] = str(target)
        except Exception as e:
            entry["action"] = "queue-failed"
            entry["queueError"] = str(e)
    else:
        entry["action"] = "auto-activated"
    # Append to audit log.
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    with audit_path.open("a", encoding="utf8") as f:
        f.write(json.dumps(entry) + "\n")
    return entry


def scan_skills_dir(skills_dir: Path, audit_path: Path, queue_dir: Path, seen: set[str]) -> list[dict]:
    """Walk skills_dir for new skill files (not in seen). Returns audit entries."""
    if not skills_dir.exists():
        return []
    entries: list[dict] = []
    for path in skills_dir.iterdir():
        # Skip the queue dir itself.
        if path == queue_dir:
            continue
        if not path.is_file():
            continue
        if path.suffix.lower() != ".md":
            continue
        key = str(path)
        if key in seen:
            continue
        entry = gate_skill_file(path, audit_path, queue_dir)
        entries.append(entry)
        seen.add(key)
    return entries
