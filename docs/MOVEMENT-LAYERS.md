# MOVEMENT data layers on the serverless deployment — providers, statuses, verification (2026-09-18)

The DATA LAYERS › MOVEMENT rows (Satellites, Live Flights, Military Flights,
Live Vessels, Street Traffic) all read **UNAVAILABLE** on the serverless
preview on 2026-09-18 ("CelesTrak unreachable", "OpenSky HTTP 502 · retry 20s",
"adsb.lol HTTP 502", "AIS live relay is unavailable in the serverless
deployment", Street Traffic OFF). This document records the root causes, the
repair, the status contract every MOVEMENT proxy now honours, the environment
variables, and the live verification. Function count is unchanged: every
route below is served by the existing catch-all `api/[...route].js` (9 Vercel
functions in total, well under the 12-function Hobby cap).

## 1. Root causes (measured, not guessed)

Probes were run from **Vercel's own egress** (a node24 Vercel Sandbox, region
IAD) on 2026-09-18 13:2xZ:

| Upstream | From Vercel egress | Consequence in the old code |
|---|---|---|
| `celestrak.org/NORAD/elements/gp.php` | **200** (TLE `active` 2.69 MB in 3.8 s) | The proxy had no bundled fallback and answered **502** on a cold instance whenever CelesTrak throttled the shared egress IP (it 403s clients that re-fetch a group more than ~every 2 h; a cold instance re-fetched 7 groups in parallel) → "CelesTrak unreachable" |
| `celestrak.com` | TLS certificate **expired** | Only a best-effort secondary |
| `opensky-network.org/api/states/all` (bbox and worldwide) | **`UND_ERR_CONNECT_TIMEOUT` after ~10.5 s** — OpenSky black-holes cloud egress IPs (the same call is 200 from a residential network) | The proxy fetched the WHOLE WORLD with no timeout; the connect timeout surfaced as **502 `proxy_error`** |
| `api.adsb.lol/v2/mil`, `/v2/point`, `/v2/lat/…/dist/…` | **200** | The proxy had no timeout and relayed any fetch failure as **502** with nothing cached |
| `opendata.adsb.fi/api/v2/mil`, `/api/v2/lat/…/dist/…` | **200** (readsb shape; ≤ 1 request/s) | Not used |
| `api.airplanes.live/v2/*` | **403** "Please contact us at contact@airplanes.live" | Not usable without prior approval |
| `wss://stream.aisstream.io/v0/stream` | WebSocket only | `/api/ais-live` answered **501** in serverless mode; the client short-circuited |
| `api.tomtom.com/traffic/services/4/flowSegmentData` | **401** without a key | No `TOMTOM_API_KEY` anywhere → layer disabled/OFF |
| `overpass-api.de` (+ `lz4.`, `z.`) | **406 Not Acceptable** from cloud AND residential egress; `overpass.kumi.systems` / `overpass.private.coffee` time out; `overpass.osm.ch` answers but is a Switzerland-only extract | The Street Traffic road network (OSM via `/api/overpass`) cannot load from this deployment right now — an external block, see §5 |

## 2. Shared provider helper — `server/providers/common/upstream.js`

Every MOVEMENT proxy is built on one helper:

- `fetchUpstream(url, { timeoutMs = 10000, retries = 2, headers, accept, maxBytes, label })` — per-attempt timeout, at most `retries` **jittered** retries (250 ms · 2ⁿ ± 50 %, cap 1.5 s) on network errors, timeouts, 429 and 5xx (never on other 4xx), a descriptive `User-Agent` (`ondemand-spatial/0.1 (+https://github.com/bilawalsidhu/gods-eye-view)`), gzip accepted, a hard body cap. It never throws for an upstream problem; `ok:false` carries `error:{code,message}` and `retryAfterMs`.
- `providerStatus({ status, source, fetchedAt, error, count })` — the structured status: `status ∈ live | stale | degraded | unavailable`, `fetchedAt` = when the DATA was obtained (so `ageSec` is honest for cached answers).
- `statusHeaders(status, { edgeMaxAgeSec, staleWhileRevalidateSec })` — `X-Provider-Status / -Source / -Fetched-At / -Age-Sec / -Error / -Count` plus the `Cache-Control` the Vercel edge honours (`public, max-age=0, s-maxage=…, stale-while-revalidate=…`; `no-store` for per-view snapshots).
- `createLastGoodStore()` — bounded per-key last-good memory for the life of the warm instance.

**Response policy (all five proxies):** HTTP **200** whenever any data exists —
fresh primary → `live`; last-good / bundled snapshot → `stale`; an alternative
source or a demo dataset → `degraded` with `error` naming why; only when there
is nothing at all → HTTP **503** with `{ error, provider }`. A raw upstream
5xx/502 is never relayed. JSON bodies additionally carry `provider`.

Client side: `src/sources/live/contract.js#providerStatusFromResponse()` reads
the headers (or `body.provider`), every live source copies it into its
snapshot (`providerStatus`, `providerError`, `providerFetchedAtMs`,
`providerSource`), the layers expose it from `getStats()`, and
`src/data/feedState.js#layerFeedState` maps an explicit `stale`/`degraded`
ahead of the older source-name heuristics. `src/ui/layerPanel.js` renders
`LIVE · <source> · <age>`, `STALE · …`, `DEGRADED · <source> · <reason>`; a
provider that declared itself degraded says so while it is still loading; an
honestly empty scene renders as guidance (`AISStream · No vessels in scene`),
not as a fault.

## 3. Per-layer resolution order

### Satellites — `GET /api/celestrak/<group>` (`server/providers/space/celestrak.js`)
cache < 6 h → `celestrak.org` (10 s, 2 jittered retries, TLE validated) →
`celestrak.com` (best effort) → stale memory/disk cache (any age) → **bundled
snapshot** `data/celestrak-active-snapshot.json` (stations, visual, gps-ops,
glo-ops, galileo, geo, starlink; refreshed by `npm run prebuild` →
`scripts/refresh-celestrak-snapshot.mjs --skip-if-fresh 6`, never fails a
build; shipped with the function via `vercel.json` `includeFiles: data/**`) →
503. Headers: `X-TLE-Cache` HIT/MISS/STALE-ERROR/SNAPSHOT/NONE, `X-TLE-Source`,
edge `s-maxage=3600, stale-while-revalidate=86400` (TLEs change slowly).
Positions are propagated client-side with satellite.js (SGP4); DENSE mode is
the `starlink` group.

### Live Flights — `GET /api/opensky?lat&lon` (`server/providers/aircraft/opensky.js`)
Scene box `lamin/lomin/lamax/lomax` = anchor ± `OPENSKY_BBOX_DEGREES` (1.5°;
1 anonymous credit per call instead of 4 for the old worldwide request);
OAuth2 client credentials when `OPENSKY_CLIENT_ID/SECRET` are set (token
cached ~30 min, single in-flight refresh), anonymous otherwise; per-attempt
timeout `OPENSKY_TIMEOUT_MS` (6 s), `OPENSKY_RETRIES` (0); a timeout/network
error opens a **breaker** for `OPENSKY_BREAKER_MS` (10 min) so no later request
waits on OpenSky; 429 honours `X-Rate-Limit-Retry-After-Seconds`. Fallbacks:
last-good OpenSky for the scene (`stale`) → **adsb.lol**
`/v2/lat/{lat}/lon/{lon}/dist/{OPENSKY_FALLBACK_RADIUS_NM}` → **adsb.fi**
`/api/v2/lat/…/dist/…` (≤ 1 req/s) → airplanes.live (only with
`AIRPLANES_LIVE_ENABLED=true`) → any last-good → 503. Fallback answers are
`degraded` with `provider.error` such as
`OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed`.

### Military Flights — `GET /api/adsblol/mil[?lat&lon&radiusNm[&point=1]]` (`server/providers/aircraft/adsb-lol.js`)
adsb.lol `/v2/mil` (10 s, 1 retry, 12 s response cache shared by every
client) → adsb.fi `/api/v2/mil` → airplanes.live (opt-in) → last-good ≤ 30 min
(`stale`) → 503. With `lat/lon/radiusNm` the list is filtered server-side to
the scene radius (`X-Flight-Coverage: 600nm around 30.27,-97.74`); `point=1`
uses `/v2/point/{lat}/{lon}/{radius}` filtered to `dbFlags & 1`. The client
sends `radiusNm=600` only below a 2,000 km camera height, so the globe view
still shows the worldwide list.

### Live Vessels — `GET /api/ais-live?bbox=lamin,lomin,lamax,lomax&maxRows=N` (`server/providers/vessels/ais-serverless.js`, serverless mode only)
Snapshot < `AISSTREAM_SNAPSHOT_TTL_MS` (25 s; memory + Vercel KV / Upstash REST
when configured) → in-flight collection for the same 0.25° box (coalesced) →
**bounded collector**: one WebSocket to AISStream subscribed to the scene box
(`BoundingBoxes: [[[latMin, lonMin], [latMax, lonMax]]]`,
`FilterMessageTypes: PositionReport, StandardClassBPositionReport,
ExtendedClassBPositionReport, ShipStaticData`) for ≤ `AISSTREAM_COLLECT_MS`
(8 s), closed after `AISSTREAM_COLLECT_QUIET_MS` (2.5 s) of silence once
something arrived → rows ingested through the existing `ais-store.js`,
filtered to the box → `live`; zero messages (the known AISStream silence
incident) → `degraded` + last-good, or `empty`; `Api Key Is Not Valid` → 503
`auth-failed`. Without `AISSTREAM_API_KEY`: AISHub (`AISHUB_USERNAME`,
`degraded`) or the clearly labelled **demo replay** (12 synthetic vessels on
the Houston Ship Channel / Galveston Bay / Gulf approaches, MMSI 999000001…,
type "Demo replay (not live AIS)", `degraded`, error
`AISSTREAM_API_KEY not set - demo replay, not live AIS`); an inland scene →
`empty` / "No vessels in scene". Edge `s-maxage=30, stale-while-revalidate=60`.
The dev-server relay (`ais-live.js`, persistent socket) is unchanged and still
never mounted in serverless mode.

### Street Traffic — `/api/tomtom/*` (`server/providers/traffic.js`)
`/api/tomtom/status[?point=lat,lon]` now carries `provider` (`live` with a key,
`degraded` without: `TOMTOM_API_KEY not set - flow colours are simulated on live
OSM roads`) and, with a key, a cached Flow Segment probe
(`currentSpeed/freeFlowSpeed/confidence`); new
`/api/tomtom/flow-segment?point=lat,lon[&zoom=10][&unit=KMPH]` proxies
`traffic/services/4/flowSegmentData/absolute/{zoom}/json` (10 s, 1 retry, 60 s
cache per 0.01°, `TOMTOM_DAILY_REQUEST_BUDGET`); flow vector tiles get a 10 s
timeout, one jittered retry and a last-good tile cache (`stale`). The layer
turns ON without a key (live OSM roads, simulated flow colours) and the row
reads `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on
live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)`.

## 4. Environment variables

Set in Vercel → Project → Settings → Environment Variables (all optional; the
deployment degrades honestly without them):

| Variable | Purpose | Without it |
|---|---|---|
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky OAuth2 client credentials (4,000 credits/day, 5 s resolution) | anonymous OpenSky (400 credits/day) — and on Vercel OpenSky is unreachable at the network level anyway, so Live Flights come from adsb.lol/adsb.fi (`DEGRADED`) |
| `OPENSKY_AUTH_MODE` (`oauth`), `OPENSKY_BBOX_DEGREES` (1.5), `OPENSKY_TIMEOUT_MS` (6000), `OPENSKY_RETRIES` (0), `OPENSKY_BREAKER_MS` (600000), `OPENSKY_FALLBACK_RADIUS_NM` (250) | tuning | defaults |
| `AIRPLANES_LIVE_ENABLED` (`false`) | opt-in last flight fallback | skipped (403 without approval) |
| `AISSTREAM_API_KEY` | live AIS via the bounded collector | demo replay / AISHub (`DEGRADED`) |
| `AISSTREAM_COLLECT_MS` (8000), `AISSTREAM_COLLECT_QUIET_MS` (2500), `AISSTREAM_SNAPSHOT_TTL_MS` (25000) | collector tuning | defaults |
| `KV_REST_API_URL` + `KV_REST_API_TOKEN` (Vercel KV) or `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN` | share AIS snapshots across function instances | per-instance memory + edge cache only |
| `AISHUB_USERNAME` | keyless delayed AIS (AISHub membership) | demo replay |
| `TOMTOM_API_KEY` | live traffic flow tiles + Flow Segment Data | simulated flow on OSM roads (`DEGRADED`) |
| `TOMTOM_DAILY_TILE_BUDGET` (40000), `TOMTOM_DAILY_REQUEST_BUDGET` (2000) | daily soft caps | defaults |

## 5. Live verification (Vercel Sandbox, node24, `npm ci` → `npm run build` → `npm run dev:serverless`, 2026-09-18)

Preview `https://sb-5z1tt82ep4go.vercel.run` (ephemeral). Every MOVEMENT
endpoint answered 200 with a structured status — no 502 anywhere:

| Request | HTTP | `X-Provider-Status` | Source | Note |
|---|---|---|---|---|
| `/api/celestrak/stations` | 200 | live | CelesTrak (celestrak.org) | 20 sats, edge `s-maxage=3600` |
| `/api/celestrak/starlink` | 200 | live | CelesTrak | 10,700 sats, 1.8 MB TLE in 2.4 s |
| `/api/opensky?lat=30.2672&lon=-97.7431` (cold) | 200 | degraded | adsb.lol | 617 aircraft within 250 nm in 6.6 s; error `OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` |
| same, second call | 200 | degraded | adsb.lol | 0.08 s — breaker open, cached |
| `/api/adsblol/mil?lat=30.2672&lon=-97.7431&radiusNm=600` | 200 | live | adsb.lol | 139 military aircraft, `X-Flight-Coverage: 600nm around …` |
| `/api/adsblol/mil` | 200 | live | adsb.lol | 395 worldwide |
| `/api/ais-live?bbox=29.2,-95.2,29.9,-94.4` | 200 | degraded | Demo replay | 9 demo vessels (no `AISSTREAM_API_KEY`) |
| `/api/ais-live?bbox=28.77,-99.24,31.77,-96.24` (Austin) | 200 | degraded | Demo replay | `status: empty`, "No vessels in scene (demo replay covers the Texas Gulf coast)" |
| `/api/tomtom/status?point=30.2672,-97.7431` | 200 | degraded | TomTom | `TOMTOM_API_KEY not set - flow colours are simulated on live OSM roads` |
| `/api/tomtom/flow-segment?point=30.2672,-97.7431` | 503 | unavailable | TomTom | structured `{ error, provider }`, never 502 |
| `/api/ondemand/health?envNames=1` | 200 | — | — | `ondemand: healthy` (chat/media/workflow/speech), `config.flowVersion.resolvedVia: alias` |
| `/api/ondemand/selftest` (`x-selftest-token`) | 200 | — | — | 10 steps: **9 passed / 0 failed / 1 skipped** (step 4 — the account still has no agents), 39.7 s |

Rendered UI (headless Chromium via `ui-validator`, every MOVEMENT toggle
switched on, DENSE satellites): Austin scene — `LIVE · CelesTrak · <age>`,
`DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed`,
`LIVE · adsb.lol · just now`, `Demo replay · No vessels in scene (demo replay
covers the Texas Gulf coast)`, `DEGRADED · TomTom · TOMTOM_API_KEY not set — …`;
Galveston Bay scene — `DEGRADED · Demo replay · AISSTREAM_API_KEY not set -
demo replay, not live AIS` with the demo vessels rendered. Screenshots:
`.ui-proof/after-austin-1440x900.png`, `.ui-proof/after-galveston-1440x900.png`.

**Known external blocker (not fixable in this repo):** the public Overpass
mirrors refuse or time out for this deployment's egress (§1), so the Street
Traffic layer's OSM road network — and therefore its simulated flow — may
not draw until a mirror accepts the request; the row then reads
`DEGRADED · OpenStreetMap · OpenStreetMap roads unavailable — public Overpass
mirrors refuse this deployment (HTTP 406); simulated traffic needs OSM roads`.
A `TOMTOM_API_KEY` gives live flow tiles but does not replace the road
geometry.

## 6. Tests

`npm test` (unit, `src/**/*.test.mjs`): 4,224 tests / 4,223 pass / 1
pre-existing skip (Node-24 allocation gate); `npm run test:ondemand` 192;
`npm run test:serverless` 47; `npm run check:boundaries` and `npm run
format:check` green. Provider tests mock the network (`t.mock.method(globalThis,
'fetch', …)`, injected `fetchImpl`/`webSocketImpl`); see
`src/tooling/upstreamHelper.test.mjs`, `spaceProviders.test.mjs`,
`celestrakSnapshot.test.mjs`, `liveProviders.test.mjs`,
`aisServerless.test.mjs`, `trafficProvider.test.mjs`,
`src/data/providerFeedState.test.mjs`.

## Live verification 2026-09-18 (preview sb-1dqoce558p0v)

E2E pass against `https://sb-1dqoce558p0v.vercel.run` (Vercel Sandbox, node 24, `dev:serverless`
over `dist` + `api`; runtime env limited to the OnDemand variables — **no OPENSKY / AISSTREAM /
TOMTOM keys**). Browser side: headless Chromium 1440×900 through the `ui-validator` driver, layers
enabled with `dataManager.setEnabled(id, true, { origin: 'user' })` after the share-link camera
restore completed, DENSE satellites chip on, rows read after 40 s. Screenshots (after-only — there
is no live "before" build of this preview): `.ui-proof/e2e-austin-1440x900.png` (17:31:24Z),
`.ui-proof/e2e-galveston-1440x900.png` (17:29:33Z).

### DATA LAYERS badge texts (`name | count | meta`)

| Layer | Austin `#lat=30.2672&lon=-97.7431&alt=1200&pitch=-35` (17:31:20Z) | Galveston Bay `#lat=29.45&lon=-94.85&alt=45000&pitch=-55` (17:29:29Z) |
| --- | --- | --- |
| Satellites | `Satellites \| 11.5K \| LIVE · CelesTrak · 34m ago` | `Satellites \| 11.5K \| LIVE · CelesTrak · 32m ago` |
| Live Flights | `Live Flights \| 648 \| DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` | `Live Flights \| 532 \| DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` |
| Military Flights | `Military Flights \| 105 \| LIVE · adsb.lol · 7s ago` | `Military Flights \| 130 \| LIVE · adsb.lol · 8s ago` |
| Live Vessels | `Live Vessels \| — \| Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` | `Live Vessels \| 12 \| DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not live AIS` |
| Street Traffic | `Street Traffic \| — \| DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) · SIMULATE…` | `Street Traffic \| — \| DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)` |

One-second samples over 40 s per scene: Satellites `LIVE`×40, Military `LIVE`×40, Flights
`ENABLING`≤6 s then `DEGRADED`, Vessels `ENABLING` 1 s then `DEGRADED` (Galveston) / `Demo replay`
guidance (Austin), Traffic `DEGRADED`×40 in the final runs. **0 `HTTP 502`** in every sample and
every scene. **`UNAVAILABLE`: 0 in the final runs of both scenes, but not always** — in five earlier
Austin runs the Street Traffic row read `UNAVAILABLE · OpenStreetMap · OpenStreetMap roads
unavailable — public Overpass mirrors refuse this deployment (HTTP 406); simulated traffic needs
O…` for ~4 s (samples at 17:09:38Z, 17:14:06Z, 17:21:46Z, 17:23:22Z, 17:24:46Z) before returning to
`DEGRADED · TomTom · …`: the simulated flow needs OSM roads from `/api/overpass`, which the public
mirrors answer with HTTP 406 from Vercel egress (§1 root cause; same blocker `road_network_status`
reports), so the traffic row flaps DEGRADED ↔ UNAVAILABLE around each failed Overpass attempt.
Console also logged one `GET /api/terrain/heights … 502` during the Austin boots (terrain sampling
proxy, not a DATA LAYERS row) and the benign `GET /api/setup/status` 404 probe.

Harness note: enabling a layer **before** the camera restore lands (the rows exist while the camera
is still at the default globe view, lat 35.2 / lon −82.5 / h 24 900 km) makes the vessels layer poll
that scene box — `No vessels in scene` even at Galveston — so the driver waits for the rewritten
`#v=2…` hash / camera height < 1 000 km first.

### Tool matrix (`/api/tools/*`, `curl` from outside Vercel, 16:56:46–16:56:55Z)

| Tool | Request | HTTP | Time | `provider.status` / source | Counts | `&bogus=1` |
| --- | --- | --- | --- | --- | --- | --- |
| `list_satellites_in_scene` | `lat=30.2672&lon=-97.7431&radiusKm=1500&limit=5` | 200 | 0.67 s | live / CelesTrak | count 1 · matched 1 · total 832 | 400 `unknown_param` |
| `satellite_passes` | `lat=30.2672&lon=-97.7431&name=iss&hours=24` | 200 | 0.07 s | live / CelesTrak (cache) | 4 passes | 400 `unknown_param` |
| `flights_in_bbox` | `lat=30.2672&lon=-97.7431&radiusNm=100&limit=5` | 200 | 6.62 s | degraded / adsb.lol — OpenSky connect timeout → regional feed | count 5 · total 152 · upstreamStates 603 | 400 `unknown_param` |
| `flight_by_icao24` | `icao24=a78b23` (first hex of the previous answer) | 200 | 0.16 s | live / adsb.lol | 1 aircraft (N5852K, C550) | 400 `unknown_param` |
| `military_flights_in_bbox` | `lat=30.2672&lon=-97.7431&radiusNm=600&limit=5` | 200 | 0.20 s | live / adsb.lol | count 5 · total 114 | 400 `unknown_param` |
| `vessels_in_bbox` | `lat=29.45&lon=-94.85&radiusKm=60&limit=5` | 200 | 0.07 s | degraded / Demo replay (AISSTREAM_API_KEY not set) | count 5 · total 11 | 400 `unknown_param` |
| `vessel_by_mmsi` | `mmsi=999000001` | 200 | 0.05 s | degraded / Demo replay | 1 vessel + track | 400 `unknown_param` |
| `traffic_flow_at_point` | `lat=30.2672&lon=-97.7431` | **503** | 0.05 s | `not_configured` — TOMTOM_API_KEY not set (provider unavailable / TomTom) | — | 400 `unknown_param` |
| `road_network_status` | — | 200 | 0.05 s | degraded / road-network:overpass — public Overpass mirrors refuse or time out for cloud egress | 4 upstreams | 400 `unknown_param` |
| `earthquake_search` | `latitude=27&longitude=-92&maxradiuskm=1500&limit=5` | 200 | 0.31 s | live / USGS FDSN Event Web Service | 5 events | 400 `unknown_param` |

Every route answered with `x-tools-route: ondemand-spatial`; provider status travels in the JSON
`provider` object (no `X-Provider-*` headers on `/api/tools/*`). Full tables, JSON excerpts and
the per-layer badge notes: `docs/plugins/<id>/TEST_PROOF.md` → "Preview evidence (Vercel egress)".
OnDemand side of the same pass: `/api/ondemand/health` healthy, selftest 9 PASS / 0 FAIL / 1 SKIP
(43 624 ms), workflow `6aad6db187fc428d7c18a4bc` first log 436 ms → `success` in 156 649 ms
(`docs/VOICE_MODE.md`, `docs/ENTITY_CHAT.md`).
