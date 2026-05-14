"""
Voice input processing via Google Gemini.
Transcribes audio and extracts expense details using function calling.
One expense entry per shopping trip/merchant, with individual items listed.
"""

from datetime import date

import classifier
from config import GEMINI_MODEL, ASK_BELOW


_VOICE_PROMPT = (
    "The user recorded a short voice note describing a purchase. "
    "Call the add_expense function with the details you hear. "
    "Rules:\n"
    "- Use the STORE or MERCHANT name as 'merchant' (e.g. Lidl, Starbucks). "
    "If no store is mentioned, use the item name.\n"
    "- If multiple items are mentioned, list each one in the 'items' array with its name and price.\n"
    "- Set 'total' to the sum of all item prices, or the total explicitly stated.\n"
    "- Default currency is EUR unless another is explicitly mentioned.\n"
    "- Use today's date if no date is mentioned."
)

_ADD_EXPENSE_FUNC = {
    "name": "add_expense",
    "description": "Record a purchase as a single expense with optional line items",
    "parameters": {
        "type": "object",
        "properties": {
            "merchant": {
                "type": "string",
                "description": "The store or merchant name (e.g. Lidl, Starbucks). If no store is mentioned, use the item name.",
            },
            "total": {
                "type": "number",
                "description": "Total amount paid. Sum all item prices if not explicitly stated.",
            },
            "currency": {
                "type": "string",
                "description": "Three-letter ISO currency code (e.g. EUR, USD, GBP)",
            },
            "date": {
                "type": "string",
                "description": "Date of purchase in YYYY-MM-DD format",
            },
            "payment_method": {
                "type": "string",
                "description": "One of: Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer",
            },
            "notes": {
                "type": "string",
                "description": "Any extra context",
            },
            "items": {
                "type": "array",
                "description": "Individual items purchased. One entry per distinct item.",
                "items": {
                    "type": "object",
                    "properties": {
                        "name":  {"type": "string", "description": "Item name"},
                        "price": {"type": "number", "description": "Price of this item"},
                    },
                    "required": ["name"],
                },
            },
        },
        "required": ["merchant"],
    },
}


def process_voice_input(audio_data: bytes, mime_type: str, api_key: str) -> dict:
    """
    Send audio to Gemini, extract expense details via function calling,
    attach a category prediction, and return the structured dict.
    Raises on any error.
    """
    from google import genai
    from google.genai import types

    client     = genai.Client(api_key=api_key)
    audio_part = types.Part.from_bytes(data=audio_data, mime_type=mime_type)
    tool       = types.Tool(function_declarations=[_ADD_EXPENSE_FUNC])

    response = client.models.generate_content(
        model    = GEMINI_MODEL,
        contents = [_VOICE_PROMPT, audio_part],
        config   = types.GenerateContentConfig(tools=[tool]),
    )

    extracted = {}
    for part in response.candidates[0].content.parts:
        if part.function_call:
            extracted = dict(part.function_call.args)
            break

    if not extracted:
        raise ValueError("Gemini could not extract expense details from the audio")

    extracted.setdefault("merchant",       "")
    extracted.setdefault("total",          None)
    extracted.setdefault("currency",       "EUR")
    extracted.setdefault("date",           None)
    extracted.setdefault("payment_method", None)
    extracted.setdefault("notes",          "")
    extracted.setdefault("items",          [])

    # Normalise items to plain dicts (Gemini may return MapComposite objects)
    extracted["items"] = [dict(i) for i in extracted["items"]]

    if not extracted.get("date"):
        extracted["date"] = date.today().isoformat()

    # If total is missing but items have prices, compute it
    if extracted["total"] is None and extracted["items"]:
        prices = [i.get("price") for i in extracted["items"] if i.get("price") is not None]
        if prices:
            extracted["total"] = round(sum(prices), 2)

    merchant = extracted.get("merchant", "")
    if merchant:
        pred, conf, emb, top3 = classifier.do_classify(merchant)
        classifier.embedding_cache[merchant] = emb
        extracted["predicted_category"] = pred
        extracted["confidence"]         = conf
        extracted["needs_review"]       = conf < ASK_BELOW
        extracted["top3"]               = top3
    else:
        extracted["predicted_category"] = "Others"
        extracted["confidence"]         = 0.0
        extracted["needs_review"]       = True
        extracted["top3"]               = []

    extracted["categories"] = list(classifier.centroids.keys()) + ["Others"]
    return extracted
