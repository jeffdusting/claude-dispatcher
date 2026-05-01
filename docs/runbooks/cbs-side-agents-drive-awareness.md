# CBS-side agents — Drive folder awareness rollout

Author: Claude Code (CC), 2026-05-01.
Status: PROPOSAL — pending operator review of the dispatcher PR that lands this runbook alongside `agent-instructions/group-exec-technology/AGENTS.md`.

## 1. Purpose

The River Programme's documentation pack now lives in CBS Drive at the
`River_CBS` folder (Drive ID `1P7sAByjFLdlLg_bBtqAK7oraeHOwHCX4`). The
**Group Exec Technology** agent gets the canonical write-aware
relationship to that folder via the `agent-instructions/group-exec-technology/AGENTS.md`
prompt that lands in the same PR as this runbook.

Other CBS-side agents (CBS Executive, Office Management CBS, Tender
Intelligence, Tender Coordination, Research CBS, Governance CBS, the
LEO subgraph, Compliance, Tech Operations Engineer, Tech QA &
Verification, Pricing and Commercial, Technical Writing) need a
smaller, **read-only** awareness addition to their prompts so they can
reference programme decisions and architecture without proposing
kanban edits. This runbook describes that smaller addition and the
apply procedure.

## 2. Read-only awareness — text to add to each CBS-side agent prompt

The text below is the canonical addition. Drop it into each agent's
`adapterConfig.promptTemplate` near the existing references to skills
and the chain-of-command — typically as a new section between the
current "Reporting Structure" and the heartbeat / routing sections.

```
## Programme documentation — read access

The River Programme's canonical documentation lives in CBS Drive at the
River_CBS folder:
https://drive.google.com/drive/folders/1P7sAByjFLdlLg_bBtqAK7oraeHOwHCX4

Reference the architecture, runbooks, diagnostics, and operator decisions
in that folder before proposing platform changes. The kanban
(https://drive.google.com/file/d/1CoG4DjW_YF1ETjo2hJHRJohhiz111n2RcAN6oZXRkec/view)
records work in flight, planned, and deferred. Read-only — propose
kanban updates by surfacing change proposals via Discord; you do not
edit the kanban directly.

A proposal that contradicts a recorded operator decision (the OD-NNN
entries in 02 — Migration Plan & Decisions / 27-river-decisions-applied)
is rejected outright unless the operator explicitly supersedes it.
```

The text is the same for every CBS-side agent. Tailor only the
placement (the "between Reporting Structure and routing" guideline)
to each agent's existing structure.

## 3. Affected agents

Per the §17 agent roster (CBS Group company `fafce870-b862-4754-831e-2cd10e8b203c`):

| Agent | UUID | Role | Heartbeat |
|---|---|---|---|
| CBS Executive | `01273fb5-3af2-4b2e-bf92-06da5dc8eb10` | executive | 2 hrs |
| Office Management CBS | `d5df66da-202b-48d2-b97b-8cf2a5536604` | general | 6 hrs |
| Tender Intelligence | `1dcabe74-9a2b-41a1-b628-a8bf6bc1970a` | tender | (per agent) |
| Tender Coordination | `69aa7cc8-0fc0-46bf-a67e-36c67f6936c2` | tender | (per agent) |
| Research CBS | `a0bb2e2a-3e16-4c86-8782-39723a12a17d` | research | (per agent) |
| Governance CBS | `beb7d905-f343-4cb2-a61b-b6b75bcd50a9` | governance | (per agent) |
| Compliance | `9f649467-c959-4ba1-9cef-d14ea5015491` | compliance | (per agent) |
| Pricing and Commercial | `43468bee-d04c-41d2-b29b-1edc060d558f` | commercial | (per agent) |
| Technical Writing | `31230e7a-f4f0-440f-a214-5abca42e7140` | content | (per agent) |
| LEO Lead Advisor | `7fff3b25-bce6-475d-9862-218e1ad2e3a8` | LEO | (per agent) |
| LEO Commercial Advisor | `d8f1213a-1297-44b6-a574-e9908828eb23` | LEO | (per agent) |
| LEO Content Producer | `cf9479ad-0566-4ef5-a34d-36c5fad9eae0` | LEO | (per agent) |
| LEO Technical Architect | `7512c527-ac68-4e42-9123-7cad2500e5e3` | LEO | (per agent) |
| LEO Engagement Manager | `0c7769a4-d215-41e7-9685-8fc5c40e2de1` | LEO | (per agent) |
| LEO Regulatory Analyst | `18821dea-4695-4e92-9d41-0c01c4e56786` | LEO | (per agent) |
| Tech Operations Engineer | `83f7b451-0f81-442b-befd-37b6ede5eb4b` | engineer | 5 min |
| Tech QA & Verification | `dbad7afd-64a4-4256-9ba9-df0fa20f08ab` | QA | (per agent) |

The **Group Head of Technology** (`d55043f4-cc83-4f0b-83e8-cb043f90d548`)
gets the larger Drive-references content from `agent-instructions/group-exec-technology/AGENTS.md`,
not the smaller read-only block above. Apply the larger content to
that agent only.

The **River Monitor** agent (`ebb2bbf3-...`) is retired and has its
heartbeat disabled (twenty-fourth session WAT-179 closure); skip.

## 4. Apply procedure

### 4.1 Pre-flight

Confirm the PR that lands this runbook is **merged** on `dispatcher`
origin/main. CC's apply step in §4.2 is gated on the merge.

### 4.2 Group Exec Technology — apply

Apply `agent-instructions/group-exec-technology/AGENTS.md` to the
Paperclip agent record. The shape:

```
PATCH /api/agents/d55043f4-cc83-4f0b-83e8-cb043f90d548
Content-Type: application/json
Cookie: __Secure-better-auth.session_token=<session>

{
  "adapterConfig": {
    ... existing adapterConfig ...,
    "promptTemplate": "<full content of agent-instructions/group-exec-technology/AGENTS.md>"
  }
}
```

Verify HTTP 200 and inspect the response for the new prompt content.

### 4.3 Other CBS-side agents — apply

For each of the agents in §3 (excluding Group Exec Technology and
River Monitor):

- Pull current `adapterConfig.promptTemplate`.
- Insert the §2 read-only awareness block at the position described in §2.
- PATCH back via `PATCH /api/agents/{id}` with the merged
  `adapterConfig`.
- Verify HTTP 200.

CC writes the apply script after PR merge as a one-shot
`scripts/apply-drive-references-prompt-update.py`. The script reads
the current `promptTemplate` for each agent, idempotently inserts the
§2 block (skipping agents that already have the block), and PATCHes
back. The script does NOT run autonomously — operator runs it from
their shell with the same `op read 'op://CoS-Dispatcher/paperclip-auth/...'`
auth pattern that the wet-run command uses.

### 4.4 Verification

After all PATCHes complete, trigger one heartbeat per affected agent
via `POST /api/agents/{id}/heartbeat/invoke`. Confirm:

- The heartbeat run completes without error.
- The agent's first comment (or response) on a relevant heartbeat-driven
  issue references the kanban or the canonical Drive folder, indicating
  the new prompt content has taken effect.

## 5. Rollback

If the PATCH applies a prompt that breaks an agent's behaviour, roll
back by re-PATCHing the previous `promptTemplate`. CC stashes each
agent's pre-update `promptTemplate` to
`/tmp/g6-drive/prompt-backup-<agent-uuid>-2026-05-01.txt` during the
apply run; rollback uses that file directly.

## 6. Document control

Author: Claude Code (CC), 2026-05-01.
Cross-references: OD-031 (skill versioning discipline; same source-of-truth
discipline applied here to agent prompts under
`dispatcher/agent-instructions/`); R-156 (kanban entry for the broader
prompt-bundle work); the Drive folder structure proposal at
`docs/runbooks/drive-folder-structure-proposal.md` in the
`river-migration` repo.
