"""
Nearest-centroid classifier with online (incremental) learning.
All ML state lives here as module-level variables so the Flask app
and the receipt module can share the same in-process objects.
"""

import os
import json

import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

from config import MODEL_NAME, EMBEDDING_VERSION, THRESHOLD, CENTROIDS_FILE

# ── Module-level state ────────────────────────────────────────────────────────

_model:          object     = None   # SentenceTransformer, lazy-loaded
centroids:       dict       = {}     # cat -> {centroid: ndarray, n: int}
embedding_cache: dict       = {}     # merchant name -> embedding (request-scoped cache)
overrides:       dict       = {}     # lowercase merchant -> category


# ── Model loading ─────────────────────────────────────────────────────────────

def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        _model = SentenceTransformer(MODEL_NAME)
    return _model


# ── Centroid persistence ──────────────────────────────────────────────────────

def load_centroids() -> bool:
    """Load persisted centroids. Returns False (and loads nothing) if the
    file is missing or was computed with a different embedding model or
    encoding version — stale centroids have the wrong dimensionality, or
    the right dimensionality but the wrong vectors, and would silently
    corrupt cosine_similarity against fresh embeddings."""
    global centroids, overrides
    if not os.path.exists(CENTROIDS_FILE):
        return False
    with open(CENTROIDS_FILE) as f:
        data = json.load(f)
    if data.get("model") != MODEL_NAME or data.get("embedding_version") != EMBEDDING_VERSION:
        print(f"[data] {CENTROIDS_FILE} was built with model={data.get('model')!r} "
              f"embedding_version={data.get('embedding_version')!r}, not "
              f"{MODEL_NAME!r}/{EMBEDDING_VERSION!r} — ignoring and recomputing.")
        return False
    centroids = {
        cat: {"centroid": np.array(v["centroid"]), "n": v["n"]}
        for cat, v in data["categories"].items()
    }
    overrides = data.get("overrides", {})
    print(f"[data] Loaded {len(centroids)} categories, {len(overrides)} overrides")
    return True


def load_from_csv(csv_path: str):
    import pandas as pd
    global centroids
    print(f"[data] Computing centroids from {csv_path} ...")
    df     = pd.read_csv(csv_path)
    names  = df["name"].astype(str).tolist()
    labels = df["category"].astype(str).tolist()
    m      = get_model()
    # Lowercase before encoding — the embedding model is sensitive enough to
    # casing that e.g. "REWE" and "rewe" land measurably apart in embedding
    # space, which can flip a borderline match across THRESHOLD.
    embs   = m.encode([n.lower() for n in names], normalize_embeddings=True, show_progress_bar=True)
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
        "model":             MODEL_NAME,
        "embedding_version": EMBEDDING_VERSION,
        "threshold":         THRESHOLD,
        "categories": {
            cat: {"centroid": d["centroid"].tolist(), "n": d["n"]}
            for cat, d in centroids.items()
        },
        "overrides": overrides,
    }
    with open(CENTROIDS_FILE, "w") as f:
        json.dump(export, f, indent=2)


# ── Serialization helper ──────────────────────────────────────────────────────

def centroids_payload(local_cents=None, local_ovrs=None) -> dict:
    """Serialize centroids + overrides for JSON transport to the browser."""
    cent = local_cents if local_cents is not None else centroids
    ovr  = local_ovrs  if local_ovrs  is not None else overrides
    return {
        "model":             MODEL_NAME,
        "embedding_version": EMBEDDING_VERSION,
        "threshold":         THRESHOLD,
        "categories": {
            cat: {"centroid": d["centroid"].tolist(), "n": d["n"]}
            for cat, d in cent.items()
        },
        "overrides": ovr,
    }


# ── Per-request client centroid parsing ───────────────────────────────────────

def parse_client_centroids(body: dict):
    """
    The browser sends its own (possibly personalized) centroids with each
    request so the server is stateless w.r.t. per-user learning.
    Returns (local_cents, local_ovrs) or (None, None) if not present or if
    they were built with a different embedding model or encoding version
    (e.g. a client that hasn't refreshed since a server-side model swap or
    preprocessing change) — their vectors would be wrong for the live model.
    """
    cats = body.get("categories")
    if not cats or body.get("model") != MODEL_NAME or body.get("embedding_version") != EMBEDDING_VERSION:
        return None, None
    local_cents = {
        cat: {"centroid": np.array(v["centroid"]), "n": v["n"]}
        for cat, v in cats.items()
    }
    return local_cents, body.get("overrides", {})


# ── Core classifier ───────────────────────────────────────────────────────────

def do_classify(name: str, local_cents=None, local_ovrs=None):
    """
    Classify a merchant name.
    Returns (prediction, confidence, embedding, top3_list).
    """
    cent      = local_cents if local_cents is not None else centroids
    ovr       = local_ovrs  if local_ovrs  is not None else overrides
    m         = get_model()
    embedding = m.encode(name.lower(), normalize_embeddings=True)

    override = ovr.get(name.lower().strip())
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
