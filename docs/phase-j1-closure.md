# Phase J.1 closure — multi-EA bootstrap complete

This document is the closure artefact for Phase J.1 of the River
migration (Migration Plan §14). It records what landed, the four
bootstrap pause points, the operator's conditional-approval
mechanism, the verification status, and the transition into
Phase J.4 one-month shake-down.

---

## 1. What landed

### 1.1 Phase J.1 §14.2 — multi-EA scaffolding

PRs #35 and #36 squash-merged on dispatcher `origin/main`. The
scaffolding established the partition pattern, the cross-EA
mailroom, the identity-binding three-layer resolver, the
multi-EA operations runbook, and the Sarah onboarding pack.

  - First-agent selector and per-EA partition directories
    (Migration Plan §14.2.1, §14.2.2).
  - Mailroom envelope schema, drop / drain primitives, drain
    cycle, depth and age backpressure alarms (Migration Plan
    §14.2.3).
  - Identity-binding three-layer resolver with audit log at
    `state/identity-binding-audit.jsonl` (Migration Plan §14.2.4).
  - Multi-EA operations runbook at
    `dispatcher/docs/runbooks/multi-ea-operations.md` (§14.2.5,
    Δ O-011).
  - Sarah onboarding pack at `dispatcher/docs/sarah-onboarding/`
    (§14.2.6, Δ O-013).

### 1.2 Phase J.1a — Alex in-place migration

PR #37 squash-merged. Alex Morgan migrated into the multi-EA
architecture with Jeff's partition.

  - Archive snapshot index at
    `dispatcher/docs/alex-archive-snapshot.md` (§14.3.1).
  - ProjectRecord schema v2 → v3 with the `owningEA` field;
    backfill executed against all 18 descriptors with
    `owningEA=jeff` (§14.3.2).
  - Chief-of-staff agent definition adds the multi-EA awareness
    section and the explicit "you serve Jeff Dusting only"
    directive (§14.3.4).
  - Alex's STYLE.md baseline approved by operator on 2026-04-30
    and seeded at `state/seeds/eas/jeff/style.md` (§14.3.3 third
    bootstrap pause point — CONSUMED).

### 1.3 Phase J.1b — Quinn bootstrap

PR #38 squash-merged. Quinn (Sarah's EA) bootstrapped from clean
slate.

  - Quinn agent definition at
    `dispatcher/.claude/agents/quinn.md` (§14.4.3).
  - Partition routing wiring: `claudeAgent` field on
    `PartitionMetadata`, `agentForPartition()` helper,
    `partitionContext.ts` AsyncLocalStorage scope, gateway and
    `runSession` wiring so partition-routed messages spawn the
    right agent (§14.4.4).
  - `first-agent-by-principal.json`: Sarah's Discord author ID
    `1495747655152701547` mapped to the `sarah` partition;
    sarah partition metadata populated with `principalName`,
    `anthropicKeyVaultRef`, `claudeAgent`.
  - Quinn's STYLE.md baseline approved by operator (forwarded
    to Sarah) on 2026-04-30 and seeded at
    `state/seeds/eas/sarah/style.md` (§14.4.3 / §14.4.5 fourth
    bootstrap pause point — CONSUMED).

### 1.4 Iterative STYLE.md update mechanism (operator-conditional)

Operator approval of the Phase J.1a / J.1b baselines was
conditional on the EAs being able to receive style-update
instructions via Discord and reflect those updates in their
behaviour. The mechanism landed alongside the baseline seeds:

  - `src/styleUpdate.ts` — file-I/O + audit-log helpers; writes
    to seed AND runtime path atomically; per-call audit at
    `state/style-update-audit.jsonl`.
  - `~/claude-workspace/generic/skills/style-update/SKILL.md` —
    natural-language playbook; consumed by both `chief-of-staff`
    and `quinn`.
  - Cross-EA boundary enforced structurally: an EA can only
    update its own partition; cross-attempts are refused with a
    user-facing explanation.

---

## 2. Bootstrap pause points — final tally

The four bootstrap-defined pause points were:

1. **B.5 Drive folder access verification** — CONSUMED 2026-04-28.
2. **E.1 cutover trigger** — CONSUMED 2026-04-29.
3. **J.1a §14.3.3 Alex STYLE.md operator approval** — CONSUMED
   2026-04-30 (this session).
4. **J.1b §14.4.3 Quinn STYLE.md principal approval** — CONSUMED
   2026-04-30 (this session); operator review then forwarded to
   Sarah for principal approval (mode (a) per carry-over).

Bootstrap interaction surface is closed. Phase J.4 shake-down does
not introduce new pause points; it is observational.

---

## 3. Verification status

### 3.1 Code-side verification — PASSING

`tests/firstAgentLiveConfig.test.ts` exercises the canonical
`config/first-agent-by-principal.json` and confirms:

  - Jeff's Discord ID resolves to the `jeff` partition.
  - Sarah's Discord ID resolves to the `sarah` partition.
  - The `jeff` partition routes to `chief-of-staff` with the
    `alex-morgan-runtime` vault ref.
  - The `sarah` partition routes to `quinn` with the
    `quinn-runtime` vault ref.
  - An unknown Discord ID is refused.

Full dispatcher test suite: see CI; expected pass count is 306
(263 base + 11 partition context + 14 styleUpdate + 7 bootstrap
+ 5 live-config + 6 owningEA backfill).

### 3.2 Vault-side verification — operator-attested

The operator rotated Quinn's runtime key on 2026-04-30 (per the
session-start security note) and stored the fresh value at
`op://CoS-Dispatcher/quinn-runtime/credential`. Claude Code
attempted prefix-only confirmation per the carry-over but was
blocked by the harness (any process touching the credential value
is treated as exfiltration risk). The operator's attestation
that the rotation occurred — recorded in this session's
opening — is the durable signal; CC does not have a path to
confirm without harness permission.

The operator should run `op read 'op://CoS-Dispatcher/quinn-runtime/credential'`
locally (single command, secret-aware shell) and visually
confirm the prefix differs from the leaked `sk-ant-api03-SGBC…`
value before declaring the security check complete.

### 3.3 Discord-side verification — operator-runbook

The synthetic Discord verification ping is the final step in the
Sarah onboarding pre-flight checklist (multi-EA-operations.md §2.9
applied to Sarah's account). Procedure:

  - From Sarah's Discord account, send a test message in any
    allowlisted channel where the dispatcher is configured to
    process her input.
  - Confirm the dispatcher log emits `identity_binding_allow`
    with `partition: "sarah"` and `hasVaultRef: true`.
  - Confirm `state/identity-binding-audit.jsonl` records an
    `allow` decision naming the `sarah` partition.
  - Confirm a session is created in the `sarah` partition's
    mailbox.
  - Confirm the spawned worker invokes `quinn` (visible in the
    worker registry log line and the `--agent quinn` argument
    on the spawn command).
  - Run the equivalent ping from Jeff's account; confirm the
    `jeff` partition path and `chief-of-staff` agent.

The ping must be run after the dispatcher restarts on the new
image (post-merge of this branch) — until then, the runtime
config the dispatcher process holds is the prior version. Cloud
deploy via `fly deploy` is the operator's existing path.

---

## 4. Sarah orientation — activation status

The orientation pack at `dispatcher/docs/sarah-onboarding/` is
ready for the operator to run the 30-minute walkthrough with
Sarah per Migration Plan §14.4.5. The pre-flight checklist in
the README is now satisfied to the extent CC can satisfy it:

  - Quinn's agent definition committed and merged. ✓
  - Quinn's STYLE.md approved and committed. ✓
  - Sarah's Discord author ID mapped in
    `config/first-agent-by-principal.json`. ✓
  - Quinn's vault credential staged at
    `op://CoS-Dispatcher/quinn-runtime/credential`
    (operator-attested rotation 2026-04-30). ✓
  - Sarah's Discord account exists in the workspace. — pending
    operator confirmation; the seventeenth-session
    Sarah-login-instructions doc captures the operator-driven
    procedure.
  - Verification ping run successfully. — pending
    post-deployment Discord-side run per §3.3.

The orientation session can be scheduled once the verification
ping has passed.

---

## 5. Phase J.4 — one-month shake-down

Phase J.4 begins from the time of this commit. The shake-down
is observational; CC's involvement is light. Per Migration Plan
§14.5:

  - Operator reviews the multi-EA mailroom audit log
    (`state/ea-mailroom/audit.jsonl`) weekly.
  - Operator runs the STYLE.md drift audit weekly — divergence
    between EA outputs and the current STYLE.md baseline flags
    the need for STYLE.md tightening or agent-definition
    edits.
  - Operator monitors the four success criteria across the
    month: zero identity-binding mechanical failures; mailroom
    queue depth maintained below the 50-message alert
    threshold; no inappropriate cross-EA surfacing detected;
    both principals confirm EA outputs match their STYLE.md
    baseline.
  - Closing the shake-down requires the operator's confirmation
    across all four criteria plus the operator's overall
    sign-off.

### 5.1 Concurrent during J.4 (informational)

The following work continues alongside J.4 without competing
for shake-down attention:

  - Stability week observations from Phase F — operator-gated
    launchd decommissioning per the existing runbook (gated on
    2026-05-06 stability window per
    `laptop-decommission.md` §3).
  - Discord history bootstrap (G.6) ready to run once the J.0
    redaction pipeline is verified clean in production.
  - Next development cycle planning for kanban items R-939
    through R-945 (the staged "next-development-cycle items"
    in `21-river-development-kanban-v03.md` §3.2).

### 5.2 Iterative STYLE.md updates expected during J.4

The mechanism from §1.4 is expected to see real-world use during
J.4 as Jeff and Sarah refine their EAs' behaviour organically.
Each accepted update produces a JSONL audit record and a
`style-update(<partition>): …` git commit on a feature branch
opened for operator self-approval. The drift audit reads against
the current baseline, so an iterative update updates the baseline
the next week's drift audit compares to.

---

## 6. Document control

Author: Claude Code, Phase J.1 closure deliverable.
Closure date: 2026-04-30.
Source of truth: this file in `dispatcher/docs/`.
Cross-references: Migration Plan §14 (Phase J overall);
architecture v2.1 §2.2, §6.7, §7.4; OD-011 (mailroom runbook
source), OD-012a (per-EA Anthropic key attribution), OD-013
(Sarah onboarding pack source), OD-014 (PII redaction patterns),
OD-015 (closed by OD-035 supersession), OD-035 (Quinn name),
OD-038 (per-EA runtime keys); pause points B.5, E.1, J.1a, J.1b
all CONSUMED; Phase J.4 begins 2026-04-30 with observational
posture.
