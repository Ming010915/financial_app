import os
from dotenv import load_dotenv

load_dotenv()

MODEL_NAME            = "paraphrase-multilingual-mpnet-base-v2"
SERVER_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")

# ── Vertex AI ─────────────────────────────────────────────────────────────────
GOOGLE_CLOUD_PROJECT  = os.environ.get("GOOGLE_CLOUD_PROJECT", "")
GOOGLE_CLOUD_LOCATION = os.environ.get("GOOGLE_CLOUD_LOCATION", "us-central1")


def get_genai_client():
    from google import genai
    return genai.Client(
        vertexai=True,
        project=GOOGLE_CLOUD_PROJECT,
        location=GOOGLE_CLOUD_LOCATION,
    )


# ── Access control ────────────────────────────────────────────────────────────
# When True, the whole app sits behind a login page that requires APP_PASSWORD.
# When False, the login page is skipped and the app is open.
REQUIRE_PASSWORD = os.environ.get("REQUIRE_PASSWORD", "true").lower() in ("1", "true", "yes", "on")
# The password the user must enter — set this in your .env file.
APP_PASSWORD     = os.environ.get("APP_PASSWORD", "")
# Secret key used to sign the session cookie. Override in .env for stable sessions.
SECRET_KEY       = os.environ.get("SECRET_KEY", os.urandom(32).hex())
# Tried in order — the first model that responds wins.
GEMINI_MODELS         = ["gemini-3.5-flash", "gemini-2.5-flash"]
GEMINI_LIVE_MODEL     = "gemini-3.1-flash-live-preview"
THRESHOLD      = 0.3
ASK_BELOW      = 0.6
CENTROIDS_FILE = "dataset/centroids.json"
MONTHLY_SPENDING_DATASET = "dataset/monthly_spending_2024.csv"
CHROMA_DB_PATH = "./flo_db"
