---
name: agent-retirement
description: Retire an agent from the active roster — reassign or close in-flight work, remove the agent's directory from the active tree, archive its prompt template, deactivate the agent in Paperclip, and update every SKILL.md consumers list that referenced it. Counterpart to the existing agent-recruitment skill.
version: 0.1.0
status: active
source-of-truth: ~/claude-workspace/generic/skills/agent-retirement/SKILL.md
last-updated: 2026-04-29
consumers:
  - operator (manual invocation when a retirement is initiated)
  - future Recruitment Agent (if added; currently the operator is the recruiting principal)
---

# agent-retirement

## 1. Purpose

The skill provides the procedure for retiring an agent — what cleanup is required, what disposition applies to in-flight work, how the historical record is preserved. It resolves Architecture Review 4 finding A-009 ("Agent retirement and roster maintenance process undefined") and gives the operator a counterpart to the `agent-recruitment` skill so the roster can shrink as well as grow.

The skill is mostly a checklist; the underlying mechanics use existing Paperclip APIs and standard filesystem moves. The discipline the skill encodes — eight steps in fixed order — is the load-bearing part. Without that discipline, retired agents leave residue: open Paperclip tasks reassigned haphazardly, scheduled routines pointing at removed records, SKILL.md consumers lists drifting from reality.

## 2. When to use

Use the skill when the operator has decided to retire an agent and wants the cleanup performed under the documented discipline. Three triggering scenarios:

The first scenario is duplicate consolidation. The duplicate River Monitor (A-001) is the canonical case at the time of authoring; the apparent `<name> 2.md` duplicates of CBS-side agents in `River/agent-instructions/` are likely candidates pending operator confirmation. Investigation under A-001 surfaces which copy is the artefact; the skill retires the artefact while preserving the active copy.

The second scenario is post-launch consolidation. The four-week WREI granularity audit (A-004) may identify specialists that are consistently under-loaded and whose scope can be absorbed by their Tier 2 lead. WREI Office Management is a possible target; the audit makes the call.

The third scenario is replacement-by-skill. If a skill addition supersedes an agent's reason for existing — for example, a future "Mailroom" skill that replaces the current per-EA mailroom agent design — the agent retires and its consumers (Paperclip tasks, scheduled routines, SKILL.md consumers lists) migrate to the replacement skill or to other agents.

Do not use the skill for temporary suspension. If an agent should pause but not retire, set its Paperclip status to `paused` (or whichever status removes the agent from active heartbeat without archiving). Retirement is irreversible without explicit recruitment-from-archive, which is heavier than a temporary pause warrants.

## 3. Inputs

The skill takes the following parameters:

3.1 `agent-name` — required. The directory name under `~/Desktop/Projects2/River/agent-instructions/`. Lowercase with hyphens.

3.2 `paperclip-id` — required. The Paperclip platform ID of the agent record. Used in the historical-roster entry for durable identification across any future archive lookups.

3.3 `retirement-reason` — required. One of:

- `duplicate` — retiring the artefact copy from a duplication. Pair with `replacement-agent` if the active copy has a different name.
- `consolidated` — the agent's scope has been absorbed by another agent. Pair with `replacement-agent`.
- `replaced-by-skill` — the agent's reason for existing has been replaced by a new skill. Pair with `replacement-skill`.
- `role-no-longer-needed` — the role has been removed from the operating model (e.g., a tender portal that no longer exists, a function the operator now handles directly). No replacement; the agent's work simply stops being done by an agent.

3.4 `replacement-agent` — optional. The name of the agent that absorbs the retiring agent's open work. Required when `retirement-reason` is `duplicate` or `consolidated`.

3.5 `replacement-skill` — optional. The name of the skill that replaces the retiring agent's function. Required when `retirement-reason` is `replaced-by-skill`.

3.6 `disposition` — required. A JSON object describing what happens to in-flight work:

- `open-tasks` — one of `reassign-to-replacement`, `set-in-review-for-operator`, or `close-as-wontfix`. Per-task overrides are listed in the optional `task-overrides` array.
- `task-overrides` — list of objects each containing `task-id` and `disposition`. Used when the default `open-tasks` disposition does not fit some specific tasks.

## 4. Outputs

The skill returns a structured summary of the retirement:

- `agent-name` — echoed from the input.
- `paperclip-id` — echoed from the input.
- `retirement-date` — ISO date of the run.
- `tasks-reassigned` — list of `{task-id, from-agent, to-agent}`.
- `tasks-in-review` — list of `{task-id, reason}`.
- `tasks-closed` — list of `{task-id, reason}`.
- `routines-rewired` — list of `{plist-name, from-agent, to-agent}` for any laptop launchd plists that referenced the retiring agent.
- `routines-removed` — list of plist names that were retired alongside the agent (e.g., a daily-status plist for a single-agent role).
- `skills-affected` — list of `{skill-name, version-before, version-after}` for SKILL.md files whose consumers list was updated.
- `roster-entry` — the historical-roster entry that was appended to `River/docs/agent-roster.md`.

## 5. Procedure

The retirement procedure has eight steps. Run them in order. Each step has explicit verification before the next step proceeds; partial state is recoverable from intermediate checkpoints.

### 5.1 Step 1 — confirm the retirement decision

5.1.1 Confirm the operator has decided to retire the agent. The decision is operator-driven (or driven by an explicit recruitment-agent recommendation that the operator ratifies); the skill does not autonomously decide to retire an agent.

5.1.2 Confirm the inputs in §3 — agent name, Paperclip ID, retirement reason, replacement (if applicable), disposition for open work. The skill fails fast if any required input is missing.

5.1.3 Record the decision intent in `~/claude-workspace/generic/river-migration/TASK_LOG.md` (or in a programme retrospective note if post-migration) at the top of the retirement run. The intent record is the audit trail's first entry; subsequent steps append to the same retirement record.

### 5.2 Step 2 — confirm no open work assigned to the agent

5.2.1 Query Paperclip for all tasks where the agent is the assignee, filtered to status `open`, `in_progress`, or `in_review`. The query returns the working set.

5.2.2 For each task in the working set, decide the disposition per the input `disposition` object. The default for `open-tasks` is the disposition that applies unless the task is named in `task-overrides`.

5.2.3 The decision step does not yet execute the disposition — it produces the planned action list. The action list is part of the audit record.

### 5.3 Step 3 — reassign or close any open Paperclip tasks

5.3.1 For each task with disposition `reassign-to-replacement`, change the assignee in Paperclip to the replacement agent. Add a comment recording the reassignment context: "Reassigned from <agent-name> on <date> as part of the agent retirement procedure (reason: <retirement-reason>)."

5.3.2 For each task with disposition `set-in-review-for-operator`, set the task status to `in_review` with a comment naming the operator and the retirement context. Send a Teams notification per the standard escalation pattern.

5.3.3 For each task with disposition `close-as-wontfix`, set the task status to `closed` with a comment recording why the work is no longer needed.

5.3.4 Wait for confirmation that each reassignment lands cleanly — the receiving agent's next heartbeat picks up the reassigned work. The skill's run record gains the actual reassignment timestamps from Paperclip rather than just the planned timestamps from §5.2.

### 5.4 Step 4 — confirm no scheduled routine references the agent

5.4.1 Inspect the laptop launchd plists under `~/Library/LaunchAgents/` for any plist whose `ProgramArguments` or environment variables reference the retiring agent by name or by Paperclip ID. Common pattern: `au.com.waterroads.alexmorgan.daily-status.plist` references the Alex Morgan EA agent.

5.4.2 Inspect the cloud-side scheduled jobs (currently nil — supercronic cadence is per-skill, not per-agent at the time of authoring). Future-proofed: query whichever cron / supercronic / scheduler-config holds cloud-side scheduled jobs.

5.4.3 For each routine referencing the retiring agent, decide between rewiring (point the routine at a replacement agent — pair with `replacement-agent` from §3) or removal (the routine retires alongside the agent). Record the decision per routine.

5.4.4 Execute the rewires and removals. For removals, archive the plist to `~/archives/launchd-decommission-<retirement-date>/` per the decommission convention from `docs/runbooks/laptop-decommission.md` §3.3.

### 5.5 Step 5 — remove the agent's directory from the active tree

5.5.1 Move (do not delete) the agent's directory from `~/Desktop/Projects2/River/agent-instructions/<agent-name>/` to `~/Desktop/Projects2/River/agent-instructions/_retired/<agent-name>-<retirement-date>/`. The historical record is preserved on disk for any future contractor or audit need; the active roster is what Paperclip reads at heartbeat.

5.5.2 The retired directory's contents (AGENTS.md, HEARTBEAT.md, SOUL.md, TOOLS.md, any other reference files) are preserved unchanged. The retirement does not edit historical content.

### 5.6 Step 6 — deactivate the agent in Paperclip

5.6.1 Navigate to the company → Agents → the retiring agent record in the Paperclip dashboard.

5.6.2 Set status to `archived` (or whichever Paperclip status removes the agent from active heartbeat without deleting the record). The Paperclip ID is preserved in the archive; the agent's prompt-template loads cease at the next scheduled heartbeat after the status change.

5.6.3 Record the Paperclip ID in the §5.7 historical-roster entry. The ID is the durable identifier across any future archive lookups regardless of display-name changes.

### 5.7 Step 7 — update SKILL.md consumers lists

5.7.1 For each skill in `~/claude-workspace/generic/skills/` whose consumers list includes the retiring agent, remove the agent from the list, bump the SKILL.md's patch version, and append a changelog entry recording the consumer removal.

5.7.2 The changelog entry follows the §5 STYLE.md format. Example: `0.2.1 | 2026-04-29 | Consumers list loses office-management-wr (retired under agent-retirement procedure; reason: replaced-by-skill; replacement-skill: cross-entity-mail-intake).`

5.7.3 The pre-merge CI hook (`CI-HOOK.md`) surfaces the consumer removals on the PR that lands the skill changes. The hook does not block the merge; the reviewer judges whether any of the consumer-side prompt templates also need updating.

### 5.8 Step 8 — record the retirement in the historical roster and audit trail

5.8.1 Append an entry to `~/Desktop/Projects2/River/docs/agent-roster.md` under a "Historical roster — retired agents" section (created on first retirement; appended on subsequent retirements). The entry includes:

- Agent name (matches the directory name in `_retired/`).
- Paperclip ID (durable identifier).
- Retirement date.
- Retirement reason (one of the four reasons in §3.3).
- Replacement (agent or skill, if applicable).
- Summary line of the cleanup performed (count of tasks reassigned / in_review / closed; count of routines rewired / removed; count of skills affected).
- Cross-reference to the audit-trail record in `TASK_LOG.md` (or the post-migration retrospective note).

5.8.2 The audit-trail record in `TASK_LOG.md` (or post-migration equivalent) is the long-form version of the retirement run — every action taken, every Paperclip ID touched, every commit hash for each affected file. The roster entry in §5.8.1 is the index into the audit trail.

## 6. Credential pattern

6.1 The skill operates against the operator's authenticated Paperclip session and the operator's local filesystem. No worker-environment credentials are required because the skill is operator-invoked, not agent-invoked.

6.2 If a future Recruitment Agent runs the skill autonomously on operator behalf, the agent inherits the operator's Paperclip credentials via the standard worker-spawn path (Paperclip token from the vault) plus filesystem write access to `~/Desktop/Projects2/River/agent-instructions/` and `~/claude-workspace/generic/skills/`. The Recruitment Agent does not yet exist; the operator is the principal at the time of authoring.

## 7. Failure modes

7.1 `MISSING_REQUIRED_INPUT` — one of the §3 required inputs is not provided. The skill fails before step 1.

7.2 `INVALID_REPLACEMENT` — the named replacement agent or replacement skill does not exist (no directory under `agent-instructions/`, no SKILL.md under `skills/`). Fails fast in step 1.

7.3 `OPEN_WORK_INDETERMINATE` — a Paperclip task in the working set has no disposition that fits the input (`disposition` does not cover the task and `task-overrides` does not name it). The skill stops at step 2 with the unresolved task ID; the operator updates the input and re-runs.

7.4 `REASSIGNMENT_FAILED` — a task reassignment in step 3 returned an error from Paperclip. Common causes: API rate limit, the replacement agent's Paperclip ID not matching, network. The skill retries per the resilience policy; on retry exhaustion, the run halts with the failed task ID and the operator decides whether to resume manually.

7.5 `ROUTINE_REWIRE_AMBIGUOUS` — a launchd plist references the retiring agent in a way that the rewire heuristic cannot resolve. The skill stops at step 4 and surfaces the plist for operator decision.

7.6 `PARTIAL_RETIREMENT` — the run halts mid-procedure for any reason. Recoverable from the intermediate state because steps are independent; the audit-trail record in step 1 captures the planned actions and step 5.8 records what actually executed. Re-running the skill from step 4 onward is safe; re-running from step 3 risks double-reassigning tasks already moved.

## 8. Versioning and changelog

The skill follows semver per the workspace `STYLE.md`. Procedural changes that consumers see (a new disposition value, a new failure mode, a new step in §5) bump the minor version. Bug fixes, prose corrections, and changelog updates bump the patch.

### 8.1 Changelog

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-04-29 | Initial SKILL.md authored under Phase G.5 / A-009. Born under the §3 versioning discipline (version, changelog, consumers list). Establishes the eight-step retirement procedure. |

## 9. Related artefacts

The first related artefact is **Architecture Review 4 finding A-009** — the underlying gap the skill closes.

The second is the existing **agent-recruitment skill** in the Paperclip skill registry (operator-managed via the platform UI). The two skills are deliberate counterparts; the local-vs-Paperclip alignment work for `agent-recruitment` is queued under OD-031's future-task pointer.

The third is the **STYLE.md** at `~/claude-workspace/generic/skills/STYLE.md`. Step 7 (consumers-list updates) follows STYLE.md §6.

The fourth is the **CI-HOOK.md** at `~/claude-workspace/generic/skills/CI-HOOK.md`. The hook surfaces the consumers-list changes from step 7 on the PR that lands them.

The fifth is the **runbook** at `~/claude-workspace/generic/river-migration/docs/runbooks/agent-platform-preflight.md` §4 — the operator-facing description of the deliverable.

The sixth is the **laptop-decommission runbook** at `~/claude-workspace/generic/river-migration/docs/runbooks/laptop-decommission.md` §3.3 — the archive convention that step 4 reuses for plist removals.

The seventh is **Architecture Review 4 finding A-001** — the duplicate River Monitor case is the canonical first-run candidate for the skill.

## 10. Document control

| Item | Value |
|---|---|
| Skill | agent-retirement |
| Source of truth | `~/claude-workspace/generic/skills/agent-retirement/SKILL.md` |
| Status | Active. Authored 2026-04-29 during Phase G.5 / A-009. First-run candidates surfaced in §2; first execution awaits operator initiation. |
| Author | CBS Group, drafted with Claude Code |
| Update cadence | Append-only changelog; bump version on any consumer-visible change. Procedural changes (new step, new disposition value, new failure mode) bump the minor version per §8. |
