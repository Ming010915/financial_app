"""
Voice input processing via Google Gemini.
Transcribes audio and extracts expense details using function calling.
One expense entry per shopping trip/merchant, with individual items listed.
"""

from datetime import date

from services import classifier
from services.gemini_utils import generate_with_fallback
from services.prompts import build_voice_prompt, ADD_EXPENSE_FUNC, build_summary_prompt
from config import GEMINI_MODELS, ASK_BELOW


def summarize_transcript(transcript: str) -> str:
    """
    Turn a raw speech-to-text transcript into a short, clean summary of the
    purchase — fixing mis-hearings, resolving self-corrections, and dropping
    filler — without inventing content. Returns the summary, or the original
    transcript if the model returns nothing useful. Raises on any error.
    """
    from config import get_genai_client

    client   = get_genai_client()
    response = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [build_summary_prompt(transcript)],
    ), GEMINI_MODELS)

    summary = (response.text or "").strip()
    return summary or transcript


def process_voice_text(transcript: str, event_budgets: list[str] | None = None) -> dict:
    """
    Extract expense details from a (user-confirmed) transcript via function
    calling, attach a category prediction, and return the structured dict.
    Raises on any error.
    """
    from google.genai import types
    from config import get_genai_client

    client = get_genai_client()
    tool   = types.Tool(function_declarations=[ADD_EXPENSE_FUNC])

    today          = date.today().isoformat()
    wrapped_transcript = f"<user_transcript>\n{transcript}\n</user_transcript>"
    response = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [build_voice_prompt(today, event_budgets or []), wrapped_transcript],
        config   = types.GenerateContentConfig(tools=[tool]),
    ), GEMINI_MODELS)

    extracted = {}
    for part in response.candidates[0].content.parts:
        if part.function_call:
            extracted = dict(part.function_call.args)
            break

    if not extracted:
        raise ValueError("Gemini could not extract expense details from the transcript")

    return _finalize_extracted(extracted)


def process_voice_input(audio_data: bytes, mime_type: str) -> dict:
    """
    Send audio to Gemini, extract expense details via function calling,
    attach a category prediction, and return the structured dict.
    Raises on any error.
    """
    from google.genai import types
    from config import get_genai_client

    client     = get_genai_client()
    audio_part = types.Part.from_bytes(data=audio_data, mime_type=mime_type)
    tool       = types.Tool(function_declarations=[ADD_EXPENSE_FUNC])

    today    = date.today().isoformat()
    response = generate_with_fallback(lambda model: client.models.generate_content(
        model    = model,
        contents = [build_voice_prompt(today), audio_part],
        config   = types.GenerateContentConfig(tools=[tool]),
    ), GEMINI_MODELS)

    extracted = {}
    for part in response.candidates[0].content.parts:
        if part.function_call:
            extracted = dict(part.function_call.args)
            break

    if not extracted:
        raise ValueError("Gemini could not extract expense details from the audio")

    return _finalize_extracted(extracted)


INCOME_CATEGORIES = [
    "Salary", "Freelance", "Investment", "Rental", "Gift", "Refund", "Other Income"
]


def _finalize_extracted(extracted: dict) -> dict:
    """
    Fill in defaults, normalise items, compute a missing total, and attach the
    category prediction. Shared by the audio and text extraction paths.
    """
    extracted.setdefault("merchant",         "")
    extracted.setdefault("total",            None)
    extracted.setdefault("currency",         "EUR")
    extracted.setdefault("date",             None)
    extracted.setdefault("payment_method",   None)
    extracted.setdefault("notes",            "")
    extracted.setdefault("items",            [])
    extracted.setdefault("transaction_type", "expense")
    extracted.setdefault("event_hint",        None)

    # Normalise items to plain dicts (Gemini may return MapComposite objects)
    extracted["items"] = [dict(i) for i in extracted["items"]]

    if not extracted.get("date"):
        extracted["date"] = date.today().isoformat()

    # If total is missing but items have prices, compute it
    if extracted["total"] is None and extracted["items"]:
        prices = [i.get("price") for i in extracted["items"] if i.get("price") is not None]
        if prices:
            extracted["total"] = round(sum(prices), 2)

    is_income = extracted["transaction_type"] == "income"
    merchant  = extracted.get("merchant", "")

    if is_income:
        # Income entries don't use the ML expense classifier
        extracted["predicted_category"] = "Other Income"
        extracted["confidence"]         = 1.0
        extracted["needs_review"]       = False
        extracted["top3"]               = []
        extracted["categories"]         = INCOME_CATEGORIES
        extracted["is_override"]        = False
    elif merchant:
        pred, conf, emb, top3, is_ovr = classifier.do_classify(merchant)
        classifier.embedding_cache[merchant] = emb
        extracted["predicted_category"] = pred
        extracted["confidence"]         = conf
        extracted["needs_review"]       = conf < ASK_BELOW
        extracted["top3"]               = top3
        extracted["categories"]         = list(classifier.centroids.keys()) + ["Others"]
        extracted["is_override"]        = is_ovr
    else:
        extracted["predicted_category"] = "Others"
        extracted["confidence"]         = 0.0
        extracted["needs_review"]       = True
        extracted["top3"]               = []
        extracted["categories"]         = list(classifier.centroids.keys()) + ["Others"]
        extracted["is_override"]        = False

    return extracted
