# Orientation script — 30-minute walkthrough

Operator's running order for the session. Allow 30 minutes; the
script is sized to fit. The session is per Migration Plan §14.4.5.

---

## 1. Setup (operator does before Sarah arrives)

1.1 Confirm the pre-flight checklist in `README.md` is complete.

1.2 Open Discord on the screen Sarah will see, logged in as Sarah.
A second screen logged in as the operator is useful for showing the
audit logs and the dispatcher logs in real time.

1.3 Open the four orientation files in this directory and have them
ready for Sarah to read alongside.

---

## 2. Introduction (5 minutes)

2.1 Hand Sarah `01-what-sarah-will-see.md`. Walk through §1 and §2
together. The point: Quinn is software, lives in the cloud, serves
only Sarah, and behaves per a written STYLE.md that Sarah owns.

2.2 Explain the principal-only rule. Sarah's messages reach Quinn;
Jeff's messages reach Alex; cross-EA traffic exists but is rare,
audit-logged, and operator-supervised.

2.3 Confirm Sarah understands the STYLE.md is editable later by
operator request. Sarah does not need to perfect it in the
orientation; the goal is a working baseline.

---

## 3. Discord channels and access (5 minutes)

3.1 Walk Sarah through the channels she has access to. The current
list is determined by the access-control configuration the operator
has set. Typical entries include:

  - the channel(s) the operator has allowlisted Sarah for in
    `~/.claude/channels/discord/access.json` (`groups` block,
    `allowFrom` includes Sarah's Discord user ID);
  - any per-thread visibility Sarah has been granted post-thread-
    creation.

3.2 Confirm Sarah can see the channels and can post into the
allowlisted ones. If she cannot, the operator updates `access.json`
via the dispatcher's `/access` slash command (or directly) and
restarts the relevant intervals.

3.3 Note which channels are CBS-scoped (Sarah may have read-only
visibility) versus WR-scoped (Sarah has full participation as the
WR principal). The Discord channel-to-entity map is in
`config/channel-entity-map.json` in the dispatcher repo.

---

## 4. First conversation with Quinn (10 minutes)

4.1 Have Sarah send her first message to Quinn in an allowlisted
channel with the bot mention. Confirm the dispatcher creates a
thread and Quinn responds.

4.2 On the operator's screen, show the live audit signals:

  - the `identity_binding_allow` log line confirming Sarah's
    Discord ID resolved to the Quinn partition;
  - the `state/identity-binding-audit.jsonl` entry for the same
    decision;
  - the new session in `state/sessions.json`;
  - the worker registry's `worker_registered` line.

4.3 Have Sarah continue the conversation in the thread. Confirm:

  - she does not need to mention the bot inside the thread;
  - Quinn replies within a few seconds;
  - the message is logged in `logs/<date>-dispatcher.jsonl`;
  - the trace block writes under Quinn's partition.

4.4 Have Sarah try `!status` in the thread. Show her the output and
explain when she might use it (long-running turns, suspected hangs).

---

## 5. STYLE.md drafting (5 minutes — see §3 for the full walkthrough)

5.1 Walk Sarah through `03-style-md-walkthrough.md` §1. The choice
is between option (a) — operator drafts a starting point and Sarah
reviews — and option (b) — Sarah engages directly via her newly
created Paperclip account and contributes to drafting.

5.2 Confirm the operator's choice. Default is (a) per Migration
Plan §14.4 carry-over instruction.

5.3 Schedule the STYLE.md review and approval. The principal
approval is the fourth and final bootstrap pause point per the
standing posture rule (Migration Plan §14.4.3 / §14.4.5).

---

## 6. Escalation and audit (5 minutes)

6.1 Hand Sarah `04-escalation-and-audit.md`. Walk through §2 (when
to escalate) and §3 (what is audited and who reviews).

6.2 Confirm Sarah's escalation channel. Default is direct DM to the
operator on Discord; in genuine outages, SMS to the operator's
mobile per the existing tier-2 escalation runbook.

6.3 Confirm Sarah understands that the operator reviews her
cross-principal interactions weekly. The mailroom audit log
captures every cross-EA delivery; the identity-binding audit log
captures every gateway decision. Neither is hidden from the
operator; both are durable.

---

## 7. Wrap-up

7.1 Leave the orientation files with Sarah. They are her ongoing
reference; she does not need to memorise anything.

7.2 Schedule a follow-up at one week and one month per the Phase
J.4 shake-down (Migration Plan §14.5.3 — "both principals confirm
EA outputs match STYLE.md baseline" is one of the four success
criteria).

7.3 Note in `TASK_LOG.md` that orientation is complete with the
date, who attended, and any pending follow-ups (e.g. STYLE.md
revisions Sarah requested).
