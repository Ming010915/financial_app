# import numpy as np
# import chromadb
# import google.generativeai as genai
# import os
# from sklearn.preprocessing import normalize


# genai.configure(api_key="AIzaSyCsONxjn_O6OaiXiRY8pzpxpg8btBD7GR4")
# gemini_model = genai.GenerativeModel("gemini-3-flash-preview")

# # Fixed category list — order matters, must stay consistent
# CATEGORIES = ["Groceries", "Dining Out", "Transport", "Nights Out", "Clothing", "University Supplies"]

# client = chromadb.PersistentClient(path="./flo_db")

# # Delete old collection if it exists
# try:
#     client.delete_collection(name="monthly_summaries")
# except:
#     pass

# collection = client.get_or_create_collection(name="monthly_summaries")


# def make_numerical_vector(spending: dict) -> list[float]:
#     """Convert a spending dict into a normalised numerical vector."""
#     vector = np.array([spending.get(cat, 0.0) for cat in CATEGORIES], dtype=float)
#     normed = normalize([vector])[0]  # normalise to unit length for cosine similarity
#     return normed.tolist()


# def project_to_full_month(spending: dict, days_elapsed: int, days_in_month: int) -> dict:
#     """Scale mid-month spending to a full-month projection."""
#     scale = days_in_month / days_elapsed
#     return {cat: round(amount * scale, 2) for cat, amount in spending.items()}


# def store_summary(period: str, text: str, spending: dict) -> None:
#     """Embed and store a completed monthly summary."""
#     vector = make_numerical_vector(spending)
#     collection.upsert(
#         ids=[period],
#         documents=[text],
#         embeddings=[vector]
#     )
#     print(f"Stored summary for {period}.")


# def retrieve_similar_summaries(spending: dict, days_elapsed: int, days_in_month: int, n_results: int = 2) -> list[dict]:
#     """Project current month to full month, then retrieve similar historical summaries."""
#     projected = project_to_full_month(spending, days_elapsed, days_in_month)
#     vector = make_numerical_vector(projected)
#     results = collection.query(
#         query_embeddings=[vector],
#         n_results=n_results
#     )
#     return [
#         {"period": id, "text": document}
#         for id, document in zip(results["ids"][0], results["documents"][0])
#     ]


# def generate_spending_overview(current_text: str, retrieved_summaries: list[dict]) -> str:
#     """Generate a natural language overview using Gemini."""
#     historical_context = "\n".join([
#         f"- {s['period']}: {s['text']}"
#         for s in retrieved_summaries
#     ])

#     prompt = f"""You are a friendly personal finance assistant helping a university student 
# understand their spending habits.

# Here is the user's spending so far this month:
# {current_text}

# Here is relevant historical context from similar past months:
# {historical_context}

# Write a concise, friendly overview of the user's spending this month compared to their 
# history. Highlight anything notable — both positive and negative. Keep it to 3-4 sentences."""

#     response = gemini_model.generate_content(prompt)
#     return response.text


# # --- Store historical summaries ---

# store_summary(
#     period="March 2026",
#     text="March 2026: Groceries €180, Dining Out €140, Transport €52, Nights Out €65, University Supplies €23. Total €460.",
#     spending={"Groceries": 180, "Dining Out": 140, "Transport": 52, "Nights Out": 65, "University Supplies": 23}
# )

# store_summary(
#     period="November 2025",
#     text="November 2025: Groceries €165, Dining Out €95, Transport €48, Nights Out €110, Clothing €89, University Supplies €45. Total €552.",
#     spending={"Groceries": 165, "Dining Out": 95, "Transport": 48, "Nights Out": 110, "Clothing": 89, "University Supplies": 45}
# )

# # --- Current month (mid-month) ---

# current_spending = {"Groceries": 120, "Dining Out": 110, "Transport": 48, "Nights Out": 80}
# current_text = "April 2026 (so far, day 14): Groceries €120, Dining Out €110, Transport €48, Nights Out €80. Total €358."

# retrieved = retrieve_similar_summaries(
#     spending=current_spending,
#     days_elapsed=14,
#     days_in_month=30,
#     n_results=2
# )

# overview = generate_spending_overview(current_text, retrieved)
# print(overview)


# """
# Flo — Monthly Spending Summaries
# Handles vector storage, similarity retrieval, and AI-generated overviews.
 
# No side effects on import. All stateful operations are explicit function calls.
# """
 
# from __future__ import annotations
 
# import os
# import threading
# from typing import Optional
 
# import numpy as np
# from sklearn.preprocessing import normalize
 
# import classifier  # for dynamic category list

# # ── Lazy ChromaDB singleton ───────────────────────────────────────────────────
 
# _client     = None
# _collection = None
# _lock       = threading.Lock()
 
 
# def _get_collection():
#     """Return the ChromaDB collection, initialising it once on first call."""
#     global _client, _collection
#     if _collection is not None:
#         return _collection
#     with _lock:
#         if _collection is not None:          # double-checked locking
#             return _collection
#         import chromadb
#         from config import CHROMA_DB_PATH
#         _client     = chromadb.PersistentClient(path=CHROMA_DB_PATH)
#         _collection = _client.get_or_create_collection(name="monthly_summaries")
#     return _collection

 
# # ── Helpers ───────────────────────────────────────────────────────────────────
 
# def _category_list() -> list[str]:
#     """Live category list sourced from the classifier (excludes 'Others')."""
#     return list(classifier.centroids.keys())
 
 
# def _make_numerical_vector(spending: dict[str, float]) -> list[float]:
#     """
#     Convert a {category: amount} dict into a unit-length numerical vector.
#     Categories not present in the classifier are ignored.
#     Zero vectors (no spending data) are returned as-is.
#     """
#     cats   = _category_list()
#     vector = np.array([spending.get(cat, 0.0) for cat in cats], dtype=float)
#     norm   = np.linalg.norm(vector)
#     if norm == 0.0:
#         return vector.tolist()
#     return (vector / norm).tolist()
 
 
# def project_to_full_month(
#     spending: dict[str, float],
#     days_elapsed: int,
#     days_in_month: int,
# ) -> dict[str, float]:
#     """Scale partial-month spending to a full-month projection."""
#     if days_elapsed <= 0:
#         raise ValueError("days_elapsed must be > 0")
#     scale = days_in_month / days_elapsed
#     return {cat: round(amount * scale, 2) for cat, amount in spending.items()}
 
#  # ── Public API ────────────────────────────────────────────────────────────────
 
# def store_summary(period: str, text: str, spending: dict[str, float]) -> None:
#     """
#     Embed and persist a completed monthly summary.
 
#     Args:
#         period:   Human-readable label, e.g. "March 2026". Used as the record ID.
#         text:     Plain-text narrative stored alongside the vector for retrieval.
#         spending: {category: amount} dict for the full month.
#     """
#     vector = _make_numerical_vector(spending)
#     _get_collection().upsert(
#         ids        = [period],
#         documents  = [text],
#         embeddings = [vector],
#     )
 
 
# def retrieve_similar_summaries(
#     spending: dict[str, float],
#     days_elapsed: int,
#     days_in_month: int,
#     n_results: int = 2,
# ) -> list[dict[str, str]]:
#     """
#     Project current partial-month spending to a full month, then return
#     the most similar historical summaries from the vector store.
 
#     Returns a list of {"period": ..., "text": ...} dicts.
#     """
#     col = _get_collection()
 
#     # ChromaDB raises if we ask for more results than records stored
#     stored_count = col.count()
#     if stored_count == 0:
#         return []
#     n = min(n_results, stored_count)
 
#     projected = project_to_full_month(spending, days_elapsed, days_in_month)
#     vector    = _make_numerical_vector(projected)
 
#     results = col.query(query_embeddings=[vector], n_results=n)
#     return [
#         {"period": id_, "text": doc}
#         for id_, doc in zip(results["ids"][0], results["documents"][0])
#     ]
 
 
# def generate_overview(
#     current_text: str,
#     retrieved_summaries: list[dict[str, str]],
#     api_key: str,
# ) -> str:
#     """
#     Call Gemini to produce a 3-4 sentence natural-language spending overview.
 
#     Args:
#         current_text:        Plain-text description of spending so far this month.
#         retrieved_summaries: Output of retrieve_similar_summaries().
#         api_key:             Google API key (never hard-coded; passed by the caller).
 
#     Returns:
#         The model's response text.
 
#     Raises:
#         Any exception from the Gemini SDK is propagated to the caller.
#     """
#     from google import genai
#     from config import GEMINI_MODEL
 
#     historical_context = "\n".join(
#         f"- {s['period']}: {s['text']}" for s in retrieved_summaries
#     ) or "No historical data available yet."
 
#     prompt = (
#         "You are a friendly personal finance assistant helping a university student "
#         "understand their spending habits.\n\n"
#         f"Here is the user's spending so far this month:\n{current_text}\n\n"
#         "Here is relevant historical context from similar past months:\n"
#         f"{historical_context}\n\n"
#         "Write a concise, friendly overview of the user's spending this month compared "
#         "to their history. Highlight anything notable — both positive and negative. "
#         "Keep it to 3-4 sentences."
#     )
 
#     client   = genai.Client(api_key=api_key)
#     response = client.models.generate_content(model=GEMINI_MODEL, contents=prompt)
#     return response.text