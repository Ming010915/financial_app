# Flo — AI-Powered Personal Finance Tracker

A mobile-style expense tracker with automatic merchant categorisation via an on-device ML model and receipt scanning powered by Google Gemini.

---

## Architecture

```
Browser (SPA)
    │
    │  HTTP / JSON
    ▼
Flask backend  (app.py)
    ├── SentenceTransformer  (paraphrase-multilingual-mpnet-base-v2)
    ├── Nearest Centroid Classifier  (centroids.json)
    └── Google Gemini 2.5 Flash  (receipt scanning)
```

All expense records live in the **browser's localStorage**. The server is stateless with respect to user data — it only holds the shared ML model state (`centroids.json`).

---

## Application Views

| View | Purpose |
|------|---------|
| **Home** | Today's total, this-month total, 7-day bar chart, category breakdown, 5 most recent expenses |
| **Add** | Manual entry form + optional receipt scanning; auto-classifies merchant on blur |
| **History** | Full chronological expense list, grouped by date; tap to open detail sheet |
| **Summary** | Spending by category (doughnut chart) and last-7-days line chart |
| **Settings** | Dark mode toggle, Google AI Studio API key, default currency, JSON/CSV export & import |

---

## Processes

### 1. Server Startup

1. The `paraphrase-multilingual-mpnet-base-v2` SentenceTransformer model is loaded into memory (lazy on first use, eager at `__main__` startup).
2. If `centroids.json` exists, category centroids and overrides are loaded from it.
3. If no JSON is found but `monthly_spending_2024.csv` exists, centroids are computed from that CSV (merchant names → embeddings → per-category mean vectors).
4. Otherwise the classifier starts with no categories (every merchant falls through to "Others").

### 2. Manual Expense Entry

1. User types a **merchant name** and leaves the field — `autoClassify()` fires a `POST /api/classify` request.
2. The server embeds the name, computes cosine similarity against all category centroids, and returns a prediction, a confidence score (0–1), and the top-3 candidates.
3. If confidence is below `0.6` (`ASK_BELOW`), `needs_review = true` is set and the frontend highlights the category selector so the user confirms manually.
4. User fills in amount, currency (default EUR), date, category (chip selector), payment method, and optional notes.
5. On submit, `POST /api/learn` is called (the centroid for the chosen category is updated) and the expense is persisted to localStorage.

### 3. Receipt Scanning

1. User takes a photo or uploads an image from the **Add** view.
2. `POST /api/scan_receipt` sends the image (multipart/form-data) to the server along with the Google AI Studio API key (from localStorage or `GOOGLE_API_KEY` env var).
3. The server forwards the image to **Gemini 2.5 Flash** with a structured prompt requesting a JSON object.
4. Gemini returns extracted fields (merchant, date, total, currency, payment method, line items, notes). Missing fields default to `null`; missing date defaults to today.
5. The extracted merchant name is then classified by the same ML pipeline as a manual entry.
6. Pre-filled form fields are shown to the user for confirmation before saving.

### 4. Online ML Learning

Every time the user saves an expense (manual or receipt):

1. The merchant's embedding (cached in memory from the classify step, or recomputed) is passed to `do_update()`.
2. The category centroid is updated using an **incremental running average**:
   ```
   new_centroid = (old_centroid × n + embedding) / (n + 1)
   ```
   The result is L2-normalised and `n` is incremented.
3. If the user **corrected** the predicted category, the merchant name (lowercased) is added to the `overrides` dict — future classifications of that exact name always return the corrected category with confidence 1.0.
4. The updated state is flushed to `centroids.json`.

---

## Data Stored

### Server — `centroids.json`

Persists the ML classifier state across restarts.

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
| `payment_method` | string \| null | Cash, Debit Card, Credit Card, Mobile Pay, Bank Transfer |
| `notes` | string | Optional free-text note |
| `items` | array | Line items from receipt: `[{name, price}]` (empty for manual entries) |
| `source` | string | `"manual"` or `"receipt"` |
| `created_at` | string (ISO 8601) | Timestamp when the record was saved |

#### Other localStorage keys

| Key | Value | Description |
|-----|-------|-------------|
| `darkMode` | `"0"` or `"1"` | UI theme preference |
| `googleApiKey` | string | Google AI Studio API key for receipt scanning |
| `defaultCurrency` | string | Default 3-letter currency code shown in the Add form |

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Serves the single-page app (`index.html`) |
| `GET` | `/api/categories` | Returns known categories and per-category sample counts |
| `POST` | `/api/classify` | Classifies a merchant name; body: `{name}` |
| `POST` | `/api/learn` | Updates the ML centroid; body: `{merchant, category, original_category}` |
| `POST` | `/api/scan_receipt` | Scans a receipt image; multipart with `image` file and `api_key` field |
| `GET` | `/api/settings` | Returns `{env_key_set: bool}` — whether `GOOGLE_API_KEY` is set server-side |

---

## Setup & Running

```bash
pip install -r requirements.txt
python app.py
# Open http://localhost:5000
```

To enable receipt scanning without entering the key in the UI every time:

```bash
export GOOGLE_API_KEY=AIza...
python app.py
```

### Data Export / Import

From the **Settings** view:

- **Export JSON** — downloads `flo-expenses-YYYY-MM-DD.json` (full expense array).
- **Export CSV** — downloads `flo-expenses-YYYY-MM-DD.csv` with columns: `date, merchant, amount, currency, category, payment_method, notes, source, created_at`.
- **Import JSON** — merges a previously exported JSON backup into the current localStorage, skipping duplicate IDs.

---

## Dependencies

| Package | Purpose |
|---------|---------|
| `flask` | HTTP server and template rendering |
| `sentence-transformers` | Multilingual text embeddings for classification |
| `numpy` | Vector arithmetic (centroid updates, cosine similarity) |
| `scikit-learn` | `cosine_similarity` helper |
| `pandas` | CSV loading for initial centroid computation |
| `google-genai` | Gemini API client for receipt OCR |
