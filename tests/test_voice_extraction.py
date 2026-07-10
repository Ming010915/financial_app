"""
Field-extraction accuracy for services/voice.process_voice_text() — the
Gemini function-calling step that turns a (user-confirmed) transcript into
structured expense/income fields. Tested on transcript text directly, which
exercises the same extraction prompt/schema as the audio path
(process_voice_input) without needing synthesized speech or Google Cloud STT.

Fixtures probe: itemization, income vs. expense detection, relative dates
("yesterday"), spoken self-correction handling, event-budget matching, and
non-EUR currency mentions. Requires live Vertex AI credentials.
"""

from __future__ import annotations

import json
import time
from datetime import date, timedelta
from pathlib import Path

import pytest

from services import voice as voice_service
from tests.conftest import skip_without_live_api
from tests.helpers import latency_stats, save_result

FIXTURES = json.loads((Path(__file__).resolve().parent / "data" / "voice_fixtures.json").read_text())
NON_TRANSACTION_FIXTURES = json.loads(
    (Path(__file__).resolve().parent / "data" / "voice_non_transaction_fixtures.json").read_text()
)


def _amount_close(a, b, tol=0.05):
    if a is None or b is None:
        return a == b
    return abs(float(a) - float(b)) <= tol


@pytest.mark.live_api
@skip_without_live_api()
def test_voice_extraction_field_accuracy(live_api_available):
    checks = ["transaction_type", "merchant", "total", "currency", "date", "event_hint", "self_correction"]
    scores = {c: [] for c in checks}
    per_case = []
    latencies = []

    for case in FIXTURES:
        exp = case["expected"]
        t0 = time.perf_counter()
        extracted = voice_service.process_voice_text(case["transcript"], case.get("event_budgets"))
        elapsed = time.perf_counter() - t0
        latencies.append(elapsed)

        row = {"id": case["id"], "transcript": case["transcript"], "latency_s": round(elapsed, 3), "extracted": {
            k: extracted.get(k) for k in ("transaction_type", "merchant", "total", "currency", "date", "event_hint")
        }}

        type_ok = extracted.get("transaction_type") == exp["transaction_type"]
        scores["transaction_type"].append(type_ok)
        row["transaction_type_ok"] = type_ok

        if "merchant_contains" in exp:
            merchant_ok = exp["merchant_contains"] in (extracted.get("merchant") or "").lower()
            scores["merchant"].append(merchant_ok)
            row["merchant_ok"] = merchant_ok

        total_ok = _amount_close(extracted.get("total"), exp.get("total"))
        scores["total"].append(total_ok)
        row["total_ok"] = total_ok

        currency_ok = extracted.get("currency") == exp.get("currency")
        scores["currency"].append(currency_ok)
        row["currency_ok"] = currency_ok

        expected_date = (date.today() + timedelta(days=exp["date_offset_days"])).isoformat()
        date_ok = extracted.get("date") == expected_date
        scores["date"].append(date_ok)
        row["date_ok"] = date_ok
        row["expected_date"] = expected_date

        if "min_items" in exp:
            row["items_count"] = len(extracted.get("items", []))

        if "event_hint" in exp:
            hint_ok = extracted.get("event_hint") == exp["event_hint"]
            scores["event_hint"].append(hint_ok)
            row["event_hint_ok"] = hint_ok

        if "should_not_contain_in_notes_or_items" in exp:
            haystack = json.dumps(extracted).lower()
            leaked = exp["should_not_contain_in_notes_or_items"].lower() in haystack
            scores["self_correction"].append(not leaked)
            row["self_correction_ok"] = not leaked

        per_case.append(row)

    def rate(key):
        vals = scores[key]
        return round(sum(vals) / len(vals), 4) if vals else None

    result = {
        "n_cases": len(FIXTURES),
        "field_accuracy": {k: rate(k) for k in checks},
        "latency": latency_stats(latencies),
        "per_case": per_case,
    }
    save_result("voice_extraction_accuracy", result)
    print("\nVoice extraction field accuracy:", json.dumps(result["field_accuracy"], indent=2))
    print("Voice extraction latency:", json.dumps(result["latency"], indent=2))

    assert result["field_accuracy"]["transaction_type"] >= 0.9
    assert result["field_accuracy"]["total"] >= 0.8


# ── Non-transaction rejection ────────────────────────────────────────────────

class _FakeFunctionCall:
    def __init__(self, args):
        self.args = args


class _FakePart:
    def __init__(self, args=None):
        self.function_call = _FakeFunctionCall(args) if args is not None else None


class _FakeResponse:
    """Mimics the shape voice._extracted_from() reads off a Gemini response."""
    def __init__(self, parts):
        content = type("Content", (), {"parts": parts})()
        self.candidates = [type("Candidate", (), {"content": content})()]


def test_extracted_from_rejects_is_transaction_false():
    """A function call that reports no transaction must not become an expense."""
    response = _FakeResponse([_FakePart({"is_transaction": False, "merchant": ""})])
    with pytest.raises(voice_service.NoExpenseFoundError):
        voice_service._extracted_from(response, "transcript")


def test_extracted_from_rejects_missing_function_call():
    response = _FakeResponse([_FakePart()])
    with pytest.raises(voice_service.NoExpenseFoundError):
        voice_service._extracted_from(response, "audio")


def test_extracted_from_strips_gate_field_on_accept():
    """is_transaction is a routing flag, not an expense field — it must not leak downstream."""
    response = _FakeResponse([_FakePart({"is_transaction": True, "merchant": "Lidl", "total": 12.5})])
    extracted = voice_service._extracted_from(response, "transcript")
    assert extracted == {"merchant": "Lidl", "total": 12.5}


def test_extracted_from_accepts_when_gate_field_absent():
    """A model that omits is_transaction but supplies real fields still extracts."""
    response = _FakeResponse([_FakePart({"merchant": "REWE", "total": 3.5})])
    assert voice_service._extracted_from(response, "transcript")["merchant"] == "REWE"


@pytest.mark.live_api
@skip_without_live_api()
def test_voice_rejects_non_transaction_speech(live_api_available):
    """Speech that describes no purchase — mic tests, questions, chatter — must not
    be logged as an expense. Regression: 'testing 1 2 3' extracted as a valid entry."""
    rejected = []
    for case in NON_TRANSACTION_FIXTURES:
        try:
            extracted = voice_service.process_voice_text(case["transcript"])
        except voice_service.NoExpenseFoundError:
            rejected.append({"id": case["id"], "rejected": True})
        else:
            rejected.append({"id": case["id"], "rejected": False, "extracted": {
                k: extracted.get(k) for k in ("merchant", "total", "currency")
            }})

    rate = sum(r["rejected"] for r in rejected) / len(rejected)
    result = {"n_cases": len(NON_TRANSACTION_FIXTURES), "rejection_rate": round(rate, 4), "per_case": rejected}
    save_result("voice_non_transaction_rejection", result)
    print("\nNon-transaction rejection:", json.dumps(result, indent=2))

    leaked = [r["id"] for r in rejected if not r["rejected"]]
    assert not leaked, f"non-transaction speech extracted as an expense: {leaked}"
