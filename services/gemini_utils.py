"""
Shared helpers for Google Gemini calls.
Retries transient "model is overloaded / high demand" errors internally
before giving up with a user-friendly message.
"""

import time

# Substrings that indicate a transient, retryable Gemini error
# (high demand / overload / rate limit / temporarily unavailable).
_RETRYABLE_HINTS = (
    "high demand",
    "overloaded",
    "unavailable",
    "resource_exhausted",
    "rate limit",
    "try again",
    "503",
    "429",
)

# Message surfaced to the user once internal retries are exhausted.
OVERLOAD_MESSAGE = "The model is currently in high demand. Please wait a moment and try again."


class ModelOverloadedError(Exception):
    """Raised when Gemini stays overloaded after all internal retries."""


def _is_overload(exc: Exception) -> bool:
    msg = str(exc).lower()
    return any(hint in msg for hint in _RETRYABLE_HINTS)


def generate_with_retry(call, *, max_retries: int = 1, base_delay: float = 0.5):
    """
    Run a Gemini call (a zero-arg callable) and transparently retry it when
    the model reports it is overloaded / in high demand. Uses exponential
    backoff. Non-overload errors propagate immediately.

    Keeps only a quick internal retry to absorb brief blips; persistent
    overload is surfaced fast as ModelOverloadedError so the client can show
    the "high demand" message and keep retrying with visible feedback.
    """
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            return call()
        except Exception as exc:
            if not _is_overload(exc):
                raise
            last_exc = exc
            if attempt < max_retries:
                delay = base_delay * (2 ** attempt)
                print(f"[Gemini] Model overloaded (attempt {attempt + 1}/{max_retries + 1}), "
                      f"retrying in {delay:.1f}s ...")
                time.sleep(delay)

    raise ModelOverloadedError(OVERLOAD_MESSAGE) from last_exc


def generate_with_fallback(make_call, models, *, max_retries: int = 1, base_delay: float = 0.5):
    """
    Run a Gemini call across a list of models, in order. ``make_call`` is a
    function that takes a model name and returns the API response.

    Each model gets its own ``generate_with_retry`` (so transient overloads are
    absorbed first). If a model still fails — whether overloaded or otherwise —
    we fall through to the next model. The last error is re-raised only after
    every model is exhausted, so the caller's error handling is unchanged.
    """
    last_exc = None
    for model in models:
        try:
            return generate_with_retry(lambda: make_call(model),
                                       max_retries=max_retries, base_delay=base_delay)
        except Exception as exc:
            last_exc = exc
            print(f"[Gemini] Model '{model}' failed ({exc}); falling back to next model ...")

    raise last_exc if last_exc else ModelOverloadedError(OVERLOAD_MESSAGE)
