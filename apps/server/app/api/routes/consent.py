"""Cookie consent and the owner cookie that scopes saved selections.

There is no login: a browser that accepts cookies receives a random owner id
in an HttpOnly cookie, and its selections are saved under that id. The consent
choice is stored in a readable cookie so the web app knows whether to show the
cookie bar, and the owner cookie only counts while that choice accepts
cookies. Rejecting keeps the owner cookie, so the records stay hidden and come
back if the browser accepts again.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Request, Response

from app.core.config import Settings
from app.exceptions.domain import SelectionsConsentRequiredError
from app.schemas.consent import ConsentRequest, ConsentResponse

OWNER_COOKIE = "iris_owner"
CONSENT_COOKIE = "iris_consent"
ACCEPTING_LEVELS = ("necessary", "all")
COOKIE_MAX_AGE = 365 * 24 * 60 * 60  # one year
CONSENT_REQUIRED_DETAIL = (
    "Selections are saved only after accepting cookies. "
    "Accept the necessary cookies to keep your records."
)

router = APIRouter(prefix="/api/consent", tags=["consent"])


def _cookie_secure(request: Request) -> bool:
    configured = Settings().COOKIE_SECURE
    return request.url.scheme == "https" if configured is None else configured


def _owner_cookie(request: Request) -> uuid.UUID | None:
    """The owner id stored in the cookie, whatever the consent choice."""
    raw = request.cookies.get(OWNER_COOKIE)
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


def _issue_owner(request: Request, response: Response, owner: uuid.UUID) -> None:
    response.set_cookie(
        OWNER_COOKIE,
        str(owner),
        max_age=COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        secure=_cookie_secure(request),
        httponly=True,
    )


def resolve_owner(request: Request, response: Response) -> uuid.UUID | None:
    """FastAPI dependency: the browser's owner id while it accepts cookies.

    None when the consent cookie does not accept cookies (no choice, ``none``
    or an unknown value), even if an owner cookie remains. When the choice
    accepts cookies but the owner cookie was lost, a new one is issued.
    """
    if request.cookies.get(CONSENT_COOKIE) not in ACCEPTING_LEVELS:
        return None
    owner = _owner_cookie(request)
    if owner is None:
        owner = uuid.uuid4()
        _issue_owner(request, response, owner)
    return owner


def require_owner(owner: uuid.UUID | None = Depends(resolve_owner)) -> uuid.UUID:
    """FastAPI dependency: the owner id, or a 403 when cookies were not accepted."""
    if owner is None:
        raise SelectionsConsentRequiredError(CONSENT_REQUIRED_DETAIL)
    return owner


@router.post("", response_model=ConsentResponse)
def set_consent(
    body: ConsentRequest, request: Request, response: Response
) -> ConsentResponse:
    """Store the cookie choice; accepting issues (or keeps) the owner cookie.

    Rejecting leaves the owner cookie untouched: saving and reading pause, and
    the browser's records come back if it accepts again.
    """
    response.set_cookie(
        CONSENT_COOKIE,
        body.level,
        max_age=COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        secure=_cookie_secure(request),
    )
    if body.level not in ACCEPTING_LEVELS:
        return ConsentResponse(level=body.level, records_enabled=False)
    # Keep an existing owner so changing the choice never orphans saved records.
    _issue_owner(request, response, _owner_cookie(request) or uuid.uuid4())
    return ConsentResponse(level=body.level, records_enabled=True)
