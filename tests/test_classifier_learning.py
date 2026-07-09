"""
Behavioural tests for the online-learning loop described in the README
(section "5. Online ML Learning"): a user correction should (a) immediately
fix that exact merchant via the override table, and (b) nudge the category
centroid so *similar* future merchants also benefit — without needing a
server restart or model retrain.
"""

from __future__ import annotations

import numpy as np
import pytest

from services import classifier
from tests.helpers import save_result


@pytest.fixture(scope="module")
def model():
    return classifier.get_model()


def test_override_fixes_exact_merchant_immediately(model):
    """If the model mis-predicts 'Trivago' and the user corrects it to
    'Transport', the very next classification of the exact same name must
    return the corrected category with full confidence — this is the
    override path, independent of the centroid."""
    cents = {
        "Shopping": {"centroid": model.encode("amazon", normalize_embeddings=True), "n": 1},
    }
    pred_before, conf_before, emb, _top3, is_ovr_before = classifier.do_classify(
        "Trivago", local_cents=cents, local_ovrs={}
    )

    overrides = {"trivago": "Transport"}
    pred_after, conf_after, _emb2, _top3b, is_ovr_after = classifier.do_classify(
        "Trivago", local_cents=cents, local_ovrs=overrides
    )

    result = {
        "before": {"prediction": pred_before, "confidence": conf_before, "is_override": is_ovr_before},
        "after":  {"prediction": pred_after, "confidence": conf_after, "is_override": is_ovr_after},
    }
    save_result("classifier_override_behavior", result)

    assert pred_after == "Transport"
    assert conf_after == 1.0
    assert is_ovr_after is True


def test_centroid_update_shifts_toward_new_examples(model):
    """do_update() should move a category's centroid toward newly-confirmed
    examples via the documented running average, and stay unit-normalised —
    both are relied on by cosine similarity in do_classify."""
    seed_emb = model.encode("ikea", normalize_embeddings=True)
    cents = {"Home & Living": {"centroid": seed_emb.copy(), "n": 1}}

    new_emb = model.encode("otto", normalize_embeddings=True)
    classifier.do_update("Home & Living", new_emb, local_cents=cents)

    updated = cents["Home & Living"]["centroid"]
    expected = (seed_emb * 1 + new_emb) / 2
    expected = expected / np.linalg.norm(expected)

    assert cents["Home & Living"]["n"] == 2
    assert np.allclose(updated, expected, atol=1e-6)
    assert abs(np.linalg.norm(updated) - 1.0) < 1e-6


def test_repeated_corrections_converge_prediction():
    """Simulates the real product flow: a merchant the model gets wrong is
    corrected by the user a few times via /api/learn (do_update, since no
    override is registered by that endpoint for the *category* centroid
    path) — confidence for that merchant's category should trend upward,
    demonstrating the personalisation actually improves the model instead of
    only papering over one exact string via the override table."""
    model = classifier.get_model()
    merchant = "Kfz-Zulassung"  # German vehicle registration office — genuinely ambiguous
    cents = {
        "Transport": {"centroid": model.encode("bvg", normalize_embeddings=True), "n": 1},
        "Banking & Fees": {"centroid": model.encode("ing", normalize_embeddings=True), "n": 1},
    }

    confidences = []
    emb = model.encode(merchant.lower(), normalize_embeddings=True)
    for _ in range(5):
        pred, conf, _e, _t3, _o = classifier.do_classify(merchant, local_cents=cents, local_ovrs={})
        confidences.append({"prediction": pred, "confidence": conf})
        classifier.do_update("Banking & Fees", emb, local_cents=cents)

    save_result("classifier_convergence", {"merchant": merchant, "steps": confidences})
    # Confidence in the *target* category (Banking & Fees) for this exact
    # merchant should not be worse after several confirming corrections.
    final_conf_target = cosine_to(cents["Banking & Fees"]["centroid"], emb)
    # Running average with n starting at 1 still carries 1/6th weight from the
    # original seed embedding after 5 merges, so it approaches but doesn't hit
    # 1.0 — >0.95 already means the corrected category is now the dominant match.
    assert final_conf_target > 0.95


def cosine_to(vec_a, vec_b):
    return float(np.dot(vec_a, vec_b) / (np.linalg.norm(vec_a) * np.linalg.norm(vec_b)))
