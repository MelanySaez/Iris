"""Cookie consent and the owner cookie that scopes saved selections.

There is no login: a browser that accepts cookies receives a random owner id
in an HttpOnly cookie, and its selections are saved under that id. Without it
nothing is saved. The consent choice itself is stored in a readable cookie so
the web app knows whether to show the cookie bar.
"""

from __future__ import annotations

import uuid

from fastapi import APIRouter, Request, Response

from app.exceptions.domain import SelectionsConsentRequiredError
from app.schemas.consent import ConsentRequest, ConsentResponse

OWNER_COOKIE = "iris_owner"
CONSENT_COOKIE = "iris_consent"
COOKIE_MAX_AGE = 365 * 24 * 60 * 60  # one year
CONSENT_REQUIRED_DETAIL = (
    "Selections are saved only after accepting cookies. "
    "Accept the necessary cookies to keep your records."
)

router = APIRouter(prefix="/api/consent", tags=["consent"])


def read_owner(request: Request) -> uuid.UUID | None:
    """The owner id from the browser's cookie, or None when absent or invalid."""
    raw = request.cookies.get(OWNER_COOKIE)
    if not raw:
        return None
    try:
        return uuid.UUID(raw)
    except ValueError:
        return None


def require_owner(request: Request) -> uuid.UUID:
    """FastAPI dependency: the owner id, or a 403 when cookies were not accepted."""
    owner = read_owner(request)
    if owner is None:
        raise SelectionsConsentRequiredError(CONSENT_REQUIRED_DETAIL)
    return owner


@router.post("", response_model=ConsentResponse)
def set_consent(
    body: ConsentRequest, request: Request, response: Response
) -> ConsentResponse:
    """Store the cookie choice; accepting issues (or keeps) the owner cookie."""
    secure = request.url.scheme == "https"
    response.set_cookie(
        CONSENT_COOKIE,
        body.level,
        max_age=COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        secure=secure,
    )
    if body.level == "none":
        response.delete_cookie(OWNER_COOKIE, path="/", samesite="lax", secure=secure)
        return ConsentResponse(level=body.level, records_enabled=False)

    # Keep an existing owner so changing the choice never orphans saved records.
    owner = read_owner(request) or uuid.uuid4()
    response.set_cookie(
        OWNER_COOKIE,
        str(owner),
        max_age=COOKIE_MAX_AGE,
        path="/",
        samesite="lax",
        secure=secure,
        httponly=True,
    )
    return ConsentResponse(level=body.level, records_enabled=True)
