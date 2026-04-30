"""Tests for `discord_redactor.py` (Phase G.6 / OD-014).

Covers the OD-014 pattern set: emails (with allowlist), AU phone
numbers, AU postcoded addresses, Luhn-checked credit cards, AU
passport numbers, Medicare numbers, BSB-account combinations,
ABN/ACN, plus exact-match named-individuals from
`dispatcher/config/named-individuals.json`.

Run with: python -m pytest scripts/test_discord_redactor.py -v
"""

from __future__ import annotations

import os
import sys
import json
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from discord_redactor import (
    DEFAULT_EMAIL_ALLOWLIST,
    redact_string,
    load_named_individuals,
)


def setup_module(_):
    # Force reload for the suite — other tests may have cached the
    # canonical named-individuals file.
    load_named_individuals(force_reload=True)


def test_email_redacted():
    r = redact_string("Reach me at alice@example.com tomorrow.")
    assert "[REDACTED:email]" in r.text
    assert r.counts["email"] == 1


def test_email_allowlist_pass_through():
    r = redact_string("CC invoices@cbslab.xerocompute.com on this.")
    assert "invoices@cbslab.xerocompute.com" in r.text
    assert r.counts["email"] == 0


def test_au_mobile_phone():
    r = redact_string("Call me on 0412 345 678 today.")
    assert "[REDACTED:phone]" in r.text
    assert r.counts["phone"] == 1


def test_au_landline_phone():
    r = redact_string("Office: (02) 9876 5432 weekdays.")
    assert "[REDACTED:phone]" in r.text
    assert r.counts["phone"] == 1


def test_plus61_phone():
    r = redact_string("International: +61 2 9876 5432.")
    assert "[REDACTED:phone]" in r.text
    assert r.counts["phone"] >= 1


def test_au_address_with_postcode_and_state():
    r = redact_string("Send to 123 George Street Sydney NSW 2000 by Friday.")
    assert "[REDACTED:address]" in r.text
    assert r.counts["address"] == 1


def test_credit_card_luhn_pass():
    # Test card known to pass Luhn: 4532015112830366 (Visa test card).
    r = redact_string("Card 4532 0151 1283 0366 expires soon.")
    assert "[REDACTED:credit-card]" in r.text
    assert r.counts["credit-card"] == 1


def test_credit_card_luhn_fail_not_redacted():
    # 16 digits but not a valid Luhn number — should not redact.
    # 4111-1111-1111-1112 fails Luhn (Visa 4111-1111-1111-1111 passes;
    # changing the last digit breaks it).
    r = redact_string("Reference 4111 1111 1111 1112 in your reply.")
    assert "[REDACTED:credit-card]" not in r.text


def test_passport_redacted():
    r = redact_string("Passport number N1234567 lodged.")
    assert "[REDACTED:passport]" in r.text
    assert r.counts["passport"] == 1


def test_medicare_redacted():
    r = redact_string("Medicare number 1234 56789 0 attached.")
    assert "[REDACTED:medicare]" in r.text
    assert r.counts["medicare"] == 1


def test_bsb_account_redacted():
    r = redact_string("BSB 123-456 account 87654321 confirmed.")
    assert "[REDACTED:bsb-account]" in r.text


def test_abn_redacted():
    r = redact_string("ABN 12 345 678 901 noted.")
    assert "[REDACTED:abn]" in r.text


def test_acn_redacted():
    r = redact_string("ACN 123 456 789 noted.")
    assert "[REDACTED:acn]" in r.text


def test_named_individual_redacted_when_present_in_config(tmp_path):
    # Use a fixture named-individuals file so the test does not depend
    # on the operator's curated list.
    fixture = tmp_path / "named.json"
    fixture.write_text(json.dumps({
        "version": 1,
        "names": [
            {"canonical": "Test Person", "variants": ["Test Person", "TP"]},
        ],
    }))
    # Force reload to pick up the fixture path.
    r = redact_string(
        "Test Person reviewed the document.",
        named_individuals_path=str(fixture),
    )
    assert "[REDACTED:name]" in r.text
    assert r.counts["name"] >= 1
    # Restore default cache.
    load_named_individuals(force_reload=True)


def test_word_boundary_safe_for_substrings(tmp_path):
    fixture = tmp_path / "named.json"
    fixture.write_text(json.dumps({
        "version": 1,
        "names": [{"canonical": "Quinn", "variants": ["Quinn"]}],
    }))
    # "Quinnipiac" should NOT match "Quinn" due to word boundary.
    r = redact_string(
        "She studied at Quinnipiac University.",
        named_individuals_path=str(fixture),
    )
    assert "Quinnipiac" in r.text
    assert r.counts["name"] == 0
    load_named_individuals(force_reload=True)


def test_clean_text_unchanged():
    s = "The bridge was painted blue last Tuesday."
    r = redact_string(s)
    assert r.text == s
    assert all(v == 0 for v in r.counts.values())


def test_multiple_classes_combined():
    inp = (
        "Contact alice@example.com or call 0412 345 678. "
        "ABN 12 345 678 901."
    )
    r = redact_string(inp)
    assert r.counts["email"] == 1
    assert r.counts["phone"] == 1
    assert r.counts["abn"] == 1
    assert r.text.count("[REDACTED:") == 3


def test_overlap_resolution_keeps_earliest():
    # Construct text where two patterns might both fire on overlapping
    # spans. The earliest match wins per the implementation contract.
    # Email patterns shouldn't overlap with phone/address typically;
    # this test is mostly a sanity check that no text is duplicated or
    # corrupted across overlap resolution.
    s = "Email alice@example.com  in town."
    r = redact_string(s)
    assert "alice@example.com" not in r.text
    assert r.text.startswith("Email [REDACTED:email]")
