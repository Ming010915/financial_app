"""
Held-out accuracy evaluation for the nearest-centroid merchant classifier.

Merchant names repeat across dataset/monthly_spending_2024.csv (576 rows /
175 unique merchants), and every merchant maps to exactly one category, so a
row-level split would leak the same merchant into both train and test and
make the classifier look artificially perfect. We split by *unique merchant
name*, stratified by category, so test merchants are never seen while
building the centroids — this measures generalisation to new merchants,
which is the actual product behaviour (a first-time merchant name).
"""

from __future__ import annotations

import random
from collections import Counter

import numpy as np
import pandas as pd
import pytest
from sklearn.metrics.pairwise import cosine_similarity

from config import MONTHLY_SPENDING_DATASET, THRESHOLD
from services import classifier
from tests.helpers import build_centroids_from_pairs, macro_f1, new_confusion, save_result

SEED = 42
TEST_FRACTION = 0.2


def _stratified_split(df: pd.DataFrame, seed: int, test_fraction: float):
    unique = df.drop_duplicates(subset="name")[["name", "category"]]
    rng = random.Random(seed)
    train, test = [], []
    for cat, group in unique.groupby("category"):
        names = group["name"].tolist()
        rng.shuffle(names)
        n_test = max(1, round(len(names) * test_fraction)) if len(names) > 1 else 0
        test_names = set(names[:n_test])
        for n in names:
            (test if n in test_names else train).append((n, cat))
    return train, test


@pytest.fixture(scope="module")
def split():
    df = pd.read_csv(MONTHLY_SPENDING_DATASET)
    return _stratified_split(df, SEED, TEST_FRACTION)


@pytest.fixture(scope="module")
def trained_centroids(split):
    train, _ = split
    model = classifier.get_model()
    # "Others" has no centroid by design (see classifier.load_from_csv) — a
    # merchant only lands there when it's a poor match for every real category.
    cents = build_centroids_from_pairs(train, model, exclude=("Others",))
    return cents, model


def test_holdout_accuracy(split, trained_centroids):
    _, test = split
    cents, _model = trained_centroids

    confusion = new_confusion()
    confidences_correct, confidences_wrong = [], []
    rows = []

    for name, true_cat in test:
        pred, conf, _emb, top3, _is_ovr = classifier.do_classify(
            name, local_cents=cents, local_ovrs={}
        )
        confusion[true_cat][pred] += 1
        (confidences_correct if pred == true_cat else confidences_wrong).append(conf)
        rows.append({"name": name, "true": true_cat, "pred": pred, "confidence": conf,
                      "top3": top3, "correct": pred == true_cat})

    labels = sorted({true_cat for _, true_cat in test} | {r["pred"] for r in rows})
    accuracy = sum(r["correct"] for r in rows) / len(rows)
    f1, per_class = macro_f1(confusion, labels)

    # Confidence calibration: correct predictions should sit well above THRESHOLD
    # and above the confidence of wrong predictions on average.
    avg_conf_correct = sum(confidences_correct) / len(confidences_correct) if confidences_correct else 0.0
    avg_conf_wrong = sum(confidences_wrong) / len(confidences_wrong) if confidences_wrong else 0.0

    result = {
        "n_train_merchants": len(split[0]),
        "n_test_merchants": len(test),
        "threshold": THRESHOLD,
        "accuracy": round(accuracy, 4),
        "macro_f1": f1,
        "avg_confidence_when_correct": round(avg_conf_correct, 4),
        "avg_confidence_when_wrong": round(avg_conf_wrong, 4),
        "per_class": per_class,
        "confusion_matrix": {k: dict(v) for k, v in confusion.items()},
        "misclassified_examples": [r for r in rows if not r["correct"]][:25],
    }
    save_result("classifier_accuracy", result)

    print(f"\nHeld-out accuracy: {accuracy:.1%}  macro-F1: {f1}  "
          f"(n_test={len(test)}, n_train={len(split[0])})")
    print(f"avg confidence — correct: {avg_conf_correct:.3f}  wrong: {avg_conf_wrong:.3f}")

    # Sanity thresholds — generous enough not to be flaky on reshuffles,
    # tight enough to catch a real regression (e.g. a broken embedding call).
    assert accuracy > 0.55, "held-out accuracy dropped well below expected range"
    assert avg_conf_correct > avg_conf_wrong, "confidence should be higher on correct predictions"


def test_holdout_accuracy_multiseed():
    """Single-seed accuracy is noisy with only ~36 test merchants. Average
    over several stratified splits for a number that's actually defensible
    in the report."""
    df = pd.read_csv(MONTHLY_SPENDING_DATASET)
    model = classifier.get_model()
    accuracies = []

    for seed in range(20):
        train, test = _stratified_split(df, seed, TEST_FRACTION)
        cents = build_centroids_from_pairs(train, model, exclude=("Others",))
        correct = 0
        for name, true_cat in test:
            pred, _conf, _emb, _top3, _is_ovr = classifier.do_classify(
                name, local_cents=cents, local_ovrs={}
            )
            correct += pred == true_cat
        accuracies.append(correct / len(test))

    mean_acc = sum(accuracies) / len(accuracies)
    variance = sum((a - mean_acc) ** 2 for a in accuracies) / len(accuracies)
    std_acc = variance ** 0.5

    result = {"seeds": list(range(20)), "accuracies": [round(a, 4) for a in accuracies],
               "mean_accuracy": round(mean_acc, 4), "std_accuracy": round(std_acc, 4)}
    save_result("classifier_accuracy_multiseed", result)
    print(f"\nMulti-seed accuracy: {mean_acc:.1%} ± {std_acc:.1%} over {len(accuracies)} splits")

    # Floor set relative to the ~22% majority-class baseline (see
    # test_baseline_and_warm_accuracy_comparison), not an arbitrary round
    # number — at n=20 seeds the honest mean sits around 46-47%, comfortably
    # above baseline but below the n=5 estimate this threshold was originally
    # tuned to (a smaller sample happened to land on the higher end).
    assert mean_acc > 0.35


def test_baseline_and_warm_accuracy_comparison():
    """Cold-start accuracy (test_holdout_accuracy_multiseed) means nothing on
    its own — it needs a floor (a trivial baseline) and a ceiling (accuracy on
    a merchant the model actually has seen) to be judgeable. This computes
    both, batching embeddings once up front (do_classify's one-name-at-a-time
    model.encode() is fine for a single live request but far too slow to
    call ~1500 times here; the nearest-centroid + threshold math below is
    identical to do_classify, just vectorised over pre-computed embeddings)."""
    df = pd.read_csv(MONTHLY_SPENDING_DATASET)
    model = classifier.get_model()

    unique_names = df.drop_duplicates(subset="name")["name"].tolist()
    embs = model.encode([n.lower() for n in unique_names], normalize_embeddings=True,
                         show_progress_bar=False, batch_size=64)
    emb_by_name = dict(zip(unique_names, embs))

    def build(train):
        cents = {}
        for cat in sorted({c for _, c in train}):
            if cat == "Others":
                continue
            vecs = np.stack([emb_by_name[n] for n, c in train if c == cat])
            center = vecs.mean(axis=0)
            cents[cat] = center / np.linalg.norm(center)
        return cents

    def classify_many(names, cents):
        cat_names = list(cents.keys())
        matrix = np.stack([cents[c] for c in cat_names])
        sims = cosine_similarity(np.stack([emb_by_name[n] for n in names]), matrix)
        preds = []
        for row in sims:
            best = int(np.argmax(row))
            preds.append(cat_names[best] if row[best] >= THRESHOLD else "Others")
        return preds

    maj_accs, cold_accs, warm_accs = [], [], []
    for seed in range(20):
        train, test = _stratified_split(df, seed, TEST_FRACTION)
        majority = Counter(c for _, c in train).most_common(1)[0][0]
        maj_accs.append(sum(1 for _, c in test if c == majority) / len(test))

        cents = build(train)
        cold_preds = classify_many([n for n, _ in test], cents)
        cold_accs.append(sum(p == c for p, (_, c) in zip(cold_preds, test)) / len(test))

        warm_preds = classify_many([n for n, _ in train], cents)
        warm_accs.append(sum(p == c for p, (_, c) in zip(warm_preds, train)) / len(train))

    avg = lambda xs: round(sum(xs) / len(xs), 4)
    result = {
        "n_seeds": 20,
        "majority_class_baseline_accuracy": avg(maj_accs),
        "cold_start_accuracy": avg(cold_accs),
        "warm_in_vocabulary_accuracy": avg(warm_accs),
        "note": (
            "majority_class_baseline = always predicting the most common training "
            "category, the floor a classifier must clear to be worth anything. "
            "warm_in_vocabulary = accuracy on merchants that WERE part of the "
            "training centroids (the ceiling for this model size, since a real "
            "override takes an exact-match merchant straight to 100%)."
        ),
    }
    save_result("classifier_baseline_comparison", result)
    print(f"\nBaseline {result['majority_class_baseline_accuracy']:.1%} | "
          f"Cold-start {result['cold_start_accuracy']:.1%} | "
          f"Warm {result['warm_in_vocabulary_accuracy']:.1%}")

    # Cold-start must clearly beat the trivial baseline, and warm accuracy
    # must clearly beat cold-start — both would flag a real regression.
    assert result["cold_start_accuracy"] > result["majority_class_baseline_accuracy"] + 0.15
    assert result["warm_in_vocabulary_accuracy"] > result["cold_start_accuracy"]


def test_needs_review_flag_quality(split, trained_centroids):
    """The `needs_review` flag (confidence < ASK_BELOW) should correlate with
    actually-wrong predictions — i.e. it should usefully catch errors instead
    of flagging almost everything or almost nothing."""
    from config import ASK_BELOW

    _, test = split
    cents, _model = trained_centroids

    flagged_and_wrong = flagged_and_right = unflagged_and_wrong = unflagged_and_right = 0
    for name, true_cat in test:
        pred, conf, _emb, _top3, _is_ovr = classifier.do_classify(name, local_cents=cents, local_ovrs={})
        flagged = conf < ASK_BELOW
        correct = pred == true_cat
        if flagged and not correct:
            flagged_and_wrong += 1
        elif flagged and correct:
            flagged_and_right += 1
        elif not flagged and not correct:
            unflagged_and_wrong += 1
        else:
            unflagged_and_right += 1

    total = flagged_and_wrong + flagged_and_right + unflagged_and_wrong + unflagged_and_right
    recall_on_errors = flagged_and_wrong / (flagged_and_wrong + unflagged_and_wrong) \
        if (flagged_and_wrong + unflagged_and_wrong) else None
    flag_rate = (flagged_and_wrong + flagged_and_right) / total

    result = {
        "ask_below": ASK_BELOW,
        "flag_rate": round(flag_rate, 4),
        "recall_on_actual_errors": round(recall_on_errors, 4) if recall_on_errors is not None else None,
        "flagged_and_wrong": flagged_and_wrong,
        "flagged_and_right": flagged_and_right,
        "unflagged_and_wrong": unflagged_and_wrong,
        "unflagged_and_right": unflagged_and_right,
    }
    save_result("classifier_needs_review", result)
    print(f"\nneeds_review flag rate: {flag_rate:.1%}, recall on actual errors: {recall_on_errors}")
