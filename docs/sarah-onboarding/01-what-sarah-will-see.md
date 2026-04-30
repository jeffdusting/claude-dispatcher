# What Sarah will see — Quinn from the Discord side

This is the plain-English lead-in to the orientation. Hand Sarah a
copy at the start of the session.

---

## 1. Quinn is Sarah's executive assistant

1.1 Quinn is an AI agent — a software process — that lives on the
operator's cloud server and engages with Sarah through Discord.
Quinn is not a person; Quinn is not Jeff; Quinn is not a search
engine. Quinn does substantive work on Sarah's instructions and
under Sarah's standing preferences.

1.2 Quinn serves Sarah only. The same dispatcher also runs Alex
(Jeff's EA), but Alex and Quinn do not share content with each
other or surface the other principal's material to their own
principal without explicit instruction. The boundary is enforced
by three independent layers — the dispatcher refuses messages from
unmapped principals, each EA's own definition carries a "you serve
<name> only" directive, and every cross-principal action is
recorded on a durable audit log the operator reviews weekly.

---

## 2. Quinn's response style

2.1 Quinn responds the way Sarah's STYLE.md says Quinn should
respond. The STYLE.md governs five categories: tone and register,
proactivity threshold, escalation rules, boundary rules, and
engagement format defaults. Sarah's STYLE.md is the artefact Sarah
authors during this orientation (see file
`03-style-md-walkthrough.md`).

2.2 Quinn cannot modify Quinn's own STYLE.md at runtime. Changes go
through a git review process with the operator's CODEOWNERS rule on
the `river-config` repository. In practice: if Sarah wants to change
how Quinn behaves, Sarah tells the operator in Discord, the operator
updates the STYLE.md, the operator approves the change, and Quinn
picks it up on next restart.

2.3 Quinn drifts over time. The operator runs a weekly drift audit
that flags Quinn's outputs that diverge from the STYLE.md baseline.
Drift is normal and is the operator's signal to bring Quinn back in
line — through STYLE.md tightening, through agent-definition edits,
or through coaching.

---

## 3. How Sarah talks to Quinn

3.1 Sarah talks to Quinn in Discord. Each conversation is a Discord
thread; the thread title is what the conversation is about; the
thread runs as long as Sarah needs it. Quinn replies in the thread.

3.2 To start a new conversation, Sarah writes in one of the
allowlisted channels (see `02-orientation-script.md` §3 for the
channel list) with `@<bot-name>` in the message. The dispatcher
creates a new thread, names it from the message, and Quinn begins.

3.3 To continue an existing conversation, Sarah writes in the thread.
No mention is needed inside a thread — the dispatcher knows the
thread is Quinn's.

3.4 Sarah can attach files. The dispatcher hands the attachments to
Quinn at the start of the next turn.

3.5 Sarah can use `!status` in a thread or channel to see what Quinn
is doing. `!stats` shows aggregate dispatcher stats.

---

## 4. What happens when something goes wrong

4.1 If Quinn errors mid-turn, Sarah sees an error message in the
thread. Quinn's session is preserved — Sarah can continue the
conversation; the dispatcher resumes the same Quinn session where
possible.

4.2 If Quinn does not respond within a few minutes, the dispatcher
is likely under load or the Anthropic upstream is paused (monthly
cap). Sarah's options are to wait, to use `!status` to confirm, or
to escalate to the operator (see `04-escalation-and-audit.md`).

4.3 If the dispatcher is down entirely (e.g. Fly.io outage), Discord
returns no reply at all. The operator runs a warm-spare procedure to
restore service from the laptop or desktop; Sarah does not need to
do anything beyond noting the outage and waiting.

---

## 5. What Sarah should not do

5.1 Do not share Quinn's API key or any vault credential with anyone.
Sarah will not normally have direct access to credentials; if the
operator hands one over (e.g. for a one-off task) it stays with
Sarah and is rotated afterwards.

5.2 Do not attempt to modify Quinn's STYLE.md or agent definition
directly. Both are git-controlled with CODEOWNERS gates; changes go
through the operator.

5.3 Do not invoke Alex (Jeff's EA) on Sarah's behalf. The dispatcher
will refuse — but the architecturally correct path is to ask the
operator if a cross-EA hand-off is appropriate.

5.4 Do not rely on Quinn for legal, tax, or compliance advice.
Quinn produces drafts, summaries, and operational support; the
operator and qualified specialists own any binding advice.
