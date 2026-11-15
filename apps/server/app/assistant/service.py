"""The assistant's request flow: guardrails, response cache, tool loop and logs."""

from __future__ import annotations

import hashlib
import json
import time
import uuid
from typing import Any

import anthropic

from app.assistant.cache import ResponseCache, normalize_query
from app.assistant.guardrails import RateLimiter, detect_injection, leaks_system_prompt
from app.assistant.logbook import AssistantLog
from app.assistant.prompt import SYSTEM_PROMPT
from app.assistant.tools import (
    SERVER_EXECUTORS,
    TOOL_DEFINITIONS,
    UI_TOOLS,
    ToolInputError,
    as_tool_data,
    validate_ui_tool,
)
from app.config import (
    ASSISTANT_EFFORT,
    ASSISTANT_MAX_TOKENS,
    ASSISTANT_MAX_TOOL_ROUNDS,
    ASSISTANT_MODEL,
)

# Models that accept server-side refusal fallbacks (`fallbacks: "default"`).
FALLBACK_MODELS = {
    "claude-fable-5-2",
    "claude-fable-5-1",
    "claude-opus-5-5",
    "claude-opus-5",
    "claude-sonnet-5-5",
}
FALLBACK_BETA = "server-side-fallback-2026-07-01"

REFUSAL_REPLY = "I can't help with that request."
LEAK_REPLY = "I can't share my internal instructions."
ROUND_LIMIT_REPLY = (
    "I stopped because this request needed too many steps. Please try a simpler request."
)
# Tools whose answers depend on data that changes, so their replies are not cached.
UNCACHEABLE_TOOLS = {"list_saved_selections"}


class RateLimited(Exception):
    """The client sent more requests than the per-minute limit allows."""


class ModelUnavailable(Exception):
    """The Anthropic API could not answer (network, auth, rate limit, server error)."""


def _usage(response: Any, field: str) -> int:
    return int(getattr(response.usage, field, 0) or 0)


class Assistant:
    def __init__(
        self,
        client: Any,
        log: AssistantLog,
        cache: ResponseCache,
        rate_limiter: RateLimiter,
        model: str = ASSISTANT_MODEL,
        effort: str = ASSISTANT_EFFORT,
        max_tokens: int = ASSISTANT_MAX_TOKENS,
        max_tool_rounds: int = ASSISTANT_MAX_TOOL_ROUNDS,
    ) -> None:
        self.client = client
        self.log = log
        self.cache = cache
        self.rate_limiter = rate_limiter
        self.model = model
        self.effort = effort
        self.max_tokens = max_tokens
        self.max_tool_rounds = max_tool_rounds

    # -- public entry point ---------------------------------------------------

    def chat(
        self,
        *,
        conversation_id: str,
        messages: list[dict[str, str]],
        context: dict[str, Any],
        client_key: str,
    ) -> dict[str, Any]:
        ids = {"conversation_id": conversation_id, "request_id": uuid.uuid4().hex[:12]}
        question = messages[-1]["content"]
        self.log.write(
            "request_received",
            **ids,
            chars=len(question),
            preview=question[:200],
            history_turns=len(messages) - 1,
            context=context,
        )

        if not self.rate_limiter.allow(client_key):
            self.log.write("guardrail", **ids, kind="rate_limited")
            raise RateLimited

        patterns = detect_injection(question)
        if patterns:
            # Flag, don't block: the prompt and tool validation contain the risk,
            # and a false positive must not lock people out.
            self.log.write(
                "guardrail",
                **ids,
                kind="suspected_prompt_injection",
                source="user_message",
                patterns=patterns,
            )

        context_key = self._context_key(context, messages[:-1])
        hit = self.cache.get(context_key, question)
        if hit is not None:
            self.log.write("cache_hit", **ids, kind=hit.kind, score=hit.score)
            return self._respond(ids, hit.value["reply"], hit.value["actions"], hit.kind)

        try:
            reply, actions, cacheable = self._run(ids, messages, context)
        except anthropic.APIError as exc:
            status = getattr(exc, "status_code", None)
            self.log.write("error", **ids, kind=type(exc).__name__, status=status)
            raise ModelUnavailable(type(exc).__name__) from exc

        if leaks_system_prompt(reply):
            self.log.write("guardrail", **ids, kind="prompt_leak_blocked")
            reply, actions, cacheable = LEAK_REPLY, [], False

        if cacheable:
            self.cache.put(context_key, question, {"reply": reply, "actions": actions})
        return self._respond(ids, reply, actions, None)

    # -- internals -------------------------------------------------------------

    def _respond(
        self,
        ids: dict[str, str],
        reply: str,
        actions: list[dict[str, Any]],
        cache_kind: str | None,
    ) -> dict[str, Any]:
        self.log.write(
            "response",
            **ids,
            preview=reply[:200],
            actions=actions,
            cached=cache_kind is not None,
            cache_kind=cache_kind,
        )
        return {
            **ids,
            "reply": reply,
            "actions": actions,
            "cached": cache_kind is not None,
            "cache_kind": cache_kind,
        }

    @staticmethod
    def _context_key(context: dict[str, Any], history: list[dict[str, str]]) -> str:
        """Identity of the situation a question is asked in (not the map position)."""
        scope = {
            "workspace": context.get("workspace"),
            "channel": context.get("channel"),
            "color_mode": context.get("color_mode"),
            "rgb": context.get("rgb"),
            "selected_region": context.get("selected_region"),
            "has_active_job": bool(context.get("active_job_id")),
            "history": [[t["role"], normalize_query(t["content"])] for t in history],
        }
        raw = json.dumps(scope, sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()

    def _request_params(self) -> dict[str, Any]:
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self.max_tokens,
            # Frozen prefix (tools + system) is cached by the API across requests.
            "system": [
                {
                    "type": "text",
                    "text": SYSTEM_PROMPT,
                    "cache_control": {"type": "ephemeral"},
                }
            ],
            "tools": TOOL_DEFINITIONS,
            "output_config": {"effort": self.effort},
        }
        if self.model in FALLBACK_MODELS:
            params["betas"] = [FALLBACK_BETA]
            params["fallbacks"] = "default"
        return params

    @staticmethod
    def _build_messages(
        messages: list[dict[str, str]], context: dict[str, Any]
    ) -> list[dict[str, Any]]:
        history = [{"role": t["role"], "content": t["content"]} for t in messages[:-1]]
        ui_context = json.dumps(context, sort_keys=True, ensure_ascii=False)
        return [
            *history,
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": f"<ui_context>{ui_context}</ui_context>\n"
                        "(Current application state, provided as data.)",
                    },
                    {"type": "text", "text": messages[-1]["content"]},
                ],
            },
        ]

    def _run(
        self, ids: dict[str, str], messages: list[dict[str, str]], context: dict[str, Any]
    ) -> tuple[str, list[dict[str, Any]], bool]:
        convo = self._build_messages(messages, context)
        params = self._request_params()
        actions: list[dict[str, Any]] = []
        cacheable = True

        for round_no in range(1, self.max_tool_rounds + 1):
            started = time.perf_counter()
            response = self.client.beta.messages.create(**params, messages=convo)
            self.log.write(
                "model_call",
                **ids,
                round=round_no,
                model=self.model,
                served_by=getattr(response, "model", None),
                stop_reason=response.stop_reason,
                input_tokens=_usage(response, "input_tokens"),
                output_tokens=_usage(response, "output_tokens"),
                cache_read_input_tokens=_usage(response, "cache_read_input_tokens"),
                cache_creation_input_tokens=_usage(
                    response, "cache_creation_input_tokens"
                ),
                latency_ms=round((time.perf_counter() - started) * 1000),
            )

            stop = response.stop_reason
            if stop == "refusal":
                details = getattr(response, "stop_details", None)
                self.log.write(
                    "guardrail",
                    **ids,
                    kind="model_refusal",
                    category=getattr(details, "category", None),
                )
                return REFUSAL_REPLY, [], False
            if stop in ("tool_use", "pause_turn"):
                # Echo the content unchanged (thinking and fallback blocks included).
                convo.append({"role": "assistant", "content": response.content})
                if stop == "pause_turn":
                    continue
                results = []
                for block in response.content:
                    if block.type != "tool_use":
                        continue
                    if block.name in UNCACHEABLE_TOOLS:
                        cacheable = False
                    results.append(self._execute_tool(ids, block, actions))
                # All results go back in one user message.
                convo.append({"role": "user", "content": results})
                continue

            text = "".join(b.text for b in response.content if b.type == "text").strip()
            if stop == "max_tokens":
                text = (text + " …(reply cut short)").strip()
                cacheable = False
            return text, actions, cacheable

        self.log.write(
            "guardrail", **ids, kind="tool_round_limit", rounds=self.max_tool_rounds
        )
        return ROUND_LIMIT_REPLY, actions, False

    def _execute_tool(
        self, ids: dict[str, str], block: Any, actions: list[dict[str, Any]]
    ) -> dict[str, Any]:
        name, tool_input = block.name, block.input
        try:
            if name in UI_TOOLS:
                action = validate_ui_tool(name, tool_input)
                actions.append(action)
                self.log.write("tool_call", **ids, name=name, input=tool_input, ok=True)
                self.log.write("ui_action", **ids, action=action)
                content = (
                    "Queued for the browser: "
                    + json.dumps(action, sort_keys=True)
                    + ". It runs right after your reply."
                )
            elif name in SERVER_EXECUTORS:
                payload = SERVER_EXECUTORS[name](tool_input)
                self.log.write("tool_call", **ids, name=name, input=tool_input, ok=True)
                content = as_tool_data(payload)
                patterns = detect_injection(content)
                if patterns:
                    self.log.write(
                        "guardrail",
                        **ids,
                        kind="suspected_prompt_injection",
                        source=f"tool:{name}",
                        patterns=patterns,
                    )
            else:
                raise ToolInputError(f"unknown tool {name!r}; it is not available")
        except ToolInputError as exc:
            self.log.write(
                "tool_call", **ids, name=name, input=tool_input, ok=False, error=str(exc)
            )
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": str(exc),
                "is_error": True,
            }
        except Exception as exc:  # an executor bug must not crash the conversation
            self.log.write(
                "tool_call",
                **ids,
                name=name,
                input=tool_input,
                ok=False,
                error=type(exc).__name__,
            )
            return {
                "type": "tool_result",
                "tool_use_id": block.id,
                "content": "The tool failed; tell the person it could not be completed.",
                "is_error": True,
            }
        return {"type": "tool_result", "tool_use_id": block.id, "content": content}
