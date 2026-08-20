"""CelesTrak GP orbital element adapter.

One provider, one host, one cadence floor. Downstream code sees only
:class:`~tracker.contracts.satellite.Satellite`.

**The cache is the feature, not an optimisation.** CelesTrak's usage policy says GP data
updates once every two hours and asks for one download per update. The two-hour floor is
enforced against the cache below, so a poller asking more often is served the copy we
already hold and no HTTP request leaves the process.

**Any non-200 stops this feed for the life of the process.** That is a deliberate departure
from :class:`~tracker.sources.base.RateLimitedError`, which the ADS-B adapter uses to back
off and retry. Retrying CelesTrak after a 403 is exactly the behaviour that gets an IP
firewalled. Their policy, verbatim, from ``celestrak.org/usage-policy.php``:

    Most importantly, we send HTTP error responses when users are exceeding limits or using
    incorrect (long-outdated) URLs (e.g., HTTP 301, 403, 404, 50x). M2M (machine-to-machine)
    software should immediately stop querying when it receives any non-HTTP 200 responses
    and report the results to a human for investigation. Repeatedly ignoring them will end
    up sending your IP address to the firewall.

"Report to a human" is not the human-in-the-data-path that AGENTS.md bans. Nothing waits on
a person: the feed stops itself and :attr:`CelestrakClient.unavailable_reason` says why, the
same route a missing key takes.

**The URL is hardcoded on purpose.** Their policy redirects anything that is not
``https://celestrak.org`` exactly, and a 301 is a non-200 that would latch this feed off
permanently. A configurable base URL is how a ``www.`` typo becomes an outage, and there is
no second host to point at. The SupGP documentation page's own examples are written with
``www.``, so copying them walks straight into it.

**CelesTrak was unreachable when this was written** (2026-08-20: TCP 443 and 80 both dead
from two independent networks, ``connect=0.000000``, with the site serving a week earlier).
That is a transport failure, not a policy block, so it does not latch: the layer reports
itself unavailable with the reason and a later poll may succeed. Everything here is built
and tested against the recorded payloads in ``tests/fixtures/``.

**No TLE anywhere in this module.** ``satellite.js`` takes CelesTrak OMM JSON directly
through ``json2satrec``, verified at npm 7.1.0 against ``tests/fixtures/celestrak_iss_omm.json``.
A TLE encoder here would also be dead on arrival: CelesTrak exhausted the 5-digit catalogue
on 2026-07-11, the format has no sixth digit, and every object catalogued since is
unrepresentable in it.

Two things this adapter deliberately does not do, recorded so nobody adds them by reflex.
Supplemental element sets live at a different endpoint,
``https://celestrak.org/NORAD/elements/supplemental/sup-gp.php?{QUERY}=VALUE[&FORMAT=VALUE]``
with ``{QUERY}`` one of ``CATNR``, ``INTDES``, ``SOURCE``, ``NAME``, ``SPECIAL`` or ``FILE``,
and it can return several element sets for one object (multiple sources, multiple epochs), so
its merge key is catalogue number plus source plus epoch rather than the catalogue number
alone. And decay status lives on SATCAT (``DECAY_DATE``, ``OPS_STATUS_CODE``), a separate
endpoint on a daily cadence whose ``FORMAT`` defaults to JSON rather than CSV. Neither is
fetched in phase 2.
"""

import json
import logging
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

import httpx
from pydantic import Field, TypeAdapter

from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.satellite import Satellite
from tracker.sources.base import SourceError

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "celestrak"
"""Provenance carried on every record, and the attribution shown on the card."""

GP_URL: Final = "https://celestrak.org/NORAD/elements/gp.php"
"""The general perturbations endpoint. Not configurable: see the module docstring."""

GP_FORMAT: Final = "JSON"
"""Passed explicitly on every request, always.

``FORMAT`` is optional and **defaults to CSV as of 2026-05-09**, so omitting it returns
comma-separated text that the JSON parser rejects. The same trap runs the other way on
``satcat/records.php``, whose default is JSON, which is why the rule is "always pass it"
rather than "remember which default applies where".
"""

MIN_GROUP_INTERVAL_S: Final = 2.0 * 60.0 * 60.0
"""Hard floor: one request per group per two hours. CelesTrak's own figure.

A constant, never a setting, and there is no constructor argument that can lower it.
CelesTrak firewalls abusive clients without appeal and their policy states the cadence in
writing ("For GP data, updates are once every 2 hours"). Configuration can only slow this
feed down, via the poll interval, never speed it up.
"""


class CelestrakStoppedError(SourceError):
    """CelesTrak answered with a non-200, and this process will not query it again.

    Distinct from a plain :class:`~tracker.sources.base.SourceError` so a caller can tell a
    latched policy stop from a transient outage. There is no retry: the latch is the whole
    point.
    """

    def __init__(self, source: str, detail: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(source, detail)


class OmmRecordWire(WireModel):
    """One GP element set exactly as CelesTrak sends it in OMM JSON.

    Field names are the OMM keywords, carried as aliases so the provider's shape stays in
    this file. CelesTrak sends the numerics as JSON **numbers**; Space-Track sends the same
    fields as strings, and :class:`~tracker.contracts.base.WireModel` is non-strict so both
    parse.

    Only ``OBJECT_NAME`` and ``OBJECT_ID`` are optional, and only because CelesTrak
    documents that analyst objects in the 80000 series carry neither. Everything else is
    required: a missing ``BSTAR`` defaulted to zero would be a fabricated drag term, and
    zero is a real value on a geostationary object (the recorded TDRS 3 record has exactly
    that), so absence and zero must not collapse into one. A record missing a required
    keyword is dropped and counted instead.
    """

    object_name: str | None = Field(default=None, alias="OBJECT_NAME")
    object_id: str | None = Field(default=None, alias="OBJECT_ID")
    epoch: datetime = Field(alias="EPOCH")
    mean_motion: float = Field(alias="MEAN_MOTION")
    eccentricity: float = Field(alias="ECCENTRICITY")
    inclination: float = Field(alias="INCLINATION")
    ra_of_asc_node: float = Field(alias="RA_OF_ASC_NODE")
    arg_of_pericenter: float = Field(alias="ARG_OF_PERICENTER")
    mean_anomaly: float = Field(alias="MEAN_ANOMALY")
    ephemeris_type: int = Field(alias="EPHEMERIS_TYPE")
    classification_type: str = Field(alias="CLASSIFICATION_TYPE")
    norad_cat_id: int = Field(alias="NORAD_CAT_ID")
    element_set_no: int = Field(alias="ELEMENT_SET_NO")
    rev_at_epoch: int = Field(alias="REV_AT_EPOCH")
    bstar: float = Field(alias="BSTAR")
    mean_motion_dot: float = Field(alias="MEAN_MOTION_DOT")
    mean_motion_ddot: float = Field(alias="MEAN_MOTION_DDOT")


_RECORD_ADAPTER: Final = TypeAdapter(OmmRecordWire)


def _now() -> datetime:
    """Wall clock, injectable so cadence tests assert a boundary instead of sleeping."""
    return datetime.now(UTC)


def _utc_epoch(value: datetime) -> datetime:
    """Attach UTC to CelesTrak's naive ``EPOCH``.

    It arrives as ``2026-08-19T12:48:46.640160``: six decimal places, no ``Z``, no offset.
    It is UTC by specification, and CelesTrak omits the OMM ``TIME_SYSTEM`` keyword
    precisely because it is always ``UTC``. Attaching it here is the only place that
    happens, so nothing downstream ever sees a naive timestamp. Already-aware values are
    converted rather than stamped, so a provider that starts sending an offset does not get
    silently relabelled as UTC.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _to_domain(wire: OmmRecordWire, *, group: str, fetched_at: datetime) -> Satellite:
    """Map one wire record to the domain contract.

    Raises whatever the contract raises. The caller counts the drop; nothing is partially
    accepted. Angles and mean motion cross unchanged: CelesTrak publishes degrees and
    revolutions per day, which is what the contract holds, and radians appear only inside
    SGP4 in the browser.
    """
    name = wire.object_name.strip() if wire.object_name else ""
    designator = wire.object_id.strip() if wire.object_id else ""
    return Satellite(
        norad_cat_id=wire.norad_cat_id,
        object_name=name or None,
        object_id=designator or None,
        classification_type=wire.classification_type.strip().upper(),
        epoch=_utc_epoch(wire.epoch),
        mean_motion=wire.mean_motion,
        eccentricity=wire.eccentricity,
        inclination_deg=wire.inclination,
        ra_of_asc_node_deg=wire.ra_of_asc_node,
        arg_of_pericenter_deg=wire.arg_of_pericenter,
        mean_anomaly_deg=wire.mean_anomaly,
        bstar=wire.bstar,
        mean_motion_dot=wire.mean_motion_dot,
        mean_motion_ddot=wire.mean_motion_ddot,
        ephemeris_type=wire.ephemeris_type,
        element_set_no=wire.element_set_no,
        rev_at_epoch=wire.rev_at_epoch,
        group=group,
        fetched_at=fetched_at,
        source=SOURCE_NAME,
    )


def _require_omm_array(payload: bytes | str, *, source: str) -> list[Any]:
    """Reject a 200 that is not a non-empty OMM array.

    Three real failure shapes hide behind a 200 here. A CSV body, if ``FORMAT`` were ever
    dropped from the query. An HTML error or maintenance page. And an empty body, which is
    how AISHub signals a bad credential and is the precedent AGENTS.md already records.

    An empty array is treated as a failure too. We only ever ask for a named group that we
    know holds objects, so zero records means something broke upstream rather than that the
    sky emptied, and letting it through would blank the layer with a healthy-looking poll.
    The exact shape CelesTrak returns for a query matching nothing is unverified, because
    the site was down when this was written and no archived example exists.
    """
    try:
        raw = json.loads(payload)
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise ContractViolationError(source, f"payload is not JSON: {exc}") from exc
    if not isinstance(raw, list):
        raise ContractViolationError(
            source, f"expected an OMM JSON array, got {type(raw).__name__}"
        )
    if not raw:
        raise ContractViolationError(
            source, "OMM array is empty; treating as upstream failure, not as an empty sky"
        )
    return raw


def parse_elements(
    payload: bytes | str,
    *,
    group: str,
    fetched_at: datetime,
    source: str = SOURCE_NAME,
) -> tuple[Satellite, ...]:
    """Parse an OMM JSON array into domain element sets.

    Raises :class:`~tracker.contracts.base.ContractViolationError` when the payload itself is
    not a usable OMM array, because that means the provider changed shape or served an error
    page behind a 200 and the caller must not treat it as data. Individual records that will
    not map are dropped and counted, so one corrupt element set cannot empty the layer, but
    an array where **every** record fails is a shape change too and raises rather than
    returning nothing.

    Args:
        payload: The raw response body.
        group: The CelesTrak group this batch was fetched from, carried as provenance.
        fetched_at: When the fetch happened, distinct from each record's epoch.
        source: Adapter name, overridable only so a test can assert on it.
    """
    records = _require_omm_array(payload, source=source)

    satellites: list[Satellite] = []
    skipped = 0
    for record in records:
        try:
            wire = validate_payload(_RECORD_ADAPTER, record, source=source)
            satellites.append(_to_domain(wire, group=group, fetched_at=fetched_at))
        except (ContractViolationError, ValueError, TypeError) as exc:
            skipped += 1
            _log.debug("dropping unmappable element set: %s", exc)

    if skipped:
        _log.info(
            "%s/%s: kept %d element sets, dropped %d", source, group, len(satellites), skipped
        )
    if not satellites:
        # Every record failed, which is a provider shape change (one OMM keyword renamed or
        # dropped), not an empty sky. Returning () here would blank the layer behind a
        # healthy-looking poll, the exact outcome _require_omm_array refuses one level up.
        raise ContractViolationError(
            source,
            f"all {skipped} element sets in the GROUP={group} array failed to map; "
            "treating as an upstream shape change, not as data",
        )
    return tuple(satellites)


@dataclass(frozen=True, slots=True)
class _CachedGroup:
    """One group's last successful fetch."""

    fetched_at: datetime
    satellites: tuple[Satellite, ...]


class CelestrakClient:
    """Fetches GP element sets, at most once per group per two hours.

    Holds the cache that the floor is enforced against, so this object must live for the
    process rather than being constructed per request. One process owns it, which is also
    what CelesTrak asks of anyone behind a shared egress address.

    Takes no cadence argument of any kind, deliberately: see :data:`MIN_GROUP_INTERVAL_S`.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        clock: Callable[[], datetime] = _now,
    ) -> None:
        self._client = client
        self._clock = clock
        self._cache: dict[str, _CachedGroup] = {}
        self._attempted_at: dict[str, datetime] = {}
        self._stopped_reason: str | None = None
        self._last_error: str | None = None

    @property
    def name(self) -> str:
        """Short identifier for this feed, used in health output and logs."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """CelesTrak's two-hour floor. Read-only, with no setter, on purpose."""
        return MIN_GROUP_INTERVAL_S

    @property
    def unavailable_reason(self) -> str | None:
        """Why the satellite layer cannot serve, or ``None`` when it can.

        Shaped for ``LayerCapability(available=False, reason=...)``. A feed that has never
        succeeded is unavailable, not healthy-and-empty, which is the distinction that stops
        an empty globe reading as a working one.
        """
        if self._stopped_reason is not None:
            return self._stopped_reason
        # Cached *element sets*, not cache keys: a dict holding one empty group is truthy,
        # and reporting that as available publishes a working layer with nothing to draw.
        if any(entry.satellites for entry in self._cache.values()):
            return None
        if self._last_error is not None:
            return f"CelesTrak has not served an element set: {self._last_error}"
        return "CelesTrak has not been queried yet"

    def cached_at(self, group: str) -> datetime | None:
        """When this group was last fetched successfully, or ``None`` if never."""
        entry = self._cache.get(group)
        return entry.fetched_at if entry is not None else None

    def cached_elements(self) -> tuple[Satellite, ...]:
        """Every cached element set, one record per catalogue number.

        What ``/api/satellites/elements`` serves. Deduplicated because CelesTrak groups
        overlap (``stations`` is a subset of ``active``) and the same object arriving from
        two groups would otherwise be propagated and drawn twice. The freshest epoch wins,
        and two element sets are never blended into a third that no orbit determination
        produced.
        """
        best: dict[int, Satellite] = {}
        for entry in self._cache.values():
            for satellite in entry.satellites:
                existing = best.get(satellite.norad_cat_id)
                if existing is None or satellite.epoch > existing.epoch:
                    best[satellite.norad_cat_id] = satellite
        return tuple(best.values())

    async def elements(self, group: str) -> tuple[Satellite, ...]:
        """Element sets for one CelesTrak group, from cache when the floor holds.

        The only call a poller needs. Inside the two-hour window this makes no HTTP request
        at all and returns the cached copy.

        Raises:
            CelestrakStoppedError: The feed is latched off after a non-200.
            SourceError: The floor holds but there is nothing cached to serve, or CelesTrak
                is unreachable.
            ContractViolationError: A 200 that is not a usable OMM array.
        """
        if self._stopped_reason is not None:
            raise CelestrakStoppedError(SOURCE_NAME, self._stopped_reason)

        now = self._clock()
        last_attempt = self._attempted_at.get(group)
        if last_attempt is not None and (now - last_attempt).total_seconds() < MIN_GROUP_INTERVAL_S:
            cached = self._cache.get(group)
            if cached is not None:
                return cached.satellites
            because = self._last_error or "no successful fetch yet"
            detail = (
                f"two-hour floor holds for GROUP={group} after an attempt at "
                f"{last_attempt.isoformat()}; nothing cached to serve ({because})"
            )
            raise SourceError(SOURCE_NAME, detail)

        # Recorded before the request, not after it: the floor counts requests we made, not
        # requests that worked. A failed fetch has still cost CelesTrak a request.
        self._attempted_at[group] = now
        satellites = await self._fetch(group)
        self._cache[group] = _CachedGroup(fetched_at=now, satellites=satellites)
        return satellites

    async def _fetch(self, group: str) -> tuple[Satellite, ...]:
        """One request. Latches the feed off on any non-200.

        ``follow_redirects=False`` is load-bearing. A 301 means the URL is wrong, and
        following it would turn a policy warning into a silent success against an endpoint
        CelesTrak has asked us to stop using.
        """
        params = {"GROUP": group, "FORMAT": GP_FORMAT}
        try:
            response = await self._client.get(GP_URL, params=params, follow_redirects=False)
        except httpx.HTTPError as exc:
            # A dead socket is not a policy block: their firewalling returns an HTTP
            # response, so this does not latch and a later poll may succeed.
            self._last_error = f"unreachable: {type(exc).__name__}: {exc}"
            raise SourceError(SOURCE_NAME, self._last_error) from exc

        if response.status_code != httpx.codes.OK:
            self._stopped_reason = (
                f"CelesTrak answered HTTP {response.status_code} for GROUP={group}. Their "
                "usage policy requires us to stop querying on any non-200, so this process "
                "will not ask again."
            )
            _log.error("%s", self._stopped_reason)
            raise CelestrakStoppedError(SOURCE_NAME, self._stopped_reason, response.status_code)

        try:
            satellites = parse_elements(
                response.content, group=group, fetched_at=self._clock(), source=SOURCE_NAME
            )
        except ContractViolationError as exc:
            self._last_error = str(exc)
            raise
        else:
            self._last_error = None
            return satellites
