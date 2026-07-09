"""
Analyses a filled-in UAT response CSV (see docs/UAT_PLAN.md and
tests/data/uat_responses_template.csv) into per-question and per-section
summary statistics, task completion rates, and NPS — then writes
tests/results/uat_summary.json so it slots in alongside the automated eval
results for the final report and the results slide.

Usage:
    python tests/analyze_uat_results.py path/to/filled_responses.csv
"""

from __future__ import annotations

import csv
import statistics
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from tests.helpers import save_result  # noqa: E402

LIKERT_COLUMNS = {
    "A": ["A1", "A2", "A3"],
    "B": ["B4", "B5", "B6", "B7", "B8", "B9"],
    "C10": ["C10"],
    "C12": ["C12"],
}
TASK_COLUMNS = [f"task{i}_status" for i in range(1, 9)]


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def analyze(csv_path: str) -> dict:
    rows = list(csv.DictReader(open(csv_path)))
    rows = [r for r in rows if any(_to_float(r.get(c)) is not None for c in LIKERT_COLUMNS["A"])]
    if not rows:
        raise ValueError("No filled-in responses found — is the CSV still just the empty template?")

    def section_stats(cols):
        vals = [_to_float(r[c]) for r in rows for c in cols if _to_float(r.get(c)) is not None]
        return {
            "n": len(vals),
            "mean": round(statistics.mean(vals), 2) if vals else None,
            "stdev": round(statistics.stdev(vals), 2) if len(vals) > 1 else 0.0,
        }

    per_question = {}
    for cols in LIKERT_COLUMNS.values():
        for c in cols:
            per_question[c] = section_stats([c])

    section_summary = {
        "core_usability_A": section_stats(LIKERT_COLUMNS["A"]),
        "ai_trust_B": section_stats(LIKERT_COLUMNS["B"]),
        "would_use_daily_C10": section_stats(LIKERT_COLUMNS["C10"]),
        "overall_satisfaction_C12": section_stats(LIKERT_COLUMNS["C12"]),
    }

    nps_vals = [_to_float(r.get("NPS")) for r in rows if _to_float(r.get("NPS")) is not None]
    nps = None
    if nps_vals:
        promoters = sum(1 for v in nps_vals if v >= 9)
        detractors = sum(1 for v in nps_vals if v <= 6)
        nps = round((promoters - detractors) / len(nps_vals) * 100, 1)

    task_completion = {}
    for col in TASK_COLUMNS:
        vals = [r.get(col, "").strip().lower() for r in rows if r.get(col, "").strip()]
        if not vals:
            continue
        unaided = sum(1 for v in vals if v in ("unaided", "completed", "pass", "ok"))
        task_completion[col] = {
            "n": len(vals),
            "unaided_rate": round(unaided / len(vals), 3),
            "raw_counts": {v: vals.count(v) for v in set(vals)},
        }

    result = {
        "n_participants": len(rows),
        "per_question": per_question,
        "section_summary": section_summary,
        "nps": nps,
        "task_completion": task_completion,
        "acceptance_criteria_check": {
            "core_usability_A_meets_4.0": (section_summary["core_usability_A"]["mean"] or 0) >= 4.0,
            "ai_trust_B_meets_3.5": (section_summary["ai_trust_B"]["mean"] or 0) >= 3.5,
            "would_use_daily_meets_3.5": (section_summary["would_use_daily_C10"]["mean"] or 0) >= 3.5,
            "nps_non_negative": (nps or 0) >= 0,
        },
    }
    return result


def main():
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(1)
    result = analyze(sys.argv[1])
    path = save_result("uat_summary", result)
    print(f"Wrote {path}\n")
    print(f"Participants: {result['n_participants']}")
    for name, stats in result["section_summary"].items():
        print(f"  {name}: mean={stats['mean']} (n={stats['n']}, sd={stats['stdev']})")
    print(f"  NPS: {result['nps']}")
    print("\nAcceptance criteria:")
    for k, v in result["acceptance_criteria_check"].items():
        print(f"  [{'PASS' if v else 'FAIL'}] {k}")


if __name__ == "__main__":
    main()
