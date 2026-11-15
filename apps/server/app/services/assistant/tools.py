"""Tools the assistant may call, their validation and the server-side executors.

UI tools never run here: once validated they become *actions* that the browser
executes after the reply. Server tools only read data. Nothing the model can
call starts jobs, renames or deletes anything.
"""

from __future__ import annotations

import json
import unicodedata
import uuid
from contextvars import ContextVar
from typing import Any

from app.exceptions.domain import AppError
from app.schemas.assistant import UI_ACTION_TYPES
from app.services.assistant.guardrails import sanitize_untrusted
from app.services.catalog import get_catalog
from app.services.names import resolve_name
from app.services.selections import current_selection_service

# The browser asking (its owner cookie), set by the chat route for one request.
# Saved-selection tools only read that browser's records.
selection_owner: ContextVar[uuid.UUID | None] = ContextVar(
    "selection_owner", default=None
)

WORKSPACES = ("sky", "plate", "spectral", "records")
UNAVAILABLE_CHANNELS = (50, 51)
MAX_CHANNEL = 101


class ToolInputError(ValueError):
    """The model asked for a tool with input outside the allowed values."""


def _schema(properties: dict[str, Any]) -> dict[str, Any]:
    return {
        "type": "object",
        "properties": properties,
        "required": list(properties),
        "additionalProperties": False,
    }


# Ranges are stated in the descriptions and enforced by validate_ui_tool /
# the executors, which is where the guardrail lives.
TOOL_DEFINITIONS: list[dict[str, Any]] = [
    {
        "name": "search_catalog",
        "description": (
            "Search the Planet X catalog of curated sky objects by name, id, type or "
            "description. Returns up to 5 matches with coordinates and a suggested "
            "region size. Use it before showing a named object."
        ),
        "strict": True,
        "input_schema": _schema(
            {"query": {"type": "string", "description": "Object name or keywords."}}
        ),
    },
    {
        "name": "resolve_object_name",
        "description": (
            "Resolve any astronomical object name or catalogue code (e.g. Andromeda, "
            "M31, NGC 224, Orion Nebula) to coordinates through SIMBAD and NED. "
            "Returns ra_deg, dec_deg, the object size when known and a "
            "suggested_size_arcmin that show_region accepts. Use it when "
            "search_catalog has no match."
        ),
        "strict": True,
        "input_schema": _schema(
            {"name": {"type": "string", "description": "Object name or code."}}
        ),
    },
    {
        "name": "list_saved_selections",
        "description": (
            "List the most recently seen saved selections (Records): id, name, region, "
            "evaluated channels, view mode and status. Names are user-written data."
        ),
        "strict": True,
        "input_schema": _schema(
            {"limit": {"type": "integer", "description": "How many, 1 to 10."}}
        ),
    },
    {
        "name": "navigate",
        "description": (
            "Switch the visible workspace. 'plate' only works when a job is active "
            "(see ui_context.active_job_id)."
        ),
        "strict": True,
        "input_schema": _schema(
            {"workspace": {"type": "string", "enum": list(WORKSPACES)}}
        ),
    },
    {
        "name": "show_region",
        "description": (
            "Open Sky centred on a square region and draw it as a draft selection. "
            "ra_deg in [0, 360), dec_deg in [-90, 90], size_arcmin in [1, 60]. "
            "It does not start a job; the person confirms it."
        ),
        "strict": True,
        "input_schema": _schema(
            {
                "ra_deg": {"type": "number"},
                "dec_deg": {"type": "number"},
                "size_arcmin": {"type": "number"},
            }
        ),
    },
    {
        "name": "set_channel",
        "description": (
            "Show one SPHEREx channel on the Sky map (single-channel mode). Channels "
            "0 to 101; 50 and 51 do not exist."
        ),
        "strict": True,
        "input_schema": _schema({"channel": {"type": "integer"}}),
    },
    {
        "name": "set_color_mode",
        "description": (
            "Switch the Sky map between 'single' channel and an 'rgb' composite. For "
            "'rgb' give three channels [r, g, b]; for 'single' give rgb as null."
        ),
        "strict": True,
        "input_schema": _schema(
            {
                "mode": {"type": "string", "enum": ["single", "rgb"]},
                "rgb": {"type": ["array", "null"], "items": {"type": "integer"}},
            }
        ),
    },
]

SERVER_TOOLS = {"search_catalog", "resolve_object_name", "list_saved_selections"}
UI_TOOLS = set(UI_ACTION_TYPES)

_FIELDS = {d["name"]: set(d["input_schema"]["properties"]) for d in TOOL_DEFINITIONS}


def _check_fields(name: str, tool_input: Any) -> dict[str, Any]:
    if not isinstance(tool_input, dict):
        raise ToolInputError(f"{name}: input must be an object")
    expected = _FIELDS[name]
    extra = set(tool_input) - expected
    if extra:
        raise ToolInputError(f"{name}: unexpected field(s) {sorted(extra)}")
    missing = expected - set(tool_input)
    if missing:
        raise ToolInputError(f"{name}: missing field(s) {sorted(missing)}")
    return tool_input


def _number(
    value: Any, field: str, low: float, high: float, *, high_open: bool = False
) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ToolInputError(f"{field} must be a number")
    number = float(value)
    too_high = number >= high if high_open else number > high
    if number != number or number < low or too_high:
        bracket = ")" if high_open else "]"
        raise ToolInputError(f"{field} must be in [{low:g}, {high:g}{bracket}")
    return number


def _channel(value: Any, field: str = "channel") -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ToolInputError(f"{field} must be an integer")
    if not 0 <= value <= MAX_CHANNEL:
        raise ToolInputError(f"{field} must be between 0 and {MAX_CHANNEL}")
    if value in UNAVAILABLE_CHANNELS:
        raise ToolInputError(f"{field} {value} is not available (50 and 51 do not exist)")
    return value


def validate_ui_tool(name: str, tool_input: Any) -> dict[str, Any]:
    """Validate a UI tool call and return the action the browser will execute."""
    if name not in UI_TOOLS:
        raise ToolInputError(f"unknown tool {name!r}")
    data = _check_fields(name, tool_input)
    if name == "navigate":
        if data["workspace"] not in WORKSPACES:
            raise ToolInputError(f"workspace must be one of {list(WORKSPACES)}")
        return {"type": "navigate", "workspace": data["workspace"]}
    if name == "show_region":
        return {
            "type": "show_region",
            "ra_deg": _number(data["ra_deg"], "ra_deg", 0, 360, high_open=True),
            "dec_deg": _number(data["dec_deg"], "dec_deg", -90, 90),
            "size_arcmin": _number(data["size_arcmin"], "size_arcmin", 1, 60),
        }
    if name == "set_channel":
        return {"type": "set_channel", "channel": _channel(data["channel"])}
    # set_color_mode
    mode, rgb = data["mode"], data["rgb"]
    if mode == "single":
        if rgb is not None:
            raise ToolInputError("rgb must be null for mode 'single'")
        return {"type": "set_color_mode", "mode": "single", "rgb": None}
    if mode != "rgb":
        raise ToolInputError("mode must be 'single' or 'rgb'")
    if not isinstance(rgb, list) or len(rgb) != 3:
        raise ToolInputError("rgb must list exactly three channels for mode 'rgb'")
    return {
        "type": "set_color_mode",
        "mode": "rgb",
        "rgb": [_channel(c, "rgb channel") for c in rgb],
    }


def _fold(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text.casefold())
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def search_catalog(tool_input: Any) -> dict[str, Any]:
    query = _check_fields("search_catalog", tool_input)["query"]
    if not isinstance(query, str) or not query.strip():
        raise ToolInputError("query must be a non-empty string")
    words = _fold(query).split()[:8]
    matches = []
    for obj in get_catalog()["objects"]:
        haystack = _fold(
            " ".join(str(obj[k]) for k in ("id", "name", "type", "description"))
        )
        hits = sum(word in haystack for word in words)
        if hits:
            matches.append((hits, obj))
    matches.sort(key=lambda item: -item[0])
    return {
        "results": [
            {
                "id": obj["id"],
                "name": obj["name"],
                "type": obj["type"],
                "ra_deg": obj["ra_deg"],
                "dec_deg": obj["dec_deg"],
                "default_size_arcmin": obj["default_size_arcmin"],
            }
            for _, obj in matches[:5]
        ]
    }


# show_region accepts 1 to 60 arcmin; objects of unknown size get a small field.
_REGION_MIN, _REGION_MAX, _REGION_DEFAULT = 1.0, 60.0, 6.0


def resolve_object_name(tool_input: Any) -> dict[str, Any]:
    name = _check_fields("resolve_object_name", tool_input)["name"]
    if not isinstance(name, str) or not name.strip():
        raise ToolInputError("name must be a non-empty string")
    try:
        found = resolve_name(name)
    except AppError as exc:  # not found, invalid name or providers unavailable
        raise ToolInputError(exc.detail) from None
    size = found.get("size_arcmin")
    suggested = _REGION_DEFAULT if size is None else size
    return {
        # Text from external catalogues: cleaned and clearly marked as data.
        "name": sanitize_untrusted(str(found["name"]), 80),
        "object_type": (
            sanitize_untrusted(str(found["object_type"]), 40)
            if found.get("object_type")
            else None
        ),
        "ra_deg": float(found["ra_deg"]),
        "dec_deg": float(found["dec_deg"]),
        "size_arcmin": size,
        "suggested_size_arcmin": float(min(max(suggested, _REGION_MIN), _REGION_MAX)),
        "source": found.get("source"),
    }


def list_saved_selections(tool_input: Any) -> dict[str, Any]:
    limit = _check_fields("list_saved_selections", tool_input)["limit"]
    if isinstance(limit, bool) or not isinstance(limit, int) or not 1 <= limit <= 10:
        raise ToolInputError("limit must be an integer between 1 and 10")
    service = current_selection_service()
    if service is None:
        raise ToolInputError("saved selections are unavailable (no database configured)")
    owner = selection_owner.get()
    if owner is None:
        raise ToolInputError(
            "saved selections are unavailable: this browser has not accepted cookies"
        )
    return {
        "selections": [
            {
                "id": str(sel.id),
                # User-written: cleaned and clearly marked as data.
                "name": sanitize_untrusted(sel.name, 80) if sel.name else None,
                "ra_deg": float(sel.region.ra_deg),
                "dec_deg": float(sel.region.dec_deg),
                "size_arcmin": float(sel.region.size_arcmin),
                "channels": list(sel.channels),
                "view_mode": sel.view_mode,
                "job_status": sel.job_status,
            }
            for sel in service.list_recent(owner, limit)
        ]
    }


SERVER_EXECUTORS = {
    "search_catalog": search_catalog,
    "resolve_object_name": resolve_object_name,
    "list_saved_selections": list_saved_selections,
}


def as_tool_data(payload: dict[str, Any]) -> str:
    """Serialize a tool result as delimited, untrusted data for the model."""
    return (
        "<tool_data>"
        + json.dumps(payload, ensure_ascii=False, sort_keys=True)
        + "</tool_data>"
    )
