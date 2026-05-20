"""
Receipt scanning via Google Gemini.
Depends on classifier for merchant prediction after OCR.
"""

import json
from datetime import date

from services import classifier
from config import GEMINI_MODEL, ASK_BELOW


def extract_json_from_text(text: str) -> dict:
    """Pull the first valid JSON object out of a (possibly markdown-wrapped) string."""
    text = text.strip()
    if "```" in text:
        for block in text.split("```"):
            block = block.strip()
            if block.lower().startswith("json"):
                block = block[4:].strip()
            if block.startswith("{"):
                try:
                    return json.loads(block)
                except json.JSONDecodeError:
                    pass
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    start = text.find("{")
    if start >= 0:
        depth = 0
        for i, c in enumerate(text[start:], start):
            if c == "{":
                depth += 1
            elif c == "}":
                depth -= 1
                if depth == 0:
                    try:
                        return json.loads(text[start:i + 1])
                    except json.JSONDecodeError:
                        break
    return {}


_RECEIPT_PROMPT = (
    "Analyze this receipt image and extract the information. "
    "Return ONLY a valid JSON object (no markdown, no explanation) with exactly these fields:\n"
    '{"merchant": "store or restaurant name", '
    '"date": "YYYY-MM-DD if visible else null", '
    '"total": numeric_total_or_null, '
    '"currency": "currency code e.g. EUR USD GBP", '
    '"payment_method": "one of: Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer — or null if not visible", '
    '"items": [{"name": "item name", "price": numeric_or_null}], '
    '"notes": "any other relevant info or null"}\n'
    "Use the final total paid (after tax). If a field is unclear use null."
)


def scan_receipt(image_data: bytes, mime_type: str, api_key: str) -> dict:
    """
    Send an image to Gemini, parse the receipt fields, and attach a
    category prediction. Returns the extracted dict (caller handles HTTP).
    Raises on any error.
    """
    from google import genai
    from google.genai import types

    client     = genai.Client(api_key=api_key)
    image_part = types.Part.from_bytes(data=image_data, mime_type=mime_type)
    response   = client.models.generate_content(
        model    = GEMINI_MODEL,
        contents = [_RECEIPT_PROMPT, image_part],
    )
    extracted = extract_json_from_text(response.text)

    extracted.setdefault("merchant",       "")
    extracted.setdefault("date",           None)
    extracted.setdefault("total",          None)
    extracted.setdefault("currency",       "EUR")
    extracted.setdefault("payment_method", None)
    extracted.setdefault("items",          [])
    extracted.setdefault("notes",          "")

    if not extracted.get("date"):
        extracted["date"] = date.today().isoformat()

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
