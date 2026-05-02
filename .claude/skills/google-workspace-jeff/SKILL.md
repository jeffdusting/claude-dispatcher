---
name: google-workspace-jeff
description: Read Jeff's WaterRoads Workspace mailbox and calendar (`jeffdusting@waterroads.com.au`); create Gmail drafts (no send); create, modify, accept, and decline calendar events. Send-as-Jeff is intentionally absent — drafts only. Future graduation of specific email-types to autonomous send is tracked under R-952 (approval-lane port from the pre-migration laptop runtime).
version: 0.1.0
status: active
source-of-truth: ~/claude-workspace/generic/skills/google-workspace-jeff/SKILL.md
last-updated: 2026-05-01
consumers:
  - chief-of-staff (Alex Morgan — Jeff's EA)
---

# google-workspace-jeff

## 1. Purpose

The skill restores Alex Morgan's pre-migration capability to read Jeff's WaterRoads Gmail and Calendar and to act on his behalf within a strict drafts-only safety boundary. The capability existed on the laptop runtime at `~/claude-workspace/alex-morgan/runtime/` (`gmail_tools.py`, `calendar_tools.py`, `google_auth.py`, `google_tasks.py`) and was not ported to the cloud dispatcher during Phase J.1a's in-place migration. This skill is the cloud-side replacement.

The skill is the parallel WR-side capability to `cross-entity-mail-intake` (CBS-side, Microsoft Graph). Both skills follow the same pattern: documentation-driven, dispatcher loads the credential into the worker's env at boot, agent reads the SKILL.md and invokes the helper scripts via Bash.

## 2. When to use

Use the skill when Alex needs to:

- 2.1 Read Jeff's recent inbox or a specific thread to surface, summarise, or act on inbound mail.
- 2.2 Draft a reply or new email on Jeff's behalf for Jeff to review and send.
- 2.3 Read Jeff's calendar to answer scheduling questions or detect conflicts.
- 2.4 Create, modify, accept, or decline calendar events on Jeff's behalf. Calendar is read+write; the SA's `https://www.googleapis.com/auth/calendar` scope was admin-approved on the WR Workspace pre-migration.

Do not use the skill for any send-as-Jeff path. The Gmail SA scope is `gmail.modify`, not `gmail.send` — drafts work, sending does not. The drafts-only boundary is deliberate per the operator's standing rule (Alex creates drafts, Jeff reviews and sends from his own client). Future graduation of specific email-types to autonomous send is tracked under R-952; until R-952 lands, **every Alex outbound is a draft**.

Do not use the skill against any account other than `jeffdusting@waterroads.com.au`. The application-layer allow-list in `auth.ts` rejects any other principal even if the Workspace DWD config would otherwise permit it (defence-in-depth).

## 3. Authentication

3.1 The skill uses the `alex-morgan-runtime@waterroads-alex-morgan.iam.gserviceaccount.com` service account with Workspace domain-wide delegation. The SA impersonates `jeffdusting@waterroads.com.au` only.

3.2 The SA JSON key is stored in `op://CoS-Dispatcher/drive-wr-alex-morgan/sa-json`. The dispatcher's `entrypoint.sh` materialises the key to `/data/.secrets/wr-alex-morgan-gcp-sa.json` (mode 0600, owner `dispatcher:dispatcher`) and exports the path as `WR_ALEX_MORGAN_SA_KEY_PATH` so workers can read it.

3.3 The DWD allow-list at the WR Workspace admin level was configured pre-migration with the following scopes for the SA:

- `https://www.googleapis.com/auth/gmail.modify` — read inbox, create drafts, modify labels. **No send.**
- `https://www.googleapis.com/auth/calendar` — full read+write on calendars Alex can see (primary plus any calendars shared with `jeffdusting@waterroads.com.au`).
- `https://www.googleapis.com/auth/contacts.readonly` — read contacts for sender disambiguation.
- `https://www.googleapis.com/auth/drive.file` — file-scoped Drive access.
- `https://www.googleapis.com/auth/tasks` — Google Tasks read+write.

3.4 The skill ships helper scripts for Gmail (§4) and Calendar (§5). Tasks and Drive scopes are present in the SA but no helper script ships in v0.1.0 — extend the skill in a follow-up if needed.

## 4. Gmail helper

The Gmail helper lives at `dispatcher/scripts/google-workspace/gmail.ts`. Invoke via Bash:

```bash
bun /app/scripts/google-workspace/gmail.ts <subcommand> [flags]
```

Subcommands:

- 4.1 `list-unread [--max N] [--query "Q"]` — list unread (or query-matched) messages with from/to/subject/date/snippet. Default query `is:unread in:inbox`, default `--max 25`.
- 4.2 `get-message --id ID` — fetch a full message body and headers as JSON. Returns text/plain and text/html bodies separately.
- 4.3 `list-threads [--max N] [--query "Q"]` — enumerate threads with subject and snippet.
- 4.4 `get-thread --id ID` — fetch a thread with all messages.
- 4.5 `draft-reply --thread-id ID --body "B"` — create a draft reply on the thread. Subject, In-Reply-To, and References headers are derived from the last message in the thread.
- 4.6 `draft-new --to T --subject S --body B [--cc C]` — create a brand-new draft.
- 4.7 `list-drafts [--max N]` — list draft IDs with subject + recipient.
- 4.8 `delete-draft --id ID` — delete a draft.

`send` is **intentionally absent**. The Gmail helper does not implement send under any subcommand. If Alex needs to "send" something for Jeff, the path is: create a draft, surface the draft ID and a summary to Jeff via Discord, and let Jeff send from his own Gmail client.

All output is JSON to stdout. Errors print `{ ok: false, code, error }` and exit non-zero. Success prints `{ ok: true, ... }`.

## 5. Calendar helper

The Calendar helper lives at `dispatcher/scripts/google-workspace/calendar.ts`. Invoke via Bash:

```bash
bun /app/scripts/google-workspace/calendar.ts <subcommand> [flags]
```

Subcommands:

- 5.1 `list-calendars` — enumerate calendars Alex can see.
- 5.2 `list-events [--cal C] [--days N] [--max N] [--query Q]` — list events in a window. Default `--days 7`, `--max 50`, `--cal primary`.
- 5.3 `get-event --id ID [--cal C]` — fetch a single event.
- 5.4 `create-event --start S --end E --summary "S" [--description D] [--attendees a@b,c@d] [--cal C] [--location L]` — create an event. `--start` and `--end` are ISO 8601 datetime strings. Invitations are NOT sent (`sendUpdates=none`); Alex creates the event metadata, Jeff confirms before invitations dispatch.
- 5.5 `update-event --id ID [...same fields...]` — patch fields on an event.
- 5.6 `delete-event --id ID [--cal C]` — delete an event.
- 5.7 `respond --id ID --response accepted|declined|tentative [--cal C]` — set Alex's-as-Jeff response status on an invitation.

The `sendUpdates=none` default on create/update/delete is deliberate. It mirrors the drafts-only Gmail pattern: Alex prepares the calendar change, the change is visible to Jeff (and only Jeff) until Jeff explicitly authorises the invitation dispatch. If Alex needs to send invitations on a specific event, surface the event ID to Jeff and let Jeff dispatch invitations from his own Calendar client.

## 6. Approval-lane retention (R-952 forward-pointer)

The pre-migration laptop runtime included a sophisticated approval-lane mechanism in `~/claude-workspace/alex-morgan/runtime/` — `always_approval.py`, `approval_sweep.py`, lane classifiers, and the `always-approval-list.json` overlay. That system graduated specific email-types from approval-lane (drafts) to autonomous-lane (auto-send) based on counterparty, sender, and topic classification.

This skill's v0.1.0 ships drafts-only. All Alex Gmail outbound is a draft regardless of email-type. The approval-lane port is queued under kanban R-952 (next-development-cycle item). Until R-952 lands, treat this skill as the foundation and respect the drafts-only safety property.

R-952's scope (when it activates):

- 6.1 Port `always_approval.py` to TypeScript with the same overlay categories (board/investor/regulator/government/legal counterparty types; explicit counterparty IDs; Jeff-personal list; non-empty `jeff_only_topics`).
- 6.2 Add lane classification at draft-creation time — every draft carries an explicit `lane` tag.
- 6.3 Add a graduation config that names which lanes Alex may auto-send for. Default is empty (drafts-only).
- 6.4 Implement the approval-queue auto-sweep (delete stale drafts whose threads Jeff has already replied to from his own client).
- 6.5 Audit-log every auto-send with the lane reason and the classifier confidence.

## 7. Errors

The helpers report errors with structured codes for the agent to handle:

- 7.1 `NO_KEY_PATH` — `WR_ALEX_MORGAN_SA_KEY_PATH` env var not set. Dispatcher boot bug; surface to operator.
- 7.2 `KEY_FILE_UNREADABLE` — env var points to a file that does not exist or cannot be read. Operator-side credential failure.
- 7.3 `KEY_FILE_INVALID_JSON` — file contents are not valid JSON. Vault corruption — escalate.
- 7.4 `PRINCIPAL_NOT_ALLOWED` — application-layer guard rejected an attempted impersonation outside `jeffdusting@waterroads.com.au`. This should never happen in normal operation.
- 7.5 `BAD_ARGS` — required CLI flag missing.
- 7.6 `UNKNOWN_COMMAND` — invalid subcommand.
- 7.7 `EMPTY_THREAD` — `draft-reply` was called against a thread with no messages (impossible in normal operation).
- 7.8 `API_ERROR` — Google API returned an error. The error message contains the upstream detail.

Codes 7.1–7.4 indicate a configuration or credential failure at the dispatcher layer; the agent should surface to the operator rather than retry.

Codes 7.5–7.6 indicate an Alex prompt error; Alex should adjust the invocation and retry.

Code 7.8 indicates a Google API failure (rate limit, transient unavailability, scope mismatch). Apply standard retry/backoff per the resilience layer (Phase A.9). After retry exhaustion, surface to operator.

## 8. Audit trail

Every Gmail draft creation, calendar event creation, modification, and response dispatch is recorded by Google's own audit log against the SA's identity. The `events.list`/`messages.list` operations are read-only and do not require additional dispatcher-side audit logging beyond what the worker stdout/stderr already captures.

When Phase A.11 correlation IDs are extended into the SA-impersonated calls (future hardening), the dispatcher's worker spawn will pass `CLAUDE_CORRELATION_ID` into the helper scripts and the helpers will include the ID in the User-Agent header for end-to-end tracing.

## 9. Constraints

9.1 The skill is not opportunistically usable. The dispatcher only loads `WR_ALEX_MORGAN_SA_KEY_PATH` when the cos-dispatcher container boots; if the container has never booted with the SA JSON in place, the skill is unavailable until the next deploy. The check is the same as for Drive: `statSync(saKeyPath)` returns truthy.

9.2 The application-layer allow-list in `auth.ts` is hard-coded to `jeffdusting@waterroads.com.au`. Adding `alex.morgan@waterroads.com.au` (the original SA's primary identity) is a code change, not a config change. The allow-list expansion should arrive via the same PR mechanism that gates this skill's other changes.

9.3 The Quinn-side parallel skill is at `~/claude-workspace/generic/skills/google-workspace-sarah/` (status `pending-sarah-onboarding` until Sarah's WR Workspace email is provisioned, the DWD allow-list is extended, and the SA reuse-versus-new decision is made). The two skills run in parallel — Alex never invokes Quinn's skill, Quinn never invokes Alex's.

9.4 No test fixtures use the live Workspace. Unit tests cover the auth-error paths and the argv parsing; integration tests are gated on the operator (smoke-test from the laptop with `op read` populating the SA JSON, then a single live call against `gmail.users.getProfile` and `calendar.calendarList.list`).

## 10. Document control

| Item | Value |
|---|---|
| Skill | google-workspace-jeff |
| Version | 0.1.0 |
| Status | Active |
| Source of truth | `~/claude-workspace/generic/skills/google-workspace-jeff/SKILL.md` |
| Helper scripts | `dispatcher/scripts/google-workspace/{auth,gmail,calendar}.ts` |
| Pair | `~/claude-workspace/generic/skills/google-workspace-sarah/SKILL.md` (Quinn-side, status `pending-sarah-onboarding`) |
| Future graduation | Kanban R-952 (approval-lane port for autonomous send) |
| Cross-references | `cross-entity-mail-intake` (CBS-side parallel, Microsoft Graph), `supabase-query` (skill convention), `agent-retirement` (skill convention) |
