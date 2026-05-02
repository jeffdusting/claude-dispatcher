---
name: google-workspace-sarah
description: Quinn-side parallel to `google-workspace-jeff` — read Sarah's WaterRoads Workspace mailbox and calendar, create drafts (no send), create/modify/respond to calendar events. Status `pending-sarah-onboarding` until three gating items are resolved (see §2).
version: 0.1.0
status: pending-sarah-onboarding
source-of-truth: ~/claude-workspace/generic/skills/google-workspace-sarah/SKILL.md
last-updated: 2026-05-01
consumers:
  - quinn (Sarah's EA — when activated)
---

# google-workspace-sarah

## 1. Purpose

Mirror of `google-workspace-jeff` for Quinn (Sarah's EA) acting on Sarah's WaterRoads Workspace account. Built in parallel with the Jeff-side skill so the two EAs maintain symmetric architecture per the operator's R-950 brief, while preserving per-EA divergence at the agent-instruction layer (Alex's mail/calendar idioms can grow differently from Quinn's; the skill scripts are independent so divergence is supported by default).

The skill is a **scaffolding** at v0.1.0. The SKILL.md and the implementation outline are committed; the helper scripts are not in place because three gating items must resolve first (§2).

## 2. Gating items (must all resolve before activation)

2.1 **Sarah's WR Workspace email** — Sarah needs a `*.waterroads.com.au` Workspace identity. The exact email (e.g. `sarah.taylor@waterroads.com.au`) determines the impersonation target in the application-layer allow-list. Operator confirms the address.

2.2 **DWD allow-list extension at the WR Workspace admin level** — the chosen impersonation target must be added to the SA's domain-wide delegation allow-list at the Workspace admin console. Without this, the SA cannot impersonate Sarah even if the application-layer allow-list permits it. Operator action via the WR Workspace admin console.

2.3 **SA reuse-versus-new decision** — two options:

- **Option A: reuse `alex-morgan-runtime@waterroads-alex-morgan.iam.gserviceaccount.com`** with multi-target DWD. One SA impersonates both `jeffdusting@waterroads.com.au` (Alex's path) and Sarah's email (Quinn's path). Cheaper to maintain; one credential rotation cycle. Loose isolation — revoking Quinn's access without affecting Alex requires removing the Sarah target from the DWD allow-list (an admin-console change), not a credential rotation.
- **Option B: provision a new `quinn-runtime@<project>.iam.gserviceaccount.com`** SA with its own DWD allow-list. Cleaner isolation — revoking Quinn-only access is a credential rotation that does not touch Alex. Higher maintenance — two SA rotation cycles, two vault items. Preferable if Sarah's role or counter-parties differ enough that audit-log separation matters.

The recommended path is Option B (cleaner isolation, parallel rotation cadence with Alex's SA). Operator confirms.

## 3. Implementation outline (when activated)

When 2.1–2.3 resolve:

3.1 **Create or extend the SA.** Either grant the existing `alex-morgan-runtime` SA the second DWD target (Option A) or provision `quinn-runtime` with its own DWD allow-list (Option B).

3.2 **Vault item.** Either reuse `op://CoS-Dispatcher/drive-wr-alex-morgan/sa-json` (Option A) or create `op://CoS-Dispatcher/drive-wr-quinn-runtime/sa-json` (Option B).

3.3 **Helper scripts.** Mirror `dispatcher/scripts/google-workspace/{auth,gmail,calendar}.ts` to a sibling directory. Naming: keep the directory layout symmetric and parameterise the principal+vault-path so future skills can subclass. Two practical paths:

- 3.3a Duplicate the three files at `dispatcher/scripts/google-workspace/sarah/{auth,gmail,calendar}.ts` with `SARAH_PRINCIPAL` and `WR_QUINN_RUNTIME_SA_KEY_PATH`. Pure copy, easiest to evolve independently per Jeff's "divergence" preference.
- 3.3b Refactor the Alex-side scripts to take principal + key-path as constructor inputs and have per-EA wrappers be thin. Less duplication; tighter coupling.

The recommended path is 3.3a. Per Jeff's brief at the twenty-sixth session ("Alex's skills in using mail and calendars should be allowed to diverge from Quinn"), the scripts are intended to evolve independently — duplication now buys clean divergence later.

3.4 **Dispatcher entrypoint.** Add a "Quinn / Sarah Google Workspace SA" section to `entrypoint.sh` that materialises the chosen vault item to `/data/.secrets/wr-quinn-runtime-gcp-sa.json` and exports `WR_QUINN_RUNTIME_SA_KEY_PATH`.

3.5 **Quinn agent definition.** Update `dispatcher/.claude/agents/quinn.md` with the same shape as Alex — a Google Workspace section describing capability, drafts-only rule, sample invocations.

3.6 **Smoke test.** Operator-gated: laptop-side `op read` populating the SA JSON, then a single live call against `gmail.users.getProfile` and `calendar.calendarList.list` for Sarah's principal.

## 4. Drafts-only rule

The same drafts-only rule applies to Quinn as to Alex. No `send` subcommand in the Gmail helper. Calendar `create-event`/`update-event`/`delete-event` use `sendUpdates=none` so invitations require Sarah's explicit dispatch.

Future graduation of Quinn-specific email-types is tracked alongside Alex's under R-952. The graduation config can be per-EA (Quinn graduates her own counter-party-types independently of Alex).

## 5. Document control

| Item | Value |
|---|---|
| Skill | google-workspace-sarah |
| Version | 0.1.0 |
| Status | pending-sarah-onboarding |
| Source of truth | `~/claude-workspace/generic/skills/google-workspace-sarah/SKILL.md` |
| Pair | `~/claude-workspace/generic/skills/google-workspace-jeff/SKILL.md` (active) |
| Activation gate | three gating items in §2 |
| Future graduation | Kanban R-952 (approval-lane port for autonomous send) |
