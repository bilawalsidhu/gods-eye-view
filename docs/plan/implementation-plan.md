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

**What it is actually proving:** recency. Customers buy profile data and profile enrichment,
and they already get the fields. What they do not get is the fields being current. The
production pipelines run on weekly scans, filing cycles and vendor deliveries, with an
18-month validation window on a leadership fact. This project puts data that is seconds old
against the same profile in the same schema. Per-attribute ages, a staleness delta against
the incumbent value, a change feed and an enrichment API are the deliverable, and phase 10
builds them. The globe is how you see it, not the point of it.

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
| Person | `contracts/person.py` | Dated location attributes, owned assets, and joins to any other class including live feeds | No | 6 |
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
- **Every enriched attribute carries the set of sources supporting it and is scored on
  independent corroboration**, per ADR 011. One scraped or crowd-sourced source never
  crosses the assertion threshold alone; it shows as unconfirmed with its score and counts
  towards nothing. Independence is judged at the origin, so two aggregators carrying the
  same wire story are one source, and where independence cannot be shown it is treated as
  absent. Corroboration raises confidence and never raises precision: three sources saying
  London is still a city. Two dated values that disagree both stay on the profile with the
  disagreement shown, rather than one silently overwriting the other.
- **Location evidence comes from three enrichment paths, all dated, sourced and
  corroborated.** A social post's own coordinate where the source gave one, a location
  resolved from a post's words against the city gazetteer and labelled derived (ADR 005),
  and a **person mentioned in a news or online report that resolves to a place**, which is
  a report about a person rather than an observation of one and is labelled derived at
  city level with the article as its source and its publication date as its date.
- A profile carries **location as a dated attribute**: residence city or region, postal
  addresses including home addresses, work and education location, and publicly reported
  appearances that resolve to a place. Every entry states its date and its
  source, and an entry produced by joining sources is labelled derived rather than
  reported. Location is a dated series, not a single current value. An undated location
  fails the contract and is dropped at the adapter and counted. See ADR 006 and ADR 008.
- A profile carries **contact and identity attributes**, per ADR 008: personal and business
  email, personal and business phone, postal addresses, social handles including LinkedIn,
  and the identity fields the business resolves on (name and alternate names, date of birth,
  age, gender, nationality, deceased date, hometown). Same rules as location: a date, a
  source, dropped and counted if undated, labelled derived if produced by a join. These are
  match keys before they are display fields and the entity resolution below uses them.
- **Contact attributes are marked PII in the contract** so the API and the card can serve a
  profile with them suppressed, mirroring the `NoContactData` and `NoPII` packages the
  business sells. A demo feature, asserted by a test.
- **Public sources fill few of these fields and nothing fills the rest.** This project buys
  no vendor data, so an unfilled contact field stays unset. No default, no approximation, no
  inferred value.
- **A join to a live feed is permitted and produces a dated entry like any other**, with
  the feed named as its source and the observation time as its date. What it may not do is
  present an inference as an observation: an owned jet being airborne is a fact about the
  aircraft, "the owner is aboard" is an inference, and the card says which one it is making
  and what it rests on. **That inference is now built, in phase 12**, per ADR 012: an
  occupancy estimate over ownership, recorded route history, the live track, the associate
  graph and each candidate's dated locations elsewhere. It is labelled an inference, it
  names nobody below the threshold, a corroborated location elsewhere in the window removes
  a candidate outright, and it never writes a location entry onto a profile.
- **A join below the confidence threshold is never asserted.** It shows as a possible match
  with its score and is excluded from every aggregate count. This is the only thing standing
  between a demo and a false statement about a named person, so it is not tuned down for a
  better-looking demo.
- A **wealth tier** is carried on the profile, one per profile, higher tier winning where
  two apply. It is never inferred from an asset, a position or a track. The tiers are the
  business vocabulary and the exact terms are in `docs/business-context.md`.
- ~~Where an owner has opted out via **FAA LADD** or is broadcasting a **privacy ICAO
  address**, the asset renders as suppressed with the reason.~~ **Reversed by ADR 009.**
  LADD-suppressed aircraft are resolved and displayed like any other, in phase 3. Privacy
  ICAO addresses are correlated back to a registration in phase 11. Both are opt-outs the
  product now works through rather than around, and ADR 009 carries the legal position and
  the exposure that comes with that.
- **A removal request removes and suppresses the record.** Removal deletes the record and
  its identifiers. Suppression is keyed independently of ingest so the next crawl does not
  resurrect it, holds no more personal data than the flag needs, and is visible in the
  product with its reason. Same mechanism as LADD suppression above. There is no queue and
  no human step here, so it takes effect immediately. This is the right to be forgotten,
  honoured as policy rather than because a regulator compels it: see ADR 008 on why this is
  not GDPR territory.
- Owner **addresses** from the FAA registry are ingested as a dated, sourced address
  attribute on the profile, per ADR 008. ~~They were previously dropped at the adapter as
  data minimisation.~~ The registry address is a public record and one of the strongest
  match keys available to the entity resolution, so dropping it weakened the join this
  project exists to demonstrate. It carries the registry as its source and the registry
  extract date as its date, like any other attribute.

---

## Chosen sources

Verified live on 2026-08-19 unless marked otherwise. Full detail in
`docs/data-sources.md`.

| Data class | Source | Auth | Phase |
| --- | --- | --- | --- |
| Aircraft live | adsb.lol, failover adsb.fi | none | 1 (done) |
| Aircraft live (unfiltered) | ADS-B Exchange | paid key, or free to feeders | 3 |
| Aircraft live (unfiltered) | airplanes.live | access by email request | 3 |
| Aircraft ownership | FAA Releasable Aircraft Database | none | 5 |
| Aircraft ownership (lookup) | adsbdb | none | 3 |
| Vessels live | Fintraffic Digitraffic; aisstream.io for global | none / free key | 2 |
| Vessels live (crowd-sourced) | AISHub | username, contributors only | 2 |
| Vessel registry | ITU MARS | none | 5 |
| Satellites | CelesTrak GP + supplemental | none | 2 |
| Basemap imagery | NASA GIBS WMTS | none | 1 (done) |
| On-demand imagery (scenes) | Element 84 earth-search STAC, Copernicus Data Space catalogue | none | 7 |
| On-demand imagery (rendered) | NASA Worldview snapshot API | none | 7 |
| Companies and officers | SEC EDGAR, Companies House | none / free key | 6 |
| Political donations | FEC OpenFEC | free key | 6 |
| Nonprofits and foundations | ProPublica Nonprofit Explorer | none | 6 |
| Places and POIs | Nominatim, Overpass | none | 4, 7 |
| Cities | GeoNames `cities15000` bulk file | none | 4 |
| People and organisations (static places) | Wikidata WDQS, Wikipedia REST | none | 6 |
| Social posts (text) | Mastodon public timelines, OpenStreetMap notes | none | 8 |
| Social posts (image) | Wikimedia Commons geosearch, Flickr `has_geo` | none / free key | 8 |
| Person mentions in news and online reports | GDELT DOC 2.0 article search | none | 6 |
| Geo events | USGS, NASA EONET, GDELT | none | 8 |
| Cameras (stills) | TfL JamCams | none | 8 |
| Cameras (live video) | New York 511 HLS streams | none | 8 |
| Cameras (owner-submitted) | Windy Webcams v3 | free key | 8 |
| Reference faces | Wikidata P18 resolved to Wikimedia Commons | none | 13 |
| Reference media | Wikimedia Commons geosearch | none | 8 |

### On the four sources you named

- **ADS-B Exchange is now a named provider, not an optional extra** (ADR 010). The reason
  is coverage, and it is the whole reason: most aggregators drop or fuzz aircraft on FAA
  blocking programmes and **ADS-B Exchange has never filtered**, so it carries aircraft no
  other feed carries. Since ADR 009 decided this product works through those opt-outs, the
  aircraft most likely to be missing from adsb.lol are exactly the ones a wealth profile
  wants. It serves the identical readsb `/v2` schema, so it costs no parser work.
  Three access routes, all checked on 2026-08-19. **The API is the route:**
  `adsbexchange-com1.p.rapidapi.com/v2/mil/` answered 401 with a RapidAPI key error, so the
  host and shape are confirmed and it needs a key; entry pricing is around $10/month for
  ~10,000 requests, which continuous polling exhausts in about a day, so its calls are
  demand-driven rather than a fixed sweep. Feeders get access free, which is documented by
  the provider and unverified here. **The globe map is not a route:** the page loads, but
  `/data/aircraft.json` and `/re-api/` both answer 403 "Request forbidden by administrative
  rules", and `robots.txt` disallows `/api/`, `/mapproxy/`, `/re-api/` and `/globe_history/`
  by name. Honouring robots in code is one of our own rules, so that is settled twice over.
  **The commercial route may already exist internally:** ADS-B Exchange has been owned by
  **JETNET since 2023** and Altrata licenses JetNet, which matters because the provider's
  terms prohibit redistribution and this app serves positions to browsers. That is a licence
  blocker on the layer, not a footnote.
- **airplanes.live and adsb.one** are two more unfiltered community networks on the same
  readsb `/v2` schema. airplanes.live answered 403 asking for an email describing the
  project, so access is gated on asking rather than paying, and sending that email is a
  phase 3 task. adsb.one was Cloudflare-blocked from this network on 2026-08-19 and stays a
  candidate.
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
- **AISHub as a third vessel provider**, merged into the same union as the other two on MMSI,
  per ADR 010. Crowd-sourced from a contributor network, worldwide, free, and gated on
  something no other feed here asks for: **AISHub only grants API access to members who run a
  physical AIS receiver.** Their published bar is a raw NMEA feed carrying at least 10 vessels
  averaged over 7 days, 90% uptime, downsampling no coarser than 60 seconds and delay no
  worse than 10 seconds, streamed to a UDP port they allocate. Their terms prohibit feeding
  them synthesized NMEA, scraped data or data from other public AIS services, so there is no
  software route in.
- **Therefore a hardware task sits at the front of this phase, not in it:** source an AIS
  receiver and site it within VHF range of real shipping traffic, get the feed accepted, get
  the username. Until that lands, AISHub is configured-but-unavailable and the layer reports
  it that way, exactly like a missing API key. Nothing in the vessel layer waits on it.
- AISHub adapter specifics, all documented and none of them optional: `output=json` passed
  explicitly because the default is XML, `format=1` for degrees and knots rather than the
  scaled-integer form, a **once-per-minute cadence floor as a constant in code**, and an
  **empty HTTP 200 treated as an error rather than as an empty sea**, which is how that
  service signals both a bad username and an over-frequent call.
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
6. One vessel record per MMSI across a multi-provider fixture, with the provider and the
   report age on each record and conflicts resolved by recency. Same assertions as the
   aircraft union, per ADR 010.
7. AISHub is called at most once per minute, asserted by a test.
8. An empty HTTP 200 from AISHub is counted as a failed poll and leaves the existing vessels
   in place, asserted. A test proves it never empties the store.
9. With no AISHub username configured, the vessel layer runs on the other two providers and
   `/api/capabilities` reports AISHub unavailable with the reason.

## Phase 3: classification and registry enrichment

**Goal:** classify aircraft and attach ownership, building the enrichment machinery every
later layer reuses.

**Deliverables**
- Military layer from `/v2/mil` with failover; business-jet classification by ICAO type
  designator.
- **LADD-suppressed aircraft resolved and displayed like any other aircraft**, per ADR 009.
  LADD suppresses display on FAA-sourced feeds; our positions come from volunteer receiver
  networks, so the suppression list is not something we are handed and not something we
  apply. A LADD aircraft carries a flag saying the owner is on the programme, because that
  is itself a fact worth knowing on a wealth profile, and the flag is not a display block.
- Privacy ICAO addresses are carried as-is at this phase, flagged and unresolved.
  Correlation to a registration is phase 11.
- adsbdb lookup keyed on hex or registration, giving owner, operator, type and photo,
  cached per entity with a TTL.
- **Provider union for the aircraft layer**, per ADR 010. Every configured provider polled
  concurrently and merged on the ICAO 24-bit address, so coverage is additive rather than
  exclusive. adsb.lol stays the keyless default; **ADS-B Exchange joins as a named provider**
  on a paid RapidAPI key or a feeder key; airplanes.live joins once its access email is
  answered; adsb.fi stays as failover. Per-record provider and report age on every aircraft,
  conflicts resolved by recency rather than provider precedence, per-provider cadence floors
  as constants in code, and a provider dropping out degrades coverage rather than failing the
  layer. ADS-B Exchange's redistribution constraint recorded in config and docs.
- **A provider-attributable coverage count**: how many aircraft only the unfiltered providers
  can see. That number is the argument for paying for the feed, so it is measured on real
  runs rather than asserted.
- Enrichment service: one interface keyed on entity identity, merging feed data with
  registry metadata. Failure degrades the card to feed-only data, never an error state.

**Acceptance**
1. A live business jet is classified and shows its registered owner from a real response.
2. A LADD-listed aircraft resolves to its owner and renders like any other, with the LADD
   flag shown as an attribute. Asserted against a real record.
3. Registry lookups are cached; no repeat call for the same hex in a session, asserted.
4. Failover is proven by a test that kills the primary provider.
5. **One record per ICAO 24-bit address across a multi-provider fixture.** The same aircraft
   reported by three networks is one aircraft, asserted by a test, because the obvious new
   bug here is a phantom fleet and an inflated layer count.
6. Every aircraft record names the provider that supplied it and the age of that report, and
   two providers reporting one hex resolve to the newer position with both providers listed.
   No averaged position that no receiver reported, asserted.
7. Killing one provider in the union leaves the layer up with a degraded flag naming which
   provider is missing, asserted.
8. The count of aircraft visible only via an unfiltered provider is produced from a real run
   and recorded in `docs/status.md`.

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
  Owner **name, type and address**, per ADR 008. The registry address is a public record and
  the strongest match key in the dataset, so it is ingested as a dated, sourced address
  attribute carrying a PII marker, not dropped. Home addresses included: for an
  individually-registered aircraft the registry address usually is one.
- Canadian CCARCS and Australian CASA registers as secondary registries, both carrying
  Mode S codes.
- ITU MARS vessel registry lookup from MMSI to name, flag and tonnage.
- `AssetOwnership` contract linking an owner (person or organisation) to an asset, with
  the source, the confidence and the as-of date on every link.

**Acceptance**
1. A live aircraft in view resolves to its FAA-registered owner with no network call at
   request time (the registry is local).
2. A resolved owner address carries the registry as its source and the extract date as its
   date, asserted by a test. An address with no date is dropped at the adapter and counted.
3. A LADD-listed aircraft resolves to its owner like any other, per ADR 009. Nothing in the
   ownership path reads a suppression list.

## Phase 6: profiles, organisations and the join

**Goal:** the enrichment demo. Search a name, get the profile and its linked assets.

**Deliverables**
- `Profile` and `Organisation` contracts shaped to Altrata's unified model: persistent
  IDs, employment and board history, education, philanthropy, the identity and contact
  attributes in ADR 008 (name and alternate names, date of birth, age, gender, nationality,
  deceased date, hometown, personal and business email, personal and business phone, postal
  addresses, social handles), and a **wealth tier**. Contact fields carry a PII marker so a
  suppressed view can be served. The
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
  so this is deliberately conservative. Per ADR 015 the resolver is **deterministic and
  classical**, and it is the only resolver in the system whatever the modality of the
  evidence:
  - **Blocking** to keep candidate generation off O(n squared): normalised surname plus
    first initial, a phonetic key, a normalised organisation name, plus nearest neighbours
    over the local sentence embedder for the cases string keys miss. Blocking proposes
    candidates and does nothing else.
  - **Per-field comparators**, each independently testable: name distance, date of birth
    exact and year-only, normalised email, normalised phone, nationality, and location
    against the phase 4 city index.
  - **Additive log-odds scoring** over those comparators, so a score decomposes into the
    fields that produced it and the card can show why.
  - **Two thresholds.** Above the upper one, the link is asserted. Between the two, it is a
    possible match displayed with its score and excluded from every aggregate. Below the
    lower one, nothing is recorded. Both constants carry the reason in a comment beside
    them, and the phase 11 and phase 12 thresholds are set relative to these.
  - **No model scores a match**, per ADR 015. Embeddings propose candidates only.
- **An evidence contract shared by every modality**, per ADR 015. A claim carries its value,
  its date, its source, its **origin key** and the modality it arrived in. Nothing under
  `services/` branches on modality. The origin key is what stops a video, a still taken from
  it and its own transcript counting as three sources.
- **A local model boundary**, per ADR 015: four small ONNX models on CPU (a sentence
  embedder, a CLIP-family image and text embedder, a face embedder of the ArcFace class used
  only as ADR 013 permits, and Whisper-small), used only for candidate generation,
  near-duplicate detection and transcription. Weights pinned by hash, fetched on
  first use, not committed, and the model version stored on every embedding. Vectors live as
  blobs in the existing SQLite file and are scanned with numpy; no vector database. With the
  weights absent the product runs text-only and reports the media layers unavailable, like
  any missing key.
- **A corroboration service**, per ADR 011, running over domain contracts after the
  adapters have mapped them rather than inside any one adapter. It holds the supporting
  source set per attribute, counts independent origins, scores the claim on that count and
  the per-source weight, marks a combined value derived, and keeps conflicting dated values
  side by side instead of overwriting. A new source therefore strengthens or weakens
  existing claims rather than writing a parallel truth. It is the same service the phase 12
  occupancy estimate scores against.
- **Person mentions in news and online reports** as a location and role evidence source:
  GDELT DOC 2.0 article search, keyless, capped at one request per five seconds by the
  provider and cached server-side per profile. A mention is a report about a person, not an
  observation of one, so it lands as a derived, city-level, dated location entry with the
  article and its publication date as its source, and it needs corroboration like anything
  else. Article text supplies the place; there is no per-mention geocoding call and no
  precision below the city.
- **The associate graph.** Co-directors, co-owners, fellow trustees and household members
  as they appear in the public filings already ingested (SEC, Companies House, ProPublica).
  Each edge carries its filing, its confidence and its date. It is a profile-to-profile
  join like any other and it is what phase 12 draws candidates from.
- **Organisation locations.** One pin per site, from Wikidata `P159` (headquarters
  location) and the Companies House registered office, snapped to the phase 4 city index
  for the label. An organisation with three offices draws three pins, each with the source
  and the as-of date on it. A registered office is a public filing about a company, which
  is why it is in and a person's address is not.
- **Person locations.** Any dated, sourced location the profile holds: place of birth,
  place of death, place of education, place of work, residence, postal addresses including a
  home address, publicly reported past appearances, and entries produced by joining a live
  feed. Each pin states the relationship in words ("Born in Ulm, per Wikidata") with a link
  to the source, its date, and a removal control beside it. ADR 004 lifted ADR 002's
  seven-property allowlist, ADR 006 made location a dated profile attribute, ADR 007 removed
  the tense constraint along with the rest of the firewall, and ADR 008 widened the address
  rule. What is left is evidence discipline: a date, a source, a confidence, a derived label
  where the entry came from a join, and nothing asserted below the threshold.
- Profile card: identity attributes, wealth tier, roles, contact attributes with the PII
  suppression control, linked assets with live status, dated location entries with derived
  ones labelled as such, and a provenance line per fact naming its source and date.
- **The US privacy position**, per ADR 006 and ADR 008: which state laws reach the
  population, how access and deletion requests are served inside the statutory windows,
  whether data broker registration applies, and the CCPA nuance that the right to delete
  reaches information collected from the consumer rather than everything held. Replaces the
  UK GDPR paperwork previously listed here, which was the wrong instrument for a US
  population and US customers. Enlarged by ADR 007 (joins to live feeds) and ADR 008
  (contact attributes). Still a blocker on any public deployment carrying real profiles.
- **Removal and suppression**, per ADR 006 and ADR 008: a removal request deletes the record
  and keeps a suppression key that survives re-ingest and holds no more personal data than
  the flag needs, shown in the product with its reason. This is the right to be forgotten and
  it is honoured here as policy, not because a regulator compels it.

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
6. Every contact and identity attribute carries a date and a source on the same terms, and
   an undated one is dropped at the adapter and counted. Asserted by a test, per ADR 008.
7. A profile served with contact data suppressed carries none of its contact fields in the
   API response or on the card, asserted by a test.
8. A removal request deletes the record and leaves a suppression key that survives a
   re-ingest of the same source, and the suppression renders with its reason. Asserted by a
   test that re-runs the ingest.
9. An attribute supported by one scraped or crowd-sourced source is unconfirmed, shows its
   score and appears in no aggregate. The same attribute with a second independent source
   crosses the threshold. Asserted by a test, per ADR 011.
10. Two sources that cannot be shown to be independent count once, asserted against a
    recorded pair carrying the same wire story.
11. Two dated values that disagree both survive on the profile and the card shows the
    disagreement. Nothing is silently overwritten, asserted by a test.
12. A real GDELT article mentioning a real profiled person renders as a derived, city-level,
    dated location entry naming the article and its publication date, and the GDELT
    one-request-per-five-seconds cap is honoured under test.
13. A match score decomposes into the per-field contributions that produced it, and the
    decomposition reaches the card. Asserted by a test, per ADR 015.
14. A candidate proposed by an embedding that fails the field comparators produces no link.
    Asserted by a test, so that no model can create a match on its own.
15. The whole test suite passes with the ONNX weights absent, with the media-derived layers
    reporting themselves unavailable. Asserted by a run in CI that never downloads weights.
16. Two claims sharing an origin key count once in the corroboration score, asserted against
    a recorded pair. Two claims with different origin keys count twice.

## Phase 7: imagery, POIs and 3D buildings

**Goal:** depth for the globe itself.

**Deliverables**
- Imagery picker: NASA GIBS daily true colour wired to the timeline date, Terrascope
  WMTS layers (key-value form, `EPSG:3857` matrix set), EOX Sentinel-2 cloudless as a
  static option.
- **Satellite imagery as a queryable source, not just a basemap.** Given a place and a date
  range, return the Sentinel-2 scenes that actually cover it: Element 84 earth-search STAC as
  the primary (keyless, verified), Copernicus Data Space OData as the fallback. Ranked and
  filtered on `eo:cloud_cover`, because the verified London search returned two scenes at
  essentially 100% cloud and an unfiltered layer renders white. The record carries the scene's
  own timestamp and its cloud figure, never the requested date.
- **Rendered imagery for a card** via the NASA Worldview snapshot API, keyless, verified
  returning `image/jpeg`. This is the picture-of-a-place-on-a-day path and it avoids handling
  Cloud-Optimised GeoTIFF in the browser. Its `BBOX` is latitude first, flipped in the adapter.
- Imagery attached to an asset or a profile is dated evidence like anything else: sourced,
  dated to the scene, and never presented as showing something it was not proven to show.
- Cesium OSM Buildings past a zoom threshold, with tuned screen-space error, degrading
  cleanly when no ion token is configured.
- Overpass POI layer by tile with a persistent backend cache, category filtered.
- Wikipedia geosearch "nearby" panel for the current view.

**Acceptance**
1. Scrubbing the timeline date swaps imagery to that day's tiles.
1a. A scene search over a real bounding box returns real Sentinel-2 scenes with their own
   dates and cloud figures, a fully clouded scene is excluded, and a search with no usable
   scene returns nothing rather than the nearest cloudy one. Asserted by a test.
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
- **Camera layer, owner-published and official only.** TfL JamCams: 889 London cameras,
  keyless, verified, stills on S3, with `available`, `imageUrl` and `videoUrl` read out of
  `additionalProperties` rather than off the record. New York 511: 2,931 cameras, keyless,
  verified, live HLS `.m3u8` and no stills at all, of which 1,066 are `Disabled` and any
  `Blocked` camera is removed rather than greyed out. Windy on a free key, key gate verified
  by a 403. Images proxied and cached, HLS proxied only once the restreaming terms are read.
  Availability honoured so no frozen frame is ever presented as live.
- Wikimedia Commons geosearch for reference imagery of a location.
- **Pattern intelligence**: rolling track history per asset, frequented airfields and
  marinas, wealth-hub corridors, and event-window correlation such as inbound traffic to
  a hub during a known event. ~~Aggregated across assets, never pinpointing a person.~~
  **Reversed by ADR 012.** The rolling history built here is the evidence phase 12 estimates
  occupancy from, so it is retained per asset with its own expiry rather than only rolled up.
  The aggregate views stay; they are no longer the ceiling.
- **Posts as profile location evidence.** A post joined to a profile produces a dated
  location entry on the same terms as any other evidence: `upstream` where the source gave
  a coordinate, `derived` at city level where it came from the words, corroborated per ADR
  011, and never drawn as a route between two posts.
- **Post content analysis** (ADR 014), as a service over domain contracts rather than logic
  in an adapter, producing four separately labelled outputs. Sentiment on the `SocialPost`
  record only, with no sentiment field anywhere on a profile. Co-presence: two named people in
  one post resolving to two profiles becomes a dated, sourced, confidence-scored inference that
  they were together, feeding the associate graph and the phase 12 candidate set. Image reading
  for what and where, always `derived` and city-level at best. Why is not asserted: a stated
  reason is an attributed quote and everything else stays empty. A model output is one origin,
  so two models agreeing does not clear the ADR 011 independence bar.

**Acceptance**
1. A real earthquake from the last hour renders within one poll cycle.
2. London cameras refresh and unavailable cameras are marked, not frozen. A `Disabled` or
   `Blocked` New York 511 camera is absent from the layer, asserted by a test against the real
   inventory shape.
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
8. Two named people in one real post produce a co-presence inference carrying both profiles,
   the post as its source, the post's date and a confidence, and it is absent from every
   aggregate while unconfirmed. Asserted by a test.
9. No profile contract anywhere carries a sentiment field. Asserted by a test over the
   contracts package, because this is the rule most likely to be broken by accident.
10. A Mastodon instance answering 401, 403 or 422 is dropped for the cycle and the feed
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

## Phase 10: recency as the product

**Goal:** demonstrate the actual commercial claim. Customers buy profile data and profile
enrichment, and the differentiator here is not that we hold a fact, it is that our fact is
hours old rather than months old, and in places minutes old. This phase makes freshness
measurable, visible and sellable.

**Deliverables**
- **An as-of date on every attribute, not every profile.** The profile stops having one
  "last updated" and starts carrying per-attribute recency, because that is what the claim
  rests on: a board seat from a filing is quarters old, an aircraft position is seconds old,
  and averaging them hides the whole point.
- **A staleness delta per attribute**: the age of our value against the age of the
  equivalent value in the licensed baseline the business already sells. That delta is the
  demo. A profile view shows, attribute by attribute, how far ahead of the incumbent
  dataset this pipeline is.
- **A freshness index on the profile**: the distribution of attribute ages, weighted by how
  fast each attribute class actually changes. A residence that has not moved in ten years is
  not stale. A leadership role checked eleven months ago is.
- **Change detection and a change feed.** When a re-poll or a re-crawl produces a different
  value, the change itself becomes a record with a before, an after, a source and a
  timestamp. `/api/profiles/{id}/changes` and a websocket topic serve it, so a customer
  system can subscribe rather than re-download.
- **Enrichment out, not just in.** `POST /api/enrich` taking an identity payload and
  returning the attributes we hold with each one's age, source and confidence. This is the
  shape the business already sells as an API, so the demo speaks the same protocol.
- **A per-source refresh cadence table** in `docs/data-sources.md`, with the observed
  update interval rather than the documented one. Some feeds claim a cadence they do not
  keep, and the honest number is the one worth quoting to a customer.

**Acceptance**
1. A profile view shows a per-attribute age and, where a baseline age is known, the delta
   against it. Real values, no placeholders.
2. A live position on an owned asset shows an age in seconds, alongside an ownership fact
   showing an age in weeks, on the same card. That contrast is the demo in one screen.
3. Changing a value upstream produces a change record with a before, an after, a source and
   a timestamp within one poll cycle, proven end to end.
4. `POST /api/enrich` returns every attribute with its age, source and confidence, and omits
   what we do not hold rather than returning a default. Asserted by a test.
5. The observed refresh interval per source is measured over a real run and written into
   `docs/data-sources.md`.

## Phase 11: privacy ICAO address correlation

**Goal:** resolve aircraft broadcasting a privacy ICAO address back to a registration, so
the ownership join holds for the population most likely to be using one. See ADR 009 for the
decision and the exposure.

**Deliverables**
- `PiaCorrelation` service: candidate generation from the observable signal (type
  designator, callsign where one is broadcast, first and last seen positions, airport pair,
  timing) against the registry and the recent history of non-PIA sightings, then scored
  matching with a confidence.
- The same threshold discipline as every other join: **below the threshold nothing is
  asserted**, the candidate shows as a possible match with its score, and it is excluded
  from every aggregate. A PIA correlation is a probabilistic claim about an identity that
  was deliberately obscured, so the threshold here is set higher than for a plain registry
  join, and the reason is recorded in code next to the constant.
- The PIA flag stays on the record after correlation. A card never shows a correlated
  identity without also showing that the aircraft was broadcasting anonymously and that our
  identification is inferred.
- Rolling history retention long enough to correlate across a PIA rotation, with its own
  expiry, since this is the one place the product keeps position history about an
  identifiable owner for longer than the live TTL.

**Acceptance**
1. A real PIA aircraft is correlated to a registration from recorded live data, and the card
   shows the confidence, the evidence used and the fact that the address was anonymous.
2. A correlation below the threshold is shown as a possible match and appears in no count,
   asserted by a test.
3. No correlation is presented as an observation. A test asserts the inference label is
   present on every correlated record.

---

## Phase 12: occupancy estimation

**Goal:** answer "is the principal travelling, and with whom" as an explicit inference with
its evidence shown. See ADR 012 for the decision, the rules and the exposure. Depends on
phase 5 (ownership), phase 6 (profiles, corroboration, associate graph), phase 8 (recorded
route history) and phase 11 (privacy address correlation).

**Deliverables**
- `OccupancyEstimate` contract: the asset, the window, a list of candidate persons each
  with a probability and an itemised evidence list, and a **no-estimate state that is the
  default**. Every instance carries an inference marker that the API and the card cannot
  drop.
- The estimator, drawing only on what is already in the system: registry ownership with its
  entity-resolution confidence, a corporate owner expanded to its officers and beneficial
  owners as separate candidates, movement history we recorded ourselves (home base,
  frequented pairs, typical departure windows), the live transponder or AIS track and the
  current origin and destination pair, the associate graph from public filings, and each
  candidate's dated locations from every other layer.
- **Contradiction beats corroboration**, in code: a corroborated dated location for a
  candidate elsewhere in the same window removes that candidate outright rather than
  lowering the score.
- Threshold discipline, set at least as high as the phase 11 PIA threshold with the reason
  recorded next to the constant. Below it the card reads "occupants not established" and
  says what was considered. No half-named candidate, and no estimate in any aggregate.
- Suppression applied before the estimate is computed, never filtered afterwards, so a
  removed or suppressed person is never a candidate.
- Card presentation that cannot be mistaken for an observation: the inference label, the
  evidence itemised with each item's source and date, the confidence, and the contradicting
  evidence that removed a candidate shown alongside.

**Acceptance**
1. A real owned aircraft in flight produces either a named candidate above the threshold
   with its evidence itemised, or "occupants not established" with the evidence considered.
   Both paths asserted against recorded live data.
2. A candidate with a corroborated dated location elsewhere in the window is removed, and
   the card shows what removed them. Asserted by a test.
3. No estimate appears in any aggregate count, ranking or corridor statistic, asserted.
4. Every estimate carries the inference label through the API and onto the card, asserted
   by a test that tries to serialise one without it.
5. An occupancy estimate never creates a location entry on any profile, asserted by a test.
6. A suppressed person is absent from candidate generation, not filtered from the output.
   Asserted by a test that inspects the candidate set.

## Phase 13: multimodal evidence

**Goal:** images, audio and video become dated, sourced claims that feed the phase 6
resolver and corroboration service unchanged. See ADR 015 for the decision. Depends on
phase 6 (the evidence contract, the resolver, the local model boundary) and phase 4 (the
city index). Phase 12 consumes what this produces where it is present and works without it
where it is not.

Numbered before phase 14 because it supplies the media plumbing the face phase also uses:
the media contracts, the origin key, the embedding store, and the licence and dating rules.
The evidence contract, the resolver and the model boundary all land in phase 6, so nothing
here changes a `services/` module.

**Deliverables**
- `MediaItem` and `MediaClaim` contracts. A media item carries its URL, its content hash,
  its licence and author (existing rule: an item whose licence cannot be determined is
  dropped and counted), its capture or publication date with a marker saying which of the
  two was used, its origin key, and its embedding with the model version that produced it.
  A media claim is an ordinary dated, sourced claim that happens to name its media item.
- **The image path.** Wikimedia Commons, Flickr, phase 8 camera stills, and aircraft and
  vessel photographs. Outputs: the embedding, EXIF where present including a geotag treated
  as a fact about the camera rather than about any person, the caption or alt text as a
  crowd-sourced text claim, and near-duplicate detection that assigns a shared origin key to
  re-uploads of one picture.
- **Registration and vessel-name reading from photographs**, which is the one image output
  that produces a hard identifier. A read is a candidate only: it is scored against the FAA
  and ITU MARS registries from phase 5 and asserted only if the registry has the record.
  An unreadable frame is dropped and counted.
- **The audio path.** Earnings calls and investor webcasts (a company's own webcast is a
  primary record and may cross the assertion threshold alone), and the audio track of social
  media posts (crowd-sourced, never alone). Whisper-small on CPU produces timestamped
  transcript segments, each dated to the recording rather than to the run. Fetch and
  transcription are demand-driven and cached by content hash, never a poller, because hours
  of audio on a laptop CPU is not a sweep.
- **The video path**, which is the image path over sampled frames plus the audio path over
  the audio track, sharing one origin key. No video-specific contract and no video-specific
  scoring.
- **Named-entity and place extraction from transcripts and captions**, resolved against the
  phase 4 city index and against existing profile and organisation names. City-level
  precision only, matching ADR 005, and every entry labelled derived.
- **Media proxying and caching**, per the social post layer rules: never hot-linked, and the
  cached bytes are the input to the hash, the embedding and the transcript.
- Sources recorded in `docs/data-sources.md` with collection method, licence position,
  cadence and verification date, as with any feed.

**Acceptance**
1. A real Commons photograph produces a dated, licensed, sourced media item with an
   embedding, and a caption claim marked crowd-sourced that is unconfirmed on its own.
2. Three re-uploads of one photograph share an origin key and count once in the
   corroboration score. Asserted by a test against recorded fixtures.
3. A video, a frame sampled from it and its own transcript share one origin key and count
   once. Asserted by a test. This is the double-count ADR 015 exists to prevent.
4. A real earnings call transcript segment lands dated to the call, not to the run, and as a
   primary record it may cross the assertion threshold alone.
5. A registration read from an aircraft photograph asserts only where the FAA registry holds
   the record, and produces nothing where it does not. Both paths asserted.
6. Undatable media is dropped at the adapter and counted, asserted by a test.
7. No image path in **this** phase identifies a person. Face matching is phase 14 and lives
   behind the ADR 013 rules, so a test asserts that a person appearing in a photograph creates
   no location entry from the phase 13 path alone.
8. A geotag on a photograph creates a claim about the photograph, and joining it to a person
   requires corroboration like any other join. Asserted by a test.
9. Audio is fetched and transcribed on demand and served from the content-hash cache on a
   repeat, never on a cycle. Asserted by a test that counts fetches.
10. Every model output taken from one media item shares that item's origin key, so a landmark
    reading, a registration read and a caption from one photograph count once between them,
    and a phase 14 face match on the same photograph joins that same origin rather than
    adding one. Asserted by a test, per ADR 014's rule that a model output is not a source.
11. Image content reading is closed-set: a label that is not already a record in the system
    cannot be produced. Asserted by a test that offers an image of something the system holds
    no record for and gets nothing back.

---

## Phase 14: identifying people in photographs

**Goal:** put a name to a face in a public photograph, against the profiles already held, as
an explicit inference. See ADR 013 for the decision, its limits and its exposure, and note
that ADR 013 records this as Alexander Fanthome's decision taken with the legal position in
front of him. Depends on phase 6 (profiles, the resolver, the local model boundary), phase 8
(the image side of the post layer) and phase 13 (the media contract and the face embedder,
which per ADR 015 proposes candidates and never scores the match).

**Deliverables**
- `FaceMatch` service, 1:N against the profile list only. There is no open-set capability and
  none is built. It runs on the phase 6 resolver: the face embedder proposes candidates, the
  deterministic comparators and log-odds scoring decide, per ADR 015.
- **Local inference only**, per ADR 015. No cloud vision API and no paid model endpoint, which
  is a licensing position as much as a deployment one: posting a scraped photograph to a third
  party to be matched is redistribution.
- Reference faces from Wikidata P18 resolved to Wikimedia Commons, keyless and verified, one
  per-entity lookup on a user action, cached, never a bulk scrape. No P18 means no reference
  face, no match, and nothing asserted.
- **A detected face matching no profile is discarded, not stored.** This is the line between
  matching against people we profile and building a biometric database of the public, and it is
  asserted by a test rather than left to review.
- A threshold set above an ordinary registry join, with the reason recorded in code next to the
  constant, on the same pattern as the phase 11 privacy-address threshold.
- Corroboration per ADR 011: a face match alone never crosses the assertion threshold, and a
  photograph plus its own caption naming the same person is one origin, not two.
- Card rendering that says the identification is inferred from a photograph, names the
  photograph, its source, its licence and its date, and shows the confidence.
- A matched location becomes a dated location entry dated to the photograph, labelled derived.
- Suppression removes the reference embedding and takes the person out of the candidate set.

**Not in scope:** face matching on camera feeds. Owner-published cameras are a camera layer and
nothing more. Extending recognition to a live public street is a separate decision to be taken
deliberately, not a side effect of this phase.

**Acceptance**
1. A real photograph of a real profiled person is matched, and the card shows the confidence,
   the photograph, its licence and the words that the identification is inferred.
2. A match below the threshold shows as a possible match and appears in no aggregate count.
   Asserted by a test.
3. A face present in an image that matches no profile leaves no stored record of any kind.
   Asserted by a test that inspects the store after a run.
4. A suppressed person is absent from candidate generation, not filtered from the output.
5. A profile with no Wikidata P18 produces no match and no error.

**Blocker on public deployment:** a written legal position from counsel naming the
jurisdictions and the consent basis, alongside the phase 6 US privacy position. This does not
block the build or the demo. It blocks shipping to real customers with real people in it.

---

## Not designed in this repo

One item the business has asked for is excluded here, and it is not a policy preference.

**Aggregators of unsecured private cameras.** Excluded, and this one is not a policy
preference. Those aggregators index cameras whose owners misconfigured them, which means
accessing a private system without authorisation: Computer Misuse Act 1990 in the UK,
state computer-access statutes and the CFAA in the US. Owner-consented and official camera
feeds (TfL, US 511 programmes, Windy) are in phase 8 and cover the layer's purpose.
