#!/usr/bin/env python3
"""Benchmark merchant-only transaction classification on the old 10-class taxonomy."""

from __future__ import annotations

import argparse
import csv
import json
import statistics
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any

import numpy as np


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = REPO_ROOT / "benchmarks" / "transaction_classification_benchmark.csv"
DEFAULT_OUTPUT = REPO_ROOT / "reports" / "transaction_classification_benchmark_results.json"
DEFAULT_CENTROIDS = REPO_ROOT / "dataset" / "centroids.json"
DEFAULT_HARRIER_MODEL = "microsoft/harrier-oss-v1-0.6b"

OLD_10_LABEL_DESCRIPTIONS = {
    "Banking & Fees": "Bank fees, card fees, account fees, insurance-like financial payments, administrative charges, taxes, fines, and other financial services.",
    "Entertainment & Subscriptions": "Streaming, digital subscriptions, music, apps, games, cinema, events, nightlife, leisure and entertainment spending.",
    "Food & Beverage": "Restaurants, cafes, bakeries, canteens, takeaway, delivery, fast food, coffee, meals and prepared drinks.",
    "Groceries": "Supermarket and grocery purchases for food or household consumption, including Aldi, Lidl, Edeka, Rewe and similar stores.",
    "Health & Wellness": "Pharmacy, medicine, doctors, clinics, fitness, gym, therapy, healthcare and wellness services.",
    "Home & Living": "Rent, housing, utilities, internet, electricity, water, home supplies, furniture and home living expenses.",
    "Personal Care": "Haircuts, grooming, toiletries, cosmetics, hygiene, skin care, dental care and personal care services.",
    "Pet Supplies": "Pet food, pet supplies, veterinary care, grooming, boarding and pet-related expenses.",
    "Shopping": "Retail goods, clothing, electronics, books, stationery, durable goods and general shopping.",
    "Transport": "Public transport, rail, bus, taxi, ride hailing, fuel, parking, travel tickets and mobility spending.",
}


def load_cases(path: Path) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    for row in rows:
        row["amount"] = float(row["amount"])
    return rows


def sync_device() -> None:
    try:
        import torch

        if torch.backends.mps.is_available():
            torch.mps.synchronize()
    except Exception:
        return


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return 0.0
    values = sorted(values)
    index = min(len(values) - 1, max(0, round((len(values) - 1) * pct)))
    return values[index]


def summarize_predictions(cases: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {prediction["id"]: prediction for prediction in predictions}
    correct = 0
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    confusion: Counter[tuple[str, str]] = Counter()
    rows = []

    for case in cases:
        prediction = by_id[case["id"]]
        gold = case["gold_category"]
        pred = prediction["pred_category"]
        is_correct = pred == gold
        correct += int(is_correct)
        by_category[gold]["total"] += 1
        by_category[gold]["correct"] += int(is_correct)
        confusion[(gold, pred)] += 1
        rows.append(
            {
                **case,
                **prediction,
                "correct": is_correct,
            }
        )

    total = len(cases)
    return {
        "total": total,
        "correct": correct,
        "accuracy": round(correct / total, 4) if total else 0.0,
        "per_category": {
            category: {
                "total": values["total"],
                "correct": values["correct"],
                "accuracy": round(values["correct"] / values["total"], 4) if values["total"] else 0.0,
            }
            for category, values in sorted(by_category.items())
        },
        "confusion": [
            {"gold": gold, "pred": pred, "count": count}
            for (gold, pred), count in sorted(confusion.items())
        ],
        "top_confusions": [
            {"gold": gold, "pred": pred, "count": count}
            for (gold, pred), count in confusion.most_common()
            if gold != pred
        ][:10],
        "predictions": rows,
    }


def latency_summary(latencies_ms: list[float]) -> dict[str, float]:
    return {
        "warm_single_ms_median": round(statistics.median(latencies_ms), 2) if latencies_ms else 0.0,
        "warm_single_ms_p95": round(percentile(latencies_ms, 0.95), 2),
        "warm_single_ms_min": round(min(latencies_ms), 2) if latencies_ms else 0.0,
        "warm_single_ms_max": round(max(latencies_ms), 2) if latencies_ms else 0.0,
    }


def run_legacy_centroid(cases: list[dict[str, Any]], single_sample_size: int) -> tuple[dict[str, Any], dict[str, Any]]:
    from sentence_transformers import SentenceTransformer

    texts = [case["merchant"] for case in cases]
    load_start = time.perf_counter()
    centroid_payload = json.loads(DEFAULT_CENTROIDS.read_text(encoding="utf-8"))
    model = SentenceTransformer(centroid_payload["model"])
    sync_device()
    model_load_seconds = time.perf_counter() - load_start

    labels = list(centroid_payload["categories"])
    centroid_matrix = np.stack(
        [np.array(centroid_payload["categories"][label]["centroid"]) for label in labels]
    )
    threshold = float(centroid_payload["threshold"])

    encode_start = time.perf_counter()
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False, batch_size=32)
    sync_device()
    batch_encode_seconds = time.perf_counter() - encode_start

    score_start = time.perf_counter()
    scores = embeddings @ centroid_matrix.T
    order = np.argsort(scores, axis=1)[:, ::-1]
    score_seconds = time.perf_counter() - score_start

    predictions = []
    for case, row_order, score_row in zip(cases, order, scores):
        best_idx = int(row_order[0])
        best_score = float(score_row[best_idx])
        pred = labels[best_idx] if best_score >= threshold else "Others"
        predictions.append(
            {
                "id": case["id"],
                "model": "legacy_centroid_sentence_transformer",
                "input_mode": "merchant",
                "pred_category": pred,
                "confidence": round(best_score, 4),
                "top3": [
                    {"category": labels[int(index)], "score": round(float(score_row[index]), 4)}
                    for index in row_order[:3]
                ],
            }
        )

    latencies = []
    for text in texts[:single_sample_size]:
        start = time.perf_counter()
        embedding = model.encode([text], normalize_embeddings=True, show_progress_bar=False)
        _ = embedding @ centroid_matrix.T
        sync_device()
        latencies.append((time.perf_counter() - start) * 1000)

    timings = {
        "model_load_seconds": round(model_load_seconds, 3),
        "batch_encode_seconds": round(batch_encode_seconds, 3),
        "score_seconds": round(score_seconds, 4),
        "batch_rows_per_second": round(len(cases) / batch_encode_seconds, 2) if batch_encode_seconds else 0.0,
        "batch_encode_ms_per_row": round(batch_encode_seconds * 1000 / len(cases), 3) if cases else 0.0,
        "single_sample_size": min(single_sample_size, len(texts)),
        "threshold": threshold,
        "others_predictions": sum(1 for prediction in predictions if prediction["pred_category"] == "Others"),
        **latency_summary(latencies),
    }
    return summarize_predictions(cases, predictions), timings


def run_harrier_zero_shot(
    cases: list[dict[str, Any]],
    model_name: str,
    single_sample_size: int,
) -> tuple[dict[str, Any], dict[str, Any]]:
    import torch
    from sentence_transformers import SentenceTransformer

    texts = [case["merchant"] for case in cases]
    device = "mps" if torch.backends.mps.is_available() else "cpu"
    load_start = time.perf_counter()
    model = SentenceTransformer(model_name, device=device)
    sync_device()
    model_load_seconds = time.perf_counter() - load_start

    labels = list(OLD_10_LABEL_DESCRIPTIONS)
    label_texts = [
        f"Category: {label}. Definition: {OLD_10_LABEL_DESCRIPTIONS[label]}"
        for label in labels
    ]

    label_start = time.perf_counter()
    label_embeddings = model.encode(label_texts, normalize_embeddings=True, show_progress_bar=False, batch_size=16)
    sync_device()
    label_encode_seconds = time.perf_counter() - label_start

    encode_start = time.perf_counter()
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=False, batch_size=32)
    sync_device()
    batch_encode_seconds = time.perf_counter() - encode_start

    score_start = time.perf_counter()
    scores = embeddings @ label_embeddings.T
    order = np.argsort(scores, axis=1)[:, ::-1]
    score_seconds = time.perf_counter() - score_start

    predictions = []
    for case, row_order, score_row in zip(cases, order, scores):
        best_idx = int(row_order[0])
        predictions.append(
            {
                "id": case["id"],
                "model": "harrier_zero_shot",
                "harrier_model": model_name,
                "input_mode": "merchant",
                "pred_category": labels[best_idx],
                "confidence": round(float(score_row[best_idx]), 4),
                "top3": [
                    {"category": labels[int(index)], "score": round(float(score_row[index]), 4)}
                    for index in row_order[:3]
                ],
            }
        )

    latencies = []
    for text in texts[:single_sample_size]:
        start = time.perf_counter()
        embedding = model.encode([text], normalize_embeddings=True, show_progress_bar=False)
        _ = embedding @ label_embeddings.T
        sync_device()
        latencies.append((time.perf_counter() - start) * 1000)

    timings = {
        "device": device,
        "model_load_seconds": round(model_load_seconds, 3),
        "label_encode_seconds": round(label_encode_seconds, 3),
        "batch_encode_seconds": round(batch_encode_seconds, 3),
        "score_seconds": round(score_seconds, 4),
        "batch_rows_per_second": round(len(cases) / batch_encode_seconds, 2) if batch_encode_seconds else 0.0,
        "batch_encode_ms_per_row": round(batch_encode_seconds * 1000 / len(cases), 3) if cases else 0.0,
        "single_sample_size": min(single_sample_size, len(texts)),
        **latency_summary(latencies),
    }
    return summarize_predictions(cases, predictions), timings


def main() -> None:
    parser = argparse.ArgumentParser(description="Run merchant-only transaction classification benchmark.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--models", default="legacy,harrier", help="Comma-separated: legacy,harrier")
    parser.add_argument("--harrier-model", default=DEFAULT_HARRIER_MODEL)
    parser.add_argument("--single-sample-size", type=int, default=50)
    args = parser.parse_args()

    started_at = time.perf_counter()
    cases = load_cases(args.dataset)
    requested_models = [model.strip() for model in args.models.split(",") if model.strip()]
    results: dict[str, Any] = {
        "dataset": str(args.dataset.relative_to(REPO_ROOT) if args.dataset.is_relative_to(REPO_ROOT) else args.dataset),
        "scope": "merchant-only transaction classification on the old 10-class taxonomy",
        "input_mode": "merchant",
        "gold_count": len(cases),
        "gold_distribution": dict(Counter(case["gold_category"] for case in cases).most_common()),
        "models": {},
    }

    if "legacy" in requested_models:
        summary, timings = run_legacy_centroid(cases, args.single_sample_size)
        results["models"]["legacy_centroid_sentence_transformer"] = {
            "description": "Existing SentenceTransformer nearest-centroid classifier using dataset/centroids.json.",
            "timings": timings,
            **summary,
        }

    if "harrier" in requested_models:
        summary, timings = run_harrier_zero_shot(cases, args.harrier_model, args.single_sample_size)
        results["models"]["harrier_zero_shot"] = {
            "description": "Microsoft Harrier embedding model used as a zero-shot classifier against old 10-class label descriptions.",
            "harrier_model": args.harrier_model,
            "timings": timings,
            **summary,
        }

    results["duration_seconds"] = round(time.perf_counter() - started_at, 1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print(json.dumps({k: v for k, v in results.items() if k != "models"}, ensure_ascii=False, indent=2))
    for model_name, model_result in results["models"].items():
        timings = model_result["timings"]
        print(
            f"{model_name}: {model_result['correct']}/{model_result['total']} "
            f"accuracy={model_result['accuracy']:.4f} "
            f"batch_ms_per_row={timings['batch_encode_ms_per_row']} "
            f"single_median_ms={timings['warm_single_ms_median']}"
        )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
