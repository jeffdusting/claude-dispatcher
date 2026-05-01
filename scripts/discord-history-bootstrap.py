#!/usr/bin/env python3
"""
Discord history bootstrap (Phase G.6 / OD-030).

Reads the operator's archived Discord Data Package extract, classifies
each channel and thread into an entity (CBS or WR) per the dispatcher's
`channelEntityMap.ts` plus a thread-name heuristic, redacts each
message via the J.0 trace-redaction pipeline (`discord_redactor`),
embeds via Voyage AI `voyage-3.5` (1024-dim), and upserts into the
appropriate entity-scoped Supabase pgvector knowledge base.

The script is chunked-execution-friendly: pass `--batch-channels N` to
process the top N highest-traffic channels first, or
`--include-channel <id>` (repeatable) to whitelist explicit channels.

Three execution modes:

  - Default (interactive): prints classification preview, prompts
    `Proceed with wet ingestion? [y/N]`, embeds + upserts only on a
    `y` / `yes` confirmation. Default-on-Enter is decline. Phase J
    posture rule: each batch's classification is operator-reviewed
    before any embedding cost or Supabase write.
  - `--dry-run`: prints classification preview and runs the loop in
    read-only mode (counts chunks, applies redaction in-memory).
    Skips the prompt entirely. No Voyage calls, no Supabase writes.
  - `--yes`: bypasses the prompt for non-interactive automation
    (e.g. CI replaying an audit-recorded batch). Operator runs MUST
    NOT pass `--yes`.

Idempotency: each Discord message becomes one Supabase row keyed on
`source_file = "discord-bootstrap-<channel-id>-<message-id>"`. The
script pre-deletes prior rows with the same source_file before insert,
so re-running on the same batch leaves no duplicates.

Per-message metadata recorded:
  - discord_channel_id, discord_channel_name, discord_channel_type
  - discord_message_id, discord_timestamp
  - source = "discord-bootstrap"
  - source_date = "2026-04-28" (the extract date)
  - chunk_index, total_chunks (only relevant for messages exceeding
    8000 chars, which is rare for Discord)
  - For WR-routed content: synthetic Drive provenance —
    drive_file_id = source_file, drive_modified = message timestamp

Audit: the script emits a JSONL audit log at
`state/discord-bootstrap-audit.jsonl` recording the run timestamp,
batch composition, per-channel counts and entity decisions, and total
upsert counts for both Supabase projects.

Usage:
    # Dry-run on top 7 channels (no API calls, no DB writes):
    python scripts/discord-history-bootstrap.py --batch-channels 7 --dry-run --verbose

    # Wet-run on top 5 channels:
    export VOYAGE_API_KEY=$(op read 'op://CoS-Dispatcher/voyage-api/credential')
    export CBS_SUPABASE_URL=$(op read 'op://CoS-Dispatcher/supabase-cbs/url')
    export CBS_SUPABASE_SERVICE_ROLE_KEY=$(op read 'op://CoS-Dispatcher/supabase-cbs/service-role-key')
    export WR_SUPABASE_URL=$(op read 'op://CoS-Dispatcher/supabase-wr/url')
    export WR_SUPABASE_SERVICE_ROLE_KEY=$(op read 'op://CoS-Dispatcher/supabase-wr/service-role-key')
    python scripts/discord-history-bootstrap.py --batch-channels 5

    # Wet-run on explicit channels:
    python scripts/discord-history-bootstrap.py --include-channel 1495629402908921876 \\
        --include-channel 1495962797329219584
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any

# Ensure the redactor in the same directory is importable when the
# script is invoked from anywhere.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from discord_redactor import redact_string


DEFAULT_ARCHIVE = os.path.expanduser(
    "~/archives/discord/cbs-river-workspace/2026-04-28"
)

# ─── Channel-to-entity map ───────────────────────────────────────────
# Mirror of dispatcher/src/channelEntityMap.ts — kept in sync manually.
# The TS source is the canonical record; this Python copy is for the
# offline ingestion only.
CHANNEL_ENTITY_MAP: dict[str, str] = {
    # WaterRoads
    "1495962797329219584": "wr",         # waterroads
    "1497129990192627802": "wr",         # wrei
    "1495962505879486584": "wr",         # sjt-pa
    # CBS Group
    "1497133030559715338": "cbs",        # bridge-repair-white-paper
    "1495962402934751382": "cbs",        # project-leo
}

# Thread-name heuristic — words that mark a thread as WR-scoped. Match
# is case-insensitive on word-boundaries. Threads that match any of
# these are routed to WR; otherwise they default to CBS (the platform
# home and the dispatcher's pre-multi-EA default).
WR_THREAD_KEYWORDS: tuple[str, ...] = (
    "waterroads",
    "wrei",
    "sjt",
    "rhodes",
    "barangaroo",
    "ferry",
    "wr-",
    "wr cto",
)


def classify_channel(channel_id: str, name: str, channel_type: str) -> tuple[str, str]:
    """Return (entity, reason). Top-level channel mapping wins; thread
    heuristic is fallback. Default is `cbs`."""
    if channel_id in CHANNEL_ENTITY_MAP:
        return CHANNEL_ENTITY_MAP[channel_id], "channel-entity-map"
    if channel_type == "PUBLIC_THREAD":
        lower = name.lower()
        for kw in WR_THREAD_KEYWORDS:
            # Word-boundary on either side; tolerate punctuation.
            pattern = rf"\b{re.escape(kw)}\b" if kw.endswith("-") is False else re.escape(kw)
            if re.search(pattern, lower, re.IGNORECASE):
                return "wr", f"thread-keyword:{kw}"
        return "cbs", "thread-default"
    if channel_type == "DM":
        return "skip", "dm-out-of-scope"
    return "cbs", "channel-default"


# ─── Archive readers ─────────────────────────────────────────────────

@dataclass
class ChannelRecord:
    channel_id: str
    channel_type: str
    name: str
    messages: list[dict]
    entity: str = ""
    entity_reason: str = ""

    @property
    def message_count(self) -> int:
        return len(self.messages)


def load_archive(archive_path: str) -> list[ChannelRecord]:
    msg_root = os.path.join(archive_path, "Messages")
    idx = json.load(open(os.path.join(msg_root, "index.json"), "r"))
    records: list[ChannelRecord] = []
    for entry in sorted(os.listdir(msg_root)):
        if not entry.startswith("c"):
            continue
        cid = entry[1:]
        ch_dir = os.path.join(msg_root, entry)
        ch = json.load(open(os.path.join(ch_dir, "channel.json"), "r"))
        msgs = json.load(open(os.path.join(ch_dir, "messages.json"), "r"))
        records.append(ChannelRecord(
            channel_id=cid,
            channel_type=str(ch.get("type", "?")),
            name=idx.get(cid, ch.get("name", "?")),
            messages=msgs,
        ))
    return records


# ─── Chunking ────────────────────────────────────────────────────────

def chunk_message(content: str, max_chars: int = 8000) -> list[str]:
    if len(content) <= max_chars:
        return [content]
    chunks: list[str] = []
    paragraphs = content.split("\n\n")
    current = ""
    for p in paragraphs:
        if len(current) + len(p) + 2 > max_chars:
            if current:
                chunks.append(current.strip())
            current = p
        else:
            current = current + "\n\n" + p if current else p
    if current.strip():
        chunks.append(current.strip())
    return chunks if chunks else [content[:max_chars]]


# ─── Main ingestion ──────────────────────────────────────────────────

@dataclass
class BatchOutcome:
    channels: int = 0
    messages_processed: int = 0
    chunks_inserted: int = 0
    rows_redacted: int = 0
    redaction_counts: dict[str, int] = field(default_factory=dict)
    per_channel: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def ingest_batch(
    *,
    records: list[ChannelRecord],
    voyage_client,
    cbs_supabase,
    wr_supabase,
    extract_date: str,
    dry_run: bool,
    verbose: bool,
) -> BatchOutcome:
    out = BatchOutcome()
    out.redaction_counts = {}

    for rec in records:
        if rec.entity == "skip":
            if verbose:
                print(f"  [skip] {rec.channel_id} ({rec.name[:60]}) — {rec.entity_reason}")
            continue

        target_supabase = wr_supabase if rec.entity == "wr" else cbs_supabase
        ch_count = 0
        ch_redacted = 0

        # Pre-delete by source_file prefix for idempotency. Use the LIKE
        # operator since each row has source_file = "discord-bootstrap-<cid>-<mid>[-N]"
        # and the per-channel prefix is "discord-bootstrap-<cid>-".
        prefix = f"discord-bootstrap-{rec.channel_id}-"
        if not dry_run and target_supabase is not None:
            try:
                target_supabase.table("documents").delete().like(
                    "source_file", f"{prefix}%"
                ).execute()
            except Exception as e:
                out.errors.append(f"pre-delete {prefix}: {e}")

        for msg in rec.messages:
            mid = msg.get("ID")
            ts = msg.get("Timestamp", "")
            content = msg.get("Contents", "") or ""
            if not content.strip():
                continue

            redacted = redact_string(content)
            ch_redacted += 1
            for cls, n in redacted.counts.items():
                if n > 0:
                    out.redaction_counts[cls] = out.redaction_counts.get(cls, 0) + n

            chunks = chunk_message(redacted.text)
            for chunk_index, chunk in enumerate(chunks):
                if not chunk.strip():
                    continue
                source_file = (
                    f"{prefix}{mid}-{chunk_index}" if len(chunks) > 1
                    else f"{prefix}{mid}"
                )
                metadata: dict[str, Any] = {
                    "discord_channel_id": rec.channel_id,
                    "discord_channel_name": rec.name,
                    "discord_channel_type": rec.channel_type,
                    "discord_message_id": mid,
                    "discord_timestamp": ts,
                    "source": "discord-bootstrap",
                    "source_date": extract_date,
                    "chunk_index": chunk_index,
                    "total_chunks": len(chunks),
                    "embedding_model": "voyage-3.5",
                }
                if rec.entity == "wr":
                    metadata.update({
                        "drive_file_id": source_file,
                        "drive_modified": ts,
                    })

                if dry_run:
                    out.chunks_inserted += 1
                    ch_count += 1
                    continue

                try:
                    emb = voyage_client.embed(
                        [chunk], model="voyage-3.5", input_type="document"
                    ).embeddings[0]
                except Exception as e:
                    out.errors.append(f"embed {source_file}: {e}")
                    continue

                record = {
                    "entity": "cbs-group" if rec.entity == "cbs" else "waterroads",
                    "source_file": source_file,
                    "title": (
                        f"Discord history: {rec.name[:80]} (msg {mid})"
                        if len(chunks) == 1
                        else f"Discord history: {rec.name[:80]} (msg {mid}, part {chunk_index + 1})"
                    ),
                    "content": chunk,
                    "embedding": emb,
                    "category": "discord-history",
                    "metadata": json.dumps(metadata),
                }
                if rec.entity == "wr":
                    record["drive_file_id"] = source_file
                    record["drive_modified"] = ts
                try:
                    target_supabase.table("documents").insert(record).execute()
                    out.chunks_inserted += 1
                    ch_count += 1
                except Exception as e:
                    out.errors.append(f"insert {source_file}: {e}")
                # Voyage rate-limit guard.
                time.sleep(0.1)

            out.messages_processed += 1
            out.rows_redacted += 1

        out.channels += 1
        out.per_channel.append({
            "channel_id": rec.channel_id,
            "channel_name": rec.name,
            "channel_type": rec.channel_type,
            "entity": rec.entity,
            "entity_reason": rec.entity_reason,
            "messages_in_extract": rec.message_count,
            "chunks_inserted": ch_count,
            "messages_redacted": ch_redacted,
        })
        if verbose:
            print(
                f"  [{rec.entity:3}] {rec.channel_id} ({rec.name[:50]}) — "
                f"{rec.message_count} msgs → {ch_count} chunks ({rec.entity_reason})"
            )
    return out


def write_audit(audit_path: str, outcome: BatchOutcome, args: argparse.Namespace) -> None:
    record = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "source": "discord-bootstrap",
        "source_date": args.extract_date,
        "archive_path": args.archive,
        "dry_run": args.dry_run,
        "batch_channels_arg": args.batch_channels,
        "include_channel_arg": args.include_channel or [],
        "exclude_channel_arg": args.exclude_channel or [],
        "channels_processed": outcome.channels,
        "messages_processed": outcome.messages_processed,
        "chunks_inserted": outcome.chunks_inserted,
        "redaction_counts": outcome.redaction_counts,
        "per_channel": outcome.per_channel,
        "errors": outcome.errors,
    }
    os.makedirs(os.path.dirname(audit_path), exist_ok=True)
    with open(audit_path, "a", encoding="utf-8") as f:
        f.write(json.dumps(record) + "\n")


def select_records(
    records: list[ChannelRecord],
    *,
    batch_channels: int | None,
    include_channel: list[str] | None,
    exclude_channel: list[str] | None,
) -> list[ChannelRecord]:
    if include_channel:
        wanted = set(include_channel)
        return [r for r in records if r.channel_id in wanted]
    selected = records
    if exclude_channel:
        ex = set(exclude_channel)
        selected = [r for r in selected if r.channel_id not in ex]
    if batch_channels:
        # Sort by message count desc, then by channel_id for stable order.
        selected = sorted(
            selected, key=lambda r: (-r.message_count, r.channel_id)
        )
        selected = selected[:batch_channels]
    return selected


def prompt_for_wet_run(
    *,
    input_fn=input,
    output_stream=None,
) -> bool:
    """Interactive operator gate.

    Returns True only on an unambiguous affirmative response (`y` or `yes`,
    case-insensitive); any other input — including the bare-Enter default,
    `n` / `no`, ambiguous input like `maybe` / `hmm`, or EOF — returns False.
    The default-on-Enter behaviour is intentional: the operator must
    actively confirm the wet run; the safe default is to decline.

    The `input_fn` and `output_stream` parameters are seams for tests so
    the suite does not need to drive process stdin.
    """
    if output_stream is None:
        output_stream = sys.stderr
    output_stream.write(
        "\nProceed with wet ingestion?\n"
        "  - 'y' or 'yes' to embed via Voyage and upsert to Supabase\n"
        "  - anything else (including bare Enter, 'n', or ambiguous input) declines\n"
        "Choice [y/N]: ",
    )
    output_stream.flush()
    try:
        raw = input_fn("")
    except EOFError:
        return False
    return raw.strip().lower() in ("y", "yes")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--archive", default=DEFAULT_ARCHIVE)
    p.add_argument(
        "--extract-date", default="2026-04-28",
        help="Source date metadata for ingested rows (YYYY-MM-DD).",
    )
    p.add_argument("--batch-channels", type=int, default=None)
    p.add_argument("--include-channel", action="append")
    p.add_argument("--exclude-channel", action="append")
    p.add_argument("--dry-run", action="store_true")
    p.add_argument(
        "--yes", action="store_true",
        help="Non-interactive: skip the wet-run confirmation prompt. Use only "
             "in automation contexts where the classification preview has "
             "already been reviewed (e.g. CI replaying an audit-recorded "
             "batch). Interactive operator runs must NOT pass --yes.",
    )
    p.add_argument("--verbose", action="store_true")
    p.add_argument(
        "--audit-path",
        default=os.path.expanduser(
            "~/claude-workspace/generic/dispatcher/state/discord-bootstrap-audit.jsonl"
        ),
    )
    args = p.parse_args()

    # Load archive.
    print(f"Reading archive: {args.archive}")
    records = load_archive(args.archive)
    print(f"  {len(records)} channels/threads in extract")

    # Classify.
    for r in records:
        r.entity, r.entity_reason = classify_channel(r.channel_id, r.name, r.channel_type)

    # Select batch.
    batch = select_records(
        records,
        batch_channels=args.batch_channels,
        include_channel=args.include_channel,
        exclude_channel=args.exclude_channel,
    )
    print(f"  {len(batch)} channel(s) selected for this run")

    # Show per-channel classification before doing any work.
    print("\nClassification preview:")
    by_entity: dict[str, int] = {}
    by_entity_chunks: dict[str, int] = {}
    for r in batch:
        by_entity[r.entity] = by_entity.get(r.entity, 0) + 1
        by_entity_chunks[r.entity] = by_entity_chunks.get(r.entity, 0) + r.message_count
        print(
            f"  [{r.entity:4}] {r.channel_id} {r.channel_type:14} "
            f"{r.message_count:>4} msgs  {r.name[:60]} ({r.entity_reason})"
        )
    print("\nClassification summary:")
    for entity, count in sorted(by_entity.items()):
        print(
            f"  {entity:4}: {count} channel(s), ~{by_entity_chunks.get(entity, 0)} "
            f"messages → embedding + upsert"
        )

    # Operator gate (Phase J posture rule). The prompt is the explicit
    # break between classification preview and the embedding + Supabase
    # writes. --dry-run skips the wet path entirely (no prompt). --yes
    # bypasses the prompt for automation use only.
    if args.dry_run:
        print("\n--dry-run: skipping wet ingestion entirely.\n")
    elif args.yes:
        print("\n--yes: bypassing operator confirmation (automation mode).\n")
    else:
        if not prompt_for_wet_run():
            print("\nWet ingestion declined by operator. Exiting without changes.")
            return 0

    # Initialise clients (skipped in dry-run).
    voyage_client = None
    cbs_supabase = None
    wr_supabase = None

    if not args.dry_run:
        try:
            import voyageai
            from supabase import create_client
        except ImportError as e:
            print(f"ERROR: missing python deps for wet run: {e}", file=sys.stderr)
            return 2

        voyage_key = os.environ.get("VOYAGE_API_KEY")
        if not voyage_key:
            print("ERROR: VOYAGE_API_KEY not set in environment", file=sys.stderr)
            return 2
        voyage_client = voyageai.Client(api_key=voyage_key)

        cbs_url = os.environ.get("CBS_SUPABASE_URL")
        cbs_key = os.environ.get("CBS_SUPABASE_SERVICE_ROLE_KEY")
        wr_url = os.environ.get("WR_SUPABASE_URL")
        wr_key = os.environ.get("WR_SUPABASE_SERVICE_ROLE_KEY")
        # Both pairs may be required depending on the batch's classifications.
        wants_cbs = any(r.entity == "cbs" for r in batch)
        wants_wr = any(r.entity == "wr" for r in batch)
        if wants_cbs and not (cbs_url and cbs_key):
            print(
                "ERROR: batch contains CBS-routed content but CBS_SUPABASE_URL / "
                "CBS_SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr,
            )
            return 2
        if wants_wr and not (wr_url and wr_key):
            print(
                "ERROR: batch contains WR-routed content but WR_SUPABASE_URL / "
                "WR_SUPABASE_SERVICE_ROLE_KEY not set", file=sys.stderr,
            )
            return 2
        if wants_cbs:
            cbs_supabase = create_client(cbs_url, cbs_key)
        if wants_wr:
            wr_supabase = create_client(wr_url, wr_key)

    print(f"\n{'DRY RUN' if args.dry_run else 'WET RUN'} — beginning ingestion ...\n")

    outcome = ingest_batch(
        records=batch,
        voyage_client=voyage_client,
        cbs_supabase=cbs_supabase,
        wr_supabase=wr_supabase,
        extract_date=args.extract_date,
        dry_run=args.dry_run,
        verbose=args.verbose,
    )

    print(f"\n=== Outcome ===")
    print(f"  channels processed: {outcome.channels}")
    print(f"  messages processed: {outcome.messages_processed}")
    print(f"  chunks inserted:    {outcome.chunks_inserted}")
    print(f"  redaction counts:   {outcome.redaction_counts}")
    print(f"  errors:             {len(outcome.errors)}")
    if outcome.errors:
        for err in outcome.errors[:10]:
            print(f"    - {err}")

    write_audit(args.audit_path, outcome, args)
    print(f"\nAudit appended to {args.audit_path}")
    return 0 if not outcome.errors else 1


if __name__ == "__main__":
    sys.exit(main())
