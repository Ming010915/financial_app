"""
Receipt scanning via Google Gemini.
Depends on classifier for merchant prediction after OCR.
"""

import json
from datetime import date

from services import classifier
from services.gemini_utils import generate_with_fallback
from services.prompts import (
    build_receipt_prompt,
    build_receipt_safety_prompt,
    RECEIPT_SAFETY_SCHEMA,
    TRANSACTION_SCHEMA,
)
from config import GEMINI_MODELS, ASK_BELOW


class NotAReceiptError(ValueError):
    pass


class SuspiciousReceiptError(ValueError):
    def __init__(self, message: str, reasons: list[str] | None = None):
        super().__init__(message)
        self.reasons = reasons or []


def _ensure_safe_to_parse(client, image_part):
    """Fail closed if the image contains visual prompt-injection cues."""
    from google.genai import types

    config = types.GenerateContentConfig(
        response_mime_type = "application/json",
        response_schema    = RECEIPT_SAFETY_SCHEMA,
    )
    response = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [build_receipt_safety_prompt(), image_part],
        config   = config,
    ), GEMINI_MODELS)
    safety = json.loads(response.text)
    if safety.get("safe_to_parse") is not True:
        reasons = safety.get("reasons") or []
        if not isinstance(reasons, list):
            reasons = [str(reasons)]
        detail = "; ".join(str(r) for r in reasons if r) or "instruction-like text was detected"
        raise SuspiciousReceiptError(
            "This receipt contains possible AI/OCR override instructions and was not "
            f"automatically processed. Reason: {detail}",
            reasons,
        )


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
    _ensure_safe_to_parse(client, image_part)
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
    if extracted.get("suspicious_visual_injection") is True:
        reason = extracted.get("suspicious_reason") or "instruction-like text was detected"
        raise SuspiciousReceiptError(
            "This receipt contains possible AI/OCR override instructions and was not "
            f"automatically processed. Reason: {reason}",
            [str(reason)],
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
