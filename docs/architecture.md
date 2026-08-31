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
downloaded weekly and 34,072 of its 34,099 rows are held in memory, the 27 refusals being dead
places, which is also what keeps place search off the network entirely. The weekly request is
conditional on the stored `ETag` and normally costs nothing: verified 2026-08-20 as HTTP 304 with
zero bytes in 64 milliseconds against 3,306,600 bytes for the file. Both bulk fetches sit behind a
`robots.txt` that disallows them, and the reading that permits a weekly conditional fetch is R4 in
`docs/pending-decisions.md`. It is unratified and it carries every live vessel number and every
city in `docs/status.md`.

**Fetched-and-cached records** (social posts, organisation and person records, registry
lookups, camera images) are pulled on demand or on a slow cycle, cached server-side with
their own expiry, and are not part of the WebSocket delta stream. A social post is a fixed
event with a timestamp: it never updates, it never moves, and it is never dead-reckoned.

**Rate-limit state is a fourth thing on disk, and it is the smallest.** `cache.py` is one
SQLite file under `Settings.cache_dir`, holding two kinds of row: when may I next call this
provider, and what did it last tell me. Every guard that used to keep that in memory now
writes it there, because a restart threw the lot away and a provider cannot tell a restart
loop apart from hammering. Measured on 2026-08-20: adsb.lol answered HTTP 420 on the first
`/v2/mil` request of a fresh process, having been asked for 120 seconds of quiet by a process
that had already exited. Get with a time to live, set, delete, delete by prefix, list keys,
and nothing else. It is not a data layer, and no personal data goes in it: the adsbdb owner
cache is deliberately in memory only (`sources/adsbdb.py:472`).

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

Cities walk none of those steps, and that is the whole design of the layer. The weekly
download is one asyncio task started by the lifespan rather than a `Poller`
(`app.py:_refresh_cities_forever`), because a poller belongs to a feed with a delta channel
and a static file has none. The index is never registered with the hub, so no city delta is
ever pushed and no time to live can expire London. `/api/cities` reads the ordered rows and
`/api/cities/{geonames_id}` the index (`api/routes_entities.py`), and both read memory only.
`/api/search` (`api/routes_meta.py`) builds a `SearchService` per request over the live
stores, the index and the geocoder, which is what stops a weekly index swap leaving the
search answering out of a gazetteer it was born with. A retry that indexed nothing waits
`app.CITY_RETRY_SECONDS` rather than the week, because the floor that protects the provider is
the adapter's own and a week-long sleep after a failure only starves the layer.

The city read is the one response big enough to matter on the wire: 34,072 rows and **10,227,194
bytes** of JSON, asked for in full on every page load because the layer decides which labels to
draw from where the camera is and cannot decide that over rows it does not hold. Gzip is registered
next to CORS in `app.create_app` and takes it to **2,062,053 bytes**, five times smaller, at
compression level 1 so the saving costs a fraction of the CPU that level 9 does. Both figures read
off `content-length` on a running server on 2026-08-20; an earlier version of this paragraph said
1.57MB and was wrong. There is no reverse proxy in this deployment, since FastAPI serves the built
bundle itself, so nothing else was ever going to compress it.

Two things about that layer that only the browser half decides, and the second is not optional.
`CityLayer` (`frontend/src/globe/layers/cities.ts`) holds every record in memory, sorted, and draws
through one `LabelCollection` created once and mutated in place. Six population bands drive a
per-label `DistanceDisplayCondition`, so the range test is the GPU's and costs nothing per frame:
59 cities are visible from orbit, 562 by continent framing, 1,989 by country zoom, all 34,072 at
street zoom, measured against the real file on 2026-08-20. On top of that sits
`CITY_LABEL_BUDGET`, 600 labels. Banding alone would still put 34,072 labels in the collection, and
a Cesium label is not one primitive: `rebindAllGlyphs` builds one billboard per glyph as soon as a
label has text, whatever its display condition says. The whole gazetteer is roughly 300,000 glyph
billboards, hundreds of megabytes of vertex buffer and a multi-second hitch on load, so the
collection holds a working set of the biggest cities that could be visible from where the camera is
now. Nothing is refetched to change the picture.

The gazetteer itself is `CityIndex` (`services/gazetteer.py`), and the thing to know about it is
what it does not contain: no client, no URL, no coroutine. "A city lookup issues zero requests" is
a structural fact about the type rather than a rule somebody has to remember, which is what phase 4
acceptance 3 asks for. Storage is a dict on the GeoNames id plus two parallel lists, one of folded
keys sorted lexicographically and one of matching cities, searched with `bisect.bisect_left`. No
search library and no trie. Measured on 2026-08-20 against the real 34,099-row file over 2,000
iterations: `"London"` 1.46 microseconds median, and the worst case in the whole design, the
one-letter query `"l"` that matches thousands of rows, 347 microseconds. The plan's budget is 300
milliseconds.

The other two mover layers walk the same eight steps with one difference each. Vessels insert
a merge between step 4 and step 5: every provider is fetched concurrently, the results are
merged on MMSI in `services/union.py`, and the store is fed one record per ship carrying the
providers that saw it. Satellites stop at step 5 and hand the browser element sets rather than
positions, for the reasons below.

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

A mover layer is the union of what its providers return, merged on the existing identity: the
ICAO 24-bit address for aircraft, MMSI for vessels (ADR 010). Failover still exists inside a
provider; coverage across providers is additive.

**The vessel layer is where this is actually built.** One poller drives up to three providers,
Fintraffic Digitraffic, aisstream.io and AISHub, merges them on MMSI in
`services/union.py`, and writes one record per ship carrying the list of providers that saw
it and the age of the winning report. A provider with no credential is left out of the union
entirely rather than added and failed every cycle, so an unconfigured AISHub does not make the
layer read degraded forever: it reports itself unavailable from `/api/capabilities` instead. A
provider that errors drops out of that cycle, is named on `/api/layers`, and the layer reads
degraded rather than healthy.

**The aircraft layer is a union with one live member**, and that is a source-access problem
rather than a code one. Phase 3 built it: `_register_aircraft_pollers` (`app.py`) polls its
members concurrently, merges them on the ICAO 24-bit address through the same
`services/union.py` the vessel layer uses, writes the provider list onto every record, and
reports per-provider coverage on `/api/layers`. The membership is a table, `UNION_PROVIDERS` in
`sources/adsb.py`, so adding a provider is a row plus a base URL rather than a code change.

What is missing is providers, not machinery. adsb.lol is the only one we can reach and serve.
adsb.fi is a failover only, because its licence is non-commercial, which is R3 in
`docs/pending-decisions.md`. ADS-B Exchange answers HTTP 401 without a paid key and prohibits
redistribution, and serving positions to a browser is redistribution. airplanes.live answers
HTTP 403 until an email is answered. adsb.one is Cloudflare-blocked. All four re-verified live
on 2026-08-20. So ADR 010's coverage argument has no second member on the aircraft side today,
and the provider-attributable count is reported as zero rather than hidden.

**Cadence is per provider and it is what makes this more than a second base URL.** Each row in
the table carries its own floor as a constant: adsb.lol 5s, airplanes.live 1s stated by the
provider, ADS-B Exchange 260s. The last one is not a rate at all, it is a monthly quota of
10,000 requests divided into a month, which is why that provider is marked demand-driven and is
excluded from the sweep and from the cycle floor. A metered key on a five-second sweep spends
its month in fourteen hours.

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

**Two fields name a provider and they are not the same field.** `Aircraft.source` is set by the
adapter to the host that actually answered, so a failover inside a client shows up there.
`Aircraft.providers` is set by the union wiring (`app.py:610`) to the configured union member's
name, so a failover does not show up there at all. On a live run on 2026-08-20 the adsb.fi
failover fired and the layer served 62 records reading `source: adsb.fi` alongside
`providers: ["adsb.lol"]`, with the provider row on `/api/layers` crediting adsb.lol for a cycle
adsb.fi supplied in full. The card reads `source` and the layer rail reads the provider list, so
the two surfaces credit different providers for the same aircraft. That matters beyond tidiness,
because adsb.fi is licensed non-commercial and its attribution is not interchangeable with
adsb.lol's ODbL. Recorded as a defect in `docs/status.md`; not fixed.

**Recency has to hold across cycles, not just inside one.** The merge resolving recency and
the store then taking whatever it was handed is not enough, and the gap is not theoretical: a
provider dropping out on its own cadence floor let an older fix, re-served inside its own
lookback window, replace a newer position already held, which walked a ship backwards on the
globe and pushed the regression out in the next delta. The guard is on `EntityStore` itself as
an optional fix time (`services/store.py:64`), so every layer gets it from one place rather
than the vessel path getting it alone.

**One record per identity is asserted by a test, not assumed.** The obvious bug in a union is
one asset counted once per provider. Note also that the merge key has to be validated, not
trusted: MMSI 999999999 is a placeholder rather than an allocation and two ships broadcasting
it would collide into one record while the one-record-per-MMSI test still passed, so a
non-conformant MMSI is dropped and counted rather than merged on.

## The deliberate exception: satellites

Satellite positions are computed in the browser, not on the server.

The backend fetches CelesTrak orbital element sets and caches them. The browser runs SGP4
via `satellite.js` and propagates every satellite every frame. Three things make that the
right call: element sets change on a scale of hours while positions change every
millisecond, so serving positions would mean pushing thousands of updates a second for
data the client can derive; time-scrubbing becomes free, because changing the clock just
re-propagates; and there are zero runtime API calls, which matters most for the one
provider that bans clients permanently.

Propagation runs in a Web Worker (`frontend/src/globe/satellites/worker.ts:31`), not on the
render thread, because the target is the whole active catalogue at 60fps and SGP4 for ten
thousand objects costs 14 ms a tick. Positions cross back as transferred typed arrays and the
layer mutates one `PointPrimitiveCollection` in place.

Two details in `frontend/src/globe/satellites/orbit.ts` are load-bearing. SGP4 returns TEME, and
turning that into an earth-fixed position is one rotation by Greenwich Mean Sidereal Time at
**the same instant**: a 60-second mismatch moves every satellite 0.25 degrees of longitude, about
28 km at the equator, with no error and no NaN. One function does both steps from one `Date`, so
there is no separate rotation step to get wrong. And nothing on an OMM record says an element set
is decayed, so a satellite is dropped from the collection when SGP4 refuses it or when its epoch
is more than 3.5 days old, and the count next to the layer is the count actually drawn.

This is the only place the browser does its own physics. Everything else it draws was
validated server-side.

**Two server-side copies, and they answer different questions.** The CelesTrak client holds
the element cache, which is what `/api/satellites/elements` serves as a tab's initial load.
The satellites `EntityStore` looks like a duplicate and is not: it is the delta channel for
that cache, so a refreshed element set or a decayed object reaches an open tab without a page
reload. Delete the registration and every open browser propagates whatever it read at load
time for as long as it stays open.

**An empty cache must never reach the store.** `replace_all(())` deletes every satellite and
tells every browser to remove it, on a poll that would otherwise report healthy with a count
of zero. Two guards close it. The adapter refuses an all-dropped refresh, so a good cached
group survives a shape change upstream rather than being overwritten by nothing
(`sources/celestrak.py:267`). And availability is computed from cached element sets rather
than from cache keys, because a dict holding one empty group is truthy and used to publish
`available=True` over a layer with nothing to draw (`sources/celestrak.py:332`). With the
cache empty the layer reports itself unavailable with the provider's own error on it, which is
what a running server does today.

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

One store per layer, four of them, not one shared store. The viewport feed and the worldwide
military feed would otherwise fight: `/v2/mil` is a complete world picture, so `replace_all`
is correct for it, and running `replace_all` over a merged store would evict every locally
seen aircraft on every military poll.

Which write method a feed uses is a design decision, not a preference. `replace_all` is for a
feed that publishes a complete world each poll. `upsert_many` is for everything else, and the
vessel union needs it specifically: each provider covers its own patch of sea, so replacing
would delete every ship only a missing provider could see.

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

**Two things were wrong with that and both are now fixed.** The floor only held inside one
process, so stopping and starting the app produced a fresh floor every time; it is now written
to the disk cache on every attempt and read back on construction
(`services/poller.py:118`). And a throttle absorbed by a failover never reached the poller at
all, because a successful failover is not a failed poll: adsb.lol asked for 120 seconds on
`/v2/mil`, adsb.fi answered, and the next cycle called adsb.lol again 65 seconds in. The
provider's figure is now honoured where the response arrived, per provider, and shared between
the two adsb.lol clients because a 420 binds the egress address rather than the endpoint
(`sources/adsb.py:735`).

### The incident that justifies the provider-swap interface

On the first live run of this app, adsb.lol answered `/v2/mil` with HTTP 420 and the
adsb.fi failover carried the military layer with no code change. The failover is
`AdsbClient._get` (`sources/adsb.py:331`): it catches transport errors, rate limiting, 5xx
and contract violations, then retries the same path against the secondary base URL. Both
providers serve the readsb v2 schema, so the same parser handles both and swapping is a
base-URL change (`config.py:64`, `config.py:65`).

That is the interface earning its keep on day one. It also found its own limit and then paid
for the fix. Failover replays the same path against the secondary provider, so a
provider-specific path silently disables failover for that call, and adsb.lol's viewport path
`/v2/point/{lat}/{lon}/{nm}` is adsb.lol only: adsb.fi answers 400 for it. Only `/v2/mil`
survived, because it happens to be path-identical. The fix is one path both providers accept,
`VIEWPORT_PATH_TEMPLATE` at `sources/adsb.py:56`, and it was seen working live twice on
2026-08-20: adsb.lol answered 420, adsb.fi answered 200 on the same path, and the layer kept
its aircraft. Evidence in `docs/status.md`.

The lesson generalises past this one path. Any per-provider difference on a shared code path
turns a failover into a second failure, and it does so quietly, because the primary's error is
what gets logged.

Jitter (`services/poller.py:34`) spreads every sleep by 15%, so pollers started together
do not synchronise into a burst against one provider.

## Search: local first, and the geocoder is the exception

One field resolves everything, so `/api/search` is the only navigation this globe has. The rule
that keeps it inside Nominatim's usage policy is a fall-through with two guards, all of it in
`services/search.py:496`.

Four local groups are scanned first, every one of them in process: aircraft by callsign,
registration and hex, vessels by name, MMSI and IMO, satellites by name and NORAD number, and
cities out of the gazetteer. **If any local group returned a hit, Nominatim is not consulted at
all.** So a city query never leaves the process, which is what makes the OSMF's "systematic
queries are unacceptable use" line survivable: a typeahead firing on every keystroke costs the
provider nothing.

The two guards on the fall-through are the part that is easy to get wrong. First, an **empty**
gazetteer blocks the geocoder rather than opening it: with no cities indexed, "every local group
came back empty" is not evidence that the query needs an address lookup, and answering it remotely
would point the typeahead at Nominatim for every city query for as long as the download is down.
The response carries the cities group with that reason instead. Second, the distinction between an
empty gazetteer and an absent one is deliberate. `AppState` always wires an index, so empty means
the weekly download has not landed; `None` means a deployment built without a city group at all,
which is a choice rather than a fault and leaves the geocoder to do its own job.

Degradation follows the same shape as a missing feed key, and Nominatim is the one keyless source
that still has a gate: it needs contact details in the User-Agent under the OSMF policy, so with
no `TRACKER_CONTACT_EMAIL` the client is not built. `/api/capabilities` then reports
`places` unavailable with the reason, the cities layer stays available, and a query only a geocoder
could answer comes back as a `places` group with zero hits and its reason attached. A group with no
hits and no reason was asked and found nothing; a group carrying a reason could not be asked. That
one distinction is why the search box can tell "no such place" apart from "the geocoder is off",
and it is asserted live in `docs/status.md`.

Every reason string is clipped to `MAX_REASON_CHARS` on the way out. That is not tidiness: a
review found `/api/search` answering HTTP 500 when a long query hit a failing geocoder, because
the reason string built from the query overflowed its own 300-character contract.

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

**The registry join is demand-driven, and `GET /api/aircraft/{icao24}` is the only route in
the product that reaches an upstream.** Phase 3 built the first enrichment: `services/enrich.py`
holds one generic `Enricher` over domain contracts with the lookup, the merge and the identity
injected, and `sources/adsbdb.py` supplies all three for aircraft. It is not a poller and it
must not become one: adsbdb allows 512 requests a minute per IP and a live aircraft layer is
several hundred records a cycle, so a sweep would be throttled inside the first poll and would
tell the card nothing it needed. A card asks about one aircraft, that aircraft is looked up, and
the answer is cached per identity with a one-day time to live. Four card opens on one address
cost one request, measured on a live run.

Three rules make that safe rather than merely cheap. **The feed keeps every attribute it
supplied** and the registry's value is kept beside it as a conflict rather than dropped, because
adsbdb carries no as-of date and ADR 008 does not let an undated claim displace a timestamped
one; that also makes it structurally impossible for enrichment to move an aircraft or restamp
its observation. **A registry fault degrades the card to feed-only data and never to an error**,
so an aircraft with no owner still renders with its position, callsign, type and class. And
**a failure is never remembered**, so the next card open is a real attempt rather than a cached
"this does not exist".

**A cache of a personal attribute needs a way out of it.** A registered owner is a named
individual on a great many N-numbers, so this cache holds personal data with a one-day life, and
ADR 008 makes a removal immediate with no queue and no human step. `AdsbdbLookup.forget`
(`src/tracker/sources/adsbdb.py:592`) empties it by identity rather than by key, because one
answer is remembered under the requested key, the record's own address and its registration, and
clearing one of the three would report success while the name stayed reachable by the other two.
Phase 6 owns the suppression register that stops the next lookup fetching the name again; this is
only the hook it will call.

**Classification is a service, not adapter code.** `services/classify.py` resolves the display
class from what the feed reported, in a fixed precedence, and the adapter calls it on the way
into the domain so no record ever reaches a store unclassified. It reads `tracker.contracts`
only, so the direction of the dependency cannot cycle, and it is idempotent so the union can
re-apply it after a merge without allocating.

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
- **One thing owns the camera at a time.** Follow mode
  (`frontend/src/globe/follow.ts:108`) locks it to the selected entity and reads that
  entity's last reported fix out of the store, extrapolated the way the layers extrapolate,
  rather than holding a primitive: a layer pools and reuses its primitives, so a held
  reference can end up pointing at another aircraft's. Manual camera input takes it back at
  once (`frontend/src/globe/follow.ts:122`): a pointer drag past four pixels, or any wheel
  or pinch zoom. A click is not manual input, because clicking is how an entity gets
  selected. A search fly-to disengages it too.
- **The URL carries the camera and the layer switches, and nothing else.** In the hash, so
  it never reaches the server, written with `replaceState` on `moveEnd`
  (`frontend/src/state/url.ts:229`) and longitude first like every other coordinate in this
  project. Entities are left out because they have moved by the time the link is opened.
  A hash that does not parse leaves the globe on its opening view, and a layer named in one
  that this deployment does not have is dropped rather than erroring
  (`frontend/src/ui/layer-rail.ts:353`), so a shared link always opens.

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

A **new provider for a layer that already exists** is smaller than that. On the aircraft
layer it is one row in `UNION_PROVIDERS` (`sources/adsb.py`) carrying its name, its own cadence
floor, whether it filters, whether it can be swept, the names of the settings holding its base
URL and any failover, and the name of the setting that clears its gate, plus those settings in
`config.py`. The wiring reads all of it off the row: nothing compares a row against a named
constant, so a new row gets its own host, its own name on every record it supplies, and its own
gate honoured. Its terms belong in `docs/data-sources.md`, which is the source of truth for
them, and its credit in `ATTRIBUTIONS` (`app.py`).

Then the tests: a parser test against a recorded real payload in `tests/fixtures/`, and a
cadence test asserting the floor holds. Refresh the wire contract with
`uv run python scripts/dump_openapi.py` and regenerate the frontend types, because CI
fails on drift.
