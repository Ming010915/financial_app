"""
Generates a small synthetic "golden set" of receipt images with known ground
truth, used by tests/test_receipt_ocr.py to measure Gemini OCR field
accuracy without depending on real photographed receipts (none exist in the
repo). Each case is deliberately designed to probe one rule from the
extraction prompt in services/prompts.py (tax line handling, discounts,
"N x price" quantity notation, locale date formats, non-receipt rejection).

Run: python tests/data/generate_receipts.py
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont
import random

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "receipts"
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"


def render_receipt(lines: list[tuple[str, bool]], filename: str, width: int = 480,
                    degrade: bool = False):
    """lines: list of (text, bold). Renders a simple thermal-receipt-style image.
    degrade=True simulates a phone photo: slight rotation, blur, and JPEG noise,
    so the OCR eval isn't only measuring extraction on pristine text renders."""
    font = ImageFont.truetype(FONT_PATH, 16)
    font_b = ImageFont.truetype(FONT_BOLD, 18)
    line_height = 24
    height = 40 + line_height * len(lines) + 40
    img = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(img)
    y = 30
    for text, bold in lines:
        draw.text((20, y), text, fill="black", font=font_b if bold else font)
        y += line_height

    if degrade:
        rng = random.Random(7)
        img = img.rotate(rng.uniform(-4, 4), expand=True, fillcolor="white")
        img = img.filter(ImageFilter.GaussianBlur(radius=1.1))
        # Light per-pixel noise to mimic camera sensor grain.
        import numpy as np
        arr = np.array(img).astype(np.int16)
        noise = np.random.default_rng(7).integers(-18, 18, arr.shape, dtype=np.int16)
        arr = np.clip(arr + noise, 0, 255).astype("uint8")
        img = Image.fromarray(arr)

    path = OUT_DIR / filename
    img.save(path, quality=70 if degrade else None)
    return path


CASES = [
    {
        "id": "grocery_tax_line",
        "file": "grocery_tax_line.png",
        "lines": [
            ("REWE MARKT GmbH", True),
            ("Hauptstr. 12, 80331 Muenchen", False),
            ("", False),
            ("Milch 1L          1,29", False),
            ("Brot Vollkorn     2,49", False),
            ("Bananen 1kg       1,80", False),
            ("Kaese Gouda       3,99", False),
            ("", False),
            ("Zwischensumme     9,57", False),
            ("MwSt 7%           0,67", False),
            ("Summe            10,24", True),
            ("", False),
            ("Zahlart: EC-Karte", False),
            ("Datum: 03.02.2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "REWE",
            "date": "2026-02-03",
            "total": 10.24,
            "currency": "EUR",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Milch 1L", "price": 1.29, "quantity": 1},
                {"name": "Brot Vollkorn", "price": 2.49, "quantity": 1},
                {"name": "Bananen 1kg", "price": 1.80, "quantity": 1},
                {"name": "Kaese Gouda", "price": 3.99, "quantity": 1},
                {"name": "MwSt 7%", "price": 0.67, "quantity": 1},
            ],
        },
    },
    {
        "id": "cafe_quantity_notation",
        "file": "cafe_quantity_notation.png",
        "lines": [
            ("BLUE BOTTLE COFFEE", True),
            ("221 Market St, San Francisco", False),
            ("", False),
            ("Espresso   2 x 3.50 = 7.00", False),
            ("Croissant  1 x 4.25", False),
            ("", False),
            ("Subtotal          11.25", False),
            ("Tax                0.98", False),
            ("Total             12.23", True),
            ("", False),
            ("Paid by: Credit Card", False),
            ("Date: 01/15/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Blue Bottle Coffee",
            "date": "2026-01-15",
            "total": 12.23,
            "currency": "USD",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Espresso", "price": 7.00, "quantity": 2},
                {"name": "Croissant", "price": 4.25, "quantity": 1},
                {"name": "Tax", "price": 0.98, "quantity": 1},
            ],
        },
    },
    {
        "id": "electronics_discount",
        "file": "electronics_discount.png",
        "lines": [
            ("MEDIA MARKT", True),
            ("Order Confirmation #48213", False),
            ("", False),
            ("USB-C Cable        12.99", False),
            ("Coupon -3.00", False),
            ("Wireless Mouse     24.99", False),
            ("", False),
            ("Total              34.98", True),
            ("", False),
            ("Payment: Mobile Pay", False),
            ("Date: 2026-03-11", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Media Markt",
            "date": "2026-03-11",
            "total": 34.98,
            "currency": "EUR",
            "payment_method": "Mobile Pay",
            "items": [
                {"name": "USB-C Cable", "price": 9.99, "quantity": 1},
                {"name": "Wireless Mouse", "price": 24.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "uk_pharmacy_gbp",
        "file": "uk_pharmacy_gbp.png",
        "lines": [
            ("BOOTS PHARMACY", True),
            ("221B Baker Street, London", False),
            ("", False),
            ("Paracetamol 500mg   GBP 2.49", False),
            ("Hand Cream          GBP 5.99", False),
            ("", False),
            ("Total               GBP 8.48", True),
            ("", False),
            ("Cash", False),
            ("28/02/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Boots",
            "date": "2026-02-28",
            "total": 8.48,
            "currency": "GBP",
            "payment_method": "Cash",
            "items": [
                {"name": "Paracetamol 500mg", "price": 2.49, "quantity": 1},
                {"name": "Hand Cream", "price": 5.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "duplicate_items_merge",
        "file": "duplicate_items_merge.png",
        "lines": [
            ("STARBUCKS", True),
            ("Marienplatz 5, Munich", False),
            ("", False),
            ("Latte Grande     4.50", False),
            ("Latte Grande     4.50", False),
            ("Muffin           3.20", False),
            ("", False),
            ("Total           12.20", True),
            ("", False),
            ("Credit Card", False),
            ("Date: 2026-04-02", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Starbucks",
            "date": "2026-04-02",
            "total": 12.20,
            "currency": "EUR",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Latte Grande", "price": 9.00, "quantity": 2},
                {"name": "Muffin", "price": 3.20, "quantity": 1},
            ],
        },
    },
    {
        "id": "grocery_tax_line_degraded",
        "file": "grocery_tax_line_degraded.png",
        "degrade": True,
        "lines": [
            ("REWE MARKT GmbH", True),
            ("Hauptstr. 12, 80331 Muenchen", False),
            ("", False),
            ("Milch 1L          1,29", False),
            ("Brot Vollkorn     2,49", False),
            ("Bananen 1kg       1,80", False),
            ("Kaese Gouda       3,99", False),
            ("", False),
            ("Zwischensumme     9,57", False),
            ("MwSt 7%           0,67", False),
            ("Summe            10,24", True),
            ("", False),
            ("Zahlart: EC-Karte", False),
            ("Datum: 03.02.2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "REWE",
            "date": "2026-02-03",
            "total": 10.24,
            "currency": "EUR",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Milch 1L", "price": 1.29, "quantity": 1},
                {"name": "Brot Vollkorn", "price": 2.49, "quantity": 1},
                {"name": "Bananen 1kg", "price": 1.80, "quantity": 1},
                {"name": "Kaese Gouda", "price": 3.99, "quantity": 1},
                {"name": "MwSt 7%", "price": 0.67, "quantity": 1},
            ],
        },
    },
    {
        "id": "cafe_quantity_notation_degraded",
        "file": "cafe_quantity_notation_degraded.png",
        "degrade": True,
        "lines": [
            ("BLUE BOTTLE COFFEE", True),
            ("221 Market St, San Francisco", False),
            ("", False),
            ("Espresso   2 x 3.50 = 7.00", False),
            ("Croissant  1 x 4.25", False),
            ("", False),
            ("Subtotal          11.25", False),
            ("Tax                0.98", False),
            ("Total             12.23", True),
            ("", False),
            ("Paid by: Credit Card", False),
            ("Date: 01/15/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Blue Bottle Coffee",
            "date": "2026-01-15",
            "total": 12.23,
            "currency": "USD",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Espresso", "price": 7.00, "quantity": 2},
                {"name": "Croissant", "price": 4.25, "quantity": 1},
                {"name": "Tax", "price": 0.98, "quantity": 1},
            ],
        },
    },
    {
        "id": "not_a_receipt",
        "file": "not_a_receipt.png",
        "lines": [
            ("Weekend Trip Notes", True),
            ("", False),
            ("Remember to pack:", False),
            ("- Hiking boots", False),
            ("- Sunscreen", False),
            ("- Camera charger", False),
            ("", False),
            ("Meet Sarah at the trailhead at 9am.", False),
        ],
        "ground_truth": {"is_receipt": False},
    },
    {
        "id": "restaurant_bill_with_tip",
        "file": "restaurant_bill_with_tip.png",
        "lines": [
            ("TRATTORIA BELLA", True),
            ("Via Roma 5, Milano", False),
            ("", False),
            ("Spaghetti Carbonara   14.50", False),
            ("Tiramisu               6.00", False),
            ("Water 1L               2.50", False),
            ("", False),
            ("Subtotal              23.00", False),
            ("Tip (10%)               2.30", False),
            ("Total                 25.30", True),
            ("", False),
            ("Credit Card", False),
            ("Date: 2026-03-20", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Trattoria Bella",
            "date": "2026-03-20",
            "total": 25.30,
            "currency": "EUR",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Spaghetti Carbonara", "price": 14.50, "quantity": 1},
                {"name": "Tiramisu", "price": 6.00, "quantity": 1},
                {"name": "Water 1L", "price": 2.50, "quantity": 1},
            ],
        },
    },
    {
        "id": "dual_tax_lines_us",
        "file": "dual_tax_lines_us.png",
        "lines": [
            ("TRADER JOE'S", True),
            ("123 Main St, Austin, TX", False),
            ("", False),
            ("Almond Milk         3.99", False),
            ("Bananas             1.50", False),
            ("Bread               2.99", False),
            ("", False),
            ("Subtotal            8.48", False),
            ("State Tax           0.70", False),
            ("Local Tax           0.13", False),
            ("Total               9.31", True),
            ("", False),
            ("Debit Card", False),
            ("Date: 04/10/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Trader Joe's",
            "date": "2026-04-10",
            "total": 9.31,
            "currency": "USD",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Almond Milk", "price": 3.99, "quantity": 1},
                {"name": "Bananas", "price": 1.50, "quantity": 1},
                {"name": "Bread", "price": 2.99, "quantity": 1},
                {"name": "State Tax", "price": 0.70, "quantity": 1},
                {"name": "Local Tax", "price": 0.13, "quantity": 1},
            ],
        },
    },
    {
        "id": "online_order_pickup",
        "file": "online_order_pickup.png",
        "lines": [
            ("TARGET", True),
            ("Order #556219 - Click & Collect", False),
            ("", False),
            ("Phone Charger        15.99", False),
            ("Notebook              4.99", False),
            ("", False),
            ("Total                20.98", True),
            ("", False),
            ("Pickup location: Target Downtown", False),
            ("500 5th Ave, New York", False),
            ("Billing address: 12 Elm St, Boston", False),
            ("Payment: Credit Card", False),
            ("Date: 2026-05-05", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Target",
            "date": "2026-05-05",
            "total": 20.98,
            "currency": "USD",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Phone Charger", "price": 15.99, "quantity": 1},
                {"name": "Notebook", "price": 4.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "different_unit_price_no_merge",
        "file": "different_unit_price_no_merge.png",
        "lines": [
            ("H&M", True),
            ("Fashion Store, Berlin", False),
            ("", False),
            ("T-Shirt               9.99", False),
            ("T-Shirt              14.99", False),
            ("", False),
            ("Total                24.98", True),
            ("", False),
            ("Mobile Pay", False),
            ("Date: 2026-06-01", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "H&M",
            "date": "2026-06-01",
            "total": 24.98,
            "currency": "EUR",
            "payment_method": "Mobile Pay",
            "items": [
                {"name": "T-Shirt", "price": 9.99, "quantity": 1},
                {"name": "T-Shirt", "price": 14.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "french_date_format",
        "file": "french_date_format.png",
        "lines": [
            ("CAFE DE PARIS", True),
            ("12 Rue de Rivoli, Paris", False),
            ("", False),
            ("Croissant              2.20", False),
            ("Cafe Allonge           3.00", False),
            ("", False),
            ("Total                  5.20", True),
            ("", False),
            ("Carte Bancaire", False),
            ("Date: 15/03/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Cafe de Paris",
            "date": "2026-03-15",
            "total": 5.20,
            "currency": "EUR",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Croissant", "price": 2.20, "quantity": 1},
                {"name": "Cafe Allonge", "price": 3.00, "quantity": 1},
            ],
        },
    },
    {
        "id": "spanish_receipt",
        "file": "spanish_receipt.png",
        "lines": [
            ("MERCADONA", True),
            ("Calle Mayor 10, Madrid", False),
            ("", False),
            ("Leche 1L               0.95", False),
            ("Pan de Molde           1.20", False),
            ("Manzanas 1kg           1.80", False),
            ("", False),
            ("Total                  3.95", True),
            ("", False),
            ("Tarjeta", False),
            ("Fecha: 22/07/2026", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Mercadona",
            "date": "2026-07-22",
            "total": 3.95,
            "currency": "EUR",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Leche 1L", "price": 0.95, "quantity": 1},
                {"name": "Pan de Molde", "price": 1.20, "quantity": 1},
                {"name": "Manzanas 1kg", "price": 1.80, "quantity": 1},
            ],
        },
    },
    {
        "id": "refund_receipt",
        "file": "refund_receipt.png",
        "lines": [
            ("ZALANDO", True),
            ("Refund Confirmation #RT-88213", False),
            ("", False),
            ("Sneakers Size 42      49.99", False),
            ("", False),
            ("Refund Amount:        49.99", True),
            ("", False),
            ("Refunded to: Credit Card", False),
            ("Date: 2026-08-14", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Zalando",
            "date": "2026-08-14",
            "total": 49.99,
            "currency": "EUR",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Sneakers Size 42", "price": 49.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "long_itemized_grocery",
        "file": "long_itemized_grocery.png",
        "lines": [
            ("ALDI", True),
            ("Berliner Str. 20, Hamburg", False),
            ("", False),
            ("Eggs 10pk              2.49", False),
            ("Milk 1L                1.09", False),
            ("Butter 250g            2.29", False),
            ("Yogurt 4pk             1.99", False),
            ("Apples 1kg             2.19", False),
            ("Chicken Breast 500g    4.99", False),
            ("Rice 1kg               1.79", False),
            ("Pasta 500g             0.89", False),
            ("", False),
            ("Total                 17.72", True),
            ("", False),
            ("Debit Card", False),
            ("Date: 2026-09-02", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "ALDI",
            "date": "2026-09-02",
            "total": 17.72,
            "currency": "EUR",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Eggs 10pk", "price": 2.49, "quantity": 1},
                {"name": "Milk 1L", "price": 1.09, "quantity": 1},
                {"name": "Butter 250g", "price": 2.29, "quantity": 1},
                {"name": "Yogurt 4pk", "price": 1.99, "quantity": 1},
                {"name": "Apples 1kg", "price": 2.19, "quantity": 1},
                {"name": "Chicken Breast 500g", "price": 4.99, "quantity": 1},
                {"name": "Rice 1kg", "price": 1.79, "quantity": 1},
                {"name": "Pasta 500g", "price": 0.89, "quantity": 1},
            ],
        },
    },
    {
        "id": "bank_statement_snippet",
        "file": "bank_statement_snippet.png",
        "lines": [
            ("DEUTSCHE BANK", True),
            ("Account Statement Excerpt", False),
            ("", False),
            ("POS Payment - Spotify Premium Subscription   9.99 EUR", False),
            ("Date: 2026-01-18", False),
            ("", False),
            ("Balance after: 1,245.30 EUR", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Spotify",
            "date": "2026-01-18",
            "total": 9.99,
            "currency": "EUR",
            "payment_method": None,
            "items": [
                {"name": "Spotify Premium Subscription", "price": 9.99, "quantity": 1},
            ],
        },
    },
    {
        "id": "not_a_receipt_chat_screenshot",
        "file": "not_a_receipt_chat_screenshot.png",
        "lines": [
            ("Group Chat: Weekend Plans", True),
            ("", False),
            ("Alex: are we still on for Saturday?", False),
            ("Jamie: yes! 3pm at the park", False),
            ("Alex: sounds good, see you then", False),
            ("Jamie: ok!", False),
        ],
        "ground_truth": {"is_receipt": False},
    },
    {
        "id": "restaurant_bill_with_tip_degraded",
        "file": "restaurant_bill_with_tip_degraded.png",
        "degrade": True,
        "lines": [
            ("TRATTORIA BELLA", True),
            ("Via Roma 5, Milano", False),
            ("", False),
            ("Spaghetti Carbonara   14.50", False),
            ("Tiramisu               6.00", False),
            ("Water 1L               2.50", False),
            ("", False),
            ("Subtotal              23.00", False),
            ("Tip (10%)               2.30", False),
            ("Total                 25.30", True),
            ("", False),
            ("Credit Card", False),
            ("Date: 2026-03-20", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "Trattoria Bella",
            "date": "2026-03-20",
            "total": 25.30,
            "currency": "EUR",
            "payment_method": "Credit Card",
            "items": [
                {"name": "Spaghetti Carbonara", "price": 14.50, "quantity": 1},
                {"name": "Tiramisu", "price": 6.00, "quantity": 1},
                {"name": "Water 1L", "price": 2.50, "quantity": 1},
            ],
        },
    },
    {
        "id": "long_itemized_grocery_degraded",
        "file": "long_itemized_grocery_degraded.png",
        "degrade": True,
        "lines": [
            ("ALDI", True),
            ("Berliner Str. 20, Hamburg", False),
            ("", False),
            ("Eggs 10pk              2.49", False),
            ("Milk 1L                1.09", False),
            ("Butter 250g            2.29", False),
            ("Yogurt 4pk             1.99", False),
            ("Apples 1kg             2.19", False),
            ("Chicken Breast 500g    4.99", False),
            ("Rice 1kg               1.79", False),
            ("Pasta 500g             0.89", False),
            ("", False),
            ("Total                 17.72", True),
            ("", False),
            ("Debit Card", False),
            ("Date: 2026-09-02", False),
        ],
        "ground_truth": {
            "is_receipt": True,
            "merchant": "ALDI",
            "date": "2026-09-02",
            "total": 17.72,
            "currency": "EUR",
            "payment_method": "Debit Card",
            "items": [
                {"name": "Eggs 10pk", "price": 2.49, "quantity": 1},
                {"name": "Milk 1L", "price": 1.09, "quantity": 1},
                {"name": "Butter 250g", "price": 2.29, "quantity": 1},
                {"name": "Yogurt 4pk", "price": 1.99, "quantity": 1},
                {"name": "Apples 1kg", "price": 2.19, "quantity": 1},
                {"name": "Chicken Breast 500g", "price": 4.99, "quantity": 1},
                {"name": "Rice 1kg", "price": 1.79, "quantity": 1},
                {"name": "Pasta 500g", "price": 0.89, "quantity": 1},
            ],
        },
    },
]


def main():
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    manifest = []
    for case in CASES:
        path = render_receipt(case["lines"], case["file"], degrade=case.get("degrade", False))
        manifest.append({
            "id": case["id"],
            "file": case["file"],
            "ground_truth": case["ground_truth"],
        })
    with open(OUT_DIR / "ground_truth.json", "w") as f:
        json.dump(manifest, f, indent=2)
    print(f"Generated {len(manifest)} synthetic receipts in {OUT_DIR}")


if __name__ == "__main__":
    main()
