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
