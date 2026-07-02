#!/usr/bin/env python3
"""Build the merchant-only transaction classification benchmark CSV."""

from __future__ import annotations

import argparse
import csv
import json
from collections import Counter
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_SOURCE = REPO_ROOT / "dataset" / "student_germany_finance_2025_2026.json"
DEFAULT_OUTPUT = REPO_ROOT / "benchmarks" / "transaction_classification_benchmark.csv"

OLD_10_CATEGORY_MAP = {
    "Dining": ("Food & Beverage", "prepared food and drinks"),
    "Groceries": ("Groceries", "supermarket and grocery merchant"),
    "Subscriptions": ("Entertainment & Subscriptions", "subscription or recurring entertainment service"),
    "Entertainment": ("Entertainment & Subscriptions", "leisure or entertainment merchant"),
    "Transport": ("Transport", "daily mobility"),
    "Travel": ("Transport", "old taxonomy has no travel class; mapped to transport"),
    "Health": ("Health & Wellness", "health, pharmacy, fitness, or wellness"),
    "Utilities": ("Home & Living", "old taxonomy has no utilities class; mapped to home and living"),
    "Housing": ("Home & Living", "old taxonomy has no housing class; mapped to home and living"),
    "Shopping": ("Shopping", "general retail"),
    "Electronics": ("Shopping", "electronics are retail goods in the old taxonomy"),
    "Personal Care": ("Personal Care", "personal care merchant"),
    "Insurance": ("Banking & Fees", "old taxonomy has no insurance class; mapped to financial/admin fees"),
}

EXCLUDED_CATEGORIES = {
    "Allowance": "income row, not an expense classification target",
    "Education": "old taxonomy has no clean education/work class",
    "Other": "ambiguous catch-all source label",
}


def build_rows(source_rows: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], Counter[str]]:
    benchmark_rows = []
    excluded: Counter[str] = Counter()

    for row in source_rows:
        source_category = row.get("category", "")
        mapped = OLD_10_CATEGORY_MAP.get(source_category)
        if not mapped:
            excluded[source_category] += 1
            continue
        gold_category, mapping_note = mapped
        benchmark_rows.append(
            {
                "id": row.get("id", ""),
                "date": row.get("date", ""),
                "merchant": row.get("merchant", ""),
                "amount": row.get("amount", ""),
                "currency": row.get("currency", ""),
                "source": row.get("source", ""),
                "type": row.get("type", ""),
                "original_category": source_category,
                "gold_category": gold_category,
                "mapping_note": mapping_note,
            }
        )

    return benchmark_rows, excluded


def main() -> None:
    parser = argparse.ArgumentParser(description="Build the transaction classification benchmark CSV.")
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    args = parser.parse_args()

    source_rows = json.loads(args.source.read_text(encoding="utf-8"))
    benchmark_rows, excluded = build_rows(source_rows)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "id",
        "date",
        "merchant",
        "amount",
        "currency",
        "source",
        "type",
        "original_category",
        "gold_category",
        "mapping_note",
    ]
    with args.output.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(benchmark_rows)

    summary = {
        "source": str(args.source.relative_to(REPO_ROOT) if args.source.is_relative_to(REPO_ROOT) else args.source),
        "output": str(args.output.relative_to(REPO_ROOT) if args.output.is_relative_to(REPO_ROOT) else args.output),
        "source_rows": len(source_rows),
        "benchmark_rows": len(benchmark_rows),
        "gold_distribution": dict(Counter(row["gold_category"] for row in benchmark_rows).most_common()),
        "excluded_rows": sum(excluded.values()),
        "excluded_by_category": dict(excluded),
        "excluded_category_notes": EXCLUDED_CATEGORIES,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
