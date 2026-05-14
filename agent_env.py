"""
Environment loading for the embedded assistant.

The migrated assistant can reuse a local .env without committing secrets into
this Flask repo. Real environment variables always win; local files only fill
missing values.
"""

from __future__ import annotations

import os
from pathlib import Path


def load_agent_env() -> None:
    root = Path(__file__).resolve().parent
    candidates = [
        root / ".env",
        root.parent / "FinancialApp" / ".env",
    ]

    for path in candidates:
        if path.exists():
            _load_dotenv_file(path)

    # The existing Flask receipt scanner looks for GOOGLE_API_KEY, while the
    # migrated agent used GEMINI_API_KEY. Treat them as aliases for Gemini.
    if os.environ.get("GEMINI_API_KEY") and not os.environ.get("GOOGLE_API_KEY"):
        os.environ["GOOGLE_API_KEY"] = os.environ["GEMINI_API_KEY"]


def _load_dotenv_file(path: Path) -> None:
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue

        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue

        os.environ[key] = _clean_value(value.strip())


def _clean_value(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
        value = value[1:-1]
    return value
