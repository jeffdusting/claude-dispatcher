---
name: cross-entity-mail-intake
description: Read mail at a CBS-domain mailbox, filter for WR-relevant content, and route the matched items into the WaterRoads-routed pipeline (WR Drive, WR Supabase trace block, or Paperclip task). The skill is the canonical example of the cross-entity-write pattern — reads from CBS, writes to WR, with audit logging that flags the cross-entity flow as exception rather than routine.
version: 0.1.0
status: active
source-of-truth: ~/claude-workspace/generic/skills/cross-entity-mail-intake/SKILL.md
last-updated: 2026-04-29
consumers:
  - office-management-wr (WaterRoads — resolves WAT-13, WAT-15, WAT-20, WAT-22)
  - kb-manager-wr (WaterRoads — forward referrals to the WR knowledge base)
  - dispatcher worker spawn (post-A.5.3 — entity-scoped invocation; required because the skill needs both CBS-side and WR-side credentials in the same worker)
---

# cross-entity-mail-intake

## 1. Purpose

The skill closes the capability gap surfaced by Architecture Review 4 finding A-003: four WaterRoads tasks (WAT-13, WAT-15, WAT-20, WAT-22) were blocked for more than eight days at the time of the migration baseline because the agents had no mechanism to read mail arriving at a CBS-domain address (`jeff@cbs.com.au`) and route it into a WR-domain pipeline. The skill is the explicit cross-entity bridge — reads from CBS, writes to WR, audit-logged as a cross-entity exception rather than as routine traffic.

The skill is paired with a blocked-task escalation behaviour added in the same Phase G.5 deliverable (Migration Plan §11.3): any Paperclip task blocked for more than three days produces a Discord notification to the relevant principal. The skill resolves the immediate capability gap; the escalation behaviour prevents future capability gaps from accumulating eight days of silent block.

## 2. When to use

Use the skill when an agent needs to receive content that arrives at a CBS-domain mailbox but belongs operationally to WaterRoads. The four canonical examples are the originally-blocked tasks: PPP correspondence sent to `jeff@cbs.com.au` (Rhodes-Barangaroo NSW Government engagement), WREI broker pipeline replies from prospects who have only the CBS-domain address on file, ferry-operator regulatory mail (Maritime Safety NSW, Transport NSW), and Sarah-via-Jeff forwards where Sarah's reply chain anchors at the CBS-domain address.

Do not use the skill for routine WR-domain mail that arrives at a WR-domain mailbox — the existing `graph-mail-read` skill handles that directly within the WR-credentialed worker. The cross-entity skill is the explicit exception path; treating it as a routine reader for ordinary WR mail dilutes the audit signal and makes cross-entity flow harder to track.

Do not use the skill for the inverse direction (WR-domain mailbox → CBS pipeline). That direction is rare in practice and would warrant a separately-named skill (`cross-entity-mail-intake-reverse` or similar) so the audit trail remains directional. If the operator's mail-arrival pattern shifts to need the inverse, a follow-on skill is the path; do not parameterise this skill bidirectionally.

## 3. Inputs

The skill takes the following parameters:

3.1 `source-mailbox` — required. The CBS-domain mailbox address to read from. Currently `jeff@cbs.com.au`. Other addresses can be added once they have a Microsoft Graph delegated-permission grant on the CBS Office 365 tenant.

3.2 `filter` — required. A JSON object describing the content filter. Supported keys:

- `senders` — list of address patterns (literal or glob, e.g., `*@waterroads.com.au`, `*@nsw.gov.au`).
- `subject-patterns` — list of subject regex patterns (e.g., `^RE: WR-STR-`, `\\[WR\\]`, `Rhodes`, `Barangaroo`, `ferry`, `PPP`, `WREI`).
- `attachment-types` — list of file extensions or MIME types from senders that pass the sender filter (e.g., `[".pdf", ".docx"]`).
- `lookback-hours` — integer hours to scan back from the current time. Default 24.

The filter is per-consumer; Office Management WR uses one filter, KB Manager WR uses a different one. Filters are stored in the consumer agent's prompt template, not in the skill itself.

3.3 `output-mode` — required. One of:

- `drive-write` — write the matched item plus its attachments to the WR Drive folder under `wr/inbox/cross-entity-mail-intake/<YYYY-MM-DD>/<message-id>/`.
- `kb-trace` — post a structured trace block to the WR Supabase project (project id `imbskgjkqvadnazzhbiw`) with `entity=waterroads`, `cross_entity=true`, the correlation ID per DA-013 / OD-027, and the source-mail metadata.
- `paperclip-task` — raise a Paperclip task in WaterRoads assigned to the consumer agent (e.g., Office Management WR) with the source-mail subject as the task title, the matched body as the description, the Drive link to the attachments (if any), and metadata fields recording the cross-entity provenance.
- `all` — execute all three modes for the same matched item. Useful when an item is both KB-relevant and Office-Management-relevant.

3.4 `approval-threshold` — optional. A JSON object describing when to mark the resulting Paperclip task `in_review` rather than `open`. Supported keys:

- `large-attachment-bytes` — integer; items with attachments larger than this size are auto-`in_review`. Default 10485760 (10 MB).
- `sensitive-sender-patterns` — list of sender patterns where any match auto-routes to `in_review` regardless of size.
- `financial-figure-detected` — boolean; when true, body content matching a basic financial-figure regex (`\$[\d,]+`, `AUD\s*[\d,]+`, etc.) auto-routes to `in_review`.

Items routed to `in_review` produce a Teams notification per the standard escalation pattern, addressed to the consumer agent's Tier 1 escalation path (currently WR Executive; soon Sarah's EA Quinn per OD-035 / Phase J.1b).

## 4. Outputs

The skill returns a structured object summarising the run:

- `items-scanned` — count of mail items inspected during the lookback window.
- `items-matched` — count of mail items that passed the filter.
- `items-routed` — count of items successfully routed via the chosen output-mode (or modes, if `all`).
- `items-in-review` — count of items that hit an approval threshold and were routed to `in_review` rather than `open`.
- `items-failed` — count of items that matched the filter but failed routing (for example, Drive write failed or Paperclip task creation timed out). Each failure includes the source-message ID and the error code.
- `correlation-ids` — list of correlation IDs assigned to the matched items, for downstream audit reconstruction.

## 5. Credential pattern

The skill is the canonical cross-entity exception. Three credentials are required in the same worker environment:

5.1 The first credential is the CBS-side Microsoft Graph token with `Mail.Read` scope on the source mailbox. Loaded into `CBS_GRAPH_TOKEN` by the dispatcher worker spawn when the spawning project descriptor declares `cross-entity-mail-intake` in the worker's skill list. Without this declaration the credential is not loaded — the skill cannot be used opportunistically by a worker that was not configured for it.

5.2 The second credential is the WR-side Supabase service-role key (`WR_SUPABASE_SERVICE_ROLE_KEY`) and the WR Supabase URL (`WR_SUPABASE_URL`). Required for the `kb-trace` output mode.

5.3 The third credential is the WR-side Drive service account (`WR_DRIVE_SA_JSON`) and Paperclip token (`WR_PAPERCLIP_TOKEN`). Required for `drive-write` and `paperclip-task` output modes respectively.

The dispatcher worker spawn loads all three credentials only because the project descriptor declares this skill explicitly. The `scopeWorkerEnv` pattern from A.5.3 / OD-031 is the underlying mechanism — by default a worker is single-entity scoped; the cross-entity skill is the explicit opt-in that requests both sides.

If any credential is missing the skill fails fast with `MISSING_CREDENTIAL` and the missing variable name. The failure is recorded in the trace pipeline as a cross-entity-skill-misconfiguration audit event.

## 6. Audit pattern

Every cross-entity-mail-intake execution writes audit records to both entity shards.

6.1 The first audit shard is the CBS-side trace. Records the mail-read action — message ID, sender, subject, timestamp, the filter that matched, the correlation ID. Written to the CBS Supabase audit table (which is part of the CBS knowledge base — separate from the document corpus). The CBS shard is the read-side audit.

6.2 The second audit shard is the WR-side trace. Records the routing action — output-mode chosen, destination (Drive URL, Paperclip task ID, or KB trace block ID), the correlation ID. The correlation ID is identical to the CBS shard's, so an operator inspecting either side can reconstruct the cross-entity flow.

6.3 Both shards have `cross_entity=true` set on every audit row, so cross-entity audit queries surface only the exception traffic without mixing in routine same-entity flow.

## 7. Failure modes

7.1 `MISSING_CREDENTIAL` — one of the three credential sets in §5 is not in the worker environment. The skill fails fast and surfaces which credential is missing. The dispatcher worker spawn is the most likely fix.

7.2 `MAILBOX_AUTH_FAILED` — the CBS Graph token authenticates but does not have `Mail.Read` on the source mailbox. Operator-side fix in the Microsoft 365 admin centre.

7.3 `FILTER_CONFIG_INVALID` — the filter object did not parse (regex error, unknown key, etc.). The skill fails before scanning the mailbox; no items are read.

7.4 `OUTPUT_FAILED` — one or more matched items failed routing. The error is per-item, not for the whole run; the run completes with `items-failed > 0` and the per-item error codes in the response. Common causes: WR Drive folder permission drift, Paperclip task creation rate limit, WR Supabase row insert constraint violation.

7.5 `RATE_LIMITED` — Microsoft Graph or Paperclip API returned a rate-limit response. The skill applies the standard exponential-backoff retry from the resilience layer (Phase A.9). After retry exhaustion, the error propagates.

## 8. Versioning and changelog

The skill follows semver. Breaking changes (parameter renames, removal of output fields, change in default approval-threshold behaviour) bump the major version. Additive changes (new filter key, new output-mode, new approval-threshold key) bump the minor. Bug fixes bump the patch.

### 8.1 Changelog

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-04-29 | Initial SKILL.md authored under Phase G.5 / A-003 and A-007. Born under the §3 versioning discipline (version, changelog, consumers list). Resolves the four-task block on Office Management WR (WAT-13, WAT-15, WAT-20, WAT-22). |

## 9. Related artefacts

The first related artefact is **Architecture Review 4 finding A-003** — the underlying capability gap this skill closes.

The second is **Architecture Review 4 finding A-007** — the skill versioning discipline this metadata block is born under.

The third is **Migration Plan v1.1 §11.2** — the Phase G.5 deliverable that authorises the skill.

The fourth is **Architecture v2.1 §6** plus **Review 3 finding DA-005** — the credential-scoping pattern the cross-entity exception sits inside.

The fifth is **Decisions Applied OD-027 and OD-035** — the correlation-ID propagation that the audit shards rely on, and the EA-name resolution (Quinn) for the future escalation path.

The sixth is the runbook record at `claude-workspace/generic/river-migration/docs/runbooks/agent-platform-preflight.md` §2 — the operator-facing description of how the skill lands in production, including the Paperclip UI actions required to wire it into Office Management WR's toolset and to reset the four blocked WAT tasks.

## 10. Document control

| Item | Value |
|---|---|
| Skill | cross-entity-mail-intake |
| Source of truth | `~/claude-workspace/generic/skills/cross-entity-mail-intake/SKILL.md` |
| Status | Active |
| Author | CBS Group, drafted with Claude Code |
| Update cadence | Append-only changelog; bump version on any consumer-visible change. Consumers list updated synchronously with agent-recruitment and agent-retirement actions. |
