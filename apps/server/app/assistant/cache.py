"""Response cache for equal or similar assistant requests.

Entries are scoped by a context key (UI state + earlier turns), so the same
words asked in a different situation never share an answer. A hit is either
*exact* (same normalized text) or *similar* (high word overlap with the same
numbers, so "channel 44" never answers "channel 45").
"""

from __future__ import annotations

import re
import threading
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

_NUMBER_RE = re.compile(r"-?\d+(?:\.\d+)?")


def normalize_query(text: str) -> str:
    """Casefold, drop accents and punctuation, collapse whitespace."""
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    no_accents = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    # Keep decimal points and minus signs that belong to numbers (dec -3 != dec 3).
    words = re.sub(r"[^\w.\-]+", " ", no_accents)
    words = re.sub(r"-(?!\d)|(?<!\d)\.|\.(?!\d)", " ", words)
    return re.sub(r"\s+", " ", words).strip()


def _tokens(normalized: str) -> set[str]:
    return set(normalized.split())


def _numbers(normalized: str) -> list[str]:
    return _NUMBER_RE.findall(normalized)


@dataclass
class CacheHit:
    value: dict[str, Any]
    kind: str  # "exact" or "similar"
    score: float


class ResponseCache:
    def __init__(
        self,
        max_entries: int,
        ttl_seconds: float,
        similarity: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.max_entries = max_entries
        self.ttl = ttl_seconds
        self.similarity = similarity
        self.clock = clock
        self._entries: OrderedDict[tuple[str, str], tuple[float, dict[str, Any]]] = (
            OrderedDict()
        )
        self._lock = threading.Lock()

    def _expired(self, stored_at: float) -> bool:
        return self.clock() - stored_at > self.ttl

    def get(self, context_key: str, query: str) -> CacheHit | None:
        normalized = normalize_query(query)
        if not normalized:
            return None
        with self._lock:
            for key in [k for k, (at, _) in self._entries.items() if self._expired(at)]:
                del self._entries[key]

            exact = self._entries.get((context_key, normalized))
            if exact is not None:
                self._entries.move_to_end((context_key, normalized))
                return CacheHit(exact[1], "exact", 1.0)

            tokens, numbers = _tokens(normalized), _numbers(normalized)
            if len(tokens) < 3:
                return None
            best: tuple[float, tuple[str, str]] | None = None
            for (ctx, text), (_, value) in self._entries.items():
                # Only exact requests may replay interface actions.
                if value.get("actions"):
                    continue
                if ctx != context_key or _numbers(text) != numbers:
                    continue
                other = _tokens(text)
                score = len(tokens & other) / len(tokens | other)
                if score >= self.similarity and (best is None or score > best[0]):
                    best = (score, (ctx, text))
            if best is None:
                return None
            self._entries.move_to_end(best[1])
            return CacheHit(self._entries[best[1]][1], "similar", round(best[0], 3))

    def put(self, context_key: str, query: str, value: dict[str, Any]) -> None:
        normalized = normalize_query(query)
        if not normalized:
            return
        with self._lock:
            self._entries[(context_key, normalized)] = (self.clock(), value)
            self._entries.move_to_end((context_key, normalized))
            while len(self._entries) > self.max_entries:
                self._entries.popitem(last=False)
