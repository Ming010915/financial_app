import os
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from dotenv import load_dotenv  # noqa: E402
load_dotenv(ROOT / ".env")

RESULTS_DIR = ROOT / "tests" / "results"
RESULTS_DIR.mkdir(exist_ok=True)


def _adc_available() -> bool:
    if os.environ.get("GOOGLE_APPLICATION_CREDENTIALS"):
        return True
    adc = Path.home() / ".config" / "gcloud" / "application_default_credentials.json"
    return adc.exists()


LIVE_API_AVAILABLE = bool(os.environ.get("GOOGLE_CLOUD_PROJECT")) and _adc_available()


@pytest.fixture(scope="session")
def live_api_available() -> bool:
    """True when Vertex AI credentials are configured, so live Gemini calls can run."""
    return LIVE_API_AVAILABLE


@pytest.fixture(scope="session", autouse=True)
def _preload_classifier_model():
    """The SentenceTransformer model lazy-loads on its first use (~6-9s on
    this machine, mostly model/tokenizer init, not network — confirmed by
    timing get_model() in isolation). app.py's initialize() already pays
    this cost once at server boot in production, so real users never see it.
    Without this fixture, whichever test's first do_classify() call happens
    first in the pytest process eats that cost and it gets misattributed to
    that test's own latency (this is exactly what inflated the receipt-OCR
    and voice-extraction latency numbers in earlier runs — the "first call"
    included Gemini's response time AND an unrelated one-time local model
    load). Mirrors production by paying it once, up front, for everyone.

    get_model() alone only constructs the SentenceTransformer (loads
    weights) — it doesn't run an actual encode(), which has its own
    first-call cost (tokenizer/backend warm-up). Without a real encode()
    here, whichever performance test happens to run first
    (test_classifier_do_classify_latency, by file order) absorbs that cost
    across its own timed samples, making it look slower than
    /api/classify's later, already-warm samples — an artifact of test
    order, not a real latency difference. Calling do_classify() here pays
    that cost once, before any test's clock starts."""
    from services import classifier
    classifier.get_model()
    classifier.do_classify("warmup merchant", local_cents=classifier.centroids, local_ovrs={})


def skip_without_live_api():
    return pytest.mark.skipif(
        not LIVE_API_AVAILABLE,
        reason="GOOGLE_CLOUD_PROJECT / ADC credentials not configured — see README Setup section",
    )
