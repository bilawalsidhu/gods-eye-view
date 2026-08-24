"""Shared vocabulary for the official-camera adapters, and the sweep that runs them.

**The boundary first, because it is legal rather than editorial.** Every provider reachable
from here publishes its own estate: a road authority listing the cameras it owns, on its own
domain. Aggregators of unsecured private cameras are excluded and stay excluded. Those index
cameras whose owners misconfigured them, so using one is unauthorised access to a private
system: the Computer Misuse Act 1990 in the UK, state computer-access statutes and the CFAA in
the US. AGENTS.md names this as the one source class still excluded on principle. Nothing in
this module takes a hostname from a caller, and :func:`safe_media_url` refuses any address
outside a per-provider allowlist, so adding an aggregator would take a deliberate edit to a
constant rather than a configuration change.

**ADR 013 stops at the edge of this layer.** Faces are matched in photographs against profiles
we already hold, and camera feeds are explicitly outside that permission. No code reachable
from here detects, embeds, crops or identifies a person, and the contract has nowhere to put
the answer if it did.

**Four adapters, one sweep, and it is not the GTFS-Realtime sweep.** The transit sweep reads
258 feeds sharing one schema. These four share nothing but a subject: four schemas, four
coordinate conventions, four ways of saying "this camera is switched off". So the per-provider
work lives in four modules and what is shared is exactly this: how a media address is proved
safe, how a provider's own flag is read without being truth-tested, and how a sweep reports
what it read and what it refused.

**What is deliberately not shared is the plausibility box.** Each authority states its own
jurisdiction, so the box belongs beside that authority's adapter where it can be written in
that authority's terms. A shared box would either be the whole world, which catches nothing,
or a guess about somebody else's coverage.
"""

import asyncio
import logging
from collections import Counter
from collections.abc import Awaitable, Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Final
from urllib.parse import urlsplit

import httpx

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.camera import Camera, merge_key
from tracker.contracts.geo import BoundingBox, Point
from tracker.sources.base import ParsedRecords, SourceError, describe_exception

_log = logging.getLogger(__name__)

LAYER: Final = "cameras"
"""The layer name this adapter set answers to on ``/api/layers`` and ``/api/capabilities``.

Already a member of the backend's ``LayerName`` union in ``contracts/messages.py``, which was
written before any camera adapter existed. The name was reserved and is now used.
"""

CACHE_NAMESPACE: Final = LAYER
"""Prefix for every key this module writes to the shared :class:`~tracker.cache.DiskCache`."""

CREDENTIALS_IN_URL_REASON: Final = "media address carried embedded credentials"
"""Why a record was refused, written so the reason can be logged and the value cannot.

Nine New York records shipped plaintext basic-auth credentials to a directly addressable
camera over plain HTTP, in the ``VideoUrl`` field, measured on 2026-08-24. A drop reason built
by interpolating the offending URL would put those credentials into the log file, the
``/api/layers`` response and the layer rail, which is three new places they exist. So the
reason is a constant and the value never leaves the parse.
"""

UNAPPROVED_HOST_REASON: Final = "media address was not on the provider's host allowlist"
"""Why a record was refused when its media address pointed somewhere unexpected.

An allowlist rather than a blocklist for the same reason the media proxy uses one: a camera
inventory is a list of addresses supplied by somebody else, and treating it as trusted input
turns our proxy into an open one. New York's own inventory is the worked example, carrying
nine addresses to raw camera hardware alongside 1,754 to the authority's streaming estate.
"""

IMPLAUSIBLE_POSITION_REASON: Final = "position outside the authority's own jurisdiction"
"""Why a record was refused when its coordinates could not be where the authority operates.

Measured on 2026-08-24 against New York 511: four cameras marked enabled sat outside any
plausible New York box, three at exactly ``0.0, 0.0`` and one at longitude +73.22 where -73.22
was meant, which is a dropped minus sign landing in Uzbekistan. All four carried a working HLS
playlist, so nothing about the record other than its position said it was wrong.
"""


def parse_flag(value: object, *, default: bool = False) -> bool:
    """Read a provider's boolean, whether it sent a boolean or the word for one.

    **The string trap is the reason this exists and it is not hypothetical.** TfL's
    ``available`` is the string ``"true"`` or ``"false"``, so ``if ap["available"]:`` is true
    for both and 84 cameras the authority says are down would render as up. Caltrans'
    ``inService`` has the same shape. New York sends a real JSON boolean for ``Disabled`` and
    ``Blocked``, so a shared reader has to take both and cannot assume either.

    Anything that is neither a boolean nor a recognised word returns ``default``. A provider
    inventing a third state is not something to guess at, and the caller decides whether
    unknown means present or absent for its own feed.
    """
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        lowered = value.strip().lower()
        if lowered in {"true", "yes", "1"}:
            return True
        if lowered in {"false", "no", "0"}:
            return False
    return default


def safe_media_url(raw: object, *, allowed_hosts: frozenset[str]) -> str | None:
    """The address, if it is HTTPS, on the allowlist and carries no credentials. Else ``None``.

    Three checks, and each one is here because a real inventory failed it.

    **Credentials.** ``urlsplit`` parses userinfo into ``username`` and ``password``, so the
    presence of either is the test. Nine New York records carried
    ``live:<password>@<ip>:<port>``, pointing at camera hardware directly rather than at the
    authority's streaming estate. Storing one would put a working credential in our database,
    our logs and our API response.

    **Scheme.** HTTPS only. The nine credential-bearing records were also the nine plain-HTTP
    ones, which is not a coincidence: the authority's own estate is HTTPS throughout and the
    exceptions are the records that escaped it.

    **Host.** Matched on ``hostname``, never on ``netloc``, because ``netloc`` carries the port
    and four New York records are published as ``s51.nysdot.skyvdn.com:443``. A ``netloc``
    comparison drops those four while a ``hostname`` comparison keeps them, and the difference
    reads as four cameras that are mysteriously missing. Suffix matching is on a dot boundary,
    so ``evilnysdot.skyvdn.com`` is not treated as a subdomain of ``nysdot.skyvdn.com``.
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    parts = urlsplit(raw.strip())
    if parts.username is not None or parts.password is not None:
        return None
    if parts.scheme != "https":
        return None
    host = (parts.hostname or "").lower()
    if not host:
        return None
    if any(host == allowed or host.endswith(f".{allowed}") for allowed in allowed_hosts):
        return raw.strip()
    return None


def refusal_reason(raw: object) -> str:
    """Which allowlist rule an address failed, without ever naming the address.

    Split from :func:`safe_media_url` rather than returned alongside it so the counting path
    and the value path stay separate: the caller can put this string in a ``Counter`` that
    reaches ``/api/layers``, and there is no version of it that carries a credential.
    """
    if isinstance(raw, str) and "@" in urlsplit(raw.strip()).netloc:
        return CREDENTIALS_IN_URL_REASON
    return UNAPPROVED_HOST_REASON


def plausible(point: Point, box: BoundingBox) -> bool:
    """Whether a camera could be where the authority says it is.

    A thin wrapper over :meth:`BoundingBox.contains`, named for what it means here so the
    call site reads as the check it is rather than as a viewport filter. The two are different
    intentions and a later reader who mistakes one for the other would happily widen this box
    to fit a camera in.
    """
    return box.contains(point)


@dataclass(frozen=True, slots=True)
class CameraProvider:
    """One authority's camera feed: how to read it, how often, and what it must be credited as.

    A record rather than a class hierarchy, because the only thing that genuinely differs
    between these four is the parse, and that is the ``fetch`` callable. Everything else is
    data, and data can be asserted by a test without constructing anything.
    """

    name: str
    """Our short name for the feed, and the ``provider`` half of every key it produces."""

    operator: str
    """The body that owns the cameras, for the card and the mandatory credit."""

    country: str
    """ISO 3166-1 alpha-2 for the authority's jurisdiction. Not from the payload: none of
    these feeds states a country and each is a single-jurisdiction road authority."""

    licence: str
    """The terms the records travel under, verbatim enough to be checked against the source."""

    min_interval_seconds: float
    """The floor for one fetch of this authority's inventory.

    Slow on purpose across the board. A camera inventory is furniture that changes when an
    authority installs or retires a camera, so the useful cadence is hours rather than
    seconds, and the pictures are fetched on demand by the proxy rather than by this sweep.
    TfL's inventory alone is 1.1MB and its own guidance is to fetch it daily.
    """

    fetch: Callable[[httpx.AsyncClient], Awaitable[ParsedRecords[Camera]]]
    """Read this authority's inventory once and map it. Never rate-limits itself: the floor
    above is enforced by the sweep, in one place, against the shared disk cache."""


@dataclass(frozen=True, slots=True)
class CameraSweepResult:
    """What one pass over the provider registry did.

    The same shape as the transit sweep's result and for the same reason: a pass that skipped a
    provider inside its own floor is not a pass that failed, and collapsing the two makes a
    working rate discipline read as a dead feed.
    """

    records: tuple[Camera, ...] = ()
    """Every camera that mapped, from every provider read this pass."""

    polled: int = 0
    """Providers actually fetched."""

    skipped: int = 0
    """Providers held back inside their own floor. Not a failure."""

    failures: dict[str, str] = field(default_factory=dict)
    """Why each provider that could not be read could not be read, keyed by provider name."""

    drops: Counter[str] = field(default_factory=Counter)
    """Records refused this pass, keyed by the adapter's own reason."""

    @property
    def failed(self) -> int:
        """How many providers could not be read."""
        return len(self.failures)


class CameraSweep:
    """Reads every registered authority's inventory on its own floor.

    **The floor is per provider and it is persisted, not held in memory.** A restart loop is
    indistinguishable from hammering as far as an authority is concerned, so the next-allowed
    time for each provider goes through the shared :class:`~tracker.cache.DiskCache` exactly as
    CelesTrak's two-hour window does. A process started inside a provider's window opens no
    socket to it at all.

    **A provider that fails does not fail the sweep.** Four independent authorities on four
    continents-worth of infrastructure will not all answer on the same pass, and taking the
    whole layer down because one did would be worse than serving three. Only a pass where
    nothing was read and nothing was held back is a failed poll, which is the distinction the
    transit poller already draws.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        providers: Sequence[CameraProvider],
        cache: DiskCache | None = None,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._client = client
        self._providers = tuple(providers)
        self._cache = cache
        self._clock = clock

    @property
    def name(self) -> str:
        """Short identifier for this feed, used in health output and logs."""
        return LAYER

    @property
    def min_interval_seconds(self) -> float:
        """The strictest floor in the registry, so one pass cannot breach any of them."""
        return min((p.min_interval_seconds for p in self._providers), default=3600.0)

    @property
    def providers(self) -> tuple[CameraProvider, ...]:
        """The registry this sweep reads, for the credits and the coverage row."""
        return self._providers

    async def sweep(self) -> CameraSweepResult:
        """One pass over every provider whose floor has expired.

        Concurrent across providers because they are four unrelated hosts and nothing is
        shared between them but the cache. Sequential would make the pass as slow as the sum
        of four inventories, three of which are over a megabyte.
        """
        due = [p for p in self._providers if self._is_due(p)]
        skipped = len(self._providers) - len(due)
        if not due:
            return CameraSweepResult(skipped=skipped)

        outcomes = await asyncio.gather(
            *(self._read(provider) for provider in due), return_exceptions=False
        )

        records: list[Camera] = []
        drops: Counter[str] = Counter()
        failures: dict[str, str] = {}
        polled = 0
        seen: set[str] = set()
        for provider, parsed, error in outcomes:
            if error is not None:
                failures[provider.name] = error
                continue
            polled += 1
            drops.update(parsed.drops)
            for camera in parsed.records:
                key = merge_key(camera.provider, camera.camera_id)
                if key in seen:
                    # An authority listing one camera twice in one payload. Counted rather
                    # than silently collapsed, because a rising count here means the identity
                    # this layer keys on has stopped being unique inside its own feed, which
                    # is the failure the transit contract measured across 247 feeds.
                    drops["duplicate identity within one inventory"] += 1
                    continue
                seen.add(key)
                records.append(camera)

        return CameraSweepResult(
            records=tuple(records),
            polled=polled,
            skipped=skipped,
            failures=failures,
            drops=drops,
        )

    async def _read(
        self, provider: CameraProvider
    ) -> tuple[CameraProvider, ParsedRecords[Camera], str | None]:
        """Fetch and map one provider, turning any fault into a reason a person can read.

        Never raises. ``describe_exception`` rather than ``str(exc)`` because several httpx
        exceptions stringify to the empty string, and a provider that failed for no stated
        reason is worse on the rail than one that failed bluntly.
        """
        try:
            parsed = await provider.fetch(self._client)
        except SourceError as exc:
            self._mark_read(provider)
            return provider, ParsedRecords(records=()), exc.detail
        except (httpx.HTTPError, ValueError) as exc:
            self._mark_read(provider)
            return provider, ParsedRecords(records=()), describe_exception(exc)
        self._mark_read(provider)
        return provider, parsed, None

    def _floor_key(self, provider: CameraProvider) -> str:
        return cache_key(CACHE_NAMESPACE, provider.name, "not_before")

    def _is_due(self, provider: CameraProvider) -> bool:
        """Whether this provider's floor has expired.

        With no cache configured every provider is due, which is the right answer for a test
        that injects a stub client: the guard exists to protect a real authority from a real
        process, and an in-memory-only run has no authority to protect.
        """
        if self._cache is None:
            return True
        not_before = self._cache.get_time(self._floor_key(provider))
        return not_before is None or self._clock() >= not_before

    def _mark_read(self, provider: CameraProvider) -> None:
        """Hold this provider off until its floor expires.

        Written whether the read succeeded or failed, and unconditionally, because a floor can
        only ever delay us: persisting it after a failure is what stops a provider that is
        down being asked again every thirty seconds for as long as it stays down.
        """
        if self._cache is None:
            return
        until = self._clock() + timedelta(seconds=provider.min_interval_seconds)
        self._cache.set_time(self._floor_key(provider), until)


def coverage_reason(providers: Iterable[CameraProvider]) -> str:
    """What this layer actually covers, built from the providers that exist.

    Derived rather than written down, for the reason AGENTS.md gives about the transit store's
    time to live: a sentence naming four authorities goes stale the moment somebody adds a
    fifth, and nobody remembers to edit a string. Building it from the registry means adding a
    provider updates the notice by construction.

    The notice matters because "cameras" invites an assumption of worldwide coverage and the
    honest answer is a handful of road authorities. A viewer looking at an empty Germany needs
    to know nobody there publishes into this layer, not conclude the layer is broken.
    """
    named = sorted({p.operator for p in providers})
    countries = sorted({p.country for p in providers})
    if not named:
        return "No camera authority is configured, so this layer draws nothing."
    return (
        f"Official road-authority cameras only, from {len(named)} "
        f"{'authority' if len(named) == 1 else 'authorities'} in "
        f"{len(countries)} {'country' if len(countries) == 1 else 'countries'}: "
        f"{', '.join(named)}. Aggregators of unsecured private cameras are excluded on "
        "principle, so a road with no camera here is a road no authority publishes."
    )
