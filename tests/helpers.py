"""Shared utilities for the QA test suite: metrics + result persistence.

Tests build their own in-memory centroids and pass them explicitly to
classifier.do_classify(..., local_cents=...) rather than mutating the module-
level `classifier.centroids` — that keeps evaluation runs from ever touching
dataset/centroids.json (the production base model).
"""

from __future__ import annotations

import json
from collections import defaultdict
from pathlib import Path

import numpy as np

RESULTS_DIR = Path(__file__).resolve().parent / "results"


def save_result(name: str, payload: dict) -> Path:
    RESULTS_DIR.mkdir(exist_ok=True)
    path = RESULTS_DIR / f"{name}.json"
    with open(path, "w") as f:
        json.dump(payload, f, indent=2, default=str)
    return path


def build_centroids_from_pairs(pairs: list[tuple[str, str]], model, exclude=("Others",)) -> dict:
    """pairs: list of (merchant_name, category). Mirrors classifier.load_from_csv
    but works on an arbitrary in-memory subset (e.g. a train split)."""
    names = [n.lower() for n, _ in pairs]
    labels = [c for _, c in pairs]
    embs = model.encode(names, normalize_embeddings=True, show_progress_bar=False)

    centroids: dict = {}
    for cat in sorted(set(labels)):
        if cat in exclude:
            continue
        mask = np.array([l == cat for l in labels])
        center = embs[mask].mean(axis=0)
        center = center / np.linalg.norm(center)
        centroids[cat] = {"centroid": center, "n": int(mask.sum())}
    return centroids


def macro_f1(confusion: dict[str, dict[str, int]], labels: list[str]) -> tuple[float, dict]:
    """confusion[true_label][pred_label] = count. Returns (macro_f1, per_class_dict)."""
    per_class = {}
    f1_sum = 0.0
    for label in labels:
        tp = confusion.get(label, {}).get(label, 0)
        fp = sum(confusion.get(t, {}).get(label, 0) for t in labels if t != label)
        fn = sum(v for k, v in confusion.get(label, {}).items() if k != label)
        precision = tp / (tp + fp) if (tp + fp) else 0.0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        per_class[label] = {"precision": round(precision, 3), "recall": round(recall, 3),
                             "f1": round(f1, 3), "support": tp + fn}
        f1_sum += f1
    return round(f1_sum / len(labels), 3) if labels else 0.0, per_class


def new_confusion() -> dict:
    return defaultdict(lambda: defaultdict(int))


def latency_stats(samples_seconds: list[float]) -> dict:
    """p50/p95/mean/max over a small sample of wall-clock latencies. With the
    small n typical of live-API eval runs (5-10 calls), p95 is really "close
    to the max" rather than a statistically tight tail estimate — reported as
    such, not as a production SLO measurement."""
    if not samples_seconds:
        return {"n": 0, "mean_s": None, "p50_s": None, "p95_s": None, "max_s": None}
    xs = sorted(samples_seconds)
    n = len(xs)

    def pct(p):
        idx = min(n - 1, max(0, round(p * (n - 1))))
        return xs[idx]

    return {
        "n": n,
        "mean_s": round(sum(xs) / n, 3),
        "p50_s": round(pct(0.5), 3),
        "p95_s": round(pct(0.95), 3),
        "max_s": round(xs[-1], 3),
    }
