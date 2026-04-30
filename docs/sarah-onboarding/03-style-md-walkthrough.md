# STYLE.md drafting walkthrough

Quinn's STYLE.md is the single most consequential artefact Sarah
authors during onboarding. It governs how Quinn engages with Sarah on
every turn from now on. Migration Plan §14.4.3 places the operator's
one-time approval here as the fourth bootstrap pause point.

---

## 1. Choose the drafting mode

The operator chooses one of two modes at the start of orientation
(Migration Plan §14.4 carry-over):

1.1 **Mode (a) — operator-drafted starting point.** The operator
(or Claude Code on the operator's behalf) authors a generic STYLE.md
based on what the operator knows of Sarah's preferences. The
operator hands the draft to Sarah for review; Sarah edits and
approves. The default mode unless the operator chooses (b).

1.2 **Mode (b) — Sarah-drafted via Paperclip.** Sarah engages
directly with a Paperclip-hosted Claude session under her newly
created Paperclip account. The session walks Sarah through the
template (file `docs/river-migration/23-river-style-md-template.md`)
and produces a draft Sarah is satisfied with. The operator reviews
the draft for compatibility with the dispatcher's runtime
constraints; Sarah's editorial choices stand.

1.3 Both modes end at the same place — a draft STYLE.md committed
to `state/eas/<sarah-partition>/style.md` (or the principal-keyed
partition path determined in Phase J.1b §14.4.4). The principal-
approval gate gates that commit; Claude Code does not commit the
draft until Sarah and the operator both sign off.

---

## 2. The template

The template lives at `docs/river-migration/23-river-style-md-template.md`
in the river-migration pack. It has five top-level sections that
correspond to the five categories from architecture v2.1 §2.2.6:

2.1 **Tone and register.** How Quinn talks. Direct or warm; formal
or casual; brief or expansive; written like a colleague or written
like a service. Sarah's preference here is the strongest signal
Quinn picks up.

2.2 **Proactivity threshold.** When Quinn volunteers next steps
versus waits to be asked. A high threshold means Quinn answers what
was asked and stops; a low threshold means Quinn proposes follow-ups
unprompted.

2.3 **Escalation rules.** When Quinn surfaces something to the
operator (Jeff) instead of handling it autonomously. Default is
high-stakes operational items only — financial commitments, legal
risk, anything that touches WaterRoads board governance. Quinn
should not escalate routine work.

2.4 **Boundary rules.** What Quinn declines to do. Examples:
producing legal advice, signing on Sarah's behalf, sharing CBS
content with Sarah where the operator's posture is CBS-restricted,
making public statements without Sarah's review.

2.5 **Engagement format defaults.** How Quinn structures replies.
Examples: bulleted lists with leading sentences, legal-style
numbering, no emojis, Australian spelling, no "transformative" /
"compelling" / "journey" register.

---

## 3. Drafting prompts — operator's checklist when running mode (a)

If the operator (or Claude Code) is producing the draft, run through
these prompts before handing the draft to Sarah:

3.1 What tone does Sarah use in her own Discord messages? Match it.

3.2 What does Sarah expect when she asks a question — a direct
answer, or a discussion that explores options? The proactivity
threshold maps to that.

3.3 Has Sarah expressed preferences about format in the past?
(Bullets, numbering, length defaults.) If yes, encode them; if
unknown, leave them open and ask Sarah during review.

3.4 What is Sarah's working hours and availability signal? Does
Quinn say "I'll have this by tomorrow" when Sarah is offline, or
hold the response until Sarah is back? Encode the rule.

3.5 What is Sarah's escalation comfort? Some principals want
visibility of every cross-principal interaction; others want only
material exceptions surfaced. The STYLE.md governs this.

---

## 4. Sarah's review prompts — what to ask Sarah on first read

4.1 Read the draft aloud and pause at each section. Sarah's
intuitive reaction to the wording is the right signal.

4.2 Ask Sarah if there are things Quinn would always say that she
would not. (E.g. corporate-speak, hedging language, certain
sign-offs.)

4.3 Ask Sarah for examples of past communications she felt were
right, and walk through which categories they exemplified.

4.4 Ask Sarah for examples of past communications she felt were
wrong, and walk through which categories they violated.

4.5 Ask Sarah if there are topics she does not want Quinn to engage
on without escalation. (E.g. board governance, personnel matters,
specific financial decisions.)

---

## 5. Operator approval — the bootstrap pause point

5.1 Migration Plan §14.4.3 places the operator's one-time approval
of Sarah's STYLE.md as the fourth and final bootstrap pause point.
Claude Code does not commit the draft until the operator approves.

5.2 The CODEOWNERS rule on `river-config` keeps Sarah's STYLE.md
gated to the operator's approval going forward. Sarah does not
commit changes directly; the operator owns the merge.

5.3 After approval, Claude Code commits the draft to
`state/eas/<sarah-partition>/style.md` and to the corresponding
location in `river-config` per the established convention. The
runtime write-interceptor in the dispatcher prevents Quinn from
modifying the file at runtime.

5.4 First-day Quinn behaviour after approval is the operator's
diagnostic. The Phase J.4 weekly drift audit (architecture §2.2.6)
catches divergences from the baseline; the first month is the
shake-down window per Migration Plan §14.5.

---

## 6. Iteration

6.1 STYLE.md is expected to evolve. Sarah may request changes after
the first day, the first week, the first month — each is a normal
operating event.

6.2 Each change is a PR against `river-config` with the operator
as approving reviewer. Quinn picks up the change on next dispatcher
restart.

6.3 The drift audit does not punish change. It identifies divergence
between Quinn's outputs and the *current* STYLE.md baseline. Updating
the STYLE.md updates the baseline; old outputs are not re-evaluated.
