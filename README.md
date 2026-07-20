# Flo: AI-Powered Personal Finance Tracker

A mobile-style expense and income tracker with on-device merchant categorisation, receipt scanning, voice input, AI spending insights, location autocomplete, custom budgets, recurring expenses, and advanced history filtering, powered by Google Gemini via Vertex AI and Google Cloud Speech APIs.

---

## Setup & Running

Dependencies are declared in [`requirements.txt`](requirements.txt). Pick whichever setup you already have:

| | Command |
|---|---|
| **pip** | `pip install -r requirements.txt && ./scripts/run_and_share.sh` |
| **conda** | `conda create -n flo python=3.14 && conda activate flo && pip install -r requirements.txt && ./scripts/run_and_share.sh` |
| **Docker** | `docker build -t flo . && docker run -p 8080:8080 --env-file .env flo` |

pip/conda serve on http://localhost:5000 (plus a public tunnel URL); Docker on http://localhost:8080.

- **[`./scripts/run_and_share.sh`](scripts/run_and_share.sh)** starts the Flask app and exposes it via [`lt`](https://github.com/localtunnel/localtunnel) (fixed URL, default) or `TUNNEL=cloudflared` ([random URL](https://developers.cloudflare.com/cloudflare-tunnel/), no reminder page), printing a QR code for mobile access. Override the subdomain with `LT_SUBDOMAIN`. Requires `lt`/`cloudflared` plus `qrencode` or Python `qrcode` on `PATH`.
- **Docker** builds a self-contained image ([`Dockerfile`](Dockerfile)) with the HuggingFace model baked in, running gunicorn (threaded, `--timeout 0` so WebSockets survive). For Cloud Run, set `GOOGLE_CLOUD_PROJECT`, grant the service account the Vertex AI User role; it binds to `$PORT` (default `8080`).

### Environment variables

Create a `.env` file in the project root. All AI features run through **Vertex AI**; no Google API key string is needed for Gemini.

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLOUD_PROJECT` | **Yes** | Your GCP project ID. Enables receipt scanning, voice input, and AI spending insights. |
| `GOOGLE_CLOUD_LOCATION` | No | Vertex AI region. Defaults to `us-central1`. |
| `GOOGLE_CLOUD_STT_LOCATION` | No | Speech-to-Text v2 recognizer location for the Chirp 3 model. Defaults to `eu`. Must be `us` or `eu` (Chirp 3 is not available in `global` or single regions). |
| `GOOGLE_PLACES_API_KEY` | No | Google Maps Platform key (`AIza…`). Enables location autocomplete. Without it, the location field is a plain text input. |
| `REQUIRE_PASSWORD` | No | Set to `true` (default) to protect the app with a password, or `false` to leave it open. |
| `APP_PASSWORD` | No | The password shown on the login page. Only used when `REQUIRE_PASSWORD=true`. |
| `SECRET_KEY` | No | Signs the session cookie. Generate with `python -c "import secrets; print(secrets.token_hex(32))"`. A new random key is generated on each restart if not set (logs everyone out on restart). |

Example `.env`:

```bash
# Required
GOOGLE_CLOUD_PROJECT=your-gcp-project-id

# Optional
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_CLOUD_STT_LOCATION=eu
GOOGLE_PLACES_API_KEY=AIza...

# Access control
REQUIRE_PASSWORD=true
APP_PASSWORD=your-secret-password
SECRET_KEY=your-random-hex-string
```

### Authentication

Gemini calls go through **Vertex AI** and use Google's [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials); no API key required.

**Local development**: run once after installing the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install):

```bash
gcloud auth application-default login
```

This saves credentials to `~/.config/gcloud/application_default_credentials.json`. The SDK picks them up automatically on every subsequent run.

**GCP deployment (Cloud Run, GKE, Compute Engine, etc.)**: credentials are provided automatically by the compute metadata server. No extra setup needed beyond ensuring the service account has the required roles and the APIs are enabled:

```bash
gcloud services enable aiplatform.googleapis.com speech.googleapis.com texttospeech.googleapis.com
```

Required IAM roles:
- `roles/aiplatform.user`: Gemini / Vertex AI (receipt OCR, voice extraction, AI overview)
- `roles/speech.client` (or `roles/editor`): Google Cloud Speech-to-Text
- `roles/cloudtexttospeech.client` (or `roles/editor`): Google Cloud Text-to-Speech

### Data Export / Import

From the **Settings** view:

- **Export JSON**: downloads `flo-expenses-YYYY-MM-DD.json` (full transaction array).
- **Export CSV**: downloads `flo-expenses-YYYY-MM-DD.csv`.
- **Import JSON**: merges a previously exported JSON backup into IndexedDB, skipping duplicate IDs.

### Testing

Automated tests live in [`tests/`](tests/) and run with `pytest`, which isn't pinned in `requirements.txt`:

```bash
pip install pytest
pytest tests/ -v -s
```

Deterministic tests (classifier accuracy, API behaviour, access control) always run. Tests marked `live_api` call real Gemini/Vertex AI models and are skipped automatically unless `GOOGLE_CLOUD_PROJECT` and ADC credentials are configured (see [Authentication](#authentication) above). Synthetic receipt fixtures (including adversarial prompt-injection variants) can be regenerated with:

```bash
python tests/data/generate_receipts.py
python tests/data/generate_injection_receipts.py
```

Coverage spans the merchant classifier, receipt OCR, voice extraction, and the AI spending insight (RAG) pipeline, including their resistance to prompt-injection attempts embedded in receipt images or transcripts. Results are written to `tests/results/*.json`; methodology and findings are written up in [`tests/QA_TESTING_REPORT.md`](tests/QA_TESTING_REPORT.md).

---

## Architecture

```
Browser (SPA)  ── IndexedDB ──────────────────────────────────────────────────
    │   expenses · centroids · overrides · settings · budgets · summaries
    │   home layout · payment methods · currencies · recurring templates
    │   pending-scan files · saved receipt images
    │
    │  HTTP/JSON  +  WebSocket (audio)
    ▼
Flask backend  (app.py)
    ├── services/classifier.py
    │     • SentenceTransformer (microsoft/harrier-oss-v1-0.6b) [1]
    │     • Nearest-centroid + cosine similarity
    │     • Online (incremental) centroid updates
    ├── services/receipt.py   ── Gemini (GEMINI_MODELS fallback) (receipt OCR → JSON, incl. tax/VAT lines)
    ├── services/voice.py     ── Gemini (GEMINI_MODELS fallback) (transcript summary + function call → expense fields)
    ├── services/summary.py   ── Gemini (GEMINI_MODELS fallback) (AI overview generation from client-retrieved context)
    ├── services/gemini_utils.py  (retry / model-fallback helpers)
    ├── services/prompts.py       (centralised Gemini prompts & function schemas)
    ├── /ws/voice_live        ── Google Cloud STT (streaming) (live transcript via WebSocket)
    ├── /api/stt              ── Google Cloud STT (batch)     (single-shot audio → transcript)
    └── /api/tts              ── Google Cloud Text-to-Speech  (text → MP3 audio)
    +   Frankfurter API (FX rates)  ·  Google Places API proxy (location autocomplete)
```

The server is **mostly stateless with respect to user data**. Expenses, personalised centroids, overrides, budgets, spending summaries, recurring-expense templates, and home layout all live in the browser's **IndexedDB** (see [Data Stored](#data-stored)); a legacy `localStorage` payload from older installs is migrated in automatically on first load. The server ships a read-only *base model* (`dataset/centroids.json`) that new clients download on first run.

The AI spending overview uses a **client-side RAG pipeline**: monthly summaries are computed and stored client-side, similarity search runs in the browser, and only the Gemini generation call goes to the server. The generated insight is cached client-side and invalidated whenever expenses change.

Gemini calls try each model in `GEMINI_MODELS` ([config.py](config.py)) in order, currently `gemini-3.5-flash` then `gemini-2.5-flash`, falling through automatically if one is unavailable.

Every Gemini prompt that mixes trusted instructions with untrusted user-supplied content (receipt images, voice transcripts, retrieved spending history) explicitly marks that content as data, not instructions, and is tested against prompt-injection attempts (see [Testing](#testing)).

[1] Selected by comparing candidates from the [MTEB leaderboard](https://huggingface.co/spaces/mteb/leaderboard).

---

## Application Views

| View | Purpose |
|------|---------|
| **Home** | Monthly total with trend badge, budget progress, today/week/remaining stats, custom budget cards, 7-day bar chart, income/balance card, category breakdown, 5 most recent transactions; widgets are reorderable and hideable |
| **Add Method** | Entry-point picker: choose Scan Receipt, Voice Log, Manual Entry, or Add Income |
| **Add** | Manual form with auto-classification, income/expense toggle, currency conversion, optional budget tag, and Google Places location autocomplete |
| **Scan** | Receipt scan via camera or file; zoomable receipt preview; background queueing of pending scans |
| **Voice** | Real-time voice recording with live transcript, AI transcript cleanup, and structured field extraction |
| **Verify** | Pre-fill confirmation screen after a receipt scan or voice entry; editable line items |
| **History** | Full chronological transaction list grouped by date; text search; filter sheet (category, payment method, time range, type, sort, custom budget); tap to open / edit / delete detail sheet; toggle to a monthly **calendar view** |
| **Summary** | Spending by category (doughnut chart), last-7-days line chart, and an **AI spending insight** generated with local historical context |
| **Settings** | Hub for app configuration: links to Preferences, Budgets, Categories, and Payment Methods; dark mode toggle; JSON/CSV export & import |
| **Preferences** | Default currency · custom currency codes |
| **Budgets** | Monthly budget limit · custom **Event** budgets (name, amount, optional date range, color) · custom **Category** budgets (per-category limit, color) |
| **Categories** | Add / remove expense categories · add / remove income categories · manage exact-match merchant override rules · reset AI model |
| **Recurring Expenses** | Manage templates that auto-surface as due on a chosen day of the month; each due item is confirmed, modified, or snoozed from the Notifications panel rather than being inserted silently |
| **Payment Methods** | Add / remove payment methods and their display emojis |
| **Notifications** *(bell-icon overlay, not a bottom-nav view)* | Consolidates background receipt/voice scans (processing / ready / failed) and due recurring expenses into one panel; badge count and a spinner reflect in-flight work |

---

## Processes

### 1. Server Startup

1. The `microsoft/harrier-oss-v1-0.6b` SentenceTransformer model is loaded into memory.
2. If `dataset/centroids.json` exists, base centroids and overrides are loaded from it.
3. Otherwise, if `dataset/monthly_spending_2024.csv` exists, base centroids are computed (merchant names → embeddings → per-category mean vectors) and saved to JSON.
4. Otherwise the classifier starts empty (every merchant falls through to "Others").

### 2. Manual Expense / Income Entry

1. User opens the **Add Method** picker and selects **Manual Entry** or **Add Income**.
2. User types a **merchant / source name** and leaves the field. For expenses, the client posts its own centroids to `POST /api/classify`.
3. The server embeds the name, computes cosine similarity against the **client-supplied** centroids, and returns a prediction, confidence (0–1), top-3 candidates, and `needs_review` flag.
4. If confidence is below `ASK_BELOW = 0.80`, the frontend highlights the category selector for manual confirmation.
5. User fills in amount, currency (with live FX conversion if not the default), date, category, payment method, optional notes, location, and optionally tags the transaction to a **custom budget**.
6. On submit, `POST /api/learn` updates the user's local centroid (returned in the response and re-saved), then the transaction is persisted to IndexedDB.

### 3. Receipt Scanning

1. User selects **Scan Receipt** from the Add Method picker, then takes a photo or picks an image/PDF from the gallery. Receipts can also be queued as **pending scans** from the Home screen; the full-resolution file is kept in IndexedDB so an in-flight scan survives a page refresh.
2. `POST /api/scan_receipt` sends the file (multipart/form-data) to the server, which calls Gemini via Vertex AI (see `GEMINI_MODELS` fallback).
3. The server forwards the file with a structured prompt that requests a strict JSON receipt schema. The prompt also instructs Gemini to treat the printed merchant, total, and item prices as the transaction record and to ignore any text on the document that claims a printed value should be replaced, a defense against receipts crafted to inject instructions into the extraction.
4. Gemini returns extracted fields (merchant, date, total, currency, payment method, items, location). Missing date defaults to today. A printed tax/VAT/GST line (e.g. "Tax", "MwSt", "USt") is extracted as its own line item rather than folded into another item or dropped; per-item discounts are subtracted into that item's price and summarised in `notes`.
5. The extracted merchant is classified by the same ML pipeline.
6. The **Verify** screen shows pre-filled fields and editable line items for user confirmation before saving. Once saved, the original receipt image is kept permanently in IndexedDB (keyed by expense id) so History can display it later.

### 4. Voice Input

Voice recording uses the browser's **AudioContext** to capture 16 kHz PCM audio, streamed over a WebSocket to the server.

**Streaming transcription** (`/ws/voice_live`):
1. The browser opens a WebSocket and sends raw PCM chunks as base64-encoded JSON messages.
2. The server feeds the chunks into a **Google Cloud Speech-to-Text** `streaming_recognize` session with `interim_results=True`.
3. Interim results (partial phrases) and final results are sent back over the WebSocket in real-time, displayed as live subtitles in the UI.

After the user stops recording, the transcript goes through a three-step pipeline:
1. `POST /api/voice_summary`: Gemini cleans the raw transcript (fixes mis-hearings, drops filler, resolves self-corrections) and returns a concise purchase note.
2. The clean summary is shown for the user to confirm or edit.
3. `POST /api/voice_extract`: Gemini extracts structured expense/income fields from the confirmed text via function calling. The transcript is treated as untrusted spoken content: the model is instructed to ignore phrases that look like instructions or authority claims (e.g. "ignore previous instructions", "system override") rather than acting on them, and to distinguish a genuine spoken self-correction (a small adjustment to the same transaction) from an attempt to swap in an unrelated merchant, amount, or transaction type.

If the speech didn't describe a real transaction at all (a microphone test, silence, background chatter), the model reports `is_transaction: false`, the server responds with `error_code: "no_expense_found"`, and the frontend lets the user jump back into editing the transcript instead of creating a bogus entry.

If the transcript mentions a named trip or occasion (e.g. "Bangkok trip"), Gemini can match it against the user's active **event budgets** and return an `event_hint`; the Verify/Add form pre-selects that budget tag automatically when a match is found.

The extracted merchant runs through the classifier identically to a receipt scan, and the pre-filled fields land on the **Verify** screen.

### 5. Online ML Learning (client-personalised)

Each `POST /api/learn` carries the client's current centroids/overrides:

1. The embedding for the merchant is taken from a per-request cache (populated by the prior `/api/classify`), or recomputed.
2. The category's centroid is updated with an **incremental running average**:
   ```
   new_centroid = (old_centroid · n + embedding) / (n + 1)
   ```
   The result is L2-normalised and `n` is incremented.
3. If the user **corrected** the predicted category, the lowercased merchant name is added to `overrides`; future classifications of that exact name return the corrected category with confidence 1.0. (Centroid updates are skipped when an override already covers the merchant.)
4. The updated `{categories, overrides}` payload is returned and written back under the `flo_centroids` key.

### 6. Custom Budgets

Custom budgets are defined in the **Budgets** settings view and stored under the `flo_custom_budgets` key.

- **Event budgets**: a name, a spend limit, an optional date range (start / end), and a color. Spending is summed from all expense transactions tagged with the budget's ID in the chosen date window.
- **Category budgets**: a name, a spend limit, a target category, and a color. Spending is summed from all expense transactions in that category for the current month.
- Transactions can be tagged to a budget at the time of entry via the optional **budget tag** drop-down in the Add / Edit form (stored as `budgetId` on the transaction), or automatically from a voice entry that names a matching event (see [Voice Input](#4-voice-input)).
- The Home screen shows a **Custom Budgets widget** with a progress bar per budget; the History filter sheet lets the user filter by budget.

### 7. Location Autocomplete

When `GOOGLE_PLACES_API_KEY` is set, the server proxies all Google Places calls; the API key never reaches the browser. The Add / Edit forms offer:

- **Near me**: uses `navigator.geolocation`, posts to `/api/places/nearby`, and lists nearby establishments.
- **Type-ahead**: debounced text search posted to `/api/places/text_search`, biased to the cached position.

### 8. Currency Conversion

The home/summary views aggregate across multi-currency transactions. The frontend fetches rates via `GET /api/exchange_rates?base=<DEFAULT>`, which proxies the [Frankfurter](https://www.frankfurter.app) API. Rates are cached per base currency under `flo_rates_<BASE>`. The `rate` field on each transaction stores the exchange rate at the time of entry so historical totals remain accurate if the default currency changes later; conversions consistently use this stored rate rather than the live rate so past totals don't drift when the default currency or live rates change.

### 9. AI Spending Overview (Client-side RAG)

The **Summary** view generates a personalised insight by comparing the current month's spending to similar past months. The pipeline runs entirely in the browser until the final generation call:

1. **Auto-archiving**: on load, `rebuildSummariesFromExpenses()` computes per-category totals for every completed past month from the expense history and upserts them into `flo_summaries`. No manual archiving step is required.
2. **Manual archive**: the Summary view also exposes an **Archive current month** action that immediately snapshots the current month's breakdown into `flo_summaries`, useful for mid-month comparisons.
3. **Similarity retrieval**: `retrieveSimilarSummaries()` projects the current spending onto a normalised category vector and computes cosine similarity against stored month vectors entirely in JavaScript. The top-2 nearest neighbours are passed as `retrieved_json` to the server.
4. `GET /api/summary/overview` receives the current spending breakdown, days elapsed, and pre-retrieved context, then asks Gemini to write a 2-3 sentence insight comparing this month to the retrieved months. The prompt marks the retrieved history and budget context as untrusted data and tells the model not to treat embedded instructions or implausible outlier figures within it as legitimate.
5. As a safety net independent of prompt wording, the server checks that every € figure in the generated text is close to a number derivable from the trusted input data (or a simple sum/difference of two such numbers). If not, it retries once with a stricter instruction, then falls back to a deterministic, no-LLM-call summary built only from the current month's figures, so a fabricated or injected figure can never reach the user.
6. The insight and the periods it was based on are displayed in the AI card, and cached under `flo_ai_overview_cache` so reopening Summary doesn't re-call Gemini. The cache is cleared whenever expenses change (`saveExpenses()`), so the next visit regenerates a fresh insight.

### 10. Gemini Retry & Model Fallback

All Gemini calls go through `services/gemini_utils.py`:

- **`generate_with_retry`**: retries once on transient overload/rate-limit errors with exponential backoff, then raises `ModelOverloadedError` (which surfaces as an HTTP 503 with `"retryable": true`).
- **`generate_with_fallback`**: tries each model in `GEMINI_MODELS` in order (`gemini-3.5-flash` → `gemini-2.5-flash`), falling through on failure, so a degraded model never blocks the user.

### 11. Recurring Expenses

Recurring templates are managed from **Settings → Recurring Expenses** and stored under `flo_recurring`. Each template has a merchant, amount, currency, category, optional payment method/notes, and a `day_of_month` (clamped to the last day of shorter months).

1. On every app load, `getDueRecurring()` filters templates that are enabled, not yet generated for the current month (`last_generated` ≠ this year-month), not currently snoozed, and whose `day_of_month` has passed.
2. Due templates do **not** auto-insert an expense; they surface in the **Notifications** panel for the user to **Confirm** (records this month's expense and marks it generated), **Modify** (opens the Add form pre-filled, with a choice to apply the change just this once or to the template going forward), or **Remind later** (snoozes for a chosen number of days via `snoozed_until`).
3. A confirmed occurrence is written to `flo_expenses` with `source: "recurring"`, `confidence: 1.0`, and no FX rate conversion.

### 12. Notifications Center

The bell icon in the header opens a single panel that merges two kinds of pending work (previously split across the Home screen and a separate processing indicator):

- **Pending scans** (`flo_pending_scans`): receipts and voice inputs queued for background AI extraction, grouped by status: *Processing* (spinner), *Ready to Review* (tap to open **Verify**), and *Failed* (tap **Retry**). A spinner badge on the bell reflects any scan still processing.
- **Recurring Due**: see [Recurring Expenses](#11-recurring-expenses) above, with inline Confirm / Modify / Remind-later actions.

The badge count is `ready scans + due recurring items`; opening/closing the panel and any state change re-renders it live.

---

## Data Stored

### Server: `dataset/centroids.json`

The shared base model used to bootstrap new clients. After bootstrap, each browser maintains its own copy under `flo_centroids`.

| Field | Type | Description |
|-------|------|-------------|
| `model` | string | SentenceTransformer model name |
| `threshold` | float | Minimum cosine similarity to assign a category (below → "Others") |
| `categories` | object | Map of category name → `{centroid: float[], n: int}` |
| `categories[*].centroid` | float[] | 768-dimensional normalised mean embedding vector |
| `categories[*].n` | int | Number of training examples that built this centroid |
| `overrides` | object | Map of lowercased merchant name → category string (exact-match shortcuts) |

**Built-in expense categories:** Banking & Fees, Entertainment & Subscriptions, Food & Beverage, Groceries, Health & Wellness, Home & Living, Personal Care, Pet Supplies, Shopping, Transport, Others.

---

### Browser: IndexedDB

All persistent client-side state lives in one IndexedDB database, `flo_files` (see `static/js/app.js`), with three object stores:

| Store | Keyed by | Contents |
|-------|----------|----------|
| `kv_store` | string key | Everything that used to live in `localStorage`: expenses, centroids, budgets, preferences, caches, etc. (see table below). Read via an in-memory `_kvCache` hydrated once at boot (`hydrateKvCache()`) so reads stay synchronous; writes go to IndexedDB in the background. |
| `pending_files` | scan id | Full-resolution `File`/`Blob` for a receipt scan still queued/processing, so a page refresh doesn't lose the upload mid-scan. |
| `expense_receipts` | expense id | The original receipt image, kept permanently once an expense is saved, so History can redisplay it later. |

On first load after an upgrade, any legacy `localStorage` keys (from installs predating the IndexedDB migration) are copied into `kv_store` and then removed from `localStorage`.

#### `flo_expenses` (in `kv_store`)

A JSON array of transaction objects. Each object has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique identifier |
| `type` | string | `"expense"` (default) or `"income"` |
| `date` | string (YYYY-MM-DD) | Transaction date |
| `merchant` | string | Merchant / store name (expenses) or income source |
| `amount` | number | Total amount (2 d.p.) |
| `currency` | string | 3-letter ISO code (e.g. `EUR`) |
| `rate` | number \| null | FX rate from `currency` to default currency at time of entry (null if same currency) |
| `category` | string | Assigned category |
| `confidence` | number | ML confidence at time of classification (0–1) |
| `payment_method` | string \| null | Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer, … |
| `notes` | string | Optional free-text note (also used for short discount tags on receipt scans, e.g. `"Milk -€0.50"`) |
| `location` | string | Optional address/place label from Places autocomplete |
| `items` | array | Line items: `[{name, price, quantity}]` (from receipt or voice; a tax/VAT line appears here too if the receipt printed one; empty for manual) |
| `source` | string | `"manual"`, `"receipt"`, `"voice"`, or `"recurring"` |
| `budgetId` | string \| null | ID of the custom budget this expense is tagged to (expenses only) |
| `created_at` | string (ISO 8601) | Timestamp when the record was saved |

#### Other `kv_store` keys

| Key | Value | Description |
|-----|-------|-------------|
| `flo_centroids` | JSON | Per-user personalised classifier state (same shape as `dataset/centroids.json`) |
| `flo_payment_methods` | JSON array | User-managed payment-method list |
| `flo_payment_emojis` | JSON object | Map of payment method name → emoji |
| `flo_custom_currencies` | JSON array | Extra ISO currency codes added by the user |
| `flo_rates_<BASE>` | JSON | Cached FX-rate snapshot keyed by base currency |
| `flo_budget` | string | Monthly budget limit (numeric, in default currency) |
| `flo_custom_budgets` | JSON array | Custom event/category budget definitions `[{id, name, type, amount, start?, end?, category?, color}]` |
| `flo_pending_scans` | JSON array | Receipts/voice inputs queued for background scanning, surfaced in the Notifications panel; full-res files live in the `pending_files` IndexedDB store |
| `flo_recurring` | JSON array | Recurring expense templates `[{id, merchant, amount, currency, category, payment_method?, notes?, day_of_month, enabled, last_generated, snoozed_until?}]` |
| `flo_summaries` | JSON array | Monthly spending summaries for AI overview RAG `[{period, text, spending}]` |
| `flo_ai_overview_cache` | JSON | Cached `{overview, basedOnText}` from the last AI overview generation; cleared whenever expenses change |
| `flo_income_categories` | JSON array | User-added custom income category names |
| `flo_income_emojis` | JSON object | Map of income category name → emoji |
| `flo_home_layout` | JSON | Widget visibility and order for the Home screen |
| `darkMode` | `"0"` or `"1"` | UI theme preference |
| `defaultCurrency` | string | Default 3-letter currency code shown in the Add form |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Serves the single-page app (`index.html`) |
| `GET`  | `/login` | Login page (when `REQUIRE_PASSWORD=true`) |
| `GET`  | `/logout` | Clears the session and redirects to login |
| `GET`  | `/api/categories` | Returns base-model categories and per-category sample counts |
| `GET`  | `/api/base_centroids` | Returns the read-only base model so new browsers can bootstrap `flo_centroids` |
| `POST` | `/api/classify` | Classifies a merchant name. Body may include the client's `categories` + `overrides`. |
| `POST` | `/api/learn` | Updates the (client's) centroid and overrides. Returns the new state. |
| `POST` | `/api/scan_receipt` | Scans a receipt image or PDF; multipart with `file` or `image` |
| `POST` | `/api/voice_input` | Processes a recorded audio blob via Gemini function calling; multipart with `audio` |
| `POST` | `/api/voice_summary` | Summarises a raw live transcript into a clean purchase note; form field `transcript` |
| `POST` | `/api/voice_extract` | Extracts expense fields from a confirmed transcript (text only); form fields `transcript`, optional `event_budgets` (JSON array of active event-budget names to match against) |
| `POST` | `/api/stt` | Single-shot speech-to-text via Google Cloud STT; multipart with `audio` |
| `POST` | `/api/tts` | Synthesises text to MP3 audio via Google Cloud TTS; JSON body `{text, language_code?, voice_name?}` |
| `WS`   | `/ws/voice_live` | Streaming speech-to-text via Google Cloud STT; sends PCM chunks, receives `{transcript, is_final}` |
| `GET`  | `/api/exchange_rates?base=EUR` | Proxies the Frankfurter FX-rates API |
| `GET`  | `/api/settings` | Returns `{vertex_ai_configured, env_key_set, places_key_set}` |
| `POST` | `/api/places/text_search` | Server-side proxy for Google Places text search |
| `POST` | `/api/places/nearby` | Server-side proxy for Google Places nearby search |
| `GET`  | `/api/summary/overview` | Generates an AI spending insight via Gemini; receives current spending + pre-retrieved historical context as query params |

---

## Project Layout

```
financial_app/
├── app.py                    Flask app + routes + WebSocket relay
├── config.py                 Env vars, model names, thresholds, file paths
├── requirements.txt          Pip dependencies (used locally and by Docker)
├── Dockerfile                Container build for Cloud Run / Docker
├── pytest.ini                 Pytest config (markers, test paths)
├── scripts/
│   └── run_and_share.sh      Local + localtunnel + QR sharing helper
├── services/
│   ├── classifier.py         SentenceTransformer + nearest-centroid + online learning
│   ├── receipt.py            Gemini receipt OCR → structured JSON
│   ├── voice.py              Gemini voice → transcript summary → function-call → expense fields
│   ├── summary.py            Gemini overview generation (context supplied by client) + numeric-grounding safety net
│   ├── gemini_utils.py       Retry + model-fallback helpers for Gemini calls
│   └── prompts.py            Centralised Gemini prompts and function-call schemas
├── dataset/
│   ├── centroids.json        Shared base model (generated)
│   ├── monthly_spending_2024.csv   Seed dataset for initial centroids
│   └── student_germany_finance_2025_2026.json  Sample transaction export (not read by the app; for demoing import)
├── tests/
│   ├── conftest.py               Shared fixtures (live_api gating, model warm-up)
│   ├── helpers.py                 Shared test utilities
│   ├── test_classifier_accuracy.py, test_classifier_learning.py   Merchant classifier evals
│   ├── test_receipt_ocr.py        Receipt OCR accuracy against synthetic golden set
│   ├── test_voice_extraction.py   Voice function-calling extraction accuracy
│   ├── test_rag_insight.py        AI spending insight groundedness
│   ├── test_multimodal_injection.py   Prompt-injection resistance (receipts + voice)
│   ├── test_api_deterministic.py  Flask API / access-control tests
│   ├── test_performance.py        Latency benchmarks
│   ├── data/                      Golden-set generators and fixtures (receipts, voice transcripts, RAG scenarios)
│   ├── results/                   JSON output from the latest test run
│   └── QA_TESTING_REPORT.md       Methodology and results write-up
├── templates/
│   ├── index.html            Single-page app shell
│   ├── login.html            Password-gate login page
│   └── partials/
│       ├── nav.html              Bottom navigation bar
│       ├── overlays.html         Toast, confirm dialog, notifications panel, home customise sheet
│       ├── view_home.html        Home screen widgets
│       ├── view_add_method.html  Transaction type picker
│       ├── view_add.html         Manual entry form (also reused for recurring-expense create/edit)
│       ├── view_scan.html        Receipt scan / camera / gallery
│       ├── view_voice.html       Voice recording + transcript UI
│       ├── view_verify.html      Pre-save confirmation + line-item editor
│       ├── view_history.html     Transaction list + calendar + filter sheet
│       ├── view_summary.html     Charts + AI insight card
│       ├── view_settings.html    Settings hub
│       ├── view_preferences.html Currency preferences
│       ├── view_budgets.html     Monthly + custom budget management
│       ├── view_categories.html  Expense/income categories + overrides + AI model
│       ├── view_payment_methods.html  Payment method management
│       └── view_recurring.html   Recurring expense template list
└── static/
    ├── css/styles.css
    └── js/app.js             SPA logic, IndexedDB, FX, Places, voice, charts, budgets, recurring, notifications
```

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `flask`, `flask-sock` | HTTP server + WebSocket for live voice transcription |
| `gunicorn` | Production WSGI server (threaded, `--timeout 0` for WebSockets) |
| `sentence-transformers` | Multilingual text embeddings for classification |
| `numpy`, `scikit-learn` | Vector arithmetic + cosine similarity |
| `pandas` | CSV loading for initial centroid computation |
| `google-genai` | Gemini SDK (receipt OCR, voice function-calling, AI overview generation) |
| `google-cloud-speech` | Google Cloud Speech-to-Text (streaming + batch voice transcription) |
| `google-cloud-texttospeech` | Google Cloud Text-to-Speech (available via API) |
| `python-dotenv` | `.env` loading for environment variables |
| `qrcode` | Terminal QR for the localtunnel sharing script |

`pytest` (not pinned in `requirements.txt`, installed separately, see [Testing](#testing)) runs the suite in `tests/`.
