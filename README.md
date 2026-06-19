# Flo — AI-Powered Personal Finance Tracker

A mobile-style expense and income tracker with on-device merchant categorisation, receipt scanning, voice input, AI spending insights, and location autocomplete — all powered by Google Gemini via Vertex AI.

---

## Architecture

```
Browser (SPA)  ── localStorage ──────────────────────────────────────────────
    │   expenses · centroids · overrides · settings · budget · home layout
    │
    │  HTTP/JSON  +  WebSocket (audio)
    ▼
Flask backend  (app.py)
    ├── services/classifier.py
    │     • SentenceTransformer (paraphrase-multilingual-mpnet-base-v2)
    │     • Nearest-centroid + cosine similarity
    │     • Online (incremental) centroid updates
    ├── services/receipt.py   ── Gemini 2.5 Flash       (receipt OCR → JSON)
    ├── services/voice.py     ── Gemini 2.5 Flash       (voice → transcript summary → function call)
    ├── services/summary.py   ── ChromaDB + Gemini      (monthly spending RAG overview)
    ├── services/gemini_utils.py  (retry / model-fallback helpers)
    ├── services/prompts.py       (centralised Gemini prompts & function schemas)
    └── /ws/voice_live        ── Gemini Live API        (streaming transcription)
    +   Frankfurter API (FX rates)  ·  Google Places API proxy (location autocomplete)
```

The server is **mostly stateless with respect to user data**. Expenses, personalised centroids, overrides, budget, and home layout all live in the browser's `localStorage`. The server ships a read-only *base model* (`dataset/centroids.json`) that new clients download on first run. The one server-side store is `flo_db/` — a ChromaDB database that persists the AI spending overview's monthly-summary vectors.

---

## Application Views

| View | Purpose |
|------|---------|
| **Home** | Today's total, this-month total, 7-day bar chart, monthly income/balance card, budget progress, category breakdown, 5 most recent transactions; widgets are reorderable and hideable |
| **Add** | Receipt scan • Voice input • Manual form with auto-classification, income/expense toggle, currency conversion, and Google Places location autocomplete |
| **History** | Full chronological transaction list grouped by date; tap to open / edit detail sheet; toggle to a monthly **calendar view** |
| **Summary** | Spending by category (doughnut chart), last-7-days line chart, and an **AI spending overview** generated from historical context |
| **Settings** | Dark mode · Default & custom currencies · JSON/CSV export & import · Reset model |
| **Categories** | Add / remove expense categories (drive classification) and **income categories** |
| **Category Overrides** | Manage exact-match `merchant → category` rules |
| **Payment Methods** | Add / remove payment methods and their display emojis |

---

## Processes

### 1. Server Startup

1. The `paraphrase-multilingual-mpnet-base-v2` SentenceTransformer model is loaded into memory.
2. If `dataset/centroids.json` exists, base centroids and overrides are loaded from it.
3. Otherwise, if `dataset/monthly_spending_2024.csv` exists, base centroids are computed (merchant names → embeddings → per-category mean vectors) and saved to JSON.
4. Otherwise the classifier starts empty (every merchant falls through to "Others").

### 2. Manual Expense / Income Entry

1. User selects **expense** or **income**, types a **merchant / source name**, and leaves the field — for expenses, the client posts its own centroids to `POST /api/classify`.
2. The server embeds the name, computes cosine similarity against the **client-supplied** centroids, and returns a prediction, confidence (0–1), top-3 candidates, and `needs_review` flag.
3. If confidence is below `ASK_BELOW = 0.6`, the frontend highlights the category selector for manual confirmation.
4. User fills in amount, currency (with live FX conversion if not the default), date, category, payment method, optional notes, and optional location.
5. On submit, `POST /api/learn` updates the user's local centroid (returned in the response and re-saved to `localStorage`), then the transaction is persisted to `localStorage`.

### 3. Receipt Scanning

1. User takes a photo or drops an image/PDF into the **Add** view (receipts can also be queued as **pending scans** from the Home screen).
2. `POST /api/scan_receipt` sends the file (multipart/form-data) to the server, which calls Gemini via Vertex AI.
3. The server forwards the file to **Gemini 2.5 Flash** with a structured prompt that requests a strict JSON receipt schema.
4. Gemini returns extracted fields (merchant, date, total, currency, payment method, items, location). Missing date defaults to today.
5. The extracted merchant is classified by the same ML pipeline.
6. Pre-filled form fields are shown for user confirmation before saving.

### 4. Voice Input

There are two voice flows; the client picks one based on browser capability:

- **Streaming live transcription** (`/ws/voice_live`) — the browser streams 16 kHz PCM audio over a WebSocket. The server opens a Gemini Live session and relays incremental input transcripts back to the browser for a live subtitle.
- **Batch processing** (`POST /api/voice_input`) — after recording, the audio blob is uploaded; Gemini 2.5 Flash is called with an `add_expense` **function declaration** and extracts all fields via function calling.

After live transcription, the raw transcript goes through a **summary step**:
1. `POST /api/voice_summary` sends the raw transcript to Gemini, which produces a clean, corrected note (fixes mis-hearings, resolves self-corrections, drops filler).
2. The clean summary is displayed for the user to confirm or edit.
3. `POST /api/voice_extract` sends the confirmed text back to Gemini for structured expense/income extraction.

The extracted merchant runs through the classifier identically to a receipt scan.

### 5. Online ML Learning (client-personalised)

Each `POST /api/learn` carries the client's current centroids/overrides:

1. The embedding for the merchant is taken from a per-request cache (populated by the prior `/api/classify`), or recomputed.
2. The category's centroid is updated with an **incremental running average**:
   ```
   new_centroid = (old_centroid · n + embedding) / (n + 1)
   ```
   The result is L2-normalised and `n` is incremented.
3. If the user **corrected** the predicted category, the lowercased merchant name is added to `overrides` — future classifications of that exact name return the corrected category with confidence 1.0. (Centroid updates are skipped when an override already covers the merchant.)
4. The updated `{categories, overrides}` payload is returned and written back to `localStorage` under `flo_centroids`.

### 6. Location Autocomplete

When `GOOGLE_PLACES_API_KEY` is set, the server proxies all Google Places calls — the API key never reaches the browser. The Add / Edit forms offer:

- **Near me** — uses `navigator.geolocation`, posts to `/api/places/nearby`, and lists nearby establishments.
- **Type-ahead** — debounced text search posted to `/api/places/text_search`, biased to the cached position.

### 7. Currency Conversion

The home/summary views aggregate across multi-currency transactions. The frontend fetches rates via `GET /api/exchange_rates?base=<DEFAULT>`, which proxies the [Frankfurter](https://www.frankfurter.app) API. Rates are cached in `localStorage` per base currency.

### 8. AI Spending Overview (RAG)

The **Summary** view generates a personalised 2–3 sentence overview by comparing the current month's spending to similar past months:

1. When a month ends (or manually), the frontend posts `POST /api/summary/store` with the period label, a text description, and category totals.
2. The server projects the spending vector (normalised per-category amounts) and stores it in a **ChromaDB** collection (`flo_db/`).
3. On the Summary view, `GET /api/summary/overview` retrieves the most similar stored months (nearest-neighbour on spending vectors), builds a context prompt, and asks Gemini to write the overview.
4. The overview and the periods it was based on are displayed in the AI card.

### 9. Gemini Retry & Model Fallback

All Gemini calls go through `services/gemini_utils.py`:

- **`generate_with_retry`** — retries once on transient overload/rate-limit errors with exponential backoff, then raises `ModelOverloadedError` (which surfaces as an HTTP 503 with `"retryable": true`).
- **`generate_with_fallback`** — tries each model in `GEMINI_MODELS` in order, falling through on failure, so a degraded model never blocks the user.

---

## Data Stored

### Server — `dataset/centroids.json`

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

### Server — `flo_db/` (ChromaDB)

Persistent vector database for the AI spending overview. Stores one document per completed month: a text description and a normalised per-category spending vector. Used for nearest-neighbour retrieval in `GET /api/summary/overview`.

---

### Browser — `localStorage`

#### `flo_expenses`

A JSON array of transaction objects. Each object has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique identifier |
| `type` | string | `"expense"` (default) or `"income"` |
| `date` | string (YYYY-MM-DD) | Transaction date |
| `merchant` | string | Merchant / store name (expenses) or income source |
| `amount` | number | Total amount (2 d.p.) |
| `currency` | string | 3-letter ISO code (e.g. `EUR`) |
| `category` | string | Assigned category |
| `confidence` | number | ML confidence at time of classification (0–1) |
| `payment_method` | string \| null | Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer, … |
| `notes` | string | Optional free-text note |
| `location` | string | Optional address/place label from Places autocomplete |
| `items` | array | Line items: `[{name, price, quantity}]` (from receipt or voice; empty for manual) |
| `source` | string | `"manual"`, `"receipt"`, or `"voice"` |
| `created_at` | string (ISO 8601) | Timestamp when the record was saved |

#### Other localStorage keys

| Key | Value | Description |
|-----|-------|-------------|
| `flo_centroids` | JSON | Per-user personalised classifier state (same shape as `dataset/centroids.json`) |
| `flo_payment_methods` | JSON array | User-managed payment-method list |
| `flo_payment_emojis` | JSON object | Map of payment method name → emoji |
| `flo_custom_currencies` | JSON array | Extra ISO currency codes added by the user |
| `flo_rates_<BASE>` | JSON | Cached FX-rate snapshot keyed by base currency |
| `flo_budget` | string | Monthly budget limit (numeric, in default currency) |
| `flo_pending_scans` | JSON array | Receipts queued for background scanning from the Home screen |
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
| `POST` | `/api/voice_extract` | Extracts expense fields from a confirmed transcript (text only); form field `transcript` |
| `WS`   | `/ws/voice_live` | Streaming voice transcription via the Gemini Live API |
| `GET`  | `/api/exchange_rates?base=EUR` | Proxies the Frankfurter FX-rates API |
| `GET`  | `/api/settings` | Returns `{vertex_ai_configured, env_key_set, places_key_set}` |
| `POST` | `/api/places/text_search` | Server-side proxy for Google Places text search |
| `POST` | `/api/places/nearby` | Server-side proxy for Google Places nearby search |
| `POST` | `/api/summary/store` | Stores a monthly spending summary vector in ChromaDB |
| `GET`  | `/api/summary/overview` | Retrieves similar past months and generates an AI overview via Gemini |

---

## Setup & Running

Dependencies are declared in [`environment.yml`](environment.yml) (conda + pip) and [`requirements.txt`](requirements.txt) (pip only, used by Docker).

```bash
conda env create -f environment.yml
conda activate gen_ai_test
python app.py
# Open http://localhost:5000
```

### Environment variables

Create a `.env` file in the project root. All AI features run through **Vertex AI** — no Google API key string is needed for Gemini.

| Variable | Required | Description |
|----------|----------|-------------|
| `GOOGLE_CLOUD_PROJECT` | **Yes** | Your GCP project ID. Enables receipt scanning, voice input, and AI spending insights. |
| `GOOGLE_CLOUD_LOCATION` | No | Vertex AI region. Defaults to `us-central1`. |
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
GOOGLE_PLACES_API_KEY=AIza...

# Access control
REQUIRE_PASSWORD=true
APP_PASSWORD=your-secret-password
SECRET_KEY=your-random-hex-string
```

### Authentication

Gemini calls go through **Vertex AI** and use Google's [Application Default Credentials (ADC)](https://cloud.google.com/docs/authentication/application-default-credentials) — no API key required.

**Local development** — run once after installing the [Google Cloud SDK](https://cloud.google.com/sdk/docs/install):

```bash
gcloud auth application-default login
```

This saves credentials to `~/.config/gcloud/application_default_credentials.json`. The SDK picks them up automatically on every subsequent run.

**GCP deployment (Cloud Run, GKE, Compute Engine, etc.)** — credentials are provided automatically by the compute metadata server. No extra setup needed beyond ensuring the service account has the **Vertex AI User** role (`roles/aiplatform.user`) and the Vertex AI API is enabled:

```bash
gcloud services enable aiplatform.googleapis.com
```

### Docker / Cloud Run

A [`Dockerfile`](Dockerfile) is included for containerised deployment. The HuggingFace model is baked into the image to avoid cold-start downloads. The container runs **gunicorn** with a threaded worker to support WebSocket connections.

```bash
docker build -t flo .
docker run -p 8080:8080 --env-file .env flo
```

For Cloud Run, set `GOOGLE_CLOUD_PROJECT` as an environment variable and grant the service account the Vertex AI User role. The gunicorn command in the `Dockerfile` binds to `$PORT` (default `8080`) and sets `--timeout 0` so long-lived Gemini Live WebSocket connections are not killed.

### Share over a tunnel

[`run_and_share.sh`](run_and_share.sh) starts the app, exposes it through a public tunnel, and prints a QR code for quick mobile access:

```bash
./run_and_share.sh
```

By default it uses [`lt`](https://github.com/localtunnel/localtunnel) with a fixed subdomain, giving a **stable URL** (`https://myfloapp-tum.loca.lt`) across runs. Override the subdomain with `LT_SUBDOMAIN`, or switch to a [`cloudflared`](https://developers.cloudflare.com/cloudflare-tunnel/) quick tunnel (no reminder page, but a **random URL** each run) with `TUNNEL=cloudflared`:

```bash
LT_SUBDOMAIN=my-custom-name ./run_and_share.sh   # fixed lt URL
TUNNEL=cloudflared ./run_and_share.sh            # random, no reminder page
```

Requires one of those tunnel tools plus one of `qrencode` / Python `qrcode` on `PATH`.

> With `lt`, browser visitors may see localtunnel's reminder page once per public IP (every 7 days). Programmatic callers can bypass it with a `bypass-tunnel-reminder` request header (any value) or a non-standard `User-Agent`. Those are request headers, so they don't help a fresh browser navigation — use `TUNNEL=cloudflared` to avoid the page entirely (at the cost of a fixed URL).

### Data Export / Import

From the **Settings** view:

- **Export JSON** — downloads `flo-expenses-YYYY-MM-DD.json` (full transaction array).
- **Export CSV** — downloads `flo-expenses-YYYY-MM-DD.csv`.
- **Import JSON** — merges a previously exported JSON backup into `localStorage`, skipping duplicate IDs.
- **Reset to Base Model** — discards the browser's personalised centroids and re-downloads the server's base model.

---

## Project Layout

```
financial_app/
├── app.py                    Flask app + routes + WebSocket relay
├── config.py                 Env vars, model names, thresholds, file paths
├── environment.yml           Conda + pip dependencies
├── requirements.txt          Pip-only dependencies (used by Docker)
├── Dockerfile                Container build for Cloud Run / Docker
├── run_and_share.sh          Local + localtunnel + QR sharing helper
├── services/
│   ├── classifier.py         SentenceTransformer + nearest-centroid + online learning
│   ├── receipt.py            Gemini receipt OCR → structured JSON
│   ├── voice.py              Gemini voice → transcript summary → function-call → expense fields
│   ├── summary.py            ChromaDB monthly-summary store + RAG overview generation
│   ├── gemini_utils.py       Retry + model-fallback helpers for Gemini calls
│   └── prompts.py            Centralised Gemini prompts and function-call schemas
├── dataset/
│   ├── centroids.json        Shared base model (generated)
│   └── monthly_spending_2024.csv   Seed dataset for initial centroids
├── flo_db/                   ChromaDB data directory (AI overview vectors; auto-created)
├── templates/
│   ├── index.html            Single-page app shell
│   └── login.html            Password-gate login page
└── static/
    ├── css/styles.css
    └── js/app.js             SPA logic, localStorage, FX, Places, voice, charts
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
| `google-genai` | Gemini SDK (receipt OCR, voice function-calling, Live API, overview generation) |
| `chromadb` | Persistent vector store for monthly spending summaries (AI overview RAG) |
| `python-dotenv` | `.env` loading for environment variables |
| `qrcode` | Terminal QR for the localtunnel sharing script |
