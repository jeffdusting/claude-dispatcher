# Sarah onboarding pack

Operator-facing documentation for handing Quinn (Sarah's EA) over to
Sarah once Quinn has been bootstrapped per Phase J.1b of the Migration
Plan. The pack satisfies §14.2.6 and Δ O-013.

The pack is the operator's pre-read for Sarah's 30-minute orientation
session (Migration Plan §14.4.5). Hand the contents to Sarah after the
session as her ongoing reference. Some content (the orientation script,
the principal-approval prompts) is the operator's own working material;
other content (the interaction patterns, the escalation rules) is
intended for Sarah to keep.

The pack is split across four files:

1. `01-what-sarah-will-see.md` — Sarah's view of Quinn from the Discord
   side, in plain English. This is the lead-in to the orientation.
2. `02-orientation-script.md` — operator's running order for the
   30-minute walkthrough.
3. `03-style-md-walkthrough.md` — the STYLE.md drafting exercise. Used
   in two modes per the operator's choice — see Migration Plan §14.4.3
   options (a) and (b).
4. `04-escalation-and-audit.md` — escalation rules between Sarah and
   the operator; audit visibility (what is logged, what Sarah can see,
   what the operator reviews).

Convention notes:

  - The Quinn name is fixed per OD-035. Older drafts (OD-015) used
    "Sarah's EA" as a placeholder; that is superseded.
  - All references to "Jeff" mean the operator (Jeff Dusting, Director
    of CBS Group). The operator owns the dispatcher and the
    cross-principal review responsibilities.
  - "EA" throughout means executive assistant in the agent sense — the
    Anthropic-driven worker that operates inside Quinn's partition.
  - All references to "the dispatcher" mean the Fly.io-hosted process
    `cos-dispatcher` running in `syd`.

---

## Pre-flight checklist

Before running the orientation session, confirm the following:

  - Quinn's agent definition is committed and merged (Phase J.1b
    §14.4.3).
  - Quinn's STYLE.md is approved by Sarah and committed (Phase J.1b
    §14.4.2; the fourth and final bootstrap pause point per the
    standing posture rule).
  - Quinn is registered with the dispatcher; Sarah's Discord author ID
    is mapped in `config/first-agent-by-principal.json` to the
    `sarah` partition (or whatever partition name was finalised — see
    Migration Plan §14.4.4).
  - Sarah's Anthropic API key (Quinn's runtime key) is staged in
    1Password vault `CoS-Dispatcher` at
    `op://CoS-Dispatcher/quinn-runtime/credential` and the `partitions`
    block in `first-agent-by-principal.json` references it. Per OD-038
    spawned-worker attribution, Quinn's spend folds into the dispatcher
    50% allocation.
  - Sarah's Discord account exists in the workspace and Sarah has
    access to her primary channels.
  - The verification ping has been run — a test message from Sarah's
    Discord account triggered an `identity_binding_allow` decision
    naming the Quinn partition.

If any of the above is incomplete, do not proceed with orientation —
finish the prerequisite step first.

---

## Document control

Author: Claude Code (Migration Plan §14.2.6).
Last review: 2026-04-30.
Source of truth: this directory in `dispatcher/docs/sarah-onboarding/`.
Cross-references: architecture v2.1 §2.2, §7.4; Migration Plan §14.4
(Phase J.1b Quinn bootstrap); OD-013, OD-015 (closed by OD-035),
OD-035, OD-038.
