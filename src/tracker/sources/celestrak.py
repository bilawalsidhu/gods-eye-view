"""Orbital element adapter: CelesTrak's OMM JSON contract, from whichever host will serve it.

One contract, several hosts, one cadence floor. Downstream code sees only
:class:`~tracker.contracts.satellite.Satellite`.

**CelesTrak is not down. CelesTrak is refusing this network, and that changes what to do
about it.** An earlier version of this docstring called the silence a transport failure that
might clear on its own. Corrected 2026-08-20 against measurements from three independent
networks taken the same day:

- this laptop: ``http=000``, connection timed out after 30s on ``celestrak.org:443``, DNS
  resolving fine to ``104.168.149.178``
- Anthropic's fetch service: ``connect ECONNREFUSED 104.168.149.178:443``
- GitHub Actions runners, reached through two third-party mirrors: **HTTP 200 with that
  day's data**

Two different failure modes against one IP while a third network is served is a firewall
rule, not an outage. The ``astrion-tech/celestrak-mirror`` README names the mechanism in as
many words: it re-fetches "from runner IPs that CelesTrak does not block, so consumers behind
blocked datacenter ASNs can still ingest the data". CelesTrak's usage policy has no appeal
route, so waiting and retrying is not a plan. Redundancy is.

**So this module is a provider chain, not one host.** :data:`PROVIDER_CHAIN` is the ordered
set, and the whole reason it can exist is that ReTLEctor and the satvisor mirror both serve
the *identical* CelesTrak OMM JSON contract: same keywords, same naive-UTC ``EPOCH``, same
types. Verified 2026-08-20, both hosts returning byte-identical ISS elements. Nothing in the
parser changes per provider, which is the point.

**Every host in the chain is one origin, and confidence must not double-count them.**
ReTLEctor and satvisor are caches of CelesTrak. Two of them agreeing is the same file fetched
twice, not corroboration, which is exactly the error ``docs/pending-decisions.md`` already
flags against ADR 010 for ADS-B. The genuinely independent origins for orbital elements are
CelesTrak, Space-Track (reachable keyless only through SatNOGS DB), AMSAT, McCants, NASA
SSCWeb, SpaceX and Planet Labs. None of them serves OMM JSON per CelesTrak group, so none of
them is in this chain yet; see ``docs/data-sources.md`` for what each would cost.

**A republisher going stale silently is a worse failure than a host going down, and it is the
new failure mode this chain buys.** An outage is loud. A proxy that keeps serving last week's
elements draws satellites confidently in the wrong place, because SGP4 error grows with
element age. It is not hypothetical: satvisor's ``celestrak/json/active.json`` answered HTTP
200 on 2026-08-20 with 14,875 records whose **median epoch was 147 days old**, its README
still claiming a 2-to-12-hour refresh, its repository ``pushed_at`` five minutes fresh. So
freshness is read off the element epochs in the body and never off a mirror's own metadata:
not ``Last-Modified``, not ``pushed_at``, not a README table. See
:data:`MAX_ELEMENT_AGE_S` and :data:`DEGRADED_ELEMENT_AGE_S`.

**The cache is the feature, not an optimisation.** CelesTrak's usage policy says GP data
updates once every two hours and asks for one download per update. The two-hour floor is
enforced against the cache below, so a poller asking more often is served the copy we
already hold and no HTTP request leaves the process. One attempt per group per two hours
covers the whole chain, so no host in it can be asked more often than CelesTrak's own figure
allows, whatever its own published cap says.

**The floor and the cache both survive a restart, and they are the whole rate guard.** With a
:class:`~tracker.cache.DiskCache` passed in, the per-group attempt time and the element sets
themselves go to disk, so a process started inside the two-hour window serves the copy it
already holds and opens no socket. Without that, stopping and starting the app was a fresh
request per group every time, and a provider cannot tell that apart from hammering. Both are
persisted unconditionally, because neither can do anything worse than delay us.

**A non-200 holds one provider off, not the layer, and the length depends on whose policy is
being honoured.** CelesTrak's policy is the strict one, quoted verbatim from
``celestrak.org/usage-policy.php``:

    Most importantly, we send HTTP error responses when users are exceeding limits or using
    incorrect (long-outdated) URLs (e.g., HTTP 301, 403, 404, 50x). M2M (machine-to-machine)
    software should immediately stop querying when it receives any non-HTTP 200 responses
    and report the results to a human for investigation. Repeatedly ignoring them will end
    up sending your IP address to the firewall.

"Report to a human" is not the human-in-the-data-path that AGENTS.md bans. Nothing waits on
a person: the provider holds itself off, :attr:`CelestrakClient.unavailable_reason` says why
when nothing can serve, and that is the same route a missing key takes.

Three hold-off lengths, chosen by cause rather than by one number:

- **CelesTrak, 5xx**: :data:`SERVER_STOP_SECONDS`, one GP publication cycle. The provider's
  own server having a bad day says nothing about our client, so it costs one refresh.
- **CelesTrak, 3xx or 4xx**: :data:`POLICY_STOP_SECONDS`, a day. This is a statement about
  us, and their policy asks for a person to look.
- **A republisher, any non-200**: :data:`MIRROR_STOP_SECONDS`, or the provider's own
  ``Retry-After`` when it is throttling us. A one-person proxy 404ing a group is not a
  firewall risk and must not dark the layer for a day.

None can outlive its cause, every one is checked on read so a restarted process and a
long-running one agree, and the human reset route needs no code: stop the app, delete
``upstream.sqlite3`` under ``Settings.cache_dir``, start it again. The floor is what actually
protects the providers and it persists unconditionally, so even a hold-off that has just
expired cannot produce more than one request per group per two hours.

**No TLE anywhere in this module, and that is why the chain is only three hosts long.**
``satellite.js`` takes CelesTrak OMM JSON directly through ``json2satrec``, verified at npm
7.1.0 against ``tests/fixtures/celestrak_iss_omm.json``. A TLE encoder here would be dead on
arrival: CelesTrak exhausted the 5-digit catalogue on 2026-07-11, the format has no sixth
digit, and 326 of the 16,399 objects ReTLEctor served on 2026-08-20 already carry a 6-digit
number. Every other keyless orbital source found publishes TLE line pairs only, so admitting
one means a decoder plus the Alpha-5 encoding plus the 57-to-99 year pivot, and it still
cannot represent a modern catalogue number.

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
import statistics
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Final, NoReturn

import httpx
from pydantic import Field, TypeAdapter, ValidationError

from tracker.cache import DiskCache
from tracker.cache import key as cache_key
from tracker.contracts.base import ContractViolationError, WireModel, validate_payload
from tracker.contracts.satellite import STALE_EPOCH_AGE_S, Satellite
from tracker.sources.base import (
    RATE_LIMIT_STATUS_CODES,
    SourceError,
    describe_exception,
    retry_after_seconds,
)

_log = logging.getLogger(__name__)

SOURCE_NAME: Final = "celestrak"
"""The layer's adapter name, used in health output, poller names and log lines.

Still ``celestrak`` even though CelesTrak itself is refusing this network, because that is
what the data *is*: every host in :data:`PROVIDER_CHAIN` republishes CelesTrak GP element
sets. The host that actually answered is carried per record in :attr:`Satellite.source`, so
a card credits the server rather than this constant.
"""

GP_URL: Final = "https://celestrak.org/NORAD/elements/gp.php"
"""The general perturbations endpoint at the origin. Not configurable, and the reason is
their policy: it redirects anything that is not ``https://celestrak.org`` exactly, a 301 is a
non-200 that holds this provider off for a day, and the SupGP documentation page's own
examples are written with ``www.`` so copying them walks straight into it."""

GP_FORMAT: Final = "JSON"
"""Passed explicitly on every CelesTrak request, always.

``FORMAT`` is optional and **defaults to CSV as of 2026-05-09**, so omitting it returns
comma-separated text that the JSON parser rejects. The same trap runs the other way on
``satcat/records.php``, whose default is JSON, which is why the rule is "always pass it"
rather than "remember which default applies where". The republishers take no format
parameter: their path ends in ``/json`` or ``.json`` and there is nothing to get wrong.
"""

MIN_GROUP_INTERVAL_S: Final = 2.0 * 60.0 * 60.0
"""Hard floor: one attempt per group per two hours, covering the whole chain.

A constant, never a setting, and there is no constructor argument that can lower it. It is
CelesTrak's own figure ("For GP data, updates are once every 2 hours") and it is the
strictest in :data:`PROVIDER_CHAIN`, so applying it per attempt rather than per provider
means no host can be asked faster than the origin allows. ReTLEctor publishes 60 requests
per 60 seconds and refreshes its groups every 4 to 12 hours, so a two-hour attempt is
already twice as often as its data moves. Configuration can only slow this feed down, via
the poll interval, never speed it up.
"""


SERVER_STOP_SECONDS: Final = MIN_GROUP_INTERVAL_S
"""How long a CelesTrak 5xx holds that provider off: one GP publication cycle.

Taken from the floor rather than written as its own number, so "a server error costs us one
refresh" cannot drift away from what a refresh is.
"""

POLICY_STOP_SECONDS: Final = 24.0 * 60.0 * 60.0
"""How long a CelesTrak 3xx or 4xx holds that provider off: one day.

Longer than :data:`SERVER_STOP_SECONDS` because the two mean different things. A 301 or a 403
is CelesTrak telling us our client is wrong, and their policy says a human should look at it.
A day is twelve missed refreshes of a catalogue that moves slowly, against a firewall entry
that has no expiry and no appeal.
"""

MIRROR_STOP_SECONDS: Final = MIN_GROUP_INTERVAL_S
"""How long a republisher's non-200 holds it off: one publication cycle.

Not :data:`POLICY_STOP_SECONDS`, and the difference is the whole reason the chain exists. A
day-long hold-off is a proportionate answer to CelesTrak's stated firewall policy and a wildly
disproportionate one to a one-person proxy answering ``Group "not-a-group" not found.`` with a
404, which both republishers do (verified 2026-08-20). Darkening a fallback for a day over a
typo would leave the layer resting on a single host, which is the position this module exists
to get out of. A throttling response overrides this with the provider's own ``Retry-After``.
"""

DEGRADED_ELEMENT_AGE_S: Final = STALE_EPOCH_AGE_S
"""Median element age at which a batch is drawn but reported degraded: 3.5 days.

CelesTrak's own number, reused from :data:`~tracker.contracts.satellite.STALE_EPOCH_AGE_S`
rather than invented here, so "stale" is one fact in this codebase. Its ``OLDEST`` table flag
marks objects whose GP data is more than 3.5 days old, and on the active list that is normally
fewer than 50 objects out of 10,000-plus. Measured against real batches on 2026-08-20 there is
plenty of headroom: ReTLEctor's whole active set had a median epoch age of 15.6 hours and a p90
of 32.1 hours.

A degraded batch is still drawn, because a three-day-old element set is a useful pin and an
empty layer is not. What it must not do is stop the chain: :meth:`CelestrakClient.elements`
keeps asking the next provider and keeps the freshest answer, which is the only place in this
module where "prefer the fresher provider" is a real choice rather than a slogan.
"""

MAX_ELEMENT_AGE_S: Final = 14.0 * 24.0 * 60.0 * 60.0
"""Element age past which a record is dropped and counted rather than drawn: 14 days.

The number is set by what a drawn position is worth. SGP4 error grows roughly a kilometre a
day for a low-orbit object, so a week-old element set is a useful pin and a fortnight-old one
is at the edge of it. Past that the honest output is a layer reporting itself degraded, not a
satellite drawn confidently tens of kilometres from where it is.

It is also the guard that catches the failure a mirror makes possible. Measured live on
2026-08-20, satvisor's ``celestrak/json/active.json`` served HTTP 200 with 14,875 records at a
median epoch age of 147 days and a *newest* record 143 days old, so every single one of them
fails this test, the batch raises :class:`StaleElementsError`, and the chain moves on with a
reason a person can read. Nothing else in the response says anything is wrong.
"""

CACHE_NAMESPACE: Final = SOURCE_NAME
"""Prefix for every key this adapter writes, so the whole source can be cleared at once."""


# ------------------------------------------------------------------ the chain of providers
#
# Held as data for the same reason sources/adsb.py holds its providers that way: adding one
# is a row and a URL template rather than a code change, and a provider that is blocked shows
# up as a row saying so instead of as an absence. Each floor is a constant here and never in
# configuration, per ADR 003.


@dataclass(frozen=True, slots=True)
class ElementProvider:
    """One host that will serve CelesTrak GP element sets as OMM JSON.

    Every row serves the identical contract, which is what makes the chain a chain rather
    than three adapters. ``url_template`` takes exactly one field, ``{group}``, and carries
    the whole per-provider shape including any query string, so nothing downstream has to
    know that CelesTrak wants ``?GROUP=&FORMAT=`` while the republishers put the group in the
    path.

    ``stop_on_non_200`` is true only for CelesTrak, whose usage policy asks for it in writing.
    A republisher gets a bounded hold-off instead: see :data:`MIRROR_STOP_SECONDS`.

    ``origin`` is who determined the orbit, not who served it. Every row here reads
    ``celestrak``, and that is the point: under ADR 011 they corroborate nothing, so anything
    counting independent sources counts this field and not :attr:`name`.
    """

    name: str
    url_template: str
    origin: str
    attribution: str
    attribution_url: str
    min_interval_seconds: float
    stop_on_non_200: bool

    def url(self, group: str) -> str:
        """The full URL for one group on this provider."""
        return self.url_template.format(group=group)


RETLECTOR: Final = ElementProvider(
    name="retlector",
    url_template="https://retlector.eu/{group}/json",
    origin=SOURCE_NAME,
    attribution="Orbital elements from CelesTrak, served through the ReTLEctor cache",
    attribution_url="https://retlector.eu",
    min_interval_seconds=MIN_GROUP_INTERVAL_S,
    stop_on_non_200=False,
)
"""Primary. A caching proxy in front of CelesTrak, and the only keyless host that hands us
the exact contract this module already parses.

Verified 2026-08-20: ``/stations/json`` HTTP 200 in 9,313 bytes with the ISS at epoch
2026-08-20T04:17:29.138208, field-for-field identical in shape to
``tests/fixtures/celestrak_iss_omm.json`` and fresher. ``/active/json`` HTTP 200 in 6,944,641
bytes, 16,399 objects, all 216 cells of a 10-by-30-degree grid occupied and zero SGP4 failures.
326 of those objects carry a 6-digit catalogue number, which no TLE source can represent at
all. Its stated cap is 60 requests per 60 seconds and it confirms it on the wire with
``x-ratelimit-limit``, ``x-ratelimit-remaining`` and ``x-ratelimit-reset``. ``robots.txt``
answers 404, so there is no directive to honour. Code is MIT (``MrTalon63/ReTLEctor``); the
data is CelesTrak's, whose own position is "not stated", so this changes nothing about our
licence exposure.

Its risk is exactly its value: one person, one host, no SLA, existing because CelesTrak bans
people. Which is why it is first and not alone.
"""

SATVISOR: Final = ElementProvider(
    name="satvisor",
    url_template=(
        "https://raw.githubusercontent.com/satvisorcom/satvisor-data/master"
        "/celestrak/json/{group}.json"
    ),
    origin=SOURCE_NAME,
    attribution="Orbital elements from CelesTrak, served through the satvisor-data mirror",
    attribution_url="https://github.com/satvisorcom/satvisor-data",
    min_interval_seconds=MIN_GROUP_INTERVAL_S,
    stop_on_non_200=False,
)
"""Fallback, and deliberately a guarded one rather than a trusted one.

Chosen because it is a **second host on a second network** serving the same OMM JSON: GitHub's
CDN rather than one person's Caddy box, with ``etag`` and ``last-modified`` so a conditional
request is free. Verified 2026-08-20: ``celestrak/json/stations.json`` HTTP 200 in 9,289 bytes
carrying the identical ISS element set ReTLEctor served, to the digit.

**And its two biggest files are frozen, which is why it sits behind the freshness guard rather
than in front of it.** Measured the same day, ``celestrak/json/active.json`` answered 200 with
14,875 records at a median epoch age of 147.4 days, newest 143.2 days, while its README claimed
a 2-to-12-hour refresh and the repository had been pushed to five minutes earlier. The small
groups do refresh. So this row is useful for the groups it keeps current and refused outright
for the ones it does not, decided per batch from the epochs in the body. Repository declares no
licence at all, which is worse than a restrictive one; its README asks us to respect CelesTrak's
terms of use.
"""

CELESTRAK: Final = ElementProvider(
    name=SOURCE_NAME,
    url_template=f"{GP_URL}?GROUP={{group}}&FORMAT={GP_FORMAT}",
    origin=SOURCE_NAME,
    attribution="Orbital elements from CelesTrak",
    attribution_url="https://celestrak.org",
    min_interval_seconds=MIN_GROUP_INTERVAL_S,
    stop_on_non_200=True,
)
"""The origin, ordered last, and still in the chain on purpose.

It is the right primary the moment the block lifts, and it is the only row whose data is not
someone else's cache. It is last because it refuses this network today, so on a healthy cycle
ReTLEctor answers first and nothing is spent on a 30-second connect timeout here. When every
republisher has failed we do ask it, which is the only case where paying that timeout buys
anything.

Not gated out of the table. A gated row would be a permanent claim about a network, and this
one is measured about *our* network on one day: run the same code from an unblocked address
and this row starts working with no change. The block shows up honestly instead, as
"unreachable" on :meth:`CelestrakClient.provider_status`.
"""

PROVIDER_CHAIN: Final = (RETLECTOR, SATVISOR, CELESTRAK)
"""Ask in this order, stop at the first fresh answer, keep the freshest of any degraded ones.

The ordering is freshness first, then independence of host, then origin:

1. **ReTLEctor**, because it is the only keyless host serving this exact contract with the
   modern catalogue in it, and its measured freshness is the best of the three.
2. **satvisor**, because it is a different host on a different network serving the same bytes,
   which is the entire property a fallback needs, and because its known-frozen files are
   caught by the freshness guard rather than trusted.
3. **CelesTrak**, the origin, unreachable from here today.

Every row is CelesTrak-origin, so this chain buys availability and not corroboration. See the
module docstring.
"""


class CelestrakStoppedError(SourceError):
    """No provider in the chain may be queried right now, and each says why.

    Distinct from a plain :class:`~tracker.sources.base.SourceError` so a caller can tell a
    held-off chain from an outage. Raised only when *every* row is holding off: one provider
    refusing is a failover, not a failure.
    """

    def __init__(self, source: str, detail: str, status_code: int | None = None) -> None:
        self.status_code = status_code
        super().__init__(source, detail)


class StaleElementsError(SourceError):
    """A 200 whose element sets were all too old to draw.

    Its own type because it is the failure a mirror makes possible and it must not be
    confused with a shape change. The payload parsed, the records mapped, the contract held,
    and every epoch was past :data:`MAX_ELEMENT_AGE_S`. Carries the numbers so the reason a
    person reads names the age rather than saying "stale".
    """

    def __init__(self, source: str, detail: str, *, newest_epoch: datetime, dropped: int) -> None:
        self.newest_epoch = newest_epoch
        self.dropped = dropped
        super().__init__(source, detail)


def _stale_epoch(error: StaleElementsError) -> datetime:
    """Sort key for picking the least-frozen of several frozen providers.

    A named function rather than a lambda because ``max`` narrows a lambda's parameter to the
    declared element type of its overload, and ``ty`` then reads the attribute off
    :class:`~tracker.sources.base.SourceError` and fails the build.
    """
    return error.newest_epoch


class OmmRecordWire(WireModel):
    """One GP element set exactly as CelesTrak sends it in OMM JSON.

    Field names are the OMM keywords, carried as aliases so the provider's shape stays in
    this file. CelesTrak sends the numerics as JSON **numbers**; Space-Track sends the same
    fields as strings, and :class:`~tracker.contracts.base.WireModel` is non-strict so both
    parse. That leniency is load-bearing rather than tidy: **the same response mixes ``int``
    and ``float`` on fields the propagator needs.** Measured across ReTLEctor's 16,399 active
    objects on 2026-08-20, ``MEAN_MOTION_DDOT`` arrived as an int on 16,302 and a float on 97,
    ``BSTAR`` as an int on 802, ``INCLINATION`` on 85, ``MEAN_MOTION_DOT`` on 14,
    ``MEAN_ANOMALY`` on 3 and ``ARG_OF_PERICENTER`` on 1. A ``strict=True`` float field here
    would drop those records for no reason at all.

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
    """Attach UTC to the naive ``EPOCH`` every provider in the chain sends.

    It arrives as ``2026-08-20T04:17:29.138208``: six decimal places, no ``Z``, no offset, on
    all 16,399 records ReTLEctor served and on every CelesTrak record before it. It is UTC by
    specification, and CelesTrak omits the OMM ``TIME_SYSTEM`` keyword precisely because it is
    always ``UTC``. Attaching it here is the only place that happens, so nothing downstream
    ever sees a naive timestamp. Already-aware values are converted rather than stamped, so a
    provider that starts sending an offset does not get silently relabelled as UTC.

    The serialised form matters as much as the value: the contract writes ``Z``, because
    ``json2satrec`` appends a ``Z`` when the string lacks one, so a ``+00:00`` suffix becomes
    ``+00:00Z``, ``new Date()`` rejects it, and every satellite lands at ``NaN`` with nothing
    thrown anywhere. ``tests/contracts/test_satellite.py`` asserts the suffix.
    """
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _to_domain(wire: OmmRecordWire, *, group: str, fetched_at: datetime, source: str) -> Satellite:
    """Map one wire record to the domain contract.

    Raises whatever the contract raises. The caller counts the drop; nothing is partially
    accepted. Angles and mean motion cross unchanged: every provider here publishes degrees
    and revolutions per day, which is what the contract holds, and radians appear only inside
    SGP4 in the browser.

    ``source`` is the provider that actually served the record, not :data:`SOURCE_NAME`, so a
    card credits the host that answered rather than the origin we could not reach.
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
        source=source,
    )


@dataclass(frozen=True, slots=True)
class ElementBatch:
    """One provider's answer for one group, with the numbers that say whether to trust it.

    Never constructed empty. :func:`parse_elements` raises instead, because an empty batch
    behind a healthy-looking poll is the outcome every guard in this module exists to refuse,
    so the invariant is worth more here than a defensive branch.

    The three counts are the "dropped and counted" channel for this feed, and they are
    separated because they mean different things. ``dropped_unmappable`` is a record the
    contract refused: a missing keyword, an eccentricity SGP4 cannot propagate. ``dropped_stale``
    is a record the contract accepted and the clock refused. Reading them as one number would
    hide a frozen mirror behind what looks like ordinary parser noise.
    """

    provider: str
    group: str
    fetched_at: datetime
    satellites: tuple[Satellite, ...]
    dropped_unmappable: int
    dropped_stale: int

    @property
    def newest_epoch(self) -> datetime:
        """The freshest orbit determination in the batch. What provider ordering compares."""
        return max(satellite.epoch for satellite in self.satellites)

    @property
    def median_age_s(self) -> float:
        """Median seconds between the batch's epochs and the fetch.

        The median rather than the newest, because one current element set in a frozen file
        would otherwise clear the whole batch. satvisor's frozen ``active.json`` is the case
        that makes this the right statistic.
        """
        return statistics.median(
            satellite.epoch_age_s(self.fetched_at) for satellite in self.satellites
        )

    @property
    def degraded(self) -> bool:
        """Whether this batch should be drawn but reported as degraded."""
        return self.median_age_s > DEGRADED_ELEMENT_AGE_S

    @property
    def summary(self) -> str:
        """One line a person can read, for ``/api/layers`` and the log."""
        hours = self.median_age_s / 3600.0
        text = (
            f"{self.provider} served {len(self.satellites)} element sets for GROUP="
            f"{self.group}, median epoch age {hours:.1f}h, newest "
            f"{self.newest_epoch.isoformat()}"
        )
        if self.dropped_unmappable:
            text += f", {self.dropped_unmappable} dropped as unmappable"
        if self.dropped_stale:
            text += f", {self.dropped_stale} dropped as older than {MAX_ELEMENT_AGE_S / 86400:.0f}d"
        if self.degraded:
            text += (
                f" (degraded: the median is past {DEGRADED_ELEMENT_AGE_S / 3600:.0f}h, so these "
                "positions are drawn but are not current)"
            )
        return text


def _require_omm_array(payload: bytes | str, *, source: str) -> list[Any]:
    """Reject a 200 that is not a non-empty OMM array.

    Three real failure shapes hide behind a 200 here. A CSV body, if ``FORMAT`` were ever
    dropped from the CelesTrak query. An HTML error or maintenance page, which is what a CDN
    in front of any of these hosts serves when it is unhappy. And an empty body, which is how
    AISHub signals a bad credential and is the precedent AGENTS.md already records.

    An empty array is treated as a failure too. We only ever ask for a named group that we
    know holds objects, so zero records means something broke upstream rather than that the
    sky emptied, and letting it through would blank the layer with a healthy-looking poll.
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
) -> ElementBatch:
    """Parse an OMM JSON array into one batch of domain element sets.

    Three ways this refuses a body, and they are separate on purpose:

    - :class:`~tracker.contracts.base.ContractViolationError` when the payload is not a usable
      OMM array, or when **every** record fails to map. Either means the provider changed
      shape or served an error page behind a 200.
    - :class:`StaleElementsError` when records mapped fine and every one of them was older
      than :data:`MAX_ELEMENT_AGE_S`. That is a frozen mirror, not a shape change, and the
      reason a person reads has to say so.
    - Nothing at all for individual failures. One corrupt or ancient element set is dropped
      and counted so it cannot empty the layer.

    Args:
        payload: The raw response body.
        group: The group this batch was fetched from, carried as provenance.
        fetched_at: When the fetch happened. Both the record's ``fetched_at`` and the instant
            every age in this batch is measured against, so a test asserts a boundary rather
            than approximating one.
        source: The provider that served this body, carried onto every record.
    """
    records = _require_omm_array(payload, source=source)

    satellites: list[Satellite] = []
    unmappable = 0
    stale = 0
    newest_stale: datetime | None = None
    for record in records:
        try:
            wire = validate_payload(_RECORD_ADAPTER, record, source=source)
            satellite = _to_domain(wire, group=group, fetched_at=fetched_at, source=source)
        except (ContractViolationError, ValueError, TypeError) as exc:
            unmappable += 1
            _log.debug("dropping unmappable element set: %s", exc)
            continue
        if satellite.epoch_age_s(fetched_at) > MAX_ELEMENT_AGE_S:
            stale += 1
            if newest_stale is None or satellite.epoch > newest_stale:
                newest_stale = satellite.epoch
            continue
        satellites.append(satellite)

    if satellites:
        batch = ElementBatch(
            provider=source,
            group=group,
            fetched_at=fetched_at,
            satellites=tuple(satellites),
            dropped_unmappable=unmappable,
            dropped_stale=stale,
        )
        if unmappable or stale:
            _log.info("%s", batch.summary)
        return batch

    if newest_stale is not None:
        # Every record parsed and every one was ancient. This is the frozen-mirror case, and
        # it has to be told apart from a shape change or the next person debugs the parser.
        age_days = (fetched_at - newest_stale).total_seconds() / 86400.0
        raise StaleElementsError(
            source,
            f"every one of {stale} element sets for GROUP={group} is older than "
            f"{MAX_ELEMENT_AGE_S / 86400:.0f} days; the newest is "
            f"{newest_stale.isoformat()}, {age_days:.1f} days old. This provider is serving a "
            "frozen copy, so nothing here is drawn.",
            newest_epoch=newest_stale,
            dropped=stale,
        )

    # Every record failed the contract, which is a provider shape change (one OMM keyword
    # renamed or dropped), not an empty sky. Returning an empty batch would blank the layer
    # behind a healthy-looking poll, the exact outcome _require_omm_array refuses one level up.
    raise ContractViolationError(
        source,
        f"all {unmappable} element sets in the GROUP={group} array failed to map; "
        "treating as an upstream shape change, not as data",
    )


class _StoredGroup(WireModel):
    """The on-disk shape of one cached group.

    ``fetched_at`` rides inside the value rather than being taken from the cache row's own
    write time, so the group's age is one fact and an injected clock in a test does not have
    to agree with the cache's clock to make the floor assertable. ``provider`` rides with it
    because a restarted process has to be able to say which host the elements it is serving
    came from, and the counts ride with it so the freshness report survives a restart too.
    """

    fetched_at: datetime
    provider: str
    satellites: tuple[Satellite, ...]
    dropped_unmappable: int
    dropped_stale: int


class _StoredStop(WireModel):
    """The on-disk shape of one provider's hold-off: why, and when it lifts."""

    reason: str
    until: datetime


_GROUP_ADAPTER: Final = TypeAdapter(_StoredGroup)
_STOP_ADAPTER: Final = TypeAdapter(_StoredStop)


@dataclass(frozen=True, slots=True)
class _Stop:
    """A hold-off held in memory: the reason a person reads, and its expiry."""

    reason: str
    until: datetime


@dataclass(frozen=True, slots=True)
class ProviderStatus:
    """One row of the chain as it stands right now, for ``/api/layers``.

    ``reason`` is ``None`` when the provider may be asked. When it is set, the provider is
    either holding off after a refusal or was unreachable on the last attempt, and the string
    says which. A layer that names its providers has to be able to say why one of them is
    contributing nothing, or the count is a guess.
    """

    name: str
    url_template: str
    origin: str
    attribution: str
    attribution_url: str
    held_off_until: datetime | None
    reason: str | None


class CelestrakClient:
    """Fetches GP element sets from the provider chain, at most once per group per two hours.

    Holds the cache that the floor is enforced against, so this object must live for the
    process rather than being constructed per request. One process owns it, which is also
    what CelesTrak asks of anyone behind a shared egress address.

    Takes no cadence argument of any kind, deliberately: see :data:`MIN_GROUP_INTERVAL_S`.
    The name is unchanged from when this talked to one host, because ``app.py``, the poller
    name on ``/api/health`` and the layer rail in the browser all key on it, and renaming a
    class to describe its plumbing would break three of them to describe nothing a user sees.
    """

    def __init__(
        self,
        client: httpx.AsyncClient,
        *,
        clock: Callable[[], datetime] = _now,
        cache: DiskCache | None = None,
        providers: tuple[ElementProvider, ...] = PROVIDER_CHAIN,
    ) -> None:
        self._client = client
        self._clock = clock
        self._providers = providers
        self._cache: dict[str, ElementBatch] = {}
        self._attempted_at: dict[str, datetime] = {}
        self._stops: dict[str, _Stop] = {}
        self._provider_errors: dict[str, str] = {}
        self._last_error: str | None = None
        self._disk = cache
        # Read once here rather than on demand, because /api/capabilities can ask why the
        # layer is unavailable before the first poll has run and the answer has to be the
        # real one. The element sets and the per-group floor load lazily instead: the group
        # names are not known until a caller asks for one.
        self._load_stops()

    @property
    def name(self) -> str:
        """Short identifier for this feed, used in health output and logs."""
        return SOURCE_NAME

    @property
    def min_interval_seconds(self) -> float:
        """The two-hour floor. Read-only, with no setter, on purpose."""
        return MIN_GROUP_INTERVAL_S

    @property
    def providers(self) -> tuple[ElementProvider, ...]:
        """The chain this client will ask, in order."""
        return self._providers

    @property
    def unavailable_reason(self) -> str | None:
        """Why the satellite layer cannot serve, or ``None`` when it can.

        Shaped for ``LayerCapability(available=False, reason=...)``. A feed that has never
        succeeded is unavailable, not healthy-and-empty, which is the distinction that stops
        an empty globe reading as a working one.
        """
        # Cached *element sets*, not cache keys: a dict holding one empty group is truthy,
        # and reporting that as available publishes a working layer with nothing to draw.
        if any(entry.satellites for entry in self._cache.values()):
            return None
        stopped = self.stopped_reason
        if stopped is not None:
            return stopped
        if self._last_error is not None:
            return f"no provider has served an element set: {self._last_error}"
        return "the orbital element providers have not been queried yet"

    @property
    def degraded_reason(self) -> str | None:
        """Why the drawn satellites are not current, or ``None`` when they are.

        Separate from :attr:`unavailable_reason` because the two ask different questions. A
        layer with nothing to draw is unavailable. A layer drawing three-day-old element sets
        is available and dishonest if it says nothing, because SGP4 error grows with element
        age and the pin looks exactly as confident either way. This is the string that belongs
        next to the provider list on ``/api/layers``.
        """
        degraded = [entry.summary for entry in self._cache.values() if entry.degraded]
        if not degraded:
            return None
        return "; ".join(sorted(degraded))

    @property
    def stopped_reason(self) -> str | None:
        """Why no provider may be queried, or ``None`` when at least one may.

        One provider holding off is a failover and reports nothing here. Every provider
        holding off is a stopped feed, and each row's own reason is carried into the string so
        a person can see whether they are looking at one cause or three.

        Every expiry is checked on read rather than by anything scheduled, so a hold-off
        written by a previous process and one written by this one behave identically. That
        matters: a latch that were permanent in memory and expiring on disk would mean a
        long-running process and a restarted one disagreed about the same failure.
        """
        reasons = [
            f"{provider.name}: {held}"
            for provider in self._providers
            if (held := self._held_off_reason(provider)) is not None
        ]
        if len(reasons) < len(self._providers):
            return None
        return "; ".join(reasons)

    def provider_status(self) -> tuple[ProviderStatus, ...]:
        """Every row of the chain and what stands in its way, in chain order.

        The honest answer to "which providers is this layer resting on", which is not the same
        question as "which providers are configured". Built for ``/api/layers``.
        """
        statuses: list[ProviderStatus] = []
        for provider in self._providers:
            held = self._held_off_reason(provider)
            stop = self._stops.get(provider.name)
            statuses.append(
                ProviderStatus(
                    name=provider.name,
                    url_template=provider.url_template,
                    origin=provider.origin,
                    attribution=provider.attribution,
                    attribution_url=provider.attribution_url,
                    held_off_until=stop.until if held is not None and stop is not None else None,
                    reason=held or self._provider_errors.get(provider.name),
                )
            )
        return tuple(statuses)

    def freshness(self) -> tuple[ElementBatch, ...]:
        """Every cached group's batch, so the age of what we are drawing is readable.

        The batch carries the newest epoch, the median age and both drop counts, which is the
        only honest health signal a cache of somebody else's cache can give. Read it rather
        than assuming: a mirror's own metadata said "fresh" while it served 147-day-old
        elements.
        """
        return tuple(self._cache[group] for group in sorted(self._cache))

    def cached_at(self, group: str) -> datetime | None:
        """When this group was last fetched successfully, or ``None`` if never."""
        entry = self._cached_group(group)
        return entry.fetched_at if entry is not None else None

    def cached_provider(self, group: str) -> str | None:
        """Which provider served this group's cached elements, or ``None`` if none has."""
        entry = self._cached_group(group)
        return entry.provider if entry is not None else None

    def cached_elements(self) -> tuple[Satellite, ...]:
        """Every cached element set, one record per catalogue number.

        What ``/api/satellites/elements`` serves. Deduplicated because groups overlap
        (``stations`` is a subset of ``active``) and the same object arriving from two groups
        would otherwise be propagated and drawn twice. **The freshest epoch wins**, and two
        element sets are never blended into a third that no orbit determination produced.

        This is where recency actually arbitrates in this module, and it is the right place
        for it. ``services/union.py`` resolves competing *position reports* by recency; an
        element set is not a position report, so comparing two mirrors of one origin buys
        nothing (they serve the same file) and comparing two element sets for one object does,
        because a later orbit determination genuinely supersedes an earlier one.
        """
        best: dict[int, Satellite] = {}
        for entry in self._cache.values():
            for satellite in entry.satellites:
                existing = best.get(satellite.norad_cat_id)
                if existing is None or satellite.epoch > existing.epoch:
                    best[satellite.norad_cat_id] = satellite
        return tuple(best.values())

    async def elements(self, group: str) -> tuple[Satellite, ...]:
        """Element sets for one group, from cache when the floor holds.

        The only call a poller needs. Inside the two-hour window this makes no HTTP request
        at all and returns the cached copy. Outside it, the chain is asked in order and stops
        at the first provider whose batch is fresh. A batch that parses but is degraded does
        not stop the chain: the next provider is asked and the freshest answer is kept, which
        is the one place "prefer the fresher provider" is a real decision here.

        Raises:
            CelestrakStoppedError: Every provider is holding off after a refusal.
            StaleElementsError: The only provider that answered served a frozen copy.
            SourceError: The floor holds but there is nothing cached to serve, or no provider
                in the chain answered.
            ContractViolationError: A 200 that is not a usable OMM array.
        """
        # The hold-off is checked before the floor, and the order is about which reason a
        # person gets. Both refuse to make a request, but the hold-off is the *cause*: the
        # floor only holds because an attempt was already spent on the provider that refused
        # us. Reporting the floor first would answer "why is this layer empty" with "because
        # we asked recently" and bury the refusal that made asking pointless.
        askable = [
            provider for provider in self._providers if self._held_off_reason(provider) is None
        ]
        if not askable:
            # Every row is holding off. stopped_reason cannot be None here, and asserting that
            # with a fallback string would be an untestable branch, so the ``or ""`` stands.
            raise CelestrakStoppedError(SOURCE_NAME, self.stopped_reason or "")

        now = self._clock()
        last_attempt = self._last_attempt(group)
        if last_attempt is not None and (now - last_attempt).total_seconds() < MIN_GROUP_INTERVAL_S:
            cached = self._cached_group(group)
            if cached is not None:
                return cached.satellites
            because = self._last_error or "no successful fetch yet"
            detail = (
                f"two-hour floor holds for GROUP={group} after an attempt at "
                f"{last_attempt.isoformat()}; nothing cached to serve ({because})"
            )
            raise SourceError(SOURCE_NAME, detail)

        # Recorded before the requests, not after them: the floor counts attempts we made, not
        # attempts that worked. A failed fetch has still cost the providers a request, and that
        # is exactly why it goes to disk before the socket opens rather than after.
        self._record_attempt(group, now)
        best, errors = await self._walk(askable, group)
        if best is None:
            failure = self._nothing_answered(group, errors)
            self._last_error = failure.detail
            raise failure

        self._remember(group, best)
        self._last_error = None
        _log.info("%s", best.summary)
        return best.satellites

    async def _walk(
        self, askable: list[ElementProvider], group: str
    ) -> tuple[ElementBatch | None, list[SourceError | ContractViolationError]]:
        """Ask each provider in turn, keeping the freshest batch and every failure.

        Stops at the first batch that is not degraded. A degraded batch is kept and the walk
        continues, so a stale primary costs one extra request and buys a fresher answer where
        one exists. On a healthy cycle the first provider answers fresh and nothing else in
        the chain is touched.
        """
        best: ElementBatch | None = None
        errors: list[SourceError | ContractViolationError] = []
        for provider in askable:
            try:
                batch = await self._fetch(provider, group)
            except (SourceError, ContractViolationError) as exc:
                # Both types carry .detail, the readable half without the source name
                # repeated. Recorded per provider so the reason survives into
                # provider_status() rather than living only in an exception nobody caught.
                self._provider_errors[provider.name] = exc.detail
                errors.append(exc)
                continue
            if best is None or batch.newest_epoch > best.newest_epoch:
                best = batch
            if not batch.degraded:
                break
            _log.warning(
                "%s: %s; asking the next provider for a fresher copy", SOURCE_NAME, batch.summary
            )
        return best, errors

    def _nothing_answered(
        self, group: str, errors: list[SourceError | ContractViolationError]
    ) -> SourceError | ContractViolationError:
        """Pick the one error for a walk where every provider failed.

        **A single failure is re-raised as itself, never wrapped.** The type is information: a
        :class:`~tracker.contracts.base.ContractViolationError` means a provider changed shape,
        a :class:`StaleElementsError` means it is serving a frozen copy, and flattening either
        into "no provider answered" sends the next person to the wrong place. Wrapping only
        earns its keep when several providers failed for several reasons, and then the reasons
        all have to be in the string.

        When every failure was a frozen copy, the freshest of them is raised, so the reason
        names the best case rather than the worst.
        """
        if len(errors) == 1:
            return errors[0]
        stale: list[StaleElementsError] = [
            exc for exc in errors if isinstance(exc, StaleElementsError)
        ]
        if len(stale) == len(errors):
            return max(stale, key=_stale_epoch)
        detail = f"no provider served GROUP={group}: " + "; ".join(
            f"{exc.source}: {exc.detail}" for exc in errors
        )
        return SourceError(SOURCE_NAME, detail)

    def _last_attempt(self, group: str) -> datetime | None:
        """When this group was last asked for, from disk when there is a cache.

        **A stored floor that will not parse counts as "asked just now", not as "never
        asked".** :meth:`~tracker.cache.DiskCache.get_time` reports an unreadable value as
        absent, which is the right default for a cache and the wrong one here: absent means
        never asked, and never asked spends a request against a chain whose origin firewalls
        abusive clients permanently and without appeal.

        The row is rewritten as it is read, which is what stops the lean becoming a blackout.
        Left corrupt it would read as "asked now" on every call for ever and nothing would
        ever be queried again. Healed, the floor runs two hours from now and the next refresh
        after that is ordinary. The whole cost of a corrupt row is one missed refresh.
        """
        if self._disk is None:
            return self._attempted_at.get(group)
        key = cache_key(CACHE_NAMESPACE, "attempted", group)
        when = self._disk.get_time(key)
        if when is None and self._disk.get(key) is not None:
            now = self._clock()
            self._record_attempt(group, now)
            _log.warning(
                "%s: the stored floor for GROUP=%s is unreadable; holding off for %.0fs from "
                "now rather than treating it as never asked",
                SOURCE_NAME,
                group,
                MIN_GROUP_INTERVAL_S,
            )
            return now
        return when

    def _record_attempt(self, group: str, when: datetime) -> None:
        """Spend this group's slot, in memory and on disk."""
        self._attempted_at[group] = when
        if self._disk is not None:
            self._disk.set_time(cache_key(CACHE_NAMESPACE, "attempted", group), when)

    def restore(self, groups: Iterable[str]) -> tuple[Satellite, ...]:
        """Load these groups from the disk cache and return the deduplicated element sets.

        **Synchronous, and it opens no socket.** That is the whole point of it. A fresh
        process starts with an empty in-memory cache, so :meth:`cached_elements` returns
        nothing until something has populated it, and the only thing that populates it is a
        fetch. Meanwhile the poller persists its next-allowed-poll time, so a restart inside
        the six-hour window declines to poll at all. Between the two, the satellite layer was
        empty on every restart while the disk held every element set: measured 2026-08-23, a
        restart four minutes after a successful fetch served 0 satellites from a cache
        holding 698.

        Calling :meth:`elements` instead would fix the restart and break the cold start,
        because it fetches on a miss, which would put fourteen HTTP requests inside
        application startup and inside every test that builds an app. This reads disk and
        stops.
        """
        for group in groups:
            self._cached_group(group)
        return self.cached_elements()

    def _cached_group(self, group: str) -> ElementBatch | None:
        """One group's batch, reading disk through into memory on a first miss.

        Element sets are not given a time to live here. The floor above decides when to ask
        again, and a copy older than that is still the newest orbit determination the chain
        published, which is far better than an empty layer. What makes an old element set
        unusable is its epoch, and that is enforced at parse time by :data:`MAX_ELEMENT_AGE_S`
        and reported by :attr:`ElementBatch.degraded`.
        """
        entry = self._cache.get(group)
        if entry is not None or self._disk is None:
            return entry
        stored = self._disk.get(cache_key(CACHE_NAMESPACE, "elements", group))
        if stored is None:
            return None
        try:
            loaded = _GROUP_ADAPTER.validate_json(stored.value)
        except ValidationError as exc:
            # A cached shape we cannot read is our own bug or a hand-edited file, never the
            # provider's. Drop it rather than keep failing on it, and take the request.
            _log.warning(
                "%s: cached %s elements are unreadable (%s); dropping",
                SOURCE_NAME,
                group,
                exc,
            )
            self._disk.delete(cache_key(CACHE_NAMESPACE, "elements", group))
            return None
        entry = ElementBatch(
            provider=loaded.provider,
            group=group,
            fetched_at=loaded.fetched_at,
            satellites=loaded.satellites,
            dropped_unmappable=loaded.dropped_unmappable,
            dropped_stale=loaded.dropped_stale,
        )
        self._cache[group] = entry
        return entry

    def _remember(self, group: str, entry: ElementBatch) -> None:
        """Hold one group's batch, in memory and on disk."""
        self._cache[group] = entry
        if self._disk is None:
            return
        stored = _StoredGroup(
            fetched_at=entry.fetched_at,
            provider=entry.provider,
            satellites=entry.satellites,
            dropped_unmappable=entry.dropped_unmappable,
            dropped_stale=entry.dropped_stale,
        )
        self._disk.set(
            cache_key(CACHE_NAMESPACE, "elements", group),
            _GROUP_ADAPTER.dump_json(stored).decode(),
        )

    def _stop_key(self, provider: ElementProvider) -> str:
        """Where one provider's hold-off lives on disk. Per provider, so one cannot dark another."""
        return cache_key(CACHE_NAMESPACE, "stopped", provider.name)

    def _load_stops(self) -> None:
        """Read hold-offs left by a previous process, ignoring any that have expired."""
        if self._disk is None:
            return
        for provider in self._providers:
            stored = self._disk.get(self._stop_key(provider))
            if stored is None:
                continue
            try:
                loaded = _STOP_ADAPTER.validate_json(stored.value)
            except ValidationError:
                self._disk.delete(self._stop_key(provider))
                continue
            if self._clock() >= loaded.until:
                self._disk.delete(self._stop_key(provider))
                continue
            self._stops[provider.name] = _Stop(reason=loaded.reason, until=loaded.until)
            _log.warning(
                "%s: %s is still held off until %s: %s",
                SOURCE_NAME,
                provider.name,
                loaded.until,
                loaded.reason,
            )

    def _held_off_reason(self, provider: ElementProvider) -> str | None:
        """Why this provider may not be asked, or ``None``. Clears itself once it expires."""
        stop = self._stops.get(provider.name)
        if stop is None:
            return None
        if self._clock() < stop.until:
            return stop.reason
        del self._stops[provider.name]
        if self._disk is not None:
            self._disk.delete(self._stop_key(provider))
        _log.info(
            "%s: the hold-off on %s has expired; it may be queried again",
            SOURCE_NAME,
            provider.name,
        )
        return None

    def _hold_off(self, provider: ElementProvider, reason: str, seconds: float) -> None:
        """Stop asking one provider for a while, in memory and on disk."""
        until = self._clock() + timedelta(seconds=seconds)
        self._stops[provider.name] = _Stop(reason=reason, until=until)
        if self._disk is not None:
            stored = _StoredStop(reason=reason, until=until)
            self._disk.set(self._stop_key(provider), _STOP_ADAPTER.dump_json(stored).decode())
        _log.error("%s (holding off until %s)", reason, until.isoformat())

    def _refuse(self, provider: ElementProvider, group: str, response: httpx.Response) -> NoReturn:
        """Turn a non-200 into a hold-off whose length is chosen by whose policy applies.

        The order of the branches is load-bearing. CelesTrak's policy says stop on *any*
        non-200, and a 429 is a non-200, so the policy branch is tested before the throttling
        branch. Reading the header first would honour a 60-second ``Retry-After`` against a
        provider that has asked us in writing to stop until a person has looked.
        """
        status = response.status_code
        if provider.stop_on_non_200:
            seconds = (
                SERVER_STOP_SECONDS
                if status >= httpx.codes.INTERNAL_SERVER_ERROR
                else POLICY_STOP_SECONDS
            )
            reason = (
                f"CelesTrak answered HTTP {status} for GROUP={group}. Their usage policy "
                "requires us to stop querying on any non-200, so this provider will not be "
                "asked again until the hold-off expires."
            )
        elif status in RATE_LIMIT_STATUS_CODES:
            seconds = retry_after_seconds(response)
            reason = (
                f"{provider.name} answered HTTP {status} for GROUP={group} and is throttling "
                f"us, so its own figure of {seconds:.0f}s is honoured before asking again."
            )
        else:
            seconds = MIRROR_STOP_SECONDS
            reason = (
                f"{provider.name} answered HTTP {status} for GROUP={group}. It republishes "
                "CelesTrak rather than setting policy, so this is one publication cycle off "
                "rather than a day."
            )
        self._provider_errors[provider.name] = reason
        self._hold_off(provider, reason, seconds)
        raise CelestrakStoppedError(SOURCE_NAME, reason, status)

    async def _fetch(self, provider: ElementProvider, group: str) -> ElementBatch:
        """One request to one provider.

        ``follow_redirects=False`` is load-bearing. On CelesTrak a 301 means the URL is wrong,
        and following it would turn a policy warning into a silent success against an endpoint
        they have asked us to stop using. On a republisher it means the mirror moved, which is
        a fact worth surfacing rather than papering over.
        """
        try:
            response = await self._client.get(provider.url(group), follow_redirects=False)
        except httpx.HTTPError as exc:
            # A dead socket is not a refusal we can read, so it does not hold the provider off
            # and a later poll may succeed. CelesTrak arrives here every time today, because a
            # firewall drop looks like this rather than like an HTTP response.
            # describe_exception, not the exception: httpx timeouts carry no message at all,
            # and this string is what /api/health, /api/capabilities and the layer rail show a
            # person. It read "unreachable: ConnectTimeout: " on the live run.
            detail = f"unreachable: {describe_exception(exc)}"
            self._provider_errors[provider.name] = detail
            raise SourceError(provider.name, detail) from exc

        if response.status_code != httpx.codes.OK:
            self._refuse(provider, group, response)

        batch = parse_elements(
            response.content, group=group, fetched_at=self._clock(), source=provider.name
        )
        self._provider_errors.pop(provider.name, None)
        return batch
