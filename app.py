"""
Flo — Personal Finance Tracker
Flask entry point: app creation, routes, and startup.
"""

import asyncio
import base64
import json
import os
import queue
import re
import threading
import urllib.request

from flask import Flask, render_template, request, jsonify
from flask_sock import Sock

import services.summary as summary
import services.classifier as classifier
import services.receipt as receipt
import services.voice as voice
from services.gemini_utils import ModelOverloadedError
from config import ASK_BELOW, CENTROIDS_FILE, GEMINI_LIVE_MODEL, MONTHLY_SPENDING_DATASET, SERVER_API_KEY, SERVER_PLACES_API_KEY

app  = Flask(__name__)
sock = Sock(app)


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
        or SERVER_API_KEY
    )
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500

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
        data = receipt.scan_receipt(file_data, mime_type, api_key, payment_methods or None)
        return jsonify({"success": True, "data": data})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Receipt processing failed: {str(e)}"}), 500


# ── Voice input API ───────────────────────────────────────────────────────────

@app.route("/api/voice_input", methods=["POST"])
def api_voice_input():
    api_key = (
        request.form.get("api_key", "").strip()
        or SERVER_API_KEY
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
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Voice processing failed: {str(e)}"}), 500


@app.route("/api/voice_summary", methods=["POST"])
def api_voice_summary():
    """Summarise a raw live transcript into a clean purchase note before extraction."""
    api_key = (request.form.get("api_key", "").strip() or SERVER_API_KEY)
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500

    transcript = (request.form.get("transcript", "") or "").strip()
    if not transcript:
        return jsonify({"error": "Empty transcript"}), 400

    try:
        summary = voice.summarize_transcript(transcript, api_key)
        return jsonify({"success": True, "original": transcript, "summary": summary})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Transcript summary failed: {str(e)}"}), 500


@app.route("/api/voice_extract", methods=["POST"])
def api_voice_extract():
    """Extract expense details from a user-confirmed transcript (text only)."""
    api_key = (request.form.get("api_key", "").strip() or SERVER_API_KEY)
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500

    transcript = (request.form.get("transcript", "") or "").strip()
    if not transcript:
        return jsonify({"error": "Empty transcript"}), 400

    try:
        data = voice.process_voice_text(transcript, api_key)
        return jsonify({"success": True, "data": data})
    except ModelOverloadedError as e:
        return jsonify({"error": str(e), "retryable": True}), 503
    except Exception as e:
        return jsonify({"error": f"Voice processing failed: {str(e)}"}), 500


# ── Gemini Live WebSocket ─────────────────────────────────────────────────────

@sock.route('/ws/voice_live')
def voice_live_ws(ws):
    """WebSocket relay: browser audio → Gemini Live → browser transcription."""
    from google import genai
    from google.genai import types as genai_types

    try:
        init     = json.loads(ws.receive())
        api_key  = (init.get('api_key', '').strip()
                    or os.environ.get('GOOGLE_API_KEY', ''))
        pcm_rate = int(init.get('sample_rate', 16000))
        print(f"[Live] WebSocket connection initiated. api_key: {'***' if api_key else 'None'}, sample_rate: {pcm_rate}")
    except Exception as e:
        print(f"[Live] Init error: {e}")
        return

    if not api_key:
        try:
            ws.send(json.dumps({'error': 'No API key configured'}))
        except Exception:
            pass
        return

    mime_type  = f'audio/pcm;rate={pcm_rate}'
    audio_q    = queue.Queue()
    stop_event = threading.Event()

    def _queue_get(q):
        try:
            return q.get(timeout=0.1)
        except queue.Empty:
            return ...

    async def _gemini_session():
        print("[Live] Starting Gemini Session thread...")
        client = genai.Client(api_key=api_key)
        config = genai_types.LiveConnectConfig(
            response_modalities=["AUDIO"],
            input_audio_transcription=genai_types.AudioTranscriptionConfig(),
        )
        try:
            print(f"[Live] Connecting to Gemini Live with model {GEMINI_LIVE_MODEL}...")
            async with client.aio.live.connect(
                model=GEMINI_LIVE_MODEL,
                config=config,
            ) as session:
                print("[Live] Connected to Gemini Live API session successfully!")

                async def _send():
                    loop = asyncio.get_running_loop()
                    while not stop_event.is_set():
                        item = await loop.run_in_executor(None, _queue_get, audio_q)
                        if item is None:
                            print("[Live] Send task: poison pill received, stopping.")
                            break
                        if item is ...:
                            continue
                        try:
                            await session.send_realtime_input(
                                audio=genai_types.Blob(
                                    mime_type=mime_type,
                                    data=item,
                                )
                            )
                        except Exception as e:
                            print(f"[Live] Error sending audio chunk: {e}")
                            break

                async def _recv():
                    loop = asyncio.get_running_loop()
                    transcript = ''
                    try:
                        print("[Live] Receive task started, listening for responses...")
                        while not stop_event.is_set():
                            async for response in session.receive():
                                if stop_event.is_set():
                                    break
                                sc = response.server_content
                                if sc is None:
                                    continue
                                tc = getattr(sc, 'input_transcription', None)
                                if tc and tc.text:
                                    finished = bool(tc.finished)
                                    print(f"[Live] Received input transcription: {tc.text} (finished={finished})")
                                    # Gemini streams incremental fragments (not cumulative)
                                    # and rarely sets finished, so accumulate every chunk.
                                    chunk = re.sub(r'<[^>]*>', '', tc.text)
                                    transcript += chunk
                                    display = re.sub(r'\s+', ' ', transcript).strip()
                                    try:
                                        await loop.run_in_executor(
                                            None,
                                            ws.send,
                                            json.dumps({
                                                'transcript': display,
                                                'finished': finished,
                                            })
                                        )
                                    except Exception as e:
                                        print(f"[Live] Error sending to websocket: {e}")
                                        stop_event.set()
                                        break
                    except Exception as e:
                        print(f"[Live] Error in receive loop: {e}")
                        import traceback
                        traceback.print_exc()

                send_task = asyncio.create_task(_send())
                recv_task = asyncio.create_task(_recv())
                done, pending = await asyncio.wait(
                    [send_task, recv_task],
                    return_when=asyncio.FIRST_COMPLETED,
                )
                for t in pending:
                    t.cancel()
                    try:
                        await t
                    except (asyncio.CancelledError, Exception):
                        pass

        except Exception as exc:
            print(f"[Live] Connection exception: {exc}")
            import traceback
            traceback.print_exc()
            try:
                ws.send(json.dumps({'error': str(exc)}))
            except Exception:
                pass

    def _run_gemini():
        asyncio.run(_gemini_session())

    worker = threading.Thread(target=_run_gemini, daemon=True)
    worker.start()

    chunk_counter = [0]
    try:
        while True:
            try:
                raw = ws.receive()
            except Exception as e:
                print(f"[Live] ws.receive() exception: {e}")
                break
            if raw is None:
                break
            try:
                msg = json.loads(raw)
                msg_type = msg.get('type')
                if msg_type == 'audio':
                    data_len = len(msg.get('data', ''))
                    chunk_counter[0] += 1
                    if chunk_counter[0] % 10 == 1:
                        print(f"[Live] Received audio chunk #{chunk_counter[0]}, length: {data_len}")
                    audio_q.put(base64.b64decode(msg['data']))
                elif msg_type == 'stop':
                    print("[Live] Received stop command from client.")
                    break
                else:
                    print(f"[Live] Received unknown message type: {msg_type}")
            except Exception as e:
                print(f"[Live] Error parsing websocket message: {e}")
                continue
    finally:
        stop_event.set()
        audio_q.put(None)
        worker.join(timeout=5)


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
        "env_key_set":        bool(SERVER_API_KEY),
        "places_server_key":  SERVER_PLACES_API_KEY,
    })

# ── Summary API ──────────────────────────────────────────────────────────────

@app.route("/api/summary/overview", methods=["GET"])
def api_get_overview():
    import json as _json
    from calendar import monthrange
    from datetime import date

    api_key = (
        request.args.get("api_key", "").strip()
        or SERVER_API_KEY
    )
    if not api_key:
        return jsonify({"error": "No Google API key configured. Please add your key in Settings."}), 500
 
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
        overview = summary.generate_overview(current_text, retrieved, api_key)
    except Exception as exc:
        return jsonify({"error": f"Failed to generate overview: {exc}"}), 500

    return jsonify({
        "overview":     overview,
        "current_text": current_text,
    })
 

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
