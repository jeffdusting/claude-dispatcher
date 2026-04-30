"""
Discord-content redactor (Phase G.6 / Δ DA-004 / OD-014).

Python port of `dispatcher/src/traceRedactor.ts`. The pattern set is the
operator-curated J.0 set: emails (with allowlist), AU phone numbers, AU
postcoded addresses, Luhn-checked credit cards, AU passport numbers,
Medicare numbers, BSB-account combinations, ABN/ACN, plus an exact-match
pass over the named-individuals list shipped at
`dispatcher/config/named-individuals.json`.

The Python implementation is byte-for-byte equivalent to the TS source
where regex behaviour permits. Where Python's regex differs (lookbehind
support, Unicode word boundaries), this module documents the divergence
inline. Tests in `tests/test_discord_redactor.py` lock the behaviour.

Used by `scripts/discord-history-bootstrap.py` to redact each Discord
message before embedding and upserting into the per-entity Supabase KB.
"""

from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from typing import Iterable


# Default email allowlist — service mailboxes whose appearance in trace
# output is operationally meaningful and not personal-identifier-like.
DEFAULT_EMAIL_ALLOWLIST: frozenset[str] = frozenset({
    "invoices@waterroads.xerocompute.com",
    "invoices@cbslab.xerocompute.com",
    "noreply@anthropic.com",
})


REDACTION_CLASSES = (
    "email",
    "phone",
    "address",
    "credit-card",
    "passport",
    "medicare",
    "bsb-account",
    "abn",
    "acn",
    "name",
)


@dataclass(frozen=True)
class RedactionMatch:
    start: int
    end: int
    raw: str
    cls: str


@dataclass
class RedactionResult:
    text: str
    counts: dict[str, int]
    matches: list[RedactionMatch]


# ─── Patterns ───────────────────────────────────────────────────────────

EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")

# AU phone number patterns — anchored on +61, leading 04, or area-code
# formats with parentheses. Word-boundaries on each end keep the matcher
# off long invoice numbers.
PHONE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\+61\s?[2-478](?:[\s-]?\d){8}\b"),     # +61 area-code mobile/landline
    re.compile(r"\b04\d{2}[\s-]?\d{3}[\s-]?\d{3}\b"),  # mobile 04xx xxx xxx
    re.compile(r"\(0[2-8]\)\s?\d{4}[\s-]?\d{4}\b"),    # landline (02) xxxx xxxx
)

# Australian street-address tail. Number-prefixed street line followed
# eventually by a four-digit postcode and a state code. Precise enough to
# avoid matching naked numbers; permits suburb names between the street
# suffix and the state code.
AU_ADDRESS_RE = re.compile(
    r"\b\d{1,5}[A-Za-z]?\s+[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*\s+"
    r"(?:Street|St|Road|Rd|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Lane|Ln|"
    r"Way|Place|Pl|Crescent|Cres|Court|Ct|Highway|Hwy|Parade|Pde|Terrace|Tce)"
    r"\b[\s,]+(?:[A-Z][A-Za-z]+(?:\s+[A-Z][A-Za-z]+)*[\s,]+)?"
    r"(?:NSW|VIC|QLD|WA|SA|TAS|ACT|NT)\s+\d{4}\b",
    re.IGNORECASE,
)

CC_CANDIDATE_RE = re.compile(r"\b(?:\d[\s-]?){12,18}\d\b")

PASSPORT_RE = re.compile(
    r"\bpassport\s*(?:number|no\.?|#)?\s*[:#]?\s*([A-Z]?\d{7,9})\b",
    re.IGNORECASE,
)

MEDICARE_RE = re.compile(
    r"\bMedicare\s*(?:number|no\.?|#)?\s*[:#]?\s*(\d{4}\s?\d{5}\s?\d)\b",
    re.IGNORECASE,
)

BSB_ACCT_RE = re.compile(
    r"\b\d{3}[-\s]?\d{3}\b\s*(?:account|acct|a/c)?\s*[:#]?\s*\b\d{4,10}\b",
    re.IGNORECASE,
)

ABN_RE = re.compile(r"\bABN\s*[:#]?\s*((?:\d[\s-]?){10}\d)\b", re.IGNORECASE)
ACN_RE = re.compile(r"\bACN\s*[:#]?\s*((?:\d[\s-]?){8}\d)\b", re.IGNORECASE)


def _luhn_check(digits: str) -> bool:
    s = 0
    alt = False
    for ch in reversed(digits):
        if not ch.isdigit():
            return False
        n = int(ch)
        if alt:
            n *= 2
            if n > 9:
                n -= 9
        s += n
        alt = not alt
    return s % 10 == 0


def _empty_counts() -> dict[str, int]:
    return {c: 0 for c in REDACTION_CLASSES}


def _variant_regex(variant: str) -> re.Pattern[str]:
    escaped = re.escape(variant)
    return re.compile(rf"\b{escaped}\b", re.IGNORECASE)


_cached_named: dict | None = None


def load_named_individuals(path: str | None = None, force_reload: bool = False) -> dict:
    """Load the operator-curated named-individuals list. Caches across calls
    when invoked without an explicit path; bypasses the cache when a path
    is supplied so tests can substitute a fixture without stale state. Falls
    back to an empty list if the file is missing — name redaction is
    disabled but other patterns still fire."""
    global _cached_named
    if path is not None or force_reload:
        # Read directly without touching the cache. An explicit path is the
        # caller's signal that they want a specific list, not the cached
        # default.
        target = path
        if target is None:
            here = os.path.dirname(os.path.abspath(__file__))
            target = os.path.join(here, "..", "config", "named-individuals.json")
        if not os.path.exists(target):
            data = {"version": 0, "names": []}
        else:
            with open(target, "r", encoding="utf-8") as f:
                data = json.load(f)
        if force_reload and path is None:
            _cached_named = data
        return data
    if _cached_named is not None:
        return _cached_named
    here = os.path.dirname(os.path.abspath(__file__))
    default_path = os.path.join(here, "..", "config", "named-individuals.json")
    if not os.path.exists(default_path):
        _cached_named = {"version": 0, "names": []}
        return _cached_named
    with open(default_path, "r", encoding="utf-8") as f:
        _cached_named = json.load(f)
    return _cached_named


def redact_string(
    inp: str,
    *,
    email_allowlist: Iterable[str] = DEFAULT_EMAIL_ALLOWLIST,
    named_individuals_path: str | None = None,
) -> RedactionResult:
    """Redact a single string. Equivalent to the TS module's `redactString`.

    Order: emails, phones, addresses, Luhn-validated credit cards, passports,
    Medicare, BSB-accounts, ABN, ACN, names. Overlaps are resolved by
    keeping the earliest-detected match and dropping anything that overlaps
    it (preferring the more-specific patterns registered first).
    """
    counts = _empty_counts()
    matches: list[RedactionMatch] = []
    allowlist = {e.lower() for e in email_allowlist}
    named = load_named_individuals(named_individuals_path)

    @dataclass
    class _Sub:
        start: int
        end: int
        replacement: str
        cls: str
        raw: str

    subs: list[_Sub] = []

    def _add(pattern: re.Pattern[str], cls: str, allow: callable | None = None):
        for m in pattern.finditer(inp):
            raw = m.group(0)
            if allow and allow(raw):
                continue
            subs.append(_Sub(m.start(), m.end(), f"[REDACTED:{cls}]", cls, raw))

    _add(EMAIL_RE, "email", lambda raw: raw.lower() in allowlist)

    for re_phone in PHONE_PATTERNS:
        _add(re_phone, "phone")

    _add(AU_ADDRESS_RE, "address")

    # Credit card: only emit when Luhn passes.
    for m in CC_CANDIDATE_RE.finditer(inp):
        raw = m.group(0)
        digits = re.sub(r"\D", "", raw)
        if 13 <= len(digits) <= 19 and _luhn_check(digits):
            subs.append(_Sub(m.start(), m.end(), "[REDACTED:credit-card]", "credit-card", raw))

    _add(PASSPORT_RE, "passport")
    _add(MEDICARE_RE, "medicare")
    _add(BSB_ACCT_RE, "bsb-account")
    _add(ABN_RE, "abn")
    _add(ACN_RE, "acn")

    for entry in named.get("names", []):
        for variant in entry.get("variants", []):
            _add(_variant_regex(variant), "name")

    # Sort by start ascending; resolve overlaps by keeping earliest match.
    subs.sort(key=lambda s: s.start)
    filtered: list[_Sub] = []
    cursor = -1
    for s in subs:
        if s.start < cursor:
            continue
        filtered.append(s)
        cursor = s.end

    # Apply substitutions from the end so indexes remain valid.
    text = inp
    for s in reversed(filtered):
        text = text[: s.start] + s.replacement + text[s.end :]
        counts[s.cls] += 1
        matches.append(RedactionMatch(s.start, s.end, s.raw, s.cls))

    matches.reverse()  # restore left-to-right order
    return RedactionResult(text=text, counts=counts, matches=matches)
