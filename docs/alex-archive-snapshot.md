# Alex Morgan archive snapshot — Phase J.1a §14.3.1

Frozen-in-time reference of Alex Morgan's pre-J.1a state. Produced as
the in-place migration's reversion baseline. The actual artefacts are
preserved through git history (agent definition, dispatcher source)
and through the existing project descriptors on disk; this manifest is
the durable index of what counts as "Alex's pre-J.1a state" so a
future operator (or Claude Code) can locate the baseline material
without reconstructing it.

The snapshot is taken on 2026-04-30 against dispatcher
`origin/main` HEAD `803fede` (PR #35 squash-merge — multi-EA
scaffolding §14.2.1–14.2.3). The Phase J.1a in-place migration that
follows is built on this baseline.

---

## 1. Agent definition baseline

1.1 Source: `dispatcher/.claude/agents/chief-of-staff.md` at SHA
`803fede` (the commit immediately before the §14.3.4 update in this
PR). The post-update version of the file lives at the PR's HEAD; the
pre-update content is reachable via:

```
git show 803fede:.claude/agents/chief-of-staff.md
```

1.2 The pre-J.1a definition omitted the multi-EA architecture
awareness section, the explicit "you serve Jeff Dusting only"
directive, and the partition-scoped state references. Phase J.1a
§14.3.4 added all three.

1.3 No alternative agent definition for Alex existed pre-J.1a — the
single `chief-of-staff` definition was the canonical source. Nothing
else needs preservation under this heading.

---

## 2. Project descriptors at snapshot

The snapshot covers every project descriptor on disk where Alex was
the responsible agent. Pre-J.1a the dispatcher served Alex only, so
this is the union of `state/projects/*.json` and
`state/projects/archive/*.json`.

### 2.1 Active projects

The active descriptors at snapshot time (`state/projects/*.json`):

  - `p-173549a3` — "Dispatcher cloud migration to Fly.io" — entity
    `cbs`, status `blocked`.
  - `p-690de71c` — "WR R&DTI FY2024-25 Full Registration" — entity
    `wr`, status `blocked`.

### 2.2 Archived projects

The archived descriptors at snapshot time
(`state/projects/archive/*.json`):

  - `p-1147eb3c` — "WREI Activation under WaterRoads" — `wr`, `cancelled`.
  - `p-170c9c00` — "Heritage Timber Bridge Paper — v4→v5 peer review cycle" — `cbs`, `complete`.
  - `p-1ac621bf` — "Smoke test" — `cbs`, `complete`.
  - `p-2f796375` — "Simanta Das investor DD" — `cbs`, `complete`.
  - `p-3035e9ce` — "Dispatcher cloud migration" — `cbs`, `complete`.
  - `p-380219ba` — "Paperclip stall investigation" — `cbs`, `complete`.
  - `p-4187396d` — "Cloud migration plan v2 — review and Option F roadmap" — `cbs`, `complete`.
  - `p-5fa04952` — "Heritage Timber Bridge Paper — v3→v4 peer review cycle" — `cbs`, `complete`.
  - `p-74e9f6fe` — "Comprehensive package + cloud-developer plan" — `cbs`, `complete`.
  - `p-79aa88bb` — "Paperclip + dispatcher comprehensive package and cloud-developer plan" — `cbs`, `complete`.
  - `p-7d014e4a` — "LEO site content port" — `cbs`, `complete`.
  - `p-8aeff807` — "Codebase audit and migration plan reconciliation" — `cbs`, `complete`.
  - `p-a8a735bb` — "Simanta Das DD" — `cbs`, `complete`.
  - `p-b5edf675` — "WREI Automated Business Activation" — `wr`, `complete`.
  - `p-db98ee91` — "Heritage Timber Bridge Paper — Peer Review & v4" — `cbs`, `complete`.
  - `p-ff1bb123` — "Heritage Timber Bridge Composite Repair — Technical White Paper" — `cbs`, `complete`.

### 2.3 Owning-EA backfill

Phase J.1a §14.3.2 re-tags every descriptor in §2.1 and §2.2 with
`owningEA: "jeff"` via the backfill script
(`scripts/backfill-project-descriptors.ts`). The schemaVersion field
advances 2 → 3. The pre-backfill values are recoverable from git
history of any committed descriptors, or from the R2 nightly backup
of state for runtime-only descriptors.

---

## 3. Drive outputs

3.1 The CBS Drive parent folder
(`1P7sAByjFLdlLg_bBtqAK7oraeHOwHCX4`, architecture v2.1 §5.2)
contains every CBS-tagged Drive artefact Alex produced pre-J.1a. The
folder is the pre-J.1a Drive root; structurally unchanged by the
migration.

3.2 The WR Drive root used by the existing WaterRoads service
account (`waterroads@waterroads.com.au` SA per Migration Plan §5.6)
contains every WR-tagged Drive artefact Alex produced pre-J.1a.
Structurally unchanged by the migration.

3.3 No filesystem-level archive of Drive content is made — Drive is
the canonical source of truth. The folder IDs and the SA credentials
are the recovery handles.

---

## 4. Trace data

4.1 Pre-redaction originals at `$STATE_DIR/traces-original/` (0700
permissions). Phase J.0 (PR #34) introduced redaction; pre-J.0
traces predate redaction entirely and are still available in raw
form on disk.

4.2 Redacted partitioned output at `$STATE_DIR/traces/` — pre-J.1a
output here was implicitly partitioned to `traces/jeff/` by the
redact-traces script's default-EA fallback. Post-J.1a the
partitioning is descriptor-driven via the `owningEA` field added in
§14.3.2.

---

## 5. Reversion playbook

If the in-place migration needs to be reverted (e.g. operator
discovers a critical bug post-migration), the steps are:

5.1 Revert the dispatcher PR for §14.3 in git. The chief-of-staff
agent definition reverts to the pre-J.1a baseline at SHA `803fede`.

5.2 Roll back the project-descriptor backfill via the inverse pass
of `scripts/backfill-project-descriptors.ts` (or restore from R2
nightly backup). The schemaVersion field reverts 3 → 2; the
`owningEA` field is dropped.

5.3 Drive outputs require no reversion — they were untouched by the
migration.

5.4 Trace partitioning reverts naturally as the redact-traces script
falls back to the default EA when the descriptor lacks `owningEA`.
No further action required.

---

## 6. Document control

Author: Claude Code (Migration Plan §14.3.1).
Snapshot date: 2026-04-30.
Baseline SHA: `803fede` (dispatcher origin/main; PR #35 squash).
Source of truth: this file in `dispatcher/docs/`.
Cross-references: Migration Plan §14.3 (Phase J.1a Alex in-place
migration); architecture v2.1 §5.1 (state partition), §5.2 (Drive
routing), §6.6 (trace partitioning).
