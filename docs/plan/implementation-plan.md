# Tracker implementation plan

> **For agentic workers:** each phase has its own detailed task plan under
> `docs/superpowers/plans/`, written immediately before that phase starts.
> Use `superpowers:subagent-driven-development` to execute a phase task-by-task.

**Goal:** an interactive 3D globe showing real public data live (aircraft, ships,
satellites, cities, organisations, public figures, geolocated social posts, plus cameras,
geo-events, imagery and 3D buildings), with free-text search across people, organisations,
assets and places, and cross-referenced enrichment linking a profile to the assets it
owns.

**Context:** this is a demo of profile enrichment for Altrata. The business sells wealth
and executive intelligence: data collected on people and organisations, resolved to one
profile, joined up, and sold to private banks, wealth managers, advancement teams and
fundraisers. The population is the wealth tiers, UHNW over $30m, VHNW $5m to $30m, HNW
over $1m, with Likely UHNW and Likely VHNW covering partial valuations. Altrata already
licenses global private aircraft ownership (JetNet), luxury vehicle ownership, US real
estate (CoreLogic) and profiles on 100M+ individuals. This project rebuilds that join from
**public sources only**, shaped to Altrata's real data model, so it can be demoed without
touching licensed data or production systems. Full framing in
`docs/business-context.md`.

**Architecture:** one FastAPI process owns every upstream feed, validates each payload
against a strict Pydantic contract at the boundary, holds live state in a TTL store, and
fans batched updates out to browsers over a single WebSocket. A Vite + TypeScript
frontend renders with CesiumJS using one primitive collection per layer and in-place
position mutation. Satellites are propagated in the browser from cached orbital elements.

**Tech stack:** Python 3.13, uv, FastAPI, Pydantic v2, httpx, ruff, ty, mypy --strict,
pytest + respx + hypothesis. TypeScript, Vite, CesiumJS, satellite.js, vitest, Playwright.
GitHub Actions CI.

**Spec:** `docs/superpowers/specs/2026-08-19-tracker-design.md`

## Entity classes

Everything the globe can put a pin on. Seven classes, each with its own contract module,
its own layer and its own phase. Nothing renders that is not on this list.

| Class | Contract | Position comes from | Moves? | Phase |
| --- | --- | --- | --- | --- |
| Aircraft | `contracts/aircraft.py` | ADS-B transponder position in the feed | Yes, live | 1 (done) |
| Vessel | `contracts/vessel.py` | AIS position report | Yes, live | 2 |
| Satellite | `contracts/satellite.py` | SGP4 propagation of cached orbital elements, in the browser | Yes, computed | 2 |
| City | `contracts/city.py` | GeoNames coordinates for the populated place | No | 4 |
| Organisation | `contracts/organisation.py` | Registered or headquarters site, one pin per site | No | 6 |
| Person | `contracts/person.py` | Dated location attributes and owned assets. Never a live position | No | 6 |
| Social post | `contracts/post.py` | Either an upstream coordinate or a location derived from the text, and the two are different things the card states plainly | No, a post is a fixed event in time | 8 |

Any of these may be joined to any other. **There is no prohibited join**, live position
feeds included, and no structural test asserting a separation. ADR 007 took that firewall
out and named what replaces it.

What every join carries instead, asserted by tests:

**A source, a confidence and an as-of date**, rendered on the card. A join below the
confidence threshold is displayed as a possible match with its score and is excluded from
every aggregate count.

**An inference labelled as an inference.** An owned aircraft being airborne is a fact about
the aircraft. "The owner is aboard" is an inference, and the product says which it is
saying.

**No fabricated precision.** A city-level match stays city-level. A location derived from
text says derived and shows the phrase it matched. Person locations are dated attributes
with provenance per ADR 006, and a join to a live feed produces a dated entry like any
other with the feed named as its source.

---

## Global constraints

These apply to every task in every phase.

- **Real data only.** No mock feeds, no sample data, no placeholder entities in the
  running product. Recorded real payloads are used *only* as test fixtures.
- **No placeholders in code.** No `TODO`, no `pass  # later`, no stub returning a
  hardcoded value, no skipped tests.
- **No human verification, anywhere.** This is a proof of concept and a demo. No reviewer,
  no review queue, no QA step, no pending-approval state, no accept/reject screen. Nothing
  may be designed on the assumption a person will check it. The machine carries it: strict
  contracts, unmappable records dropped and counted, confidence thresholds asserting no
  link below the bar, unconfirmed matches labelled and excluded from aggregates, provenance
  on every card. See `docs/business-context.md`.
- **Python 3.13**, pinned. `uv.lock` committed. CI uses `uv sync --locked`.
- **Every contract is a strict Pydantic model** deriving from `StrictModel`
  (`strict=True, extra="forbid", frozen=True`). Upstream payloads get permissive
  `WireModel` shapes inside the source adapter, never in the domain.
- **Coordinates are `[longitude, latitude]`**, WGS84, degrees. Altitude in metres.
- **Times are timezone-aware UTC.** A naive datetime is a validation error.
- **Never rebuild a Cesium layer per tick.** One primitive collection per layer.
- **Never call an upstream faster than its documented cadence.** Enforced in code and
  asserted by a test, not left to configuration.
- **No API key reaches the browser**, except the Cesium ion token, which is a
  client-side token by design.
- **Every visible data layer renders its attribution.**
- **Every source gets a row in `docs/data-sources.md`** in the same commit, with a
  last-verified date. No endpoint is written there unverified.
- **`ruff`, `ty`, `mypy --strict`, `pytest` (branch coverage ≥ 85%), and the full
  frontend gate all pass** before a phase is complete.

### Person data: what a join has to carry

The product joins a person to everything else that is known about them, live feeds
included. ADR 007 removed the firewall that used to sit here and this section is what
replaces it. Every rule below is a schema and UI constraint, not a policy note, and each is
asserted by a test.

- A person or organisation resolves to the **assets linked to them**, to social posts, to
  events and to any other entity class. The globe flies to the join. Every link states its
  source, its confidence and its as-of date on the card.
- A profile carries **location as a dated attribute**: residence city or region, business
  or registered address from a public record, work and education location, and publicly
  reported appearances that resolve to a place. Every entry states its date and its
  source, and an entry produced by joining sources is labelled derived rather than
  reported. Location is a dated series, not a single current value. An undated location
  fails the contract and is dropped at the adapter and counted. See ADR 006.
- **A join to a live feed is permitted and produces a dated entry like any other**, with
  the feed named as its source and the observation time as its date. What it may not do is
  present an inference as an observation: an owned jet being airborne is a fact about the
  aircraft, "the owner is aboard" is an inference, and the card says which one it is making
  and what it rests on.
- **A join below the confidence threshold is never asserted.** It shows as a possible match
  with its score and is excluded from every aggregate count. This is the only thing standing
  between a demo and a false statement about a named person, so it is not tuned down for a
  better-looking demo.
- A **wealth tier** is carried on the profile, one per profile, higher tier winning where
  two apply. It is never inferred from an asset, a position or a track. The tiers are the
  business vocabulary and the exact terms are in `docs/business-context.md`.
- Where an owner has opted out via **FAA LADD** or is broadcasting a **privacy ICAO
  address**, the asset renders as **suppressed with the reason**. Suppression is a
  demoed feature, not a gap.
- **A removal request removes and suppresses the record.** Suppression is keyed
  independently of ingest so the next crawl does not resurrect it, and it is visible in the
  product with its reason. Same mechanism as LADD suppression above.
- Owner **addresses** from the FAA registry are not ingested. The join needs the owner
  *name*; the address is personal data we have no use for, so it is dropped at the
  adapter. That is data minimisation, which Altrata's own privacy standard calls for.

---

## Chosen sources

Verified live on 2026-08-19 unless marked otherwise. Full detail in
`docs/data-sources.md`.

| Data class | Source | Auth | Phase |
| --- | --- | --- | --- |
| Aircraft live | adsb.lol, failover adsb.fi | none | 1 (done) |
| Aircraft live (optional) | ADSBExchange | paid key | 3 |
| Aircraft ownership | FAA Releasable Aircraft Database | none | 5 |
| Aircraft ownership (lookup) | adsbdb | none | 3 |
| Vessels live | Fintraffic Digitraffic; aisstream.io for global | none / free key | 2 |
| Vessel registry | ITU MARS | none | 5 |
| Satellites | CelesTrak GP + supplemental | none | 2 |
| Basemap imagery | NASA GIBS WMTS | none | 1 (done) |
| On-demand imagery | Terrascope WMTS (VITO) | none | 7 |
| Companies and officers | SEC EDGAR, Companies House | none / free key | 6 |
| Political donations | FEC OpenFEC | free key | 6 |
| Nonprofits and foundations | ProPublica Nonprofit Explorer | none | 6 |
| Places and POIs | Nominatim, Overpass | none | 4, 7 |
| Cities | GeoNames `cities15000` bulk file | none | 4 |
| People and organisations (static places) | Wikidata WDQS, Wikipedia REST | none | 6 |
| Social posts (text) | Mastodon public timelines, OpenStreetMap notes | none | 8 |
| Social posts (image) | Wikimedia Commons geosearch, Flickr `has_geo` | none / free key | 8 |
| Geo events | USGS, NASA EONET, GDELT | none | 8 |
| Cameras | TfL JamCams, US 511, Windy | none / free key | 8 |
| Reference media | Wikimedia Commons geosearch | none | 8 |

### On the four sources you named

- **globe.adsbexchange.com** serves the identical readsb `/v2` schema, so it is a
  drop-in third provider needing no parser work. Two caveats. It has no free tier: the
  cheapest self-serve plan is $10/month for 10,000 requests, which continuous polling
  exhausts in about a day. And its terms prohibit publishing or redistributing the data,
  so serving it to end users needs written permission. It is therefore wired as an
  **optional, user-supplied-key provider**, with adsb.lol remaining the default.
  Worth knowing: **ADSBExchange has been owned by JETNET since 2023**, and Altrata
  already licenses JetNet aircraft ownership data, so a commercial route may already
  exist internally. Never scrape the globe map itself; its tile endpoints return 403 and
  scraping is explicitly prohibited.
- **open-ais.org** turns out to publish **no data feed at all**. It is open-source
  software for storing and serving AIS you have collected yourself. The live vessel data
  therefore comes from **Fintraffic Digitraffic**, which is better for our purposes:
  keyless, no registration, and CC BY 4.0 which explicitly permits commercial use.
  Global coverage comes from aisstream.io on a free key, with Norwegian Kystverket's
  raw NMEA stream as a third option.
- **terrascope.be** works and is keyless. One verified trap: the RESTful tile templates
  advertised in its own capabilities document return HTTP 400, so it must be consumed in
  key-value form, which is what Cesium's `WebMapTileServiceImageryProvider` does by
  default. The tile matrix set is the literal string `EPSG:3857`.
- **platform.leolabs.space** is entirely commercial, in the region of $2,500 per month
  per satellite, and its licence would not permit re-serving positions to browsers.
  Satellite positions come from **CelesTrak** instead, propagated client-side.

---

## Phase 1: vertical slice — COMPLETE

Repo scaffold, strict contracts, live aircraft from adsb.lol with failover, CesiumJS
globe on NASA GIBS imagery, docked info card, WebSocket fan-out, CI, docs.

**Proven:** 469 backend tests at 98.9% branch coverage, 51 frontend tests, ruff and
`mypy --strict` clean, the globe renders several hundred real aircraft over real imagery
and updates without refresh, and provider failover works against both live providers.

## Phase 2: ships and satellites

**Goal:** the other two moving-asset classes, live.

**Deliverables**
- Fintraffic Digitraffic vessel ingest (keyless, CC BY 4.0) plus aisstream.io WebSocket
  for global coverage behind the same provider interface; `Vessel` contract joining
  position reports to static data on MMSI.
- CelesTrak poller on a four-to-six hour cadence with the two-hour floor enforced in
  code; `/api/satellites/elements` serving cached OMM.
- Frontend satellite layer: `satellite.js` SGP4 in a Web Worker, TEME to ECEF via GMST,
  decayed-element guard, orbit trail for the selection.
- Layer rail with per-layer toggles and live counts; vessel and satellite cards.

**Acceptance**
1. Ships appear in a coastal viewport within 30 seconds, with name, type, speed, flag.
2. The ISS renders within visual tolerance of its published position and 1,000+
   satellites hold 60fps.
3. Killing the AIS connection reconnects and resubscribes within 15 seconds, tested.
4. CelesTrak is fetched at most once per group per two hours, asserted by a test.
5. 5,000 combined live entities hold 30fps or better.

## Phase 3: classification and registry enrichment

**Goal:** classify aircraft and attach ownership, building the enrichment machinery every
later layer reuses.

**Deliverables**
- Military layer from `/v2/mil` with failover; business-jet classification by ICAO type
  designator; PIA and LADD aircraft rendered as suppressed with the reason.
- adsbdb lookup keyed on hex or registration, giving owner, operator, type and photo,
  cached per entity with a TTL.
- ADSBExchange wired as an optional provider behind a user-supplied key, with its licence
  constraint recorded in config and docs.
- Enrichment service: one interface keyed on entity identity, merging feed data with
  registry metadata. Failure degrades the card to feed-only data, never an error state.

**Acceptance**
1. A live business jet is classified and shows its registered owner from a real response.
2. A PIA aircraft renders as suppressed and no code path attempts to resolve it.
3. Registry lookups are cached; no repeat call for the same hex in a session, asserted.
4. Failover is proven by a test that kills the primary provider.

## Phase 4: cities, free-text search and fly-to

**Goal:** the city layer, and one search box that resolves anything, with the camera
flying to it.

**Deliverables**
- **City layer** from the GeoNames `cities15000` bulk file: roughly 26,000 populated
  places above 15,000 people, with name, country, admin division, population and
  timezone. A weekly download into a local index, not a poller, because cities do not
  move. `City` contract keyed on the GeoNames ID. Rendered as labels in a
  `LabelCollection` with population-banded `distanceDisplayCondition` tiers, so a world
  view shows capitals and a city view shows towns. This is also the layer that makes an
  empty ocean view legible, so it ships before search rather than after.
- `/api/search` resolving, in one query: aircraft (callsign, registration, hex), vessels
  (name, MMSI, IMO), satellites (name, NORAD ID), cities (name and country, from the
  local GeoNames index, ranked by population so "London" means the English one), other
  places (Nominatim, cached and throttled), and later phases' organisations and profiles.
  Results grouped by type and ranked, served from in-memory indices for live entities.
  The city index is what keeps Nominatim off the hot path: a city hit never leaves the
  process.
- Search box with `Ctrl+K` and `/` focus, grouped typeahead, `Enter` to fly and open the
  card, reduced-motion aware.
- Follow mode locking the camera to a moving entity, broken by manual camera input.
- Keyboard shortcuts and URL state for camera and layers, so any view is shareable.

**Acceptance**
1. A live callsign, an MMSI or "ISS" resolves in under 300ms from local indices.
2. "Rotterdam" flies to the port; Nominatim is called at most once per unique query.
3. "London" resolves from the local GeoNames index with **zero network calls**, returns
   the United Kingdom city first, and offers London, Ontario below it. Asserted by a test
   that fails if any HTTP client is touched.
4. City labels are readable at country zoom and do not overdraw at street zoom, with the
   whole 26,000-row layer costing nothing when it is toggled off.
5. Follow mode tracks a moving aircraft and disengages on drag.
6. Copying the URL into a fresh tab reproduces camera and layers.

## Phase 5: asset ownership spine

**Goal:** the ownership dataset that makes profile enrichment possible.

**Deliverables**
- FAA Releasable Aircraft Database ingest: nightly download, `MASTER.txt` keyed on the
  **Mode S hex code column**, which joins directly to ADS-B with no derivation, left
  joined to `ACFTREF.txt` for make and model. Roughly 316,000 US aircraft, public domain.
  Owner **name** and type only; owner addresses are dropped at the adapter.
- Canadian CCARCS and Australian CASA registers as secondary registries, both carrying
  Mode S codes.
- ITU MARS vessel registry lookup from MMSI to name, flag and tonnage.
- `AssetOwnership` contract linking an owner (person or organisation) to an asset, with
  the source, the confidence and the as-of date on every link.

**Acceptance**
1. A live aircraft in view resolves to its FAA-registered owner with no network call at
   request time (the registry is local).
2. No owner address is present anywhere in the store, the API or the database, asserted
   by a test that scans the contract fields.
3. LADD-suppressed and PIA aircraft are excluded from ownership resolution by design.

## Phase 6: profiles, organisations and the join

**Goal:** the enrichment demo. Search a name, get the profile and its linked assets.

**Deliverables**
- `Profile` and `Organisation` contracts shaped to Altrata's unified model: persistent
  IDs, employment and board history, education, philanthropy, and a **wealth tier**. The
  tier is an enum with exactly the business values (Confirmed UHNW, Likely UHNW, Confirmed
  VHNW, Likely VHNW, HNW), one per profile, higher tier winning where two apply, matching
  how the platform derives it from the Wealth-X dossier category. Definitions and
  thresholds in `docs/business-context.md`. A public source that does not support a tier
  leaves it unset; no tier is estimated from an asset.
- Public profile sources: SEC EDGAR (officers, directors, insider holdings from Form 4
  and DEF 14A), Companies House (officers and persons with significant control), FEC
  Schedule A (donor name, employer, occupation), ProPublica Nonprofit Explorer
  (trustees, foundation assets).
- **Entity resolution** joining an FAA owner name to a profile or organisation. Fuzzy by
  necessity, so: blocked candidate generation, scored matching, and a confidence
  threshold below which **no link is asserted**. Low-confidence candidates are shown as
  "possible match" with the score, never merged. Altrata's own Jira documents chimera
  profiles (attributes of several people wrongly merged) as a live production problem,
  so this is deliberately conservative.
- **Organisation locations.** One pin per site, from Wikidata `P159` (headquarters
  location) and the Companies House registered office, snapped to the phase 4 city index
  for the label. An organisation with three offices draws three pins, each with the source
  and the as-of date on it. A registered office is a public filing about a company, which
  is why it is in and a person's address is not.
- **Person locations.** Static public associations only: place of birth, place of death,
  place of education, place of work. Each pin states the relationship in words ("Born in
  Ulm, per Wikidata") with a link to the source and a report control beside it. ADR 004
  lifted ADR 002's seven-property allowlist and permits scraped and crowd-sourced person
  data, and ADR 006 makes location a dated profile attribute, so the constraint is now the
  tense rather than the source: a dated public association or residence can produce a pin,
  a present-tense whereabouts cannot, whatever the source. Every other pin a person gets comes from an asset they own, and that
  pin is the asset's position, labelled as the asset.
- Profile card: identity, wealth tier, roles, linked assets with live status, dated
  location entries with derived ones labelled as such, and a provenance line per fact
  naming its source and date.
- **The US privacy position**, per ADR 006: which state laws reach the population, how
  access and deletion requests are served inside the statutory windows, and whether data
  broker registration applies. Replaces the UK GDPR paperwork previously listed here, which
  was the wrong instrument for a US population and US customers. Still a blocker on any
  public deployment carrying real profiles.
- **Removal and suppression**, per ADR 006: a removal request drops the record and keeps a
  suppression key that survives re-ingest, shown in the product with its reason.

**Acceptance**
1. Searching an organisation returns its registered aircraft, and the globe flies to one
   that is currently airborne.
2. Every asset-to-owner link displays its confidence and its source.
3. A link below the confidence threshold is displayed as unconfirmed and is excluded
   from any aggregate count, asserted by a test.
4. A profile joined to a live feed shows the join with the feed as its source and the
   observation time as its date, and any inference drawn from it is labelled as an
   inference. Asserted by a test, per ADR 007.
5. Every location entry on a profile carries a date. An undated one is dropped at the
   adapter and counted, asserted by a test.

## Phase 7: imagery, POIs and 3D buildings

**Goal:** depth for the globe itself.

**Deliverables**
- Imagery picker: NASA GIBS daily true colour wired to the timeline date, Terrascope
  WMTS layers (key-value form, `EPSG:3857` matrix set), EOX Sentinel-2 cloudless as a
  static option.
- Cesium OSM Buildings past a zoom threshold, with tuned screen-space error, degrading
  cleanly when no ion token is configured.
- Overpass POI layer by tile with a persistent backend cache, category filtered.
- Wikipedia geosearch "nearby" panel for the current view.

**Acceptance**
1. Scrubbing the timeline date swaps imagery to that day's tiles.
2. London streams 3D buildings without dropping below 30fps.
3. Overpass is never called from the browser and repeat views hit the cache, asserted.
4. Every attribution renders. The app works fully with no ion token.

## Phase 8: events, social posts, cameras and pattern intelligence

**Goal:** context layers, and the aggregate signal that is the commercial story.

**Deliverables**
- **Social post layer.** One `SocialPost` contract covering text and image posts, with a
  `location_basis` field that is the point of the whole layer: `upstream` where the source
  gave us a coordinate, `derived` where we resolved it from the words. Sources, all
  server-side and cached: OpenStreetMap notes (crowd-sourced text at a real coordinate,
  keyless, `upstream`), Wikimedia Commons geosearch (images with coordinates and a
  per-file licence, `upstream`), Mastodon public timelines (text and attached media, no
  coordinate in the payload at all, so `derived` by gazetteer match against the phase 4
  city index, never a general geocode per post), and Flickr `has_geo` on a free key with a
  licence filter (`upstream`). Media is proxied and cached, never hot-linked, and an image
  without a determinable licence is dropped rather than shown.
- **The rules the layer ships with**, each asserted by a test: a `derived` post renders as
  "location mentioned in the text" with the phrase it matched, and is never presented as an
  observed position; a post is a fixed event with a timestamp, so two posts by one handle
  are never drawn as a path; and a post joined to a person or organisation record carries
  the join's source, confidence and date like any other join. Joining is permitted, per
  ADR 007. Full reasoning on the derived-versus-upstream split in ADR 005.
- Unified `GeoEvent` contract with pollers: USGS every two minutes, EONET hourly, GDELT
  every fifteen minutes with backoff. GDELT is labelled "news coverage location".
- Camera layer from TfL JamCams and US 511 programmes (both keyless and
  coordinate-complete) plus Windy on a free key, images proxied and cached, availability
  flags respected so no frozen frame is presented as live.
- Wikimedia Commons geosearch for reference imagery of a location.
- **Pattern intelligence**: rolling track history per asset, frequented airfields and
  marinas, wealth-hub corridors, and event-window correlation such as inbound traffic to
  a hub during a known event. Aggregated across assets, never pinpointing a person.

**Acceptance**
1. A real earthquake from the last hour renders within one poll cycle.
2. London cameras refresh and unavailable cameras are marked, not frozen.
3. Each poller honours its documented cadence under test.
4. A portfolio of assets produces a corridor ranking from real recorded tracks.
5. A real OpenStreetMap note and a real Commons image both render with their own
   attribution, and a Mastodon post from a real public timeline renders with
   `location_basis: derived` and the words "location mentioned in the text" on the card.
6. A post joined to a profile displays the join's source, confidence and date, and a
   sub-threshold join shows as a possible match and is absent from every count. Asserted by
   a test.
7. An image record with no determinable licence is dropped and counted, asserted against a
   recorded payload.
8. A Mastodon instance answering 401, 403 or 422 is dropped for the cycle and the feed
   stays healthy, asserted. `mastodon.social` already behaves this way.

## Phase 9: scale, replay and polish

**Goal:** hold frame rate at full load, add replay, finish accessibility.

**Deliverables**
- Feed parsing in Web Workers with transferable typed arrays, clustering at low zoom,
  level-of-detail tiers, `requestRenderMode` audit.
- Track replay via the timeline, with a LIVE snap-back.
- Accessibility completion: entity list as the canvas alternative, focus management,
  contrast audit, shortcut overlay, reduced-motion coverage, axe-core in CI.
- Per-source degraded banners, and a Playwright suite covering search, fly-to, cards,
  replay and layer toggles.

**Acceptance**
1. 30fps or better with 20,000 combined live entities, measured and recorded.
2. Scrubbing back replays real recorded tracks.
3. Playwright green in CI including a WebGL smoke test; no critical axe violations.
4. A hidden tab does zero render work.
5. Every feed shows a degraded banner within twice its poll interval when upstream is
   down, covered by a test.
