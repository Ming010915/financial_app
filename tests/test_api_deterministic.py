"""
Deterministic API-level tests — no Gemini calls, so these always run and are
the fast/cheap tests to run on every change. Covers the login gate, the
classify/learn contract the frontend depends on, and the live Frankfurter FX
proxy (network but free and stable).
"""

from __future__ import annotations

import pytest

import app as app_module


@pytest.fixture()
def client(monkeypatch):
    monkeypatch.setattr(app_module, "REQUIRE_PASSWORD", False)
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as c:
        yield c


@pytest.fixture()
def locked_client(monkeypatch):
    monkeypatch.setattr(app_module, "REQUIRE_PASSWORD", True)
    monkeypatch.setattr(app_module, "APP_PASSWORD", "test-password-123")
    app_module.app.config.update(TESTING=True)
    with app_module.app.test_client() as c:
        yield c


# ── Access control ────────────────────────────────────────────────────────────

def test_api_rejects_unauthenticated_when_password_required(locked_client):
    resp = locked_client.get("/api/categories")
    assert resp.status_code == 401


def test_login_then_api_succeeds(locked_client):
    login_resp = locked_client.post("/login", data={"password": "test-password-123"})
    assert login_resp.status_code == 302
    resp = locked_client.get("/api/categories")
    assert resp.status_code == 200


def test_wrong_password_rejected(locked_client):
    resp = locked_client.post("/login", data={"password": "wrong"})
    assert resp.status_code == 401


# ── Classify / learn contract ─────────────────────────────────────────────────

def test_classify_requires_name(client):
    resp = client.post("/api/classify", json={})
    assert resp.status_code == 400


def test_classify_with_client_supplied_centroids_is_stateless(client):
    """The server must be stateless w.r.t. per-user learning (README architecture
    section) — classifying with client-supplied centroids must not leak into
    global module state that a second, unrelated request could observe."""
    from services import classifier

    dim = classifier.get_model().get_embedding_dimension()
    body = {
        "name": "My Custom Merchant",
        "model": classifier.MODEL_NAME,
        "embedding_version": classifier.EMBEDDING_VERSION,
        "categories": {
            "Custom Category": {"centroid": [1.0] + [0.0] * (dim - 1), "n": 1},
        },
        "overrides": {},
    }
    resp = client.post("/api/classify", json=body)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["categories"] == ["Custom Category", "Others"]
    # The server's own global centroids must be untouched by this request.
    assert "Custom Category" not in classifier.centroids


def test_learn_creates_override_on_correction(client):
    from services import classifier

    body = {
        "merchant": "Totally Ambiguous Store 12345",
        "category": "Shopping",
        "model": classifier.MODEL_NAME,
        "embedding_version": classifier.EMBEDDING_VERSION,
        "categories": {},
        "overrides": {},
    }
    resp = client.post("/api/learn", json=body)
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["success"] is True
    assert data["centroids"]["overrides"].get("totally ambiguous store 12345") == "Shopping"


def test_learn_requires_merchant_and_category(client):
    resp = client.post("/api/learn", json={"merchant": "X"})
    assert resp.status_code == 400


# ── FX proxy ──────────────────────────────────────────────────────────────────

def test_exchange_rates_proxy_returns_rates(client):
    resp = client.get("/api/exchange_rates?base=EUR")
    assert resp.status_code == 200
    data = resp.get_json()
    assert data["base"] == "EUR"
    assert "USD" in data["rates"]
    assert isinstance(data["rates"]["USD"], (int, float))


# ── Settings ──────────────────────────────────────────────────────────────────

def test_settings_reports_vertex_ai_configuration(client):
    resp = client.get("/api/settings")
    assert resp.status_code == 200
    data = resp.get_json()
    assert set(data.keys()) == {"vertex_ai_configured", "env_key_set", "places_key_set"}
