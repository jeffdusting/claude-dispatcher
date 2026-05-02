---
name: style-update
description: Receive a Discord message from your principal expressing a style preference; propose a STYLE.md edit as a Discord reply with a diff; on principal approval, write the new STYLE.md to the seed and runtime paths, commit and push the seed change, append an audit record. The skill is the operator-conditional approval mechanism for the Phase J.1 STYLE.md baselines — Migration Plan §14.3.3 / §14.4.3.
version: 0.1.0
status: active
source-of-truth: ~/claude-workspace/generic/skills/style-update/SKILL.md
last-updated: 2026-04-30
consumers:
  - chief-of-staff (Alex Morgan, jeff partition)
  - quinn (Sarah Taylor's EA, sarah partition)
---

# style-update

## 1. Purpose

The skill closes the loop between Phase J.1 STYLE.md approval and the operator's conditional-approval requirement: principals must be able to evolve their EA's style organically through Discord rather than via PR engineering. Operator approval of the Phase J.1a / J.1b baselines was conditional on this mechanism being in place; the skill is what makes the approval whole.

The skill encodes the discipline — detect, propose, approve, commit. The dispatcher's `src/styleUpdate.ts` module provides the file-I/O + audit-log primitives; this skill is the EA-facing playbook that uses them.

## 2. When to use

Use the skill when the principal you serve sends a Discord message expressing a preference about your style. The full set of triggers is wider than the literal patterns below — use judgement; the LLM-side detection is more reliable than a hard-coded matcher.

The first trigger is direct instruction. "Be more concise." "Use full sentences." "Stop hedging." "Always start with the answer." Anything that names a behavioural change.

The second trigger is reflection on a recent reply. "That last reply was too long." "I would have preferred bullets there." "You're escalating too often." The principal references something you already did and wants different next time.

The third trigger is correction. "No, when I ask X you should Y." This is a single-instance correction that may or may not generalise — surface the question of generalisation to the principal in your proposal step (§4).

Do not use the skill for one-off output adjustments inside the current turn. If the principal says "rewrite that with bullets" they want the current reply rewritten, not the STYLE.md updated. Use the skill only when the change is intended to persist.

Do not use the skill for clarifications about your existing style. If the principal asks "what's your default tone?" answer the question by reading your STYLE.md and explaining; do not propose a change.

## 3. Cross-EA boundary

You may only update **your own partition's** STYLE.md. The dispatcher's identity-binding layer (architecture v2.1 §2.2.4) routes Discord messages so Jeff reaches Alex (the `jeff` partition) and Sarah reaches Quinn (`sarah`). If the principal asks you to update the *other* EA's STYLE.md ("Alex, please make Quinn more concise"), refuse:

> I can only update my own STYLE.md. Quinn's STYLE.md is updated by Sarah via Quinn directly. If you'd like to suggest a style change to Quinn, draft the suggestion and Sarah can take it up with Quinn in their next conversation.

The cross-EA boundary is structural — the file-write path in `src/styleUpdate.ts` is partition-keyed, and the partition is determined by the Discord author's binding. Trying to update another partition is a correctness error, not a permission one.

## 4. The propose step

When a style instruction is detected, do not write to STYLE.md immediately. Compose a proposed update and surface it to the principal as a Discord reply.

The reply contains four parts:

  - A one-sentence acknowledgement of the instruction in your own words. This confirms you understood the request — if the principal disagrees, they correct here before the change lands.
  - The current relevant STYLE.md section, copied verbatim. The principal can see what you're starting from.
  - The proposed new section, in the same format. Diff-style markers (`-` for removed lines, `+` for added) are optional — readability is the priority.
  - The single-word approval prompt: "Approve?"

Worked example for Quinn:

> You'd like me to be more direct in my replies — fewer hedges, more declarative statements.
>
> Current §1.1 of my STYLE.md:
> > Direct, professional Australian register. Match Sarah's own register on the inbound message — terse when she writes terse, fuller when her brief is fuller. Default to a slightly warmer tone than Alex's default…
>
> Proposed §1.1:
> > Direct, professional Australian register. Default to declarative statements — drop hedges ("perhaps", "I think", "it might be") unless I am genuinely unsure, in which case use the standing "Unsure on X — assuming Y" template…
>
> Approve?

The proposal step is mandatory — never skip it. The principal must see the proposed text before it commits. A back-and-forth refining the proposal is fine; iterate until the principal is satisfied, then commit.

## 5. The approve step

The principal's approval phrase is open-ended. "Approve", "yes", "do it", "go", "ok" all count. Accept any reasonably-clear affirmation. If the principal's response is ambiguous ("hmm", "maybe", "let me think"), do NOT commit — wait for explicit approval.

If the principal rejects ("no", "not quite", "let me try again"), drop the proposal and re-propose if instructed, or end the flow. Do not retry without re-proposing — a rejected proposal is dead.

If the principal walks away mid-flow without responding, do not commit. The proposal expires when the conversation moves on; STYLE.md is unchanged. The audit log records nothing because no change was applied.

## 6. The commit step

Once approval is unambiguous, run the following procedure. The order matters — file write first, audit record second, git commit + push third.

### 6.1 Apply the update

Use the `applyStyleUpdate` helper from `src/styleUpdate.ts`. Pass the partition name (yours, not the other EA's), the full new STYLE.md content, the principal's Discord author ID, the principal's display name from the partition metadata, the message ID of the instruction (or any short reference), and a short summary of the change.

The helper writes to both `state/seeds/eas/<partition>/style.md` (durable) and `state/eas/<partition>/style.md` (runtime), and appends to `state/style-update-audit.jsonl`. Returns the previous content so you can reference it in your confirmation reply.

### 6.2 Commit and push the seed change

The seed file is in the dispatcher repo's tracked tree. Commit and push so the change has durable git history. Use the standard commit message convention:

```
style-update(<partition>): <one-line summary>

Approved-by: <principal-name> (Discord author <id>)
Instruction-ref: <message-id-or-ref>
Audit: state/style-update-audit.jsonl <ISO-timestamp>
```

The commit goes onto a feature branch named `style-update-<partition>-<YYYY-MM-DD>-<short-hash>` and is pushed for normal PR review. Do NOT push directly to main — STYLE.md changes still benefit from a brief operator glance even when the principal has already approved. Operators can self-approve via `gh pr merge --admin --squash` once they've eyeballed the diff.

If you are running on the cloud dispatcher and lack the local credentials to push, surface the local commit to the principal with a note that the operator needs to push it. Do not block the user-facing flow on the push step.

### 6.3 Confirm to the principal

Post a short Discord reply confirming the change is live:

> STYLE.md updated and committed (seed at `state/seeds/eas/<partition>/style.md`; PR #N for operator review). Effective on my next session.

The principal does not need to restart anything — the change applies on next session start.

## 7. Limitations

The skill has known limitations that the principal should understand if they are surprised by behaviour:

  - **Current session does not reload.** STYLE.md is read at session start. Once a session is running, changes to STYLE.md do not take effect mid-session. The new style applies from the principal's next message that spawns a fresh agent invocation.
  - **Cross-EA updates require the operator.** If Sarah wants to change Alex's style or vice versa, neither EA can do it directly — the operator updates the other partition's STYLE.md via PR.
  - **Style changes do not retroactively edit past outputs.** The drift audit (architecture §2.2.7 weekly review) compares EA outputs against the *current* STYLE.md baseline; old outputs are not re-evaluated against new rules.
  - **Push may require operator follow-up.** The cloud dispatcher's git credentials may not support push to a writable repo; in that case the local commit is recorded and the operator pushes it.

## 8. Audit visibility

Every applied update produces a JSONL record at `state/style-update-audit.jsonl`. Fields: timestamp, partition, principalName, principalAuthorId, instructionRef, summary, previousLength, newLength. Cross-reference with the git history on the seed file for the actual diff content.

The operator reviews the audit log alongside the existing weekly mailroom audit (architecture §2.2.7 / §6.7). Iterative style changes are an expected operating event; the audit confirms that each change was principal-authorised and bounded to the right partition.

## 9. Outputs

The skill returns a structured summary:

  - `partition` — the partition that was updated
  - `seedPath` — absolute path to the seed file
  - `runtimePath` — absolute path to the runtime file
  - `auditRecord` — the JSONL record appended
  - `previousContent` — the full prior STYLE.md text (for diffs / revert)
  - `commitSha` — the dispatcher commit SHA, populated after step 6.2 if the EA recorded it via git rev-parse HEAD
  - `pullRequestUrl` — populated after `gh pr create` if applicable

The audit record is the durable signal the operator's review pulls from; the file paths are useful for the EA's own subsequent reads.
