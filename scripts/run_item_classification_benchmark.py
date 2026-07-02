#!/usr/bin/env python3
"""Benchmark item main-category classification.

The benchmark compares predictions on the same item-level gold dataset.
The legacy embedding classifier is evaluated through its current merchant-only
path, then mapped onto the item taxonomy main-category IDs.
"""

from __future__ import annotations

import argparse
import csv
import json
import sys
import time
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DATASET = REPO_ROOT / "benchmarks" / "item_classification_benchmark.csv"
DEFAULT_OUTPUT = REPO_ROOT / "reports" / "item_classification_benchmark_results.json"
ALLOWED_MAIN_CATEGORIES = {
    "groceries",
    "dining",
    "household",
    "personal_care",
    "health",
    "transport",
    "travel",
    "housing_utilities",
    "retail_goods",
    "digital_subscriptions",
    "entertainment_leisure",
    "education_work",
    "pets",
    "children_family",
    "gifts_donations",
    "insurance",
    "financial_admin",
    "other",
}
LEGACY_TO_TAXONOMY_MAIN = {
    "Banking & Fees": "financial_admin",
    "Entertainment & Subscriptions": "digital_subscriptions",
    "Food & Beverage": "dining",
    "Groceries": "groceries",
    "Health & Wellness": "health",
    "Home & Living": "household",
    "Personal Care": "personal_care",
    "Pet Supplies": "pets",
    "Shopping": "retail_goods",
    "Transport": "transport",
    "Others": "other",
}


def load_cases(path: Path, limit: int | None = None) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if limit is not None:
        rows = rows[:limit]
    for row in rows:
        row["quantity"] = float(row["quantity"])
        row["amount"] = float(row["amount"])
    return rows


def summarize_predictions(cases: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {prediction["id"]: prediction for prediction in predictions}
    total = len(cases)
    correct = 0
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    confusion: Counter[tuple[str, str]] = Counter()

    rows = []
    for case in cases:
        prediction = by_id.get(case["id"], {})
        pred_main = prediction.get("pred_main_category", "other")
        gold_main = case["gold_main_category"]
        is_correct = pred_main == gold_main
        correct += int(is_correct)
        by_category[gold_main]["total"] += 1
        by_category[gold_main]["correct"] += int(is_correct)
        confusion[(gold_main, pred_main)] += 1
        rows.append(
            {
                **case,
                **prediction,
                "correct": is_correct,
            }
        )

    per_category = {
        category: {
            "total": values["total"],
            "correct": values["correct"],
            "accuracy": round(values["correct"] / values["total"], 4) if values["total"] else 0.0,
        }
        for category, values in sorted(by_category.items())
    }
    return {
        "total": total,
        "correct": correct,
        "accuracy": round(correct / total, 4) if total else 0.0,
        "per_category": per_category,
        "confusion": [
            {"gold": gold, "pred": pred, "count": count}
            for (gold, pred), count in sorted(confusion.items())
        ],
        "predictions": rows,
    }


def run_embedding_baseline(cases: list[dict[str, Any]], input_mode: str) -> list[dict[str, Any]]:
    import numpy as np
    from sentence_transformers import SentenceTransformer

    centroid_payload = json.loads((REPO_ROOT / "dataset" / "centroids.json").read_text(encoding="utf-8"))
    model = SentenceTransformer(centroid_payload["model"])
    threshold = float(centroid_payload["threshold"])
    category_names = list(centroid_payload["categories"])
    centroid_matrix = np.stack(
        [np.array(centroid_payload["categories"][category]["centroid"]) for category in category_names]
    )

    texts = [
        f"{case['merchant']} {case['raw_name']}" if input_mode == "merchant_item" else case["merchant"]
        for case in cases
    ]
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    predictions = []
    for case, text, embedding in zip(cases, texts, embeddings):
        sims = centroid_matrix @ embedding
        order = np.argsort(sims)[::-1]
        best_idx = int(order[0])
        best_score = float(sims[best_idx])
        legacy_pred = category_names[best_idx] if best_score >= threshold else "Others"
        top3 = [
            {"category": category_names[int(index)], "score": round(float(sims[index]), 3)}
            for index in order[:3]
        ]
        predictions.append(
            {
                "id": case["id"],
                "model": "embedding",
                "embedding_input": text,
                "legacy_pred": legacy_pred,
                "pred_main_category": LEGACY_TO_TAXONOMY_MAIN.get(legacy_pred, "other"),
                "confidence": round(best_score, 3),
                "top3": top3,
            }
        )
    return predictions


def qwen_prompt(batch: list[dict[str, Any]]) -> str:
    return f"""
Classify receipt line items into item taxonomy main_category IDs.
Return strict JSON only. Do not include markdown or explanations.

Allowed main_category values:
{json.dumps(sorted(ALLOWED_MAIN_CATEGORIES), ensure_ascii=False)}

Rules:
- Use merchant only as context.
- Use item raw_name as the strongest signal.
- Do not classify all items from the same merchant into one category.
- Return exactly one prediction for every input id.
- main_category must be exactly one allowed value.
- If unclear, use "other".

Input:
{json.dumps(batch, ensure_ascii=False, indent=2)}

Output schema:
{{
  "predictions": [
    {{
      "id": "string",
      "main_category": "string",
      "confidence": 0.0
    }}
  ]
}}
""".strip()


def parse_qwen_predictions(raw_text: str, batch: list[dict[str, Any]]) -> list[dict[str, Any]]:
    sys.path.insert(0, str(REPO_ROOT))
    from scripts.qwen_item_classifier_demo import extract_json

    parsed = extract_json(raw_text)
    raw_predictions = parsed.get("predictions", [])
    by_id = {item.get("id"): item for item in raw_predictions if isinstance(item, dict)}
    predictions = []
    for item in batch:
        raw = by_id.get(item["id"], {})
        pred = raw.get("main_category", "other")
        if pred not in ALLOWED_MAIN_CATEGORIES:
            pred = "other"
        confidence = raw.get("confidence", 0.0)
        confidence = confidence if isinstance(confidence, (int, float)) else 0.0
        predictions.append(
            {
                "id": item["id"],
                "model": "qwen",
                "pred_main_category": pred,
                "confidence": round(max(0.0, min(1.0, float(confidence))), 4),
            }
        )
    return predictions


def run_qwen(cases: list[dict[str, Any]], model_name: str, batch_size: int, max_new_tokens: int) -> list[dict[str, Any]]:
    sys.path.insert(0, str(REPO_ROOT))
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor
    from scripts.qwen_item_classifier_demo import infer_merchant_context, tensor_dict_to_device

    device = torch.device("mps") if torch.backends.mps.is_available() else torch.device("cpu")
    dtype = torch.float16 if device.type == "mps" else torch.float32
    print(f"Loading {model_name} on {device} with {dtype}...", flush=True)
    processor = AutoProcessor.from_pretrained(model_name, trust_remote_code=True)
    model = AutoModelForMultimodalLM.from_pretrained(
        model_name,
        dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    model.to(device)
    model.eval()

    all_predictions = []
    for start in range(0, len(cases), batch_size):
        batch_cases = cases[start : start + batch_size]
        batch = []
        for case in batch_cases:
            merchant_context = infer_merchant_context(case["merchant"])
            batch.append(
                {
                    "id": case["id"],
                    "merchant": case["merchant"],
                    "merchant_type": merchant_context["merchant_type"],
                    "candidate_main_categories": merchant_context["candidate_main_categories"],
                    "raw_name": case["raw_name"],
                    "quantity": case["quantity"],
                    "amount": case["amount"],
                    "currency": case["currency"],
                }
            )

        messages = [
            {
                "role": "system",
                "content": [
                    {
                        "type": "text",
                        "text": "You are a JSON API. Return only valid JSON.",
                    }
                ],
            },
            {"role": "user", "content": [{"type": "text", "text": qwen_prompt(batch)}]},
        ]
        kwargs = {
            "add_generation_prompt": True,
            "tokenize": True,
            "return_dict": True,
            "return_tensors": "pt",
        }
        try:
            inputs = processor.apply_chat_template(messages, enable_thinking=False, **kwargs)
        except TypeError:
            inputs = processor.apply_chat_template(messages, **kwargs)
        inputs = tensor_dict_to_device(inputs, device)
        print(f"Generating Qwen batch {start + 1}-{start + len(batch_cases)}...", flush=True)
        with torch.inference_mode():
            outputs = model.generate(
                **inputs,
                max_new_tokens=max_new_tokens,
                do_sample=False,
            )
        prompt_tokens = inputs["input_ids"].shape[-1]
        raw_text = processor.decode(outputs[0][prompt_tokens:], skip_special_tokens=True).strip()
        all_predictions.extend(parse_qwen_predictions(raw_text, batch))

    return all_predictions


def main() -> None:
    parser = argparse.ArgumentParser(description="Run item classification benchmark.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--models", default="embedding", help="Comma-separated: embedding,qwen")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--embedding-input", choices=["merchant", "merchant_item"], default="merchant")
    parser.add_argument("--qwen-model", default="Qwen/Qwen3.5-4B")
    parser.add_argument("--qwen-batch-size", type=int, default=10)
    parser.add_argument("--qwen-max-new-tokens", type=int, default=1536)
    args = parser.parse_args()

    started_at = time.time()
    cases = load_cases(args.dataset, args.limit)
    requested_models = [model.strip() for model in args.models.split(",") if model.strip()]
    results: dict[str, Any] = {
        "dataset": str(args.dataset.relative_to(REPO_ROOT) if args.dataset.is_relative_to(REPO_ROOT) else args.dataset),
        "scope": "item main_category accuracy",
        "gold_count": len(cases),
        "gold_distribution": dict(Counter(case["gold_main_category"] for case in cases).most_common()),
        "models": {},
    }

    if "embedding" in requested_models:
        embedding_predictions = run_embedding_baseline(cases, args.embedding_input)
        results["models"]["embedding"] = {
            "description": "Legacy SentenceTransformer nearest-centroid classifier, mapped from legacy transaction labels to taxonomy main categories.",
            "input_mode": args.embedding_input,
            **summarize_predictions(cases, embedding_predictions),
        }

    if "qwen" in requested_models:
        qwen_predictions = run_qwen(cases, args.qwen_model, args.qwen_batch_size, args.qwen_max_new_tokens)
        results["models"]["qwen"] = {
            "description": "Local Qwen classifier prompted on merchant and item text.",
            "qwen_model": args.qwen_model,
            "batch_size": args.qwen_batch_size,
            **summarize_predictions(cases, qwen_predictions),
        }

    results["duration_seconds"] = round(time.time() - started_at, 1)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(results, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({k: v for k, v in results.items() if k != "models"}, ensure_ascii=False, indent=2))
    for model_name, model_result in results["models"].items():
        print(
            f"{model_name}: {model_result['correct']}/{model_result['total']} "
            f"accuracy={model_result['accuracy']:.4f}"
        )
    print(f"Wrote {args.output}")


if __name__ == "__main__":
    main()
