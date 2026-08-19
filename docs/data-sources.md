# Data sources

The single source of truth for feed facts: endpoint, auth, cadence, licence, cost, and the
date someone actually called it and got a 200 back.

**The rule.** No endpoint goes in the verified table until it has been called successfully
and this file updated with the date. Nothing in the planned table may be relied on in code
until it has been called and moved up. If you are about to write an endpoint into an
adapter and it is marked NOT YET VERIFIED here, call it first. Guessing an endpoint shape
from documentation is how a layer ships broken.

Every row added to this file belongs in the same commit as the code that uses it.

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
| Windy Webcams v3 | Owner-submitted public webcams | 5 | API key | **Image tokens expire after 10 minutes.** Never cache an image URL beyond validity | Provider terms, non-commercial tiers exist | NOT YET VERIFIED |
| TfL JamCams | London traffic cameras | 5 | App key | Inventory refreshed daily. Availability flag must be respected: no frozen JPEG presented as live | TfL open data, credit string mandatory | NOT YET VERIFIED |
| Wikidata (`wbsearchentities`, WDQS SPARQL) | Notable public entities and their static places | 6 | None, but requires descriptive User-Agent | No SPARQL per keystroke. Server-side cache. Query is restricted to the property allowlist, see ADR 002 | CC0 | NOT YET VERIFIED |
| Wikipedia REST | Person and place summaries, geosearch | 6, 7 | None, but requires descriptive User-Agent | Respect the Wikimedia API etiquette limits | CC BY-SA 4.0 | NOT YET VERIFIED |
| Overpass | OSM points of interest by tile | 7 | None, but requires descriptive User-Agent with contact | Fair use roughly 10,000 queries per day per IP. Never called from the browser. Persistent cache required | ODbL (OSM data) | NOT YET VERIFIED |
| Cesium ion | OSM Buildings 3D Tiles, optional terrain | 7 | Client-side ion token | Community tier quota. Token is client-side by design | **Non-commercial community tier, paid past $50k organisation revenue** | NOT YET VERIFIED |
| EOX Sentinel-2 cloudless | Static high-resolution basemap option | 7 | None expected | Check which mosaic year you are pointing at | **CC BY-NC on newer mosaics** | NOT YET VERIFIED |

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

Clean for commercial use as far as their own terms go, with attribution honoured:
adsb.lol (ODbL 1.0), USGS (public domain), NASA GIBS and EONET, Wikidata (CC0), Wikipedia
(CC BY-SA 4.0). ODbL carries share-alike obligations on derived databases, so anything
that redistributes an aggregated store of adsb.lol data needs a licence read of its own,
not just an attribution line.

Unresolved and needing a read before they ship: aisstream.io (beta, terms may change),
adsbdb, Windy (tier-dependent), GDELT.

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

Two rules that sit alongside the strings. Wikipedia's CC BY-SA needs a link to the source
article, not just the word "Wikipedia". TfL's wording is fixed by their terms and must not
be paraphrased.
