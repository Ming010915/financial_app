import os
from dotenv import load_dotenv

load_dotenv()

MODEL_NAME       = "paraphrase-multilingual-mpnet-base-v2"
SERVER_API_KEY        = os.environ.get("GOOGLE_API_KEY", "")
SERVER_PLACES_API_KEY = os.environ.get("GOOGLE_PLACES_API_KEY", "")
# Tried in order — the first model that responds wins.
GEMINI_MODELS         = ["gemini-3.5-flash", "gemini-2.5-flash"]
GEMINI_LIVE_MODEL = "gemini-3.1-flash-live-preview"
THRESHOLD      = 0.3
ASK_BELOW      = 0.6
CENTROIDS_FILE = "dataset/centroids.json"
MONTHLY_SPENDING_DATASET = "dataset/monthly_spending_2024.csv"
CHROMA_DB_PATH = "./flo_db"
