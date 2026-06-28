#!/usr/bin/env python3
"""Local Qwen item taxonomy smoke test.

Run with:
  conda run -n genai python scripts/qwen_item_classifier_demo.py
"""

from __future__ import annotations

import argparse
import json
import os
import re
import time
from pathlib import Path
from typing import Any

import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor


DEFAULT_MODEL = os.environ.get("QWEN_ITEM_MODEL", "Qwen/Qwen3.5-4B")
DEFAULT_TAXONOMY_PATH = Path(__file__).resolve().parents[1] / "receipt_item_classification_skill.md"
UNKNOWN_CLASSIFICATION = {
    "main_category": "other",
    "sub_category": "other.unknown",
    "tags": ["unknown"],
    "confidence": 0.3,
    "classification_source": "qwen",
}

SAMPLE_PAYLOAD = {
    "merchant": "REWE",
    "currency": "EUR",
    "items": [
        {"raw_name": "MILCH 1.5%", "quantity": 1, "amount": 1.29},
        {"raw_name": "BIO BANANEN", "quantity": 1, "amount": 2.18},
        {"raw_name": "CHIPS PAPRIKA", "quantity": 1, "amount": 2.49},
    ],
}

SAMPLE_EXPENSES = {
    "edeka-magnum": {
        "id": "tx_demo_edeka_magnum",
        "merchant": "edika",
        "date": "2026-06-28",
        "time": "18:42",
        "datetime": "2026-06-28T18:42:00+02:00",
        "timezone": "Europe/Berlin",
        "weekday": 7,
        "hour": 18,
        "amount": 2.79,
        "currency": "EUR",
        "amount_base": 2.79,
        "source": "receipt",
        "type": "expense",
        "created_at": "2026-06-28T18:45:00+02:00",
        "items": [
            {
                "id": "item_demo_magnum",
                "name": "MAGNUM MANDEL",
                "quantity": 1,
                "amount": 2.79,
            }
        ],
    }
}


def extract_markdown_section(text: str, start_heading: str, end_heading: str) -> str:
    start = text.index(start_heading)
    end = text.index(end_heading, start)
    return text[start:end]


def extract_json_array(section: str) -> list[str]:
    match = re.search(r"```json\s*(\[.*?\])\s*```", section, re.DOTALL)
    if not match:
        raise ValueError("Could not find a JSON array in taxonomy section.")
    return json.loads(match.group(1))


def load_taxonomy(path: Path) -> dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    main_categories = extract_json_array(
        extract_markdown_section(text, "## 3. Allowed Main Categories", "## 4. Allowed Taxonomy")
    )
    tags = extract_json_array(extract_markdown_section(text, "## 5. Allowed Tags", "## 6. Decision Rules"))

    taxonomy_section = extract_markdown_section(text, "## 4. Allowed Taxonomy", "## 5. Allowed Tags")
    headings = list(re.finditer(r"^### 4\.\d+ `([^`]+)`.*$", taxonomy_section, re.MULTILINE))
    subcategories_by_main: dict[str, list[str]] = {}
    for index, heading in enumerate(headings):
        main_category = heading.group(1)
        section_start = heading.end()
        section_end = headings[index + 1].start() if index + 1 < len(headings) else len(taxonomy_section)
        subcategories_by_main[main_category] = extract_json_array(taxonomy_section[section_start:section_end])

    return {
        "allowed_main_categories": main_categories,
        "allowed_subcategories_by_main": subcategories_by_main,
        "allowed_tags": tags,
    }


def build_prompt(payload: dict[str, Any], taxonomy: dict[str, Any]) -> str:
    taxonomy_json = json.dumps(taxonomy, ensure_ascii=False, indent=2)
    return f"""
You classify receipt line items for a personal finance app.
Use only the merchant, currency, item names, quantities, and item amounts as receipt context.
Use the taxonomy JSON below only as the allowed classification vocabulary.
Return strict JSON only. Do not include markdown, comments, or explanations.

Hard rules:
- Preserve every input item exactly once and keep raw_name unchanged.
- Do not invent, merge, split, remove, or reorder items.
- normalized_name must be concise English lowercase.
- main_category must be exactly one ID from allowed_main_categories.
- sub_category must be exactly one ID under the selected main_category in allowed_subcategories_by_main.
- tags must contain 1 to 4 values from allowed_tags.
- confidence must be a number from 0 to 1.
- classification_source must always be "qwen".
- Classify item-level categories by item purpose and consumption context, not by merchant type alone.
- Merchant is context only. Do not classify all items as the merchant category.
- If unclear, use main_category "other", sub_category "other.unknown", tags ["unknown"], and confidence <= 0.5.

Boundary rules:
- Groceries means food and drink for home or later consumption.
- Dining means prepared food/drinks served in restaurants, cafes, bars, canteens, delivery, or takeaway contexts.
- Household means non-food home supplies such as cleaning, laundry, paper goods, kitchen supplies, tools, and home maintenance supplies.
- Housing & Utilities means rent, electricity, gas, water, heating, internet, property bills, and housing-related service bills.
- Retail Goods means durable/discretionary retail goods such as clothing, electronics, books, stationery, sports goods, toys, gifts, luxury, and general merchandise.
- Personal Care means hygiene, dental care, hair care, skin care, cosmetics, fragrance, and grooming.
- Health means medicine, supplements, medical devices, pharmacy, doctor/clinic, therapy, and wellness.
- If a food or drink item is served in a restaurant/cafe/bar, classify it under dining.
- If a food or drink item is bought from a supermarket/grocery store for later consumption, classify it under groceries.
- Common supermarket/grocery merchants include REWE, EDEKA/EDIKA, ALDI, Lidl, Netto, Penny, Kaufland, and supermarket-like OCR variants.
- Packaged supermarket ice cream, frozen dessert, frozen pizza, and frozen vegetables should be groceries.frozen_food, not dining.
- Do not classify packaged supermarket food as dining just because it is ready_to_eat, sweet, or a dessert.
- For Amazon/marketplace/payment merchants, classify by item purpose, not as retail_goods by default.

Allowed taxonomy:
{taxonomy_json}

Input:
{json.dumps(payload, ensure_ascii=False, indent=2)}

Output schema:
{{
  "items": [
    {{
      "raw_name": "string",
      "normalized_name": "string",
      "main_category": "string",
      "sub_category": "string",
      "tags": ["string"],
      "confidence": 0.0,
      "classification_source": "qwen"
    }}
  ]
}}
""".strip()


def normalize_text(value: str) -> str:
    return re.sub(r"\s+", " ", value.strip().lower())


def normalize_merchant(value: str) -> str:
    aliases = {
        "edika": "edeka",
    }
    normalized = normalize_text(value)
    return aliases.get(normalized, normalized)


def expense_to_classification_payload(expense: dict[str, Any]) -> dict[str, Any]:
    return {
        "merchant": expense.get("merchant", ""),
        "currency": expense.get("currency", "EUR"),
        "items": [
            {
                "raw_name": item.get("name") or item.get("raw_name") or "",
                "quantity": item.get("quantity") or 1,
                "amount": item.get("amount", item.get("price")),
            }
            for item in expense.get("items", [])
        ],
    }


def build_flo_items(expense: dict[str, Any], classification: dict[str, Any]) -> list[dict[str, Any]]:
    source_items = expense.get("items", [])
    classified_items = classification.get("items", [])
    merchant = expense.get("merchant", "")
    currency = expense.get("currency", "EUR")
    expense_id = expense.get("id")
    records = []

    for index, item in enumerate(source_items):
        classified = classified_items[index] if index < len(classified_items) else {}
        quantity = item.get("quantity") or 1
        amount = item.get("amount", item.get("price"))
        unit_price = round(amount / quantity, 2) if isinstance(amount, (int, float)) and quantity else None
        raw_name = item.get("name") or item.get("raw_name") or classified.get("raw_name") or ""

        records.append(
            {
                "id": item.get("id") or f"{expense_id}_item_{index + 1}",
                "expense_id": expense_id,
                "merchant": merchant,
                "merchant_normalized": normalize_merchant(merchant),
                "raw_name": raw_name,
                "normalized_name": classified.get("normalized_name") or normalize_text(raw_name),
                "unit_price": unit_price,
                "quantity": quantity,
                "amount": amount,
                "currency": currency,
                "amount_base": item.get("amount_base", amount),
                "date": expense.get("date"),
                "time": expense.get("time"),
                "datetime": expense.get("datetime"),
                "timezone": expense.get("timezone"),
                "weekday": expense.get("weekday"),
                "hour": expense.get("hour"),
                "main_category": classified.get("main_category"),
                "sub_category": classified.get("sub_category"),
                "tags": classified.get("tags") or [],
                "confidence": classified.get("confidence"),
                "classification_source": classified.get("classification_source") or "qwen",
                "created_at": expense.get("created_at"),
            }
        )

    return records


def extract_json(text: str) -> dict[str, Any]:
    cleaned = text.strip()
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", cleaned, re.DOTALL)
    if fenced:
        cleaned = fenced.group(1)
    else:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start != -1 and end != -1 and end > start:
            cleaned = cleaned[start : end + 1]
    return json.loads(cleaned)


def clamp_confidence(value: Any, fallback: float = 0.3) -> float:
    if isinstance(value, (int, float)):
        return max(0.0, min(1.0, float(value)))
    return fallback


def fallback_item(raw_name: str) -> dict[str, Any]:
    return {
        "raw_name": raw_name,
        "normalized_name": normalize_text(raw_name),
        **UNKNOWN_CLASSIFICATION,
    }


def sanitize_classification(
    classification: dict[str, Any],
    payload: dict[str, Any],
    taxonomy: dict[str, Any],
) -> dict[str, Any]:
    allowed_main = set(taxonomy["allowed_main_categories"])
    allowed_subcategories = taxonomy["allowed_subcategories_by_main"]
    allowed_tags = set(taxonomy["allowed_tags"])
    source_items = payload.get("items", [])
    classified_items = classification.get("items", [])
    if not isinstance(classified_items, list):
        classified_items = []

    sanitized_items = []
    for index, source_item in enumerate(source_items):
        raw_name = source_item.get("raw_name") or source_item.get("name") or ""
        classified = classified_items[index] if index < len(classified_items) and isinstance(classified_items[index], dict) else {}
        normalized_name = classified.get("normalized_name")
        if not isinstance(normalized_name, str) or not normalized_name.strip():
            normalized_name = normalize_text(raw_name)

        main_category = classified.get("main_category")
        sub_category = classified.get("sub_category")
        category_valid = (
            main_category in allowed_main
            and sub_category in allowed_subcategories.get(main_category, [])
            and classified.get("raw_name") == raw_name
        )
        if not category_valid:
            sanitized_items.append(fallback_item(raw_name))
            continue

        raw_tags = classified.get("tags", [])
        if not isinstance(raw_tags, list):
            raw_tags = []
        tags = [tag for tag in raw_tags if isinstance(tag, str) and tag in allowed_tags][:4]
        if not tags:
            tags = ["unknown"]

        sanitized_items.append(
            {
                "raw_name": raw_name,
                "normalized_name": normalize_text(normalized_name),
                "main_category": main_category,
                "sub_category": sub_category,
                "tags": tags,
                "confidence": clamp_confidence(classified.get("confidence")),
                "classification_source": "qwen",
            }
        )

    return {"items": sanitized_items}


def tensor_dict_to_device(inputs: dict[str, Any], device: torch.device) -> dict[str, Any]:
    moved = {}
    for key, value in inputs.items():
        moved[key] = value.to(device) if hasattr(value, "to") else value
    return moved


def main() -> None:
    parser = argparse.ArgumentParser(description="Classify receipt items with local Qwen.")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--payload", help="Path to JSON payload. Defaults to a REWE sample.")
    parser.add_argument(
        "--taxonomy",
        default=str(DEFAULT_TAXONOMY_PATH),
        help="Path to receipt item classification skill markdown.",
    )
    parser.add_argument(
        "--sample",
        choices=sorted(SAMPLE_EXPENSES),
        help="Use a built-in transaction sample and output flo_items records.",
    )
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--raw", action="store_true", help="Print raw model text before parsed JSON.")
    parser.add_argument("--flo-items", action="store_true", help="Print flo_items records after classification.")
    parser.add_argument("--print-prompt", action="store_true", help="Print the Qwen prompt and exit before loading model.")
    args = parser.parse_args()

    expense = SAMPLE_EXPENSES.get(args.sample) if args.sample else None
    payload = expense_to_classification_payload(expense) if expense else SAMPLE_PAYLOAD
    if args.payload:
        with open(args.payload, "r", encoding="utf-8") as f:
            payload = json.load(f)
        expense = None

    taxonomy = load_taxonomy(Path(args.taxonomy))
    prompt = build_prompt(payload, taxonomy)
    if args.print_prompt:
        print(prompt)
        return

    if torch.backends.mps.is_available():
        device = torch.device("mps")
        dtype = torch.float16
    else:
        device = torch.device("cpu")
        dtype = torch.float32

    started_at = time.time()
    subcategory_count = sum(len(value) for value in taxonomy["allowed_subcategories_by_main"].values())
    print(
        f"Loaded taxonomy from {args.taxonomy}: "
        f"{len(taxonomy['allowed_main_categories'])} main categories, "
        f"{subcategory_count} subcategories, {len(taxonomy['allowed_tags'])} tags.",
        flush=True,
    )
    print(f"Loading {args.model} on {device} with {dtype}...", flush=True)
    print("Loading processor...", flush=True)
    processor = AutoProcessor.from_pretrained(args.model, trust_remote_code=True)
    print(f"Processor loaded in {time.time() - started_at:.1f}s.", flush=True)
    print("Loading model weights...", flush=True)
    model = AutoModelForMultimodalLM.from_pretrained(
        args.model,
        dtype=dtype,
        low_cpu_mem_usage=True,
        trust_remote_code=True,
    )
    print(f"Model weights loaded in {time.time() - started_at:.1f}s.", flush=True)
    print(f"Moving model to {device}...", flush=True)
    model.to(device)
    model.eval()
    print(f"Model ready in {time.time() - started_at:.1f}s.", flush=True)

    messages = [
        {
            "role": "system",
            "content": [
                {
                    "type": "text",
                    "text": "You are a JSON API. Return only valid JSON. Do not show thinking, analysis, markdown, or explanations.",
                },
            ],
        },
        {
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
            ],
        }
    ]
    chat_template_kwargs = {
        "add_generation_prompt": True,
        "tokenize": True,
        "return_dict": True,
        "return_tensors": "pt",
    }
    try:
        inputs = processor.apply_chat_template(
            messages,
            enable_thinking=False,
            **chat_template_kwargs,
        )
    except TypeError:
        inputs = processor.apply_chat_template(messages, **chat_template_kwargs)
    inputs = tensor_dict_to_device(inputs, device)
    print("Generating classification JSON...", flush=True)

    with torch.inference_mode():
        outputs = model.generate(
            **inputs,
            max_new_tokens=args.max_new_tokens,
            do_sample=False,
        )
    print(f"Generation completed in {time.time() - started_at:.1f}s.", flush=True)

    prompt_tokens = inputs["input_ids"].shape[-1]
    raw_text = processor.decode(outputs[0][prompt_tokens:], skip_special_tokens=True).strip()
    if args.raw:
        print("\nRaw model output:\n")
        print(raw_text)
        print("\nParsed JSON:\n")

    parsed = sanitize_classification(extract_json(raw_text), payload, taxonomy)

    if args.flo_items:
        if not expense:
            raise SystemExit("--flo-items requires --sample for this demo.")
        print(json.dumps(build_flo_items(expense, parsed), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(parsed, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
