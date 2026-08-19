# Tracker implementation plan

> **For agentic workers:** each phase has its own detailed task plan under
> `docs/superpowers/plans/`, written immediately before that phase starts.
> Use `superpowers:subagent-driven-development` to execute a phase task-by-task.

**Goal:** a web app that renders an interactive 3D globe and shows real, live public data
on it (aircraft, ships, satellites, cameras, geo-events, imagery, POIs, 3D buildings,
notable public figures) with search, camera fly-to, information cards and
cross-referenced enrichment.

**Architecture:** one FastAPI process owns every upstream feed, validates each payload
against a strict Pydantic contract at the boundary, holds live state in a TTL store, and
fans batched updates out to browsers over a single WebSocket. A Vite + TypeScript
frontend renders with CesiumJS using one primitive collection per layer and in-place
position mutation. Satellites are propagated in the browser from cached orbital elements.

**Tech stack:** Python 3.13, uv, FastAPI, Pydantic v2, httpx, ruff, mypy --strict,
pytest + pytest-asyncio + respx + hypothesis. TypeScript, Vite, CesiumJS, satellite.js,
vitest, Playwright, eslint. GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-08-19-tracker-design.md`

---

## Global constraints

These apply to every task in every phase. No task may violate them.

- **Real data only.** No mock feeds, no sample data, no placeholder entities in the
  running product. Recorded real payloads are used *only* as test fixtures.
- **No placeholders in code.** No `TODO`, no `pass  # later`, no `NotImplementedError`
  left in a shipped path, no `test.skip`, no stub returning a hardcoded value.
- **Python 3.13**, pinned in `.python-version`. `uv.lock` committed. CI uses
  `uv sync --locked` so a stale lockfile fails the build.
- **Every contract is a strict Pydantic model** deriving from `StrictModel`
  (`strict=True, extra="forbid", frozen=True`).
- **Coordinates are `[longitude, latitude]`** in every contract, WGS84 / EPSG:4326,
  degrees. Altitude in metres above the WGS84 ellipsoid.
- **Times are timezone-aware UTC**, ISO 8601 in contracts. A naive datetime is a
  validation error.
- **Never rebuild a Cesium layer per tick.** One primitive collection per layer,
  positions mutated in place.
- **Never call an upstream faster than its documented cadence.** Each poller's cadence
  guard is enforced in code and asserted by a test.
- **No API key reaches the browser.** All keyed feeds are proxied by the backend.
- **Every visible data layer renders its attribution.**
- **Every source added to the app gets a row in `docs/data-sources.md`** in the same
  commit, with a last-verified date. No endpoint is written into that file unverified.
- **`ruff check`, `ruff format --check`, `mypy --strict`, `pytest --cov` (branch,
  `fail_under=85`), `tsc --noEmit`, `eslint`, `vitest` all pass** before a phase is
  called complete.
- **Person data is constrained by the property allowlist** in the spec section 8. That
  allowlist is load-bearing and is never widened.

## File structure

### Backend, `src/tracker/`

| Path | Responsibility |
| --- | --- |
| `app.py` | `create_app()` factory, lifespan wiring, CORS, static mount |
| `config.py` | `Settings` via pydantic-settings, all keys and cadences |
| `contracts/base.py` | `StrictModel`, shared validators, `UtcDatetime` |
| `contracts/geo.py` | `Position`, `BoundingBox`, `Coordinate` |
| `contracts/aircraft.py` | `Aircraft`, `AircraftCategory`, `EmitterFlags` |
| `contracts/vessel.py` | `Vessel`, `VesselStatic`, `VesselType` |
| `contracts/satellite.py` | `SatelliteElement`, `SatelliteGroup` |
| `contracts/event.py` | `GeoEvent`, `EventSource`, `EventSeverity` |
| `contracts/camera.py` | `Camera`, `CameraImage` |
| `contracts/place.py` | `Place`, `PointOfInterest` |
| `contracts/person.py` | `Person`, `PersonPlace`, `PlaceRelation` |
| `contracts/entity.py` | `Entity` discriminated union on `kind` |
| `contracts/messages.py` | WebSocket envelope: `Snapshot`, `Delta`, `Removal`, `FeedStatus` |
| `sources/base.py` | `PollingSource` / `StreamingSource` protocols, `SourceHealth` |
| `sources/adsb.py` | readsb v2 wire models and parser, adsb.lol / adsb.fi / mil |
| `sources/adsbdb.py` | aircraft registry lookup for owner and operator |
| `sources/aisstream.py` | AIS WebSocket client, reconnect and resubscribe |
| `sources/celestrak.py` | OMM/GP fetch with the two-hour guard |
| `sources/usgs.py` `sources/eonet.py` `sources/gdelt.py` | event feeds |
| `sources/windy.py` `sources/tfl.py` | camera inventories and image proxy |
| `sources/overpass.py` `sources/nominatim.py` | OSM POIs and geocoding |
| `sources/wikidata.py` `sources/wikipedia.py` | people and place knowledge |
| `services/store.py` | TTL entity store, change-set emission |
| `services/hub.py` | WebSocket connection registry and batched fan-out |
| `services/poller.py` | generic supervised poller task with jittered backoff |
| `services/registry.py` | enrichment cache keyed by entity identity |
| `services/classify.py` | military and business-jet classification |
| `services/search.py` | in-memory search index across live entities |
| `api/routes_entities.py` | REST snapshots per layer |
| `api/routes_search.py` | unified search |
| `api/routes_ws.py` | the single `/ws` multiplex |
| `api/routes_meta.py` | health, feed status, attribution manifest |

### Frontend, `frontend/src/`

| Path | Responsibility |
| --- | --- |
| `main.ts` | bootstrap, wiring only |
| `globe/viewer.ts` | Cesium viewer construction and render policy |
| `globe/layers/*.ts` | one module per layer, each owning its primitive collection |
| `globe/camera.ts` | `flyTo`, follow mode, reduced-motion handling |
| `net/ws.ts` | WebSocket client, per-frame batching |
| `net/api.ts` | typed REST client over generated types |
| `types/api.d.ts` | generated from the committed OpenAPI schema |
| `ui/search.ts` `ui/card.ts` `ui/layerRail.ts` `ui/attribution.ts` | UI panels |
| `state/store.ts` `state/url.ts` | selection and layer state, URL sync |

### Contract sharing

`scripts/dump_openapi.py` writes `openapi.json` from the app without starting a server.
`pnpm codegen` turns it into `frontend/src/types/api.d.ts` via `openapi-typescript`. CI
regenerates both and fails if they differ from what is committed, so the wire contract
cannot drift between backend and frontend.

---

## Phase 1: vertical slice

**Goal:** prove the whole pipeline end to end with one real feed.

**Deliverables**
- uv project, Python 3.13 pinned, `src/tracker` layout, `uv.lock`, ruff, mypy strict.
- Vite + TypeScript frontend workspace, eslint, vitest.
- Pre-commit hooks and GitHub Actions CI covering backend and frontend.
- `StrictModel` base and the `Aircraft` contract, validated against real adsb.lol
  `/v2/point` responses.
- Lifespan-managed shared `httpx.AsyncClient`; supervised poller; `/api/aircraft`
  snapshot; `/ws` fanning out batched deltas.
- CesiumJS globe on NASA GIBS imagery (no ion token needed), aircraft in a
  `PointPrimitiveCollection` mutated in place, click-to-select opening a docked card
  with live fields and last-fix age.
- `AGENTS.md`, one-line `CLAUDE.md`, `docs/architecture.md`, `docs/data-sources.md`
  seeded with the verified adsb.lol and GIBS rows, `docs/status.md`, ADR 001.

**Sources:** adsb.lol, NASA GIBS.

**Acceptance**
1. `uv run pytest` passes, branch coverage ≥ 85% on the backend; CI green on a clean clone.
2. The app shows real aircraft moving over real imagery within ten seconds, positions
   updating with no page refresh.
3. Clicking an aircraft opens a card with callsign, registration, type, altitude, speed.
4. Stale-data badge logic is proven by a test.
5. `mypy --strict` and `ruff` clean. No placeholder data anywhere.
6. The feed parser is hypothesis-tested and tested against recorded real payloads.
7. ODbL attribution for adsb.lol is visible on screen.

## Phase 2: ships and satellites

**Goal:** add the other two core moving-asset classes.

**Deliverables**
- aisstream.io WebSocket ingest with auto-reconnect and resubscribe; `Vessel` contract
  joining `PositionReport` to `ShipStaticData` on MMSI; viewport bounding-box
  subscription driven by camera idle.
- CelesTrak poller on a four-to-six hour cadence caching OMM JSON by NORAD ID;
  `/api/satellites/elements` serving the cache.
- Frontend satellite layer: `satellite.js` SGP4 in a Web Worker, TEME to ECEF via GMST,
  guard against decayed element sets, orbit trail for the selected satellite.
- Layer rail with per-layer toggles and live entity counts; ship and satellite cards.

**Sources:** aisstream.io, CelesTrak, adsb.lol.

**Acceptance**
1. Ships appear in a coastal viewport within 30 seconds of panning there, with name,
   type, speed and heading on the card.
2. The ISS (NORAD 25544) renders within visual tolerance of its published position and
   moves smoothly at 60fps with 1,000+ satellites loaded.
3. Killing the aisstream connection triggers reconnect and resubscribe within 15
   seconds, covered by a test.
4. CelesTrak is fetched at most once per group per two-hour window, asserted by a test.
5. All three feeds hold 30fps or better with 5,000 combined live entities.

## Phase 3: military, private jets, cross-referencing

**Goal:** classify and enrich, and build the enrichment machinery every later layer reuses.

**Deliverables**
- Military layer from adsb.lol `/v2/mil` with automatic failover to adsb.fi `/v2/mil`
  through the same parser; `dbFlags` bit 1 classification.
- Business-jet classifier: type-designator allowlist on the `t` field, then cached
  adsbdb owner and operator lookup separating charter operators from private owners.
  PIA aircraft (`dbFlags` bit 4) are shown as anonymised by design and never unmasked.
- Cross-reference service: one enrichment interface keyed on entity identity
  (hex, MMSI, NORAD ID) merging feed data with registry metadata, per-source cache TTLs.
- Enriched cards: owner, operator, country, aircraft photo where adsbdb provides one.

**Sources:** adsb.lol, adsb.fi, adsbdb.

**Acceptance**
1. The military toggle shows live military aircraft with visual distinction; failover to
   adsb.fi is proven by a test that kills the primary.
2. A live business jet is classified and its registered owner shown from a real adsbdb
   response.
3. adsbdb lookups are cached; no repeat call for the same hex within a session, asserted.
4. Enrichment failure degrades the card to feed data with "registry unavailable", never
   an error state.
5. The classifier is unit-tested against recorded real payloads covering military,
   business jet, airline and PIA cases.

## Phase 4: search, fly-to, place geocoding

**Goal:** one search box that finds anything on the globe, plus places.

**Deliverables**
- `/api/search`: fuzzy match across live entity indices (callsign, registration, hex,
  MMSI, ship name, satellite name, NORAD ID) plus Nominatim place geocoding with a
  server-side cache and a one-request-per-second throttle.
- Persistent search box, `Ctrl+K` and `/` focus, results grouped by asset type, `Enter`
  flies the camera (eased, reduced-motion aware) and opens the card.
- Follow mode: camera locks to the selected entity, broken by any manual camera input.
- Keyboard shortcuts (`Esc` deselect, `F` follow, `+`/`-` zoom, `?` overlay) and URL
  state for camera and layers so views are shareable.

**Sources:** Nominatim, plus all live feeds.

**Acceptance**
1. Typing a live callsign, an MMSI or "ISS" returns the entity in under 300ms from local
   indices, and `Enter` lands the camera on it with the card open.
2. Searching "Rotterdam" flies to the port; Nominatim is called at most once per unique
   query thanks to the cache, asserted by a test.
3. Follow mode tracks a moving aircraft and disengages on user drag.
4. Copying the URL and opening it in a fresh tab reproduces camera position and layers.
5. `prefers-reduced-motion` skips the fly-to animation, verified in Playwright.

## Phase 5: geo-events and public cameras

**Goal:** the "what is happening here" layers.

**Deliverables**
- Unified `GeoEvent` contract (source, timestamp, point, title, url, licence) with
  pollers: USGS every two minutes, EONET hourly, GDELT every fifteen minutes with 429
  backoff.
- Camera layer: Windy Webcams v3 by viewport bounding box plus a TfL JamCams inventory
  refreshed daily; camera card shows the still or video proxied through the backend with
  a short cache.
- Event styling: magnitude-scaled earthquake markers, EONET category icons, GDELT
  density labelled "news coverage locations".
- Attribution updated for GDELT, USGS, NASA EONET, TfL ("Powered by TfL Open Data"),
  Windy.

**Sources:** USGS, NASA EONET, GDELT GEO 2.0, Windy Webcams, TfL JamCams.

**Acceptance**
1. A real earthquake from the last hour renders within one poll cycle with magnitude,
   depth and the USGS link on its card.
2. A London viewport shows JamCams whose stills refresh and whose availability flag is
   respected. No frozen JPEG is ever presented as live.
3. Windy image URLs are fetched fresh, respecting the ten-minute token expiry, never
   cached beyond validity, asserted by a test.
4. The GDELT layer is visibly labelled as coverage geography and has no code path that
   accepts a person name as input.
5. Each poller honours its cadence under test.

## Phase 6: people knowledge layer

**Goal:** search notable public figures and organisations and fly to their static public
association places, scoped so private-individual tracking is impossible by construction.

**Deliverables**
- Search via `wbsearchentities` filtered to entities holding a Wikipedia sitelink;
  server-side SPARQL hydration restricted to the property allowlist (P19, P20, P159,
  P937, P69, P7153 resolved via P625), excluding P551 and raw coordinates on living
  humans, cached with scheduled re-sync.
- Person card: Wikipedia REST summary (image, extract, article link),
  relationship-labelled pins ("Born in Ulm"), provenance and licence lines
  (Wikidata CC0, Wikipedia CC BY-SA 4.0), report control.
- Rate limiting on repeated same-name searches with abuse-monitoring logs only. No
  per-person history view exists.
- Privacy notice page, written legitimate-interests assessment and DPIA under `docs/`.

**Sources:** Wikidata, Wikipedia REST.

**Acceptance**
1. Searching a Wikipedia-notable figure returns allowlisted place pins, each labelled
   with its relationship. Searching a random private name returns no map result.
2. A test proves P551 and living-human raw coordinates can never reach the renderer even
   if present in a SPARQL response.
3. No person card shows a timestamp, a current location or any live-feed data. Person
   search and GDELT share no code path, asserted structurally by a test.
4. Upstream Wikidata deletion propagates on the next sync, covered by a test.
5. WDQS etiquette enforced: descriptive User-Agent, server-side caching, no SPARQL per
   keystroke.

## Phase 7: imagery, POIs, 3D buildings

**Goal:** depth for the globe itself.

**Deliverables**
- Imagery picker: GIBS daily true-colour wired to the timeline date, EOX Sentinel-2
  cloudless as a static base option, defaulting to yesterday's GIBS layer.
- Cesium OSM Buildings via an ion token, loaded past a zoom threshold with tuned
  `maximumScreenSpaceError` and a tile cache cap.
- POI layer: backend Overpass queries by tile with a persistent cache, category-filtered
  (airports, ports, stations, landmarks), POI cards with OSM attribution.
- Wikipedia geosearch "nearby" panel for the current view.

**Sources:** NASA GIBS, EOX Sentinel-2 cloudless, Cesium ion OSM Buildings, Overpass,
Wikipedia geosearch.

**Acceptance**
1. Scrubbing the timeline date swaps GIBS imagery to that day's tiles.
2. Zooming into London streams 3D buildings without dropping below 30fps, with screen
   space error tunable in settings.
3. Overpass is never called from the browser, and repeated views of the same tile hit the
   backend cache, asserted by a test.
4. All attributions render: GIBS acknowledgement, EOX CC-BY, OSM contributors, Cesium ion.
5. The app still works with the buildings layer off and no ion token configured.

## Phase 8: scale, replay, polish

**Goal:** hold frame rate at full load, add history replay, finish accessibility.

**Deliverables**
- Performance pass: all feed parsing in Web Workers with transferable typed arrays,
  batched per-frame updates, clustering at low zoom, `distanceDisplayCondition` LOD
  tiers, `requestRenderMode` audit, optional high-DPI toggle.
- Track history: backend retains a rolling window of positions per entity; timeline
  scrubbing replays recorded tracks via `SampledPositionProperty`; satellite replay via
  clock multiplier.
- Accessibility completion: entity list panel as the canvas alternative, focus
  management, contrast audit, shortcut overlay, reduced-motion coverage.
- Ops polish: per-layer loading counts rather than a global spinner, per-source
  stale-feed banners, dark theme consistency pass, Playwright suite covering search,
  fly-to, cards, replay and layer toggles.

**Acceptance**
1. 30fps or better with 20,000 combined live entities and all layers on, measured and
   recorded in `docs/status.md`.
2. Scrubbing 30 minutes back replays real recorded aircraft and ship tracks; a LIVE
   button snaps back to now.
3. Playwright suite green in CI including a WebGL smoke test; axe-core reports no
   critical violations on the UI shell.
4. A hidden tab means zero render loop activity; idle scene GPU usage near zero.
5. Every feed shows a visible degraded-state banner within twice its poll interval when
   its upstream is down, covered by a test.
