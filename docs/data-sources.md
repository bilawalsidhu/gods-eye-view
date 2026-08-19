# Data sources

The single source of truth for feed facts: endpoint, auth, cadence, licence, cost, and the
date someone actually called it and got a 200 back.

**The rule.** No endpoint goes in the verified table until it has been called successfully
and this file updated with the date. Nothing in the planned table may be relied on in code
until it has been called and moved up. If you are about to write an endpoint into an
adapter and it is marked NOT YET VERIFIED here, call it first. Guessing an endpoint shape
from documentation is how a layer ships broken.

Every row added to this file belongs in the same commit as the code that uses it.

**No bought data.** The business buys licensed wealth files and a vendor contact file
supplying address, email and phone at scale. This project is public sources only, so none of
that appears here and none of it ever will. The profile contract holds the contact
attributes anyway (ADR 008), and the fields a bought file would fill simply stay unset. Do
not add a vendor row to this table, and do not invent a value to stand in for one.

---

## Verified

Called live on 2026-08-19 with a real 200 response.

| Source | Endpoint | Auth | Cadence / rate limit | Format | Licence | Cost | Last verified |
| --- | --- | --- | --- | --- | --- | --- | --- |
| adsb.lol | `https://api.adsb.lol/v2/point/{lat}/{lon}/{radius_nm}` | None | No published contractual limit. We poll at 8s, floor 5s in code | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/mil` | None | Throttles with HTTP 420. We poll no faster than 30s and fail over to adsb.fi | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.lol | `https://api.adsb.lol/v2/type/{icao_type}` | None | Same throttling behaviour as the rest of the v2 API | JSON, readsb v2 | ODbL 1.0 | Free | 2026-08-19 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/mil` | None | 1 request per second, stated by the provider | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| adsb.fi | `https://opendata.adsb.fi/api/v2/lat/{lat}/lon/{lon}/dist/{nm}` | None | 1 request per second | JSON, readsb v2 | **Non-commercial** | Free | 2026-08-19 |
| CelesTrak | `https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=json` | None | **Never faster than once per 2 hours per group.** Abusive clients are firewalled permanently | JSON, OMM mean elements (not TLE line format) | CelesTrak terms, attribution required | Free | 2026-08-19 |
| USGS | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson` | None | No hard limit published. Planned cadence 2 minutes | GeoJSON | Public domain (US Government work) | Free | 2026-08-19 |
| NASA EONET | `https://eonet.gsfc.nasa.gov/api/v3/events/geojson` | None | No hard limit published. Planned cadence hourly | GeoJSON | NASA open data, attribution requested | Free | 2026-08-19 |
| NASA GIBS | `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/` | None | Tile service, no key. Respect normal tile-client behaviour | WMTS (XML capabilities, raster tiles) | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| GeoNames | `https://download.geonames.org/export/dump/cities15000.zip` | None | Bulk file, not an API. Download at most once a week | Tab-separated text in a zip | CC BY 4.0 | Free | 2026-08-19 |
| Wikidata WDQS | `https://query.wikidata.org/sparql` | None, descriptive User-Agent required | One query per user action, never per keystroke. Server-side cache | SPARQL JSON results | CC0 | Free | 2026-08-19 |
| Wikimedia Commons | `https://commons.wikimedia.org/w/api.php?action=query&list=geosearch` | None, descriptive User-Agent required | Wikimedia API etiquette, roughly 1 request per second | JSON | Per-file, mostly CC BY-SA or public domain | Free | 2026-08-19 |
| OpenStreetMap notes | `https://api.openstreetmap.org/api/0.6/notes.json?bbox={w},{s},{e},{n}` | None, descriptive User-Agent required | Treat as roughly 1 request per second, cache per tile | JSON | ODbL 1.0 | Free | 2026-08-19 |
| ADS-B Exchange (RapidAPI) | `https://adsbexchange-com1.p.rapidapi.com/v2/...` | **Paid RapidAPI key**, or a free key as a data feeder | Per-plan request quota. Continuous polling exhausts the entry tier in about a day | JSON, readsb v2 | **Provider terms prohibit redistribution without written permission** | From $10/month, free to feeders | 2026-08-19 |
| ADS-B Exchange (globe map) | `https://globe.adsbexchange.com/data/aircraft.json`, `/re-api/` | n/a | **Do not use.** 403 by administrative rule and disallowed in `robots.txt` | n/a | n/a | n/a | 2026-08-19 |
| airplanes.live | `https://api.airplanes.live/v2/...` | Access granted by email request | Unstated until granted | JSON, readsb v2 | Provider terms, ask on request | Free | 2026-08-19 |
| adsb.one | `https://api.adsb.one/v2/...` | None documented | **Cloudflare-blocked from this network on 2026-08-19** | JSON, readsb v2 | Provider terms | Free | 2026-08-19 |
| Mastodon (`mas.to`) | `https://{instance}/api/v1/timelines/public` | None on instances that still allow it | 300 requests per 5 minutes per IP on default Mastodon config | JSON | Per-post, author's own; instance terms apply | Free | 2026-08-19 |
| GDELT DOC 2.0 | `https://api.gdeltproject.org/api/v2/doc/doc?query={q}&mode=artlist&format=json&timespan={t}` | None, descriptive User-Agent required | **One request per five seconds**, stated by the provider in its own 429 body. Cache per profile | JSON | GDELT terms, attribution required | Free | 2026-08-19 |

| Element 84 earth-search | `https://earth-search.aws.element84.com/v1/search` | None | No published cap. One search per user action, cached server-side | STAC JSON. Assets are Cloud-Optimised GeoTIFF on S3 | Copernicus free, full and open. Attribution mandatory | Free | 2026-08-19 |
| Copernicus Data Space | `https://catalogue.dataspace.copernicus.eu/odata/v1/Products` | None to search. **OAuth token to download** | Search keyless. Download quota sits on the token | OData JSON | Copernicus free, full and open | Free | 2026-08-19 |
| NASA Worldview snapshot | `https://wvs.earthdata.nasa.gov/api/v1/snapshot` | None | Renders one image per call, not a tile service. Cache per place and date | JPEG, PNG or GeoTIFF | NASA open data, acknowledgement requested | Free | 2026-08-19 |
| TfL JamCams | `https://api.tfl.gov.uk/Place/Type/JamCam` | **None.** A key raises the rate limit, it does not grant access | Inventory is 1.1MB. Refresh daily, never per view. Stills refresh on the order of minutes | JSON, stills as `image/jpeg` on S3 | TfL open data, credit string mandatory | Free | 2026-08-19 |
| New York 511 | `https://511ny.org/api/getcameras?format=json` | None | 2,931 cameras in one 858KB response. Refresh the inventory on a slow cycle | JSON. Live video as HLS `.m3u8` | NYSDOT open data. Restreaming needs a read | Free | 2026-08-19 |

### adsb.lol `/v2/point/{lat}/{lon}/{radius_nm}`

The viewport feed and the only aircraft source the running app polls for a local view.
Radius is capped at 250 nautical miles and the provider rejects anything larger, so the cap
is applied in code at `src/tracker/sources/adsb.py:304`. A wider area needs tiling.

Verified with `51.5 / -0.12 / 25`, which returned 65 aircraft (captured as
`tests/fixtures/adsb_point_live.json`, all 65 records carrying a position). Field
availability in that sample: `hex`, `lat`, `lon` on all 65, `flight` on 63, `t` and `r` on
59, `track` on only 28. That last figure is why the heading fallback chain at
`src/tracker/sources/adsb.py:129` is not an edge case.

Because the feed only understands circles, a bounding-box query becomes the circumscribed
circle plus local filtering (`src/tracker/sources/adsb.py:307`), which over-fetches by up
to about 27% at the corners.

adsb.lol publishes no contractual rate limit and plans to introduce keys earned by feeding
data. It does throttle in practice: on 2026-08-19 it answered this endpoint with HTTP 420
during a live run.

### adsb.lol `/v2/mil`

Every military aircraft the provider currently sees, worldwide, in one response. Verified
on 2026-08-19: 391 records, of which 310 carried a position (captured as
`tests/fixtures/adsb_mil_live.json`, 168KB). All 391 carried `dbFlags` bit 1.

This endpoint returns eight fields `/v2/point` does not (`dbFlags`, `calc_track`,
`lastPosition`, `gpsOkBefore`, `gpsOkLat`, `gpsOkLon`, `rr_lat`, `rr_lon`). That difference
is the reason for the permissive wire model, explained in `docs/architecture.md`.

**It answered HTTP 420 rate-limited on a later call.** 420 is not a standard status code
and is handled explicitly at `src/tracker/sources/base.py:21`. Consequences, both in code:
the cadence floor is 30 seconds (`src/tracker/app.py:41`), four times the viewport floor,
and failure falls over to adsb.fi.

Coverage is inherently partial. Military aircraft routinely fly with transponders off, and
the UI says so rather than implying a complete picture.

### adsb.lol `/v2/type/{icao_type}`

Every aircraft of one ICAO type designator, worldwide. Verified with `GLF6`, which returned
18 aircraft (captured as `tests/fixtures/adsb_type_glf6_live.json`). This is the endpoint
behind business-jet sweeps in phase 3.

### adsb.fi

The failover provider, and the reason a single parser serves both: adsb.fi, adsb.lol and
ADSBexchange all serve the readsb v2 schema.

`/v2/mil` is path-identical to adsb.lol, which is why the military failover works with no
code change. The viewport endpoint is **not** path-identical: adsb.fi uses
`/v2/lat/{lat}/lon/{lon}/dist/{nm}` and answers HTTP 400 for adsb.lol's
`/v2/point/{lat}/{lon}/{nm}`. Both were confirmed on 2026-08-19. The current failover in
`src/tracker/sources/adsb.py:331` retries the same path against the secondary base URL, so
the viewport failover does not work yet. Recorded in `docs/status.md`.

Licence is the blocker here, not the technology: adsb.fi open data is **non-commercial
use only**. Rate limit is one request per second.

### CelesTrak

Orbital element sets for the satellite layer (phase 2). Verified on 2026-08-19 against
NORAD 25544 (the ISS), captured as `tests/fixtures/celestrak_iss_omm.json`.

Four things that will cost you time if you skip them:

- The response is **OMM JSON mean elements**, not TLE line format. Field names are
  `MEAN_MOTION`, `ECCENTRICITY`, `INCLINATION`, `BSTAR` and so on. `satellite.js` takes a
  TLE by default, so either build the TLE lines or use its OMM entry point.
- `EPOCH` is a **naive** ISO timestamp (`2026-08-19T12:48:46.640160`) but is UTC by
  specification. Attach UTC in the adapter or every propagation is offset by the local
  timezone.
- **Always pass `FORMAT` explicitly.** The default changed to CSV in May 2026, so a
  request without it silently stops being JSON.
- **Never fetch a group more than once per two-hour window.** CelesTrak permanently
  firewalls abusive clients, without appeal. That guard belongs in code with a test, not
  in configuration. This file's verification was done once today and deliberately not
  repeated while writing these notes.

### USGS earthquake feed

`all_hour.geojson` is every earthquake in the last hour, worldwide, as GeoJSON. Captured as
`tests/fixtures/usgs_all_hour.json`. Public domain as a US Government work, so attribution
is courtesy rather than a licence condition, and we credit it anyway.

### NASA EONET

Natural event tracking (wildfires, storms, volcanoes) as GeoJSON. Captured as
`tests/fixtures/eonet_events.json`. Events carry categories, which is what the phase 5
icon set keys off.

### NASA GIBS

The default basemap, and the reason the app needs no Cesium ion token to render something
real. WMTS in EPSG:3857, verified via
`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/1.0.0/WMTSCapabilities.xml` on
2026-08-19. Daily true-colour layers are date-addressable, which is what phase 7 wires to
the timeline.

### ADS-B Exchange, and the three ways in

The reason this provider matters, in one line: **it does not filter.** adsb.lol and most
aggregators drop or fuzz aircraft that appear on FAA blocking programmes, and ADS-B Exchange
has never done that. So it carries aircraft no other feed carries, which is precisely the
population this project profiles. ADR 009 already decided we work through those opt-outs, and
ADR 010 makes ADS-B Exchange a first-class provider rather than an optional extra.

Three access routes, verified on 2026-08-19, and only two of them are usable.

**The paid API, which is the route.** `https://adsbexchange-com1.p.rapidapi.com/v2/mil/`
answered HTTP 401 with `{"message":"Invalid API key..."}` from RapidAPI itself, so the host,
the path shape and the gate are all confirmed live: it is the readsb `/v2` schema behind a
RapidAPI key. Entry pricing is around $10 a month for roughly 10,000 requests, which
continuous polling burns through in about a day, so the cadence has to be demand-driven
rather than a fixed poll. The provider also grants API access to anyone feeding data into the
network, which is the cheaper route if a receiver goes up. That feeder route is documented by
the provider and **has not been verified here**.

**The globe map, which is not the route.** `https://globe.adsbexchange.com/` serves the map
page (HTTP 200), but every data endpoint behind it is closed: `/data/aircraft.json` and
`/re-api/?binCraft` both answered **HTTP 403, "Request forbidden by administrative rules."**
And `https://globe.adsbexchange.com/robots.txt` disallows `/api/`, `/mapproxy/`, `/re-api/`
and `/globe_history/` by name while allowing only the static pages. That is the provider
stating a crawl directive, and honouring `robots.txt` in code is one of this project's own
rules, so scraping the map is out on two independent counts before anyone reaches the terms.

One thing that keeps ADS-B Exchange in the verified table despite no payload having been
seen: it serves the readsb `/v2` schema, and that schema is verified here against three other
providers with captured fixtures. The shape is known-good from adsb.lol. AISHub is the
opposite case, a shape unique to itself with no payload captured, which is why it sits in the
planned table below.

**The commercial route, which may already exist.** ADS-B Exchange has been owned by **JETNET
since 2023**, and Altrata licenses JetNet aircraft ownership data. A redistribution
permission may therefore be obtainable internally rather than bought, and that conversation
is worth having before anyone pays a RapidAPI invoice. It needs to happen anyway: **the
provider's terms prohibit redistributing or publishing the data**, and serving positions to
a browser is redistribution. That is a licence blocker on this layer, recorded in the audit
below.

### airplanes.live and adsb.one

Two more community networks that also decline to filter, both serving the identical readsb
`/v2` schema, which is why they cost nothing in parser work.

**airplanes.live** answered HTTP 403 on `/v2/mil` with a plain-text ask rather than a wall:
`{"error": "Please contact us at contact@airplanes.live. Your email MUST include any links, a
description of the project, and any information you deem appropriate."}` So access is gated
on asking, not on paying. Sending that email is a phase 3 task, and until it is answered
nothing in code may assume the shape of a successful response.

**adsb.one** answered HTTP 403 behind Cloudflare from this network on 2026-08-19. That may be
this IP rather than the provider's policy, so it stays a candidate rather than a plan.

### AISHub

Crowd-sourced AIS from a contributor network, and the third vessel source alongside
Fintraffic Digitraffic and aisstream.io. Worldwide coverage, free, and gated behind a
condition none of the other feeds in this project has.

**You have to run a receiver.** Verified on `https://www.aishub.net/join-us` on 2026-08-19,
in their own words: every contributor must provide at least one raw AIS feed in NMEA format,
and API access to the aggregated feed requires that feed to hold **coverage of at least 10
vessels averaged over 7 days, at least 90% uptime, downsampling no coarser than 60 seconds
and delay no worse than 10 seconds**. You stream raw NMEA to a UDP port they allocate by
email, and the account and API key follow once the feed is up and meets the bar.

**The obvious shortcut is prohibited by name.** Their terms bar synthesized or artificially
generated NMEA, scraped or stolen data, and **data from publicly available AIS sources or
services**. So you cannot bootstrap membership by piping aisstream.io or Digitraffic back
into AISHub. Access costs a real antenna within VHF range of real shipping, which is a
procurement and siting task rather than a coding one, and it is the long lead time on this
source.

**The endpoint and its parameter contract**, from `https://www.aishub.net/api` on
2026-08-19:

```
https://data.aishub.net/ws.php?username=&format=&output=&compress=
                              &latmin=&latmax=&lonmin=&lonmax=&mmsi=&imo=&interval=
```

`format` is 0 for AIS-encoded values or 1 for human-readable. `output` is `xml`, `json` or
`csv`. `compress` is 0, 1 (ZIP), 2 (GZIP) or 3 (BZIP2). The bounding box is four separate
parameters, `mmsi` and `imo` accept comma-separated lists, and `interval` caps the age of
returned positions in minutes, which is the parameter that keeps a poll cheap.

Five traps, all from the same page, and each one is the kind that ships a broken layer:

- **`output` defaults to `xml`.** Pass it explicitly every time, exactly like CelesTrak's
  `FORMAT`.
- **Failure is HTTP 200 with an empty body.** Called with `username=TEST` on 2026-08-19 it
  answered 200 and zero bytes. Their own note says the same about calling too often: "The web
  service will return nothing if executed more frequently". An empty 200 must be an error in
  the adapter, counted, never an empty vessel list treated as "no ships anywhere".
- **Once per minute, hard.** Not a courtesy figure, it is the documented behaviour, so the
  cadence floor is a constant in code with a test, same treatment as CelesTrak's two hours.
- **`format=0` values are scaled integers.** Longitude and latitude are degrees multiplied by
  600000 (1/10000 minute), course over ground is degrees times 10, speed over ground is knots
  times 10, draught is metres times 10. `format=1` gives degrees, knots and metres directly,
  which is why the adapter uses it.
- **Sentinels, not nulls.** Course over ground 3600 (`format=0`) or 360.0 (`format=1`) means
  not available; speed over ground 1024 or 102.4 means not available; heading 511 means not
  available in both; `IMO` 0 means absent. Each maps to `None` in the domain, never to a
  bearing of 360 degrees or a stationary vessel.

Two smaller shape notes. The timestamp field is named `TIME` in the JSON output and `TSTAMP`
in the XML and CSV outputs, for the same value. In human-readable form it arrives as
`"2021-07-09 08:06:53 GMT"`, which parses naive and needs UTC attached in the adapter, the
same fix CelesTrak's `EPOCH` needs. And `NAME` is capped at 20 characters upstream, so a
truncated vessel name is upstream truth rather than our bug.

**No payload has been seen.** The host answers and the parameter contract is published, but
without a username there is no response body, so this stays NOT YET VERIFIED and the wire
model must be written against a real captured response rather than against the table above.
That is the file's own rule and this source is exactly what it was written for.

### GeoNames `cities15000`

The city layer. Every populated place above 15,000 people, roughly 26,000 rows, with name,
country, admin division, population, timezone and coordinates. Verified on 2026-08-19 with
a ranged request that returned HTTP 206, so the file is there and is byte-servable.

It is a bulk file, not an API, which is the point: cities do not move, so this is a weekly
download into a local index rather than a poller. `cities1000` exists if a denser set is
ever wanted, at roughly 140,000 rows. Licence is CC BY 4.0, confirmed in
`https://download.geonames.org/export/dump/readme.txt` on the same date, so the credit line
is a licence condition and not a courtesy.

The file is latin-1-tolerant tab-separated text with no header row and a fixed 19-column
layout. Column 6 is latitude and column 7 is longitude, in that order, which is the
opposite of our contract order and gets flipped in the adapter.

### Wikidata WDQS

The person and organisation layer. Verified on 2026-08-19 with a live SPARQL query for
instances of city (`wd:Q515`), which returned HTTP 200 and JSON results.

Two operational facts. WDQS enforces a 60-second query timeout and will drop a query that
exceeds it, so an unbounded property scan is not an option and every query ships with a
`LIMIT`. And it requires a descriptive User-Agent with contact details; a generic client
string gets blocked rather than throttled.

### Wikimedia Commons geosearch

Reference imagery for a place, and the one image source whose coordinates come from the
upstream rather than from parsing text. Verified on 2026-08-19 against London
(`51.5074|-0.1278`, 1,000m radius), HTTP 200.

Licences are per file, not per source, so the file's own licence and author have to be
fetched with it and rendered on the card. There is no blanket credit string that covers
this source.

### OpenStreetMap notes

Crowd-sourced text at a real coordinate: a note is a free-text comment a mapper left at a
location. Verified on 2026-08-19 over a London bounding box, HTTP 200.

This is the honest half of the social layer. The coordinate is the subject of the note
rather than a guess derived from its words, and it carries no claim about where the author
was. Notes are user-submitted text, so they are the least trustworthy input in the system
and get the treatment in `AGENTS.md` under Data sourcing.

### Mastodon public timeline

Geolocated social posts, with the caveat that makes the layer what it is: **a Mastodon
status object carries no coordinates.** Verified on 2026-08-19 against `mas.to`, HTTP 200,
and the returned status keys are `account`, `card`, `content`, `created_at`, `tags`,
`media_attachments`, `language`, `visibility` and the counts. There is no latitude, no
longitude and no place object anywhere in the shape.

So any position on a post is derived from its text and its hashtags, and the card says so
in those words. See ADR 005.

**`mastodon.social` no longer serves this endpoint anonymously.** It answered HTTP 422
`{"error":"This method requires an authenticated user"}` on 2026-08-19, with and without
`local=true`. `mas.to` answered 200 for the identical request. Instance policy is per
instance and changes without notice, so the instance list is configuration and a 401, 403
or 422 from one instance drops it for the cycle rather than failing the feed.

### GDELT DOC 2.0 article search

The news-mention source behind person location evidence in phase 6, and the input to the
occupancy estimate's contradiction check in phase 12 (ADR 011, ADR 012). Verified on
2026-08-19 with `query="Elon Musk"&mode=artlist&maxrecords=3&format=json&timespan=3d`,
HTTP 200, real articles returned.

Four facts worth having before anyone writes the adapter.

**It states its own rate cap in a 429, and the first request got one.** The body reads
"Please limit requests to one every 5 seconds", so the floor is five seconds, in code, with
the article search cached per profile. The 429 body is **plain text, not JSON**, and it is
prepended to the body even on a subsequent 200, so a parser must find the JSON rather than
assume the whole body is JSON.

**`mode=artlist` returns no coordinates.** Each article carries `url`, `title`, `seendate`,
`domain`, `language`, `sourcecountry` and a social image. `sourcecountry` is where the
outlet is, not where the person was, and conflating the two would be a fabricated location.
The place comes from the article text matched against the phase 4 city gazetteer, so a
mention is `derived` and city-level like a Mastodon post, never `upstream`.

**A mention is a report about a person, not an observation of one.** It carries the article
as its source and the publication date as its date, and it needs corroboration from an
independent origin before it is asserted, per ADR 011. Syndication makes this bite: the same
wire story on twelve domains is one source, not twelve.

**Results are multilingual by default.** The verified response mixed English, Persian and
other languages, so language is a filter decision the adapter makes explicitly rather than
something to be surprised by.

### Sentinel-2 scenes: Element 84 earth-search

The source that answers "show me this place on this date". The NASA GIBS basemap cannot: it
is a tile service pinned to a global daily mosaic. This returns the actual Sentinel-2 scenes
covering a bounding box in a date range. Verified on 2026-08-19 with a POST to `/v1/search`
over a London bounding box for 1 to 19 August 2026, HTTP 200, two scenes returned.

Keyless. The search is a POST carrying `collections`, `bbox` and `datetime`. Each feature
holds per-band assets plus `visual`, the true-colour composite, as a Cloud-Optimised GeoTIFF
on S3.

**Both London scenes came back at essentially 100% cloud cover.** That single fact decides
whether this layer is any good. `eo:cloud_cover` is on every feature, and a search that does
not filter or rank on it returns white rectangles and looks broken. Filter in the adapter, and
put the scene's own date on the card, because it will often not be the date that was asked
for.

Sentinel-2 revisits a given point roughly every five days, so imagery for today does not exist
for most places on most days. The contract carries the scene timestamp, never the requested
one, and a request with no usable scene returns nothing rather than the nearest cloudy thing.

A Cloud-Optimised GeoTIFF is not a browser image. Serving `visual` to Cesium means a
server-side tile cut or a rendered snapshot, which is what the Worldview snapshot API below is
for.

### Copernicus Data Space OData catalogue

The first-party catalogue for the same Sentinel data, and the fallback if the AWS mirror goes
away. Verified on 2026-08-19 with `$filter=Collection/Name eq 'SENTINEL-2'&$top=1`, HTTP 200,
a real product record returned.

Search is keyless. Download is not: product bytes need an OAuth token from the Copernicus
identity service and the token carries a quota. So the catalogue is usable today for "what
imagery exists here", and the download path needs an account registered before any code
depends on it.

### NASA Worldview snapshot API

The rendered-image route, and the one that needs no GeoTIFF handling at all. Verified on
2026-08-19 for a London box on 2026-08-15, HTTP 200, `image/jpeg`, 41KB.

Give it a layer, a date, a bounding box and a size, and it renders. That makes it the right
source for a picture on a profile card or an event card, where the need is an image of a place
on a day rather than pixels to analyse.

**Its `BBOX` is `south,west,north,east` in `EPSG:4326`, latitude first.** That is the opposite
of this project's `[longitude, latitude]` rule, so the flip happens in the adapter and nowhere
else. Getting it wrong returns a valid image of the wrong place, which is the failure nobody
spots.

### TfL JamCams

889 London traffic cameras, and they need no key at all. Verified on 2026-08-19, HTTP 200, and
one still pulled live from S3 at `image/jpeg`, 14.8KB.

This file previously recorded an app key as required. It is not, at this volume. A key raises
the rate limit rather than granting access.

Coordinates are `lat` and `lon` at the top of the record. Everything else sits inside
`additionalProperties` as key-value pairs, so the adapter reads `available`, `imageUrl`,
`videoUrl` and `view` out of a list rather than off the object. `available` is the one that
matters: a camera can be listed and dark, and presenting its last frame as live is the bug this
layer will actually ship with if nobody checks.

The inventory response is 1.1MB. Fetch it daily, not per view.

### New York 511 traffic cameras

2,931 cameras across New York State, keyless, with coordinates on every record. Verified on
2026-08-19, HTTP 200, 858KB.

This is the live-video source rather than a stills source. 1,561 records are enabled and carry
a `VideoUrl`, which is an HLS playlist (`.m3u8`) on the state's video host. There is no
still-image field anywhere in the record, so a camera here is a stream or it is nothing.

1,066 of the 2,931 are `Disabled`. There is a second flag, `Blocked`, at zero across the whole
feed on the verification date, which the operator sets to pull a camera during an incident.
Both are honoured before a camera is offered, and a blocked camera is removed rather than
greyed out.

Restreaming someone else's HLS through our proxy is a different licence question from proxying
a JPEG. Settle it before the layer ships publicly.

State 511 programmes are not interchangeable. WSDOT answered HTTP 401 without a key on
2026-08-19. Each state is its own adapter and its own row in this file.

### Reference photographs of named people

The reference set behind the face-matching path in ADR 013. Wikidata P18 resolved to Commons:
`SELECT ?img WHERE { wd:Q317521 wdt:P18 ?img }`, verified on 2026-08-19, HTTP 200, returning a
`Special:FilePath` URL on Commons.

That gives a licensed photograph attached to a known entity, which is what a reference face has
to be. The file's own licence travels with it like any other Commons item. A person with no P18
has no reference face, so no match is possible and none is asserted. This is a per-entity
lookup on a user action, cached, never a bulk scrape of Commons.

---

## Planned, NOT YET VERIFIED

None of these has been called from this project. Each is a phase deliverable, and each must
be called and moved into the verified table before any code depends on its shape.

| Source | Purpose | Phase | Auth | Known constraints | Licence | Status |
| --- | --- | --- | --- | --- | --- | --- |
| aisstream.io | Live ship positions over WebSocket | 2 | Free API key | Beta, no SLA. Key must never reach the browser | Provider terms, check before commercial use | NOT YET VERIFIED |
| adsbdb | Aircraft registry: owner, operator, type | 3 | None expected | Cache per hex; no repeat call within a session | Check before commercial use | NOT YET VERIFIED |
| Nominatim | Place geocoding for search | 4 | None, but requires descriptive User-Agent with contact details | Roughly 1 request per second. Must be server-side and cached. Bulk use is prohibited | ODbL (OSM data) | NOT YET VERIFIED |
| GDELT GEO 2.0 | Geolocated news coverage density | 5 | None | 429 backoff needed. Planned cadence 15 minutes | GDELT terms, attribution required | NOT YET VERIFIED |
| Windy Webcams v3 | Owner-submitted public webcams | 5 | API key, confirmed mandatory | Answered HTTP 403 `Missing Header 'x-windy-api-key'` on 2026-08-19, so the key gate is verified and the payload shape is not. **Image tokens expire after 10 minutes.** Never cache an image URL beyond validity | Provider terms, non-commercial tiers exist | KEY GATE VERIFIED, SHAPE NOT |
| US 511 programmes beyond New York | State traffic cameras outside NY | 8 | Varies by state | Not one API. WSDOT answered HTTP 401 without a key on 2026-08-19. Each state is its own adapter and its own row here | Per state, usually open data | NOT YET VERIFIED |
| Copernicus Data Space download | Sentinel product bytes, not just the catalogue record | 7 | OAuth token from the Copernicus identity service | Catalogue search is already verified and keyless. Only the byte download needs the account and carries the quota | Copernicus free, full and open | NOT YET VERIFIED |
| Public live-stream webcams | Owner-published city, port and landmark streams | 8 | Varies | Owner-published only. Each stream is checked individually for a publish-to-web intent before it is used | Per stream | NOT YET VERIFIED |
| Wikidata (`wbsearchentities`, WDQS SPARQL) | Notable public entities and their static places | 6 | None, but requires descriptive User-Agent | No SPARQL per keystroke. Server-side cache. The ADR 002 property allowlist is lifted (ADR 004) and the residence exclusion with it (ADR 006, ADR 008); every returned place still needs a date and a source | CC0 | NOT YET VERIFIED |
| Wikipedia REST | Person and place summaries, geosearch | 6, 7 | None, but requires descriptive User-Agent | Respect the Wikimedia API etiquette limits | CC BY-SA 4.0 | NOT YET VERIFIED |
| Overpass | OSM points of interest by tile | 7 | None, but requires descriptive User-Agent with contact | Fair use roughly 10,000 queries per day per IP. Never called from the browser. Persistent cache required | ODbL (OSM data) | NOT YET VERIFIED |
| Cesium ion | OSM Buildings 3D Tiles, optional terrain | 7 | Client-side ion token | Community tier quota. Token is client-side by design | **Non-commercial community tier, paid past $50k organisation revenue** | NOT YET VERIFIED |
| EOX Sentinel-2 cloudless | Static high-resolution basemap option | 7 | None expected | Check which mosaic year you are pointing at | **CC BY-NC on newer mosaics** | NOT YET VERIFIED |
| FAA Releasable Aircraft Database | Aircraft ownership: owner name and registered address | 5 | None | Weekly bulk zip. Owner address is ingested as a dated, sourced profile attribute per ADR 008, dated to the extract | Public domain (US Government work) | NOT YET VERIFIED |
| ITU MARS | Vessel registry, MMSI to name and flag | 5 | None expected | Registration may be needed for bulk access | ITU terms | NOT YET VERIFIED |
| SEC EDGAR | Officers, directors, insider holdings | 6 | None | 10 requests per second, declared User-Agent with contact mandatory | Public domain | NOT YET VERIFIED |
| Companies House | Officers, persons with significant control, registered office | 6 | Free key | 600 requests per 5 minutes. Key never reaches the browser | Open Government Licence 3.0 | NOT YET VERIFIED |
| FEC OpenFEC | Donor name, employer, occupation | 6 | Free key | 1,000 requests per hour on the standard key | Public domain | NOT YET VERIFIED |
| ProPublica Nonprofit Explorer | Foundation trustees and assets | 6 | None expected | Attribution required | ProPublica terms | NOT YET VERIFIED |
| AISHub | Crowd-sourced vessel positions, worldwide | 2 | Username, granted only to contributors running a physical AIS receiver | **Once per minute, hard.** An over-frequent call returns nothing. `output` defaults to XML. An invalid username answers **HTTP 200 with an empty body**, not an error | Contributor terms, no redistribution grant stated | NOT YET VERIFIED |
| Flickr | Geotagged photographs with author text | 8 | Free key | `has_geo=1` with a bbox. Endpoint reached on 2026-08-19 and correctly rejected a null key, so the shape is unconfirmed. Per-photo licence must be read; commercial use needs a CC filter | Per-photo | NOT YET VERIFIED |
| Bluesky (`public.api.bsky.app`) | Social posts, text only | 8 | None documented | **Answered HTTP 403 from this network on 2026-08-19** for `app.bsky.feed.searchPosts` while `app.bsky.actor.getProfile` answered 200, so search is gated. Posts carry no coordinates | Per-post | NOT YET VERIFIED |

---

## Licence audit

Read this before anyone says the word "launch".

**The project is not currently licensed for commercial deployment.** Three sources block
it, and two of them are load-bearing.

1. **adsb.fi is non-commercial use only.** It is the aircraft failover, so commercial use
   means either dropping the failover (and accepting that an adsb.lol HTTP 420 takes the
   military layer down, which has already happened once) or replacing it with a
   commercially licensed readsb v2 provider. The adapter makes that a base-URL change, and
   that is exactly why the provider-swap interface exists. See ADR 003.
2. **Cesium ion's community tier is non-commercial**, and flips to paid past $50,000 of
   organisation revenue. This one is contained: the buildings layer is optional, the app
   works with no ion token, and `/api/capabilities` reports the layer as unavailable with a
   reason (`src/tracker/api/routes_meta.py:93`).
3. **EOX Sentinel-2 cloudless is CC BY-NC on the newer mosaics.** Also contained, because
   it is one option in an imagery picker whose default is NASA GIBS.

**Camera restreaming is its own question, and it is not the same as proxying a JPEG.** TfL
JamCams are stills on S3 under TfL open data with a mandatory credit string, and proxying and
caching a still is ordinary use. New York 511 is live HLS on a state video host, and pulling
that through our proxy so a browser can play it is restreaming a third party's video. The
answer is probably fine under NYSDOT open data terms and it has not been read yet. Read it
before the camera layer ships publicly, not after.

**Copernicus imagery is free, full and open, with attribution that has to say it was
modified.** Any scene we cloud-filter, tile-cut or composite is modified Copernicus Sentinel
data and the credit line has to say so with the year.

Clean for commercial use as far as their own terms go, with attribution honoured:
adsb.lol (ODbL 1.0), USGS (public domain), NASA GIBS and EONET, Wikidata (CC0), Wikipedia
(CC BY-SA 4.0). ODbL carries share-alike obligations on derived databases, so anything
that redistributes an aggregated store of adsb.lol data needs a licence read of its own,
not just an attribution line.

Also clean, with their credit conditions honoured: GeoNames (CC BY 4.0), OpenStreetMap
notes (ODbL, same share-alike caveat as any OSM data).

**ADS-B Exchange prohibits redistribution without written permission**, and this app serves
positions to browsers, which is redistribution. It is now a named provider (ADR 010), so this
is a live blocker on the aircraft layer rather than a note about an optional extra. Two ways
through: written permission from the provider, or the internal JETNET route, since JETNET has
owned ADS-B Exchange since 2023 and Altrata licenses JetNet. Settle it before the layer ships
publicly, not after.

Unresolved and needing a read before they ship: aisstream.io (beta, terms may change),
adsbdb, Windy (tier-dependent), GDELT, ITU MARS, ProPublica, airplanes.live (terms come with
the access grant), **AISHub**. AISHub says contributors may use the aggregated data for free,
which is a use grant and not a redistribution grant, and this app serves positions to
browsers. Same question as ADS-B Exchange, and it needs asking before the vessel layer ships
publicly rather than after.

**Per-item licensing is its own category.** Wikimedia Commons, Mastodon and Flickr license
each record separately, so there is no source-level answer. A Commons file may be public
domain or CC BY-SA; a Flickr photo may be all rights reserved. The rule is that the item's
own licence and author travel with the record through the domain contract and are rendered
on the card, and any item whose licence cannot be determined is dropped rather than shown.
Flickr in particular needs its licence filter set before a commercial deployment, not
after.

## Attribution

Every visible layer renders its credit. These strings are served from the API rather than
hardcoded in the frontend, at `src/tracker/app.py:51`, so a new source cannot ship without
one.

Currently served, verbatim:

| Source | Credit string | Licence field |
| --- | --- | --- |
| adsb.lol | `Aircraft data from adsb.lol` | `ODbL 1.0` |
| adsb.fi | `Aircraft failover data from adsb.fi` | `Non-commercial use` |
| NASA GIBS | `Imagery courtesy of NASA EOSDIS GIBS` | `Public domain, attribution requested` |

Required for the planned sources, to be added with the code that uses them:

| Source | Required credit |
| --- | --- |
| ADS-B Exchange | `Aircraft data from ADS-B Exchange` |
| airplanes.live | `Aircraft data from airplanes.live` |
| AISHub | `Vessel data from AISHub` |
| CelesTrak | `Orbital elements from CelesTrak` |
| USGS | `Earthquake data from the U.S. Geological Survey` |
| NASA EONET | `Natural event data from NASA EONET` |
| OpenStreetMap (Nominatim, Overpass) | `Map data © OpenStreetMap contributors` under ODbL |
| Wikidata | `Data from Wikidata, CC0` |
| Wikipedia | `Text from Wikipedia, CC BY-SA 4.0`, with a link to the article |
| TfL | `Powered by TfL Open Data` (this exact wording is a condition of the licence) |
| Windy | `Webcams provided by Windy.com` |
| GDELT | `News coverage data from the GDELT Project` |
| Cesium ion | Cesium ion and the underlying OSM Buildings credit, rendered by Cesium's own credit display |
| EOX | `Sentinel-2 cloudless by EOX IT Services GmbH` with the mosaic year and its CC licence |
| Copernicus / Sentinel-2 | `Contains modified Copernicus Sentinel data [year]` |
| TfL | `Powered by TfL Open Data` |
| New York 511 | `Camera imagery courtesy of NYSDOT 511NY` |
| GeoNames | `City data from GeoNames, CC BY 4.0` |
| OpenStreetMap notes | `Map notes © OpenStreetMap contributors` under ODbL |
| Wikimedia Commons | Per file: the file's own licence, its author and a link to the file page |
| Mastodon | Per post: the instance domain, the author handle and a link to the original post |
| Flickr | Per photo: the photographer, the photo's own licence and a link to the photo page |

Four rules that sit alongside the strings. Wikipedia's CC BY-SA needs a link to the source
article, not just the word "Wikipedia". TfL's wording is fixed by their terms and must not
be paraphrased. Commons, Mastodon and Flickr are licensed per item rather than per source,
so their credit is assembled from the record and a card cannot render without it. GeoNames
is CC BY, so its credit is a condition and not a courtesy.
