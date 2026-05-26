# Flo — AI-Powered Personal Finance Tracker

A mobile-style expense tracker with on-device merchant categorisation, receipt scanning, voice input, and location autocomplete — all powered by Google Gemini.

---

## Architecture

```
Browser (SPA)  ── localStorage ──────────────────────────────────────
    │   expenses · personalised centroids · overrides · settings
    │
    │  HTTP/JSON  +  WebSocket (audio)
    ▼
Flask backend  (app.py)
    ├── services/classifier.py
    │     • SentenceTransformer (paraphrase-multilingual-mpnet-base-v2)
    │     • Nearest-centroid + cosine similarity
    │     • Online (incremental) centroid updates
    ├── services/receipt.py   ── Gemini 2.5 Flash       (receipt OCR → JSON)
    ├── services/voice.py     ── Gemini 2.5 Flash       (voice → function call)
    └── /ws/voice_live        ── Gemini Live API        (streaming transcription)
    +   Frankfurter API (FX rates)  ·  Google Places API (location autocomplete)
```

The server is **stateless with respect to user data**. Expenses, personalised centroids, and overrides all live in the browser's `localStorage`. The server only ships a read-only *base model* (`dataset/centroids.json`) that new clients download on first run, after which every classify/learn request carries the client's own centroids.

---

## Application Views

| View | Purpose |
|------|---------|
| **Home** | Today's total, this-month total, 7-day bar chart, category breakdown, 5 most recent expenses |
| **Add** | Receipt scan • Voice input • Manual form with auto-classification, currency conversion, and Google Places location autocomplete |
| **History** | Full chronological expense list, grouped by date; tap to open / edit detail sheet |
| **Summary** | Spending by category (doughnut chart) and last-7-days line chart |
| **Settings** | Dark mode · API keys (Gemini, Places) · Default & custom currencies · JSON/CSV export & import · Reset model |
| **Categories** | Add / remove the categories that drive classification |
| **Category Overrides** | Manage exact-match `merchant → category` rules |
| **Payment Methods** | Add / remove payment methods |

---

## Processes

### 1. Server Startup

1. The `paraphrase-multilingual-mpnet-base-v2` SentenceTransformer model is loaded into memory.
2. If `dataset/centroids.json` exists, base centroids and overrides are loaded from it.
3. Otherwise, if `dataset/monthly_spending_2024.csv` exists, base centroids are computed (merchant names → embeddings → per-category mean vectors) and saved to JSON.
4. Otherwise the classifier starts empty (every merchant falls through to "Others").

### 2. Manual Expense Entry

1. User types a **merchant name** and leaves the field — the client posts its own centroids to `POST /api/classify`.
2. The server embeds the name, computes cosine similarity against the **client-supplied** centroids, and returns a prediction, confidence (0–1), top-3 candidates, and `needs_review` flag.
3. If confidence is below `ASK_BELOW = 0.6`, the frontend highlights the category selector for manual confirmation.
4. User fills in amount, currency (with live FX conversion if not the default), date, category, payment method, optional notes, and optional location.
5. On submit, `POST /api/learn` updates the user's local centroid (returned in the response and re-saved to `localStorage`), then the expense is persisted to `localStorage`.

### 3. Receipt Scanning

1. User takes a photo or drops an image into the **Add** view.
2. `POST /api/scan_receipt` sends the image (multipart/form-data) with the Google AI Studio API key (from `localStorage` or the `GOOGLE_API_KEY` env var).
3. The server forwards the image to **Gemini 2.5 Flash** with a structured prompt that requests a strict JSON receipt schema.
4. Gemini returns extracted fields (merchant, date, total, currency, payment method, line items, notes). Missing date defaults to today.
5. The extracted merchant is classified by the same ML pipeline.
6. Pre-filled form fields are shown for user confirmation before saving.

### 4. Voice Input

There are two voice flows; the client picks one based on browser capability:

- **Streaming live transcription** (`/ws/voice_live`) — the browser streams 16 kHz PCM audio over a WebSocket. The server opens a Gemini Live session and relays incremental input transcripts back to the browser for a live subtitle.
- **Batch processing** (`POST /api/voice_input`) — after recording, the audio blob is uploaded; Gemini 2.5 Flash is called with an `add_expense` **function declaration** and extracts merchant, total, currency, date, payment method, notes, and individual items via function calling.

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

When a Google Maps Platform API key is configured (in Settings or via `GOOGLE_PLACES_API_KEY` env var), the Add / Edit forms load the Google Maps JS SDK and offer:

- **Near me** — uses `navigator.geolocation` + Places `nearbySearch` to list nearby establishments.
- **Type-ahead** — debounced `textSearch` biased to the cached position.

### 7. Currency Conversion

The home/summary views aggregate across multi-currency expenses. The frontend fetches rates via `GET /api/exchange_rates?base=<DEFAULT>`, which proxies the [Frankfurter](https://www.frankfurter.app) API. Rates are cached in `localStorage` per base currency.

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

**Built-in categories:** Banking & Fees, Entertainment & Subscriptions, Food & Beverage, Groceries, Health & Wellness, Home & Living, Personal Care, Pet Supplies, Shopping, Transport, Others.

---

### Browser — `localStorage`

#### `flo_expenses`

A JSON array of expense objects. Each object has:

| Field | Type | Description |
|-------|------|-------------|
| `id` | string (UUID) | Unique identifier |
| `date` | string (YYYY-MM-DD) | Transaction date |
| `merchant` | string | Merchant / store name |
| `amount` | number | Total amount (2 d.p.) |
| `currency` | string | 3-letter ISO code (e.g. `EUR`) |
| `category` | string | Assigned category |
| `confidence` | number | ML confidence at time of classification (0–1) |
| `payment_method` | string \| null | Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer, … |
| `notes` | string | Optional free-text note |
| `location` | string | Optional address/place label from Places autocomplete |
| `items` | array | Line items: `[{name, price}]` (from receipt or voice input; empty for manual) |
| `source` | string | `"manual"`, `"receipt"`, or `"voice"` |
| `created_at` | string (ISO 8601) | Timestamp when the record was saved |

#### Other localStorage keys

| Key | Value | Description |
|-----|-------|-------------|
| `flo_centroids` | JSON | Per-user personalised classifier state (same shape as `dataset/centroids.json`) |
| `flo_payment_methods` | JSON array | User-managed payment-method list |
| `flo_custom_currencies` | JSON array | Extra ISO currency codes added by the user |
| `flo_rates_<BASE>` | JSON | Cached FX-rate snapshot keyed by base currency |
| `darkMode` | `"0"` or `"1"` | UI theme preference |
| `googleApiKey` | string | Google AI Studio API key for Gemini |
| `placesApiKey` | string | Google Maps Platform API key for Places |
| `defaultCurrency` | string | Default 3-letter currency code shown in the Add form |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET`  | `/` | Serves the single-page app (`index.html`) |
| `GET`  | `/api/categories` | Returns base-model categories and per-category sample counts |
| `GET`  | `/api/base_centroids` | Returns the read-only base model so new browsers can bootstrap `flo_centroids` |
| `POST` | `/api/classify` | Classifies a merchant name. Body may include the client's `categories` + `overrides`. |
| `POST` | `/api/learn` | Updates the (client's) centroid and overrides. Returns the new state. |
| `POST` | `/api/scan_receipt` | Scans a receipt image; multipart with `image` + `api_key` |
| `POST` | `/api/voice_input` | Processes a recorded audio blob via Gemini function calling; multipart with `audio` + `api_key` |
| `WS`   | `/ws/voice_live` | Streaming voice transcription via the Gemini Live API |
| `GET`  | `/api/exchange_rates?base=EUR` | Proxies the Frankfurter FX-rates API |
| `GET`  | `/api/settings` | Returns `{env_key_set, places_server_key}` so the client knows what's already configured server-side |

---

## Setup & Running

Dependencies are declared in [`environment.yml`](environment.yml) (conda + pip).

```bash
conda env create -f environment.yml
conda activate gen_ai
python app.py
# Open http://localhost:5000
```

### Environment variables (optional — also configurable in the UI)

Create a `.env` file or export them in the shell:

```bash
GOOGLE_API_KEY=AIza...           # Gemini — receipt & voice
GOOGLE_PLACES_API_KEY=AIza...    # Google Maps Platform — Places autocomplete
```

### Share over a tunnel

[`run_and_share.sh`](run_and_share.sh) starts the app and exposes it through [localtunnel](https://github.com/localtunnel/localtunnel), printing a QR code for quick mobile access:

```bash
./run_and_share.sh
```

Requires `lt` (localtunnel) and one of `qrencode` / Python `qrcode` on `PATH`.

### Data Export / Import

From the **Settings** view:

- **Export JSON** — downloads `flo-expenses-YYYY-MM-DD.json` (full expense array).
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
├── run_and_share.sh          Local + localtunnel + QR sharing helper
├── services/
│   ├── classifier.py         SentenceTransformer + nearest-centroid + online learning
│   ├── receipt.py            Gemini receipt OCR → structured JSON
│   └── voice.py              Gemini voice → function-call → expense fields
├── dataset/
│   ├── centroids.json        Shared base model (generated)
│   └── monthly_spending_2024.csv   Seed dataset for initial centroids
├── templates/index.html      Single-page app shell
└── static/
    ├── css/styles.css
    └── js/app.js             SPA logic, localStorage, FX, Places, voice, charts
```

---

## Key Dependencies

| Package | Purpose |
|---------|---------|
| `flask`, `flask-sock` | HTTP server + WebSocket for live voice transcription |
| `sentence-transformers` | Multilingual text embeddings for classification |
| `numpy`, `scikit-learn` | Vector arithmetic + cosine similarity |
| `pandas` | CSV loading for initial centroid computation |
| `google-genai` | Gemini SDK (receipt OCR, voice function-calling, Live API) |
| `python-dotenv` | `.env` loading for API keys |
| `qrcode` | Terminal QR for the localtunnel sharing script |
