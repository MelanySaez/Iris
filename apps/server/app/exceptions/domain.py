"""Domain errors raised by the service layer.

Services never import FastAPI: they raise these errors and
``app.exceptions.handlers`` maps them to the HTTP contract.
"""

from __future__ import annotations


class AppError(Exception):
    """Base class for expected application failures."""

    status_code = 400

    def __init__(self, detail: str) -> None:
        super().__init__(detail)
        self.detail = detail


# -- generic HTTP-shaped categories ---------------------------------------------


class BadRequestError(AppError):
    status_code = 400


class RequestValidationError(AppError):
    status_code = 422


class NotFoundError(AppError):
    status_code = 404


class ConflictError(AppError):
    status_code = 409


class TooManyRequestsError(AppError):
    status_code = 429


class UpstreamServiceError(AppError):
    status_code = 502


class ServiceUnavailableError(AppError):
    status_code = 503


# -- channel catalog ------------------------------------------------------------


class ChannelCatalogUnavailableError(ServiceUnavailableError):
    """The HiPS properties could not be fetched and no cache exists."""


class ChannelOutOfRangeError(NotFoundError):
    """The requested channel index is outside the catalog."""


# -- jobs and derived frames ----------------------------------------------------


class RegionRequestError(RequestValidationError):
    """Region, channel list or product selection violates the job contract."""


class JobNotFoundError(NotFoundError):
    """No snapshot exists for the requested job id."""


class JobNotReadyError(ConflictError):
    """The job has not reached ``ready`` yet, or it failed."""


class CutoutUnavailableError(NotFoundError):
    """The job's derived cutout is not available anymore."""


class UnknownProductError(NotFoundError):
    """The requested product is not one this endpoint can serve."""


class ProductNotRequestedError(NotFoundError):
    """The product exists but this job never requested it."""


class FrameOptionError(RequestValidationError):
    """A render option such as ``mode`` or ``stretch`` is invalid."""


class PixelOutOfBoundsError(RequestValidationError):
    """Pixel coordinates fall outside the cutout."""


# -- object names ---------------------------------------------------------------


class NameNotFoundError(NotFoundError):
    """No catalogue knows the requested name."""


class NameInvalidError(RequestValidationError):
    """The requested name is empty or uses unsafe characters."""


class NameResolverUnavailableError(ServiceUnavailableError):
    """Every name provider failed, so the answer is not definitive."""


# -- All-Sky Cube spectra -------------------------------------------------------


class SpectrumRequestError(RequestValidationError):
    """Coordinates are not finite or declination is out of range."""


class SpectrumNotFoundError(NotFoundError):
    """No All-Sky Cube tile covers the position."""


class CubeUpstreamError(UpstreamServiceError):
    """IRSA answered with an error, an unusable range or a malformed tile."""


# -- selection records ----------------------------------------------------------


class SelectionNotFoundError(NotFoundError):
    """No selection record exists for the requested id."""


class SelectionsConsentRequiredError(AppError):
    """The browser has no owner cookie: cookies were not accepted."""

    status_code = 403


class SelectionsDisabledError(ServiceUnavailableError):
    """Selection persistence is disabled because ``DATABASE_URL`` is unset."""


class InvalidDatabaseUrlError(ServiceUnavailableError):
    """The configured database URL could not build an engine."""


# -- assistant ------------------------------------------------------------------


class AssistantDisabledError(ServiceUnavailableError):
    """The assistant is disabled until its key and model are configured."""


class AssistantRateLimitedError(TooManyRequestsError):
    """The client exceeded the per-minute assistant rate limit."""


class AssistantProviderRateLimitedError(ServiceUnavailableError):
    """The model provider is rate-limiting this server's requests."""


class AssistantModelUnavailableError(UpstreamServiceError):
    """The model provider could not answer the request."""
