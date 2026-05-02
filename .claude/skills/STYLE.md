# Skills directory — STYLE.md

This file is the canonical style guide for SKILL.md authoring under `~/claude-workspace/generic/skills/`. Every skill in this directory must follow the structure, frontmatter, and discipline described here. The discipline answers Architecture Review 4 finding A-007 ("Skills lack version control discipline and change-impact analysis") and is sequenced under Phase G.5 of the River migration.

The guide is split into seven parts:

1. Filesystem layout for a skill.
2. SKILL.md frontmatter — required and optional fields.
3. SKILL.md body — required sections.
4. Versioning rules.
5. Changelog format.
6. Consumers-list maintenance.
7. Pre-merge CI hook.

---

## 1. Filesystem layout for a skill

1.1 One directory per skill at `~/claude-workspace/generic/skills/<skill-name>/`. The skill name uses lowercase letters, digits, and hyphens. No underscores, no camelCase, no spaces.

1.2 The skill directory contains exactly one canonical authoring file: `SKILL.md` (uppercase). Reference helpers (Python implementations, shell scripts, fixtures) sit alongside the SKILL.md as needed; the SKILL.md is the contract, the helpers are illustrative.

1.3 Each skill is independent. Skills do not share code at the filesystem level; if two skills need the same logic, the logic belongs in a shared library that both depend on, not in a copy-pasted helper.

---

## 2. SKILL.md frontmatter — required and optional fields

2.1 Every SKILL.md begins with YAML frontmatter delimited by `---`. The frontmatter carries the metadata that satisfies A-007.

2.2 Required fields:

- `name` — the skill name. Matches the directory name.
- `description` — one paragraph describing the skill's purpose and the boundary it sits behind. Loaded into agent prompts as the skill's one-line summary; keep tight.
- `version` — semver string. See §4.
- `status` — one of `active`, `deprecated`, `retired`. New skills ship as `active`. Retired skills are moved to `~/claude-workspace/generic/skills/_retired/` rather than left in the active tree with `status: retired`; the field exists for the brief window where a skill is in the deprecation grace period.
- `source-of-truth` — the absolute path to this SKILL.md. Documents authority for the inevitable Paperclip-vs-local sync question.
- `last-updated` — ISO date of the last version bump.
- `consumers` — list of agents and other skills that reference this skill. See §6.

2.3 Optional fields:

- `companies` — list of Paperclip companies the skill is registered under (e.g., `[CBS Group, WaterRoads]`). If the skill is universal across companies, omit the field.
- `replaces` — name of the skill this one supersedes, if any. Used during deprecation transitions.
- `replaced-by` — name of the skill that supersedes this one. Set when the skill enters the `deprecated` status.

---

## 3. SKILL.md body — required sections

3.1 Every SKILL.md body uses legal-style numbering (1, 1.1, 1.1.1) and Australian spelling. Section ordering is fixed:

- §1 — Purpose. What the skill does and why it exists. References the underlying review finding or operator decision when applicable.
- §2 — When to use. Trigger conditions in prose. Pair with explicit "do not use" cases that mark the skill's boundary.
- §3 — Inputs. Each parameter as a numbered sub-section. State whether each is required or optional and provide a default for optional parameters.
- §4 — Outputs. The shape of the return value. Each top-level field documented.
- §5 — Credential pattern. Which credentials the skill reads from the worker environment, how the dispatcher worker spawn loads them, and what fails if a credential is missing. The cross-entity skills additionally document audit shards.
- §6 — Failure modes. Named errors the skill surfaces, plus the conditions that produce each. Named errors are uppercase-with-underscores (`MISSING_CREDENTIAL`, `RATE_LIMITED`).
- §7 — Versioning and changelog. The §4 versioning rules in summary plus the changelog table. See §5 below for the changelog format.
- §8 — Related artefacts. Cross-references to architecture documents, review findings, decisions, runbooks. Use the "The first / second / third related artefact is …" pattern from the existing supabase-query SKILL.md so the section reads as prose, not as bullets without context.
- §9 — Document control. The standard table — skill name, source-of-truth, status, author, update cadence.

3.2 Bulleted lists in the body must have leading sentences. No bare bullets without context.

3.3 No emojis. No motivational cadence ("transformative", "compelling", "journey"). Direct register, understated tone.

---

## 4. Versioning rules

4.1 Every SKILL.md carries a semver `version`. Bumps follow standard semver semantics applied to the skill's contract:

- **Patch (0.1.0 → 0.1.1)** — bug fixes, documentation corrections, error-message wording, no consumer-visible change. Append a changelog entry.
- **Minor (0.1.0 → 0.2.0)** — additive changes that consumers may opt into without breaking. Examples: new optional input parameter, new output field, new failure mode that consumers can ignore. Consumers list may gain entries; existing consumers are not invalidated.
- **Major (0.x.y → 1.0.0)** — breaking changes. Examples: input parameter removed or renamed, output field removed or renamed, default behaviour changed in a way that consumers must update for. Major bumps require updating every consumer's prompt template alongside the skill change.

4.2 The first stable release is 1.0.0. Skills authored at 0.x.y are in draft. The transition to 1.0.0 happens once the skill has consumers in production and at least one production cycle without breaking changes.

4.3 Version bumps are manual. There is no automatic bumping based on file diff. The author decides which level applies and updates the frontmatter `version` plus the changelog atomically.

---

## 5. Changelog format

5.1 The changelog lives in §7.1 of the SKILL.md body. Every entry has three columns: `Version`, `Date`, `Change`.

5.2 The `Change` column is one paragraph in direct register. Lead with the change; follow with the rationale; end with the impact on consumers.

5.3 Entries are append-only. Do not edit historical entries. If a published change later turns out to have unexpected consequences, add a new patch-level entry recording the consequences and (if applicable) the fix; do not rewrite history.

5.4 Date format is ISO (`2026-04-29`). Australian local time when ambiguous.

---

## 6. Consumers-list maintenance

6.1 The consumers list in the frontmatter records every agent and every other skill that references this skill. The list is the input to the §7 pre-merge CI hook and to the §4 retirement procedure.

6.2 When a new agent is recruited with the skill in its toolset, the recruiting flow updates the skill's consumers list synchronously. The recruitment commit and the skill consumers-list update are in the same PR.

6.3 When an agent is retired (per the retirement procedure documented at `~/claude-workspace/generic/skills/agent-retirement/SKILL.md`), the retirement flow removes the agent from every skill's consumers list synchronously. The retirement commit bumps the patch version of every affected SKILL.md.

6.4 When a skill is itself a consumer of another skill (e.g., cross-entity-mail-intake's `kb-trace` mode consumes the supabase-query credential pattern), the producing skill records the consumer skill in its consumers list.

6.5 Consumers list entries use one of these forms:

- Bare agent name for Paperclip agents (e.g., `office-management-wr (WaterRoads)`).
- "dispatcher worker spawn (post-A.5.3 — entity-scoped invocation)" for the dispatcher's worker spawn path.
- Skill name plus a brief annotation for skill-on-skill consumption (e.g., `cross-entity-mail-intake skill (kb-trace output mode writes to WR Supabase via this skill's credential pattern)`).

---

## 7. Pre-merge CI hook

7.1 The `~/claude-workspace/generic/skills/CI-HOOK.md` file specifies the pre-merge CI hook contract. The hook fires on any PR that modifies a `SKILL.md` in this directory.

7.2 The hook reads the changed skill's frontmatter consumers list, opens each consumer's prompt template (or the consumer skill's SKILL.md), runs a syntactic check that the consumer's references to the changed skill still parse, and posts a summary comment on the PR listing affected consumers.

7.3 The hook does not block the merge. A skill change may legitimately require updating consumers. The hook ensures the impact is visible to the reviewer before approval; the reviewer judges whether the consumer updates land in the same PR or in a follow-on.

7.4 Adding the hook itself is a follow-on operator action — the hook specification establishes the contract, the GitHub Action workflow file is authored separately, and the hook is enabled at the workspace repository's Settings → Actions → Workflows level.

---

## 8. Document control

| Item | Value |
|---|---|
| Document | Skills directory STYLE.md |
| Source of truth | `~/claude-workspace/generic/skills/STYLE.md` |
| Status | Active. Authored 2026-04-29 during Phase G.5 / A-007. |
| Author | CBS Group, drafted with Claude Code |
| Update cadence | Append-only; revise on substantive discipline changes; record revisions in a changelog at the bottom of this file when the first one occurs. |
