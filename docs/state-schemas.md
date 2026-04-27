# Dispatcher state schemas

This document is the canonical reference for every state file the
dispatcher persists, the writer modules that own each file, and the
on-disk version where versioning applies. It exists to satisfy the
DA-001 finding from architecture review 03 (data architecture) and
was first published under Migration Plan §4.6.4 (Phase A.6).

Conventions:

1. All state files live under `STATE_DIR` (default `state/` in dev,
   `/data/state/` on the Fly machine via the `STATE_DIR` environment
   variable from Phase A.4).
2. All writes are atomic via `writeJsonAtomic` (see
   `src/atomicWrite.ts`) — temp file + rename onto target. The D-001
   audit closed under Phase A.4 (see `src/atomicWrite.ts` header).
3. Schema versions are integers stored in a `schemaVersion` field.
   Readers tolerate older versions by filling in defaults; the
   on-disk record is rewritten when the next legitimate writer runs,
   or eagerly via a backfill script.
4. Where the schema lacks a `schemaVersion` field, the file is
   treated as version 1 by default. Versioning is added when the
   first non-additive change lands.

---

## 1. Files indexed in this document

The following table indexes every state artefact, its location, the
module that writes it, and its current schema version.

| File | Path (relative to `STATE_DIR`) | Writer | Schema version | Versioned field present |
|---|---|---|---|---|
| Sessions registry | `sessions.json` | `src/sessions.ts` | 1 | no |
| Permanent thread → session map | `thread_sessions.json` | `src/threadSessions.ts` | 1 | no |
| Health snapshot | `health.json` | `src/health.ts` | 1 | no |
| Daily health reports | `health/<YYYY-MM-DD>.json` | `src/health.ts` | 1 | no |
| Channel ingest cursors | `ingest-cursors.json` | `src/ingest.ts` | 1 | no |
| Known channels registry | `known-channels.json` | `src/config.ts` | 1 | no |
| Agent-stale flag | `agents-stale.json` | `src/agentSync.ts` | 1 | no |
| Continuation descriptors | `continuations/<threadId>.json` | `src/continuation.ts` | 1 | no |
| Project descriptor (active) | `projects/<projectId>.json` | `src/projects.ts` | 2 | yes |
| Project descriptor (archived) | `projects/archive/<projectId>.json` | `src/projects.ts` | 2 | yes |
| Project kickoff request | `project-kickoff-inbox/<projectId>.json` | `src/kickoffInbox.ts` | 1 | no |
| Project kickoff (rejected) | `project-kickoff-inbox/.rejected/<ts>-<file>` | `src/kickoffInbox.ts` | 1 | no |
| Outbox manifest | `<OUTBOX_DIR>/.outbox-manifest.json` | `src/outboxManifest.ts` | 1 | yes |
| Channel ingest data | `channels/<channelId>/...` | `src/ingest.ts` | n/a (raw text) | n/a |

Files written by ad-hoc scripts (e.g. the Leo monitor heartbeat backups
under `state/leo-heartbeat-backup-*.json`) are not formal state and are
not covered here.

---

## 2. Project descriptor — current schema (v2)

The project descriptor is the canonical state of a Mode-3 project (a
PM-driven, multi-worker piece of work). Phase A.6 elevated this from
v1 to v2 by adding `entity`, `paperclipTaskIds`, `correlationId`, and
`schemaVersion`.

### 2.1 Field reference

The full field set is defined in `src/projects.ts` (`ProjectRecord`).
The fields below are the v2 canonical shape.

1. `id`: string — `p-<8 hex>`. Stable for the lifetime of the project.
2. `name`: string — short human-readable label, capped at 120 chars.
3. `brief`: string — Jeff's original brief.
4. `threadId`: string | null — Discord thread the PM posts into; null
   between project creation and thread provisioning.
5. `originThreadId`: string — the CoS thread that spawned this project.
6. `status`: `'planning' | 'running' | 'blocked' | 'complete' | 'cancelled' | 'failed'`.
7. `createdAt`: number — epoch ms.
8. `updatedAt`: number — epoch ms; rewritten on every `updateProject` call.
9. `maxParallelWorkers`: number — concurrency ceiling for parallel
   workers within this project. Default 3, max 5.
10. `tasks`: array of `ProjectTask` — see `src/projects.ts`.
11. `artifacts`: array of `ProjectArtifact` — outbox paths.
12. `summary`: string (optional) — final summary written at completion.
13. `log`: array of `{ at: number; note: string }` — bounded to last
    50 entries.
14. `entity`: `'cbs' | 'wr'` — owning entity (Phase A.5/A.6). Drives
    Drive routing and KB credential scoping.
15. `paperclipTaskIds`: string[] — Paperclip task IDs linked to this
    project; `[]` if no Paperclip linkage.
16. `correlationId`: string — UUID used for end-to-end audit
    reconstruction (Δ DA-013, OD-027). Generated at creation;
    propagated through logs, worker spawn env, outbox file headers,
    Drive metadata, and KB entries (Phase A.11 wires propagation).
17. `schemaVersion`: number — currently `2`. v1 records lack fields
    14–17 entirely.

### 2.2 Version history

- v1 (pre-Phase-A.6): fields 1–13. No version marker. Entity defaulted
  to `'cbs'` at every dispatcher call site (`DEFAULT_ENTITY`).
- v2 (Phase A.6): fields 1–17 added. Backfill script
  `scripts/backfill-project-descriptors.ts` migrates v1 → v2. Readers
  (`normaliseProjectRecord` in `src/projects.ts`) tolerate v1 by
  filling defaults at read time.

### 2.3 Writers

The writers that produce v2 records are listed below.

- `createProject()` — sets all v2 fields; `correlationId` from
  `randomUUID()`; `entity` from caller (defaults to `DEFAULT_ENTITY`);
  `paperclipTaskIds` initialised to `[]`; `schemaVersion` set to the
  exported `PROJECT_SCHEMA_VERSION` constant.
- `updateProject()` — preserves whatever the caller's mutator
  produced. Mutators receive a v2-shaped record (the reader
  normalises) and should not strip v2 fields.
- `archiveProject()` — copies the live record into the archive dir;
  the v2 shape is preserved verbatim.

### 2.4 Readers

`getProject()` and `getArchivedProject()` route through
`readProjectFile()`, which calls `normaliseProjectRecord()`. Readers
always see a v2-shaped record regardless of the underlying file's
version. The on-disk version is unchanged until a writer rewrites
the file.

---

## 3. Outbox manifest — current schema (v1)

`outboxManifest.ts` writes `<OUTBOX_DIR>/.outbox-manifest.json`. The
manifest is keyed by relative outbox path; each entry records the
Drive file ID, web view link, upload time, size, and local mtime.
The schema is versioned (the file embeds a top-level `version`
field) per DA-001; the reader is tolerant of forward-compat additions
per the same finding.

---

## 4. Files that are not yet versioned

The remaining state files (sessions, threadSessions, health,
ingest-cursors, known-channels, agents-stale, continuations,
kickoff inbox) currently lack a `schemaVersion` field. They are
treated as version 1 by definition. The next non-additive change to
any of these triggers the same versioning + backfill pattern Phase
A.6 applied to project descriptors:

1. Add `schemaVersion` to the on-disk shape.
2. Bump the writer to set the new version.
3. Add a tolerant reader that can ingest v1 records.
4. Provide a backfill script for in-flight files.
5. Update §1 of this document.

---

## 5. Document control

| Item | Value |
|---|---|
| Document | Dispatcher state schemas |
| Status | Active |
| First published | Phase A.6 (River migration) |
| Owner | Dispatcher maintainer |
| Companion | `src/projects.ts`, `src/atomicWrite.ts`, `src/outboxManifest.ts` |
