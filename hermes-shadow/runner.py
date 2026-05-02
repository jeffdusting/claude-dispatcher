"""Hermes shadow runner — FastAPI HTTP server.

The dispatcher (cos-dispatcher) POSTs Discord messages routed to Jeff's
partition to /shadow/inbound on this app. The runner:

  1. Authenticates the POST via the shared bearer token.
  2. Persists the inbound envelope to SHADOW_INPUT_DIR (durable record;
     also lets the operator inspect what was queued without going through
     Hermes).
  3. Calls Hermes Agent programmatically (CLI for now — pilot v0.1)
     against the inbound message text.
  4. Captures the response, runtime stats, and any new skills emitted.
  5. Writes a comparison-register entry at COMPARISON_REGISTER_DIR/
     <correlationId>.json so the operator's week-1 review pass can read
     side-by-side with the live Alex output.

Read-only contract:

  - No Discord credential available — runner cannot post back even if
    asked to.
  - No mail / calendar / Drive / Paperclip credentials.
  - Hermes' Discord/Slack/etc. gateways disabled in config.toml.

Security:

  - SHADOW_API_TOKEN bearer auth on /shadow/inbound. Rejects unauthenticated
    POSTs with 401.
  - /health is unauthenticated for Fly's health checks.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

sys.path.insert(0, str(Path(__file__).parent))
from skill_gate import scan_skills_dir  # noqa: E402


SHADOW_API_TOKEN = os.environ.get("SHADOW_API_TOKEN", "")
SHADOW_INPUT_DIR = Path(os.environ.get("SHADOW_INPUT_DIR", "/data/state/hermes-shadow-input"))
COMPARISON_REGISTER_DIR = Path(
    os.environ.get("COMPARISON_REGISTER_DIR", "/data/state/hermes-shadow-comparison")
)
HERMES_HOME = Path(os.environ.get("HERMES_HOME", "/data/.hermes"))
SKILL_GATE_AUDIT = Path(
    os.environ.get("SKILL_GATE_AUDIT", "/data/state/hermes-skill-gate-audit.jsonl")
)
HERMES_PILOT_PRINCIPAL = os.environ.get("HERMES_PILOT_PRINCIPAL", "jeff")
SHADOW_READ_ONLY = os.environ.get("SHADOW_READ_ONLY", "true").lower() == "true"

# Track skills already seen so we only audit new ones.
seen_skills: set[str] = set()


class ShadowInput(BaseModel):
    """Schema posted by cos-dispatcher's hermesShadow.ts."""

    correlationId: str
    threadId: str
    channelId: str
    messageId: str
    authorId: str
    authorUsername: str
    partition: str
    contentRaw: str
    isThread: bool
    hasAttachments: bool
    ts: int


app = FastAPI(title="cos-hermes-shadow-jeff")


@app.get("/health")
def health() -> dict[str, Any]:
    """Unauthenticated liveness check for Fly's HTTP health-check probe."""
    return {
        "ok": True,
        "service": "cos-hermes-shadow-jeff",
        "principal": HERMES_PILOT_PRINCIPAL,
        "readOnly": SHADOW_READ_ONLY,
        "hermesHome": str(HERMES_HOME),
        "comparisonRegisterDir": str(COMPARISON_REGISTER_DIR),
        "ts": datetime.now(timezone.utc).isoformat(),
    }


def authorise(request: Request) -> None:
    """Bearer auth on POST endpoints."""
    if not SHADOW_API_TOKEN:
        raise HTTPException(status_code=500, detail="shadow not configured (SHADOW_API_TOKEN unset)")
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="missing bearer token")
    token = auth[len("Bearer ") :]
    if token != SHADOW_API_TOKEN:
        raise HTTPException(status_code=401, detail="invalid bearer token")


def call_hermes(message_text: str, correlation_id: str) -> dict[str, Any]:
    """Invoke Hermes Agent against a single message in non-interactive mode.

    Pilot v0.1 — uses the CLI's one-shot mode if available, else falls back
    to a stdin-driven invocation. Captures stdout/stderr as the response.
    """
    started = time.time()
    cmd = ["hermes", "ask", message_text]
    try:
        proc = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=120,
            env={**os.environ, "HERMES_CORRELATION_ID": correlation_id},
        )
        duration_ms = int((time.time() - started) * 1000)
        return {
            "ok": proc.returncode == 0,
            "exitCode": proc.returncode,
            "responseText": proc.stdout,
            "stderr": proc.stderr[-2000:] if proc.stderr else "",
            "durationMs": duration_ms,
        }
    except subprocess.TimeoutExpired:
        return {
            "ok": False,
            "exitCode": -1,
            "responseText": "",
            "stderr": "hermes invocation timed out at 120s",
            "durationMs": 120_000,
        }
    except FileNotFoundError as e:
        return {
            "ok": False,
            "exitCode": -1,
            "responseText": "",
            "stderr": f"hermes binary not found: {e}",
            "durationMs": int((time.time() - started) * 1000),
        }


def write_comparison_entry(envelope: ShadowInput, hermes_result: dict[str, Any], skills: list[dict]) -> Path:
    """Write the per-turn comparison register entry."""
    COMPARISON_REGISTER_DIR.mkdir(parents=True, exist_ok=True)
    path = COMPARISON_REGISTER_DIR / f"{envelope.correlationId}.json"
    record = {
        "correlationId": envelope.correlationId,
        "ts": datetime.now(timezone.utc).isoformat(),
        "principal": envelope.partition,
        "inbound": {
            "channelId": envelope.channelId,
            "threadId": envelope.threadId,
            "messageId": envelope.messageId,
            "username": envelope.authorUsername,
            "contentPreview": envelope.contentRaw[:500],
            "contentLength": len(envelope.contentRaw),
        },
        "alex": {
            "note": "live Alex output captured by cos-dispatcher; shadow does not see it directly. "
            "Operator pairs the two at week-1 review by correlationId.",
        },
        "hermes": {
            "ok": hermes_result["ok"],
            "exitCode": hermes_result["exitCode"],
            "responsePreview": hermes_result["responseText"][:500],
            "responseLength": len(hermes_result["responseText"]),
            "stderrTail": hermes_result["stderr"][:500],
            "durationMs": hermes_result["durationMs"],
            "newSkillsEmitted": skills,
        },
        "review": {"comparedAt": None, "reviewer": None, "tags": [], "verdict": None, "notes": None},
    }
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(record, indent=2), encoding="utf8")
    tmp.rename(path)
    return path


@app.post("/shadow/inbound")
async def shadow_inbound(request: Request, envelope: ShadowInput) -> dict[str, Any]:
    """Receive a Discord-message envelope from cos-dispatcher and process it."""
    authorise(request)

    if envelope.partition != HERMES_PILOT_PRINCIPAL:
        # Defence in depth — we reject partitions other than the configured
        # pilot principal even if the dispatcher routes them to us by mistake.
        raise HTTPException(
            status_code=400,
            detail=f"shadow configured for partition {HERMES_PILOT_PRINCIPAL}; got {envelope.partition}",
        )

    # Persist the envelope durably for audit even if Hermes errors.
    SHADOW_INPUT_DIR.mkdir(parents=True, exist_ok=True)
    inbound_path = SHADOW_INPUT_DIR / f"{envelope.correlationId}.json"
    inbound_path.write_text(envelope.model_dump_json(indent=2), encoding="utf8")

    # Snapshot skills before invocation so we can diff after.
    skills_dir = HERMES_HOME / "skills"
    queue_dir = skills_dir / ".queued-for-review"
    pre_skills = (
        {str(p) for p in skills_dir.iterdir() if p.is_file() and p.suffix.lower() == ".md"}
        if skills_dir.exists()
        else set()
    )

    # Call Hermes.
    hermes_result = call_hermes(envelope.contentRaw, envelope.correlationId)

    # Diff skills — the gate scans the directory and audits new ones.
    new_skill_audit = scan_skills_dir(skills_dir, SKILL_GATE_AUDIT, queue_dir, pre_skills)

    # Write comparison register entry.
    register_path = write_comparison_entry(envelope, hermes_result, new_skill_audit)

    return {
        "ok": True,
        "correlationId": envelope.correlationId,
        "registerPath": str(register_path),
        "hermesOk": hermes_result["ok"],
        "newSkillsEmitted": len(new_skill_audit),
    }


@app.get("/shadow/comparison/{correlation_id}")
async def get_comparison(correlation_id: str, request: Request) -> dict[str, Any]:
    """Read a single comparison register entry. Authed."""
    authorise(request)
    path = COMPARISON_REGISTER_DIR / f"{correlation_id}.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"no entry for {correlation_id}")
    return json.loads(path.read_text(encoding="utf8"))
