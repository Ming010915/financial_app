"""
Receipt scanning via Google Gemini.
Depends on classifier for merchant prediction after OCR.
"""

import json
from datetime import date

from services import classifier
from services.gemini_utils import generate_with_fallback
from services.prompts import build_receipt_prompt, TRANSACTION_SCHEMA
from config import GEMINI_MODELS, ASK_BELOW


class NotAReceiptError(ValueError):
    pass


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
    config     = types.GenerateContentConfig(
        response_mime_type = "application/json",
        response_schema    = TRANSACTION_SCHEMA,
    )
    response   = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [prompt, image_part],
        config   = config,
    ), GEMINI_MODELS)
    extracted = json.loads(response.text)

    if extracted.get("is_receipt") is False:
        raise NotAReceiptError(
            "This file doesn't appear to be a receipt. "
            "Please upload an image or PDF of a receipt, invoice, or bill."
        )

    extracted.setdefault("transaction_type", "expense")
    extracted.setdefault("merchant",         "")
    extracted.setdefault("date",             None)
    extracted.setdefault("total",            None)
    extracted.setdefault("currency",         "EUR")
    extracted.setdefault("payment_method",   None)
    extracted.setdefault("items",            [])
    extracted.setdefault("location",         None)
    extracted.setdefault("notes",            "")

    if not extracted.get("date"):
        extracted["date"] = date.today().isoformat()

    merchant = extracted.get("merchant", "")
    if merchant:
        pred, conf, emb, top3, is_ovr = classifier.do_classify(merchant)
        classifier.embedding_cache[merchant] = emb
        extracted["predicted_category"] = pred
        extracted["confidence"]         = conf
        extracted["needs_review"]       = conf < ASK_BELOW
        extracted["top3"]               = top3
        extracted["is_override"]        = is_ovr
    else:
        extracted["predicted_category"] = "Others"
        extracted["confidence"]         = 0.0
        extracted["needs_review"]       = True
        extracted["top3"]               = []
        extracted["is_override"]        = False

    extracted["categories"] = list(classifier.centroids.keys()) + ["Others"]
    return extracted
