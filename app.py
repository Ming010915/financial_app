"""
Flo — Personal Finance Tracker
Flask entry point: app creation, routes, and startup.
"""

import base64
import json
import os
import queue
import threading
import urllib.request
import urllib.parse

from flask import Flask, render_template, request, jsonify, session, redirect, url_for
from flask_sock import Sock

import services.summary as summary
import services.classifier as classifier
import services.receipt as receipt
import services.voice as voice
from services.gemini_utils import ModelOverloadedError
from config import (
    ASK_BELOW, CENTROIDS_FILE, MONTHLY_SPENDING_DATASET,
    SERVER_PLACES_API_KEY, GOOGLE_CLOUD_PROJECT,
    REQUIRE_PASSWORD, APP_PASSWORD, SECRET_KEY,
    get_genai_client,
)

app = Flask(__name__)
app.secret_key = SECRET_KEY
sock = Sock(app)


# ── Access control ────────────────────────────────────────────────────────────

# Endpoints reachable without being logged in.
PUBLIC_ENDPOINTS = {"login", "static"}


@app.before_request
def require_login():
    """Gate every request behind the login page when REQUIRE_PASSWORD is on."""
    if not REQUIRE_PASSWORD:
        return None
    if request.endpoint in PUBLIC_ENDPOINTS:
        return None
    if session.get("authenticated"):
        return None
    # Unauthenticated: send pages to the login screen, reject API/WS calls.
    if request.path.startswith("/api/") or request.path.startswith("/ws/"):
        return jsonify({"error": "Authentication required"}), 401
    return redirect(url_for("login"))


@app.route("/login", methods=["GET", "POST"])
def login():
    # If the gate is off, there's nothing to log into.
    if not REQUIRE_PASSWORD:
        return redirect(url_for("index"))
    if session.get("authenticated"):
        return redirect(url_for("index"))

    error = None
    if request.method == "POST":
        password = (request.form.get("password") or "").strip()
        # No password configured at all → deny everyone for security.
        if not APP_PASSWORD:
            error = "No password is configured on the server. Access is denied."
        elif password and password == APP_PASSWORD:
            session["authenticated"] = True
            session.permanent = True
            return redirect(url_for("index"))
        else:
            error = "Incorrect password. Please try again."
    return render_template("login.html", error=error), (401 if error else 200)


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


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
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    file = request.files.get("file") or request.files.get("image")
    if file is None:
        return jsonify({"error": "No file uploaded"}), 400

    file_data = file.read()
    if not file_data:
        return jsonify({"error": "Empty file"}), 400

    mime_type = file.content_type or "image/jpeg"
    allowed = ("image/", "application/pdf")
    if not any(mime_type.startswith(p) for p in allowed):
        return jsonify({"error": "Unsupported file type. Please upload an image or PDF."}), 400

    try:
        pm_raw = request.form.get("payment_methods", "")
        payment_methods = [m.strip() for m in pm_raw.split(",") if m.strip()] if pm_raw else []
        data = receipt.scan_receipt(file_data, mime_type, payment_methods or None)
        return jsonify({"success": True, "data": data})
    except receipt.NotAReceiptError as e:
        return jsonify({"error": str(e), "error_code": "not_a_receipt"}), 422
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Receipt processing failed: {str(e)}"}), 500


# ── Voice input API ───────────────────────────────────────────────────────────

@app.route("/api/voice_input", methods=["POST"])
def api_voice_input():
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    if "audio" not in request.files:
        return jsonify({"error": "No audio file uploaded"}), 400

    file       = request.files["audio"]
    audio_data = file.read()
    if not audio_data:
        return jsonify({"error": "Empty audio file"}), 400

    try:
        data = voice.process_voice_input(audio_data, file.content_type or "audio/webm")
        return jsonify({"success": True, "data": data})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Voice processing failed: {str(e)}"}), 500


@app.route("/api/voice_summary", methods=["POST"])
def api_voice_summary():
    """Summarise a raw live transcript into a clean purchase note before extraction."""
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    transcript = (request.form.get("transcript", "") or "").strip()
    if not transcript:
        return jsonify({"error": "Empty transcript"}), 400

    try:
        summary = voice.summarize_transcript(transcript)
        return jsonify({"success": True, "original": transcript, "summary": summary})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Transcript summary failed: {str(e)}"}), 500


@app.route("/api/voice_extract", methods=["POST"])
def api_voice_extract():
    """Extract expense details from a user-confirmed transcript (text only)."""
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    transcript = (request.form.get("transcript", "") or "").strip()
    if not transcript:
        return jsonify({"error": "Empty transcript"}), 400

    import json as _json
    raw_budgets   = request.form.get("event_budgets", "")
    event_budgets = _json.loads(raw_budgets) if raw_budgets else []

    try:
        data = voice.process_voice_text(transcript, event_budgets=event_budgets)
        return jsonify({"success": True, "data": data})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Voice processing failed: {str(e)}"}), 500


# ── Speech-to-Text API ───────────────────────────────────────────────────────

# Phrases boosted in Google Cloud STT to improve recognition of financial terms.
_STT_FINANCIAL_HINTS = [
    # Currencies
    "Euro", "Euros", "EUR", "Dollar", "Dollars", "USD",
    "Pound", "Pounds", "GBP", "Swiss Franc", "CHF", "Yen", "JPY",
    "cent", "cents", "pence"
]

@app.route("/api/stt", methods=["POST"])
def api_stt():
    """Transcribe uploaded audio using Google Cloud Speech-to-Text."""
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    file = request.files.get("audio")
    if not file:
        return jsonify({"error": "No audio file uploaded"}), 400

    audio_data = file.read()
    if not audio_data:
        return jsonify({"error": "Empty audio file"}), 400

    try:
        from google.cloud import speech
        client = speech.SpeechClient()

        mime = (file.content_type or "audio/webm").lower()
        if "ogg" in mime:
            encoding = speech.RecognitionConfig.AudioEncoding.OGG_OPUS
        else:
            encoding = speech.RecognitionConfig.AudioEncoding.WEBM_OPUS

        config = speech.RecognitionConfig(
            encoding=encoding,
            sample_rate_hertz=48000,
            language_code="en-US",
            alternative_language_codes=["de-DE"],
            enable_automatic_punctuation=True,
            speech_contexts=[speech.SpeechContext(
                phrases=_STT_FINANCIAL_HINTS,
                boost=15.0,
            )],
        )
        print(f"[STT] Sending {len(audio_data)} bytes ({mime}) to Google Cloud STT...")
        response = client.recognize(
            config=config,
            audio=speech.RecognitionAudio(content=audio_data),
        )
        transcript = " ".join(
            result.alternatives[0].transcript
            for result in response.results
            if result.alternatives
        )
        print(f"[STT] Transcript: {transcript!r}")
        return jsonify({"transcript": transcript})
    except Exception as e:
        print(f"[STT] Error: {e}")
        return jsonify({"error": f"STT failed: {str(e)}"}), 500


# ── Text-to-Speech API ────────────────────────────────────────────────────────

@app.route("/api/tts", methods=["POST"])
def api_tts():
    """Synthesize text to speech using Google Cloud TTS and return MP3 audio."""
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500

    body = request.get_json(silent=True) or {}
    text = (body.get("text") or "").strip()
    if not text:
        return jsonify({"error": "text is required"}), 400

    language_code = body.get("language_code", "en-US")
    voice_name    = body.get("voice_name", "en-US-Chirp3-HD-Aoede")

    try:
        from google.cloud import texttospeech
        client = texttospeech.TextToSpeechClient()
        response = client.synthesize_speech(
            input=texttospeech.SynthesisInput(text=text),
            voice=texttospeech.VoiceSelectionParams(
                language_code=language_code,
                name=voice_name,
            ),
            audio_config=texttospeech.AudioConfig(
                audio_encoding=texttospeech.AudioEncoding.MP3,
            ),
        )
        return response.audio_content, 200, {
            "Content-Type": "audio/mpeg",
            "Cache-Control": "no-store",
        }
    except Exception as e:
        return jsonify({"error": f"TTS failed: {str(e)}"}), 500


# ── Streaming STT WebSocket ───────────────────────────────────────────────────

@sock.route('/ws/voice_live')
def voice_live_ws(ws):
    """WebSocket: browser PCM audio → Google Cloud STT streaming → live transcript."""
    from google.cloud import speech

    try:
        init     = json.loads(ws.receive())
        pcm_rate = int(init.get('sample_rate', 16000))
        print(f"[STT] WebSocket connected. sample_rate={pcm_rate}")
    except Exception as e:
        print(f"[STT] Init error: {e}")
        return

    if not GOOGLE_CLOUD_PROJECT:
        try:
            ws.send(json.dumps({'error': 'GOOGLE_CLOUD_PROJECT is not configured.'}))
        except Exception:
            pass
        return

    audio_q    = queue.Queue()
    stop_event = threading.Event()

    def audio_generator():
        while not stop_event.is_set():
            chunk = audio_q.get()
            if chunk is None:
                return
            yield speech.StreamingRecognizeRequest(audio_content=chunk)

    def stt_thread():
        try:
            client = speech.SpeechClient()
            config = speech.RecognitionConfig(
                encoding=speech.RecognitionConfig.AudioEncoding.LINEAR16,
                sample_rate_hertz=pcm_rate,
                language_code="en-US",
                alternative_language_codes=["de-DE"],
                enable_automatic_punctuation=True,
                speech_contexts=[speech.SpeechContext(
                    phrases=_STT_FINANCIAL_HINTS,
                    boost=15.0,
                )],
            )
            streaming_config = speech.StreamingRecognitionConfig(
                config=config,
                interim_results=True,
            )
            responses = client.streaming_recognize(streaming_config, audio_generator())
            for response in responses:
                if stop_event.is_set():
                    break
                for result in response.results:
                    if not result.alternatives:
                        continue
                    transcript = result.alternatives[0].transcript
                    is_final   = result.is_final
                    print(f"[STT] {'Final' if is_final else 'Interim'}: {transcript!r}")
                    try:
                        ws.send(json.dumps({'transcript': transcript, 'is_final': is_final}))
                    except Exception:
                        stop_event.set()
                        return
        except Exception as e:
            print(f"[STT] Stream error: {e}")
            try:
                ws.send(json.dumps({'error': str(e)}))
            except Exception:
                pass
            stop_event.set()

    worker = threading.Thread(target=stt_thread, daemon=True)
    worker.start()

    try:
        while True:
            raw = ws.receive()
            if raw is None:
                break
            try:
                msg = json.loads(raw)
                if msg.get('type') == 'audio':
                    audio_q.put(base64.b64decode(msg['data']))
                elif msg.get('type') == 'stop':
                    print("[STT] Stop received from client.")
                    break
            except Exception as e:
                print(f"[STT] Error parsing message: {e}")
    finally:
        stop_event.set()
        audio_q.put(None)
        worker.join(timeout=5)
        print("[STT] Session ended.")


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
    return jsonify({
        "vertex_ai_configured": bool(GOOGLE_CLOUD_PROJECT),
        "env_key_set":          bool(GOOGLE_CLOUD_PROJECT),
        "places_key_set":       bool(SERVER_PLACES_API_KEY),
    })


# ── Google Places proxy ───────────────────────────────────────────────────────
# The browser never receives the Places key; it calls these endpoints and the
# server talks to Google on its behalf.

def _places_request(path, params):
    """Call a Google Places web-service endpoint and return parsed JSON."""
    qs  = urllib.parse.urlencode(params)
    req = urllib.request.Request(
        f"https://maps.googleapis.com/maps/api/place/{path}?{qs}",
        headers={"User-Agent": "Flo-Finance/1.0"},
    )
    with urllib.request.urlopen(req, timeout=8) as resp:
        data = json.loads(resp.read())
    status = data.get("status", "")
    if status not in ("OK", "ZERO_RESULTS"):
        msg = data.get("error_message", status)
        raise ValueError(f"Google Places API error: {status} — {msg}")
    return data


def _normalize_places(results):
    """Reduce Google's payload to just what the UI renders."""
    out = []
    for r in (results or [])[:12]:
        out.append({
            "name":              r.get("name", ""),
            "formatted_address": r.get("formatted_address", ""),
            "vicinity":          r.get("vicinity", ""),
        })
    return out


@app.route("/api/places/text_search", methods=["POST"])
def api_places_text_search():
    body = request.get_json(silent=True) or {}
    # A user-supplied key (from their own browser settings) overrides the server key.
    api_key = (body.get("api_key") or "").strip() or SERVER_PLACES_API_KEY
    if not api_key:
        return jsonify({"error": "No Places API key configured"}), 400

    query = (body.get("query") or "").strip()
    if not query:
        return jsonify({"results": []})

    params = {"query": query, "key": api_key, "type": "establishment"}
    lat, lng = body.get("lat"), body.get("lng")
    if lat is not None and lng is not None:
        params["location"] = f"{lat},{lng}"
        params["radius"]   = 5000

    try:
        data = _places_request("textsearch/json", params)
    except Exception as exc:
        return jsonify({"error": f"Places request failed: {exc}"}), 502
    return jsonify({"results": _normalize_places(data.get("results"))})


@app.route("/api/places/nearby", methods=["POST"])
def api_places_nearby():
    body = request.get_json(silent=True) or {}
    api_key = (body.get("api_key") or "").strip() or SERVER_PLACES_API_KEY
    if not api_key:
        return jsonify({"error": "No Places API key configured"}), 400

    lat, lng = body.get("lat"), body.get("lng")
    if lat is None or lng is None:
        return jsonify({"error": "lat and lng are required"}), 400

    params = {
        "location": f"{lat},{lng}",
        "rankby":   "distance",
        "type":     "establishment",
        "key":      api_key,
    }
    try:
        data = _places_request("nearbysearch/json", params)
    except Exception as exc:
        return jsonify({"error": f"Places request failed: {exc}"}), 502
    return jsonify({"results": _normalize_places(data.get("results"))})

# ── Summary API ──────────────────────────────────────────────────────────────

@app.route("/api/summary/overview", methods=["GET"])
def api_get_overview():
    import json as _json
    from calendar import monthrange
    from datetime import date
    if not GOOGLE_CLOUD_PROJECT:
        return jsonify({"error": "GOOGLE_CLOUD_PROJECT is not configured on the server."}), 500
    
    spending_raw = request.args.get("spending_json", "").strip()
    if not spending_raw:
        return jsonify({"error": "spending_json is required"}), 400
 
    try:
        spending = {k: float(v) for k, v in _json.loads(spending_raw).items()}
    except (ValueError, TypeError, _json.JSONDecodeError):
        return jsonify({"error": "spending_json must be a valid JSON object with numeric values"}), 400
 
    today = date.today()
    _, default_days_in_month = monthrange(today.year, today.month)
 
    try:
        days_elapsed  = int(request.args.get("days_elapsed",  today.day))
        days_in_month = int(request.args.get("days_in_month", default_days_in_month))
    except ValueError:
        return jsonify({"error": "days_elapsed and days_in_month must be integers"}), 400
 
    if not (1 <= days_elapsed <= days_in_month):
        return jsonify({"error": "days_elapsed must be between 1 and days_in_month"}), 400
 
    # ── current_text (auto-generate if not supplied) ──────────────────────────
    current_text = request.args.get("current_text", "").strip()
    if not current_text:
        month_label  = today.strftime("%B %Y")
        items        = ", ".join(f"{cat} €{amt:.0f}" for cat, amt in spending.items())
        total        = sum(spending.values())
        current_text = (
            f"{month_label} (so far, day {days_elapsed}): {items}. "
            f"Total €{total:.0f}."
        )

    # ── retrieved summaries (looked up client-side) ───────────────────────────
    retrieved_raw = request.args.get("retrieved_json", "[]").strip()
    try:
        retrieved = _json.loads(retrieved_raw)
        if not isinstance(retrieved, list):
            raise ValueError
    except (ValueError, _json.JSONDecodeError):
        return jsonify({"error": "retrieved_json must be a JSON array"}), 400

    # ── generate ──────────────────────────────────────────────────────────────
    try:
        overview = summary.generate_overview(current_text, retrieved, "")

    except Exception as exc:
        return jsonify({"error": f"Failed to generate overview: {exc}"}), 500

    return jsonify({
        "overview":     overview,
        "current_text": current_text,
    })
 

# ── Startup ───────────────────────────────────────────────────────────────────

def initialize():
    """Load the model and classifier state.

    Runs both for local `python app.py` and under a production WSGI server
    (e.g. gunicorn on Cloud Run), which imports `app:app` and never executes
    the `__main__` block below — so this must NOT live inside it.
    """
    print(f"  Model : {classifier.MODEL_NAME}")
    print("  Loading sentence transformer ...")
    classifier.get_model()
    print("  Model ready.")

    loaded = classifier.load_centroids()
    if not loaded and os.path.exists(MONTHLY_SPENDING_DATASET):
        classifier.load_from_csv(MONTHLY_SPENDING_DATASET)
        classifier.save_centroids()
        print(f"[data] Base model saved to {CENTROIDS_FILE}")
    elif not loaded:
        print("[data] No data source found — starting with empty centroids.")

    print(f"  Categories ({len(classifier.centroids)}): {list(classifier.centroids.keys())}")


# Run at import time so gunicorn workers come up warm and ready.
initialize()


if __name__ == "__main__":
    # Local development server. Cloud Run / gunicorn use the module-level
    # `app` object and the initialize() call above instead.
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  Open http://localhost:{port} in your browser\n")
    app.run(debug=False, host="0.0.0.0", port=port)
