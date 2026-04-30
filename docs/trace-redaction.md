# Trace redaction pipeline

**Status**: Phase J.0 — trace redaction precondition (Δ DA-004, OD-014). Operational.
**Source**: `src/traceRedactor.ts`, `scripts/redact-traces.ts`, `config/named-individuals.json`.

---

## 1. Purpose

Trace blocks captured by `src/trace.ts` go to `STATE_DIR/traces-original/` with 0700 directory permissions. Those originals are never ingested into knowledge bases or surfaced beyond the dispatcher process. The redaction pipeline reads from there, applies the PII pattern set in §3 below, partitions by EA owner per §4, and writes a redacted copy to `STATE_DIR/traces/<eaOwner>/`. Only the redacted copies are read by downstream ingestion (Phase G.6 Discord history bootstrap; Phase J.1a multi-EA per-EA partitioning).

The original directory's 0700 permission is the operational guard — only the dispatcher process owner can read the unredacted files. The redacted directory inherits the standard process umask because the redacted content is, by construction, safe for KB ingestion.

---

## 2. Running the redactor

The redactor is a Bun script — it has no network dependencies and runs against local state.

```bash
# Dry-run a single day, default partition (jeff = Alex's partition)
bun run scripts/redact-traces.ts --dry-run --since 2026-04-29 --until 2026-04-29

# Dry-run all available original traces
bun run scripts/redact-traces.ts --dry-run

# Wet-run (writes the redacted output) under Quinn's partition fallback
bun run scripts/redact-traces.ts --ea quinn

# Wet-run with a specific date range
bun run scripts/redact-traces.ts --since 2026-04-01 --until 2026-04-15
```

The CLI prints a JSON summary on stdout — `mode`, `filesScanned`, `totalLines`, `linesWithRedactions`, `totalsByClass`, and the list of partition paths that were written (or would be written, in dry-run). The `totalsByClass` line is the audit-friendly count of how many matches landed in each redaction class.

The CLI has no destructive behaviour outside `STATE_DIR/traces/<eaOwner>/`. Originals are never modified or removed.

---

## 3. Pattern set

The redactor walks every string-valued leaf in each trace block (numbers, booleans, and nulls pass through unchanged) and applies the patterns below. The replacement token is `[REDACTED:<class>]`, so dashboards and audits can pivot on the class.

### 3.1 Email addresses

Standard RFC-shaped addresses are redacted unless the address appears in the email allow-list. The default allow-list contains the operational mailboxes that legitimately appear in agent output: `invoices@waterroads.xerocompute.com`, `invoices@cbslab.xerocompute.com`, and `noreply@anthropic.com`.

### 3.2 Phone numbers

Australian patterns are redacted: mobile (`04xx xxx xxx`), area-code landline (`(02) xxxx xxxx` and the comparable formats for 03/07/08), and `+61` international form. Word-boundary anchoring keeps the matcher off long invoice numbers.

### 3.3 Australian addresses

A street-address tail with state code and postcode is redacted: `<number> <street-words> <suffix>[, <suburb>] <STATE> <postcode>`. Bare suburb names without postcodes are not matched.

### 3.4 Credit card numbers

Sequences of 13–19 digits (separators tolerated) are redacted only when the digits pass a Luhn check. This avoids false positives on long order numbers; a Luhn-passing accidental string is rare enough to accept the small false-positive risk.

### 3.5 Passport numbers

The Australian passport pattern (one-letter prefix optional, eight or nine digits) is redacted only when the word "passport" is in the same line. A bare nine-digit number is not redacted as a passport — the contextual word is required to bias toward precision.

### 3.6 Medicare numbers

Ten-digit Medicare numbers (`xxxx xxxxx x` with optional spacing) are redacted only when the word "Medicare" is in the same line.

### 3.7 BSB-account combinations

Six-digit BSB (with the standard hyphen) followed on the same line by a four-to-ten digit account number is redacted as a single match.

### 3.8 ABN / ACN

Eleven-digit ABN with the word "ABN" and nine-digit ACN with the word "ACN" are each redacted. Bare digit strings without the prefix are not matched.

### 3.9 Named individuals

Names in `config/named-individuals.json` are redacted with case-insensitive word-boundary matching. Each entry has a `canonical` form (audit only) and a `variants` array; every variant is matched. The list is operator-curated. Update procedure is in §6.

---

## 4. Per-EA partitioning

Output is partitioned by EA. The redactor reads the `eaOwner` field from the project descriptor referenced by the trace block's `projectId`. When the field is absent (legacy descriptors written before the field was added) or when the trace block has no `projectId`, the redactor falls back to the `--ea` flag (default `jeff`, which is Alex's partition under the Phase J.1a scaffolding).

Once Phase J.1b registers Quinn as Sarah's EA and the project-descriptor schema gains `eaOwner` for new descriptors, traces will fan out across `traces/jeff/` and `traces/quinn/` deterministically by descriptor lookup.

---

## 5. Audit and verification

Re-run the redactor with `--dry-run` against any historical date range to count redactions per class. The output is deterministic on the same input, so a reviewer can verify pattern coverage by inspecting the dry-run summary alongside the source files.

For incident response, the unredacted originals remain readable on the 0700 `traces-original/` directory by the dispatcher process owner. Operators on the host can read them with `sudo` or by switching to the dispatcher user.

A quarterly redaction-effectiveness audit (per Migration Plan §14.1.4) is the operator's responsibility — sample N redacted lines, compare against the originals, and confirm no PII slipped through. New patterns or new variants are added per §6.

---

## 6. Adding patterns or names post-deploy

### 6.1 Adding a named individual

To add a name (or a new variant), edit `config/named-individuals.json`, append a new `names` entry or extend the `variants` array of an existing canonical, bump `lastUpdated`, and ship the change as a PR. The redactor reads the file at process start; a redeploy is required for the change to take effect.

### 6.2 Adding a regex pattern

To add a new pattern class:

1. Add the regex constant at the top of `src/traceRedactor.ts` (next to `EMAIL_RE`, `PHONE_PATTERNS`, etc.).
2. Add the new class to `RedactionClass` and `emptyCounts()`.
3. Wire it into `redactString` with a single `add(re, '<class>')` call. If the pattern requires post-match validation (like Luhn for credit cards), follow the credit-card branch in the same function.
4. Add tests under `tests/traceRedactor.test.ts` covering at least one positive case, one false-positive resistance case, and one shape-walk case via `redactTraceBlock`.
5. Ship as a PR. Phase J.0 deliverable rule applies — the PR surfaces for operator review before merge regardless of auto-mode classification.

### 6.3 Adding to the email allow-list

Edit the `DEFAULT_EMAIL_ALLOW_LIST` constant in `src/traceRedactor.ts`. The set is keyed lowercase; add the lowercased mailbox.

---

## 7. Document control

| Field | Value |
|---|---|
| Document | dispatcher/docs/trace-redaction.md |
| Phase | J.0 — Trace redaction precondition (Δ DA-004, OD-014) |
| Authored | 2026-04-29 |
| Author | CC (river-migration session 16) |
| Cross-references | Migration Plan v1.1 §14.1; OD-014 (PII pattern set); Architecture v2.1 §5; OD-030 (Phase G.6 — depends on this pipeline). |
