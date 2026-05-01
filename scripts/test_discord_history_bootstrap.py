"""Tests for the operator-gate behaviour of discord-history-bootstrap.py.

The script's filename has hyphens, so it cannot be imported as a normal
Python module. Tests use importlib.util to load it under a synthetic
module name. We test the `prompt_for_wet_run` helper directly against
representative input strings and the seam parameters.
"""

from __future__ import annotations

import importlib.util
import io
import os
import sys

import pytest


def _load_bootstrap_module():
    """Load the hyphenated script file under a synthetic module name so
    importlib's machinery doesn't choke on the filename."""
    here = os.path.dirname(os.path.abspath(__file__))
    src = os.path.join(here, "discord-history-bootstrap.py")
    spec = importlib.util.spec_from_file_location("discord_history_bootstrap", src)
    module = importlib.util.module_from_spec(spec)
    sys.modules["discord_history_bootstrap"] = module
    spec.loader.exec_module(module)
    return module


bootstrap = _load_bootstrap_module()


def _run_prompt(reply: str | type) -> tuple[bool, str]:
    """Drive prompt_for_wet_run with a canned reply. Returns (decision, output)."""
    out = io.StringIO()

    if isinstance(reply, type) and issubclass(reply, BaseException):
        def fake_input(_prompt: str = "") -> str:
            raise reply()
    else:
        def fake_input(_prompt: str = "") -> str:
            return reply

    decision = bootstrap.prompt_for_wet_run(input_fn=fake_input, output_stream=out)
    return decision, out.getvalue()


def test_yes_lowercase_proceeds():
    decision, out = _run_prompt("y")
    assert decision is True
    assert "Proceed with wet ingestion" in out


def test_yes_uppercase_proceeds():
    decision, _ = _run_prompt("Y")
    assert decision is True


def test_yes_full_word_proceeds():
    decision, _ = _run_prompt("yes")
    assert decision is True


def test_yes_with_whitespace_padding_proceeds():
    decision, _ = _run_prompt("  yes  ")
    assert decision is True


def test_no_declines():
    decision, _ = _run_prompt("n")
    assert decision is False


def test_no_full_word_declines():
    decision, _ = _run_prompt("no")
    assert decision is False


def test_bare_enter_declines():
    """Default-on-Enter is the safe-decline behaviour. Operator must
    actively confirm; the empty default does NOT proceed."""
    decision, _ = _run_prompt("")
    assert decision is False


def test_ambiguous_response_declines():
    decision, _ = _run_prompt("maybe")
    assert decision is False
    decision, _ = _run_prompt("hmm")
    assert decision is False


def test_eof_declines():
    """EOF on stdin (e.g. piped /dev/null) returns False rather than
    raising. Important for non-interactive contexts where the operator
    may not realise the prompt is waiting for input."""
    decision, _ = _run_prompt(EOFError)
    assert decision is False


def test_keyboardinterrupt_propagates():
    """Ctrl-C should propagate so the operator's interrupt is honoured;
    do not swallow it as a 'no'."""
    with pytest.raises(KeyboardInterrupt):
        _run_prompt(KeyboardInterrupt)


def test_prompt_text_includes_options_and_default():
    _, out = _run_prompt("y")
    assert "Proceed with wet ingestion" in out
    assert "embed via Voyage" in out
    assert "upsert to Supabase" in out
    assert "[y/N]" in out
