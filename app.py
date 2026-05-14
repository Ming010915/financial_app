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
import voice
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


# ── Voice input API ───────────────────────────────────────────────────────────

@app.route("/api/voice_input", methods=["POST"])
def api_voice_input():
    api_key = (
        request.form.get("api_key", "").strip()
        or os.environ.get("GOOGLE_API_KEY", "")
    )
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500

    if "audio" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400

    file       = request.files["audio"]
    audio_data = file.read()
    if not audio_data:
        return jsonify({"error": "Empty audio file"}), 400

    try:
        data = voice.process_voice_input(audio_data, file.content_type or "audio/webm", api_key)
        return jsonify({"success": True, "data": data})
    except Exception as e:
        return jsonify({"error": f"Voice processing failed: {str(e)}"}), 500


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
