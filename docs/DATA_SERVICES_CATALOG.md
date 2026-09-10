# Data Services Catalog — for operator review

Updated: 2026-08-29

This document answers "what other services can I add through API signup?" and
records which free/no-key services are already wired. Every "verified live"
claim below was checked against the real service on 2026-08-29 from this
machine; everything marked "documented, unverified" still needs a live probe
before we build on it. Nothing in this document was implemented yet unless it
says so — this is the review copy.

## Legend

- **Key** — signup required (link in the row). Free tier noted where one exists.
- **Keyless** — works with no account; we still proxy it server-side to cache
  and to keep a single point for rate limiting.
- **Wired** — already integrated in this repo today.

## 1. Already wired (today's data plane)

| Service | Layer(s) | Key | Notes |
|---|---|---|---|
| Google Photorealistic 3D Tiles | basemap | **required** `GOOGLE_MAPS_API_KEY` | The globe itself. |
| OpenSky Network | flights | optional `OPENSKY_*` | OAuth client-credentials; anonymous tier is heavily limited. |
| adsb.lol | military flights, traces | keyless | Also our fallback civil feed. |
| adsbdb | aircraft type/route enrichment | keyless | Browser-cached 30 d since `a9710e3` (localStorage tier). |
| AISStream | vessels | optional `AISSTREAM_API_KEY` | WebSocket; production needs Durable Objects (see Known gaps). |
| CelesTrak | satellites (SGP4) | keyless | TLE groups are immutable-ish — next candidate for the localStorage tier. |
| USGS | earthquakes | keyless | |
| NASA FIRMS | fire detection | optional `NASA_FIRMS_API_KEY` | WASM heatmap renderer lives in `rust/firms-renderer`. |
| TomTom | traffic tiles | optional `TOMTOM_API_KEY` | |
| Launch Library 2 | rocket launches | optional `LAUNCH_LIBRARY_2_TOKEN` | |
| Radio Browser | radio stations | keyless | Community DB; be gentle, cache hard. |
| GBFS feeds | bikeshare | keyless | Many city endpoints; per-city politeness. |
| Austin data.austintexas.gov, Caltrans, TfL | CCTV | keyless | See CCTV audit (task #29). |
| OpenStreetMap Overpass | annotation geocoding | keyless | Multi-mirror failover already implemented. |
| OpenAI | voice + HUD AI summary | optional `OPENAI_API_KEY` | Ported to Pages Functions in `8e66429`. |

## 2. Verified live today, not yet integrated

### OpenZenith — free elevation, geocoding, reverse geocoding (no key)

`https://www.openzenith.org` — "Free Global Elevation API & Geospatial Tools…
No API key required." Their robots.txt disallows `/api/proxy/` only; the JSON
endpoints below are allowed and answered `access-control-allow-origin: *`,
`cache-control: public, max-age=3600` (they cache server-side too).

Contracts captured live on 2026-08-29:

```
GET /api/elevation?lat=30.2&lon=-97.7
→ 200 {"requestId":"oz-mteoeu7p","elevation":114,"surface_type":"land",
       "unit":"meters","location":{"lat":30.2,"lon":-97.7},
       "source":"ozt2","tile":"","resolution":30,"ok":true}

GET /api/elevation?latitude=…          (wrong param names)
→ 400 {"ok":false,"error":{"code":"INVALID_PARAM",
       "message":"Missing required parameters: lat, lon"}}

GET /api/geocode?query=Austin%20Tower
→ 200 {"requestId":"…","results":[{"display_name":…,"lat":…,"lon":…,
        "type":"apartments","importance":…,"address":{…}}],"count":…}
   (error shape: {"ok":false,"error":{…},"results":[],"count":0})

GET /api/reverse-geocode?lat=30.2&lon=-97.7
→ 200 {"place":{"display_name":"7024, Vail Ridge Street, … 78744, United States",
        "name":"7024","type":"yes","address":{"house_number":"7024",
        "road":"Vail Ridge Street","city":"Austin",…,"country_code":"us"},
        "osm_id":824608455,"osm_type":"way"},
       "location":{"lat":30.2,"lon":-97.7}}
```

Where this lands in our app (proposal, task #37):

1. **Tracked-target address readout** — reverse-geocode the tracked aircraft /
   vessel / camera target at click time (one call per selection, then
   localStorage-cached by rounded coordinate) so the HUD can show a street
   address under the coordinates. This is the "address data" ask.
2. **Ground-truth elevation** — `surface_type` + `elevation` as a cross-check
   for the existing terrain-height proxy, and as a keyless fallback when no
   Google/Bing terrain sample is available (drones over open water, CCTV
   placements, radio masts).
3. **Geocode mirror** — annotation resolver currently relies on Overpass
   mirrors; OpenZenith `/api/geocode` is a Nominatim-shaped fallback when all
   mirrors rate-limit us.

Integration shape (same as every other proxy): a Pages Function
`functions/api/openzenith/[[path]].js` forwarding `elevation` /
`geocode` / `reverse-geocode` only, with the browser localStorage tier on top
(30 d TTL for elevation by 3-decimal tile; addresses are effectively
immutable). Direct browser calls work (CORS `*`) but bypass our cache and
burn their goodwill — we proxy.

Also advertised (documented, unverified — probe before relying): weather,
flight tracking, earthquake, satellite, marine endpoints. `/api/earthquakes`
answered live with a USGS GeoJSON passthrough; `/api/flights` and
`/api/satellites` timed out at 8 s during the probe (do not build on them
until they answer).

## 3. Candidate additions, by value to this app

Ordering is my recommendation for review; "P1" rows are the ones I would wire
first after the current phase lands. Nothing here is integrated.

### P1 — fills an obvious gap in an existing layer

| Service | What it adds | Key / cost | Status |
|---|---|---|---|
| **Open-Meteo** (open-meteo.com) | Real weather per coordinate — winds aloft for the tracked aircraft readout, precip overlay for FIRMS context. Non-commercial free, no key, generous limits. | Keyless | Documented, unverified |
| **RainViewer** (rainviewer.com) | Global precipitation radar tiles (past + nowcast) — the missing "weather" overlay the HUD's scene summary keeps wanting. Free tile API, no key. | Keyless | Documented, unverified |
| **OpenAIP** (openaip.net) | Airports, airspaces, navaids, hotspots — makes military + civil flight layers navigable ("fly me to the nearest MOE"). Free with API key. | Key, free | Documented, unverified |
| **aviationweather.gov (METAR/TAF)** | Live station weather decoded into the airport/CCTV panels. NOAA, keyless, official. | Keyless | Documented, unverified |
| **OpenRouteService** (openrouteservice.org) | Driving/flight-legend routing + isochrones for the ground layer. Free tier with key (2,000 dir/day). | Key, free | Documented, unverified |
| **Wikidata/OSM Nominatim (self-host or paid)** | Institutional geocoding depth (military bases by name) beyond Overpass. Nominatim public policy forbids bulk/heavy app use — self-host or use paid. | Key, free tier | Documented, unverified |

### P2 — new layers with real value

| Service | What it adds | Key / cost | Status |
|---|---|---|---|
| **GDACS** (gdacs.org) | Global disasters (floods, cyclones, wildfires, volcanoes) with severity scores — pairs naturally with quakes + FIRMS. Keyless RSS/GeoJSON. | Keyless | Documented, unverified |
| **NOAA SWPC** (swpc.noaa.gov) | Space weather (Kp index, solar wind, aurora oval) — the HUD and the satellite layer both have a natural slot for it. Keyless JSON. | Keyless | Documented, unverified |
| **Whooo's Reading / Transitland / GTFS directories** | Live public transit vehicles in supported metros (GTFS-Realtime). Key varies per agency; Transitland aggregates. | Mixed | Documented, unverified |
| **OpenAQ** (openaq.org) | Air-quality sensors (PM2.5, etc.) as a point layer. Free key. | Key, free | Documented, unverified |
| **Wikipedia geosearch** | Point-of-interest callouts for anything on screen (`action=query&generator=geosearch`). Keyless, politeness policy applies. | Keyless | Documented, unverified |

### P3 — paid / heavier, only if a specific need emerges

| Service | What it adds | Cost reality |
|---|---|---|
| MarineTraffic / VesselFinder | Global AIS beyond AISStream's community basins | Paid; AISStream free tier already covers our demo scope |
| FlightAware / Cirium | Airline schedule + flight status to join against tail numbers | Paid |
| Mapbox / HERE / Stadia | Basemap + routing alternates | Free tiers small; we already have Google 3D + Bing + OSM |
| Planet / Sentinel Hub | Fresh satellite imagery layers | Paid (Sentinel has free tiers with registration) |

## 4. Known gaps in the current data plane (honest list)

1. **CCTV in production** — the dev middleware lives in `vite.config.js`; a
   static deploy has no such server. Port in progress (task #29): shared
   source module + `functions/api/cctv/[[path]].js`.
2. **AISStream WebSocket in production** — Pages Functions can't hold a
   persistent upstream WebSocket without Durable Objects (paid Workers plan).
   Until then the vessels layer needs an HTTP fallback or stays dev-only.
   Honest status, not fixed by this phase.
3. **Keyed heavy proxies not yet ported to Functions** — gbfs, tomtom, firms,
   opensky, google/* (nearby-places, text-search), military-installations,
   regional-brief, weather-effects. They work in dev; in production they 404
   until ported. Porting order should follow actual usage.
4. **Per-isolate rate limits** — Pages Functions limiters are per-isolate;
   they protect upstreams from a single runaway client, not from global
   traffic. Documented here so nobody assumes global quotas exist.
5. **Dependabot reports 11 vulnerabilities** (8 high, 3 moderate) on the
   default branch as of 2026-08-29 — triage under the CI/security task, not
   in this phase.

## 5. Signup checklist (operator actions)

If you want the P1 rows wired, the keys to obtain are:

- [ ] OpenAIP — https://www.openaip.net (free account)
- [ ] OpenRouteService — https://openrouteservice.org/dev (free account)
- [ ] OpenAQ — https://explore.openaq.org (free account)
- (no signup needed for Open-Meteo, RainViewer, METAR, GDACS, SWPC, Wikidata,
   OpenZenith)

Add them to `.env` (see `.env.example`) and to the Pages project env vars; the
app degrades honestly (`KEY REQUIRED` row state) for any that stay unset.
