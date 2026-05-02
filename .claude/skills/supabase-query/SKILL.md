---
name: supabase-query
description: Query the entity-scoped Supabase pgvector knowledge base. Used by Paperclip agents and dispatcher-spawned workers to retrieve context documents from CBS or WR Supabase via semantic search with full-text fallback. Credential is provided per-entity by the spawning process; the skill never reads cross-entity credentials.
version: 0.2.0
status: active
source-of-truth: ~/claude-workspace/generic/skills/supabase-query/SKILL.md
last-updated: 2026-04-29
consumers:
  - cbs-leo (CBS Group CEO agent — Paperclip)
  - cbs-cfo (Paperclip)
  - cbs-coo (Paperclip)
  - cbs-governance (Paperclip)
  - wr-cfo (Paperclip)
  - wr-cto (Paperclip)
  - wr-rdti (Paperclip)
  - dispatcher worker spawn (post-A.5.3 — entity-scoped invocation)
  - cross-entity-mail-intake skill (kb-trace output mode writes to WR Supabase via this skill's credential pattern; added Phase G.5 / 2026-04-29)
---

# supabase-query

## 1. Purpose

The skill performs entity-scoped retrieval against the appropriate Supabase pgvector knowledge base. The CBS knowledge base (1,188 documents, 1024-dim Voyage embeddings) and the WaterRoads knowledge base (380+ chunks, same model) are physically separate Supabase projects. The caller specifies the entity context; the skill loads only the credential for that entity from the worker environment.

The skill is the agent-side counterpart to the dispatcher's per-entity service-account routing for Drive (Phase A.5.1). Both implement the credential-scoping pattern described in Architecture v2.1 §6 and Review 3 finding DA-005.

## 2. When to use

Use the skill when an agent needs to retrieve prior decisions, policies, board papers, technical specifications, contractual terms, or any other context document held in the entity's knowledge base. Do not use the skill for live operational data (Paperclip task state, Discord channel state, mailbox content) — those have dedicated skills.

Do not call the skill cross-entity. A WR agent must not call the skill with `entity: "cbs"` and a CBS agent must not call it with `entity: "wr"`. The credential will not be present in the worker environment, the call will fail, and the failure will be flagged in the trace pipeline as a cross-KB query attempt (Review 3 DA-013 audit pattern).

## 3. Inputs

The skill takes the following parameters:

3.1 `entity` — required. One of `cbs` or `wr`. Selects which knowledge base to query and which credential to load. There is no default; the caller must declare entity context explicitly.

3.2 `query` — required. The natural-language query string. The skill embeds the query with the same Voyage model used for ingestion (1024-dim) and runs the `match_documents` RPC against the matching Supabase project.

3.3 `match-count` — optional. Maximum number of vector matches to return. Default 8.

3.4 `match-threshold` — optional. Minimum cosine similarity for a vector match to be returned. Default 0.78. Below the threshold, the skill falls back to full-text search using PostgreSQL `tsvector` over the `content` column.

3.5 `filter` — optional. JSON object of metadata key-value pairs to constrain the search (e.g. `{"doc_type": "board-paper", "year": 2026}`). Applied as a `WHERE metadata @> $filter` clause.

## 4. Outputs

The skill returns an array of match objects. Each match contains the document chunk text, the source document identifier, the chunk index within the document, the cosine similarity score, and the metadata object as stored at ingestion. If full-text fallback was invoked, the response includes a `fallback: "full-text"` flag at the top level.

If no matches are found above the threshold and full-text fallback returns nothing either, the skill returns an empty array. The caller is responsible for handling the empty case — typically by reporting "no relevant context found" upstream rather than fabricating an answer.

## 5. Credential pattern

The skill reads the service-role key from the worker environment. The dispatcher's worker spawn (post-Phase A.5.3) sets exactly one of `CBS_SUPABASE_SERVICE_ROLE_KEY` or `WR_SUPABASE_SERVICE_ROLE_KEY` based on the project descriptor's `entity` field. The skill resolves the variable name from the `entity` input parameter:

- `entity: "cbs"` → `CBS_SUPABASE_SERVICE_ROLE_KEY` and `CBS_SUPABASE_URL`.
- `entity: "wr"` → `WR_SUPABASE_SERVICE_ROLE_KEY` and `WR_SUPABASE_URL`.

If the variable is missing, the skill fails fast with a structured error that includes the entity, the missing variable name, and a hint that this likely indicates a cross-entity invocation. The error is recorded in the trace pipeline.

The skill never reads `*_ANON_KEY` variants — service-role only. Anon keys are reserved for end-user-facing surfaces and do not exist in the worker environment.

## 6. Failure modes

The skill surfaces the following failure modes to the caller:

6.1 `MISSING_CREDENTIAL` — the expected entity-scoped variable is not in the worker environment. Indicates a cross-entity invocation or a worker-spawn misconfiguration.

6.2 `EMBEDDING_FAILED` — the Voyage embedding call failed. Retried per the resilience policy (Phase A.9). After retry exhaustion, the error propagates.

6.3 `RPC_FAILED` — the Supabase `match_documents` RPC returned an error (network, timeout, or database error). Retried per the resilience policy.

6.4 `EMPTY_RESULT` — both vector and full-text search returned zero rows. Not a hard error; the caller decides whether to treat it as one.

## 7. Versioning and changelog

The skill follows semver. Breaking changes (parameter renames, removal of return fields, change in default behaviour) bump the major version. Additive changes bump the minor. Bug fixes bump the patch.

The Paperclip-side copy is re-synced from this local file in a later phase (per Review 4 finding A-007 — skill versioning discipline). Until the sync runs, the Paperclip-side copy may lag this file by a version.

### 7.1 Changelog

The first entry records the migration of the skill into local source control with the version field, changelog, and consumers list per A-007.

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-04-27 | Initial local SKILL.md authored under OD-031. Models the existing Paperclip-side skill's purpose and credential pattern; adds the version-status-consumers metadata required by A-007. No behaviour change relative to the Paperclip-side copy at the time of authoring. |
| 0.2.0 | 2026-04-29 | Consumers list gains the cross-entity-mail-intake skill (Phase G.5 / A-003). Cross-entity-mail-intake's `kb-trace` output mode posts trace blocks to WR Supabase via the credential pattern documented in §5 of this skill. Additive change; no parameter or output change. |

## 8. Related artefacts

The first related artefact is **Architecture v2.1 §6** — the credential-scoping pattern.

The second is **Migration Plan v1.1 §4.5.3** — the Phase A.5.3 task that wires entity context into the dispatcher worker spawn.

The third is **Review 3 finding DA-005** — the underlying finding behind credential-scoping per agent.

The fourth is **Review 4 finding A-007** — the skill versioning discipline this metadata block is responding to.

The fifth is **TASK_LOG.md OD-031** — the operator decision establishing local filesystem as source of truth for this skill.

## 9. Document control

| Item | Value |
|---|---|
| Skill | supabase-query |
| Source of truth | `~/claude-workspace/generic/skills/supabase-query/SKILL.md` |
| Status | Active |
| Author | CBS Group, drafted with Claude Code |
| Update cadence | Append-only changelog; bump version on any consumer-visible change |
