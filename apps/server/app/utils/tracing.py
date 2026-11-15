"""Request correlation shared by the HTTP middleware and the job manager."""

from __future__ import annotations

from contextvars import ContextVar

# Set per HTTP request by the middleware in app.main; read when a job is
# submitted so its log lines and snapshot carry the request that created it.
request_id_var: ContextVar[str | None] = ContextVar("request_id", default=None)
