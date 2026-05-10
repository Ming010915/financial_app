"""
SpendTrack — Personal Finance Tracker
Flask backend with:
- Nearest Centroid Classifier (online learning)
- Google AI Studio (Gemini) receipt scanning
- Expenses stored in browser (localStorage)
"""

import os
import json
import numpy as np
from datetime import date
from flask import Flask, render_template, request, jsonify
from sklearn.metrics.pairwise import cosine_similarity

app = Flask(__name__)

MODEL_NAME     = "paraphrase-multilingual-mpnet-base-v2"
GEMINI_MODEL   = "gemini-2.5-flash"
THRESHOLD      = 0.3
ASK_BELOW      = 0.6
CENTROIDS_FILE = "centroids.json"

_model          = None
centroids       = {}
embedding_cache = {}
overrides       = {}


# ── Model & centroid helpers ──────────────────────────────────────────────────

def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def load_centroids():
    global centroids, overrides
    if not os.path.exists(CENTROIDS_FILE):
        return
    with open(CENTROIDS_FILE) as f:
        data = json.load(f)
    centroids = {
        cat: {"centroid": np.array(v["centroid"]), "n": v["n"]}
        for cat, v in data["categories"].items()
    }
    overrides = data.get("overrides", {})
    print(f"[data] Loaded {len(centroids)} categories, {len(overrides)} overrides")


def load_from_csv(csv_path):
    import pandas as pd
    global centroids
    print(f"[data] Computing centroids from {csv_path} ...")
    df     = pd.read_csv(csv_path)
    names  = df["name"].astype(str).tolist()
    labels = df["category"].astype(str).tolist()
    m      = get_model()
    embs   = m.encode(names, normalize_embeddings=True, show_progress_bar=True)
    centroids = {}
    for cat in sorted(set(labels)):
        if cat == "Others":
            continue
        mask   = np.array([l == cat for l in labels])
        center = embs[mask].mean(axis=0)
        center = center / np.linalg.norm(center)
        centroids[cat] = {"centroid": center, "n": int(mask.sum())}
    print(f"[data] Computed {len(centroids)} category centroids")


def save_centroids():
    export = {
        "model":      MODEL_NAME,
        "threshold":  THRESHOLD,
        "categories": {
            cat: {"centroid": d["centroid"].tolist(), "n": d["n"]}
            for cat, d in centroids.items()
        },
        "overrides": overrides,
    }
    with open(CENTROIDS_FILE, "w") as f:
        json.dump(export, f, indent=2)


# ── Core classifier ───────────────────────────────────────────────────────────

def _parse_client_centroids(body):
    """Extract per-request centroids sent by the browser. Returns (cents, ovrs) or (None, None)."""
    cats = body.get("categories")
    if not cats:
        return None, None
    local_cents = {
        cat: {"centroid": np.array(v["centroid"]), "n": v["n"]}
        for cat, v in cats.items()
    }
    return local_cents, body.get("overrides", {})


def do_classify(name: str, local_cents=None, local_ovrs=None):
    """Return (prediction, confidence, embedding, top3_list)."""
    cent      = local_cents if local_cents is not None else centroids
    ovr       = local_ovrs  if local_ovrs  is not None else overrides
    m         = get_model()
    embedding = m.encode(name, normalize_embeddings=True)
    override  = ovr.get(name.lower().strip())
    if override is not None:
        return override, 1.0, embedding, [{"category": override, "score": 1.0}]
    if not cent:
        return "Others", 0.0, embedding, []
    cat_names = list(cent.keys())
    matrix    = np.stack([v["centroid"] for v in cent.values()])
    sims      = cosine_similarity(embedding.reshape(1, -1), matrix)[0]
    order     = np.argsort(sims)[::-1]
    best_idx  = int(order[0])
    best_sim  = float(sims[best_idx])
    pred      = cat_names[best_idx] if best_sim >= THRESHOLD else "Others"
    top3 = [
        {"category": cat_names[int(i)], "score": round(float(sims[i]), 3)}
        for i in order[:3]
    ]
    return pred, round(best_sim, 3), embedding, top3


def do_update(category: str, embedding: np.ndarray, local_cents=None):
    """Incremental running-average centroid update."""
    cent = local_cents if local_cents is not None else centroids
    if category == "Others":
        return
    if category not in cent:
        cent[category] = {"centroid": embedding.copy(), "n": 1}
        return
    old     = cent[category]["centroid"]
    n       = cent[category]["n"]
    updated = (old * n + embedding) / (n + 1)
    norm    = np.linalg.norm(updated)
    if norm > 0:
        updated /= norm
    cent[category]["centroid"] = updated
    cent[category]["n"]        = n + 1


# ── JSON extraction helper ────────────────────────────────────────────────────

def extract_json_from_text(text: str) -> dict:
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


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/categories")
def api_categories():
    return jsonify({
        "categories": list(centroids.keys()) + ["Others"],
        "stats":      {cat: {"n": d["n"]} for cat, d in centroids.items()},
    })


@app.route("/api/classify", methods=["POST"])
def api_classify():
    body = request.get_json(silent=True) or {}
    name = body.get("name", "").strip()
    if not name:
        return jsonify({"error": "Name is required"}), 400
    local_cents, local_ovrs = _parse_client_centroids(body)
    pred, conf, emb, top3 = do_classify(name, local_cents, local_ovrs)
    embedding_cache[name] = emb
    cent = local_cents if local_cents is not None else centroids
    return jsonify({
        "name":         name,
        "prediction":   pred,
        "confidence":   conf,
        "needs_review": conf < ASK_BELOW,
        "top3":         top3,
        "categories":   list(cent.keys()) + ["Others"],
    })


def _centroids_payload(local_cents=None, local_ovrs=None):
    """Serialize centroids for JSON transport."""
    cent = local_cents if local_cents is not None else centroids
    ovr  = local_ovrs  if local_ovrs  is not None else overrides
    return {
        "model":      MODEL_NAME,
        "threshold":  THRESHOLD,
        "categories": {
            cat: {"centroid": d["centroid"].tolist(), "n": d["n"]}
            for cat, d in cent.items()
        },
        "overrides": ovr,
    }


@app.route("/api/base_centroids", methods=["GET"])
def api_base_centroids():
    """Return the read-only base model from centroids.json for new users to bootstrap localStorage."""
    if not os.path.exists(CENTROIDS_FILE):
        return jsonify({"error": "no base model available"}), 404
    with open(CENTROIDS_FILE) as f:
        return jsonify(json.load(f))


@app.route("/api/learn", methods=["POST"])
def api_learn():
    """Update the ML centroid when the user confirms an expense category."""
    body     = request.get_json(silent=True) or {}
    merchant = body.get("merchant", "").strip()
    category = body.get("category", "").strip()
    original = body.get("original_category", "").strip()

    if not merchant or not category:
        return jsonify({"error": "merchant and category required"}), 400

    local_cents, local_ovrs = _parse_client_centroids(body)
    ovrs = local_ovrs if local_ovrs is not None else overrides

    emb = embedding_cache.pop(merchant, None)
    if emb is None:
        _, _, emb, _ = do_classify(merchant, local_cents, ovrs)

    if bool(original) and category != original:
        ovrs[merchant.lower()] = category

    # Skip centroid update when an override exists — the override already
    # takes priority in do_classify, so updating the centroid is unnecessary.
    if merchant.lower() not in ovrs:
        do_update(category, emb, local_cents)

    return jsonify({"success": True, "centroids": _centroids_payload(local_cents, ovrs)})


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
    mime_type  = file.content_type or "image/jpeg"

    if not image_data:
        return jsonify({"error": "Empty image file"}), 400

    try:
        from google import genai
        from google.genai import types

        client = genai.Client(api_key=api_key)

        prompt = (
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

        image_part = types.Part.from_bytes(data=image_data, mime_type=mime_type)
        response   = client.models.generate_content(
            model    = GEMINI_MODEL,
            contents = [prompt, image_part],
        )
        extracted = extract_json_from_text(response.text)

        extracted.setdefault("merchant", "")
        extracted.setdefault("date", None)
        extracted.setdefault("total", None)
        extracted.setdefault("currency", "EUR")
        extracted.setdefault("payment_method", None)
        extracted.setdefault("items", [])
        extracted.setdefault("notes", "")

        if not extracted.get("date"):
            extracted["date"] = date.today().isoformat()

        merchant = extracted.get("merchant", "")
        if merchant:
            pred, conf, emb, top3 = do_classify(merchant)
            embedding_cache[merchant] = emb
            extracted["predicted_category"] = pred
            extracted["confidence"]         = conf
            extracted["needs_review"]       = conf < ASK_BELOW
            extracted["top3"]              = top3
        else:
            extracted["predicted_category"] = "Others"
            extracted["confidence"]         = 0.0
            extracted["needs_review"]       = True
            extracted["top3"]              = []

        extracted["categories"] = list(centroids.keys()) + ["Others"]
        return jsonify({"success": True, "data": extracted})

    except Exception as e:
        return jsonify({"error": f"Receipt processing failed: {str(e)}"}), 500


@app.route("/api/settings", methods=["GET"])
def api_get_settings():
    return jsonify({"env_key_set": bool(os.environ.get("GOOGLE_API_KEY", ""))})


# ── Startup ───────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("=" * 55)
    print("  Flo — AI-Powered Personal Finance Assistant")
    print("=" * 55)
    print(f"\n  Model : {MODEL_NAME}")
    print("  Loading sentence transformer ...")
    get_model()
    print("  Model ready.")

    if os.path.exists(CENTROIDS_FILE):
        load_centroids()
    elif os.path.exists("monthly_spending_2024.csv"):
        load_from_csv("monthly_spending_2024.csv")
        save_centroids()
        print(f"[data] Base model saved to {CENTROIDS_FILE}")
    else:
        print("[data] No data source found — starting with empty centroids.")

    print(f"\n  Categories ({len(centroids)}): {list(centroids.keys())}")
    print(f"\n  Open http://localhost:5000 in your browser")
    print("=" * 55 + "\n")
    app.run(debug=False, port=5000)
