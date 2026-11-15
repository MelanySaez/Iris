"""Shared FastAPI dependencies and their process-wide singletons."""

from __future__ import annotations

import threading

from app.core.config import (
    ASSISTANT_CACHE_MAX_ENTRIES,
    ASSISTANT_CACHE_TTL_SECONDS,
    ASSISTANT_LOG_PATH,
    ASSISTANT_RATE_LIMIT_PER_MINUTE,
    Settings,
)
from app.exceptions.domain import AssistantDisabledError
from app.repositories.assistant_log import AssistantLog
from app.services.assistant.cache import ResponseCache
from app.services.assistant.guardrails import RateLimiter
from app.services.assistant.service import Assistant

SIMILARITY_THRESHOLD = 0.85

DISABLED_DETAIL = (
    "The assistant is disabled: set ASSISTANT_API_KEY and ASSISTANT_MODEL on the server "
    "(and ASSISTANT_BASE_URL for an OpenAI-compatible provider other than OpenAI)."
)

_assistant: Assistant | None = None
_assistant_settings: tuple[str, str, str | None] | None = None
_lock = threading.Lock()


def assistant_settings() -> tuple[str, str, str | None] | None:
    """(api key, model, base URL) from the environment, or None until both are set."""
    current = Settings()
    key = (current.ASSISTANT_API_KEY or "").strip()
    model = (current.ASSISTANT_MODEL or "").strip()
    if not key or not model:
        return None
    return key, model, (current.ASSISTANT_BASE_URL or "").strip() or None


def get_assistant() -> Assistant:
    """The shared assistant; 503 while the key or the model is missing."""
    global _assistant, _assistant_settings
    settings = assistant_settings()
    if settings is None:
        raise AssistantDisabledError(DISABLED_DETAIL)
    with _lock:
        if _assistant is None or settings != _assistant_settings:
            import openai

            key, model, base_url = settings
            _assistant = Assistant(
                client=openai.OpenAI(api_key=key, base_url=base_url),
                log=AssistantLog(ASSISTANT_LOG_PATH),
                cache=ResponseCache(
                    max_entries=ASSISTANT_CACHE_MAX_ENTRIES,
                    ttl_seconds=ASSISTANT_CACHE_TTL_SECONDS,
                    similarity=SIMILARITY_THRESHOLD,
                ),
                rate_limiter=RateLimiter(ASSISTANT_RATE_LIMIT_PER_MINUTE),
                model=model,
            )
            _assistant_settings = settings
        return _assistant
