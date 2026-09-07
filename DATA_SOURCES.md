# Data Sources & Attribution

God's Eye View's **code** is [MIT](LICENSE)-licensed. **The MIT grant covers the source code only — it does NOT extend to third-party data or visual assets.** Every third-party source keeps its own license and terms. This file documents the live and bundled data sources; bundled 3D-model provenance is recorded in [`public/models/README.md`](public/models/README.md).

How to read this:

- **The non-permissive datasets are carved out, not omitted.** Some bundled data (e.g. TeleGeography, CC BY-NC-SA) isn't MIT-compatible. Rather than hide it, we **bundle it with a clear license carve-out** so the app works out of the box — but it stays under the provider's terms.
- **If your use doesn't fit a dataset's license, remove that dataset.** Most importantly: TeleGeography is **NonCommercial** — commercial users must delete it (or license it from TeleGeography). It's one self-contained folder.
- **Attribution is shown in-app** and listed here. Active Azure Maps/OSM,
  terrain, CesiumJS, and per-layer credits render through the bottom-left
  `#cesium-credits` line and its expandable **Data attribution** lightbox. Keep
  them visible in clean-view and recording modes.
- **Bundled model attribution lives beside the model files.** [`public/models/README.md`](public/models/README.md) records each shipped model's creator, source, license, and modification status.

---

## Live sources (fetched at runtime — not stored in this repo)

| Source | Used for | License / terms | Attribution |
|--------|----------|-----------------|-------------|
| **Azure Maps** raster tiles, search, reverse geocoding, routing, traffic status, and attribution | Globe imagery, navigation, annotations, routes, and scene context through the same-origin BFF | [Microsoft Product Terms](https://www.microsoft.com/licensing/terms/productoffering/MicrosoftAzure/MCA) and Azure Maps terms | View-dependent values returned by the Azure Maps attribution endpoint |
| **Microsoft Foundry** | Realtime voice tool selection and bounded HUD summaries through the BFF | Microsoft Azure Product Terms and the configured model's terms | AI-generated output is identified by the voice/HUD surface; no provider credential is shown |
| **OpenSky Network** | Primary worldwide live-flight snapshot | Non-commercial research/education license | Schäfer et al., *"Bringing Up OpenSky"*, IPSN 2014 + opensky-network.org |
| **adsb.lol point API** | Bounded live-flight fallback when OpenSky has no usable snapshot | ODbL 1.0 | adsb.lol contributors; `api.adsb.lol/v2/lat/{lat}/lon/{lon}/dist/{radius}` |
| **adsb.lol** | Military flights + aircraft traces | ODbL 1.0 | "adsb.lol" (ODbL) |
| **AISStream.io** | Live vessels (AIS) | Free, beta, no formal ToS; AIS is a public broadcast | "AISStream.io" (courtesy) |
| **CelesTrak** | Satellite TLEs (SGP4) | US-government-origin data, no license; citation requested | "CelesTrak (celestrak.org), Dr. T.S. Kelso" |
| **OpenStreetMap raster tiles** | Explicit fallback when Azure Maps is unavailable | ODbL 1.0 and tile usage policy | "© OpenStreetMap contributors" |
| **USGS** | Earthquakes | U.S. public domain | "Data courtesy of the U.S. Geological Survey" |
| **OpenStreetMap (Overpass API)** | Road geometry for traffic | ODbL 1.0 | "© OpenStreetMap contributors" |
| **TomTom Traffic API** (flow vector tiles) | Live congestion coloring for the traffic layer (optional, BYOK) | [TomTom for Developers terms](https://developer.tomtom.com) (proprietary, your own key; free tier currently 200K tile requests/month — see [current pricing](https://docs.tomtom.com/pricing/)) | "Traffic flow data © TomTom" — registered when live mode activates |
| **OpenStreetMap (Overpass API)** | Viewport-bounded mapped installation context for Global Context | ODbL 1.0 | "© OpenStreetMap contributors" (incomplete mapped context) |
| **OpenStreetMap (Nominatim)** | Reverse-geocoded place label in the regional briefing | ODbL 1.0 + Nominatim usage policy | "© OpenStreetMap contributors" |
| **Open-Meteo** | Current regional weather and optional dynamic atmospheric effects | [CC BY 4.0 data licence and adjacent-link attribution requirement](https://open-meteo.com/en/licence) | Linked "Weather data by Open-Meteo.com" beside displayed data |
| **Google News RSS** | Primary locality-matched regional headlines | [Google News Terms of Service](https://www.google.com/intl/en_us/terms_google_news.html) restrict use to personal, noncommercial use; linked articles remain third-party publisher content and retain publisher terms | "Google News RSS" plus each article's linked publisher/domain |
| **GDELT Project DOC 2.0** | Fail-soft fallback for location-matched regional headlines | [GDELT Terms of Use](https://www.gdeltproject.org/about.html#termsofuse): unrestricted academic/commercial/governmental dataset use, with citation and link required; linked articles retain publisher terms | "GDELT Project" plus each article's linked publisher/domain |
| **City of Austin Open Data** | CCTV camera catalog + frames | City of Austin Open Data Terms of Use | "City of Austin, TX — data.austintexas.gov" |
| **Caltrans (cwwp2.dot.ca.gov)** | CCTV camera catalogs + frames, California districts | Public Caltrans traffic camera data | "Caltrans — cwwp2.dot.ca.gov" (courtesy) |
| **TfL Open Data (JamCams)** | CCTV camera catalog + frames, London | [TfL Open Data terms](https://tfl.gov.uk/info-for/open-data-users/) — attribution REQUIRED | "Powered by TfL Open Data. Contains OS data © Crown copyright and database rights" |
| **Re:Earth Terrain** (Mapterhorn) | Terrain (keyless globe stacks — OSM etc. — + `/api/terrain/heights` ellipsoidal-height lookups) | Terrain mesh: CC BY 4.0; geoid: EGM2008 (NGA, public domain) | "Terrain (keyless globe stacks): Re:Earth Terrain / Mapterhorn (CC BY 4.0) / EGM2008 (NGA)" |

### Notes on the live sources

- **Azure Maps and Microsoft Foundry.** Both are called only by the BFF. The
  BFF acquires tokens with `DefaultAzureCredential`; deployed environments use
  managed identity and local development normally uses `az login`. Browser
  code receives map bytes/normalized data or a short-lived realtime client
  secret, never an Azure credential. Deployed ingress uses Entra whole-app
  authentication.
- **OpenSky Network.** Its license is **non-commercial**, and operational use of the REST API in a live product can require a prior written agreement with OpenSky — even for non-profit/government use. If you deploy this commercially, contact OpenSky for your own terms. The flights layer is a toggle and runs anonymously by default.
- **adsb.lol flight fallback.** When OpenSky is unavailable and no last-good OpenSky response exists, the server requests a cached, capped 250 nm adsb.lol point snapshot around the current camera subpoint. This is regional observed context, not worldwide completeness; provenance is exposed in the Flights stats/context row. Military ICAOs remain reconciled through the existing dedicated military registry rather than duplicated.
- **TfL JamCams.** The camera list comes from the keyless `api.tfl.gov.uk` endpoint (an optional `TFL_APP_KEY` raises its rate limit); frames come from TfL's public S3 bucket. The "Powered by TfL Open Data" attribution is required by TfL's terms and is registered in the Data attribution popover.
- **TomTom Traffic.** Optional and BYOK: without `TOMTOM_API_KEY` the traffic layer runs its built-in simulation and no TomTom data (or attribution) appears. With a key, flow vector tiles are fetched through the server-side `/api/tomtom` proxy (120 s cache + a daily tile-budget governor — `TOMTOM_DAILY_TILE_BUDGET`, default 40,000, a configurable application safety ceiling, not a guarantee of staying within TomTom's monthly free allowance; TomTom's [current pricing](https://docs.tomtom.com/pricing/) lists 200K free tile requests per month) and the "Traffic flow data © TomTom" credit is registered in the Data attribution popover the moment live mode activates. TomTom data is served live and cached only transiently (≤120 s TTL under `.gev-cache/`, gitignored) — it is not bundled or redistributed. One 23 KB point-in-time tile snapshot is committed as a decode-test fixture (`src/data/fixtures/`, © TomTom, never served to the app).
- **Re:Earth Terrain.** Keyless (no API key). Every map stack requests its
  quantized mesh; Cesium's ellipsoid is the fallback. The retained
  `/api/terrain/heights` compatibility route also resolves best-effort
  ellipsoidal ground height for entity placement.
- **Global Context installation context.** `/api/military-installations`
  queries only an allow-listed subset of OSM `military=*` and
  `landuse=military` features inside a bounded viewport. It is incomplete
  mapped context, not evidence of capability, activity, or absence.
- **Regional briefing.** `/api/regional-brief` uses rounded cache cells and
  serialized Nominatim calls. Google News RSS is queried first; GDELT is the
  fallback. Commercial deployments must replace or separately license Google
  News RSS. Headlines are location-query matches, not verified incidents.
- **Dynamic weather presentation.** `/api/weather-effects` requests cached
  Open-Meteo observations for the camera location. Missing or expired weather
  renders no synthetic atmospheric effect.
- **AISStream credential handling.** The key is held only by the BFF. In Azure,
  supply it through a Key Vault reference authorized by managed identity;
  locally, use an untracked `.env` or process environment.

---

## Bundled snapshots (committed under `src/data/local_data/`)

Static datasets shipped in the repo for an out-of-the-box experience. **None are MIT** — each keeps its own license (see the carve-out in [LICENSE](LICENSE)). Each folder also has its own provenance README.

| Dataset | Folder | License | Commercial use? | Attribution |
|---------|--------|---------|-----------------|-------------|
| **Datacenters** (~4.3K) | `datacenters/` | **ODbL 1.0** (OpenStreetMap extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" |
| **Dams** (704) | `dams/` | **ODbL 1.0** (OpenInfraMap / OSM extract) | ✅ (attribution + share-alike on data) | "© OpenStreetMap contributors" (+ Open Infrastructure Map) |
| **TeleGeography Submarine Cable Map** (712 cables + 1,917 landing points) | `telegeography_submarine_cables/` | **CC BY-NC-SA 3.0** | ❌ **NonCommercial — remove for commercial use** | "© TeleGeography — submarinecablemap.com" |
| **Natural Earth physical regions** (1,046 land + 292 marine named polygons) | `natural_earth/` | **Public domain** | ✅ (no restrictions) | "Made with Natural Earth" (courtesy credit — not legally required) |
| **DataSF Analysis Neighborhoods** (41 SF neighborhood polygons) | `neighborhoods/` | **PDDL 1.0** (public domain) | ✅ (no restrictions) | "City & County of San Francisco — DataSF" (courtesy — not legally required) |

### ⚠️ TeleGeography is bundled but NonCommercial

The submarine-cable GeoJSON is **CC BY-NC-SA 3.0** (Attribution-**NonCommercial**-**ShareAlike**). It is bundled so the cables layer works out of the box, but it is **not covered by this project's MIT license**. CC BY-NC-SA permits redistribution with attribution and share-alike — which is exactly how it ships here — but the **NonCommercial** clause means:

> If you use God's Eye View commercially, delete `src/data/local_data/telegeography_submarine_cables/` (or obtain a commercial license from TeleGeography). It is one self-contained folder; the rest of the app runs without it.

The richer structured dataset is licensed separately/commercially by TeleGeography.

### ODbL share-alike (datacenters, dams)

The OSM-derived datasets are under the **Open Database License**. ODbL's share-alike applies to the **data / derived database, not this MIT-licensed code** — the two coexist (exactly how Open Infrastructure Map ships: MIT software + ODbL data). If you publicly distribute a *modified* version of these databases, you must offer it under ODbL. Keep the "© OpenStreetMap contributors" notice (link: https://www.openstreetmap.org/copyright).

### NASA FIRMS acknowledgement

> We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Earth Observing System Data and Information System (EOSDIS).

FIRMS active fires are **fetched live at runtime** (CC0 / U.S. public domain data): the
`/api/firms` server-side proxy merges the three VIIRS NRT sources (NOAA-20, NOAA-21,
Suomi-NPP) clamped to the trailing 24 h, cached 30 min to respect the shared MAP_KEY
transaction quota. Requires a free `FIRMS_MAP_KEY`
(https://firms.modaps.eosdis.nasa.gov/api/map_key/); the layer is empty without it.
The former bundled 2026-05-25 snapshot was removed 2026-07-16.

### Natural Earth physical regions (`natural_earth/`)

Curated from the **Natural Earth 10m physical vectors** (https://www.naturalearthdata.com/ —
fetched from the canonical `nvkelso/natural-earth-vector` GitHub repo, commit
`ca96624a56bd078437bca8184e78163e5039ad19`, 2026-07-28): `ne_10m_geography_regions_polys`
(mountain ranges, deserts, plateaus, peninsulas, islands, …) → `regions.json` and
`ne_10m_geography_marine_polys` (seas, gulfs, straits, bays) → `marine.json`. They back the
voice-annotation resolver's named-natural-region lookup (`src/data/naturalEarthRegions.js`),
so "outline the Alps" draws the real range polygon offline.

Curation (provenance in each file's `meta` header): named features only, outer rings only,
Douglas-Peucker simplified at ~0.01° with coordinates rounded to 3 decimals, sub-20 km²
MultiPolygon crumbs and zero-area sliver artifacts dropped (7.3 MB source → 2.5 MB pack).

Natural Earth is **public domain** (no permission needed, no attribution legally required —
https://www.naturalearthdata.com/about/terms-of-use/). We credit anyway: "Made with Natural
Earth". Registration in the in-app `dataCredits.js` attribution list ships with the resolver
wiring (see below).

### DataSF Analysis Neighborhoods (`neighborhoods/`)

`neighborhoods/san-francisco.json` bundles the City & County of San Francisco's official
**"Analysis Neighborhoods"** dataset (41 neighborhood polygons; DataSF dataset `j2bu-swwd`,
catalog map view
[`p5b7-5n3h`](https://data.sfgov.org/Geographic-Locations-and-Boundaries/Analysis-Neighborhoods-Map/p5b7-5n3h)).
It backs the voice-annotation resolver's offline neighborhood-boundary lookup
(`src/data/neighborhoodPolygons.js`), so "outline Chinatown" draws the city's real
boundary polygon with no network dependency.

The dataset is licensed **PDDL 1.0** (Open Data Commons Public Domain Dedication and
License — public domain; the DataSF metadata declares `licenseId: "PDDL"`). No attribution
is legally required; we note the source here and in the folder's `SOURCE.md`, which records
the retrieval date (2026-07-30), exact download URL, license evidence, and the
deterministic transform (`scripts/build-sf-neighborhoods.mjs`: `nhood` → `name`, ~2 m
Douglas-Peucker simplification, 6-decimal rounding).

---

## In-app attribution
