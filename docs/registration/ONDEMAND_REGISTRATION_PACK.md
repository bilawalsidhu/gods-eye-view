# OnDemand registration pack — the six OnDemand Spatial REST plugins

_Prepared 2026-09-18 (UTC) against the live preview `https://sb-1dqoce558p0v.vercel.run`. Status: **not yet registered** — see `docs/PLUGIN_RESOLUTION.md` for why and for the "ids pending" table._

## 0. Why this is a paste-ready pack and not a script

Creating an agent / REST plugin on OnDemand is **dashboard-only**. `docs/ONDEMAND_API_CURRENT.md` §18.1 ("Agent / REST-plugin CREATE — CONFIRMED dashboard-only (no public REST create)") and §18.2 (b) re-checked the live public documentation on 2026-09-18: `docs/rest-based-plugins.md` starts with "Navigate to My Agents (`https://app.on-demand.io/rag-agents/my-agents`) and click on Create Agents", `docs/plugin-api.md` documents only `GET /plugin/v1/list`, and the keyed categories index (40 operations) has no plugin/agent create, update or publish operation. The platform-internal `plugin_v1_plugin_create` MCP tool is not a public API surface and was not used. Registration therefore has to be done by a person signed in to the OnDemand dashboard; everything that person needs to type or upload is below.

Only the OnDemand **API key** exists in this environment (as the `ONDEMAND_API_KEY` env var on the preview); it authenticates REST calls, not the dashboard. No dashboard login was available, so nothing was created (see `docs/PLUGIN_RESOLUTION.md`).

## 1. What every plugin has in common

| Field | Value to enter |
| --- | --- |
| Agent type | **REST API** (My Agents → Create Agent → REST API, "Import OpenAPI schema") |
| Category | **Research** (`info.x-ondemand-spatial.category` in every spec) |
| Authentication | **None** — the tools are same-origin proxies on the OnDemand Spatial deployment; every upstream credential (OpenSky, AISStream, TomTom, CelesTrak, USGS) stays **server-side** in Vercel env vars and is never asked from OnDemand or the caller. The specs declare no `securitySchemes`. |
| Server URL (`servers[0].url`) | **`https://sb-1dqoce558p0v.vercel.run`** in the committed specs — the **ephemeral preview**. Before or right after registering, regenerate the six specs against the permanent deployment: `node scripts/generate-tool-openapi.mjs --server https://<permanent-host>` and re-upload / edit the server URL in each agent. A Vercel Sandbox URL expires; a registered agent pointing at it will start failing with connection errors. |
| Request style | `GET` only, query-string parameters, JSON answers in the `{ ok, tool, params, data, provider, provenance, generatedAtUtc }` envelope; `400 unknown_param` / `invalid_param` / `missing_param` for bad input, `503 not_configured` / `upstream_unavailable` when a provider cannot answer (verified live — `docs/plugins/<id>/TEST_PROOF.md` "Preview evidence"). |
| Visibility | Private (status `private`) until the owner decides otherwise. |
| OpenAPI version | 3.0.3, one file per plugin (paths below). Each file is self-contained; upload as-is. |

Machine-readable index of all ten tools: `GET https://sb-1dqoce558p0v.vercel.run/api/tools` (lists the 10 tool names, params and the plugin each belongs to).

## 2. Click path (dashboard, per plugin)

1. Sign in at `https://app.on-demand.io` → **My Agents** (`https://app.on-demand.io/rag-agents/my-agents`).
2. **Create Agent** → choose **REST API**.
3. **Name**, **Description**, **Category = Research**, logo (any; `public/brand/` has the OnDemand Spatial marks), **Conversation starters** — paste from §3.
4. **Authentication: None**.
5. **OpenAPI schema → Upload file** (or paste the JSON) — the `docs/plugins/<id>/openapi.json` listed in §3. Confirm the operations the form detects match the "Operations" column.
6. **Test** one operation from the form with the sample query in §3 (the same requests were run live on 2026-09-18 — expected status and provider state are given so a degraded answer is not mistaken for a broken plugin).
7. **Save** (private). Copy the **plugin id** (the `pluginIds` value used on chat sessions / queries) into §4 and into the Vercel env `ONDEMAND_DEFAULT_PLUGIN_IDS` (comma-separated) so `/api/ondemand/health` and the selftest step 4 ("built-in tool/plugin invocation", currently SKIP: "no plugin id in env and the account's Agents API listing is empty") start exercising it.
8. Repeat for the next plugin. Six agents in total.

## 3. Paste-ready fields per plugin

### 3.1 `satellites` — spec `docs/plugins/satellites/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Satellites (CelesTrak)` |
| Type / Category / Auth | REST API / Research / None (same-origin; CelesTrak needs no key) |
| Description | Live satellite situational awareness from CelesTrak general-perturbation element sets, propagated server-side with SGP4: which satellites are over a place right now (with altitude, speed, ground distance and observer look angles) and when a given satellite — the ISS, Tiangong, a GPS/GLONASS/Galileo vehicle, a geostationary bird or a Starlink — next rises, culminates and sets for an observer. Backed by the same cached, fallback-protected CelesTrak proxy the OnDemand Spatial satellites layer uses; answers carry a provider status (live / stale / degraded / unavailable) and element-set provenance. |
| Conversation starters | • Which satellites are over Austin, Texas right now within 1000 km? • When does the ISS next pass over London above 10° elevation? • List the GPS satellites currently above the horizon for 48.85, 2.35. • Show the next Tiangong (CSS) passes over Tokyo in the coming 48 hours. • Are any geostationary satellites within 2000 km of the sub-satellite point over Nairobi? |
| Operations | `GET /api/tools/list_satellites_in_scene` (`list_satellites_in_scene`), `GET /api/tools/satellite_passes` (`satellite_passes`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:46Z) | `/api/tools/list_satellites_in_scene?lat=30.2672&lon=-97.7431&radiusKm=1500&limit=5` → **200**, 0.67 s, `provider.status live / CelesTrak`, `total 832`; `/api/tools/satellite_passes?lat=30.2672&lon=-97.7431&name=iss&hours=24` → **200**, 4 passes |

### 3.2 `flights` — spec `docs/plugins/flights/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Live Flights (OpenSky → adsb.lol → adsb.fi)` |
| Type / Category / Auth | REST API / Research / None (OpenSky credentials, when configured, stay in Vercel env) |
| Description | Live air traffic for any place on Earth: the aircraft currently around a point or inside a bounding box (callsign, country, position, altitude, speed, heading, vertical rate, squawk, last contact) from the OpenSky Network with automatic fall-back to the adsb.lol and adsb.fi community ADS-B feeds, plus a single-aircraft lookup by ICAO 24-bit address with registration, type and military flag. Backed by the same cached, breaker-protected proxy the OnDemand Spatial flights layer uses; every answer names the feed that answered and its freshness (live / stale / degraded). |
| Conversation starters | • What aircraft are flying within 100 nautical miles of Austin, Texas right now? • List the flights inside the box 51.2,-0.8 to 51.8,0.4 (London) and which feed the data came from. • Look up the aircraft with ICAO address a835af — what is it and where is it? • How many airborne aircraft are around Dubai (25.25, 55.36) and which is closest? • Is ICAO hex ae1460 a military aircraft, and is it currently being tracked? |
| Operations | `GET /api/tools/flights_in_bbox` (`flights_in_bbox`), `GET /api/tools/flight_by_icao24` (`flight_by_icao24`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:47Z) | `/api/tools/flights_in_bbox?lat=30.2672&lon=-97.7431&radiusNm=100&limit=5` → **200**, 6.62 s, `provider.status degraded / adsb.lol` ("OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed" — expected without OpenSky egress), `total 152`; `/api/tools/flight_by_icao24?icao24=a78b23` → **200**, 0.16 s, live / adsb.lol |

### 3.3 `military` — spec `docs/plugins/military/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Military Flights (adsb.lol /v2/mil)` |
| Type / Category / Auth | REST API / Research / None |
| Description | Military aircraft currently broadcasting ADS-B/MLAT anywhere in the world — tankers, transports, patrol aircraft, trainers, helicopters and government fleets flagged military in the readsb database — around a point or inside a bounding box, with callsign, registration, type, position, altitude, speed, track, squawk and freshness. Sourced from adsb.lol /v2/mil with adsb.fi as fall-back through the same cached, cooldown-protected proxy the OnDemand Spatial military layer uses; every answer names the feed that answered and its status (live / stale / degraded). |
| Conversation starters | • Which military aircraft are flying within 600 nautical miles of Austin, Texas right now? • Are there any military tankers or transports over the Baltic Sea (box 54,10 to 60,30)? • List the military aircraft closest to Ramstein (49.44, 7.60) and what types they are. • How many military flights are currently tracked around the eastern Mediterranean (34, 33)? |
| Operations | `GET /api/tools/military_flights_in_bbox` (`military_flights_in_bbox`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:54Z) | `/api/tools/military_flights_in_bbox?lat=30.2672&lon=-97.7431&radiusNm=600&limit=5` → **200**, 0.20 s, `provider.status live / adsb.lol`, `total 114` |

### 3.4 `vessels` — spec `docs/plugins/vessels/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Live Vessels (AIS)` |
| Type / Category / Auth | REST API / Research / None (`AISSTREAM_API_KEY` stays in Vercel env; without it the tool answers a clearly labelled demo replay) |
| Description | Live ship positions (AIS) around a point or inside a bounding box, served by the OnDemand Spatial serverless AIS collector. The collector is BOUNDED: per scene box it opens one AISStream WebSocket, ingests for at most 8 s (AISSTREAM_COLLECT_MS; stops earlier after 2.5 s of silence or 2 000 rows), closes, and answers from a per-box snapshot cache (25 s TTL, shared through KV when configured) — so a call returns within a few seconds and never holds a socket open between requests. When AISSTREAM_API_KEY is missing the route serves a clearly labelled DEMO REPLAY (twelve synthetic vessels, MMSI 9990000NN, names "DEMO REPLAY N", Texas Gulf coast only) with status "degraded" and source "Demo replay" — never presented as live. Fallbacks (demo replay, AISHub delayed positions, last-good snapshots) stay in place because of the AISStream incident of 13 March 2026, when subscriptions were accepted but zero messages arrived (github.com/aisstream/aisstream/issues/15): a silent feed is reported as "degraded"/"empty" with a statusMessage instead of an empty "live" answer. Every response carries `data.status`, `data.collectorMode` and a `provider` block (live \| stale \| degraded \| unavailable) — read them before trusting the vessel list. |
| Conversation starters | • Which vessels are currently in Galveston Bay (lat 29.45, lon -94.85)? • List the ships within 100 km of Rotterdam heading to Antwerp • Where is the vessel with MMSI 999000001 right now and what is its recent track? • How many tankers are anchored off Fujairah (lat 25.15, lon 56.45) in a 60 km radius? |
| Operations | `GET /api/tools/vessels_in_bbox` (`vessels_in_bbox`), `GET /api/tools/vessel_by_mmsi` (`vessel_by_mmsi`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:54Z) | `/api/tools/vessels_in_bbox?lat=29.45&lon=-94.85&radiusKm=60&limit=5` → **200**, 0.07 s, `provider.status degraded / Demo replay` ("AISSTREAM_API_KEY not set - demo replay, not live AIS"), `total 11`; `/api/tools/vessel_by_mmsi?mmsi=999000001` → **200**, 0.05 s, one demo vessel with track |

### 3.5 `traffic` — spec `docs/plugins/traffic/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Street Traffic (TomTom Flow Segment Data)` |
| Type / Category / Auth | REST API / Research / None (`TOMTOM_API_KEY` stays in Vercel env) |
| Description | Live street-traffic speed at a point from TomTom Flow Segment Data — current speed vs free-flow speed, travel times, confidence and road closure for the road segment nearest to lat/lon — through the OnDemand Spatial TomTom proxy (60 s per-point cache, daily request budget governor, last-good served as "stale" when TomTom rate-limits or times out). Requires the deployment to have TOMTOM_API_KEY; without it the tool answers 503 `not_configured` with the exact fix ("set it in Vercel to enable live traffic") instead of guessing. The companion `road_network_status` tool reports the OSM road-network configuration (ROAD_NETWORK_SOURCE overpass\|off, the Overpass mirror list in force, and the known blocker: public Overpass mirrors refuse or time out for cloud egress — set OVERPASS_UPSTREAMS to a private mirror). |
| Conversation starters | • How congested is traffic right now near the Texas State Capitol in Austin (lat 30.2747, lon -97.7404)? • Compare the current speed with the free-flow speed on the road nearest to lat 25.2048, lon 55.2708 in mph • Is live street traffic configured on this deployment, and which road-network source is in use? • Is there a road closure near lat 40.7580, lon -73.9855? |
| Operations | `GET /api/tools/traffic_flow_at_point` (`traffic_flow_at_point`), `GET /api/tools/road_network_status` (`road_network_status`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:55Z) | `/api/tools/traffic_flow_at_point?lat=30.2672&lon=-97.7431` → **503** `not_configured` ("TOMTOM_API_KEY not set — set it in Vercel to enable live traffic") — **expected on this preview**; becomes 200 once the key is set. `/api/tools/road_network_status` → **200**, `provider.status degraded / road-network:overpass` with the Overpass blocker text |

### 3.6 `earthquakes` — spec `docs/plugins/earthquakes/openapi.json`

| Field | Value |
| --- | --- |
| Name | `OnDemand Spatial Earthquake Search (USGS)` |
| Type / Category / Auth | REST API / Research / None (USGS is public domain, no key) |
| Description | Search recent or historical earthquakes from the USGS FDSN Event Web Service by time window (UTC), magnitude range and geographic area — a circle (latitude + longitude + maxradiuskm) or a bounding box (minlatitude/maxlatitude/minlongitude/maxlongitude), never both. Returns observed events (id, UTC origin time, magnitude and type, depth km, lat/lon, place, tsunami flag, PAGER alert, USGS URL) plus a provenance block with the exact upstream request URL and the public-domain licence note; `mode=count` returns only the number of matching events. This is the OnDemand tool envelope over the Gate 3 route /api/sources/earthquakes (same adapter, same validation, same structured failures: invalid_query 400, usgs_rejected 400/404, usgs_unavailable 502/5xx, usgs_timeout 504). No authentication; USGS data are in the public domain. Results are capped at 200 events per call. |
| Conversation starters | • List earthquakes above magnitude 4.5 in the last 24 hours • Any earthquakes within 500 km of Abu Dhabi (lat 24.45, lon 54.65) this month? • Count M6+ events worldwide since 2026-01-01 • Show the strongest earthquakes in the Gulf of Mexico box 18..31 N, -98..-80 E since 2025-01-01, largest first |
| Operations | `GET /api/tools/earthquake_search` (`earthquake_search`) |
| Server URL | `https://sb-1dqoce558p0v.vercel.run` → replace with the permanent host |
| Test query (live 2026-09-18T16:56:55Z) | `/api/tools/earthquake_search?latitude=27&longitude=-92&maxradiuskm=1500&limit=5` → **200**, 0.31 s, `provider.status live / USGS FDSN Event Web Service`, 5 events |

## 4. Spec files to upload (six)

```
docs/plugins/satellites/openapi.json    2 operations
docs/plugins/flights/openapi.json       2 operations
docs/plugins/military/openapi.json      1 operation
docs/plugins/vessels/openapi.json       2 operations
docs/plugins/traffic/openapi.json       2 operations
docs/plugins/earthquakes/openapi.json   1 operation
```

Regenerate all six against the permanent host before upload: `node scripts/generate-tool-openapi.mjs --server https://<permanent-host>` (drift check: `node scripts/generate-tool-openapi.mjs --check`).

## 5. Record ids here

Fill in after each "Save" in the dashboard; then set `ONDEMAND_DEFAULT_PLUGIN_IDS=<comma-separated ids>` on Vercel and re-run `GET /api/ondemand/selftest` (step 4 should turn from SKIP to PASS).

| Plugin | Agent name (dashboard) | OnDemand plugin id (`pluginIds` value) | Registered by / UTC | Server URL registered | Notes |
| --- | --- | --- | --- | --- | --- |
| satellites | OnDemand Spatial Satellites (CelesTrak) | _pending_ | _pending_ | _pending_ | |
| flights | OnDemand Spatial Live Flights (OpenSky → adsb.lol → adsb.fi) | _pending_ | _pending_ | _pending_ | |
| military | OnDemand Spatial Military Flights (adsb.lol /v2/mil) | _pending_ | _pending_ | _pending_ | |
| vessels | OnDemand Spatial Live Vessels (AIS) | _pending_ | _pending_ | _pending_ | |
| traffic | OnDemand Spatial Street Traffic (TomTom Flow Segment Data) | _pending_ | _pending_ | _pending_ | preview answers 503 `not_configured` until `TOMTOM_API_KEY` is set |
| earthquakes | OnDemand Spatial Earthquake Search (USGS) | _pending_ | _pending_ | _pending_ | |

After registration, verify from the API side with `GET https://api.on-demand.io/plugin/v1/list?pluginIds=<id>` (header `apikey`) — on 2026-09-18T16:57:28Z the account listing was still empty (`total=0`, recorded by selftest step 4).
