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
DEFAULT_TAXONOMY_SUMMARY = REPO_ROOT / "taxonomy" / "receipt_item_taxonomy_summary.json"
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
    "digital_services",
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
    "Entertainment & Subscriptions": "digital_services",
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
TAXONOMY_MAIN_DESCRIPTIONS = {
    "groceries": "Food and drink items bought for home or later consumption, such as milk, bread, produce, meat, pantry staples, snacks, bottled drinks, supermarket alcohol, frozen food, and ready meals.",
    "dining": "Prepared food and drinks consumed in restaurants, cafes, bars, canteens, bakeries, takeaway, or delivery, including coffee, fast food, restaurant meals, desserts, and tips for food service.",
    "household": "Non-food household consumables and home supplies, including cleaning products, laundry detergent, paper goods, trash bags, kitchen supplies, light bulbs, batteries, tools, and garden supplies.",
    "personal_care": "Personal hygiene, grooming, dental care, hair care, skin care, cosmetics, fragrance, deodorant, shower gel, and grooming services such as haircuts.",
    "health": "Medicine, pharmacy items, supplements, medical devices, doctor or clinic fees, therapy, physiotherapy, fitness, wellness, and health-related services.",
    "transport": "Daily mobility and local transportation, including public transport, commuter train, taxi, ride hailing, fuel, parking, car maintenance, bike rental, and e-scooter rides.",
    "travel": "Trip-related spending, including flights, hotels, accommodation, long-distance train or bus, travel local transport, travel food, tours, luggage, and visa fees.",
    "housing_utilities": "Rent, mortgage, electricity, gas, water, heating, internet, phone, property fees, housing repairs, and housing-related utility bills.",
    "retail_goods": "Durable or discretionary retail goods such as clothing, shoes, accessories, electronics, books, stationery, sports equipment, toys, games, general merchandise, and luxury goods.",
    "digital_services": "Digital platforms and recurring services, including streaming, music subscriptions, gaming, software, cloud storage, news subscriptions, mobile phone plans, membership platforms, and online services.",
    "entertainment_leisure": "One-off entertainment, cultural activities, hobbies, sports activities, nightlife, games, arcades, cinema, concerts, museums, bowling, escape rooms, and leisure services.",
    "education_work": "Education and work expenses, including tuition, online courses, textbooks, study materials, office supplies, professional services, work equipment, conferences, and certifications.",
    "pets": "Pet food, pet care supplies, cat litter, leashes, pet toys, veterinary bills, pet grooming, and pet boarding.",
    "children_family": "Childcare, baby food, baby formula, diapers, baby wipes, kids clothing, kids toys, children's education activities, and family support.",
    "gifts_donations": "Gifts, donations, charity payments, tips, celebrations, birthday gifts, wedding gifts, and social giving.",
    "insurance": "Insurance payments including health insurance, car insurance, home insurance, travel insurance, life insurance, liability insurance, and other insurance.",
    "financial_admin": "Bank fees, card fees, ATM fees, interest, loan payments, taxes, fines, legal fees, accounting fees, government services, deposits, refunds, discounts, delivery fees, and service fees.",
    "other": "Unknown, unclear, uncategorizable, or insufficiently described items that do not fit any other category.",
}


def load_cases(path: Path, limit: int | None = None, sample_per_category: int | None = None) -> list[dict[str, Any]]:
    with path.open(newline="", encoding="utf-8") as handle:
        rows = list(csv.DictReader(handle))
    if sample_per_category is not None:
        selected = []
        counts: Counter[str] = Counter()
        for row in rows:
            category = row["gold_main_category"]
            if counts[category] < sample_per_category:
                selected.append(row)
                counts[category] += 1
        rows = selected
    if limit is not None:
        rows = rows[:limit]
    for row in rows:
        row["quantity"] = float(row["quantity"])
        row["amount"] = float(row["amount"])
    return rows


def load_taxonomy_summary(path: Path = DEFAULT_TAXONOMY_SUMMARY) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def subcategories_by_main(taxonomy_summary: dict[str, Any]) -> dict[str, list[str]]:
    compact = taxonomy_summary.get("sub_categories_by_main")
    if isinstance(compact, dict):
        return {str(main): list(subcategories) for main, subcategories in compact.items()}

    return {
        row["id"]: row["sub_categories"]
        for row in taxonomy_summary["main_categories"]
    }


def taxonomy_description(label_id: str) -> str:
    return TAXONOMY_MAIN_DESCRIPTIONS.get(
        label_id,
        label_id.replace("_", " "),
    )


def benchmark_input_text(case: dict[str, Any], input_mode: str) -> str:
    if input_mode == "merchant_item":
        return f"{case['merchant']} {case['raw_name']}"
    if input_mode == "merchant":
        return case["merchant"]
    raise ValueError(f"Unsupported input_mode: {input_mode}")


def summarize_predictions(cases: list[dict[str, Any]], predictions: list[dict[str, Any]]) -> dict[str, Any]:
    by_id = {prediction["id"]: prediction for prediction in predictions}
    total = len(cases)
    correct = 0
    by_category: dict[str, dict[str, int]] = defaultdict(lambda: {"total": 0, "correct": 0})
    confusion: Counter[tuple[str, str]] = Counter()
    sub_total = 0
    sub_correct = 0

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
        if "pred_sub_category" in prediction:
            sub_total += 1
            sub_correct += int(prediction.get("pred_sub_category") == case["gold_sub_category"])
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
    summary = {
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
    if sub_total:
        summary["sub_category_total"] = sub_total
        summary["sub_category_correct"] = sub_correct
        summary["sub_category_accuracy"] = round(sub_correct / sub_total, 4)
    return summary


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

    texts = [benchmark_input_text(case, input_mode) for case in cases]
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
                "model": "legacy_embedding",
                "input_mode": input_mode,
                "embedding_input": text,
                "legacy_pred": legacy_pred,
                "pred_main_category": LEGACY_TO_TAXONOMY_MAIN.get(legacy_pred, "other"),
                "confidence": round(best_score, 3),
                "top3": top3,
            }
        )
    return predictions


def run_harrier_zero_shot(
    cases: list[dict[str, Any]],
    model_name: str,
    candidate_mode: str,
    input_mode: str,
) -> list[dict[str, Any]]:
    sys.path.insert(0, str(REPO_ROOT))
    import numpy as np
    import torch
    from sentence_transformers import SentenceTransformer
    from scripts.qwen_item_classifier_demo import infer_merchant_context

    device = "mps" if torch.backends.mps.is_available() else "cpu"
    model = SentenceTransformer(model_name, device=device)
    taxonomy = subcategories_by_main(load_taxonomy_summary())
    label_ids = list(taxonomy)
    label_id_set = set(label_ids)
    label_texts = [
        f"Category: {label_id}. Definition: {taxonomy_description(label_id)}"
        for label_id in label_ids
    ]
    item_texts = [benchmark_input_text(case, input_mode) for case in cases]

    label_embeddings = model.encode(label_texts, normalize_embeddings=True, show_progress_bar=True)
    item_embeddings = model.encode(item_texts, normalize_embeddings=True, show_progress_bar=True)
    scores = item_embeddings @ label_embeddings.T
    predictions = []
    for case, text, row in zip(cases, item_texts, scores):
        merchant_context = infer_merchant_context(case["merchant"])
        raw_candidate_categories = [
            category for category in merchant_context["candidate_main_categories"] if category in label_id_set
        ]
        candidate_categories = list(dict.fromkeys([*raw_candidate_categories, "other"])) if raw_candidate_categories else []
        candidate_indices = [label_ids.index(category) for category in candidate_categories]
        if candidate_mode == "merchant_focus" and raw_candidate_categories:
            ranked_indices = sorted(candidate_indices, key=lambda index: float(row[index]), reverse=True)
        else:
            ranked_indices = list(np.argsort(row)[::-1])
        order = ranked_indices
        best_idx = int(order[0])
        predictions.append(
            {
                "id": case["id"],
                "model": "harrier_zero_shot",
                "harrier_model": model_name,
                "candidate_mode": candidate_mode,
                "input_mode": input_mode,
                "merchant_type": merchant_context["merchant_type"],
                "candidate_main_categories": candidate_categories if candidate_mode == "merchant_focus" else [],
                "embedding_input": text,
                "pred_main_category": label_ids[best_idx],
                "confidence": round(float(row[best_idx]), 4),
                "top3": [
                    {"category": label_ids[int(index)], "score": round(float(row[index]), 4)}
                    for index in order[:3]
                ],
            }
        )
    return predictions


def qwen_prompt(batch: list[dict[str, Any]], taxonomy: dict[str, list[str]]) -> str:
    taxonomy_json = json.dumps(taxonomy, ensure_ascii=False, separators=(",", ":"))
    batch_json = json.dumps(batch, ensure_ascii=False, separators=(",", ":"))
    return (
        "Classify receipt items. Return strict JSON only, no markdown. "
        "Use merchant as context and raw_name as strongest signal. "
        "main_category must be one taxonomy key; sub_category must be under that key. "
        "If unclear use other/other.unknown. "
        f"Taxonomy={taxonomy_json}\n"
        f"Input={batch_json}\n"
        'Output={"predictions":[{"id":"...","main_category":"...","sub_category":"...","confidence":0.0}]}'
    )


def focused_taxonomy_for_qwen_batch(batch: list[dict[str, Any]], taxonomy: dict[str, list[str]]) -> dict[str, list[str]]:
    focused = []
    for item in batch:
        for category in item.get("candidate_main_categories", []):
            if category in taxonomy:
                focused.append(category)
    focused = list(dict.fromkeys([*focused, "other"])) if focused else list(taxonomy)
    return {category: taxonomy[category] for category in focused}


def parse_qwen_predictions(
    raw_text: str,
    batch: list[dict[str, Any]],
    taxonomy: dict[str, list[str]],
) -> list[dict[str, Any]]:
    sys.path.insert(0, str(REPO_ROOT))
    from scripts.qwen_item_classifier_demo import extract_json

    parsed = extract_json(raw_text)
    raw_predictions = parsed.get("predictions", [])
    by_id = {item.get("id"): item for item in raw_predictions if isinstance(item, dict)}
    predictions = []
    for item in batch:
        raw = by_id.get(item["id"], {})
        pred = raw.get("main_category", "other")
        if pred not in taxonomy:
            pred = "other"
        pred_sub = raw.get("sub_category", "other.unknown")
        if pred_sub not in taxonomy.get(pred, []):
            pred = "other"
            pred_sub = "other.unknown"
        confidence = raw.get("confidence", 0.0)
        confidence = confidence if isinstance(confidence, (int, float)) else 0.0
        predictions.append(
            {
                "id": item["id"],
                "model": "qwen",
                "pred_main_category": pred,
                "pred_sub_category": pred_sub,
                "confidence": round(max(0.0, min(1.0, float(confidence))), 4),
            }
        )
    return predictions


def run_qwen(
    cases: list[dict[str, Any]],
    model_name: str,
    batch_size: int,
    max_new_tokens: int,
) -> list[dict[str, Any]]:
    sys.path.insert(0, str(REPO_ROOT))
    import torch
    from transformers import AutoModelForMultimodalLM, AutoProcessor
    from scripts.qwen_item_classifier_demo import infer_merchant_context, tensor_dict_to_device

    taxonomy = subcategories_by_main(load_taxonomy_summary())
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
            {"role": "user", "content": [{"type": "text", "text": qwen_prompt(batch, focused_taxonomy_for_qwen_batch(batch, taxonomy))}]},
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
        all_predictions.extend(parse_qwen_predictions(raw_text, batch, taxonomy))

    return all_predictions


def main() -> None:
    parser = argparse.ArgumentParser(description="Run item classification benchmark.")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--models",
        default="embedding",
        help=(
            "Comma-separated: embedding,harrier,qwen,legacy_merchant,legacy_merchant_item,"
            "harrier_merchant,harrier_merchant_item,five_way"
        ),
    )
    parser.add_argument("--limit", type=int)
    parser.add_argument("--sample-per-category", type=int)
    parser.add_argument("--embedding-input", choices=["merchant", "merchant_item"], default="merchant")
    parser.add_argument("--harrier-model", default="microsoft/harrier-oss-v1-0.6b")
    parser.add_argument("--harrier-candidate-mode", choices=["merchant_focus", "all"], default="merchant_focus")
    parser.add_argument("--qwen-model", default="Qwen/Qwen3.5-4B")
    parser.add_argument("--qwen-batch-size", type=int, default=10)
    parser.add_argument("--qwen-max-new-tokens", type=int, default=1536)
    args = parser.parse_args()

    started_at = time.time()
    cases = load_cases(args.dataset, args.limit, args.sample_per_category)
    requested_models = [model.strip() for model in args.models.split(",") if model.strip()]
    if "five_way" in requested_models:
        requested_models = [
            "legacy_merchant",
            "legacy_merchant_item",
            "harrier_merchant",
            "harrier_merchant_item",
            "qwen",
        ]
    elif "embedding_four_way" in requested_models:
        requested_models = [
            "legacy_merchant",
            "legacy_merchant_item",
            "harrier_merchant",
            "harrier_merchant_item",
        ]
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

    if "legacy_merchant" in requested_models:
        predictions = run_embedding_baseline(cases, "merchant")
        results["models"]["legacy_embedding_merchant"] = {
            "description": "Legacy SentenceTransformer nearest-centroid classifier with merchant-only input.",
            "input_mode": "merchant",
            **summarize_predictions(cases, predictions),
        }

    if "legacy_merchant_item" in requested_models:
        predictions = run_embedding_baseline(cases, "merchant_item")
        results["models"]["legacy_embedding_merchant_item"] = {
            "description": "Legacy SentenceTransformer nearest-centroid classifier with merchant and item text input.",
            "input_mode": "merchant_item",
            **summarize_predictions(cases, predictions),
        }

    if "harrier" in requested_models:
        harrier_predictions = run_harrier_zero_shot(cases, args.harrier_model, args.harrier_candidate_mode, "merchant_item")
        results["models"]["harrier"] = {
            "description": "Microsoft Harrier embedding model used as a zero-shot classifier against taxonomy main-category descriptions.",
            "harrier_model": args.harrier_model,
            "input_mode": "merchant_item",
            "candidate_mode": args.harrier_candidate_mode,
            **summarize_predictions(cases, harrier_predictions),
        }

    if "harrier_merchant" in requested_models:
        predictions = run_harrier_zero_shot(cases, args.harrier_model, args.harrier_candidate_mode, "merchant")
        results["models"]["harrier_merchant"] = {
            "description": "Microsoft Harrier zero-shot classifier with merchant-only input.",
            "harrier_model": args.harrier_model,
            "input_mode": "merchant",
            "candidate_mode": args.harrier_candidate_mode,
            **summarize_predictions(cases, predictions),
        }

    if "harrier_merchant_item" in requested_models:
        predictions = run_harrier_zero_shot(cases, args.harrier_model, args.harrier_candidate_mode, "merchant_item")
        results["models"]["harrier_merchant_item"] = {
            "description": "Microsoft Harrier zero-shot classifier with merchant and item text input.",
            "harrier_model": args.harrier_model,
            "input_mode": "merchant_item",
            "candidate_mode": args.harrier_candidate_mode,
            **summarize_predictions(cases, predictions),
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
