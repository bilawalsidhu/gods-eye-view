# Tracker: working conventions

A real-data situational-awareness globe. CesiumJS frontend, FastAPI backend.
One backend process owns every upstream feed; the browser only ever talks to us.

**Why it exists.** A demo of wealth profile enrichment for Altrata, built on public data
only. The business collects data on people and organisations, resolves it to one profile,
joins it up and sells the insight. The population is the wealth tiers: UHNW over $30m,
VHNW $5m to $30m, HNW over $1m, plus Likely UHNW and Likely VHNW on partial valuations.
Use those exact terms, one tier per profile, higher tier wins. This project rebuilds the
profile-to-asset join from public sources. Read
[business context](docs/business-context.md) before changing anything user-facing.

## Where it runs

**One laptop with an internet connection. No cloud infrastructure, ever.** Stated by Alexander
Fanthome on 2026-08-20 and it is a hard constraint rather than a current stage. ADR 015 already
says it for inference; this says it for everything.

- **Disk persistence is expected and encouraged.** Caches, a local SQLite database, downloaded
  bulk files, proxied media, embedding blobs. `uv run tracker` plus a browser is the whole
  deployment. The GeoNames dump caches to disk (`config.py:182`) and that is the pattern.
- **No managed service and no cloud SDK.** No AWS, no Databricks, no S3 for our own storage, no
  Postgres or Redis or a message queue, no cloud inference, no paid model API. Verified clean on
  2026-08-20: nothing in `pyproject.toml` and no reference in `src/` or `frontend/src/`.
- **Reading someone else's bucket over HTTPS is not cloud infrastructure.** earth-search's
  Sentinel-2 assets and the TfL JamCam stills both sit on S3, and fetching them is an ordinary HTTP
  request. The rule is about what *we* run, not about where a public feed happens to live.
- **The things a later phase will reach for, and must not.** A vector database (ADR 015 says
  numpy over blobs in the existing SQLite file until a brute-force scan is *measurably* too slow,
  and the measurement is the gate), a search server, a cache server, a task queue, or object
  storage for the media proxy. Each of those has a local answer already in the tree or a few lines
  away. If one genuinely cannot be done locally, that is a blocker to report rather than a reason
  to add infrastructure.

## Commands

```bash
uv sync                                  # install backend + dev tools
uv run tracker                           # serve backend on :8000
uv run pytest                            # tests, branch coverage, fail_under=85
uv run ruff check . && uv run ruff format --check .
uv run ty check                          # fast type check, runs on every commit
uv run mypy                              # strict, the correctness gate in CI
uv run python scripts/dump_openapi.py    # refresh openapi.json (committed)
cd frontend && pnpm dev | pnpm test | pnpm lint | pnpm typecheck | pnpm codegen
```

Both type checkers run and neither replaces the other. ty is quick and is right about
`@computed_field` over `@property`, where mypy reports a false `prop-decorator` error.
mypy with the pydantic plugin catches constructor arguments on a generic pydantic model,
for example `Env[int](payload="x")`, which ty passes clean. ty does not honour mypy's
coded `# type: ignore[...]`, so a line needing both carries both, mypy first:
`# type: ignore[arg-type]  # ty: ignore[invalid-argument-type]`. Reversing that order
stops mypy honouring its own ignore.

Verification before claiming anything is done:
`uv run ruff check . && uv run ruff format --check . && uv run ty check && uv run mypy && uv run pytest -m "not live" && (cd frontend && pnpm verify)`

## Layout

- `src/tracker/contracts/` strict Pydantic domain models, one module per entity class
- `src/tracker/sources/` one adapter per upstream feed, permissive wire models inside
- `src/tracker/services/` store, hub, pollers, enrichment, classification, search
- `src/tracker/api/` FastAPI routers
- `frontend/src/globe/` Cesium viewer and one module per render layer
- `tests/fixtures/` recorded real upstream payloads, used by tests only
- `docs/` architecture, data sources, status, decisions, plan, spec

## Geospatial conventions

Non-negotiable. Violations are bugs even when the code appears to work.

- Coordinate order is `[longitude, latitude]` in every contract, GeoJSON style.
- WGS84 / EPSG:4326 throughout the domain. Cesium owns all projection.
- Degrees in contracts. Radians only inside orbital maths, converted at the boundary.
- Altitude in metres above the WGS84 ellipsoid. Feeds sending feet are converted in the
  source adapter, never downstream.
- Times are timezone-aware UTC, ISO 8601 in contracts. A naive datetime is a validation
  error; use `contracts.base.UtcDatetime`.
- Bearings are degrees clockwise from true north, `0 <= x < 360`.

## Contract discipline

Two layers, and the boundary between them is the point.

- **Wire models** live inside a `sources/` adapter, are permissive (`extra="ignore"`),
  and mirror exactly what the upstream sends including its inconsistencies.
- **Domain contracts** live in `contracts/`, derive from `StrictModel`
  (`strict=True, extra="forbid", frozen=True`), and are what the rest of the app sees.
- The adapter maps wire to domain explicitly. A record that will not map is dropped and
  counted, never partially accepted.

Reason: `/v2/mil` returns eight fields `/v2/point` does not. A strict model at the wire
layer would reject every military aircraft; a permissive model in the domain would let
junk reach the renderer.

## Gotchas

Each of these has already cost time or would break something silently. Grouped by data class so
the section stays navigable.

### Aircraft and ADS-B

- `adsb.lol` `alt_baro` is a number **or** the string `"ground"`. `flight` is
  space-padded (`"RAM801F "`). `type` is the message source (`adsb_icao`), the aircraft
  type designator is `t`, and the registration is `r`.
- **The readsb envelope's `now` is milliseconds on adsb.lol and seconds on adsb.fi.** Same
  field name, same schema, different unit, and nothing in the payload declares it. Dividing
  adsb.fi's value by a thousand dates the whole batch to 1970 and the aircraft then lose every
  recency contest in the provider union, which is provider precedence arriving by accident.
  Decided on magnitude in the adapter, not assumed. Verified 2026-08-19 against both captures.
- Heading resolution order: `track`, then `true_heading`, then `mag_heading`, then `dir`.
  Only about half of live records carry `track`.
- `dbFlags` bit 1 (value 1) is military, bit 2 is interesting, bit 4 is a privacy ICAO address
  and **bit 8 is LADD**. A PIA aircraft is displayed anonymised until phase 11 correlates it to
  a registration, per ADR 009. The PIA flag stays on the record after correlation and the card
  says the identification is inferred, never observed.
- **The LADD bit is real and it is where the LADD attribute comes from.** Corrected 2026-08-20:
  an earlier version of this line listed bits 1 and 4 and said nothing about bit 8, which is how
  the repo came to believe the LADD flag had no source (U1 in `docs/pending-decisions.md`, now
  closed). readsb documents `LADD = dbFlags & 8` and adsb.lol publishes `/v2/ladd` on top of it:
  249 aircraft, 248 at `dbFlags` 8, verified live. 26 of 539 aircraft in a New York viewport
  carried it, so it arrives on ordinary position queries. The flag is still **not applied** as a
  suppression: LADD binds FAA-provided feeds and our positions come from volunteer receivers, so
  per ADR 009 a LADD aircraft resolves to its owner and renders like any other, with the flag as
  an attribute on the card. What we carry is the provider's assertion sourced from the FAA list,
  not the FAA list: the FAA issues `IndustryLADD` monthly through `adx.faa.gov` only to Service
  Consumers who have signed its terms, and `faa.gov/pilots/ladd` answers 403 to our client.
- **49 U.S.C. section 44114(b) is a third FAA privacy programme that ADR 009 never mentions.**
  It operates on the registry rather than on flight data: 4,773 of 316,030 FAA `MASTER.txt` rows
  arrive with the owner name blank and 4,771 with the street blank. The withholding happened
  upstream, so there is nothing to work through and no suppression logic to find. The record
  arrives empty, is dropped and counted. Recorded next to the FAA row in `docs/data-sources.md`.
- **The FAA's own `IndustryLADD` list is not the route and must not be taken.** It exists on
  `adx.faa.gov`, published the first Thursday of each month, but the FAA states that vendors
  subscribing to its SWIM feeds "are bound by a Data Access User Agreement to filter any LADD
  participant from public display of aircraft flight data", and that agreement is the only route to
  it. Taking it would bind us to hide exactly the aircraft a wealth profile is about, which is the
  coverage ADR 010 exists to gain. We do not need it: `dbFlags & 8` on the feed already carries the
  flag, sourced from the FAA list by the aggregator rather than handed to us under terms. Consume
  the bit, never the list.
- ADS-B Exchange does not filter aircraft on FAA blocking programmes, which is why it is in
  the union. Access is a paid RapidAPI key (`adsbexchange-com1.p.rapidapi.com`, verified 401
  without one) or a free feeder key. Its terms **prohibit redistribution**, and serving
  positions to a browser is redistribution, so that is a licence blocker on the layer.
- **Never touch the ADS-B Exchange globe map endpoints.** `/data/aircraft.json` and `/re-api/`
  answer 403 "Request forbidden by administrative rules", and `robots.txt` disallows `/api/`,
  `/mapproxy/`, `/re-api/` and `/globe_history/` by name. The API is the only way in.
- airplanes.live answers 403 until you email them a project description; adsb.one was
  Cloudflare-blocked from our network on 2026-08-19. Both serve the same readsb v2 schema, so
  neither needs parser work once access lands.
- Per-provider cadence floors, not one global floor, and they are constants in
  `sources/adsb.py` on the provider row rather than in configuration. adsb.lol is 5s and
  airplanes.live states 1s. **ADS-B Exchange is 260s and is never swept at all**, because its
  only published plan is a monthly quota of 10,000 requests rather than a rate: a 5-second sweep
  spends the month in fourteen hours. Its calls are demand-driven, and the union cycle floor is
  taken from the swept providers only, or one metered key would slow the whole layer down.
- **The aircraft union has exactly one live member and that is the honest position.** adsb.lol
  is keyless and answers. ADS-B Exchange answers 401 without a paid key and prohibits
  redistribution anyway. airplanes.live answers 403 until an access email is answered. adsb.one
  is Cloudflare-blocked. adsb.fi is the failover inside the adsb.lol client and not a member,
  per R3. So the provider-attributable count for every unfiltered provider is zero, and
  `/api/layers` reports the zero rather than omitting the number.
- **The FAA and CASA registry hosts both refuse the descriptive User-Agent this file mandates.**
  FAA answers HTTP 403 host-wide from Akamai, `robots.txt` included, while permitting the
  download path in the robots file it will not serve. CASA hangs until timeout with zero bytes,
  and a bare Chrome string is not enough: only the full browser header set gets a reply. So on
  CASA a block looks like a network fault rather than a refusal and the difference has to be
  logged. **Decided 2026-08-20: use `cloudscraper` for these two.** Where `robots.txt` permits a
  path and the CDN refuses the User-Agent, the `robots.txt` governs: a CDN bot filter is not a
  stated directive. The rate discipline is unchanged, so the FAA zip is still a conditional
  once-a-day fetch on `Last-Modified`. Recorded with its limits as U3 in
  `docs/pending-decisions.md`. Verified 2026-08-20.
- **cloudscraper gets the FAA zip on a GET and answers 503 on a HEAD, so a freshness check that
  uses HEAD reports the source down.** Measured 2026-08-20 against
  `registry.faa.gov/database/ReleasableAircraft.zip`. A descriptive User-Agent gets 403 on both
  verbs. Through cloudscraper: `HEAD` returns **HTTP 503** with a 3KB HTML body and a decoy
  `Last-Modified` of 2013, while `GET` returns the real file. So the daily freshness check is a
  **conditional GET**, never a HEAD. `If-Modified-Since` with the held value returns a real
  **HTTP 304 with zero bytes**; with a stale value it returns 200, or 206 for a ranged request.
  Ranged requests work, which is how you test without pulling the file. The real figures: full
  size **73,046,130 bytes**, `Content-Type: application/x-zip-compressed`, and `Last-Modified`
  moved to 04:58 UTC on the day it was checked, consistent with the documented 23:30 US central
  daily rebuild. The browser profile makes no difference: default, chrome/windows, firefox/linux
  and chrome/darwin all behaved identically.
- **`cloudscraper` is for bot filters and never for a stated directive, and the difference is the
  whole rule.** It is a project dependency and the right tool for the FAA and CASA CDN blocks and
  for Cloudflare-blocked adsb.one. It is **not** for airplanes.live, whose 403 asks us to email a
  project description and tells us exactly how to get in, and it is **not** for the ADS-B Exchange
  globe map, which answers 403 "Request forbidden by administrative rules", disallows those paths
  by name in `robots.txt`, and prohibits redistribution in its terms. Three independent reasons
  there, none of them a User-Agent problem. Where a provider states a route in, that route is the
  route in.

### Vessels and AIS

- **Digitraffic `timestamp` means two different things on two endpoints of the same API
  version.** On `/api/ais/v1/locations` it is the AIS UTC second-of-minute, 0 to 63, where 60
  means not available, 61 manual input, 62 dead reckoning and 63 inoperative. On
  `/api/ais/v1/vessels` the identically named field is a 13-digit millisecond epoch. The
  provider says so itself. Parsing the locations field as a time produces 1970 and every vessel
  loses every recency contest in the union. The real time on `/locations` is `timestampExternal`.
  On the MQTT `location` topic it is `time` and it is a 10-digit epoch in seconds, while MQTT
  `metadata` uses `timestamp` in milliseconds. Four names, three units, one API.
- **Digitraffic's default response is 24 hours of history, not a live snapshot.** The OpenAPI
  document says `from` "Default value is 24 hours in the past", and the oldest record in a bare
  call was 23 hours 42 minutes stale. A poller that calls the bare endpoint and renders
  everything shows a day of ghost ships parked where they were yesterday. Pass `from`
  explicitly, or filter on `timestampExternal` in the adapter. The same default applies to
  `/api/ais/v1/vessels`.
- **Digitraffic silently ignores `bbox`.** `?bbox=17,57,32,66` answered HTTP 200 with 1,059
  features, which is the whole world set, not a filtered one. There is no `bbox` parameter in
  the OpenAPI document and unknown query parameters are dropped rather than rejected with a 400.
  The real spatial filter is `radius` in kilometres with `latitude` and `longitude`, verified at
  70 features for a 50km circle on Helsinki.
- **The Digitraffic vessel feed contains aircraft.** Two records carried MMSI 111265583 and
  111265584, named LIFEGUARD 003 and LIFEGUARD 004 with Swedish aircraft registrations, one
  doing 36 knots. The ITU allocates the `111` prefix to SAR aircraft. Filter on the prefix or
  the ship layer gets helicopters in it. Other reserved prefixes to expect: `00` coast station,
  `0` group, `99` aid to navigation, `98` auxiliary craft, `970`/`972`/`974` SART, MOB and EPIRB.
- **MMSI 999999999 is a placeholder, not an allocation, and it defeats ADR 010's own test.**
  `/api/ais/v1/vessels/999999999` returns a real record named NATO WARSHIP. Two warships
  broadcasting it collide into one record, and because ADR 010 makes MMSI the vessel merge key
  the one-record-per-MMSI test passes while silently swallowing ships. A clean snapshot had zero
  MMSI duplicates across 1,058 records, so it is intermittent rather than constant, which makes
  it worse. Validate the MID against the ITU table and drop-and-count a non-conformant MMSI
  rather than merging on it.
- **Digitraffic's own documentation gives the wrong MQTT topic.** It documents
  `vessels-v2/<mmsi>/locations`. Subscribing to `vessels-v2/+/locations` is **accepted with
  granted QoS 0** and delivers zero position messages, while `vessels-v2/status` works fine. The
  real leaf is **`location`, singular**, read off the wire from `vessels-v2/#`. The broker grants
  a subscription to a topic that will never publish, so the failure mode is a layer that
  connects, reports healthy and renders nothing. The provider also writes `vessels/status` where
  the live topic is `vessels-v2/status`.
- **The Digitraffic MQTT payload is not the REST payload.** `lat` and `lon` are separate scalar
  fields rather than a GeoJSON array, so the `[longitude, latitude]` rule does not apply and a
  shared REST/MQTT parser gets one direction wrong. There is **no `mmsi` field at all**: the
  MMSI exists only in the topic string. `refA` to `refD` replace `referencePointA` to `D`, and
  `type` replaces `shipType`, so `type` means three different things across this one API.
- **`draught` is decimetres on `/api/ais/v1/vessels` and metres on
  `/api/port-call/v1/vessel-details`.** Same word, two units, two endpoints, one host. 49 means
  4.9m on the first and 8.15 means 8.15m on the second. 255 means "25.5m or greater" and 0 means
  not available, so a saturated reading is not a measurement.
- **Digitraffic sentinels, and nothing is ever null or absent.** Out of 1,058 records: `cog`
  360.0 on 110, `sog` 102.3 on 9, `heading` 511 on 184, `rot` -128 on 184, `navStat` 15 on 47.
  `rot` of 127 or -127 mean turning faster than 5 degrees per 30 seconds, not a rate. `cog`
  legitimately reads 0.0, so 360.0 is the only not-available value and a naive `0 <= x < 360`
  bearing check rejects 110 real records rather than mapping them to `None`. On the metadata
  endpoint, missing text is an **empty string**: `destination` is empty on 91 of 950, so a
  `min_length=1` strict field drops 91 real ships. `eta == 1596` is the AIS not-available value
  and is the single most common value in the body, 198 of 950.
- **Kystverket's talker ID is `BSVDM`, not `AIVDM`.** 1,690 `BSVDM`, 27 `B2VDM`, 25 `B1VDM` and
  **zero `AIVDM`** across a real 1,742-sentence capture, despite Kystverket's own documentation
  calling them AIVDM sentences. Any parser keyed on the literal `!AIVDM` matches nothing at all.
  A third of the traffic is multipart type 5 static data and that is where the vessel names, IMO
  numbers and destinations live, so a decoder that skips multipart sees positions and never a
  single ship name. The IEC 62320-1 TAG block has its own checksum and must be stripped before
  the sentence checksum is validated, and its `c:` field is a 10-digit epoch in seconds against
  Digitraffic's 13-digit milliseconds.
- **AISHub only grants API access to members running a physical AIS receiver**: at least 10
  vessels averaged over 7 days, 90% uptime, downsampling no coarser than 60s, delay under 10s,
  streamed as raw NMEA to a UDP port they allocate. Feeding them synthesized NMEA, scraped
  data or data from other public AIS services is prohibited by name, so there is no software
  route in. No username means the layer reports itself unavailable, like any missing key.
- **AISHub signals a bad username with HTTP 200 and a 115-byte JSON error envelope, not an empty
  body**:
  `[{"ERROR":true,"USERNAME":"...","FORMAT":"HUMAN","ERROR_MESSAGE":"Invalid username or password!"}]`.
  The check is `body[0]["ERROR"] is True`, with `ERROR_MESSAGE` carrying the reason. The response is an array whose element 0 is a status envelope either way, so a success
  body is an envelope followed by the vessel data and `for vessel in response` iterates the
  metadata as if it were a ship. Corrected 2026-08-20: an earlier version of this line claimed
  the failure body was empty, which is verified wrong for a bad username. The
  empty-body-on-over-frequent-calls half of that claim is untested, not disproved. Either way an
  empty or error 200 is a failed poll, counted, and it never empties the vessel store. Asserted
  by a test.
- AISHub `output` defaults to XML, so pass `output=json` explicitly, same trap as CelesTrak's
  `FORMAT`. Use `format=1` for degrees, knots and metres; `format=0` scales longitude and
  latitude by 600000, course and speed by 10, draught by 10.
- AISHub sentinels are not nulls: course 3600 (or 360.0), speed 1024 (or 102.4), heading 511
  and `IMO` 0 all mean "not available" and map to `None`. Its timestamp is `TIME` in JSON but
  `TSTAMP` in XML and CSV, and the human-readable form is naive with a `GMT` suffix, so attach
  UTC in the adapter.

### Satellites

- CelesTrak permanently firewalls abusive clients. Never fetch a group more than once per
  two-hour window. The guard is in code and asserted by a test, not left to config.
- CelesTrak `EPOCH` is naive but is UTC by specification. Attach UTC in the adapter.
- Always pass `FORMAT` explicitly to CelesTrak; the default changed to CSV in May 2026.
- **CelesTrak OMM breaks on our own timestamp format and it does not throw.** `json2satrec`
  appends a `Z` when the string lacks one, so a Pydantic-serialised `+00:00` becomes `+00:00Z`,
  `new Date()` rejects it and the satrec comes back full of `NaN`. Measured: the naive CelesTrak
  string and the `Z` form both give `jdsatepoch=2461272.03387`; `+00:00` gives `NaN`. Every
  satellite lands at NaN and renders as an empty layer, with no error anywhere. Attach UTC in
  the adapter, serialise as `Z`, and assert it with a test. Also: `json2satrec` consumes
  CelesTrak OMM directly, so do not synthesise TLE lines, and a TLE path silently misses every
  object catalogued since 2026-07-11 because catalogue numbers are now 6 digits and the format
  has 5 columns.
- Satellite positions come out of SGP4 in TEME. Convert to ECEF via GMST at the *same*
  timestamp or the whole constellation smears diagonally.

### Places, imagery and events

- **The USGS third coordinate is depth in kilometres, positive downward, and it is not an
  altitude.** Fixture range is -0.85 to 165.5. Under this project's metres-above-the-ellipsoid
  rule the conversion is `altitude_m = -depth_km * 1000`. Straight assignment puts a 165km-deep
  earthquake 165 metres above the ground. A negative depth is legal and means above sea level.
  Its `bbox` is six elements with depth interleaved,
  `[minlon, minlat, mindepth, maxlon, maxlat, maxdepth]`, so `bbox[2]` is not a latitude and must
  never be fed to `BoundingBox`.
- Sentinel-2 scenes come from earth-search STAC, keyless, `POST /v1/search` with `collections`,
  `bbox` and `datetime`. **Filter on `eo:cloud_cover`, and do it with the legacy STAC `query`
  extension**: earth-search's `conformsTo` list carries no CQL2 class and it **silently discards
  a `filter-lang: cql2-json` filter and answers HTTP 200**. A cloud-cover filter sent as CQL2
  returned 174 matches with the first five at 100% cloud, where
  `{"query": {"eo:cloud_cover": {"lt": 20}}}` with
  `"sortby": [{"field": "properties.eo:cloud_cover", ...}]` returned 36. Both London scenes on
  2026-08-18 came back at essentially 100% cloud, and an unfiltered search returns white
  rectangles that look like a broken layer. `eo:cloud_cover` arrives as an `int` or a `float` in
  the same response, which a `strict=True` float field rejects, and `proj:centroid` is
  `{lat, lon}` while everything else in the payload is longitude first. Revisit is about five
  days, so imagery for a requested date usually does not exist. Carry the scene's own timestamp,
  never the requested one. `visual` is a Cloud-Optimised GeoTIFF and cannot go straight to a
  browser.
- GeoNames `cities15000` is a tab-separated bulk file with no header and 19 fixed columns,
  UTF-8 with no BOM, and **34,099 rows**, not the ~26,000 this repo used to claim (GeoNames'
  own readme says "ca 25.000" and is wrong too). Reading it as latin-1 silently mangles every
  non-ASCII place name rather than raising. **Latitude is field 5 and longitude is field 6**
  one-based, index 4 and index 5 zero-based, so latitude comes first and that is the opposite
  of our contract order. An earlier version of this line said column 6 was latitude and
  column 7 longitude, which is wrong under either counting: corrected 2026-08-20 against the
  real file and the provider's own readme. `Last-Modified` and `ETag` are both served, so the
  weekly refresh is a conditional request that normally costs nothing. Cities do not move, so
  this is a weekly download into a local index, never a poller and never a TTL store.
- **A 200 carrying an HTML error page is worse for the GeoNames dump than a 503, and an ETag
  can outlive its zip.** Cached before it is checked, a CDN error page destroys the working
  gazetteer, takes a fresh mtime, and the weekly floor then short-circuits onto the poison for
  a week with no further request, while the discarded reason makes the product report that the
  refresh never ran. Validate the body before writing it, and only send `If-None-Match` when
  the zip it validates is in hand: a validator with no file behind it gets a 304 that is
  unusable by construction. Verified 2026-08-20.
- **A failed city refresh must retry in minutes, not in a week.** The weekly floor is enforced
  in the adapter against the file's own mtime, so the loop's sleep is not what protects the
  provider. Sleeping a week after a refresh that indexed nothing means seven days of no city
  resolving, no label drawn, and every city query falling through to Nominatim.
- Nominatim and Overpass require a descriptive User-Agent with contact details. **Nominatim's cap
  is an absolute maximum of one request per second, caching is mandatory rather than advised, and
  systematic queries are named as unacceptable use by the OSMF**, so the city list comes from the
  GeoNames dump and never from Nominatim. Corrected 2026-08-20: an earlier version of this line
  said "roughly one request per second" for both. Cache server-side; never call from the browser.
- **Nominatim's own backoff has to be stored, not just reported.** A 429 carries `Retry-After`
  and the 403 block page carries nothing at all, so both need a cooldown held on the client:
  computing the figure, raising it and then sending the next query a second later puts 120
  requests inside the window the provider asked us to stay out of while the reason string says
  we are backing off. A 500 is a failure rather than a refusal and keeps the plain floor. Also,
  a 200 whose every record fails to map is a failure and not "no such place", and caching that
  empty answer reports the query as unknown for the life of the process. Verified 2026-08-20.

### People, registries and filings

- **SEC and Companies House both serve a service address that looks like a home address.** SEC's
  `rptOwnerStreet1` and `addresses.mailing` are the **issuer's** address, because insiders file
  at the company. The Companies House PSC `address` is the statutory service address, with the
  residential address suppressed upstream. Ingesting either as a dated home address under ADR 008
  attaches a corporate HQ to a named individual as their residence, and no test catches it.
  Live example measured 2026-08-23: a real Form 4 carried `rptOwnerStreet1` reading literally
  `C/O SPACE EXPLORATION TECHNOLOGIES CORP.`, so the naive read puts a named individual's
  residence at a rocket factory.
- **The profile-to-asset join only runs person to asset, never asset to person, and that is a
  fact about the population rather than a gap in our sources.** Measured 2026-08-23 against this
  project's own live feed: 210 registrations from New York and Texas viewports, 188 returning a
  registered owner, and in the jet-heavy New York sample **44 distinct owners with not one
  natural person among them**. Named individuals do appear, and they own light aircraft: 16 of 54
  light piston owners are people against 3 of 26 for everything else, one of those three being an
  airline brand. The population this project is about holds aircraft through entities, because
  that is what the arrangement is for. Then **75% of the 93 distinct organisation owners resolve
  to nothing at all in Wikidata**, and the 25% that resolve are Delta, Southwest, United, Boeing
  and NetJets, the least interesting records in the set. The ones that matter are `2J2G LLC` and
  `BOHO LLC`: single-purpose companies holding one aircraft with no public footprint by design.
  There is no keyless route from one of those to a person. FinCEN's beneficial ownership registry
  under the Corporate Transparency Act is not public, and the UK alternative fails at the first
  hop because the CAA states that "G-INFO on the web is a read only tool" and the downloadable
  register is a paid CD. So the direction that works is SEC Form 4 to a named person with a
  stable CIK, then `company_tickers.json` across 7,997 listed companies, then an exact owner-name
  match into the FAA registry and onto an aircraft we already track. Every hop is a primary
  record, so under ADR 011 the whole spine asserts. The reachable population is officers and
  directors of US listed companies plus UK persons with significant control, which is real and is
  **not** the wealth tiers.
- **Never name-match a private individual, and this is the measurement that settles it.** Of 23
  registry owners that look like natural persons, only 2 returned any Wikidata candidate at all,
  8.7%, and **both were wrong**: one private aircraft owner in Texas matched three researchers
  and a German Waffen-SS tank commander. Organisation matching is safer and still not safe:
  `SUN COUNTRY AIRLINES` matched `SUNCOR ENERGY INC` in the SEC index and `Bank of America NA`
  matched a Supreme Court case in Wikidata. A bare name is not an identity.
- **No keyless public source carries a current wealth tier or net worth, so every field in the
  tier set sits empty and the product says so.** All of Wikidata holds **2,076 humans with a net
  worth statement**. Of a 900-row sample, **58% cite no source at all**, and among those that do
  the largest single reference host is the Swedish National Archives at 122 against Forbes at 31,
  with the remainder a tail of celebrity-net-worth content farms that copy each other and are
  therefore one origin under ADR 011. The figures are stale: 237 dated 2018, 138 dated 2021, four
  dated 2026. Personal phone is the same shape, 1,497 humans across all of Wikidata and those are
  switchboards. Measured 2026-08-23.
- **Almost every person-level claim collapses to one origin, and there is no middle ground.** SEC
  Form 4 and the issuer's own proxy statement are one origin, both being the company filing about
  itself. Wikidata and Wikipedia are one origin, because the article is usually the statement's
  own reference. So under ADR 011 a claim either rests on a primary record and asserts alone, or
  rests on crowd-sourced data and can never assert. The demo consequence is deliberate: the
  corporate spine is asserted and everything that makes a profile look like a profile renders as
  a scored possible match. That is a lot of grey text on a card, and it is the honest amount.
- **A User-Agent containing the substring `github` is refused by the SEC with a bare HTTP 403,
  and this project's own default User-Agent contains it.** Measured 2026-08-23 on both
  `www.sec.gov` and `data.sec.gov`: `tracker/0.1 (+https://github.com/local/tracker) (a@b.test)`
  gives 403, and so does a bare `tracker/0.1 (github) (a@b.test)`, and so does one naming
  `raw.githubusercontent.com`. Meanwhile `gitlab.com/x` gives 200 and
  `+https://example.invalid/x` gives 200. **It is the substring, not the URL and not the
  parentheses.** Since `config.py` builds the shared User-Agent as
  `tracker/0.1 (+https://github.com/local/tracker) (contact)`, every SEC request from a client
  using the shared header is refused, and the refusal reads as a bare 403 rather than as
  anything resembling a policy statement, so it looks like a network fault or a rate limit. Do
  not change the shared header to suit one provider: `sources/sec.py` sends its own per request,
  in the shape the SEC's own sample documents, a product name and a contact address and no URL
  at all. A test asserts the header the client actually sends carries no `github` and overrides
  a shared header that does.
- **The SEC refuses an undeclared client, so `TRACKER_CONTACT_EMAIL` is a hard requirement for
  the ownership layer rather than a courtesy**, and the layer returns before opening a socket
  when it is unset. Spending a refusal to learn what configuration already knows is the same
  mistake as testing FAA freshness with a HEAD. This is also the one case where naming a
  `TRACKER_` variable in a capability reason is right: it is a free contact address that a
  provider genuinely requires, not a credential this project has ruled out. Compare the
  aisstream reason, which names a coverage consequence instead precisely because a key is out
  of scope.
- **The SEC's own `primaryDocument` field points at an XSL-rendered path that parses as empty.**
  Fetching it returns HTTP 200 and about 38KB of HTML in which **every field parses as absent**,
  while the raw XML at the same filename with the `xslF345X06/` directory removed returns
  everything. So a parser built against the documented path finds nothing and reports the filing
  as empty rather than erroring, which is the failure mode that looks like poor coverage.
  Measured 2026-08-23.
- **FEC `sort=-contribution_receipt_date` returns undated rows, not the newest rows.** The field
  is nullable, descending sort puts nulls first, and `pagination.last_indexes` confirms it with
  `sort_null_only: true`. Since ADR 008 drops and counts an undated entry, the whole first page is
  silently discarded. Exclude nulls explicitly. The name filter is full text, not exact, so a
  `contributor_name` filter is never an identity match, and the same earmarked contribution
  appears twice under two `committee_id` values, so a naive aggregate double-counts.
- Wikidata WDQS has a 60-second query timeout and blocks generic User-Agents. Every query
  ships with a `LIMIT`. **`wdt:` throws date precision away silently**: a year-only date of birth
  comes out of `wdt:P569` as `1971-01-01T00:00:00Z` and reads as 1 January, so a date used as a
  match key comes through `p:P569/psv:P569` with `wikibase:timePrecision` (11 day, 10 month, 9
  year) or the resolver scores a false match on a fabricated date.

### Social posts, media and cameras

- A Mastodon status object has **no coordinates**, no place object, nothing positional. Any
  location on a post is derived from its text and is labelled as derived. See ADR 005.
- `mastodon.social` answers HTTP 422 "requires an authenticated user" on its public
  timeline; `mas.to` answers 200 for the identical request. Instances are configuration and
  a 401, 403 or 422 drops that instance for the cycle rather than failing the feed.
- **A Commons File page can report `missing: true` and still serve a complete licence.** Querying
  a File against a local wiki rather than Commons returns `"missing": true`,
  `"imagerepository": "shared"` and a full `imageinfo` block, because the file lives on Commons.
  **The drop condition is the absence of an `imageinfo` key, never the presence of `missing`.**
  Dropping on `missing` throws away every Commons-hosted file reached through a local wiki and
  reports it as unlicensable.
- **`thumbwidth` and `thumbheight` never describe the bytes at `thumburl`.** Requesting
  `iiurlwidth=512` returned `thumbwidth: 512` against a URL whose decoded JPEG is 960 wide.
  Wikimedia renders to its own standard widths only (20, 40, 60, 120, 250, 330, 500, 960, 1280,
  1920, 3840) and a direct request for anything else is HTTP 400 with an HTML body. Any face
  bounding box or crop computed against `thumbwidth` is misaligned rather than erroring, which in
  phase 14 reads as poor match rates rather than a bug. Read the dimensions off the decoded image.
- **Asking Commons for a thumbnail caps the whole query at 50 records, and nothing in the
  response says so.** `iiurlwidth` makes MediaWiki resolve `prop=imageinfo` for at most 50 titles
  however large `ggslimit` is. Measured 2026-08-24 on a 500-page geosearch: with it, 500 pages but
  **50 `imageinfo` blocks**, 342KB, `batchcomplete` absent and an `iicontinue` token; without it,
  **500 blocks, 2,081KB, `batchcomplete: true`**. Since the drop rule is the absence of
  `imageinfo`, the other 450 are discarded as unlicensable, so raising `ggslimit` on its own buys
  450 dropped records and 32% more bytes for not one extra post, and the layer looks like a
  provider with nothing in it. Do not send `iiurlwidth` on a bulk query: derive the thumbnail
  address instead, `/commons/6/66/Name.jpg` to
  `/commons/thumb/6/66/Name.jpg/500px-Name.jpg`, which for all 47 raster files in a live response
  was byte-identical to the API's own answer. Only `image/jpeg`, `image/png` and `image/gif`
  (99.86% of a 4,000-record census) have a derivable still; `application/ogg`, `video/webm` and
  `image/tiff` answer HTTP 400 and get none, which is what they got before. Pair it with
  `iiextmetadatafilter`, which cut the same response 64% for a byte-identical parse, and remember
  that 500 is the provider's stated `ggslimit` ceiling rather than a number to raise.
- **A Commons search that finds nothing and a Commons search that failed are the same shape.**
  A genuine empty answer is HTTP 200 with **no `query` key at all**, 51 bytes reading
  `{"batchcomplete":true,"limits":{"coordinates":500}}`, verified mid-ocean. Under load
  `CirrusSearch` refuses with HTTP 200 and `code: cirrussearch-too-busy-error`, 2 of 36 sustained
  calls, which at least carries an `error` to branch on. A third body, 57 bytes with neither
  `error` nor `query`, appeared three times at places that reliably return 500 pages. So a missing
  `query` is treated as a failure rather than as "no photographs here": the cost is a wrong notice
  over open ocean, and the alternative is telling a user there are no photographs in Delhi.
- **Flickr signals total authentication failure with HTTP 200.** No key, an empty key and a bogus
  key all return 200 with `{"stat":"fail","code":100,...}`. `raise_for_status()` passes and
  `response.json()` parses, so the adapter either throws a `KeyError` or treats it as "no photos
  here". Check `stat == "ok"` first, count the failure, and never let it empty a store. Pass
  `nojsoncallback=1` or the body is wrapped in `jsonFlickrApi(...)` and is not JSON. Omitting the
  `license` parameter returns All Rights Reserved items, so the filter is mandatory under our own
  drop-unlicensed rule.
- TfL JamCams need **no key**. `lat` and `lon` are top-level but `available`, `imageUrl`,
  `videoUrl` and `view` are key-value pairs inside `additionalProperties`. **`available` is the
  string `"true"` or `"false"`, so `if ap["available"]:` is true for both**, and it is not a
  liveness signal either: the inventory is CDN-cached up to 24 hours (`age: 28798` observed), so
  the flags lag the real cameras by hours. Compare the string, then take liveness from the
  still's own `Last-Modified`. Corrected 2026-08-20: an earlier version of this line said
  honouring `available` was enough to stop a stale frame being served as live. The inventory is
  1.1MB, so fetch daily, never per view. The mandatory credit is three strings, not one, and the
  published cap is 500 calls per minute per feed.
- New York 511 is keyless and is **video, not stills**: `VideoUrl` is an HLS `.m3u8` and there is
  no image field at all. 1,066 of 2,931 cameras are `Disabled` and a second flag, `Blocked`, is
  set by the operator during an incident. Honour both, and remove a blocked camera rather than
  greying it out. **`Disabled == false` is still not enough to render one**: four enabled records
  have impossible coordinates, three at `0.0, 0.0` and one in China with the longitude sign
  dropped, all carrying live HLS, so a New York State plausibility box is required. Nine
  `VideoUrl` values are `.mjpg` rather than HLS, and **eleven records ship plaintext basic-auth
  credentials to a directly addressable camera over plain HTTP**. Accept
  `https://*.nysdot.skyvdn.com` only, drop and count everything else, and never store or log
  those values. The provider documents a required key and a 10-calls-per-60-seconds throttle
  while ignoring the key parameter entirely. Other states are not the same API: WSDOT answered
  401 without a key.

### Cross-cutting

- **A store's time to live and an adapter's acceptance window add, they do not bound each
  other, and the worst case on screen is their sum.** `EntityStore` expires on the time it was
  *handed* a record, while an adapter decides how old a report may be when it accepts it. So a
  layer whose adapter accepts a 900-second-old report and whose store holds for 1,050 seconds
  can draw a position 1,950 seconds old, and nothing anywhere states that number. Measured on
  the transit layer 2026-08-23: median position age 359s, p90 891s, worst 1,814s, with 8,437 of
  15,065 vehicles older than five minutes. For a bus that is the wrong street by a mile, which
  is the same error this project refuses to make by extrapolating, held silently instead of
  openly. Fixed by bringing both terms down on their own measurements, acceptance 900 to 300
  and the store 1,050 to 240: median 61s, p90 259s, worst 532s, 3.7% over five minutes.
  **Whenever you set either number, state the sum.**
- **Derive a cadence figure from the feeds that exist, not from the declared floors, or it can
  be governed by a host the registry never calls.** The transit store's time to live was taken
  from the slowest entry in `HOST_MIN_INTERVAL_SECONDS`, which is `passio3.com` at 350 seconds.
  That host governs **no feed at all**: all 23 of its feeds were dropped for having no licence
  recorded. So the figure was three times too large and derived from something unused. Taking
  it from `max(feed.min_interval_seconds for feed in FEEDS)` is self-correcting, because
  dropping a feed or adding a slower host moves it without anyone remembering to. It must stay
  above the largest floor that does govern a feed, or our own rate discipline manufactures stale
  drops: a feed we choose to poll every 350 seconds cannot produce a report under 300 seconds
  old.
- **An entity id can be trip-scoped, so a count of records is not a count of things.** 23.7% of
  GTFS-Realtime `FeedEntity.id` values contain their own trip id, and on Entur it is all of
  them, which also publishes repositioning runs carrying no passengers labelled `DeadRun`. So a
  bus finishing a trip reappears under a new key and the finished one lingers until it expires,
  and a longer time to live buys dead trips rather than live buses. This is not an argument
  against the compound key, which is measurably right: `(feed_id, entity_id)` gives zero
  collisions across 13,054 vehicles where 47.7% of `vehicle_id` values are shared between
  agencies. It is an argument that the product must say it is counting recent reports.
- **Live-mover layers are a union of providers, not one with a failover** (ADR 010). Merge
  key is the existing identity: ICAO 24-bit address for aircraft, MMSI for vessels. Every
  record carries which provider supplied it and how old
  that report is. Conflicts resolve by recency, never by provider precedence, and two
  positions are never averaged into a third no receiver reported. One record per hex is
  asserted by a test: the obvious bug here is one aircraft counted three times.
- **A recency merge plus a last-write-wins store gives you provider precedence by accident, and
  every test still passes.** `merge_providers` compares the reports of one cycle; `EntityStore`
  used to take whatever it was handed. So the store accepted an older fix over the newer one it
  already held, and a ship went 18 minutes and about 9km backwards on the globe every time the
  freshest provider skipped a cycle, which for AISHub is roughly every other cycle under its own
  60-second floor while Fintraffic re-serves one stale fix for its whole 600-second window. The
  guard is an optional `fix_time` on the store, so every layer gets it from one place: an entity
  with no report time, a satellite element set, simply does not set it. Verified 2026-08-20.
- **The list of providers that saw a record is per record and it has to survive the store.**
  `UnionResult.keyed()` carries the winning value only, so a merged `Vessel` used to reach the
  API naming one provider while the merge had computed three. The list rides on the contract as
  `providers`, freshest first. Naming providers on a card from the layer-level coverage on
  `/api/layers` is not the same fact and would be a guess about that particular ship.
- **Four bounding-box conventions now live in this project and six sources disagree with ours in
  four different ways.** Our contracts and the STAC `bbox` are `[west, south, east, north]`; OSM
  notes is `bbox={w},{s},{e},{n}`; Nominatim returns `[south, north, west, east]` as four
  **strings**; Overpass queries take `(south, west, north, east)`; NASA Worldview snapshot takes
  `south,west,north,east`, latitude first; aisstream.io wants `[latitude, longitude]` pairs. Flip
  in the adapter, never downstream. Getting one wrong returns a valid answer about the wrong
  place, which nobody notices. Nominatim returns `lat` and `lon` as strings while Overpass
  returns floats for the same values, so the two OSM adapters cannot share a coordinate parser.
- **Year 9999 is a "never" sentinel on two unrelated sources and it parses cleanly.** Companies
  House PSC `appointment_verification_end_on` and Copernicus OData `EvictionDate` both use
  `9999-12-31`. Nothing errors, because `datetime.max` is year 9999: it just renders as a date in
  the year 9999 on a card. Map it to `None`.
- **The MediaWiki action API's error contract is an `error` key inside a 200 body.**
  `gsradius=50000` answered HTTP 200 with `{"error":{"code":"outofrange",...}}`, so a client that
  branches on status and reaches for `query.geosearch` gets a `KeyError` rather than a clean
  error. Check for `error` on every action API call: `wbsearchentities`, geosearch and
  `imageinfo`. `gsradius` is capped at 10 to 10,000 metres, so a wide-area geosearch has to be
  tiled. `formatversion=2` is mandatory in practice, because without it booleans come back as
  empty strings and page collections are keyed by pageid instead of being an array.
- **Overpass, GDELT and WDQS all return non-JSON error bodies, including when `[out:json]` or an
  `Accept: application/sparql-results+json` was asked for.** GDELT's DOC 2.0 article API states
  its own cap in the body of its 429, one request every five seconds, as plain text with no
  content-type at all. Overpass errors are HTML or plain text on 429 and 504. A malformed WDQS
  query answers a plain-text HTTP 504 reading `upstream request timeout`. Never assume JSON on a
  non-2xx from any of the three. Cache per profile and back off. Overpass also queues a request
  for 15 seconds before discarding it, so a client timeout under about 20 seconds looks like a
  network fault when the queue is simply full.
- Wikimedia Commons, Mastodon and Flickr license each record separately. The item's own
  licence and author travel with it into the domain contract, and an item whose licence
  cannot be determined is dropped and counted rather than shown.
- `download.geonames.org/robots.txt` is `Disallow: /` for every path and every robot, and
  `meri.digitraffic.fi/robots.txt` contains `Disallow: /api/`. Both sit behind the rule above
  that says honour `robots.txt` in code, and both are sources the plan depends on. The
  provisional reading, unratified, is that `robots.txt` binds crawling rather than a weekly
  conditional fetch of a published licensed data file. It is recorded with its reasoning and
  its consequences in `docs/pending-decisions.md` as R4, not in an ADR, because it has not been
  decided. Anyone relying on it should get it ratified first.
- **ADR 015's "four small ONNX" is six graphs, and none of the embedders normalises its own
  output.** CLIP is two towers and Whisper-small is two graphs, so six, and seven once the face
  detector ArcFace needs is counted (ADR 015 names no detector; YuNet closes it at 233KB, MIT).
  Measured L2 norms: CLIP text 10.98, CLIP image 11.29, ArcFace 4.91, and MiniLM emits token
  states rather than a sentence embedding. Mean pooling and L2 normalisation happen in the
  adapter or every cosine in the store is wrong and nothing errors. Pass
  `providers=["CPUExecutionProvider"]` explicitly, because CoreML is present by default and a
  silently different provider produces different vectors. The ADR 015 origin key is a perceptual
  hash, not CLIP: pHash separates same-photograph from different-photograph by 16 bits while
  CLIP's margin is 0.03 and inverted, so a CLIP origin key would merge unrelated photographs and
  split identical ones in the same index. Measured 2026-08-20.
- **In-memory rate state does not survive a restart, and a restart loop is indistinguishable
  from hammering as far as the provider is concerned.** Every floor, backoff and response cache
  now goes through `cache.py`, one SQLite file under `settings.cache_dir`. CelesTrak is the
  worked example, because it firewalls abusive clients permanently and without appeal: its
  two-hour-per-group floor and its element sets are both on disk, so a process started inside
  the window opens no socket at all. Measured on 2026-08-20, adsb.lol makes the same point from
  the other end: it answered HTTP 420 on the **first** `/v2/mil` request of a fresh process,
  having asked a process that had already exited for 120 seconds of quiet. Two rules fall out
  of it. A floor is persisted unconditionally, because it can only ever delay us. A stop is
  persisted with an expiry chosen by cause, because one transient 503 written to a file with no
  expiry darks a layer for ever.
- **A throttle absorbed by a failover never reaches the poller, so the provider's own figure
  has to be honoured where the response arrived.** `AdsbClient` used to hold no state and say
  so. adsb.lol answered 420 on `/v2/mil` asking for 120 seconds, adsb.fi answered fine, the
  poll therefore succeeded, and the next cycle called adsb.lol again 65 seconds into the window
  it had asked for. A successful failover is not a failed poll, so no backoff was ever applied.
  The cooldown is now per provider, checked before the request rather than after it, and shared
  between the two adsb.lol clients this app runs, because a 420 binds the egress address and
  not the endpoint. Verified live 2026-08-20: after the change a restarted process made zero
  requests to adsb.lol inside the window and served the layer off adsb.fi throughout.
- **Several httpx exceptions stringify to the empty string, so a broken layer says nothing
  rather than erroring.** `ConnectTimeout`, `ReadTimeout` and `PoolTimeout` all carry no
  message: `f"{exc}"` renders nothing and `f"{type(exc).__name__}: {exc}"` renders a dangling
  colon. Live on 2026-08-20 the ADS-B failover logged
  `adsb.lol failed for /v2/lat/51.5000/lon/-0.1200/dist/250 ()` and CelesTrak served
  `unreachable: ConnectTimeout: ` to `/api/health`, `/api/capabilities` and the browser's
  layer rail. Nothing throws, so nobody notices. Render one with
  `sources.base.describe_exception`, which gives the type name always and the message only
  when there is one, and never interpolate an exception into a string a person reads.
- **A cache of an attribute a removal can delete needs an eviction path, or the removal reports
  success while the value is still served.** The adsbdb owner cache is the worked example:
  `registered_owner` is a named individual on a great many N-numbers, the TTL is a day, and
  ADR 008 makes removal immediate with no queue and no human step. Without a way in, a removal
  would delete the profile and this cache would keep serving the name for the rest of the day,
  which is worse than a slow removal because it looks like it worked. The aliases are the
  subtler half: one answer is remembered under the requested key, the record's own address and
  its registration, so clearing one key leaves the name reachable by the other two.
  `AdsbdbLookup.forget` sweeps on identity for that reason. Before adding any cache, ask
  whether a removal can reach it, and check every key it writes rather than the obvious one.
  **Which is why this is the one cache in `sources/` that is not on disk.** Decided 2026-08-20
  when every other rate guard moved to `cache.py`: a restart clearing a cache of named people is
  the right behaviour rather than a cost, persisting it would put personal data in a file the
  removal then has to reach through three alias keys, and nothing polls adsbdb so a restart
  produces no burst to protect against. A test asserts the consequence rather than the
  intent: after a real lookup, the owner's name appears nowhere in the cache file. Persisting a
  cache of personal data is allowed, but the removal path is then not optional.
- Never expose the aisstream, Windy or TfL key to the browser. Keyed feeds are proxied.
- Windy image tokens expire after ten minutes. Never cache an image URL beyond validity.
- Cesium's `Entity` API collapses in the low thousands of movers. Use
  `PointPrimitiveCollection` / `BillboardCollection` and mutate positions in place. This
  cannot be retrofitted; it is a rewrite.
- **Cesium ships a hard-coded demo ion token with a stated deletion date, so "no token
  configured" does not mean "no token used".** 1.144 sets `Ion.defaultAccessToken` to a JWT
  whose own audience claim reads "1.144 Release - Delete on October 1, 2026". Left alone, any
  ion-backed default works silently on Cesium's key today and starts answering 401 in October,
  in a failure mode nothing here has ever tested. `frontend/src/globe/viewer.ts` blanks it at
  import time, before any viewer exists, which is what makes an accidental ion dependency fail
  now instead. Measured 2026-08-20: with it blanked, `IonImageryProvider.fromAssetId(2)` throws
  "Request has failed. Status Code: 401", and a viewer left on its ion-backed default imagery
  renders a starfield with no Earth. Do not paste the token back. The same trap exists at
  `ArcGisMapService.defaultAccessToken`, so reach for
  `ArcGisMapServerImageryProvider.fromUrl` and never `fromBasemapType`.
- **Removing the ion logo is `CreditDisplay.cesiumCredit`, never the credit container.**
  `Credit.isIon()` is a substring test for `ion-credit.png` and any credit passing it is
  short-circuited into `.cesium-credit-logoContainer`, so replacing `cesiumCredit` with an
  empty credit drops the logo and leaves the text container and the "Data attribution"
  lightbox intact. Those two carry imagery attribution, which is a licence condition on
  several sources here, so killing the container would break a licence to fix a logo.
- **Cesium draws every translucent command after every opaque one, whatever order the
  primitives were added in, so primitive order does not decide what covers what.** The cluster
  badges are the worked example: a `BillboardCollection` built with
  `BlendOption.TRANSLUCENT` carries the badge and a `LabelCollection` on its default blend
  carries the count, the two were added in the right order with a comment explaining that a
  count must never end up under its own badge, and every badge on the globe still rendered as
  an empty hexagon. The count went into the opaque pass and its badge was painted straight over
  it. Nothing errors, and it reads as a layer that draws no text. Two collections that must
  overlap in a chosen order have to share a pass; then, and only then, primitive order decides.
  Verified 2026-08-23 by patching one layer of three and watching the digits reappear on that
  layer alone.
- **Cesium's own zoom throws on a rounding coin flip above 1,000km, and it kills the render
  loop.** `ScreenSpaceCameraController.handleZoom` runs a "rotating zoom" that pulls the point
  under the cursor towards the screen centre. It guards the parallel case with
  `dot > 0 && dot < 1` and that guard does not hold, for a floating-point reason rather than a
  geometric one: once the zoom has converged the two vectors are the *same* unit vector,
  `cross(v, v)` is exactly zero because every term cancels, while `dot(v, v)` rounds either side
  of one. At 0.9999999999999999 the guard passes with an axis of no length,
  `Quaternion.fromAxisAngle` normalises it and throws `normalized result is not a number`.
  Measured over 500,000 randomised pairs sharing a line through the earth's centre: bit-identical
  normals 22.3% of the time and **7.2% both passed the guard and produced an exactly zero axis**.
  So it is a one-in-fourteen lottery at every convergence, which is why it feels random and why
  it cannot be reproduced on demand from a browser. It exists only above 1,000km, and between
  1,000 and 2,000km the vulnerable path runs on **every** wheel tick. `globe/viewer.ts` guards
  `Camera.prototype.rotate` against a degenerate axis at import time, beside
  `Ion.defaultAccessToken`: rotating about an axis of no length is the identity, so returning
  early changes no documented behaviour. Delete it when Cesium guards the axis itself; a test
  asserts `Quaternion.fromAxisAngle` still throws on a zero axis, so it fails when that day comes.
- **`scene.renderError` does not see a throw from the camera controller, and
  `showRenderLoopErrors: false` on its own is worse than the red panel.** `Scene.render` wraps its
  own work and raises `renderError`, but the camera controller runs in `Scene.initializeFrame`,
  which the widget calls *before* `scene.render` and which sits outside that try. So a throw from
  zooming reaches only `CesiumWidget`'s catch, which sets `useDefaultRenderLoop = false` and stops
  the loop. Verified 2026-08-23 by poisoning the camera in a built bundle: with the panel
  suppressed there was no panel, no `renderError`, and a dead silent globe, which is worse than a
  visible error because nobody knows to reload. Recovery needs a watchdog on
  `useDefaultRenderLoop` per animation frame, restoring the last pose that rendered. Two traps in
  writing one: `camera.setView` throws when the camera it is replacing is the non-finite one being
  repaired, so restore by assigning the vectors directly; and the watchdog must re-arm its own
  animation frame *before* anything that can throw, or it recovers exactly once.
- **Never `git checkout --` a working file to undo a temporary edit. It happened twice on
  2026-08-23 and cost real work both times.** This repository runs with a large uncommitted
  working tree, so a checkout does not revert your edit, it reverts the file to HEAD and
  discards everything anyone has done to it since the last commit. Once on `src/tracker/app.py`,
  destroying about 450 lines including a satellite-priming fix, and once on
  `frontend/src/globe/layers/aircraft.test.ts`. Both were recovered, one from a dropped `git
  stash` still in the object store plus the session transcript, one by replaying the patch
  sequence from the transcript, and neither recovery was certain at the time. **Copy the file
  aside before a temporary edit, and restore it with `cp`.** If it has already happened: check
  `git fsck --lost-found` for a dangling stash, then the session transcript under
  `~/.claude/projects/`, and verify the rebuild by coverage rather than by eye, because a file
  that looks right can be missing a test nobody counted.
- **A test that asks the implementation what the answer should be is not a test.** It agrees
  with itself and survives the mutation that matters, because moving the constant moves both the
  code and the expectation. Two instances on 2026-08-23. A badge fit test read
  `GLYPH_WIDTH_RATIO` and the badge's inner width out of the module it was testing, and survived
  both setting the ratio back to its broken value and pointing the budget at the wrong width. A
  module with 34 tests sat at 85% because every function its uncovered function called was
  tested, which reads as coverage. **The expectation needs an independently sourced number**: a
  width measured in a real browser, a count taken from a live feed, a figure from the provider's
  own documentation. And mutation-test the test itself, not only the code: break the thing it
  claims to catch and watch it go red.
- **The test for a defensive fallback is not "is this defensive", it is "does the fallback lie
  about what it achieved".** Two fallbacks on 2026-08-23 and 2026-08-24 looked identical and were
  opposites. A `getattr(state, "removal", None)` where the field is `removals` turned a wrong
  name into "absent", and absent had a handler, so a typo became a permanent 503 with every test
  green. A `?? []` on a required `operators` field survived review because the failure mode is
  asymmetric, a throw takes every credit off the globe, **and because the degraded state is
  written down as degraded**: a grouped credit row that lost its owners is under-credited, which
  these licences do not permit, so the comment says the fallback is not a compliant state. The
  first lied about what it had achieved; the second says plainly that it has achieved something
  worse than the requirement.
- **A nested `<details>` widens every descendant selector aimed at the outer one, and the tests
  that break are not the ones you are editing.** Adding a grouped credit put a second `<summary>`
  inside `#attribution`, so `#attribution summary` matched two elements and Playwright's strict
  mode refused. Four sites used the bare selector and **three of them passed only because the
  shared stub had no grouped row, while production has six**: they were one realistic payload
  from failing. Use the child combinator, `#attribution > summary`, to name a component's own
  control. Anything with a locator like `#status summary` or a rail equivalent has the same trap
  waiting the day a disclosure is nested inside it.
- **An e2e suite that needs a running backend is not self-contained, and its failure lies about
  the cause.** The legibility test did not stub `/api/search`, so on a clean machine it got
  `ECONNREFUSED` and reported against the font-size assertion as though the type scale were
  wrong. Every other test in that suite stubs. Verified 2026-08-24: with the backend down the
  suite is 32 of 32 after the stub and was 31 of 32 before it. The way to prove a call never
  leaves the browser without taking a shared server down is a catch-all
  `page.route('**/api/**', route => route.abort())` registered first, then check the aborted list.
- **A default camera is a product decision, so no test may inherit it.** Three Playwright tests
  put their stub entity at the old default position and reached it by opening `/`, which meant
  they were asserting the opening view as a side effect of testing something else. Moving the
  camera from 2,400km over London to the whole Earth then read as three broken features. A test
  that clicks a mark asks for its camera through the URL hash, `#lon=..&lat=..&alt=..`, the way
  the shared-link test already did.
- **`frontend/.remember/` has to be ignored by both linters, not just by git.** It is a plugin's
  scratch directory, regenerated by a save hook, so deleting it does not stop it coming back,
  and the type-aware eslint parser fails on a file outside `tsconfig.json` and takes the whole
  gate down with it. `biome.json` and `eslint.config.js` already ignore `.omc` for the same
  reason.
- Multiple uvicorn workers each run lifespan and so duplicate every poller. Pollers run
  in a single process until a lock exists.

## Data sourcing

Scraped and crowd-sourced sources are permitted, on the people layer included. See
`docs/decisions/004-permitting-scraped-and-crowd-sourced-data.md`, which amends ADR 002.
This matches how the business itself collects: the Leadership Extractor scrapes company
leadership pages across the whole private organisation universe weekly, the Annual Report
Extractor pulls boards and leadership out of filings, and the AI Profile Builder builds
profiles from the open web. All three put a machine on the fetch, a language model on the
extract and a researcher on the verify. See [business context](docs/business-context.md).

The business buys data as well as scraping it: licensed wealth and identity files, and
bought contact files supplying address, email and phone at scale. **This project buys
nothing.** It is public sources only, so a bought file never appears here, and a contract
field that a bought file would fill in production simply sits empty. Do not add a vendor
feed, and do not fabricate a value to stand in for one.

**No human verification in this project.** It is a proof of concept and a demo: no
researcher, no review queue, no QA step, no approval state, no admin accept/reject screen.
Never design anything on the assumption a person will check it. The machine carries the
burden instead: strict contracts, unmappable records dropped and counted, a confidence
threshold below which no link is asserted, low-confidence matches shown as unconfirmed and
excluded from aggregates, and provenance on every card. This is a rule, not a backlog item.

The obligations that come with scraped and crowd-sourced input:

- Record every source in `docs/data-sources.md` with how it was collected, its licence or
  terms position, cadence and verification date. Say plainly when a source is scraped.
- Scraped and user-submitted input is the least trustworthy input in the system. Permissive
  at the wire layer, strict at the domain layer, unmappable records dropped and counted.
- Show provenance on the card. A scraped or crowd-sourced origin is displayed as such,
  never presented as authoritative.
- Honour `robots.txt`, published crawl delays and stated request caps in code. Descriptive
  User-Agent with contact details. Cache server-side, never scrape from the browser.
- Do not scrape a source whose terms prohibit scraping or redistribution. ADSBexchange's
  globe map is the worked example: 403 on the tiles and prohibited by name.

## The people layer

Read `docs/superpowers/specs/2026-08-19-tracker-design.md` section 8 and ADR 002 for the
reasoning, then ADR 004, ADR 006, ADR 007 and ADR 008 for what changed. Person records are no
longer limited to Wikidata entities reached through the seven-property allowlist, and scraped
and crowd-sourced person data is allowed under the sourcing rules above.

**The profile carries the production attribute set**, per ADR 008, because a thinner profile
demos a thinner product than the one that exists:

- Identity: name and alternate names, date of birth, age, gender, nationality, deceased
  date, hometown or place of birth.
- Contact: personal and business email, personal and business phone, postal addresses
  including a home address, social handles including LinkedIn.
- Wealth tier, roles, and dated locations.

Contact and identity attributes are match keys before they are display fields, and the
entity resolution in phase 6 uses them. Every rule below applies to them exactly as it
applies to a location: a date, a source, dropped and counted if undated, labelled derived if
produced by a join, provenance on the card.

Contact attributes are **marked PII in the contract** so the card and the API can serve a
profile with them suppressed. The business sells packages defined by that exclusion
(`NoContactData`, `NoPII`), so it is a demo feature rather than plumbing.

Public sources fill few of these. Where a field is empty it is empty: no default, no
approximation, no inference.

**Location is a profile attribute.** Residence city or region, business or registered
address from a public record, home address, work and education location, and publicly
reported past appearances that resolve to a place. Rules that make it work:

- Every entry carries a date and a source. An undated location fails the contract and is
  dropped at the adapter and counted.
- Location is a dated series, not one current value. A profile that has moved has two
  dated entries.
- An entry produced by joining sources is labelled **derived**, not reported, and that
  label reaches the card.

**A person may be joined to any data in the system**, live position feeds included. ADR 007
removed the firewall that used to sit here and there is no prohibited join. What each join
must carry, asserted by a test:

- Its source, its confidence and its as-of date, all rendered on the card.
- A join below the confidence threshold is displayed as a possible match with its score and
  is excluded from every aggregate count. It is never asserted.
- An inference is labelled as an inference. An owned jet being airborne is a fact about the
  aircraft; "the owner is aboard" is an inference, and the card says which it is making.
- A join to a live feed produces a dated location entry like any other, sourced to the feed
  and dated to the observation. It does not become a current-location field.

**Enrichment is cross-source corroboration, not single-source assertion** (ADR 011). No
single online source is trusted on its own, because there is no researcher here to check it.
The rules, all asserted by tests:

- Every enriched attribute carries the **set** of sources supporting it, and its confidence
  is a function of how many independent origins agree.
- **Independence is judged at the origin.** Two aggregators carrying the same wire story are
  one source, and a Wikidata statement referencing the Wikipedia article that cites the same
  press release is one source. Where independence cannot be shown it is treated as absent.
- A single scraped or crowd-sourced source **never** crosses the assertion threshold alone.
  Primary records (a filing, a registry extract) may, because the source is the record.
- Corroboration raises confidence, never precision. Three sources saying London is a city.
- Conflicting dated values both stay, with the disagreement shown. Nothing is silently
  overwritten, and a combined value is labelled derived.
- Corroboration is its own service over domain contracts, not logic inside an adapter.

**Three enrichment paths produce a location, all dated and all corroborated.** A post's own
upstream coordinate; a location resolved from a post's words against the city gazetteer,
labelled derived (ADR 005); and a **person mentioned in a news or online report** that
resolves to a place, which is a report about a person rather than an observation of one, so
it is derived, city-level, sourced to the article and dated to its publication. GDELT DOC 2.0
is the news source, keyless, capped by the provider at one request per five seconds.

**Occupancy of an aircraft or vessel is estimated, and always labelled an inference**
(ADR 012, phase 12). It draws on registry ownership, movement history we recorded ourselves,
the live track and route pair, the associate graph from public filings, and each candidate's
dated locations from every other layer. Non-negotiable: contradiction beats corroboration, so
a corroborated location elsewhere in the window removes a candidate outright; below the
threshold nothing is named and the card reads "occupants not established"; the estimate is
excluded from every aggregate, never writes a location entry onto a profile, and never touches
a wealth tier; suppressed people are excluded from candidate generation, not filtered
afterwards. This is the highest-harm output in the system.

**FAA LADD and privacy ICAO addresses are worked through, not honoured** (ADR 009). A
LADD-listed aircraft resolves and displays like any other and LADD membership is an attribute
on the profile. A privacy address is correlated back to a registration in phase 11, above a
threshold set higher than for an ordinary registry join, with the anonymity and the inference
both shown on the card.

**People are identified in photographs, against the profiles we already hold** (ADR 013,
phase 14). It is 1:N against the profile list, never open-set identification of the public.
The reference face is Wikidata P18 resolved to Commons, so no P18 means no match and none is
asserted. A face detected in a photograph that matches no profile is discarded rather than
stored: we do not accumulate face data on people we hold no profile for. The threshold sits
above an ordinary registry join, a face match alone never crosses the assertion threshold
under ADR 011, the card says the identification is inferred from a named photograph, and a
suppressed person is out of the candidate set rather than filtered from the output. **It is
not applied to camera feeds.** A written legal position from counsel naming the jurisdictions
and the consent basis is a blocker on public deployment carrying real profiles, alongside the
phase 6 US privacy position. ADR 013 records that this reverses every prior exclusion in the
repo and that the decision was Alexander Fanthome's.

One thing is still out, and it is not a policy preference about joins:

- **Aggregators of unsecured private cameras.** Those index cameras whose owners
  misconfigured them, so using them is unauthorised access to a private system: Computer
  Misuse Act 1990 in the UK, state computer-access statutes and the CFAA in the US.
  Owner-published and official feeds cover the camera layer: TfL JamCams and New York 511 are
  both keyless and verified, Windy needs a key.

What has not changed:

- No wealth tier, net worth figure or wealth signal inferred from a live feed, a position
  or a track. A tier comes from a profile or it does not exist. Owning a jet is not an
  estimated net worth.
- UHNW individuals are a security-sensitive population, and a home address or phone number
  joined to a live asset position is the highest-harm thing this project can hold. With the
  joins permitted and the attributes in, the only things limiting exposure are the confidence
  threshold, the provenance display, the PII suppression and the removal control. None of the
  four is negotiable and none is tuned down for a better-looking demo.
- A wrong contact attribute is worse than a wrong location: it attaches a real stranger to a
  named profile and gives someone a way to contact them. Sub-threshold matches stay
  unconfirmed.

**Right to be forgotten, honoured whatever the jurisdiction.** The report control and a
removal request both remove **and suppress** a person record. Suppression is keyed
independently of ingest so the next crawl does not resurrect it, the key holds no more
personal data than the flag needs, and the suppression shows in the product with its reason.
Since ADR 009 stopped the product applying FAA LADD, this is the only suppression path
there is, and it is ours. There is no queue and no human step, so it takes effect
immediately.

We honour it as policy, not because a regulator compels it. **This project is not in GDPR
jurisdiction**: the profiles and the customers are in the United States, which has no single
federal privacy law and instead a state patchwork, with California's CCPA and CPRA the
sharpest edge and the California Delete Act reaching data brokers directly. The CCPA right to
delete is narrower than GDPR erasure and reaches information collected from the consumer
rather than everything held. Any UK GDPR wording still lying around this repo is wrong; ADR
008 settled it.

Before any public deployment carrying real profiles, the US privacy position is a phase 6
deliverable: which state laws reach the population, how access and deletion requests are
served inside the statutory windows, and whether data broker registration applies.

## The social post layer

Read ADR 005 before touching it, then ADR 007 for what changed. The short version: the pin
a post draws is about its subject, because no source in this layer reports an author
position. Joining a post to a person is permitted.

- `SocialPost` carries a required `location_basis`. `upstream` means the source gave us the
  coordinate (OpenStreetMap notes, Commons geosearch, Flickr `has_geo`). `derived` means we
  resolved it from the words (Mastodon). No post exists in the domain without saying which.
- A derived location is matched against the city gazetteer only. No per-post geocoding
  call, no precision finer than the city, no fallback geocoder.
- A post may be joined to a person or organisation record, per ADR 007, and the join carries
  its source, confidence and date. The `derived` label travels with it: a city-level match
  from a post's words never reads as an observed position.
- A post is a fixed event with a timestamp: no dead reckoning, no interpolation. Posts
  joined to a profile form a dated series like any other location evidence, and the globe
  shows them as dated points rather than drawing a route between them, because the route is
  not something any source reported.
- One post is one weak source. A location entry resting on a single post stays unconfirmed
  until an independent origin agrees, per ADR 011, and it is a candidate contradiction or
  corroboration for the phase 12 occupancy estimate.
- Media is proxied and cached, never hot-linked.

**Post content is analysed for four things, and they are not the same claim** (ADR 014).
Sentiment is an attribute of the post and never of a person, so there is no sentiment field on
a profile and no mood, disposition or risk score anywhere. Co-presence, two named people in one
post resolving to two profiles, is a dated, sourced, confidence-scored inference that they were
together, never proof, and it feeds the associate graph and the phase 12 candidate set. An
image is read for what and where, always derived and city-level at best, with who governed by
ADR 013. Why is not asserted at all: a stated reason is carried as an attributed quote and
anything else stays empty. A model output is not an independent source, so two models agreeing
is still one origin.

## Entity resolution and multimodal evidence

Read ADR 015. It does not decide **whether** to read a face, a landmark or a sentiment:
ADR 013 and ADR 014 decided that. It decides **how any of it runs**. Everything runs locally
on one laptop with an internet connection: no cloud inference, no paid model API. That is a
licensing position as much as a deployment one, because posting scraped or licensed media to
a third party to be described is redistribution, and shipping a reference portrait out to be
embedded hands a biometric identifier to someone with no basis to hold it.

**One evidence contract, one resolver, whatever the modality.** A claim carries its value,
its date, its source, its **origin key** and the modality it arrived in. Modality-specific
code lives in `sources/` adapters. Nothing under `services/` branches on modality.

- **Video is not a fourth modality.** It is frames plus an audio track, handled by the image
  path and the audio path, sharing one origin key.
- **The origin key is the whole game.** A video, a still pulled from it and its own
  transcript are **one** source, not three. Three re-uploads of one photograph are one
  source, and near-duplicate detection is what proves it. This is ADR 011's wire-story rule
  applied across modalities and it is the easiest thing here to get wrong.
- **Modality is not a trust level, origin is.** A company's own webcast is a primary record
  and may cross the assertion threshold alone. A caption on a crowd-uploaded photo never
  does.
- **Timestamps come from the media, not the run.** A transcript segment is dated to the
  call. A photo is dated to its EXIF capture time where present, otherwise its publication
  date, and which one was used is recorded. Undatable media is dropped and counted.
- **The resolver is deterministic and classical**: blocking, per-field comparators, additive
  log-odds scoring, two thresholds (assert above, possible match between, nothing below). A
  score decomposes into the fields that produced it. **No model scores a match.** Embeddings
  propose candidates and nothing else.
- **Local models are four small ONNX on CPU**: a sentence embedder, a CLIP-family image and
  text embedder, a face embedder of the ArcFace class (used only as ADR 013 permits), and
  Whisper-small. Corrected 2026-08-20 against measured runs: that is four models but **six ONNX
  graphs**, seven counting the face detector ArcFace will not run without, and none of the
  embedders normalises its own output. See Gotchas. Weights pinned by hash, not committed, fetched on first use, and the model
  version stored on every embedding, because a silent mixed-version index looks like poor
  recall rather than a bug, and because a removal under ADR 008 has to delete every version
  of a reference face embedding. With the weights absent the product runs text-only and
  reports the media layers unavailable, like any missing key. The test suite must pass
  without them.
- **A model output is not a source** (ADR 014), and the origin key is what enforces it. A
  face match, a landmark reading, a registration read off the tail and a caption all taken
  from the same photograph are **one** origin between them. Running a second model over the
  same picture does not create a second source.
- **Image content reading is closed-set, not open-vocabulary description.** The image
  embedding is scored against a candidate label set built from records the system already
  holds: the phase 4 gazetteer, the phase 5 registries, the phase 6 organisations and assets.
  The model ranks things we can already name and cite, so there is nothing to hallucinate.
- **Vectors are blobs in the existing SQLite file, scanned with numpy.** No vector database
  and no vector server until a brute-force scan is measurably too slow.
- **Audio is demand-driven and cached by content hash, never a poller.** Hours of earnings
  calls on a laptop CPU is not a sweep.
- **Face matching is a candidate generator, not a decision.** ADR 013 decided that faces are
  matched; ADR 015 only says the embedder runs locally and its output is scored, thresholded
  and corroborated like any other claim. Running it on this machine is what keeps ADR 013
  inside its own limits: reference portraits never leave the laptop, a face matching no
  profile is discarded rather than stored, and a removal deletes the embedding with the
  record.
- **Media never asserts a person's location on its own.** A geotag says where the camera
  was. Joining that to a person needs corroboration like any other join.

## Documentation rules

- Update the relevant doc in the same commit as the change.
- `docs/data-sources.md` is the single source of truth for feed facts. Never write an
  endpoint into it that you have not called successfully. Record the verification date.
- `docs/status.md` is the only file expected to churn: Now, Works, Broken, Next.
- ADRs under `docs/decisions/` are append-only.
- Reference code as `path:line`, do not paste snippets into docs.

Docs index: [business context](docs/business-context.md) ·
[architecture](docs/architecture.md) ·
[data sources](docs/data-sources.md) · [status](docs/status.md) ·
[plan](docs/plan/implementation-plan.md) · [decisions](docs/decisions/) ·
[pending decisions](docs/pending-decisions.md)

**Read [pending decisions](docs/pending-decisions.md) before you rely on an ADR.** Eight places
where two documents in this repo cannot both be true, found by a sweep across all fifteen ADRs on
2026-08-19, plus three questions nobody has answered yet. Each conflict has a provisional reading
that the code already assumes, and every one of those readings is unratified. The sharpest is that
ADR 010 claims a union of ADS-B providers satisfies ADR 011's corroboration test when it does not,
because two aggregators are repeating one transponder broadcast. Taking ADR 010 at its word would
inflate every confidence number that rests on a position.
