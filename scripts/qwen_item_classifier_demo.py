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
from typing import Any

import torch
from transformers import AutoModelForMultimodalLM, AutoProcessor


DEFAULT_MODEL = os.environ.get("QWEN_ITEM_MODEL", "Qwen/Qwen3.5-4B")

SAMPLE_PAYLOAD = {
    "merchant": "REWE",
    "transaction_category": "Groceries",
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
        "category": "Groceries",
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


def build_prompt(payload: dict[str, Any]) -> str:
    return f"""
You classify receipt line items for a personal finance app.
Use the merchant and transaction category as context.
Return strict JSON only. Do not include markdown or explanation.

Rules:
- Preserve every input item exactly once and keep raw_name unchanged.
- Do not invent items.
- normalized_name must be concise English lowercase.
- main_category should usually match transaction_category unless clearly wrong.
- sub_category should be specific, for example Dairy, Bakery, Snacks, Drinks, Produce, Meat, Household, Personal Care, Pet Supplies, Transport, Fees, Other.
- tags must contain 1 to 4 lowercase semantic tags.
- confidence must be a number from 0 to 1.
- classification_source must be "qwen".

Input:
{json.dumps(payload, ensure_ascii=False, indent=2)}

Output schema:
{{
  "items": [
    {{
      "raw_name": "string",
      "normalized_name": "string",
      "main_category": "string",
      "sub_category": "string|null",
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
        "transaction_category": expense.get("category", ""),
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
                "main_category": classified.get("main_category") or expense.get("category"),
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
        "--sample",
        choices=sorted(SAMPLE_EXPENSES),
        help="Use a built-in transaction sample and output flo_items records.",
    )
    parser.add_argument("--max-new-tokens", type=int, default=512)
    parser.add_argument("--raw", action="store_true", help="Print raw model text before parsed JSON.")
    parser.add_argument("--flo-items", action="store_true", help="Print flo_items records after classification.")
    args = parser.parse_args()

    expense = SAMPLE_EXPENSES.get(args.sample) if args.sample else None
    payload = expense_to_classification_payload(expense) if expense else SAMPLE_PAYLOAD
    if args.payload:
        with open(args.payload, "r", encoding="utf-8") as f:
            payload = json.load(f)
        expense = None

    if torch.backends.mps.is_available():
        device = torch.device("mps")
        dtype = torch.float16
    else:
        device = torch.device("cpu")
        dtype = torch.float32

    started_at = time.time()
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
                {"type": "text", "text": build_prompt(payload)},
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

    parsed = extract_json(raw_text)

    if args.flo_items:
        if not expense:
            raise SystemExit("--flo-items requires --sample for this demo.")
        print(json.dumps(build_flo_items(expense, parsed), ensure_ascii=False, indent=2))
    else:
        print(json.dumps(parsed, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
