# Escalation and audit visibility

This file covers two operator-relevant topics for Sarah: when to
escalate something to the operator (rather than handling via Quinn),
and what the audit logs capture about Sarah's interactions.

---

## 1. Escalation channels

1.1 The default escalation channel is direct DM to the operator on
Discord. The operator monitors DMs continuously during business
hours; out-of-hours DMs are read at the next sync.

1.2 The genuine-outage escalation channel is SMS to the operator's
mobile. Use only when the dispatcher is unavailable or Sarah needs
the operator immediately. The dispatcher's tier-2 alert escalator
already routes infrastructure failures via SMS; Sarah's escalation
is for her own work, not infrastructure.

1.3 Sarah's mobile is a tier-2 backup destination for WR-side
escalations per OD-008. The dispatcher's escalator carries her
number in the configuration; she may receive an SMS from the
dispatcher in the rare case the operator is unreachable for a
WR-tagged tier-2 alert.

---

## 2. When Sarah should escalate to the operator

The list below is not exhaustive. Use judgement; under-escalation
is a normal early-onboarding behaviour.

2.1 **Quinn produced something Sarah is uncomfortable with.** Hand
Quinn's output to the operator and explain what felt wrong. The
operator updates the STYLE.md or the agent definition. Do not edit
Quinn's output yourself — pass the example through unchanged so the
operator can diagnose.

2.2 **Quinn refused to do something Sarah needs.** The refusal might
be correct (boundary rule, escalation rule, scope rule) or
incorrect. The operator triages.

2.3 **Cross-EA traffic Sarah did not expect.** If Sarah sees content
from CBS work she had not been briefed on, or sees Quinn referencing
Alex's outputs without an obvious mailroom event, surface it. The
operator's weekly review catches this anyway; Sarah's signal lets
the operator catch it sooner.

2.4 **Discord access changes.** Channel allowlist gaps, missing
threads, broken bot mentions — anything access-related. The operator
owns `access.json`.

2.5 **Suspected security event.** Anything that looks like account
compromise, credential leak, or unauthorised access. Treat as
tier-2; SMS the operator if Discord is not available.

2.6 **Anthropic upstream behaviour Sarah cannot reconcile.** Long
silences, "monthly cap" messages, sudden paid-mode messages —
anything that suggests the upstream service is not behaving
normally. The operator owns the upstream relationship.

---

## 3. What is audited

The dispatcher operates with explicit audit boundaries; nothing
about Quinn's or Sarah's interactions is hidden from the operator.
The audit posture is the architecture's guarantee that the
multi-EA setup remains principal-bounded over time.

3.1 **Identity-binding audit log.** Every inbound message is logged
to `state/identity-binding-audit.jsonl`: timestamp, decision
(allow/refuse), the principal's Discord ID, the partition, the
principal's display name, whether a vault key reference resolved.
The log is the operator's first stop when investigating "did the
right EA serve this message?".

3.2 **Mailroom audit log.** Every cross-EA delivery is logged to
`state/ea-mailroom/audit.jsonl`: timestamp, envelope ID, source
partition, destination partition, entity context, correlation ID,
the `shareableWithPrincipal` flag, a 200-character body preview.
The log is the durable record of "did Quinn share this with Alex,
or vice versa, and was it shareable to the principal?".

3.3 **Trace blocks.** Each Quinn turn produces a trace block stored
under Quinn's partition. The trace block is redacted per the Phase
J.0 redaction patterns (Δ DA-004, OD-014) — emails, phone numbers,
BSB-account formats, ABN/ACN strings, named-individual list. The
unredacted original is preserved at `/data/state/traces-original/`
with operator-only access.

3.4 **Dispatcher logs.** Every gateway event, every cycle tick,
every error is logged to `logs/<date>-dispatcher.jsonl`. Sarah's
messages are visible there as `message_received` lines.

3.5 **Discord history.** The dispatcher passively ingests every
allowlisted channel into `state/channels/<channelId>/<date>.jsonl`.
Retention is 90 days by default. This is a separate stream from
the trace blocks — it captures what was said in the channel, not
what Quinn produced from it.

---

## 4. What Sarah can see

Sarah does not have direct access to the dispatcher's filesystem.
What Sarah can see comes through Quinn or through the operator.

4.1 **Quinn's own outputs.** The Discord thread carries every
reply Quinn sent.

4.2 **`!status` and `!stats`.** The dispatcher's status commands
expose the current activity (active sessions, queue depth, error
rate). Available in any thread or allowlisted channel.

4.3 **Quinn's mailbox via Quinn.** Sarah can ask Quinn "what's in
your mailbox?" and Quinn will summarise pending envelopes with the
appropriate `shareableWithPrincipal` filtering. Quinn does not
expose envelopes flagged non-shareable to the principal even on
direct ask; that is the architecture §2.2.5 inappropriate-sharing
mitigation.

4.4 **Operator on request.** Anything in §3 above is available to
the operator and through the operator. Sarah may ask the operator
for any audit material that pertains to her own interactions.

---

## 5. What the operator reviews

5.1 **Weekly mailroom audit thread review.** Architecture §2.2.7;
the operator walks `state/ea-mailroom/audit.jsonl` for the week and
flags any cross-EA exchange that was inappropriately shareable or
inappropriately non-shareable.

5.2 **Weekly STYLE.md drift audit.** The operator runs a comparison
between Quinn's outputs and Quinn's STYLE.md baseline. Drift is the
trigger for STYLE.md tightening or agent-definition updates.

5.3 **Identity-binding refusal review.** The operator scans the
identity-binding audit for `refuse` decisions. A refusal naming
Sarah's Discord ID would mean a configuration error (Sarah's
mapping was dropped); a refusal naming an unknown ID would mean an
unmapped principal tried to engage and was correctly refused.

5.4 **Phase J.4 shake-down.** The first month after Phase J.1b
completes is a deliberate shake-down period. The operator reviews
all four success criteria weekly: zero identity-binding mechanical
failures; mailroom queue depth maintained below alert threshold;
no inappropriate cross-EA surfacing detected; both principals
confirm EA outputs match STYLE.md baseline. Sarah's confirmation
on the last criterion is the principal sign-off Phase J.4 needs.
