"""
Central place for all Gemini prompts and function-calling schemas.
Keeping them here makes the wording easy to find, review, and tweak
without touching the surrounding service logic.
"""

# ---------------------------------------------------------------------------
# Receipt scanning (services/receipt.py)
# ---------------------------------------------------------------------------

DEFAULT_PAYMENT_METHODS = ["Cash", "Debit Card", "Credit Card", "Mobile Pay", "Bank Transfer"]


def build_receipt_prompt(payment_methods: list[str]) -> str:
    """Build the receipt-extraction prompt, injecting the allowed payment methods."""
    methods_str = ", ".join(payment_methods) if payment_methods else ", ".join(DEFAULT_PAYMENT_METHODS)
    return (
        "You are an expert receipt-parsing assistant. Analyze this receipt (image or PDF "
        "document) carefully and extract the structured information described below.\n"
        "The receipt may be in any language, may be rotated, blurry, crumpled, or a photo "
        "taken at an angle. It may be a store receipt, restaurant bill, invoice, or online "
        "order confirmation. Read every part — header, body, and footer — before answering.\n"
        "\n"
        "Return ONLY a valid JSON object (no markdown fences, no explanation, no extra text) "
        "with EXACTLY these fields:\n"
        '{\n'
        '  "merchant": "the name of the business/store/restaurant that issued the receipt",\n'
        '  "date": "YYYY-MM-DD of the purchase if visible, else null",\n'
        '  "total": numeric final amount paid or null,\n'
        '  "currency": "ISO currency code, e.g. EUR USD GBP",\n'
        f'  "payment_method": "one of: {methods_str} — or null if not visible",\n'
        '  "items": [{"name": "item name", "price": numeric line-item price or null}],\n'
        '  "location": "the street address of the MERCHANT/STORE where the purchase happened, or null"\n'
        '}\n'
        "\n"
        "RULES:\n"
        "MERCHANT:\n"
        "- This is the seller's brand/trading name, usually printed largest at the TOP of the "
        "receipt or in the logo/header. It is NOT the cashier's name, NOT a slogan, and NOT a "
        "parent/franchise legal entity in tiny print unless that is the only name available.\n"
        "- Strip legal suffixes when an everyday name is clearer (e.g. 'GmbH', 'Ltd', 'Inc', "
        "'e.K.') but keep the recognizable brand.\n"
        "\n"
        "LOCATION (IMPORTANT — receipts often contain MULTIPLE addresses):\n"
        "- Return the address of the MERCHANT / the physical store branch where the transaction "
        "took place — this is the address printed near the merchant name in the header, or near "
        "the store/branch number, phone number, or tax/VAT ID.\n"
        "- Do NOT return the customer's / cardholder's / billing / shipping / delivery address. "
        "If you see a 'Bill to', 'Ship to', 'Deliver to', 'Customer', or handwritten personal "
        "address, IGNORE it for this field.\n"
        "- For online orders where no physical store address exists, use the merchant's "
        "registered/company address if shown, otherwise null.\n"
        "- If several store addresses appear (e.g. a chain's HQ plus the actual branch), prefer "
        "the specific branch where the purchase was made (the one tied to the store/till number "
        "or transaction).\n"
        "- Format as a single line: street, postal code, city, country if available.\n"
        "\n"
        "TOTAL & CURRENCY:\n"
        "- Use the FINAL grand total actually paid AFTER tax, discounts, and tips — usually "
        "labeled 'Total', 'Amount Due', 'Grand Total', 'Betrag', 'Summe', or similar. Do NOT use "
        "the subtotal, the tax line, or any single item price.\n"
        "- Infer currency from the symbol (€ → EUR, $ → USD, £ → GBP) or explicit code; default "
        "to the currency consistent with the rest of the receipt.\n"
        "\n"
        "DATE:\n"
        "- Use the transaction/purchase date, not a 'valid until', 'best before', or printed "
        "due date. Normalize to YYYY-MM-DD (interpret day/month order from the receipt's locale).\n"
        "\n"
        "ITEMS:\n"
        "- List the purchased line items with their individual prices. Exclude subtotal, tax, "
        "tip, rounding, and total lines. If a price is unreadable use null.\n"
        "\n"
        "GENERAL:\n"
        "- If any field is unclear, unreadable, or absent, use null (or an empty list for items) "
        "rather than guessing.\n"
        "- Output must be strictly valid JSON parseable by a standard parser."
    )


# ---------------------------------------------------------------------------
# Voice input (services/voice.py)
# ---------------------------------------------------------------------------

def build_summary_prompt(transcript: str) -> str:
    """
    Build the prompt that turns a raw speech-to-text transcript into a short,
    clean summary of the purchase the user described — fixing mis-hearings,
    resolving self-corrections, and dropping filler — WITHOUT inventing any
    content the user did not say. Shown to the user for confirmation/editing
    and then used for expense extraction.
    """
    return (
        "You are summarising a short spoken note for a personal finance / "
        "expense-logging app. The user described a purchase out loud and an "
        "automatic transcriber produced the raw text below, which may contain "
        "mis-hearings, filler words, false starts, and self-corrections.\n"
        "\n"
        "Write a short, clean summary of the purchase the user described — the "
        "kind of note they would want saved with the expense. Specifically:\n"
        "- Capture the merchant/store (if mentioned), the items bought, and "
        "their prices or amounts.\n"
        "- Fix likely transcription mis-hearings using context (e.g. a money "
        "amount misheard as 'rolls' is probably 'euros'; restore garbled "
        "merchant/brand names).\n"
        "- Resolve spoken self-corrections: if the speaker changes their mind "
        "('vegetables, I mean fruits', 'actually fruits', 'no, fruits'), keep "
        "ONLY the final intended version.\n"
        "- Drop filler words, repetitions, and false starts ('uh', 'um', "
        "'like', 'so').\n"
        "\n"
        "STRICT RULES:\n"
        "- Summarise only what was actually said. Do NOT invent merchants, "
        "items, prices, dates, or details.\n"
        "- Keep every distinct item and amount the user meant to keep; be "
        "concise but do not drop real information.\n"
        "- Keep the original language. Do not translate.\n"
        "- Return ONLY the summary text — no quotes, labels, markdown, or "
        "explanation.\n"
        "\n"
        f"Spoken note (raw transcript):\n{transcript}"
    )


VOICE_PROMPT = (
    "The user recorded a short voice note describing a purchase. "
    "Call the add_expense function with the details you hear. "
    "Rules:\n"
    "- Use the STORE or MERCHANT name as 'merchant' (e.g. Lidl, Starbucks). "
    "If no store is mentioned, use the item name.\n"
    "- If multiple items are mentioned, list each one in the 'items' array with its name and price.\n"
    "- Set 'total' to the sum of all item prices, or the total explicitly stated.\n"
    "- Default currency is EUR unless another is explicitly mentioned.\n"
    "- If the speaker corrects themselves (e.g. 'vegetables, I mean fruits', "
    "'actually fruits'), record ONLY the final corrected version and ignore the "
    "retracted one.\n"
    "- Use today's date if no date is mentioned."
)

ADD_EXPENSE_FUNC = {
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
