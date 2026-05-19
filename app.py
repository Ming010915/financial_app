"""
Flo — Personal Finance Tracker
Flask entry point: app creation, routes, and startup.
"""

import json
import os
import urllib.request

from flask import Flask, render_template, request, jsonify

import classifier
import receipt
from config import ASK_BELOW, CENTROIDS_FILE, MONTHLY_SPENDING_DATASET

app = Flask(__name__)


# ── Page ──────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


# ── Category API ──────────────────────────────────────────────────────────────

@app.route("/api/categories")
def api_categories():
    return jsonify({
        "categories": list(classifier.centroids.keys()) + ["Others"],
        "stats":      {cat: {"n": d["n"]} for cat, d in classifier.centroids.items()},
    })


@app.route("/api/base_centroids")
def api_base_centroids():
    """Return the read-only base model for new users to bootstrap localStorage."""
    if not os.path.exists(CENTROIDS_FILE):
        return jsonify({"error": "no base model available"}), 404
    with open(CENTROIDS_FILE) as f:
        return jsonify(json.load(f))


# ── Classifier API ────────────────────────────────────────────────────────────

@app.route("/api/classify", methods=["POST"])
def api_classify():
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400

    local_cents, local_ovrs = classifier.parse_client_centroids(body)
    pred, conf, emb, top3   = classifier.do_classify(name, local_cents, local_ovrs)
    classifier.embedding_cache[name] = emb

    cent = local_cents if local_cents is not None else classifier.centroids
    return jsonify({
        "name":         name,
        "prediction":   pred,
        "confidence":   conf,
        "needs_review": conf < ASK_BELOW,
        "top3":         top3,
        "categories":   list(cent.keys()) + ["Others"],
    })


@app.route("/api/learn", methods=["POST"])
def api_learn():
    """Update the ML centroid when the user confirms an expense category."""
    body     = request.get_json(silent=True) or {}
    merchant = body.get("merchant", "").strip()
    category = body.get("category", "").strip()
    original = body.get("original_category", "").strip()

    if not merchant or not category:
        return jsonify({"error": "merchant and category required"}), 400

    local_cents, local_ovrs = classifier.parse_client_centroids(body)
    ovrs = local_ovrs if local_ovrs is not None else classifier.overrides

    emb = classifier.embedding_cache.pop(merchant, None)
    if emb is None:
        _, _, emb, _ = classifier.do_classify(merchant, local_cents, ovrs)

    if original and category != original:
        ovrs[merchant.lower()] = category

    # Skip centroid update when an override exists — the override already
    # takes priority in do_classify, so updating the centroid is unnecessary.
    if merchant.lower() not in ovrs:
        classifier.do_update(category, emb, local_cents)

    return jsonify({"success": True, "centroids": classifier.centroids_payload(local_cents, ovrs)})


# ── Receipt scanning API ──────────────────────────────────────────────────────

@app.route("/api/scan_receipt", methods=["POST"])
def api_scan_receipt():
    api_key = (
        request.form.get("api_key", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "")
    )
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500

    if "image" not in request.files:
        return jsonify({"error": "No image file uploaded"}), 400

    file       = request.files["image"]
    image_data = file.read()
    if not image_data:
        return jsonify({"error": "Empty image file"}), 400

    try:
        data = receipt.scan_receipt(image_data, file.content_type or "image/jpeg", api_key)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"error": f"Receipt processing failed: {str(e)}"}), 500


# ── Exchange Rates API ────────────────────────────────────────────────────────

@app.route("/api/exchange_rates")
def api_exchange_rates():
    base = request.args.get("base", "EUR").upper()
    try:
        req = urllib.request.Request(
            f"https://api.frankfurter.app/latest?from={base}",
            headers={"User-Agent": "Flo-Finance/1.0"},
        )
        with urllib.request.urlopen(req, timeout=6) as resp:
            data = json.loads(resp.read())
        return jsonify({"base": data["base"], "rates": data["rates"], "date": data["date"]})
    except Exception as exc:
        return jsonify({"error": str(exc)}), 502


# ── Settings API ──────────────────────────────────────────────────────────────

@app.route("/api/settings")
def api_get_settings():
    return jsonify({"env_key_set": bool(os.environ.get("GOOGLE_API_KEY", ""))})

# ── Summary API ──────────────────────────────────────────────────────────────

# @app.route("/api/summary/store", methods=["POST"])
# def api_store_summary():
#     body = request.get_json(silent=True) or {}
 
#     period   = body.get("period",   "").strip()
#     text     = body.get("text",     "").strip()
#     spending = body.get("spending", {})
 
#     if not period:
#         return jsonify({"error": "period is required"}), 400
#     if not text:
#         return jsonify({"error": "text is required"}), 400
#     if not isinstance(spending, dict) or not spending:
#         return jsonify({"error": "spending must be a non-empty object"}), 400
 
#     # Coerce all values to float — the frontend may send strings
#     try:
#         spending = {k: float(v) for k, v in spending.items()}
#     except (TypeError, ValueError):
#         return jsonify({"error": "spending values must be numeric"}), 400
 
#     try:
#         summary.store_summary(period, text, spending)
#     except Exception as exc:
#         return jsonify({"error": f"Failed to store summary: {exc}"}), 500
 
#     return jsonify({"success": True, "period": period})


# @app.route("/api/summary/overview", methods=["GET"])
# def api_get_overview():
#     import json as _json
#     from calendar import monthrange
#     from datetime import date
 
#     # ── API key ───────────────────────────────────────────────────────────────
#     api_key = (
#         request.headers.get("X-Google-Api-Key", "").strip()
#         or os.environ.get("GOOGLE_API_KEY", "")
#     )
#     if not api_key:
#         return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500
 
#     # ── spending ──────────────────────────────────────────────────────────────
#     spending_raw = request.args.get("spending_json", "").strip()
#     if not spending_raw:
#         return jsonify({"error": "spending_json is required"}), 400
 
#     try:
#         spending = {k: float(v) for k, v in _json.loads(spending_raw).items()}
#     except (ValueError, TypeError, _json.JSONDecodeError):
#         return jsonify({"error": "spending_json must be a valid JSON object with numeric values"}), 400
 
#     # ── time parameters ───────────────────────────────────────────────────────
#     today = date.today()
#     _, default_days_in_month = monthrange(today.year, today.month)
 
#     try:
#         days_elapsed  = int(request.args.get("days_elapsed",  today.day))
#         days_in_month = int(request.args.get("days_in_month", default_days_in_month))
#     except ValueError:
#         return jsonify({"error": "days_elapsed and days_in_month must be integers"}), 400
 
#     if not (1 <= days_elapsed <= days_in_month):
#         return jsonify({"error": "days_elapsed must be between 1 and days_in_month"}), 400
 
#     # ── current_text (auto-generate if not supplied) ──────────────────────────
#     current_text = request.args.get("current_text", "").strip()
#     if not current_text:
#         month_label  = today.strftime("%B %Y")
#         items        = ", ".join(f"{cat} €{amt:.0f}" for cat, amt in spending.items())
#         total        = sum(spending.values())
#         current_text = (
#             f"{month_label} (so far, day {days_elapsed}): {items}. "
#             f"Total €{total:.0f}."
#         )
 
#     # ── retrieve + generate ───────────────────────────────────────────────────
#     try:
#         retrieved = summary.retrieve_similar_summaries(
#             spending      = spending,
#             days_elapsed  = days_elapsed,
#             days_in_month = days_in_month,
#         )
#         overview = summary.generate_overview(current_text, retrieved, api_key)
#     except Exception as exc:
#         return jsonify({"error": f"Failed to generate overview: {exc}"}), 500
 
#     return jsonify({
#         "overview":   overview,
#         "based_on":   [s["period"] for s in retrieved],
#         "current_text": current_text,
#     })
 

# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 55)
    print("  Flo — AI-Powered Personal Finance Assistant")
    print("=" * 55)
    print(f"\n  Model : {classifier.MODEL_NAME}")
    print("  Loading sentence transformer ...")
    classifier.get_model()
    print("  Model ready.")

    if os.path.exists(CENTROIDS_FILE):
        classifier.load_centroids()
    elif os.path.exists(MONTHLY_SPENDING_DATASET):
        classifier.load_from_csv(MONTHLY_SPENDING_DATASET)
        classifier.save_centroids()
        print(f"[data] Base model saved to {CENTROIDS_FILE}")
    else:
        print("[data] No data source found — starting with empty centroids.")

    print(f"\n  Categories ({len(classifier.centroids)}): {list(classifier.centroids.keys())}")
    print(f"\n  Open http://localhost:5000 in your browser")
    print("=" * 55 + "\n")
    app.run(debug=False, port=5000)
