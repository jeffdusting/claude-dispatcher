/**
 * Trace block redaction (Phase J.0, Δ DA-004, OD-014).
 *
 * Reads JSONL trace files from `STATE_DIR/traces-original/` and writes
 * a redacted copy to `STATE_DIR/traces/<eaOwner>/`. Original blocks are
 * never mutated in place; the precondition for the Discord history
 * bootstrap (G.6) and the multi-EA per-EA partitioning (J.1a) is that
 * the originals stay untouched on the 0700 directory and only the
 * redacted output flows into knowledge bases.
 *
 * Pattern set (per OD-014 plus the sixteenth-session bootstrap brief):
 *   - Email addresses (with an opt-in allow-list for service mailboxes
 *     that legitimately appear in agent output, e.g. Xero invoice
 *     forwarding addresses).
 *   - Phone numbers — Australian formats (04xx-xxx-xxx, (02) xxxx xxxx,
 *     +61 4 xxxx xxxx) and bare international (+NNNN-NNNN).
 *   - Australian addresses — postcoded street/suburb tails.
 *   - Credit card numbers — sequences of 13–19 digits passing the Luhn
 *     check, separators tolerated.
 *   - Passport numbers — Australian eight/nine-digit pattern bracketed
 *     by the word "passport".
 *   - Medicare numbers — ten-digit pattern bracketed by the word
 *     "Medicare".
 *   - BSB-account combinations — six-digit BSB with hyphen and four-to-
 *     ten-digit account on the same line.
 *   - ABN/ACN — eleven-digit ABN with the word "ABN" and nine-digit ACN
 *     with the word "ACN".
 *   - Named individuals — exact-match (word-boundary) pass over the
 *     variants list shipped in `config/named-individuals.json`.
 *
 * Each pattern has a redaction token of the form `[REDACTED:<class>]`
 * so downstream readers and audit dashboards can surface counts.
 *
 * The classifier is deliberately precision-biased on phone/address/ABN
 * patterns (which can collide with task identifiers and order numbers)
 * and recall-biased on names (false-redact one extra "Quinn" rather
 * than miss one).
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

export type RedactionClass =
  | 'email'
  | 'phone'
  | 'address'
  | 'credit-card'
  | 'passport'
  | 'medicare'
  | 'bsb-account'
  | 'abn'
  | 'acn'
  | 'name'

export interface RedactionMatch {
  /** Index into the input string where the match started. */
  start: number
  /** Index into the input string just past the end of the match. */
  end: number
  /** The matched substring (for audit; not embedded in the redacted output). */
  raw: string
  /** Which redaction class fired. */
  class: RedactionClass
}

export interface RedactionResult {
  /** Redacted output text. */
  text: string
  /** Counts per class in the input — useful for the dry-run summary. */
  counts: Record<RedactionClass, number>
  /** Match list for audit / dry-run inspection. */
  matches: RedactionMatch[]
}

/**
 * Default service mailboxes that should not be redacted because their
 * appearance in trace output is operationally meaningful (and they are
 * not personal identifiers). Override at call time when needed.
 */
const DEFAULT_EMAIL_ALLOW_LIST: ReadonlySet<string> = new Set([
  'invoices@waterroads.xerocompute.com',
  'invoices@cbslab.xerocompute.com',
  'noreply@anthropic.com',
])

interface NamedIndividualEntry {
  canonical: string
  variants: string[]
}

interface NamedIndividualsFile {
  version: number
  lastUpdated: string
  rationale: string
  names: NamedIndividualEntry[]
}

let cachedNamedIndividuals: NamedIndividualsFile | null = null

function defaultNamedIndividualsPath(): string {
  // Resolve relative to the source file location so the redactor works
  // both in `bun run` (running from src/) and in the bundled output.
  const here = dirname(fileURLToPath(import.meta.url))
  return join(here, '..', 'config', 'named-individuals.json')
}

/**
 * Load the operator-curated named-individuals list. Caches on first
 * call; pass `forceReload: true` to pick up edits in a long-running
 * process (the tests use this).
 */
export function loadNamedIndividuals(opts?: {
  path?: string
  forceReload?: boolean
}): NamedIndividualsFile {
  if (cachedNamedIndividuals && !opts?.forceReload) return cachedNamedIndividuals
  const path = opts?.path ?? defaultNamedIndividualsPath()
  if (!existsSync(path)) {
    // Empty list is a degraded but not broken state — the rest of the
    // pattern set still redacts. We log via stderr so a missing file in
    // production is visible without crashing the pipeline.
    process.stderr.write(`traceRedactor: named-individuals file missing at ${path}; name redaction disabled.\n`)
    const empty: NamedIndividualsFile = {
      version: 0,
      lastUpdated: 'unknown',
      rationale: 'fallback: file missing',
      names: [],
    }
    cachedNamedIndividuals = empty
    return empty
  }
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw) as NamedIndividualsFile
  cachedNamedIndividuals = parsed
  return parsed
}

/**
 * Build the regex for a named-individual variant. Word-boundary anchored
 * on both sides so "Quinn" matches "Quinn" but not "Quinnipiac"; case
 * insensitive so "JEFF" / "jeff" / "Jeff" all redact.
 */
function variantRegex(variant: string): RegExp {
  // Escape regex metacharacters in the variant so a name with a dot
  // (e.g. "Mr. Dusting") would not act as a wildcard. Simple table
  // since names rarely contain regex specials.
  const escaped = variant.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\b${escaped}\\b`, 'gi')
}

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g

/**
 * AU phone number patterns — anchored on +61, leading 04, or area-code
 * formats with parentheses. Word-boundaries on each end keep the
 * matcher off long invoice numbers.
 */
const PHONE_PATTERNS: ReadonlyArray<RegExp> = [
  /\+61\s?[2-478](?:[\s-]?\d){8}\b/g, // +61 area-code mobile/landline
  /\b04\d{2}[\s-]?\d{3}[\s-]?\d{3}\b/g, // mobile 04xx xxx xxx
  /\(0[2-8]\)\s?\d{4}[\s-]?\d{4}\b/g, // landline (02) xxxx xxxx
]

/**
 * Australian street-address tail. Looks for a number-prefixed street
 * line followed eventually by a four-digit postcode and a state code,
 * which is precise enough to avoid matching naked numbers. The middle
 * span between the street suffix and the state code allows for a
 * suburb name (one or more capitalised words), with optional commas
 * and whitespace.
 */
const AU_ADDRESS_RE = /\b\d{1,5}[A-Za-z]?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|Way|Place|Pl|Crescent|Cres|Court|Ct|Highway|Hwy|Parade|Pde|Terrace|Tce)\b[\s,]+(?:[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*[\s,]+)?(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b/gi

const CC_CANDIDATE_RE = /\b(?:\d[\s-]?){12,18}\d\b/g

const PASSPORT_RE = /\bpassport\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z]?\d{7,9})\b/gi

const MEDICARE_RE = /\bMedicare\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{4}\s?\d{5}\s?\d)\b/gi

const BSB_ACCT_RE = /\b\d{3}[-\s]?\d{3}\b\s*(?:account|acct|a\/c)?\s*[:#]?\s*\b\d{4,10}\b/gi

const ABN_RE = /\bABN\s*[:#]?\s*((?:\d[\s-]?){10}\d)\b/gi
const ACN_RE = /\bACN\s*[:#]?\s*((?:\d[\s-]?){8}\d)\b/gi

function emptyCounts(): Record<RedactionClass, number> {
  return {
    email: 0,
    phone: 0,
    address: 0,
    'credit-card': 0,
    passport: 0,
    medicare: 0,
    'bsb-account': 0,
    abn: 0,
    acn: 0,
    name: 0,
  }
}

function luhnCheck(digits: string): boolean {
  // Luhn modulo-10 check; expects only digits.
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48
    if (n < 0 || n > 9) return false
    if (alt) {
      n *= 2
      if (n > 9) n -= 9
    }
    sum += n
    alt = !alt
  }
  return sum % 10 === 0
}

export interface RedactOptions {
  /** Set of email addresses that should not be redacted. */
  emailAllowList?: ReadonlySet<string>
  /** Override the default named-individuals file. */
  namedIndividualsPath?: string
  /** Force the named-individuals file to be reloaded. */
  forceReloadNamedIndividuals?: boolean
}

/**
 * Redact a string. Used inline by `redactTraceBlock` to traverse JSON
 * trace blocks and rewrite every string field. Exported for unit tests
 * and for ad-hoc redaction CLIs.
 */
export function redactString(input: string, opts?: RedactOptions): RedactionResult {
  const counts = emptyCounts()
  const matches: RedactionMatch[] = []
  const allowList = opts?.emailAllowList ?? DEFAULT_EMAIL_ALLOW_LIST
  const named = loadNamedIndividuals({
    path: opts?.namedIndividualsPath,
    forceReload: opts?.forceReloadNamedIndividuals,
  })

  // We collect substitutions as (start, end, replacement) triples and
  // apply them after all patterns have run, sorted by start position
  // descending. This keeps offsets stable while we replace.
  type Sub = { start: number; end: number; replacement: string; cls: RedactionClass; raw: string }
  const subs: Sub[] = []

  function add(re: RegExp, cls: RedactionClass, allow?: (raw: string) => boolean): void {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(input)) !== null) {
      const raw = m[0]
      if (allow && allow(raw)) continue
      subs.push({
        start: m.index,
        end: m.index + raw.length,
        replacement: `[REDACTED:${cls}]`,
        cls,
        raw,
      })
    }
  }

  add(EMAIL_RE, 'email', (raw) => allowList.has(raw.toLowerCase()))

  for (const re of PHONE_PATTERNS) {
    add(re, 'phone')
  }

  add(AU_ADDRESS_RE, 'address')

  // Credit card: only emit when Luhn passes.
  CC_CANDIDATE_RE.lastIndex = 0
  let cc: RegExpExecArray | null
  while ((cc = CC_CANDIDATE_RE.exec(input)) !== null) {
    const raw = cc[0]
    const digits = raw.replace(/\D/g, '')
    if (digits.length >= 13 && digits.length <= 19 && luhnCheck(digits)) {
      subs.push({
        start: cc.index,
        end: cc.index + raw.length,
        replacement: '[REDACTED:credit-card]',
        cls: 'credit-card',
        raw,
      })
    }
  }

  add(PASSPORT_RE, 'passport')
  add(MEDICARE_RE, 'medicare')
  add(BSB_ACCT_RE, 'bsb-account')
  add(ABN_RE, 'abn')
  add(ACN_RE, 'acn')

  for (const entry of named.names) {
    for (const variant of entry.variants) {
      const re = variantRegex(variant)
      add(re, 'name')
    }
  }

  // Apply subs from the end of the string back so indexes remain valid
  // throughout. Resolve overlaps by keeping the earliest-detected match
  // and dropping anything that overlaps it; this prefers the more-
  // specific patterns we registered first (email before address, etc.).
  subs.sort((a, b) => a.start - b.start)
  const filtered: Sub[] = []
  let cursor = -1
  for (const s of subs) {
    if (s.start < cursor) continue // overlap, skip
    filtered.push(s)
    cursor = s.end
  }

  let text = input
  for (let i = filtered.length - 1; i >= 0; i--) {
    const s = filtered[i]
    text = text.slice(0, s.start) + s.replacement + text.slice(s.end)
    counts[s.cls] += 1
    matches.push({ start: s.start, end: s.end, raw: s.raw, class: s.cls })
  }

  matches.reverse() // restore left-to-right order
  return { text, counts, matches }
}

/**
 * Redact every string-valued leaf inside a parsed JSON object. Numbers,
 * booleans, and nulls pass through unchanged. Returns the redacted
 * shape plus aggregated counts and match locations from across all
 * leaves; locations carry a `path` (JSON pointer-ish) so dry-run output
 * is auditable.
 */
export interface BlockRedactionResult {
  block: unknown
  counts: Record<RedactionClass, number>
  matches: Array<RedactionMatch & { path: string }>
}

export function redactTraceBlock(block: unknown, opts?: RedactOptions): BlockRedactionResult {
  const counts = emptyCounts()
  const matches: Array<RedactionMatch & { path: string }> = []

  function walk(node: unknown, path: string): unknown {
    if (typeof node === 'string') {
      const r = redactString(node, opts)
      for (const k of Object.keys(counts) as RedactionClass[]) counts[k] += r.counts[k]
      for (const m of r.matches) matches.push({ ...m, path })
      return r.text
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => walk(item, `${path}[${i}]`))
    }
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        out[k] = walk(v, path === '' ? k : `${path}.${k}`)
      }
      return out
    }
    return node
  }

  const redacted = walk(block, '')
  return { block: redacted, counts, matches }
}
