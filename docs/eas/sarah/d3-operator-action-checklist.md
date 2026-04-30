# D3 / Phase J.1b — operator-action checklist

This document captures the operator-action items needed to complete
Phase J.1b (Quinn bootstrap) per Migration Plan §14.4. The
scaffolding work is staged in this PR; the items below are what
the operator (Jeff) and Sarah need to do before Quinn goes live on
the dispatcher.

---

## 1. Sarah's Discord author ID

1.1 Currently absent. The mappings block in
`config/first-agent-by-principal.json` does not include Sarah's
Discord ID. Without it, the dispatcher's identity binding refuses
every message from Sarah at the gateway boundary.

1.2 Operator action: provide Sarah's Discord author ID. Append the
mapping to the config:

```diff
   "mappings": {
-    "1495020845846761582": "jeff"
+    "1495020845846761582": "jeff",
+    "<sarah-discord-id>": "sarah"
   },
```

1.3 The `sarah` partition metadata is already staged in the
`partitions` block — `principalName: "Sarah Taylor"`,
`anthropicKeyVaultRef: "op://CoS-Dispatcher/quinn-runtime/credential"`,
`claudeAgent: "quinn"`. Once the mapping is added, the dispatcher
routes Sarah's Discord messages to Quinn automatically.

1.4 CC will not invent or guess Sarah's Discord ID. If she does not
yet have a Discord account in the workspace, that provisioning step
sits ahead of this one (per the existing Sarah-login procedure
from the seventeenth session).

---

## 2. Quinn's Anthropic API key in vault

2.1 Per OD-038 spawned-worker attribution and OD-012a per-EA
runtime keys, Quinn requires its own Anthropic API key. The vault
reference is staged in the partitions block at
`op://CoS-Dispatcher/quinn-runtime/credential`. Until the key is
populated, any Quinn-spawned worker that requires the per-EA key
will fail to authenticate.

2.2 Operator action steps:

- Sign into the Anthropic Console at the CBS Group organisation
  (the same org that hosts the existing `alex-morgan-runtime`
  key).
- Generate a new API key. Name convention: `quinn-runtime`. Apply
  the same workspace assignment as `alex-morgan-runtime` for cost
  attribution consistency (per OD-012a, both fold into the
  dispatcher 50% bucket).
- Copy the key value once — Anthropic's console only shows it at
  generation time.
- Stage in 1Password vault `CoS-Dispatcher`. Item type: API
  Credential. Item title: `quinn-runtime`. Field: `credential`
  (string, secret). Resulting reference path:
  `op://CoS-Dispatcher/quinn-runtime/credential`.
- Verify with `op read op://CoS-Dispatcher/quinn-runtime/credential`
  before signalling completion.

2.3 The dispatcher does not consume the vault reference at runtime
in this PR — the wiring that injects the per-EA key into spawned
workers is a follow-up (the existing dispatcher uses one
`ANTHROPIC_API_KEY` env globally). The vault reference is staged
so the wiring can land cleanly when ready, and so the cost-tracker
artefact has a stable identifier for the key now.

---

## 3. STYLE.md drafting mode

3.1 Migration Plan §14.4 carry-over offers two modes:

- **Mode (a)** — CC drafts a generic starting point based on the
  operator's understanding of Sarah's preferences, surfaces to the
  operator, operator reviews and forwards to Sarah for approval.
  This is the default per the carry-over.
- **Mode (b)** — Sarah engages directly via her newly-created
  Paperclip account, contributes to drafting.

3.2 This PR ships a **mode (a)** draft at
`docs/eas/sarah/style-draft.md`. If the operator prefers mode (b),
discard the staged draft and run mode (b) in a follow-up session.

3.3 Sarah's input on §1 (tone), §2 (proactivity), and §3
(escalation) is the most important. Those three categories carry
most of the principal-specific signal; §4 (boundaries) and §5
(format) are largely consistent across the EAs.

3.4 The operator's review pass should sanity-check the WR-specific
sections — particularly the WREI dual-principal ratification rule
in §3.5 and the standby-agent reference in §4.4. The §6 document
control block names this as a starting-point hypothesis; Sarah's
own preference governs.

---

## 4. STYLE.md approval — fourth bootstrap pause point

4.1 This is the **fourth and final** bootstrap pause point per the
standing posture rule. Once Sarah's approval lands:

- Move the approved baseline from `docs/eas/sarah/style-draft.md`
  to `state/seeds/eas/sarah/style.md`. Delete the draft.
- Update `bootstrap.ts` to seed the new file onto the runtime
  volume (extend the SEED_FILES list pattern; add a `state/eas/`
  subdirectory traversal so the per-EA seed pattern is uniform
  across partitions).
- Commit and push. The follow-up commit completes Phase J.1b.

4.2 Quinn's runtime baseline is read by the dispatcher at boot via
the seed pattern. The runtime write-interceptor (per architecture
§2.2.6) prevents Quinn from modifying the file in place.

---

## 5. Verification ping

5.1 After §1 (Sarah's Discord ID mapped), §2 (vault key staged),
§3/§4 (STYLE.md committed), and a dispatcher restart, run the
verification ping per the multi-EA runbook (§2.9):

- Send a test Discord message from Sarah's Discord account in any
  allowed channel.
- Confirm `state/identity-binding-audit.jsonl` records an `allow`
  decision naming the `sarah` partition.
- Confirm the dispatcher log emits `identity_binding_allow` with
  `partition: "sarah"` and `hasVaultRef: true`.
- Confirm a session is created in the `sarah` partition.
- Confirm the spawned worker invokes the `quinn` agent (visible in
  the worker registry log line and the `--agent quinn` argument
  on the spawn command).

5.2 If any of the above fails, the multi-EA runbook §6 covers the
common failure modes and the operator triage path. The most
likely failure mode in the bootstrap window is the agent-routing
wiring not having reached production deploy — confirm via
`fly status` that the dispatcher is running the post-merge image.

---

## 6. Sarah onboarding session

6.1 Once Quinn is verifiably live (§5 passes), schedule the
30-minute Sarah onboarding session per Migration Plan §14.4.5.

6.2 The orientation pack at
`dispatcher/docs/sarah-onboarding/` covers the operator-side
running order. The README's pre-flight checklist gates the
session; do not run orientation until every checkbox is ticked.

6.3 Phase J.4 shake-down (one-month window) begins once Sarah's
orientation is complete and Sarah confirms her STYLE.md baseline
in normal use.

---

## 7. Document control

Author: Claude Code (Migration Plan §14.4 carry-over instructions).
Last review: 2026-04-30.
Source of truth: this file in `dispatcher/docs/eas/sarah/`.
Cross-references: Migration Plan §14.4 (Phase J.1b Quinn bootstrap);
architecture v2.1 §2.2 (multi-EA pattern); OD-035 (Quinn name);
OD-038 (per-EA runtime keys); OD-012a (spawned-worker cost
attribution); operator-action checklist sits alongside the draft
STYLE.md as the operator's working surface for Phase J.1b.
