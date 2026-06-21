"""
Flo — Monthly Spending Summaries
Handles vector storage, similarity retrieval, and AI-generated overviews.
 
No side effects on import. All stateful operations are explicit function calls.
"""
 
from __future__ import annotations
 
import numpy as np

from config import GEMINI_MODELS, get_genai_client
from services.gemini_utils import generate_with_fallback
from services.prompts import build_overview_prompt

 
import services.classifier as classifier   # for dynamic category list

# ── Helpers ───────────────────────────────────────────────────────────────────
 
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
def generate_overview(current_text: str, retrieved_summaries: list[dict[str, str]], api_key: str = "") -> str:
    historical_context = "\n".join(
        f"- {s['period']}: {s['text']}" for s in retrieved_summaries
    ) or "No historical data available yet."

    prompt = build_overview_prompt(current_text, historical_context)
 
    client   = get_genai_client()
    response = generate_with_fallback(
        lambda model: client.models.generate_content(model=model, contents=prompt),
        GEMINI_MODELS,
    )
    return response.text