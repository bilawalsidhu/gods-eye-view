# server/ HTTP route inventory (Gate-0, drives the serverless conversion)

Generated (UTC): 2026-09-17T06:41:00Z
Audited commit: `0d41b6be5490db1f10a171f238be75db4d4ec3b4 2026-09-16 11:57:56 -0700 Merge pull request #626 from bilawalsidhu/fix/vessel-partial-feed-status`

## Architectural fact: there is no Express server

`server/` is **not** an Express application. It is a set of Vite plugins:

- `vite.config.js` re-exports `server/standalone/vite.config.js`, which calls
  `createBrowserViteConfig({ plugins: [...localProviderPlugins(), apiNotFoundPlugin()] })`
  (`server/standalone/vite.config.js:14-22`, `build/vite.js:5-14`).
- `server/providers/local.js:26-51` (`localProviderPlugins()`) constructs 22 plugin objects in a fixed order.
- Each plugin exposes `configureServer(server)` (most also `configurePreviewServer`) and mounts a
  Connect-style middleware with `server.middlewares.use('/api/<mount>', handler)`; every handler is a
  plain Node `(req, res)` function (e.g. `server/providers/firms.js:171`, `server/providers/traffic.js:148`).
- `server/standalone/api-not-found.js:4-9` mounts a final `/api` layer that answers
  `404 {"error":"Unknown API route"}` so unknown API paths never fall through to Vite's HTML fallback.

**Connect mount semantics a serverless router must reproduce** (the handlers depend on them):
a layer matches when the request path equals the mount or continues with `/` or `.`;
before calling the handler Connect sets `req.originalUrl ||= req.url` and rewrites `req.url` to the
remainder after the mount (query string preserved; an empty remainder becomes `/`), so inside the
`/api/firms` handler `req.url` is `/status` or `/?x=1`; when a handler calls `next()` the original
`req.url` is restored and the next layer is tried.

Methods: **GET unless stated**; handlers that check `req.method` answer 405 for other verbs
(`server/providers/gbfs.js:120`, `overpass.js:69`, `regional/briefing.js:74`, `places/google.js:53,164`,
`military-installations.js:81`, `regional/place.js:215`, `regional/weather-effects.js:47`,
`space/launch-library.js:93`, `openai/hud-summary.js:29`, `openai/realtime.js:26`, `openai/debug-log.js:15`).

## Route table (plugin order = `localProviderPlugins()` order)

| # | Factory (plugin `name`) | `use()` at | Mount | Sub-paths / params | Method | Env vars read | Upstream | Disk | Class |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `openSkyProxy` (`opensky-proxy`) | `aircraft/opensky.js:352` | `/api/opensky` | bbox query params; credit-governed cache; adsb.lol fallback anchor | GET | `OPENSKY_AUTH_MODE`, `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `OPENSKY_USERNAME`, `OPENSKY_PASSWORD` | opensky-network.org, auth.opensky-network.org, api.adsb.lol | in-memory caches / single-flight maps (`opensky.js:68-70`) | request/response (in-memory credit governor state) |
| 2 | `celestrakProxy` (`celestrak-proxy`) | `space/celestrak.js:70` | `/api/celestrak` | `/{group}` (TLE group) | GET | — | celestrak.org | `.gev-cache/celestrak-{group}.json` via `process.cwd()` (`celestrak.js:25`) | request/response |
| 3 | `tomtomProxy` (`tomtom-proxy`) | `traffic.js:148` | `/api/tomtom` | `/status`, `/flow/{z}/{x}/{y}.pbf` | GET | `TOMTOM_API_KEY`, `TOMTOM_DAILY_TILE_BUDGET` | api.tomtom.com | `.gev-cache/tomtom/` tiles + `budget.json` via `process.cwd()` (`traffic.js:38-39`) | request/response (per-process daily budget counter) |
| 4 | `firmsProxy` (`firms-proxy`) | `firms.js:171` | `/api/firms` | `/`, `/status` | GET | `FIRMS_MAP_KEY` | firms.modaps.eosdis.nasa.gov | `.gev-cache/firms.json` via `process.cwd()` (`firms.js:32`) | request/response |
| 5 | `rocketLaunchesProxy` (`rocket-launches-proxy`) | `space/launch-library.js:92` | `/api/launches` | `/` | GET (405 otherwise) | `LL2_API_TOKEN` | Launch Library 2 (thespacedevs) | `.gev-cache/launch-library-2-v2.3.json` via `process.cwd()` (`launch-library.js:25`) | request/response |
| 6 | `terrainHeightsProxy` (`terrain-heights-proxy`) | `terrain.js:159` | `/api/terrain/heights` | `?points=` | GET | — | terrain.reearth.land | `.gev-cache/terrain-heights.json`; `setInterval(...,15s).unref()` disk flush (`terrain.js:95-106`) | request/response + background timer (unref'd) |
| 7 | `adsbdbProxy` (`adsbdb-proxy`) | `aircraft/enrichment.js:111` | `/api/adsbdb` | `/{kind}/{key}` | GET | — | api.adsbdb.com | `.gev-cache/adsbdb.json` via `process.cwd()` (`enrichment.js:12`) | request/response |
| 8 | `overpassProxy` (`overpass-proxy`) | `overpass.js:64` | `/api/overpass` | `/` (query in body) | POST (405 otherwise) | — | overpass-api.de, lz4.overpass-api.de, overpass.kumi.systems, overpass.private.coffee | `.gev-cache/overpass/` via `process.cwd()` (`overpass/constants.js:54`) | request/response |
| 9 | `militaryInstallationsProxy` (`military-installations-proxy`) | `military-installations.js:80` | `/api/military-installations` | bbox params, `?exact=` | GET (405 otherwise) | — | Overpass mirrors | `.gev-cache/military-installations/` via `process.cwd()` (`military-installations/constants.js:36-40`) | request/response |
| 10 | `regionalBriefProxy` (`regional-brief-proxy`) | `regional/briefing.js:73` | `/api/regional-brief` | lat/lon params | GET (405 otherwise) | — | nominatim.openstreetmap.org, api.open-meteo.com, news.google.com | — | request/response |
| 11 | `geocodeProxy` (`geocode-proxy`) | `regional/place.js:214` | `/api/geocode` | `?q=`, `?bounds=` | GET (405 otherwise) | — | nominatim.openstreetmap.org | — | request/response |
| 12 | `weatherEffectsProxy` (`weather-effects-proxy`) | `regional/weather-effects.js:46` | `/api/weather-effects` | lat/lon params | GET (405 otherwise) | — | api.open-meteo.com | — | request/response |
| 13 | `cctvProxy({sourceRoot})` (`cctv-proxy`) | `cctv.js:130` | `/api/cctv` | `/sources`, `/health`, `/stream/{id}`, `/media/{id}`, `/frame/{id}` (`cctv.js:138-339`) | GET | `CCTV_*` (see list below), `TFL_APP_KEY` | city/DOT camera portals (austinmobility, cwwp2.dot.ca.gov, api.tfl.gov.uk, 511on.ca, digitraffic.fi, drivebc.ca, its.txdot.gov, tallinn.ee, transpordiamet.ee, kreis-warendorf.de, nsw.gov.au, calgary.ca) | reads `config/cctv_sources.*.json` + precomputed ground heights under `sourceRoot` (`cctv/catalog.js:102`, `cctv/groundHeights.js:31`, `cctv/sources.js:995,1253`) | request/response; `/stream/` `/media/` proxy media with 15 s / 8 s timeouts (`cctv/constants.js:245-255`) — streaming response (bounded) |
| 14 | `radioBrowserProxy` (`radio-browser-proxy`) | `radio.js:12` | `/api/radio` | `/stations`, `/click/{uuid}` (`radio/catalog.js:346,374`) — catalog JSON only; audio is played by the browser directly from the (HTTPS-normalised) station URL, not proxied | GET | — | de1/de2/nl1.api.radio-browser.info (pinned DNS, `radio/transport.js:94-112`) | — | request/response |
| 15 | `gbfsProxy` (`gbfs-proxy`) | `gbfs.js:118` | `/api/gbfs` | feed/system params | GET (405 otherwise) | — | GBFS feeds (Lyft/BCycle systems) | — | request/response |
| 16 | `transitProxy` (`transit-proxy`) | `transit.js:8` | `/api/transit` | delegated to `src/sources/transitService.js` (`/api/transit/...` feeds, vehicle history) | GET | — | GTFS-RT feeds (`src/data/transitFeeds.js`) | in-memory transit history (`transitService.js:113`), per-request timeouts; `close()` on server close | request/response (in-memory history) |
| 17 | `adsbLolProxy` (`adsblol-proxy`) | `aircraft/adsb-lol.js:70` | `/api/adsblol/mil` | `/` | GET | — | api.adsb.lol | — | request/response |
| 18 | `aisLiveProxy` (`ais-live-proxy`) | `vessels/ais-live.js:74` | `/api/ais-live` | `/` (`?maxRows=`), `/track?mmsi=` (`ais-live.js:86,111`) | GET | `AISSTREAM_API_KEY`, `AISSTREAM_URL`, `AISSTREAM_BOUNDING_BOXES`, `AISSTREAM_MESSAGE_TYPES`, `AISSTREAM_SILENCE_TIMEOUT_MS` | wss://stream.aisstream.io (via `ws`) | — | **persistent upstream WebSocket relay** + watchdog `setInterval` |
| 19a | `trackBackfillProxies` (`track-backfill-proxies`) | `aircraft/tracks.js:64` | `/api/opensky-track` | `?icao24=` | GET | (OpenSky auth as #1) | opensky-network.org | — | request/response |
| 19b | `trackBackfillProxies` | `aircraft/tracks.js:92` | `/api/adsblol/trace` | `?hex=` | GET | — | api.adsb.lol | — | request/response |
| 20a | `openAiRealtimeProxy` (`openai-realtime-proxy`) | `openai.js:18` | `/api/openai/hud-summary` | `/` | POST (405 otherwise) | `OPENAI_API_KEY`, `OPENAI_HUD_SUMMARY_MODEL`, `GEV_RATELIMIT_OPENAI_PER_MIN` | `https://api.openai.com/v1/responses` (`openai/hud-summary.js:54`) | — | request/response |
| 20b | `openAiRealtimeProxy` | `openai.js:20-23` | `/api/realtime/debug-log` | `/` | POST | — | — | **writes** `.gev-logs/realtime-conversations.jsonl` under `sourceRoot` (`openai/debug-log.js:9-13`) | dev-only disk log |
| 20c | `openAiRealtimeProxy` | `openai.js:25-28` | `/api/realtime/token` | `/` (`?model=`…) | GET/POST | `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `OPENAI_REALTIME_MODEL_MINI`, `OPENAI_REALTIME_VOICE`, `OPENAI_REALTIME_REASONING_EFFORT`, `OPENAI_REALTIME_CONTEXT_TOKENS`, `OPENAI_REALTIME_CONTEXT_RETENTION`, `GEV_RATELIMIT_OPENAI_PER_MIN` | `https://api.openai.com/v1/realtime/client_secrets` (`openai/realtime.js:19,123`) | — | **mints an ephemeral client secret** for the browser's WebRTC Realtime session |
| 21a | `googlePlacesContextProxy` (`google-places-context-proxy`) | `places/google.js:52` | `/api/google/nearby-places` | `?lat=&lon=&radiusM=` | GET (405 otherwise) | `GOOGLE_MAPS_SERVER_API_KEY` / `GOOGLE_MAPS_API_KEY` (via `places/google-key.js`), `GEV_RATELIMIT_GOOGLE_PER_MIN` | places.googleapis.com | — | request/response |
| 21b | `googlePlacesContextProxy` | `places/google.js:163` | `/api/google/text-search` | `?q=&radiusM=` | GET (405 otherwise) | same as 21a | places.googleapis.com | — | request/response |
| 21c | `googlePlacesContextProxy` | `places/routes.js:229` | `/api/route` | `?profile=&coords=&steps=` | GET | — | routing.openstreetmap.de (OSRM) | — | request/response |
| 22a | `keySetupEndpoint` (`gev-key-setup`) | `standalone/key-setup.js:248` | `/api/setup/status` | `/` | GET | `GEV_LAUNCHER`, `GEV_KEY_SETUP_EXTERNAL_KEYS`, every registry key name (`src/keySetupCore.mjs`) | — | reads repo-root `.env` / `pinokio/ENVIRONMENT` | **dev-only secret store** (`configureServer` only — never preview/prod; loopback-only) |
| 22b | `keySetupEndpoint` | `standalone/key-setup.js:256` | `/api/setup/keys` | `/` | POST | same | — | **writes** repo-root `.env` then restarts the dev server | **dev-only secret store** |
| — | `apiNotFoundPlugin` (`api-not-found`) | `standalone/api-not-found.js:4` | `/api` | everything unmatched | any | — | — | — | 404 JSON fallback |

Distinct mount paths: **29** (28 provider mounts + the `/api` 404 fallback).

## Focused findings

**(a) AISStream relay — `server/providers/vessels/ais-live.js`.** The plugin comment states the design:
"AISStream does not support browser CORS and requires a private API key, so the Vite server keeps one
backend websocket open and exposes a same-origin JSON snapshot to the Cesium layer" (`ais-live.js:66-71`).
`configureServer` installs the middleware **and** calls `startAisStreamWatchdogTick()` (`ais-live.js:157-163`),
an unref'd `setInterval` (`ais-live.js:334`) that calls `ensureAisStreamConnection()`; the request handler
also calls `ensureAisStreamConnection()` on every hit (`ais-live.js:77`), which opens the `ws` socket
(`aisWebSocketImpl()` lazily requires `ws`, `ais-live.js:193-203`). A Vercel Function is frozen between
invocations and cannot keep an outbound WebSocket or an interval alive, so the vessel snapshot would never
fill → **not serverless-safe; flag off (501) and do not construct/mount the plugin at all in serverless mode.**

**(b) OpenAI routes — `server/providers/openai/*`.** `/api/realtime/token` POSTs to
`https://api.openai.com/v1/realtime/client_secrets` (`openai/realtime.js:19,123`) and returns an ephemeral
client secret the browser uses for a WebRTC Realtime session — a credential-minting path that must be
disabled under the serverless flag (never expose it). `/api/openai/hud-summary` is a plain request/response
call to `https://api.openai.com/v1/responses` (`openai/hud-summary.js:54`, POST only) and can run in a function
unchanged (keyless → it reports the missing key). `/api/realtime/debug-log` appends JSONL to
`.gev-logs/realtime-conversations.jsonl` under the repo root (`openai/debug-log.js:9-13`) — a dev diagnostic
that has no durable place in a read-only function filesystem.

**(c) Key setup — `server/standalone/key-setup.js`.** Documented as "In-app key setup ('POWER UP' panel) —
dev-server only … Loopback-only on purpose … Prod builds never register this middleware (apply: 'serve'), so the
panel's status fetch fails and the client removes the whole surface" (`key-setup.js:52-70`). It writes the
repo-root `.env` (or `pinokio/ENVIRONMENT`) and restarts Vite. In serverless it must be omitted; the client
already tolerates the resulting 404 by hiding the panel.

**(d) Radio — `server/providers/radio/*`.** `/api/radio/stations` and `/api/radio/click/{uuid}` proxy the
radio-browser.info catalogue JSON with DNS pinning (`radio/transport.js:94-112`); audio itself is fetched by
the browser from the normalised station URL, so no long-lived audio proxying happens in `server/`.

**(e) CCTV — `server/providers/cctv/*`.** `/api/cctv/frame/{id}`, `/media/{id}`, `/stream/{id}` fetch camera
images/media upstream with bounded timeouts (`CCTV_FRAME_FETCH_TIMEOUT_MS` 8 s, `CCTV_MEDIA_FETCH_TIMEOUT_MS` 15 s,
`cctv/constants.js:245-255`) — bounded streaming responses that fit a 60 s function budget.

**(f) Timers and in-memory state.** `terrain.js:95-106` keeps an unref'd 15 s disk-flush interval;
`transitService.js:113` keeps an in-memory vehicle history; `opensky.js:28-70` keeps a credit governor and
single-flight maps; `traffic.js` keeps a per-process daily tile budget; every `.gev-cache` path is derived from
`process.cwd()` at plugin construction (`celestrak.js:25`, `traffic.js:38`, `terrain.js:26`, `firms.js:32`,
`enrichment.js:12`, `launch-library.js:25-29`, `overpass/constants.js:54`, `military-installations/constants.js:36`)
and every disk write is try/catch-guarded. In serverless these become per-instance, best-effort caches.

## Not serverless-safe (recommendation)

| Route | Why | Recommendation |
|---|---|---|
| `/api/ais-live`, `/api/ais-live/track` | persistent upstream WebSocket + watchdog interval | feature-flag off → 501 `unavailable_in_serverless`; do not mount the plugin |
| `/api/realtime/token` | mints OpenAI Realtime ephemeral client secrets for the browser | disable under the flag → 501; never mint client secrets from a function |
| `/api/realtime/debug-log` | appends to `.gev-logs/` on the project filesystem | no-op / 501 |
| `/api/setup/status`, `/api/setup/keys` | dev-only, loopback-only `.env` writer | omit; let `/api` fallback return 404 (client hides the panel) |

Everything else is request/response and can be mounted unchanged behind one catch-all function, with
`process.cwd()` redirected to a writable temp dir so the guarded `.gev-cache` writes succeed.

## Env var names read under `server/` (names only, de-duplicated)

AISSTREAM_API_KEY, AISSTREAM_BOUNDING_BOXES, AISSTREAM_MESSAGE_TYPES, AISSTREAM_SILENCE_TIMEOUT_MS, AISSTREAM_URL,
CCTV_AUSTIN_MAX_SOURCES, CCTV_AUSTIN_ROWS_URL, CCTV_CALGARY_MAX_SOURCES, CCTV_CALGARY_ROWS_URL, CCTV_CALTRANS_DISTRICTS,
CCTV_CALTRANS_MAX_SOURCES, CCTV_DRIVEBC_MAX_SOURCES, CCTV_FINTRAFFIC_MAX_SOURCES, CCTV_FORCE_AUSTIN, CCTV_GROUND_HEIGHTS_FILE,
CCTV_MAX_SOURCES, CCTV_NSW_MAX_SOURCES, CCTV_ONTARIO_MAX_SOURCES, CCTV_PREFER_AUSTIN, CCTV_SOURCES_FILE, CCTV_SOURCES_JSON,
CCTV_TALLINN_MAX_SOURCES, CCTV_TALLINN_SOURCES_FILE, CCTV_TARKTEE_MAX_SOURCES, CCTV_TFL_MAX_SOURCES, CCTV_TXDOT_DISTRICTS,
CCTV_TXDOT_MAX_SOURCES, CCTV_WARENDORF_SOURCES_FILE, CESIUM_ION_TOKEN, FIRMS_MAP_KEY, GEV_KEY_SETUP_EXTERNAL_KEYS, GEV_LAUNCHER,
GEV_RATELIMIT_GOOGLE_PER_MIN, GEV_RATELIMIT_OPENAI_PER_MIN, GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_SERVER_API_KEY, HOST, LL2_API_TOKEN,
OPENAI_API_KEY, OPENAI_HUD_SUMMARY_MODEL, OPENAI_REALTIME_CONTEXT_RETENTION, OPENAI_REALTIME_CONTEXT_TOKENS, OPENAI_REALTIME_MODEL,
OPENAI_REALTIME_MODEL_MINI, OPENAI_REALTIME_REASONING_EFFORT, OPENAI_REALTIME_VOICE, OPENSKY_AUTH_MODE, OPENSKY_CLIENT_ID,
OPENSKY_CLIENT_SECRET, OPENSKY_PASSWORD, OPENSKY_USERNAME, PORT, TFL_APP_KEY, TOMTOM_API_KEY, TOMTOM_DAILY_TILE_BUDGET.
(`CCTV_*_ENABLED` flags listed in `.env.example` are consumed through the catalog's `enabled()` predicates in
`cctv/catalog.js:33-90`.)
