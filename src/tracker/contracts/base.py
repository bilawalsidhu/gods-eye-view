"""Foundations every domain contract is built on.

Two model bases live here. ``StrictModel`` is the domain base: nothing gets past it
unless it is exactly the declared shape. ``WireModel`` is the upstream base, used only
inside ``tracker.sources``, and it tolerates fields we have never seen because upstream
feeds add them without warning.

The boundary between the two is where an adapter maps a provider's payload into our
domain. That mapping is the only place provider quirks are allowed to exist.
"""

from datetime import UTC, datetime
from typing import Annotated, Any, TypeVar

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    TypeAdapter,
    ValidationError,
)


def _require_utc(value: datetime) -> datetime:
    """Reject naive datetimes and normalise anything else to UTC.

    Pydantic's strict mode accepts a naive ``datetime`` happily, which is how a local
    timestamp ends up being compared against a UTC one and an aircraft appears to have
    a fix an hour in the future. Every timestamp in the domain carries an offset.
    """
    if value.tzinfo is None or value.tzinfo.utcoffset(value) is None:
        raise ValueError("timestamp must be timezone-aware; naive datetimes are ambiguous")
    return value.astimezone(UTC)


UtcDatetime = Annotated[datetime, AfterValidator(_require_utc)]
"""A timezone-aware datetime, normalised to UTC. Use this and never bare ``datetime``."""

Longitude = Annotated[float, Field(ge=-180.0, le=180.0)]
"""Degrees east of the prime meridian, WGS84."""

Latitude = Annotated[float, Field(ge=-90.0, le=90.0)]
"""Degrees north of the equator, WGS84."""

Bearing = Annotated[float, Field(ge=0.0, lt=360.0)]
"""Degrees clockwise from true north."""


class StrictModel(BaseModel):
    """Base for every domain contract.

    ``strict`` stops silent coercion, ``extra="forbid"`` means an upstream that starts
    sending a new field fails a test instead of being quietly ignored, and ``frozen``
    makes entity snapshots safe to share between the store, the hub and the API without
    defensive copying.
    """

    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        validate_default=True,
    )

    # Deliberately NO model_validator(mode="before") on this base, and none should be added.
    # A before-validator on a strict model forces every downstream field into Python-mode
    # validation, so `validate_json` then rejects a JSON array for a tuple field and an ISO
    # string for a datetime. That silently breaks JSON validation for every contract in the
    # app. Verified against pydantic 2.13. Derived values are therefore kept off the wire
    # (plain properties, not computed fields) so models round-trip without preprocessing.


class WireModel(BaseModel):
    """Base for upstream payload models, used only inside ``tracker.sources``.

    Deliberately lenient in both directions. ``extra="ignore"`` because adsb.lol's
    ``/v2/mil`` endpoint returns eight fields ``/v2/point`` does not, and a strict model
    would reject every military aircraft. Non-strict because feeds send numbers as
    strings whenever it suits them.
    """

    model_config = ConfigDict(
        extra="ignore",
        frozen=True,
        populate_by_name=True,
    )


ModelT = TypeVar("ModelT", bound=BaseModel)


class ContractViolationError(Exception):
    """An upstream payload could not be mapped into a domain contract.

    Carries the source name so the caller can count violations per feed rather than
    logging an anonymous stack trace.
    """

    def __init__(self, source: str, detail: str) -> None:
        self.source = source
        self.detail = detail
        super().__init__(f"{source}: {detail}")


def validate_payload[ModelT: BaseModel](
    adapter: TypeAdapter[ModelT],
    payload: bytes | str | Any,
    *,
    source: str,
) -> ModelT:
    """Validate a raw upstream payload, raising :class:`ContractViolationError` on failure.

    Accepts raw bytes so JSON is parsed by pydantic-core rather than round-tripping
    through Python objects, which is measurably faster on the large aircraft payloads
    and gives us JSON-mode validation (where ISO strings become datetimes).
    """
    try:
        if isinstance(payload, bytes | str):
            return adapter.validate_json(payload)
        return adapter.validate_python(payload)
    except ValidationError as exc:
        raise ContractViolationError(source, _summarise(exc)) from exc


def _summarise(exc: ValidationError, *, limit: int = 3) -> str:
    """Compress a ValidationError into one readable line.

    A failing aircraft payload can produce hundreds of errors; the first few name the
    real problem and the rest are noise.
    """
    errors = exc.errors()
    shown = [f"{'.'.join(str(p) for p in e['loc'])}: {e['msg']}" for e in errors[:limit]]
    suffix = f" (+{len(errors) - limit} more)" if len(errors) > limit else ""
    return "; ".join(shown) + suffix
