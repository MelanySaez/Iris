"""Append-only JSONL log of everything the assistant does.

One line per event: requests, model calls (tokens, cache usage, latency, stop
reason), tool calls, UI actions, cache hits, guardrail decisions, errors and
the UI outcomes the browser reports. It never stores the API key.
"""

from __future__ import annotations

import json
import threading
from collections import deque
from datetime import UTC, datetime
from pathlib import Path
from typing import Any


class AssistantLog:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.Lock()

    def write(self, event: str, **fields: Any) -> dict[str, Any]:
        entry = {
            "ts": datetime.now(UTC).isoformat(timespec="milliseconds"),
            "event": event,
        }
        entry.update(fields)
        line = json.dumps(entry, ensure_ascii=False, default=str)
        with self._lock:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as fh:
                fh.write(line + "\n")
        return entry

    def read(
        self, limit: int = 200, conversation_id: str | None = None
    ) -> list[dict[str, Any]]:
        """Newest entries first, optionally only one conversation's."""
        if not self.path.exists():
            return []
        recent: deque[dict[str, Any]] = deque(maxlen=limit)
        with self._lock, self.path.open(encoding="utf-8") as fh:
            for line in fh:
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (
                    conversation_id is None
                    or entry.get("conversation_id") == conversation_id
                ):
                    recent.append(entry)
        return list(reversed(recent))
