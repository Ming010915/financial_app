"""
Flo — Monthly Spending Summaries
Handles vector storage, similarity retrieval, and AI-generated overviews.
 
No side effects on import. All stateful operations are explicit function calls.
"""
 
from __future__ import annotations

import re

import numpy as np

from config import GEMINI_MODELS, get_genai_client
from services.gemini_utils import generate_with_fallback
from services.prompts import build_overview_prompt


import services.classifier as classifier   # for dynamic category list

# ── Helpers ───────────────────────────────────────────────────────────────────

_MONEY_RE = re.compile(r"(?:€|EUR)\s?(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s?(?:€|EUR)")


def _numbers_grounded(text: str, pool: set[float], tol: float = 1.5) -> bool:
    """True if every € / EUR figure mentioned in `text` is close to something
    derivable from the trusted input data (`pool`). A post-generation
    safety net against prompt injection that gets the model to echo a
    fabricated figure planted in retrieved (untrusted) history/budget text —
    the prompt-level defense in build_overview_prompt catches most of this,
    but LLM outputs aren't fully deterministic, so this check gives a hard
    guarantee independent of prompt wording."""
    for m in _MONEY_RE.finditer(text):
        raw = (m.group(1) or m.group(2)).replace(",", ".")
        val = float(raw)
        if not any(abs(val - p) <= tol for p in pool):
            return False
    return True


def _grounded_pool(current_text: str, historical_context: str, budget_context: str) -> set[float]:
    pool: set[float] = set()
    for text in (current_text, historical_context, budget_context):
        for m in re.findall(r"\d+(?:[.,]\d+)?", text or ""):
            pool.add(round(float(m.replace(",", ".")), 2))
    # Legitimate summaries routinely state a *derived* figure (a sum, a
    # difference, a percentage) rather than a number printed verbatim in the
    # input — allow pairwise sums/differences so those aren't flagged.
    base = set(pool)
    for a in base:
        for b in base:
            pool.add(round(abs(a - b), 2))
            pool.add(round(a + b, 2))
    return pool


def _fallback_overview(current_text: str) -> str:
    """Deterministic, no-LLM-call summary built only from trusted current-
    spending figures. Used as a last resort if the model still produces an
    ungrounded number after one retry, so a fabricated/injected figure can
    never actually reach the user."""
    lines = [l for l in current_text.strip().splitlines() if l.strip()]
    if not lines:
        return "No spending recorded yet this month."
    total = 0.0
    for line in lines:
        m = re.search(r"[\d.,]+$", line.strip())
        if m:
            total += float(m.group().replace(",", "."))
    return (
        f"This month you've spent {total:.2f} EUR across {len(lines)} "
        f"categor{'y' if len(lines) == 1 else 'ies'}: "
        + ", ".join(l.strip() for l in lines) + "."
    )

def _category_list() -> list[str]:
    return list(classifier.centroids.keys())
 
def _make_numerical_vector(spending: dict[str, float]) -> list[float]:
    cats   = _category_list()
    vector = np.array([spending.get(cat, 0.0) for cat in cats], dtype=float)
    norm   = np.linalg.norm(vector)
    if norm == 0.0:
        return vector.tolist()
    return (vector / norm).tolist()
 
def project_to_full_month(spending: dict[str, float], days_elapsed: int, days_in_month: int) -> dict[str, float]:
    if days_elapsed <= 0:
        raise ValueError("days_elapsed must be > 0")
    scale = days_in_month / days_elapsed
    return {cat: round(amount * scale, 2) for cat, amount in spending.items()}
 

 # ── Public API ────────────────────────────────────────────────────────────────  
def generate_overview(
    current_text: str,
    retrieved_summaries: list[dict[str, str]],
    budget_context: str = "No budgets set.",
    api_key: str = "",
) -> str:
    historical_context = "\n".join(
        f"- {s['period']}: {s['text']}" for s in retrieved_summaries
    ) or "No historical data available yet."

    prompt = build_overview_prompt(current_text, historical_context, budget_context)

    client = get_genai_client()
    pool   = _grounded_pool(current_text, historical_context, budget_context)

    def _call(p):
        response = generate_with_fallback(
            lambda model: client.models.generate_content(model=model, contents=p),
            GEMINI_MODELS,
        )
        return response.text

    overview = _call(prompt)
    if _numbers_grounded(overview, pool):
        return overview

    # The prompt-level defense (build_overview_prompt) usually stops a
    # fabricated figure from being echoed, but LLM sampling isn't fully
    # deterministic — retry once with a stricter, explicit instruction before
    # falling back to a number-free, no-LLM-call summary.
    retry_prompt = prompt + (
        "\n\nYour previous answer included a € figure that could not be "
        "verified against the data blocks above. Regenerate the summary "
        "using ONLY numbers that appear in (or are simple sums/differences "
        "of) the data blocks above — mention fewer specifics rather than "
        "include any number you are not fully certain is genuine."
    )
    overview = _call(retry_prompt)
    if _numbers_grounded(overview, pool):
        return overview

    return _fallback_overview(current_text)