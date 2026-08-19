# Architecture

How a byte gets from a public feed to a pixel on the globe, and why each hop exists.

Companion documents: `docs/business-context.md` for why the product exists commercially
and the wealth tiers it serves, `docs/data-sources.md` for feed facts, `docs/status.md`
for what is actually running, `docs/decisions/` for the choices behind all of this.

The commercial shape in one line: a wealth profile joins to everything else the system
knows, assets and live feeds included, and those assets are what moves on the globe. The
claim being demonstrated is recency, so every attribute carries its own age and the
architecture below exists to make a seconds-old fact and a quarters-old fact sit on the same
card honestly. The
pipeline below is how an asset gets there. Wealth tiers ride on the profile and are never
derived from a position.

The join is the product, so there is no prohibited join and no structural separation between
the people layer and anything else (ADR 007). The profile itself carries the production
attribute set, contact and identity fields included (ADR 008). What holds the whole thing
together is evidence rather than architecture: a source, a confidence and an as-of date on
every join and every attribute, sub-threshold joins shown as possible matches and excluded
from aggregates, derived entries labelled derived, contact fields marked PII so a suppressed
view can be served, and a removal control that deletes and suppresses.

## The short version

One FastAPI process owns every upstream connection. It validates each payload at the
boundary, keeps live entities in an in-memory store with a time to live, and pushes
batched changes to browsers over a single WebSocket. The browser renders with CesiumJS
using one primitive collection per layer and mutates positions in place. Satellites are
the one thing propagated in the browser rather than fetched.

## What the globe can put a pin on

Seven entity classes: aircraft, vessels, satellites, cities, organisations, people and
social posts. One contract module and one layer each. The table in
`docs/plan/implementation-plan.md` gives the contract, the position source and the phase
for each one, and nothing renders that is not on it.

Three of them move and four do not, and that split matters more than it sounds, because
only the movers belong in the flow described below.

## Three storage shapes, not one

The TTL store and the poller are for live movers. Two other shapes exist and using the
wrong one is a design error rather than an inefficiency.

**Live movers** (aircraft, vessels) go through a poller into an `EntityStore` with a time
to live, and expire when the feed stops reporting them. Satellites are the same class of
thing with the propagation moved to the browser, described below.

**Static reference data** (cities, and the orbital element sets behind satellites) is a
periodic bulk load into a local index that is read in-process and never expires. Cities do
not stop existing between polls, so a TTL would be a bug. The GeoNames city file is
downloaded weekly and 26,000 rows are held in memory, which is also what keeps place
search off the network entirely.

**Fetched-and-cached records** (social posts, organisation and person records, registry
lookups, camera images) are pulled on demand or on a slow cycle, cached server-side with
their own expiry, and are not part of the WebSocket delta stream. A social post is a fixed
event with a timestamp: it never updates, it never moves, and it is never dead-reckoned.

**Media and its embeddings** (ADR 015) are a fetched-and-cached record with two extra
properties. They are keyed by **content hash**, because the same photograph arrives from
several places and the hash is what proves it is one origin rather than several. And they
carry embeddings as blobs in the same SQLite file, scanned with numpy rather than served by
a vector database, which keeps a removal request under ADR 008 a single delete with no
second store to forget to purge. Transcription is the expensive step, so audio is fetched
and transcribed on demand and served from the hash cache on a repeat, never swept on a
cycle.

## Data flow, in order

1. **A poller wakes up.** `services/poller.py:196` runs the supervised loop, one instance
   per feed. It calls `run_once` (`services/poller.py:126`), sleeps, repeats, and never
   exits on a failure.
2. **The adapter fetches.** For aircraft that is `AdsbClient._fetch_from`
   (`sources/adsb.py:352`), using the one shared `httpx.AsyncClient` built in the app
   lifespan (`app.py:172`).
3. **The response is validated against a wire model.** `parse_response`
   (`sources/adsb.py:235`) hands the raw bytes to `validate_payload`
   (`contracts/base.py:100`), which validates JSON in pydantic-core rather than
   round-tripping through Python objects.
4. **The adapter maps wire to domain.** `_to_domain` (`sources/adsb.py:164`) converts feet
   to metres, resolves the heading fallback chain, strips the callsign padding, reads
   `dbFlags` and produces an `Aircraft` (`contracts/aircraft.py:55`). A record that will
   not map is dropped and counted.
5. **The store takes it.** `EntityStore.upsert_many` (`services/store.py:69`) for the
   viewport feed, `replace_all` (`services/store.py:119`) for the worldwide military feed.
   The key is the ICAO 24-bit address, never a generated one.
6. **The hub drains and broadcasts.** `Hub.flush` (`services/hub.py:159`) expires stale
   entities, takes the pending change set, and sends one `Upsert` and at most one `Remove`
   per layer per interval.
7. **The socket carries a typed envelope.** `contracts/messages.py:98` defines the server
   message union, discriminated on `type`. `api/routes_ws.py:31` is the only endpoint the
   browser streams from.
8. **The frontend applies the batch once per animation frame**, mutating positions inside
   an existing `PointPrimitiveCollection`, then dead-reckons between server ticks so an
   eight-second feed still looks like motion.

REST snapshots (`api/routes_entities.py`) read the same stores and never touch an
upstream. A browser refresh must not become an upstream request, or a reload loop turns
into a denial of service against a free provider.

## Why the backend owns every upstream connection

Three reasons, heaviest first.

**Keys never reach the browser.** aisstream, Windy and TfL all need credentials. Anything
shipped to a browser is public, so those feeds are proxied. The one exception is the
Cesium ion token, which is a client-side token by design and is handed over deliberately
at `api/routes_meta.py:115`.

**Rate limits are hit once, not once per client.** With one hundred browsers open, the
upstream still sees one request per cadence. That is the difference between staying inside
a free provider's tolerance and being blocked. CelesTrak firewalls abusive clients without
appeal, and Overpass has a fair-use ceiling of roughly ten thousand queries a day per IP.

**Normalisation happens in one place.** Feet to metres, `lat, lon` to `[lon, lat]`,
naive timestamps to tz-aware UTC, provider quirks to one shape. All of it sits in the
adapter. The frontend never learns that adsb.lol space-pads `flight` or that `alt_baro`
is sometimes the string `"ground"`.

## Providers: union, not failover

The aircraft layer polls every configured provider at once and merges the results on the ICAO
24-bit address (ADR 010). Failover still exists inside a provider; coverage across providers
is additive.

The reason is coverage rather than resilience. Aggregators do not see the same aircraft,
partly because each is the union of its own volunteers' receivers, and mostly because most of
them drop or fuzz aircraft on FAA blocking programmes while ADS-B Exchange, airplanes.live
and adsb.one do not. Since ADR 009 decided this product works through those opt-outs, an
unfiltered provider is the only way the layer covers the population the profiles are about.
Every provider serves the identical readsb `/v2` schema, so the union costs no parser work.

Three consequences that shape the code. Each record carries the provider that supplied it and
the age of that report, so a merged store stays auditable. Conflicts resolve by recency, never
by provider precedence, and two disagreeing positions are never averaged into a third that no
receiver reported. And cadence is per provider: a metered key cannot be swept on the same
cycle as a keyless feed, so its calls are demand-driven.

## The deliberate exception: satellites

Satellite positions are computed in the browser, not on the server.

The backend fetches CelesTrak orbital element sets and caches them. The browser runs SGP4
via `satellite.js` and propagates every satellite every frame. Three things make that the
right call: element sets change on a scale of hours while positions change every
millisecond, so serving positions would mean pushing thousands of updates a second for
data the client can derive; time-scrubbing becomes free, because changing the clock just
re-propagates; and there are zero runtime API calls, which matters most for the one
provider that bans clients permanently.

This is the only place the browser does its own physics. Everything else it draws was
validated server-side.

## The wire-model and domain-model boundary

Two model bases, and the gap between them is the design.

`WireModel` (`contracts/base.py:68`) is permissive: `extra="ignore"`, not strict, mirrors
exactly what the provider sends including its inconsistencies. It lives only inside
`sources/`.

`StrictModel` (`contracts/base.py:50`) is the domain base: `strict=True`,
`extra="forbid"`, `frozen=True`. Everything outside `sources/` sees only these.

The real example, measured on the captured payloads in `tests/fixtures/`: adsb.lol's
`/v2/mil` returns eight fields `/v2/point` does not (`dbFlags`, `calc_track`,
`lastPosition`, `gpsOkBefore`, `gpsOkLat`, `gpsOkLon`, `rr_lat`, `rr_lon`). A strict model
at the wire layer would reject all 391 military records in that capture, and the military
layer would simply not exist. Go the other way and use a permissive model in the domain,
and a transponder reporting no position becomes an aircraft at (0, 0), drawing a permanent
phantom cluster in the Gulf of Guinea. The `/v2/mil` capture has 310 records with
positions out of 391, so that is 81 records a permissive domain model would have to invent
coordinates for.

Permissive in, strict out. `sources/adsb.py:57` documents the eight fields at the wire
model itself, and `_to_domain` (`sources/adsb.py:164`) returns `None` for a record it
cannot map rather than filling in a default.

## The store: time to live and change draining

`EntityStore` (`services/store.py:45`) is generic over the entity type and answers three
questions: what is live now, what changed since the last flush, and what has gone quiet.

**Time to live is an honesty mechanism.** A feed that stops reporting an aircraft means it
landed, left receiver range, or switched its transponder off. `expire`
(`services/store.py:90`) drops anything whose last update is older than
`entity_ttl_seconds` (default 90 seconds, `config.py:84`, roughly ten missed polls) and
queues the key for removal so clients are told to take it off the globe. Leaving the last
known position on screen forever would draw a fleet that is not there.

**Change draining is what keeps bandwidth flat.** `take_changes`
(`services/store.py:104`) returns the pending upserts as whole entities and the pending
removals as keys, then clears both sets. The pending set is a `set[str]` of keys, not a
list of events, so an entity that updated five times between flushes appears in it once
and is sent once, at its latest value. Feed frequency can rise without client bandwidth
following it. Upserts carry whole entities because the frontend replaces rather than
patches; removals carry only keys because there is nothing left to send.

Two stores, not one (`app.py:80`). The viewport feed and the worldwide military feed would
otherwise fight: `/v2/mil` is a complete world picture, so `replace_all` is correct for it,
and running `replace_all` over a merged store would evict every locally seen aircraft on
every military poll.

The store is not thread-safe on purpose. Everything touching it runs on one asyncio event
loop, and a lock would be overhead plus a false sense of safety.

## The poller: cadence floors and the rate-limit path

`effective_interval` (`services/poller.py:104`) is `max(configured, floor)`. Configuration
can slow a feed down and can never speed it past its floor. The floors are constants in
code: `ADSB_MIN_INTERVAL_SECONDS = 5.0` (`app.py:33`) because adsb.lol aggregates roughly
every five seconds, and `ADSB_MIL_MIN_INTERVAL_SECONDS = 30.0` (`app.py:41`) because
`/v2/mil` returns every military aircraft on the planet in one response and is a far more
expensive call. A floor that lived in configuration would be one careless environment
variable away from getting the IP banned, so it does not live there.

Rate limiting has its own exception type, `RateLimitedError` (`sources/base.py:47`),
carrying the provider's own `Retry-After` figure. The poller honours that figure directly
rather than applying its backoff curve (`services/poller.py:145`). The reason is stated at
`sources/base.py:3`: a 500 is worth retrying promptly, and a 429 retried promptly is how
an IP gets permanently blocked. `RATE_LIMIT_STATUS_CODES` (`sources/base.py:21`) holds
both 429 and 420, because adsb.lol answers 420 ("enhance your calm"), which is not a
standard code and would otherwise be treated as a plain client error.

### The incident that justifies the provider-swap interface

On the first live run of this app, adsb.lol answered `/v2/mil` with HTTP 420 and the
adsb.fi failover carried the military layer with no code change. The failover is
`AdsbClient._get` (`sources/adsb.py:331`): it catches transport errors, rate limiting, 5xx
and contract violations, then retries the same path against the secondary base URL. Both
providers serve the readsb v2 schema, so the same parser handles both and swapping is a
base-URL change (`config.py:64`, `config.py:65`).

That is the interface earning its keep on day one. It also found its own limit: the
military path `/v2/mil` is identical on both providers, but adsb.lol's viewport path
`/v2/point/{lat}/{lon}/{nm}` is not, and adsb.fi answers 400 for it. The viewport failover
is therefore currently broken by path shape. See `docs/status.md` for the detail and
`docs/data-sources.md` for the path adsb.fi actually uses.

Jitter (`services/poller.py:34`) spreads every sleep by 15%, so pollers started together
do not synchronise into a burst against one provider.

## Enrichment: a fourth shape, and where inference sits

Enrichment is neither a live mover nor static reference data, and it is the one part of the
system where two records combine into a third. It has its own place in the layout and
getting it wrong is how a demo starts asserting things nobody sourced.

**Corroboration runs over domain contracts, after the adapters** (ADR 011). An adapter maps
one upstream payload to one domain record and stops there. The corroboration service in
`services/` then holds, per attribute, the set of sources supporting it, counts how many
independent origins those sources represent, and scores the claim on that count. A new
source therefore strengthens or weakens the claims already held instead of writing a
parallel truth into its own adapter. Two consequences that are structural rather than
stylistic: no adapter may reach across to another source, and a claim's confidence is not
a field the adapter sets.

**Inference is a separate contract, never a field on an observation.** The phase 12
occupancy estimate (ADR 012) reads ownership, recorded route history, the live track, the
associate graph and each candidate's dated locations, and emits an `OccupancyEstimate` that
carries its own inference marker, its evidence list and its confidence. It never mutates an
aircraft record and it never writes a location entry onto a profile. An inference that can
write into the evidence store would corroborate the next inference with itself, which is
the specific failure the separation prevents.

**A model output is not a source** (ADR 014, made structural by ADR 015). Every claim drawn
from one media item shares that item's origin key, so a face match, a landmark reading, a
registration read off a tail and a caption from one photograph count once between them.
Running a second model over the same picture does not create a second source. Without this
the enrichment layer inflates its own confidence, which is the same failure as corroborating
an inference with itself.

**Resolution is deterministic and lives in `services/`, models live in `sources/`** (ADR
015). Embeddings propose candidates; per-field comparators and additive log-odds scoring
decide, so a confidence number traces back to named fields and named origins. Nothing under
`services/` inspects a pixel or a waveform, which is what lets one resolver serve text,
image, audio and video without branching on modality.

**News and article records are fetched-and-cached, per profile, not polled.** A GDELT
article search is a query about one person on demand with a server-side cache and a
five-second floor between requests, so it belongs with the other fetched-and-cached records
above rather than in the TTL store and never in the WebSocket delta stream.

## Frontend render policy

Non-negotiable, and it cannot be retrofitted.

- **One primitive collection per layer.** `PointPrimitiveCollection` and
  `BillboardCollection`, created once, mutated in place. A layer is never rebuilt per tick.
- **The Cesium `Entity` API cannot be used for moving assets.** It collapses in the low
  thousands of movers, and the target is 20,000. Converting an `Entity`-based layer to
  primitives is a rewrite of that layer, not a refactor, which is why this decision is
  made before any layer is written rather than after a frame-rate complaint.
- **`requestRenderMode` on**, with explicit render triggers. An idle scene should cost
  nothing, and the render loop is paused when the tab is hidden.
- **Dead reckoning between ticks.** The server flushes once a second (`config.py:90`) and
  the aircraft feed updates every eight. Between updates the client advances each entity
  along its last known track and ground speed, which is why `track_deg` and
  `ground_speed_mps` are part of the contract and why `Point.project`
  (`contracts/geo.py:48`) exists server-side too for track-history gap filling.
- **Level of detail by `distanceDisplayCondition`:** icon first, label last. Labels are
  the expensive tier.
- **Feed parsing in a Web Worker**, handing transferable typed arrays to the render
  thread.

## The single-worker constraint

Pollers start in the application lifespan (`app.py:184`). Every uvicorn worker runs its
own lifespan, so a second worker means a second copy of every poller and double the
upstream request rate against feeds given to us for free. `__main__.py:27` pins
`workers=1`.

Scaling out horizontally needs a cross-process lock, or a split between a poller process
and a stateless web tier, before it needs anything else. `start_background_tasks=False`
(`app.py:159`) already builds a fully working API over empty stores, which is both what
tests use and the shape a poller-less web tier would take.

There is a related single-instance assumption in `AppState.viewport`
(`api/state.py:39`): one viewport for the whole server rather than one per client, so the
aircraft feed is queried once for the union of interest. With a handful of clients that is
the right trade. With many, it becomes a merged set of boxes, and the poller reading it is
the only thing that changes.

## Where to add a new data source

Six files, and the plan's file table (`docs/plan/implementation-plan.md`) names where each
one goes.

1. **`src/tracker/contracts/<entity>.py`** for a new entity class: a `StrictModel` with a
   `kind` literal, coordinates as `[lon, lat]`, altitude in metres, tz-aware UTC times.
   Reuse an existing contract if the feed produces something already modelled.
2. **`src/tracker/contracts/messages.py`** to widen the `Entity` union
   (`contracts/messages.py:17`) and the `LayerName` literal
   (`contracts/messages.py:26`). Both are additive; every contract already carries the
   `kind` field discrimination needs.
3. **`src/tracker/sources/<feed>.py`** for the adapter: a permissive `WireModel` per
   payload shape, an explicit map to the domain contract, and every provider quirk
   confined to this file.
4. **`src/tracker/config.py`** for the base URL, the cadence default and any credential.
   Credentials are optional, and a missing one makes the layer report itself unavailable
   rather than failing.
5. **`src/tracker/app.py`** for wiring: a store in `build_state` (`app.py:74`), a
   `hub.register_layer` call, a `Poller` with its `min_interval_seconds` floor as a module
   constant, and a row in `ATTRIBUTIONS` (`app.py:51`). Add the layer to
   `api/routes_meta.py:76` so `/api/capabilities` reports it.
6. **`docs/data-sources.md`** in the same commit, with the endpoint, licence, cadence and
   the date someone actually called it. An unverified endpoint does not go in that file.

Then the tests: a parser test against a recorded real payload in `tests/fixtures/`, and a
cadence test asserting the floor holds. Refresh the wire contract with
`uv run python scripts/dump_openapi.py` and regenerate the frontend types, because CI
fails on drift.
