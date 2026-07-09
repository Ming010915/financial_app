"""
Response-time measurements for the parts of Flo a user actually waits on:
the local ML classifier (every merchant-name blur/keystroke debounce), the
full /api/classify HTTP round-trip, and the live FX proxy. These are free
and deterministic — no Gemini calls — so they run on every commit alongside
tests/test_api_deterministic.py.

Live-API latency (receipt OCR, voice extraction, AI spending insight) is
measured for free as a side effect of their existing accuracy tests instead
of with dedicated calls here — see the "latency" key each of those tests
already saves to tests/results/*.json.
"""

from __future__ import annotations

import json
import time

import pytest

import app as app_module
from services import classifier
from tests.helpers import latency_stats, save_result

SAMPLE_MERCHANTS = [
    "REWE", "Netflix", "Starbucks", "IKEA", "Lidl", "Amazon", "Zalando",
    "Deutsche Bahn", "Booking.com", "Sephora", "McDonald's", "Aral",
    "A Totally New Merchant Name 42", "Some Other Fresh Business",
    "Unfamiliar Shop XYZ", "Random Store 99", "Novel Company ABC",
    "Fresh Startup Inc", "Untested Vendor Co", "New Kid On The Block",
]


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(app_module, "REQUIRE_PASSWORD", False)
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as c:
        yield c


def test_classifier_do_classify_latency():
    """Local nearest-centroid classification, the same call path as
    /api/classify — dominated by the SentenceTransformer encode() call for a
    single short string."""
    classifier.get_model()  # warm the model outside the timed loop

    latencies = []
    for name in SAMPLE_MERCHANTS:
        t0 = time.perf_counter()
        classifier.do_classify(name, local_cents=classifier.centroids, local_ovrs={})
        latencies.append(time.perf_counter() - t0)

    result = latency_stats(latencies)
    save_result("classifier_latency", result)
    print(f"\nClassifier do_classify latency: {json.dumps(result, indent=2)}")

    # Generous target — this runs synchronously on every merchant-field blur
    # in the Add form, so it needs to feel instant, not laggy.
    assert result["p95_s"] < 1.0


def test_api_classify_endpoint_latency(client):
    """Full HTTP round-trip through Flask for /api/classify — encode +
    cosine similarity + JSON (de)serialization, no Gemini involved."""
    latencies = []
    for name in SAMPLE_MERCHANTS:
        t0 = time.perf_counter()
        resp = client.post("/api/classify", json={"name": name})
        latencies.append(time.perf_counter() - t0)
        assert resp.status_code == 200

    result = latency_stats(latencies)
    save_result("api_classify_latency", result)
    print(f"\n/api/classify endpoint latency: {json.dumps(result, indent=2)}")

    assert result["p95_s"] < 1.5


def test_api_exchange_rates_latency(client):
    """Live network round-trip to the Frankfurter FX API. n=20 real external
    calls, not simulated."""
    latencies = []
    for _ in range(20):
        t0 = time.perf_counter()
        resp = client.get("/api/exchange_rates?base=EUR")
        latencies.append(time.perf_counter() - t0)
        assert resp.status_code == 200

    result = latency_stats(latencies)
    save_result("api_exchange_rates_latency", result)
    print(f"\n/api/exchange_rates latency: {json.dumps(result, indent=2)}")

    assert result["p95_s"] < 5.0
