# Multi-EA mailroom operations

This runbook covers day-to-day operation of the multi-EA dispatcher
configuration introduced in Phase J.1 (Migration Plan §14.2;
architecture v2.1 §2.2).

It satisfies Migration Plan §14.2.5 and Δ O-011. It is the fourth
runbook in the dispatcher set described in architecture v2.1 §7.2.

The runbook is split into seven parts:

1. Topology refresher.
2. Adding a new EA.
3. Retiring an existing EA.
4. Handling cross-EA work.
5. Investigating per-EA traces.
6. Common failure modes and the responses to them.
7. Manual interventions on the mailroom queue.

---

## 1. Topology refresher

1.1 Each principal has exactly one EA. Jeff's EA is Alex Morgan; Sarah's
EA is Quinn (per OD-035). EAs do not share state, do not share
credentials, and do not surface each other's content to their
respective principal without explicit operator instruction.

1.2 Every EA has a per-principal partition at `state/eas/<partition>/`.
The partition root holds three subdirectories:

  - `mailbox/` — incoming envelopes from the cross-EA mailroom drain.
  - `audit/` — per-EA snapshots of the audit thread material.
  - and the partition's `style.md` (the approved baseline; runtime
    write-interceptor prevents the EA from modifying it).

1.3 The cross-EA mailroom queue lives at
`state/ea-mailroom/<from>-to-<to>/`. Drain cadence is 60 seconds;
audit log appends to `state/ea-mailroom/audit.jsonl` per delivery.
Backpressure alarm state persists at `state/ea-mailroom-alarms.json`.

1.4 Identity binding chains three layers:

  - Layer 1 — `config/first-agent-by-principal.json` maps Discord
    author ID → partition; layer-1 binding is enforced at the gateway
    boundary in `src/gateway.ts handleMessage()`.
  - Layer 2 — each EA's AGENTS.md carries the "you serve <name> only"
    directive plus the partition-scoped context. AGENTS.md changes
    require principal approval via the CODEOWNERS rule on
    `river-config`.
  - Layer 3 — the identity-binding audit log at
    `state/identity-binding-audit.jsonl` captures every allow and
    refuse decision for the operator's weekly review.

---

## 2. Adding a new EA

The procedure assumes a brand-new EA, not an in-place migration.
Phase J.1a (Alex Morgan) is the in-place case and follows
`docs/river-migration/22-alex-morgan-in-place-migration-plan.md`.

2.1 Confirm operator authorisation. A new EA implies a new principal;
ensure they exist in the access-control allow list and have a Discord
account in the workspace.

2.2 Allocate the partition name. Convention: lowercase principal
first name, alphanumeric with hyphens (`/^[a-z][a-z0-9-]*$/`). The
partition name MUST NOT collide with any existing partition.

2.3 Create the per-EA Anthropic API key. Generate the key in the
Anthropic Console under the CBS Group organisation. Apply OD-012a
attribution: per-EA runtime keys fold into the dispatcher 50%
allocation, not a separate bucket. Name the key `<partition>-runtime`
to match the existing convention (e.g. `quinn-runtime`).

2.4 Stage the key in 1Password vault `CoS-Dispatcher`. Item type:
API Credential. Field: `credential` (string, secret). Vault path:
`op://CoS-Dispatcher/<partition>-runtime/credential`. Verify with
`op read op://CoS-Dispatcher/<partition>-runtime/credential` before
proceeding.

2.5 Update `config/first-agent-by-principal.json`:

  - Add the principal's Discord author ID to the `mappings` block,
    pointing to the new partition name.
  - Add an entry under `partitions` for the new partition with
    `principalName` (the principal's full name, used for audit logs
    and the AGENTS.md directive substitution) and
    `anthropicKeyVaultRef` (the `op://...` reference from §2.4).

2.6 Bootstrap the on-disk partition by restarting the dispatcher.
`bootstrapEAPartitions()` in `src/eaPartitions.ts` runs at boot and
creates `state/eas/<partition>/{mailbox,audit}/` for every partition
present in `mappings`. The directories appear without further action.

2.7 Author the EA's AGENTS.md. Place it under the dispatcher repo at
`agents/<partition>.md` (or wherever your agent-roster convention
sits — see `River/agent-roster.md`). The AGENTS.md must include:

  - the "you serve <principal-name> only" directive (architecture
    §2.2.4 layer 2);
  - the partition-rooted context awareness;
  - mailroom awareness — the EA must read its `mailbox/` at session
    start;
  - cross-entity scope — primary entity (CBS / WR / both) and the
    visibility rules for content from the other entity.

2.8 Author the EA's STYLE.md. Use the template at
`docs/river-migration/23-river-style-md-template.md`. STYLE.md
changes require principal approval via the CODEOWNERS rule on the
`river-config` repository (architecture §2.2.6). The first STYLE.md
draft is the operator's one-time approval gate (Migration Plan
§14.3.3 / §14.4.3 / §14.4.5).

2.9 Verify the binding. Send a test Discord message from the new
principal's account in any allowed channel. Confirm:

  - `state/identity-binding-audit.jsonl` records an `allow` decision
    naming the new partition;
  - the dispatcher log emits `identity_binding_allow` with the
    expected `partition` and `hasVaultRef: true`;
  - a session is created in the new partition's mailbox.

---

## 3. Retiring an existing EA

Retirement is rare. The existing skill is `agent-retirement` (Phase
G.5; River/skills/agent-retirement/SKILL.md). The mailroom-specific
steps below sit alongside the broader skill.

3.1 Confirm operator decision recorded. EA retirement is a principal-
facing change; record the decision in `27-river-decisions-applied.md`
before executing.

3.2 Drain in-flight mailroom envelopes addressed to the retiring EA.
Run `runMailroomCycle()` once via a manual dispatcher restart, or
let the 60-second cycle drain the queue naturally. Confirm
`pairQueueDepth(*, <retiring-partition>)` is zero across all sources.

3.3 Drain in-flight envelopes from the retiring EA. Same procedure
in the other direction; check `pairQueueDepth(<retiring-partition>, *)`.

3.4 Remove the principal's mapping from
`config/first-agent-by-principal.json` (`mappings` block). Leave the
`partitions` entry in place if you want the partition's audit and
mailbox content preserved on disk; otherwise remove it too.

3.5 Archive the partition directory. Move
`state/eas/<retiring-partition>/` to
`state/archived/eas/<retiring-partition>-<YYYY-MM-DD>/` rather than
delete. Trace material lives there until the retention policy
collects it.

3.6 Revoke the per-EA Anthropic API key in the Anthropic Console.

3.7 Remove the 1Password vault item
`op://CoS-Dispatcher/<retiring-partition>-runtime`. The dispatcher
no longer references it after the mappings update.

3.8 Restart the dispatcher. Verify the retiring partition no longer
appears in the boot-time `ea_partitions_bootstrap` log entry.

---

## 4. Handling cross-EA work

Cross-EA messaging is a deliberate channel — it is not the normal
case. The default for EA-to-EA traffic is non-shareable; principal
surfacing requires the explicit `shareableWithPrincipal: true` flag
on the envelope.

4.1 The originating EA composes a `MailroomEnvelope` with the body,
the destination partition, the entity context, the correlation ID,
and the `shareableWithPrincipal` flag set per the operator's
guidance.

4.2 The originating EA calls `dropEnvelope(env)` from
`src/eaMailroom.ts`. The envelope writes atomically to
`state/ea-mailroom/<from>-to-<to>/<envelopeId>.json`.

4.3 The 60-second drain cycle (`runMailroomCycle()` in
`src/eaMailroomCycle.ts`) reads each envelope, writes it into the
destination partition's `mailbox/<envelopeId>.json`, and appends a
record to `state/ea-mailroom/audit.jsonl`.

4.4 The destination EA reads its `mailbox/` at session start. The
EA's AGENTS.md directs it to surface envelopes with
`shareableWithPrincipal: true` to its principal in the ordinary
course; envelopes flagged false are acted on but not surfaced.

4.5 Both EAs preserve correlation chain. The destination EA emits
its log lines under the same `correlationId` so the audit
reconstruction tool reaches across the EA boundary.

4.6 Operator weekly review of `state/ea-mailroom/audit.jsonl`
verifies that the `shareableWithPrincipal` flag was applied
consistently across the week's exchanges (architecture §6.7
inappropriate-sharing mitigation).

---

## 5. Investigating per-EA traces

5.1 Trace blocks are partitioned per EA and per entity (Phase J.0,
§14.1.2). A trace block carries `owningEA` and `entity` tags; the
ingestion pipeline routes the block to the appropriate KB based on
those tags.

5.2 To pull traces for a specific EA, query the supabase project
matching the entity (CBS Supabase `eptugqwlgsmwhnubbqsk` or WR
Supabase `imbskgjkqvadnazzhbiw`) with `WHERE owningEA = '<partition>'`.
The supabase-query skill at `River/skills/supabase-query/` is the
operator-facing entry point.

5.3 Unredacted originals live at `/data/state/traces-original/`
with 0600 permissions (Phase J.0.1.3). Access requires direct
machine access; the routine ingestion pipeline reads only the
redacted material.

5.4 Cross-EA actions appear in two places:

  - `state/ea-mailroom/audit.jsonl` records every delivered
    envelope; one line per delivery.
  - `state/identity-binding-audit.jsonl` records every gateway
    inbound resolution; one line per message (allow or refuse).

5.5 To follow a single user message end-to-end, pivot on the
`correlationId`. The Discord post carries it as a subtext footer
(Phase A.11); dispatcher logs (`logs/<date>-dispatcher.jsonl`) and
session logs (`logs/<date>-sessions.jsonl`) carry it on every
emission inside the correlation scope.

---

## 6. Common failure modes

The four mailroom failure modes are mapped to specific log signals
and operator responses.

6.1 **Identity-binding mismatch.** A message from a known principal
is refused at the gateway. The signal is an `identity_binding_refuse`
log line plus a JSONL record in `state/identity-binding-audit.jsonl`.
The operator response is to confirm whether the principal's Discord
ID is correct in `config/first-agent-by-principal.json`. If the ID
is correct, check whether the principal's account changed (Discord
account migration) — re-bind under the new ID.

6.2 **Mailroom queue depth alarm.** A pair queue
`<from>-to-<to>` crosses 50 envelopes. The signal is a
`mailroom_depth_alarm_fired` dispatcher log line plus a tier-1
Discord post in OPS_ALERT_CHANNEL_ID. The operator response is to
investigate why the destination EA is not consuming. Likely causes:

  - destination EA worker is not running (check
    `worker_registry` log lines);
  - destination EA's session is stuck in error state (check
    `state/sessions.json`);
  - destination EA is processing messages slower than they arrive
    (rate-limit or capacity issue — surface on `!status`).

The dispatcher does not auto-drain the queue; it requires operator
investigation. Cooldown is 15 minutes per pair.

6.3 **Mailroom queue age alarm.** An envelope's `createdAt` exceeds
two hours without delivery. The signal is a `mailroom_age_alarm_fired`
dispatcher log line plus a tier-2 alert in OPS_ALERT_CHANNEL_ID
(SMS-escalated by the existing escalator if not acknowledged within
TIER2_ACK_WINDOW_MS). Operator response is the same as §6.2 plus
manual flush — see §7 below.

6.4 **Inappropriate cross-EA surfacing.** An envelope was delivered
with `shareableWithPrincipal: true` when the operator's posture says
it should have been false. The signal is the operator catching it
on weekly review of `state/ea-mailroom/audit.jsonl`. Response is to
correct the originating EA's STYLE.md and re-baseline the EA, not
to redact the audit log (the audit log is the durable record of
what happened).

6.5 **Cross-entity artefact contention.** Two EAs write the same
artefact concurrently. Mitigation is structural (architecture §6.7
"cross-entity artefact handling") — Drive folders are entity-tagged,
service accounts are separated, the worker registry's
lock-by-checkout protects state files. If the operator sees lock
contention in `worker_registry` logs, the response is to check
which EAs hold the lock and serialise the work.

---

## 7. Manual interventions on the mailroom queue

Use sparingly. The queue is a piece of operational state that the
audit log expects to reconcile against; manual changes leave gaps.

7.1 **Inspect a pair queue.**

```
ls state/ea-mailroom/<from>-to-<to>/
```

Each `.json` file is one pending envelope. The `.rejected/`
subdirectory holds quarantined envelopes from the drain cycle.

7.2 **Inspect an aged envelope.**

```
cat state/ea-mailroom/<from>-to-<to>/<envelopeId>.json
```

The envelope's `createdAt` is the basis of the age alarm; if it
turns out to be incorrect (e.g. the dispatcher's clock skewed during
a deploy), the envelope can be re-issued with a corrected timestamp
under a new envelope ID rather than mutated in place.

7.3 **Manually drain a single envelope.** Move it directly into the
destination partition's mailbox and append an audit-log line:

```
mv state/ea-mailroom/<from>-to-<to>/<envelopeId>.json \
   state/eas/<to>/mailbox/

cat <<EOF >> state/ea-mailroom/audit.jsonl
{"timestamp":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","envelopeId":"<envelopeId>","fromPartition":"<from>","toPartition":"<to>","entity":"<entity>","correlationId":"<corr>","shareableWithPrincipal":<bool>,"bodyPreview":"<preview>","manualIntervention":true}
EOF
```

The `manualIntervention: true` field marks the line so the operator's
weekly audit review distinguishes it from cycle-driven deliveries.

7.4 **Quarantine a stuck envelope.** Move it to the pair queue's
`.rejected/` subdirectory:

```
mkdir -p state/ea-mailroom/<from>-to-<to>/.rejected
mv state/ea-mailroom/<from>-to-<to>/<envelopeId>.json \
   state/ea-mailroom/<from>-to-<to>/.rejected/$(date +%s)-<envelopeId>.json
```

The dedup state in `state/ea-mailroom-alarms.json` for that
envelopeId can stay; the GC pass on the next cycle prunes it once
the file no longer matches a present queue entry.

7.5 **Reset all alarm dedup state.** Useful after a misconfiguration
caused a depth or age alarm storm:

```
rm state/ea-mailroom-alarms.json
```

The next cycle re-creates the file with empty dedup state. Only
under-threshold queues stay quiet; pairs still over the depth
threshold will re-alarm on the next cycle.

---

## 8. Document control

Author: Claude Code (Migration Plan §14.2.5).
Last review: 2026-04-30.
Source of truth: this file in `dispatcher/docs/runbooks/`.
Cross-references: architecture v2.1 §2.2, §6.7, §7.2; Migration
Plan §14.2 (Phase J.1 multi-EA scaffolding); OD-011, OD-012a,
OD-035, OD-038.
