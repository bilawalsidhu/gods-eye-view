"""REST reads for live entity layers.

These are snapshot endpoints. They exist because a client needs a starting picture before
the WebSocket has had time to deliver deltas, and because they make the whole system
inspectable with curl, which is worth a great deal when a feed misbehaves.

They read the store and never touch an upstream. A browser refresh must not turn into an
upstream request, or a page reload loop becomes a denial of service against a free
provider.
"""

import logging
from collections.abc import Mapping
from datetime import date
from typing import Annotated, Final, Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import Field, ValidationError

from tracker.api.state import AppState, StateDep
from tracker.contracts.aircraft import Aircraft
from tracker.contracts.base import StrictModel, UtcDatetime
from tracker.contracts.city import City
from tracker.contracts.evidence import Join
from tracker.contracts.geo import BoundingBox
from tracker.contracts.messages import FeedHealth
from tracker.contracts.organisation import Organisation
from tracker.contracts.person import WEALTH_TIER_REASON, Person
from tracker.contracts.satellite import Satellite
from tracker.contracts.transit import TransitVehicle
from tracker.contracts.vessel import Vessel
from tracker.services import spine
from tracker.services.classify import classified
from tracker.services.enrich import EnrichmentTally
from tracker.services.suppression import SuppressionStore, excluding_suppressed
from tracker.services.union import ProviderResult, ProviderTally, UnionResult
from tracker.sources import adsbdb, faa_registry, gtfsrt, sec
from tracker.sources.base import describe_exception

_log = logging.getLogger(__name__)

router = APIRouter(prefix="/api", tags=["entities"])

CITY_LAYER = "cities"
"""The layer name the gazetteer answers to on ``/api/layers`` and ``/api/capabilities``.

A plain string rather than a ``LayerName``: that type is the set of layers the WebSocket
carries deltas for, and cities have none. They are a static weekly file read once into an
index, so there is nothing to push.
"""

TRANSIT_LAYER = "transit"
"""The layer name the GTFS-Realtime sweep answers to on ``/api/layers``.

Declared here beside :data:`CITY_LAYER` rather than imported from ``app.py``, so a route
module naming its own layer does not depend on the application factory. Unlike cities this
one **is** a ``LayerName`` and does carry WebSocket deltas; the plain annotation here is just
the string this module compares against.
"""

CITY_READ_LIMIT = 2_000
"""Cities returned by default, biggest first.

The whole gazetteer is 34,072 rows and about 8MB of JSON, which is not a sensible default
response for a label layer. Ordered by population descending, so the default is the cities a
world view draws, and a client that wants small places asks for a bounding box.
"""

CITY_READ_LIMIT_MAX = 40_000
"""Ceiling on one read, above the row count, so the whole file is askable in one request.

Above rather than at the row count on purpose: the file grows, and a cap that tracked today's
count would silently truncate the layer the week GeoNames adds a city.
"""


class AircraftSnapshot(StrictModel):
    """Every aircraft currently held, optionally filtered to a viewport."""

    count: int
    aircraft: tuple[Aircraft, ...]


class RegistryConflict(StrictModel):
    """One attribute where the registry disagreed with the feed. Both values are shown.

    Nothing is silently overwritten and nothing is combined. The feed keeps the attribute
    because its value is dated and the registry's is not (adsbdb carries no as-of date at
    all), and the registry's value is carried here so the card can show the disagreement.

    It happens on real records rather than in theory. The Gulfstream G650 in
    ``tests/fixtures/adsbdb_ab374c_live.json`` reads ``GLF6`` off the feed, which is its ICAO
    Doc 8643 designator, and ``G650`` off adsbdb, which is not a designator at all.
    """

    attribute: str
    feed_value: str
    registry_value: str


class AircraftOwnership(StrictModel):
    """The ownership spine for one aircraft: registrant, filing entity, and named officers.

    **``asserted`` is the decision and the client must read it rather than the number.**
    :func:`tracker.services.spine.asserted_join` is the single place that decides, and it stays
    the single place: a card applying its own cut-off to ``join.confidence`` is how a card, an
    aggregate and this route come to disagree about the same join. The confidence is served
    anyway, because ADR 011 wants the score shown on a possible match, but it is for display
    and never for a decision.

    **The basis is not decoration.** ``BASIS_EXACT`` and ``BASIS_CORE`` say different things: one
    is an exact match against the SEC company index, the other is a match after stripping legal
    suffixes with the parent company unconfirmed. Measured across the whole register, the first
    produced zero ambiguous matches on 78,140 organisation registrant names and the second
    produced three, which is why one asserts and the other does not.

    **There is no total here on purpose.** A possible match is excluded from every aggregate, so
    this carries one join and a boolean rather than a count a client might add up.

    The officers are the sensitive half. Their contact fields are separate, tuple-typed and
    empty, so a serializer honouring ``NoContactData`` drops them without touching anything
    else, and nothing here has to be retrofitted when suppression under ADR 008 lands: the
    candidate set is built in one place, :func:`_officers`, which is where the check goes.
    """

    registrant: str | None = Field(
        default=None,
        description="The owner name as the asset register wrote it, not normalised. A card "
        "showing a normalised name would be showing our string rather than the register's. "
        "``null`` when the register was read and does not hold this airframe, which "
        "``refused_reason`` then states.",
    )
    registrant_kind: Literal["person", "organisation", "unknown"] | None = Field(
        default=None,
        description="What the register says the registrant is. A person is never name-matched, "
        "on measured evidence: of 23 owner names that looked like natural people, two returned "
        "any candidate at all and both were wrong.",
    )
    asset_register: str = Field(
        description="Which asset register answered, e.g. ``faa``. Named this rather than "
        "``register`` because that shadows a pydantic attribute and only warns.",
    )
    as_of: date = Field(
        description="The register's own extract date. Never the date of the request.",
    )

    asserted: bool = Field(
        description="Whether this join may be shown as fact. Read this, not the confidence.",
    )
    join: Join | None = Field(
        default=None,
        description="The link itself, with its basis, source, origin key, confidence and date. "
        "``null`` when nothing matched, and ``refused_reason`` then says why.",
    )
    organisation: Organisation | None = Field(
        default=None,
        description="The filing entity the registrant resolved to. ``null`` when there is no join.",
    )
    officers: tuple[Person, ...] = Field(
        default=(),
        description="Named officers and directors of that entity, each from a primary filing. "
        "Empty when there is no join, when the entity files none, or when the lookup failed, "
        "and ``degraded_reason`` distinguishes the last of those.",
    )
    officers_basis: str | None = Field(
        default=None,
        description="How the officers were obtained, the parallel to ``join.basis``.",
    )

    refused_reason: str | None = Field(
        default=None,
        description="Why there is no join, in the matcher's own words: the registrant is a "
        "natural person, the name is claimed by more than one filing entity, or no filing "
        "entity carries it.",
    )
    degraded_reason: str | None = Field(
        default=None,
        description="Why the officers are missing when there is a join. A filing lookup that "
        "fails degrades this to the join alone and never to an error, the same contract the "
        "registry join already has.",
    )
    wealth_tier_reason: str = Field(
        default=WEALTH_TIER_REASON,
        description="Why every officer's wealth tier is empty. Carried rather than omitted: an "
        "absent field reads as an oversight and an empty one with a stated reason reads as a "
        "finding.",
    )


class AircraftDetail(StrictModel):
    """One aircraft plus the registry join that produced its ownership, and its provenance.

    ADR 011 wants every claim to carry where it came from and when, so the join is described
    rather than merged invisibly into the record: ``registry`` names the register that
    answered, ``joined_at`` dates this join, and ``degraded_reason`` says why there is no
    owner when there is none.

    ``registry`` is null in two situations that must not be confused. The register answered
    and does not hold the airframe, which is about one live aircraft in five and leaves
    ``degraded_reason`` null. Or the register did not answer, which sets it.

    No photograph. adsbdb's photo URL is a hot-link into a third party and AGENTS.md forbids
    hot-linking media, so it stays server side for a proxy that owes its own host allowlist.
    """

    aircraft: Aircraft
    registry: str | None = None
    registry_attribution: str | None = None
    joined_at: UtcDatetime | None = None
    conflicts: tuple[RegistryConflict, ...] = ()
    degraded_reason: str | None = None
    ownership: AircraftOwnership | None = None
    """The ownership spine, or ``null`` when **no register has loaded at all**.

    ``null`` means one thing and one thing only: an outage. It used to mean two, an outage or
    an airframe the register does not hold, and nothing in the payload separated them, so a
    card could not say "not on this register" without asserting the one thing it could not
    know. The ordinary case now comes back as a block carrying the register's own extract date
    and a ``refused_reason``, which is a dated, sourced negative claim rather than an absence.

    About one live aircraft in five is not on the US civil register, which is military and
    foreign traffic, so that case is common and is not a failure."""


class VesselSnapshot(StrictModel):
    """Every vessel currently held, optionally filtered to a viewport."""

    count: int
    vessels: tuple[Vessel, ...]


class TransitSnapshot(StrictModel):
    """Every transit vehicle currently held, optionally filtered to a viewport."""

    count: int
    vehicles: tuple[TransitVehicle, ...]


class CitySnapshot(StrictModel):
    """Cities from the local gazetteer, biggest first, optionally inside a bounding box.

    ``total`` is how many matched before the limit was applied, so a capped read says so
    rather than reading as everything the server holds. It answers a different question from
    ``count`` whenever the two differ, and a client that needs the rest asks with a box.
    """

    count: int
    total: int
    cities: tuple[City, ...]


class SatelliteSnapshot(StrictModel):
    """Every satellite currently held.

    No bounding box, and there is nothing to filter on: a satellite record carries orbital
    elements rather than a position, and the browser propagates it. Filtering here would
    mean running SGP4 on the server for every object on every request.
    """

    count: int
    satellites: tuple[Satellite, ...]


class SatelliteElements(StrictModel):
    """Cached OMM element sets, with when each group was last fetched.

    ``fetched`` is the evidence for the two-hour floor: it is the instant of the fetch,
    which is a different thing from an element set's epoch. One record per catalogue number,
    freshest epoch winning, because CelesTrak groups overlap.
    """

    count: int
    fetched: dict[str, UtcDatetime]
    satellites: tuple[Satellite, ...]


class ProviderCoverage(StrictModel):
    """One provider's contribution to a merged layer, for the last cycle.

    ADR 010 asks for two things this carries. ``exclusive`` is the provider-attributable
    count, so "ships only this network can see" is measured rather than asserted. ``error``
    names a provider that dropped out, which is how the layer reports itself degraded
    instead of quietly covering less.

    The four running totals are the history the per-cycle fields cannot carry. ``records``
    and ``error`` describe this cycle only and are replaced by the next one, so a provider
    that has answered an empty HTTP 200 every cycle for a week looks exactly like one that
    did it once. ``failures`` and ``empty_polls`` against ``polls`` are what tell those
    apart, and ``drops`` is the records the adapter refused, which ADR 010's "an error,
    counted" needs somewhere a human can read.

    This is coverage, not corroboration, and the two must not be confused: under R1 in
    ``docs/pending-decisions.md`` three providers reporting one ship are still one origin,
    because they are repeating one AIS broadcast. Nothing here may be counted as
    independent sources.
    """

    layer: str
    provider: str
    records: int
    exclusive: int
    error: str | None = None
    polls: int = 0
    failures: int = 0
    empty_polls: int = 0
    drops: int = 0
    last_success_at: UtcDatetime | None = None


class RefusedRecords(StrictModel):
    """One reason the adapter refused records, and how many it has refused for it.

    **Deliberately not a** :class:`ProviderCoverage`. That model answers "how many records did
    only this provider see", which has no meaning for a reason: it has no records and nothing is
    exclusive to it. Borrowing the shape put rows on ``/api/layers`` reading ``records: 0`` and
    ``exclusive: 0``, and the layer rail then rendered "report older than 5 minutes only: 0",
    which is not a statement about anything. A reason and a count is the whole of it.
    """

    reason: str = Field(description="The adapter's own words for why the records were refused.")
    count: int = Field(ge=1, description="How many records, cumulative since start-up.")


class SweepCoverage(StrictModel):
    """One adapter sweeping a registry of many feeds, rather than polling one endpoint.

    Carries what the last pass did and what the adapter has refused since start-up.

    Separate from :class:`ProviderCoverage` because a sweep is not a poll of a provider. The
    transit adapter reads 258 feeds across 52 hosts, each host with its own cadence floor, so
    the interesting numbers are how many feeds were read, how many confirmed themselves
    unchanged with a 304, how many were held back inside a floor and how many could not be
    read. Reporting those as a provider's ``polls`` and ``empty_polls`` produced 175 against 83,
    which cannot both be true of one provider and was in fact feeds out of a 258-feed registry.

    **``unchanged`` is not a failure and must never be folded into one.** A host answering 304
    has confirmed its held records still stand, and roughly 55% of this layer's traffic is 304s,
    so treating them as empty answers would report a working conditional request as a dead feed.

    **``skipped`` is not a failure either.** A 30-second poller against floors of 30, 120 and
    350 seconds skips most of the registry on most passes, and that is the rate discipline
    working rather than anything going wrong.
    """

    layer: str
    provider: str

    feeds: int = Field(description="Feeds in the registry this adapter may read.")
    read: int = Field(description="Feeds actually fetched on the last pass.")
    unchanged: int = Field(description="Feeds that answered 304, confirming their held records.")
    skipped: int = Field(description="Feeds held back inside their host's cadence floor.")
    failed: int = Field(description="Feeds that could not be read at all on the last pass.")

    records: int = Field(description="Vehicles currently held from this adapter.")
    refused: tuple[RefusedRecords, ...] = Field(
        default=(),
        description="Why records were refused, cumulative since start-up, **non-zero reasons "
        "only**. A reason that has never fired is not information, and filtering it at the "
        "presenter instead would leave the wrong shape underneath for every other client.",
    )
    error: str | None = Field(
        default=None, description="Why feeds failed on the last pass, or null when none did."
    )


class RegistryCoverage(StrictModel):
    """One registry's enrichment outcomes since start-up, for the same reason as a provider's.

    The counts exist because an :class:`~tracker.services.enrich.Enriched` describes one card
    open and is then thrown away, so a registry that has failed every lookup since start-up
    looks exactly like one that failed the last one. ``unmappable`` is the drop-and-count rule
    one layer up from the adapters: the registry answered and the domain contract would not
    take it, which is a different fault from the registry not answering.

    Demand-driven, so these move when cards are opened rather than on a cadence. A registry
    with ``requests`` at zero has not been asked yet, which is not the same as healthy.
    """

    registry: str
    requests: int
    enriched: int
    not_held: int
    failures: int
    unmappable: int
    conflicts: int
    last_error: str | None = None


class LayerSummary(StrictModel):
    """Counts and health per layer, for the layer rail and the degraded banners."""

    layers: dict[str, int]
    feeds: tuple[FeedHealth, ...]
    providers: tuple[ProviderCoverage, ...] = ()
    sweeps: tuple[SweepCoverage, ...] = ()
    """Adapters that read a registry of feeds rather than one endpoint.

    Transit is the only one today. It is here rather than in ``providers`` because a sweep over
    258 feeds does not answer the question ``providers`` asks, and forcing it to produced rows
    a viewer could not read.
    """

    registries: tuple[RegistryCoverage, ...] = ()


def _optional_box(
    west: float | None,
    south: float | None,
    east: float | None,
    north: float | None,
) -> BoundingBox | None:
    """Build a bounding box only when all four edges were supplied.

    Partial boxes are rejected rather than guessed at: silently defaulting a missing edge
    to the world would return every aircraft to a client that believed it was filtering.
    """
    if west is None and south is None and east is None and north is None:
        return None
    if west is None or south is None or east is None or north is None:
        raise HTTPException(
            status_code=422,
            detail="a bounding box needs all four of west, south, east and north",
        )
    try:
        return BoundingBox(west=west, south=south, east=east, north=north)
    except ValidationError as exc:
        # An inverted box (south above north) is the caller's mistake, not ours, so it
        # must read as 422 rather than a 500 that looks like a server fault. Note that
        # west > east is legitimate and means the box crosses the antimeridian.
        raise HTTPException(status_code=422, detail=_first_error(exc)) from exc


def _first_error(exc: ValidationError) -> str:
    """The first validation message, for a client-facing detail string."""
    errors = exc.errors()
    return errors[0]["msg"] if errors else "invalid bounding box"


OFFICERS_BASIS: Final = "named on an SEC Form 3, 4 or 5 filed against this issuer"
"""How the officers were obtained. The parallel to ``Join.basis`` for the people half."""

OFFICER_FILING_LIMIT: Final = 4
"""How many recent ownership filings to read per company.

One filing establishes the person, the issuer and the role between them; the rest are
transactions and this build makes no claim about transactions. Four rather than one because a
company's most recent filings are often the same insider several times over.
"""


def _officers(
    records: tuple[tuple[Person, Organisation], ...], *, store: SuppressionStore
) -> tuple[Person, ...]:
    """The candidate people from a company's filings, deduplicated and never the suppressed.

    **One place, and that is the point.** ADR 012 and ADR 013 both say a suppressed person is
    "excluded from candidate generation rather than filtered afterwards", and the difference is
    not stylistic: a filter runs after the set exists, so the person has already been scored,
    already been counted in an aggregate, and already been in a payload something might log.
    This is the candidate set, so this is where the exclusion happens, and there is nowhere
    else in this route it could happen instead.

    The order matters too. The exclusion wraps the return rather than the loop, so a suppressed
    person is not merely dropped from the output but never becomes a candidate to be dropped.
    """
    seen: dict[str, Person] = {}
    for person, _ in records:
        key = person.sec_cik or person.person_id
        seen.setdefault(key, person)
    return excluding_suppressed(
        seen.values(), identifier=lambda person: person.person_id, store=store
    )


NOT_ON_REGISTER: Final = "this register does not hold that airframe"
"""The ordinary negative, and it is information rather than an absence.

About one live aircraft in five, which is military and foreign traffic. Served as a block with
the register's own extract date rather than as ``null``, so a card can say "the US civil
register as of 2026-08-22 does not hold this airframe" instead of guessing whether the register
was read at all.
"""


async def _ownership(state: AppState, aircraft: "Aircraft") -> AircraftOwnership | None:
    """Resolve one aircraft's registrant to a filing entity and its officers.

    Demand-driven per card, never a sweep, for the reason ``services/enrich.py`` already gives
    about the registry join: a live layer is thousands of records a cycle and the useful
    question is about the one aircraft a viewer has opened.

    The match itself opens no socket. The register and the company index are both in memory, so
    everything up to the officers is a dictionary lookup; only the filings are fetched, and only
    when there is something to fetch them for.

    **Returns ``None`` for exactly one reason: no register has loaded.** Every other outcome is
    a block, so a card can tell an outage from an airframe the register does not hold, and from
    a registrant that matched nothing, and from filings that are switched off.
    """
    registry = state.faa.index
    extract = registry.extract_date if registry is not None else None
    if registry is None or extract is None:
        return None

    as_of = extract.date()
    block = AircraftOwnership(
        asset_register=faa_registry.SOURCE_NAME,
        as_of=as_of,
        asserted=False,
    )
    registration = registry.registration(aircraft.icao24)
    if registration is None:
        return block.model_copy(update={"refused_reason": NOT_ON_REGISTER})

    kind = spine.registrant_kind(str(registration.owner_type))
    block = block.model_copy(
        update={"registrant": registration.owner_name, "registrant_kind": kind}
    )
    index = state.company_index
    if index is None:
        # The register answered and the owner is on the card. Only the join is off, because the
        # company index is an SEC fetch and the SEC refuses an undeclared client. Degraded
        # rather than absent, which is the whole point of separating the two conditions.
        return block.model_copy(update={"refused_reason": sec.UNAVAILABLE_REASON})

    result = spine.match_registrant(
        registration.owner_name,
        kind=kind,
        index=index,
        as_of=as_of,
        source=faa_registry.SOURCE_NAME,
        origin_key=f"{faa_registry.SOURCE_NAME}-{as_of.isoformat()}",
    )
    if result.join is None:
        return block.model_copy(update={"refused_reason": result.reason})

    organisation = index.by_id[result.join.target_id]
    officers, degraded = await _fetch_officers(state, organisation)
    return block.model_copy(
        update={
            "asserted": spine.asserted_join(result.join),
            "join": result.join,
            "organisation": organisation,
            "officers": officers,
            "officers_basis": OFFICERS_BASIS if officers else None,
            "degraded_reason": degraded,
        }
    )


async def _fetch_officers(
    state: AppState, organisation: Organisation
) -> tuple[tuple[Person, ...], str | None]:
    """The company's named officers from its own filings, or why there are none.

    A failed lookup degrades this to the join alone and never to an error, the same contract
    the registry join already has: a card losing its officers is a smaller loss than a card
    losing the aircraft.
    """
    if organisation.sec_cik is None:
        return (), None
    try:
        parsed = await state.sec.ownership_for(organisation.sec_cik, limit=OFFICER_FILING_LIMIT)
    except Exception as exc:  # noqa: BLE001 - a card must render whatever the SEC does
        _log.info("officer lookup failed for %s: %s", organisation.name, describe_exception(exc))
        return (), describe_exception(exc)
    return _officers(parsed.records, store=state.suppression), None


@router.get("/aircraft")
async def list_aircraft(
    state: StateDep,
    *,
    west: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    south: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    east: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    north: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    military_only: Annotated[bool, Query()] = False,
) -> AircraftSnapshot:
    """Aircraft currently known to the server.

    Military aircraft are held in their own store because they come from a separate
    worldwide endpoint rather than the viewport query, and merging them into one store
    would let a global feed evict the local one every poll.
    """
    box = _optional_box(west, south, east, north)
    records = state.military.snapshot() if military_only else state.aircraft.snapshot()
    if box is not None:
        records = tuple(a for a in records if box.contains(a.point))
    return AircraftSnapshot(count=len(records), aircraft=records)


@router.get("/aircraft/{icao24}", response_model=AircraftDetail | None)
async def get_aircraft(state: StateDep, icao24: str) -> AircraftDetail | None:
    """One aircraft by ICAO address, joined to the registry. ``null`` when not seen.

    **This is the card path, and it is the only place enrichment happens.** A card asks
    about one aircraft and the registry is asked about that one aircraft, because adsbdb's
    limiter allows 512 requests a minute per IP and a live layer is thousands of records a
    cycle. Sweeping the layer would be throttled inside the first poll and would tell us
    nothing the card needs.

    A registry that does not answer degrades this to feed-only data and never to an error, so
    the aircraft still renders with its position, callsign, type and class. Per ADR 009 the
    LADD flag changes nothing here: a LADD aircraft resolves to its owner and comes back like
    any other.
    """
    key = icao24.strip().lower()
    record = state.aircraft.get(key) or state.military.get(key)
    if record is None:
        return None
    joined = await state.registry.enrich(record)
    return AircraftDetail(
        # Reclassified after the join, because a register can supply the type designator the
        # class is derived from and the feed often carries none. Without this an aircraft the
        # rules can now place is served with "Type GLF5" beside "Class Unknown" and stays out
        # of the business-jet count, which is the one classification this demo exists to make.
        # After the conflict resolution rather than inside the merge: the class is derived
        # from the designator, so classifying the merged record before the feed takes its own
        # designator back would raise a second conflict on a field the registry never spoke to.
        aircraft=classified(joined.value),
        registry=joined.registry,
        registry_attribution=adsbdb.ATTRIBUTION if joined.enriched else None,
        joined_at=joined.joined_at,
        conflicts=tuple(
            RegistryConflict(
                attribute=conflict.attribute,
                feed_value=_rendered(conflict.feed_value),
                registry_value=_rendered(conflict.registry_value),
            )
            for conflict in joined.conflicts
        ),
        degraded_reason=joined.error,
        ownership=await _ownership(state, record),
    )


def _rendered(value: object) -> str:
    """One side of a conflict as a string a card can print.

    Rendered rather than typed, because the two sides are whatever the contract holds at
    that attribute and a union of every possible field type would be a wire contract nobody
    could read. The attribute name is next to it, so the type is not in doubt.
    """
    return "not reported" if value is None else str(value)


# ---------------------------------------------------------------- vessels


@router.get("/vessels")
async def list_vessels(
    state: StateDep,
    *,
    west: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    south: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    east: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    north: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
) -> VesselSnapshot:
    """Vessels currently known to the server, merged across every reporting provider.

    One record per MMSI whatever the provider count, per ADR 010. Each record names the
    provider whose report supplied it, how old that report was, and every provider that saw
    the ship, because a merged store you cannot audit per record is the bug that rule exists
    to prevent.
    """
    box = _optional_box(west, south, east, north)
    records = state.vessels.snapshot()
    if box is not None:
        records = tuple(v for v in records if box.contains(v.point))
    return VesselSnapshot(count=len(records), vessels=records)


@router.get("/vessels/{mmsi}", response_model=Vessel | None)
async def get_vessel(state: StateDep, mmsi: str) -> Vessel | None:
    """One vessel by MMSI. ``null`` when not currently seen."""
    return state.vessels.get(mmsi.strip())


# ---------------------------------------------------------------- satellites


# ---------------------------------------------------------------- transit


@router.get("/transit")
async def list_transit(
    state: StateDep,
    *,
    west: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    south: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    east: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    north: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
) -> TransitSnapshot:
    """Buses and trains currently known to the server, across 258 keyless licensed feeds.

    One record per ``(feed_id, entity_id)``, which is the compound key rather than the
    vehicle's own id: 20% of id-carrying vehicles share an id with another agency, so keying
    on the obvious field collapses two buses in different countries into one.

    Coverage is 17 countries, almost all in Europe and North America, and the count moves
    with the time of day by a factor of 2.7 because a transit layer counts buses where
    buses are running. Both facts are on the layer's capability reason rather than implied.
    """
    box = _optional_box(west, south, east, north)
    records = state.transit.snapshot()
    if box is not None:
        records = tuple(v for v in records if box.contains(v.point))
    return TransitSnapshot(count=len(records), vehicles=records)


@router.get("/satellites")
async def list_satellites(state: StateDep) -> SatelliteSnapshot:
    """Satellites currently held, one record per NORAD catalogue number."""
    records = state.satellites.snapshot()
    return SatelliteSnapshot(count=len(records), satellites=records)


@router.get("/satellites/elements")
async def satellite_elements(state: StateDep) -> SatelliteElements:
    """Cached orbital element sets, served without touching CelesTrak.

    Declared before nothing else on this prefix by design: the store read above answers
    ``/api/satellites`` and this answers the element cache, which is what a client
    propagating orbits itself needs.
    """
    records = state.celestrak.cached_elements()
    fetched = {
        group: at
        for group in state.settings.celestrak_groups
        if (at := state.celestrak.cached_at(group)) is not None
    }
    return SatelliteElements(count=len(records), fetched=fetched, satellites=records)


# ---------------------------------------------------------------- cities


@router.get("/cities")
async def list_cities(
    state: StateDep,
    *,
    west: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    south: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    east: Annotated[float | None, Query(ge=-180.0, le=180.0)] = None,
    north: Annotated[float | None, Query(ge=-90.0, le=90.0)] = None,
    limit: Annotated[int, Query(ge=1, le=CITY_READ_LIMIT_MAX)] = CITY_READ_LIMIT,
) -> CitySnapshot:
    """Populated places above 15,000 people, from the local GeoNames index.

    Reads no network and never can: the gazetteer holds no HTTP client. It is not a
    time-to-live store either, so a city that was here at start-up is still here an hour
    later without anything writing it back.

    Ordered by population descending with the GeoNames id breaking ties, which is what makes
    a capped read useful: the first page is the cities a world view labels, and a bounding box
    is how a client reaches the smaller ones. Empty until the weekly refresh has run once,
    which ``/api/capabilities`` reports as unavailable with the reason rather than leaving it
    looking like a layer that draws nothing.
    """
    box = _optional_box(west, south, east, north)
    records = state.cities
    if box is not None:
        records = tuple(city for city in records if box.contains(city.point))
    return CitySnapshot(count=min(len(records), limit), total=len(records), cities=records[:limit])


@router.get("/cities/{geonames_id}", response_model=City | None)
async def get_city(state: StateDep, geonames_id: int) -> City | None:
    """One city by its GeoNames id. ``null`` when the index does not hold it.

    The id is what a search hit carries and what a shareable URL puts in its fragment, so
    this is the direct lookup behind both. A dict read on the index, no scan.
    """
    return state.city_index.get(geonames_id)


# ---------------------------------------------------------------- layers


def _provider_coverage[T](
    layer: str,
    union: UnionResult[T] | None,
    tallies: Mapping[str, ProviderTally],
) -> tuple[ProviderCoverage, ...]:
    """Turn the last merge of one layer into per-provider coverage, or nothing yet.

    Derived from the merge result rather than kept alongside it, so the numbers cannot drift
    from what actually came back. The running totals come from the tallies, which outlive the
    result the way the failures they count outlive one cycle.
    """
    if union is None:
        return ()
    exclusive = union.attributable_counts()
    return tuple(
        _coverage_row(
            layer,
            result,
            exclusive,
            tallies.get(result.provider) or ProviderTally(provider=result.provider),
        )
        for result in union.provider_results
    )


def _coverage_row[T](
    layer: str,
    result: ProviderResult[T],
    exclusive: Mapping[str, int],
    tally: ProviderTally,
) -> ProviderCoverage:
    """One provider's row: this cycle from the result, the history from its tally.

    ``records`` at zero with ``error`` null is the reporting-but-empty state ADR 010 keeps
    separate from a failure, so nothing here folds one into the other. What the row adds is
    how many times that has happened.
    """
    return ProviderCoverage(
        layer=layer,
        provider=result.provider,
        records=len(result.records),
        exclusive=exclusive.get(result.provider, 0),
        error=result.error,
        polls=tally.polls,
        failures=tally.failures,
        empty_polls=tally.empty_polls,
        drops=tally.drops,
        last_success_at=tally.last_success_at,
    )


@router.get("/layers")
async def layer_summary(state: StateDep) -> LayerSummary:
    """Entity counts per layer plus upstream health, for the layer rail."""
    return LayerSummary(
        layers={
            "aircraft": len(state.aircraft),
            "military": len(state.military),
            "vessels": len(state.vessels),
            "transit": len(state.transit),
            "satellites": len(state.satellites),
            CITY_LAYER: len(state.cities),
        },
        feeds=state.pollers.health(),
        providers=(
            _provider_coverage("aircraft", state.aircraft_union, state.aircraft_providers)
            # One provider, and here for its drop count: /v2/mil refuses 81 of 391 records in
            # the recorded capture, the worst rate of any feed in the project.
            + _provider_coverage("military", state.military_union, state.military_providers)
            + _provider_coverage("vessels", state.vessel_union, state.vessel_providers)
            + _transit_provider(state)
            + _city_coverage(state)
        ),
        sweeps=_transit_sweep(state),
        registries=(_registry_coverage(state.registry.tally),),
    )


def _transit_provider(state: AppState) -> tuple[ProviderCoverage, ...]:
    """The transit adapter's row among the providers: one adapter, counted per sweep.

    Uniform with every other layer, so a client iterating ``providers`` sees transit like the
    rest. **A poll here is one sweep**, not one feed: putting feed counts in these fields is
    what made ``empty_polls`` read 175 against 83 polls. The per-feed detail is on
    :class:`SweepCoverage`, where the fields are named for feeds.

    ``exclusive`` equals ``records`` because one adapter supplied every vehicle. Nothing until a
    sweep has run, the same rule the merged layers and the city dump follow: a row of zeroes
    reads as a pass that found nothing, which is not the same as never having swept.
    """
    tally = state.transit_tally
    if tally.polls == 0:
        return ()
    held = len(state.transit)
    return (
        ProviderCoverage(
            layer=TRANSIT_LAYER,
            provider=tally.provider,
            records=held,
            exclusive=held,
            error=_transit_failure_reason(state),
            polls=tally.polls,
            failures=tally.failures,
            empty_polls=tally.empty_polls,
            drops=tally.drops,
            last_success_at=tally.last_success_at,
        ),
    )


def _transit_failure_reason(state: AppState) -> str | None:
    """Why feeds failed on the last pass, or ``None`` when none did."""
    sweep = state.transit_sweep
    if sweep is None or not sweep.failures:
        return None
    return "; ".join(sweep.failures.values())


def _transit_sweep(state: AppState) -> tuple[SweepCoverage, ...]:
    """What the last transit pass did, and every reason it has refused a record.

    Only non-zero reasons reach the wire. Five zeros on a rail was the visible half of the bug
    this shape replaces, and a reason that has never fired is not information.
    """
    sweep = state.transit_sweep
    if sweep is None:
        return ()
    return (
        SweepCoverage(
            layer=TRANSIT_LAYER,
            provider=state.transit_tally.provider,
            feeds=len(gtfsrt.FEEDS),
            read=sweep.polled,
            unchanged=sweep.unchanged,
            skipped=sweep.skipped,
            failed=sweep.failed,
            records=len(state.transit),
            refused=tuple(
                RefusedRecords(reason=reason, count=count)
                for reason, count in sorted(state.transit_refusals.items())
                if count
            ),
            error=_transit_failure_reason(state),
        ),
    )


def _city_coverage(state: AppState) -> tuple[ProviderCoverage, ...]:
    """The city dump's row: one provider, one file, and the rows it refused.

    Here rather than in ``_provider_coverage`` because there is no merge to derive it from.
    Cities come from one file from one provider, so building a union over 34,072 records to
    produce a single row would be ceremony around a count.

    Nothing until the refresh has been attempted, the same rule the merged layers follow when
    no cycle has run: a row of zeroes reads as a feed reporting nothing, which is a different
    statement from never having been asked. ``exclusive`` equals ``records`` because one
    provider supplied every row, and ``empty_polls`` stays zero because it cannot happen: the
    adapter refuses a dump that parses to nothing rather than reporting an empty world.
    """
    tally = state.city_tally
    if tally.polls == 0:
        return ()
    held = len(state.cities)
    return (
        ProviderCoverage(
            layer=CITY_LAYER,
            provider=tally.provider,
            records=held,
            exclusive=held,
            error=state.geonames.last_error,
            polls=tally.polls,
            failures=tally.failures,
            drops=tally.drops,
            last_success_at=tally.last_success_at,
        ),
    )


def _registry_coverage(tally: EnrichmentTally) -> RegistryCoverage:
    """One registry's running tally on the wire, so the counts are readable rather than held.

    Mapped field by field rather than dumped, so adding a counter to the service is a
    deliberate choice about what the API carries.
    """
    return RegistryCoverage(
        registry=tally.registry,
        requests=tally.requests,
        enriched=tally.enriched,
        not_held=tally.not_held,
        failures=tally.failures,
        unmappable=tally.unmappable,
        conflicts=tally.conflicts,
        last_error=tally.last_error,
    )
