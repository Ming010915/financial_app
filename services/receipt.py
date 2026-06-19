"""
Receipt scanning via Google Gemini.
Depends on classifier for merchant prediction after OCR.
"""

import json
from datetime import date

from services import classifier
from services.gemini_utils import generate_with_fallback
from services.prompts import build_receipt_prompt
from config import GEMINI_MODELS, ASK_BELOW


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


def scan_receipt(image_data: bytes, mime_type: str,
                 payment_methods: list[str] | None = None) -> dict:
    """
    Send an image to Gemini, parse the receipt fields, and attach a
    category prediction. Returns the extracted dict (caller handles HTTP).
    Raises on any error.
    """
    from google.genai import types
    from config import get_genai_client

    prompt     = build_receipt_prompt(payment_methods or [])
    client     = get_genai_client()
    image_part = types.Part.from_bytes(data=image_data, mime_type=mime_type)
    response   = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [prompt, image_part],
    ), GEMINI_MODELS)
    extracted = extract_json_from_text(response.text)

    extracted.setdefault("merchant",       "")
    extracted.setdefault("date",           None)
    extracted.setdefault("total",          None)
    extracted.setdefault("currency",       "EUR")
    extracted.setdefault("payment_method", None)
    extracted.setdefault("items",          [])
    extracted.setdefault("location",       None)

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
