# Skills directory — pre-merge CI hook specification

This file specifies the pre-merge CI hook contract for changes to any `SKILL.md` under `~/claude-workspace/generic/skills/`. The hook is the third component of the A-007 skill versioning discipline (per Architecture Review 4): SKILL.md metadata in §1–§2 of `STYLE.md`, manual version bumps in §3–§5, and this automated change-impact summary as the third leg.

The specification is deliberately implementation-light. The hook itself is a small GitHub Action; the contract this document establishes is what the hook reads, what it checks, and what it posts. Implementation lands in a follow-on PR.

The specification is split into seven parts:

1. Trigger conditions.
2. What the hook reads.
3. What the hook checks.
4. What the hook posts.
5. Block-versus-warn behaviour.
6. Failure modes for the hook itself.
7. Implementation pointers.

---

## 1. Trigger conditions

1.1 The hook fires on every PR (open, synchronise, reopen) that modifies any file matching `~/claude-workspace/generic/skills/**/SKILL.md`. The match excludes the top-level `STYLE.md` and `CI-HOOK.md` (this file) and excludes the `_retired/` subdirectory.

1.2 Multi-skill PRs fire the hook once per modified SKILL.md. The hook reports each affected skill in a separate comment block within a single consolidated PR comment, so the reviewer sees one summary rather than `n` comments for `n` skills.

1.3 The hook does not fire on PRs that touch only the directory's reference helpers (Python implementations, shell scripts) without changing the SKILL.md. A non-SKILL.md change that consumers depend on still warrants a SKILL.md changelog entry per the §3 rule that contract changes bump the version — the hook surfaces the absence of that bump as a §3 violation if the helper is the contract surface.

---

## 2. What the hook reads

2.1 The first read is the changed `SKILL.md`'s YAML frontmatter at the merge base and at the PR head. The diff between the two surfaces the version bump (or its absence).

2.2 The second read is the consumers list at the PR head. The list is the input to the change-impact summary.

2.3 The third read is the body diff of the changed SKILL.md. The diff identifies whether §3 (Inputs), §4 (Outputs), §5 (Credential pattern), or §6 (Failure modes) sections changed — these are the consumer-visible sections; changes here drive the impact assessment.

2.4 The fourth read is, for each agent in the consumers list, the agent's prompt template. The template is the agent's `AGENTS.md` file at `~/Desktop/Projects2/River/agent-instructions/<agent-name>/AGENTS.md`. The hook reads the template and greps for references to the changed skill — by name in the toolset list, by parameter name in delegation rules, by output-field reference in synthesis steps.

2.5 The fifth read is, for each skill in the consumers list, the consumer skill's SKILL.md. Same parsing approach — surface where the consumer skill references the changed skill.

---

## 3. What the hook checks

3.1 The first check is version-bump correctness. The frontmatter `version` at the PR head must be greater than at the merge base. The bump level (patch / minor / major) must match the diff:

- A diff confined to docstring-style prose, error-message wording, or §7 changelog updates supports a patch bump.
- A diff that adds an optional input parameter, an output field, a failure mode, or a consumer requires at least a minor bump.
- A diff that removes or renames an input parameter, removes or renames an output field, changes a default value, or changes the credential pattern requires a major bump.

3.2 The second check is changelog freshness. The §7.1 changelog table must gain a new row matching the new version. The row's date column must be the PR-head date (or within one day, to allow for review-cycle delays). The change-description column must not be blank.

3.3 The third check is consumers-list integrity. Every consumer named in the list must resolve to a real consumer:

- Agent consumers must have an `AGENTS.md` at `~/Desktop/Projects2/River/agent-instructions/<agent-name>/AGENTS.md` (or in the `_retired/` subtree if the consumer was retired in the same PR — the hook tolerates the latter case).
- Skill consumers must have a SKILL.md at `~/claude-workspace/generic/skills/<skill-name>/SKILL.md`.
- The dispatcher worker spawn entry resolves to the dispatcher repository's worker-spawn code path; the hook does not chase this reference but allows it as a recognised string.

3.4 The fourth check is consumer coverage of breaking changes. For a major version bump, the hook surfaces every consumer whose prompt template references a removed or renamed input/output field. The reviewer sees the affected consumer list and judges whether the consumer updates land in the same PR or are queued for follow-on.

---

## 4. What the hook posts

4.1 The hook posts a single comment on the PR. The comment has the title `Skill change-impact summary` and contains:

4.1.1 The first sub-section is one block per modified SKILL.md. Each block names the skill, the version transition (e.g., `0.1.0 → 0.2.0`, with the bump level annotated), the count of consumers, and a one-line summary of what changed.

4.1.2 The second sub-section is the consumer table. For each consumer of each modified skill, a row records the consumer name (with its file path), whether the consumer's prompt or SKILL.md was scanned for references, and whether the scan found anything that the change might invalidate.

4.1.3 The third sub-section is the §3 check results. Each check is reported as `pass`, `fail`, or `warn`. `fail` results identify the specific §3 sub-rule and the line in the diff that triggered the failure.

4.2 The comment is updated in place on subsequent pushes to the PR (one comment per PR, refreshed). The hook uses a marker comment (`<!-- skill-impact-summary -->`) to find and update its own comment rather than creating a new one each time.

---

## 5. Block-versus-warn behaviour

5.1 The hook does not block the merge. A reviewer with merge authority can approve and merge a PR even if the hook has reported `fail` on §3 checks. The hook's role is to surface, not to gate.

5.2 The reasoning is that some legitimate changes will trip the §3 checks. A consumer prompt update that lands in a separate PR than the skill change is a valid pattern (sometimes the consumer-side PR needs its own review cycle). The hook surfaces the gap; the reviewer judges whether the gap is acceptable.

5.3 If the operator decides at a future point that the hook should block (e.g., on `fail` for the version-bump correctness check), the workflow file is updated to set `required_status_check: true` for the hook. The current draft posture is warn-only.

---

## 6. Failure modes for the hook itself

6.1 The hook fails closed. If the hook itself encounters an error (cannot parse a YAML frontmatter, cannot read a consumer file, network call fails), it posts a comment with the error and the marker `<!-- skill-impact-summary-error -->`. The reviewer can investigate or override.

6.2 The hook does not fall back to a permissive posture on its own errors. A silent failure that lets a skill change merge without surface-area analysis defeats the purpose; the explicit error is the correct behaviour.

---

## 7. Implementation pointers

7.1 The hook is implemented as a GitHub Action at `.github/workflows/skill-impact.yml` in the workspace repository. The Action is authored in a follow-on PR; this file establishes the contract that PR satisfies.

7.2 The Action's runtime is a small Python or TypeScript script that reads the changed SKILL.md files, parses the frontmatter, reads the consumer files, and posts the comment. The script is checked in alongside the workflow file at `.github/scripts/skill-impact.{py,ts}`.

7.3 The Action runs on `pull_request` events filtered by the §1.1 path expression. Runtime is expected to be under one minute even at the top end of the consumer-count range.

7.4 The Action requires repository read access and PR-comment write access. No secrets are loaded — no third-party API calls, no calls outside the repository.

7.5 Future enhancement (not in scope for the initial CI hook): correlate the change-impact summary with the operator's recent skill-usage telemetry once A-008 (skill-usage telemetry) lands. The summary then ranks affected consumers by recent activity, surfacing high-impact consumers ahead of dormant ones.

---

## 8. Document control

| Item | Value |
|---|---|
| Document | Skills directory CI-HOOK.md (specification) |
| Source of truth | `~/claude-workspace/generic/skills/CI-HOOK.md` |
| Status | Active specification. Implementation queued for a follow-on PR; not yet running on PRs as of 2026-04-29. |
| Author | CBS Group, drafted with Claude Code |
| Update cadence | Append-only changelog at the bottom of this file (none yet); revise on substantive contract changes. |
