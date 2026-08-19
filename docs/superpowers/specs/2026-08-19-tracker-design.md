# Tracker: design spec

**Date:** 2026-08-19
**Status:** approved for implementation
**Type:** architectural (new project)

## 1. What this is

A web application that renders an interactive 3D globe and shows real public data on
it in near real time: aircraft, ships, satellites, public cameras, geolocated news and
natural events, map points of interest, 3D buildings, satellite imagery, and a knowledge
layer of notable public figures and organisations.

A user can navigate the globe smoothly, search for a place, an asset or a notable person,
have the camera fly there, and read an information card about what they selected. The
backend cross-references feeds against public registries to enrich what the card shows.

Every data point comes from a real, live, public source. There are no fixtures in the
running product, no mock feeds, no sample data, no placeholder cards.

## 2. Success criteria

1. Opening the app shows real aircraft, ships and satellites moving over real imagery
   within ten seconds, updating without a page refresh.
2. The globe holds 30 frames per second or better with 20,000 live entities on an
   ordinary laptop.
3. One search box finds a callsign, a registration, an MMSI, a NORAD ID, a satellite
   name, a place name or a notable public figure, flies the camera there and opens a card.
4. Every card names its source and its licence, and shows how old the data is.
5. Every data contract is a strict Pydantic model. An upstream payload that does not
   match is rejected at the boundary, not carried into the app as a partial object.
6. `uv run pytest` and `pnpm test` pass, `ruff` and `mypy --strict` are clean, and CI is
   green on a clean clone.

## 3. Non-goals

- No tracking of private individuals. See section 8.
- No de-anonymising of aircraft that use privacy-ICAO-address (PIA) hex codes.
- No face recognition or person identification on any camera image.
- No user-contributed entity records.
- No horizontal scaling in the first release: one poller process owns the upstream
  connections. Multi-worker deployment needs a lock first, and that is deliberately
  deferred.
- No commercial launch. Several chosen sources are free for non-commercial use only.
  `docs/data-sources.md` records the licence per source and is the first thing to audit
  if that changes.

## 4. Architecture

```
Upstream public feeds
   |
   |  one process owns every upstream connection
   v
FastAPI backend  ---------------------------------------------
   |  sources/     one adapter per feed, behind a Protocol      |
   |  contracts/   strict Pydantic models, validated at the     |
   |               boundary via TypeAdapter                     |
   |  services/    store (TTL), registry cache, classifier,     |
   |               search index, WebSocket hub, pollers         |
   |  api/         REST snapshots + search, one /ws multiplex   |
   ---------------------------------------------------------------
   |
   |  OpenAPI schema -> generated TypeScript types
   v
Vite + TypeScript frontend
   |  net/     WebSocket client, batched per animation frame
   |  globe/   CesiumJS viewer, one primitive collection per layer
   |  ui/      search, docked info card, layer rail, attribution
   |  state/   selection, layer toggles, URL sync
```

### Why the backend owns the feeds

Three reasons, in order of weight. API keys (aisstream, Windy, TfL) never reach the
browser. Upstream rate limits are hit exactly once no matter how many clients connect,
which matters because CelesTrak permanently firewalls abusive clients and Overpass has a
fair-use ceiling of roughly ten thousand queries a day per IP. And normalisation happens
in one place, so a provider swap touches one adapter rather than the whole frontend.

### The one exception: satellites

The backend caches CelesTrak orbital element sets and serves them to the browser. The
browser propagates positions itself with `satellite.js` (SGP4) every frame. This gives
smooth 60fps orbits for thousands of satellites with zero runtime API calls, and makes
time-scrubbing free: change the clock, re-propagate.

### Data flow for a moving asset

1. A poller task fetches the feed on its documented cadence.
2. The raw payload is validated by a `TypeAdapter` against a strict contract. A bad
   record is dropped and counted, never partially accepted.
3. The validated record goes into the in-memory store keyed by its stable identity
   (ICAO hex, MMSI, NORAD ID) with a time-to-live.
4. The store emits a change set. The hub batches change sets and pushes them over the
   single `/ws` WebSocket as a typed envelope.
5. The frontend applies the batch once per animation frame, mutating positions in place
   inside a `PointPrimitiveCollection`. Between server ticks it dead-reckons from
   heading and speed, so a five-second feed still looks like smooth motion.

### Cross-referencing

One enrichment service, keyed on entity identity. Given an aircraft hex it asks the
registry adapter (adsbdb) for owner, operator and type; given an MMSI it joins the AIS
static-data message to the position report; given a NORAD ID it joins the CelesTrak
element set metadata. Results are cached with a per-source time-to-live. Enrichment
failure degrades the card to feed-only data with a "registry unavailable" line. It never
produces an error state, because the position is still true and useful.

## 5. Data contracts

One base model, used by everything:

```python
class StrictModel(BaseModel):
    model_config = ConfigDict(
        strict=True,
        extra="forbid",
        frozen=True,
        populate_by_name=True,
        ser_json_timedelta="float",
    )
```

`extra="forbid"` is the load-bearing setting: when an upstream adds a field we find out
in a test rather than silently ignoring it. Upstream shapes get their own permissive
"wire" models where the provider genuinely sends unstable extra fields, and are mapped
explicitly into the strict domain contract. That mapping is the boundary.

Domain entities form a discriminated union on a `kind: Literal[...]` field, so a single
WebSocket envelope carries any entity type and both sides know how to narrow it.

Conventions, enforced in review and stated in `AGENTS.md`:

- Coordinate order is `[longitude, latitude]`, GeoJSON style, in every contract.
- WGS84 / EPSG:4326 everywhere in the domain. Cesium handles projection.
- Degrees in contracts. Radians only inside orbital maths.
- Altitude in metres above the WGS84 ellipsoid.
- Times are UTC, ISO 8601, timezone-aware. Naive datetimes are a validation error.

## 6. Frontend

CesiumJS, because it is the only globe engine that today has a true WGS84 globe,
streaming terrain, native 3D Tiles for building meshes, a built-in clock and timeline for
time-dynamic data, `camera.flyTo`, picking, and a documented self-hosted path. deck.gl's
`GlobeView` is still experimental with no pitch or terrain; MapLibre's globe has no 3D
Tiles and no time model; Globe.gl is a demo toy.

Rendering rules that come straight from the performance research:

- One primitive collection per layer. Never rebuild a layer per tick.
- `requestRenderMode` on, with explicit render triggers, so an idle scene costs nothing.
- Render loop paused when the tab is hidden.
- Level of detail by `distanceDisplayCondition`: icon, then icon plus label. Labels are
  the most expensive tier and get enabled last.
- Clustering below a zoom threshold, with count badges.
- Feed parsing in a Web Worker, handing transferable typed arrays to the render thread.

UI, following the Flightradar24 and MarineTraffic patterns that have already been proven
on this exact problem:

- Dark, low-chroma basemap. Saturated colour is reserved for entities, selection and
  alerts, never for chrome.
- One fixed hue per entity class, used identically on the map, in lists and on the card.
  Red and orange are reserved for alert states such as squawk 7700. Status is always
  encoded in shape as well as colour, never colour alone.
- One persistent search box, keyboard-first on `/` or `Ctrl+K`, results grouped by asset
  type, `Enter` flies the camera over one to two seconds and opens the card.
- The information card is a docked side panel, not a floating popup that covers the
  neighbours the user is trying to compare against.
- Layer rail on the right with a live entity count per layer.
- Camera position and layer state live in the URL, so any view is shareable.
- Accessibility is a gate, not polish: 4.5:1 text contrast, full keyboard operability
  with visible focus, an entity list panel as the screen-reader alternative to the
  canvas, and `prefers-reduced-motion` skipping the fly-to animation.

### Honest tenses

A rule that runs through the whole UI. Live assets show the age of their last fix. A
person pin says "Born in Ulm, per Wikidata" and never implies a current position. A GDELT
pin is labelled "news coverage location", because that is what GDELT geocodes: where a
story is about, not where anyone is.

## 7. Testing

- `pytest` with `pytest-asyncio` in auto mode.
- `respx` with `assert_all_called=True` for every outbound HTTP call, so a test that
  stops exercising a code path fails instead of passing quietly.
- `httpx.ASGITransport` for in-process application tests, no live server needed.
- `hypothesis` for contract round-trips and feed parsers.
- Recorded real payloads as fixtures. They are captured from the live APIs once, checked
  in, and used to test parsers. This is how "real data, no placeholders" and
  "deterministic tests" coexist: the product never uses a fixture, the tests never hit
  the network.
- Branch coverage, `fail_under=85`.
- `vitest` for frontend units, Playwright for end-to-end including a WebGL smoke test
  that proves the globe actually renders.

## 8. The people layer, and why it is safe

This is the highest-risk feature in the brief and it gets designed defensively.

The feature is a knowledge map of notable public entities. It is not a locator. The
distinction is enforced in the data layer, not in policy, because policy does not survive
a feature request.

- Only Wikidata entities that have a Wikipedia sitelink are searchable. That is the
  notability filter, and it is a query constraint rather than a judgement call.
- The camera flies only to coordinates reached through an allowlist of static, public,
  historical association properties: birthplace (P19), place of death (P20),
  headquarters (P159), work location (P937), educated at (P69), significant place
  (P7153), resolved via coordinate location (P625).
- Residence (P551) and raw coordinates on any living human (a `Q5` instance with no
  `P570` date of death) are excluded inside the SPARQL query itself. A home address
  cannot render even if a later bug lets something through, because it is never fetched.
- No present tense. No "last seen". No movement lines. No join between a person's name
  and any real-time feed. Person search and the GDELT event layer share no code path,
  and a test asserts that structurally.
- No geocoding of arbitrary names, and no user-contributed person records.
- Every card shows provenance: the relationship in words, links to Wikidata and
  Wikipedia, and both licences. There is a report control, and scheduled re-sync from
  Wikidata propagates upstream deletion, which is the erasure mechanism.

Cameras are the same principle applied to a different feed: official and
owner-consented sources only. Transport for London JamCams under TfL open data terms,
and the Windy webcam directory, which is owner-submitted. Aggregators of unsecured
private cameras are excluded outright.

Before any public deployment: a written legitimate-interests assessment under UK GDPR
Article 6(1)(f), a data protection impact assessment, and a public privacy notice
relying on Article 14(5)(b). Those live in `docs/` and are a phase 6 deliverable.

## 9. Known risks

1. **aisstream.io is beta with no SLA.** The ship layer can stop without notice.
   Mitigated by putting ingest behind a provider interface, so a paid feed or a regional
   open feed slots in without touching consumers.
2. **adsb.lol has no contractual rate limit** and plans API keys earned by feeding data.
   The shared readsb v2 parser makes adsb.fi and ADSBexchange drop-in replacements.
3. **Licence patchwork blocks commercial use.** adsb.fi is non-commercial, the Cesium ion
   community tier is non-commercial and flips to paid past $50k organisation revenue.
4. **CesTrak permanently firewalls abusive clients.** The once-per-two-hour fetch guard
   is enforced in code and asserted in a test, never left to configuration.
5. **The people layer is the reputational exposure.** Any drift towards present-tense
   location flips the GDPR balancing test and enters Protection from Harassment Act
   territory. The property allowlist and the structural separation from live feeds are
   load-bearing and are not relaxed for a feature request.
6. **Frontend performance is the product.** The primitive-collection discipline is not
   optional and cannot be retrofitted.
7. **Multiple uvicorn workers each run lifespan**, duplicating every poller and doubling
   upstream load. Pollers run in a single process until a lock exists.
8. **Windy image tokens expire in ten minutes.** Explicit expiry handling, or images break
   silently.
9. **Military and PIA coverage is incomplete at source.** The UI states that plainly
   rather than implying full coverage.

## 10. Phases

Eight phases, each independently completable and each ending green. Phase 1 is a thin
vertical slice through the entire stack, because the riskiest thing in a project like
this is discovering at phase 6 that the render architecture cannot carry the load.

Detail, deliverables and acceptance criteria per phase: `docs/plan/implementation-plan.md`.
