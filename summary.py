import numpy as np
import chromadb
import google.generativeai as genai
import os
from sklearn.preprocessing import normalize


genai.configure(api_key="AIzaSyCsONxjn_O6OaiXiRY8pzpxpg8btBD7GR4")
gemini_model = genai.GenerativeModel("gemini-3-flash-preview")

# Fixed category list — order matters, must stay consistent
CATEGORIES = ["Groceries", "Dining Out", "Transport", "Nights Out", "Clothing", "University Supplies"]

client = chromadb.PersistentClient(path="./flo_db")

# Delete old collection if it exists
try:
    client.delete_collection(name="monthly_summaries")
except:
    pass

collection = client.get_or_create_collection(name="monthly_summaries")


def make_numerical_vector(spending: dict) -> list[float]:
    """Convert a spending dict into a normalised numerical vector."""
    vector = np.array([spending.get(cat, 0.0) for cat in CATEGORIES], dtype=float)
    normed = normalize([vector])[0]  # normalise to unit length for cosine similarity
    return normed.tolist()


def project_to_full_month(spending: dict, days_elapsed: int, days_in_month: int) -> dict:
    """Scale mid-month spending to a full-month projection."""
    scale = days_in_month / days_elapsed
    return {cat: round(amount * scale, 2) for cat, amount in spending.items()}


def store_summary(period: str, text: str, spending: dict) -> None:
    """Embed and store a completed monthly summary."""
    vector = make_numerical_vector(spending)
    collection.upsert(
        ids=[period],
        documents=[text],
        embeddings=[vector]
    )
    print(f"Stored summary for {period}.")


def retrieve_similar_summaries(spending: dict, days_elapsed: int, days_in_month: int, n_results: int = 2) -> list[dict]:
    """Project current month to full month, then retrieve similar historical summaries."""
    projected = project_to_full_month(spending, days_elapsed, days_in_month)
    vector = make_numerical_vector(projected)
    results = collection.query(
        query_embeddings=[vector],
        n_results=n_results
    )
    return [
        {"period": id, "text": document}
        for id, document in zip(results["ids"][0], results["documents"][0])
    ]


def generate_spending_overview(current_text: str, retrieved_summaries: list[dict]) -> str:
    """Generate a natural language overview using Gemini."""
    historical_context = "\n".join([
        f"- {s['period']}: {s['text']}"
        for s in retrieved_summaries
    ])

    prompt = f"""You are a friendly personal finance assistant helping a university student 
understand their spending habits.

Here is the user's spending so far this month:
{current_text}

Here is relevant historical context from similar past months:
{historical_context}

Write a concise, friendly overview of the user's spending this month compared to their 
history. Highlight anything notable — both positive and negative. Keep it to 3-4 sentences."""

    response = gemini_model.generate_content(prompt)
    return response.text


# --- Store historical summaries ---

store_summary(
    period="March 2026",
    text="March 2026: Groceries €180, Dining Out €140, Transport €52, Nights Out €65, University Supplies €23. Total €460.",
    spending={"Groceries": 180, "Dining Out": 140, "Transport": 52, "Nights Out": 65, "University Supplies": 23}
)

store_summary(
    period="November 2025",
    text="November 2025: Groceries €165, Dining Out €95, Transport €48, Nights Out €110, Clothing €89, University Supplies €45. Total €552.",
    spending={"Groceries": 165, "Dining Out": 95, "Transport": 48, "Nights Out": 110, "Clothing": 89, "University Supplies": 45}
)

# --- Current month (mid-month) ---

current_spending = {"Groceries": 120, "Dining Out": 110, "Transport": 48, "Nights Out": 80}
current_text = "April 2026 (so far, day 14): Groceries €120, Dining Out €110, Transport €48, Nights Out €80. Total €358."

retrieved = retrieve_similar_summaries(
    spending=current_spending,
    days_elapsed=14,
    days_in_month=30,
    n_results=2
)

overview = generate_spending_overview(current_text, retrieved)
print(overview)