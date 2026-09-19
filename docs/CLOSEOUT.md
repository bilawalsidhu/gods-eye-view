# OnDemand Spatial — Closeout 2026-09-19

Branch `ondemand-serverless` · repository `mk42-ai/gods-eye-view` · package `ondemand-spatial` · Vercel project
`ondemand-eand-spatial` (team `schoolhack-web-team`). Every value below was read from the checkout, the Vercel API or a
live probe on 2026-09-18/19 (UTC). No secret VALUE appears in this document — environment-variable NAMES only. Brand:
BrandGuidelines.pdf per `docs/brand/BRAND_SOURCE.md` (tokens `src/brand/tokens.css`, primary `--od-green-500 #3BB795`,
dark ground `--od-ink #161616`; lockup `public/brand/logo-light.svg`, mark `public/brand/mark-light.svg`).

## 1. Final-state ledger

| Area | State | Evidence |
|---|---|---|
| Rebrand | **DONE** — title "OnDemand Spatial", package `ondemand-spatial` | commits `ff596ee` (2026-09-18T11:16:44Z brand kit) → `64d079e` (11:17:03Z rename + `ONDEMAND_SPATIAL_FLOW_VERSION` with alias-first `GODS_EYE_FLOW_VERSION`) → `b26fc2f` (11:17:22Z docs, registration pack, grep report); grep audit 146 files / 1,559 hits / OTHER = 0; 1,250 persisted-state / registered-client ids + 64 frozen v1 prompt hits retained by decision (2026-09-18, confirmed 2026-09-19) |
| Movement layers | **DONE** — 0 UNAVAILABLE / 0 HTTP 502 on preview and on the real project | `04db22b` (shared upstream helper) `aef74d7` `75a930d` `cfea752` `fb4c5ae` `4dc98fc` (2026-09-18T14:28–14:29Z); `7ae8a50` real-Vercel routing fix; `68a51bf` handover; `7a24c7a` Overpass mirrors (`OVERPASS_ENDPOINTS` + alias `OVERPASS_UPSTREAMS`, rotation through the shared helper, structured 503 → `DEGRADED · Overpass · <reason>`); `0677f16` form-body fix for `/api/overpass` on real Vercel |
| Gates at `7a24c7a` | **GREEN** | format ✓ (964 files) · boundaries ✓ · unit 4,352 tests / **4,351 pass / 0 fail / 1 pre-existing skip** · ondemand 219 · serverless 57 (58 after `0677f16`) · build ✓ · **9 functions** |
| Selftest / health | **9 passed / 0 failed / 1 skipped**, health healthy + configured | sandbox preview https://sb-2wb9cvfm6b9q.vercel.run, 2026-09-19T01:47:39–01:48:20Z (step 4 built-in tool/plugin skipped: account has no agents) |
| Exports | closeout zip + 8-commit patch that applies cleanly onto `4dc98fc` (`git apply --check` OK, `git am` tree identical) | `ondemand-spatial-closeout-7a24c7a.zip` (83,415,409 B, sha256 `78db200c…c34197`), `ondemand-spatial-closeout-4dc98fc..7a24c7a.patch` (1,086,676 B, sha256 `21e56be4…4928a`) |
| Push | `68a51bf..7a24c7a ondemand-serverless -> ondemand-serverless` (2026-09-19T02:24:45Z), then `7a24c7a..<this run>` | remote `https://github.com/mk42-ai/gods-eye-view.git` |
| Vercel env vars | **21** on the project | incl. `ONDEMAND_SPATIAL_WORKFLOW_ID` (`lTU2obzhz3oJXEMI`, plain, prod+preview) and `ONDEMAND_SPATIAL_FLOW_VERSION` (`siAgsm6hBOQrEYcY`); `GODS_EYE_FLOW_VERSION` (`usC3wgbut65gTkaR`) still present |
| **Part A real deployment** | **ACHIEVED (preview)** — `dpl_33CfSGEWDxgimgodxnHzJUW3CbwT` READY, https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app (createdAt 2026-09-19T02:41:20.097Z, build 30.0 s, sha `0677f16`); first attempt `dpl_GDb1kCXDZRQzYdS8BzNTt5JvLuQq` (sha `7a24c7a`, READY 02:37:44Z) exposed the `/api/overpass` form-body 400 fixed by `0677f16` | health 200: `flowVersion.source = GODS_EYE_FLOW_VERSION` (`alias` — by design while the alias exists), **`spatialFlowId.source = ONDEMAND_SPATIAL_WORKFLOW_ID` (`canonical`)**; earthquakes 200 / count 100; selftest not run on the real project (token is a `sensitive` var, unreadable via API); Austin badges below. Full record: `docs/audit/deployment-verification.md` §10 |
| Production | **BLOCKED** (unchanged, not attempted) | `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9` — "Vercel couldn't find a Git account for the commit author"; project Git-linked to `mk42-ai/ondemand-eand-spatial` `main` |

## 2. Env-var table (verbatim names; reconciled against the live project list of 21)

Source: `docs/audit/closeout-2026-09-19.md` §A.3 (grep of `process.env.*` / `import.meta.env.*` across `server/`, `api/`,
`src/` plus helper-read names) and `.env.example`; "catch-all" = `api/[...route].js` → `server/serverless/app.js`,
"OnDemand functions" = `api/ondemand/*.js` via `server/ondemand/config.js`.

| Name | Required / optional | Layer / function | On `ondemand-eand-spatial` |
|---|---|---|---|
| `ONDEMAND_API_KEY` | required for a configured proxy (unkeyed = "not configured" health) | OnDemand functions | **yes** |
| `ONDEMAND_BASE_URL` | optional | OnDemand functions | **yes** |
| `ONDEMAND_API_BASE` | optional | OnDemand functions | **yes** |
| `ONDEMAND_REASONING_ENDPOINT_ID` | optional | OnDemand functions | **yes** |
| `ONDEMAND_FULFILLMENT_ENDPOINT_ID` | optional | OnDemand functions | **yes** |
| `ONDEMAND_ENDPOINT_ID` | optional | OnDemand functions | **yes** |
| `ONDEMAND_REASONING_MODE` | optional (validated: low / medium / high) | OnDemand functions | **yes** |
| `ONDEMAND_SPATIAL_WORKFLOW_ID` | optional | OnDemand functions; `api/ondemand/workflow.js` execute / selftest step 8 | **yes** |
| `ONDEMAND_SPATIAL_FLOW_ID` | optional | OnDemand functions | no |
| `ONDEMAND_SPATIAL_FLOW_VERSION` | optional | OnDemand functions | **yes** |
| `GODS_EYE_FLOW_VERSION` | optional | OnDemand functions | **yes** |
| `ONDEMAND_SPATIAL_AGENT_ID` | optional | OnDemand functions | no |
| `ONDEMAND_REQUEST_TIMEOUT_MS` | optional | OnDemand functions | no |
| `ONDEMAND_SELFTEST_TOKEN` | required only to expose `GET /api/ondemand/selftest` | `api/ondemand/selftest.js` | **yes** |
| `VITE_SERVERLESS_MODE` | required for the serverless UI build | Vite build (browser bundle, `import.meta.env`) + server/serverless/app.js | **yes** |
| `SERVERLESS_MODE` | optional | server/serverless/app.js (all functions) | no |
| `VERCEL` | n/a | server/serverless/app.js (serverless-mode detection) | no |
| `OPENSKY_CLIENT_ID` | optional (enables OAuth2 client-credentials) | catch-all → server/providers/aircraft/opensky.js (`/api/opensky`) | no |
| `OPENSKY_CLIENT_SECRET` | optional (with `OPENSKY_CLIENT_ID`) | catch-all → opensky.js | no |
| `OPENSKY_AUTH_MODE` | optional | catch-all → opensky.js | no |
| `OPENSKY_USERNAME` | optional (legacy basic auth) | catch-all → opensky.js | no |
| `OPENSKY_PASSWORD` | optional (legacy basic auth) | catch-all → opensky.js | no |
| `OPENSKY_TIMEOUT_MS` | optional | catch-all → opensky.js | no |
| `OPENSKY_RETRIES` | optional | catch-all → opensky.js | no |
| `OPENSKY_BREAKER_MS` | optional | catch-all → opensky.js | no |
| `OPENSKY_BBOX_DEGREES` | optional | catch-all → opensky.js | no |
| `OPENSKY_FALLBACK_RADIUS_NM` | optional | catch-all → opensky.js | no |
| `AIRPLANES_LIVE_ENABLED` | optional (opt-in third fallback) | catch-all → opensky.js, aircraft/adsb-lol.js (`/api/adsblol/mil`) | no |
| `AISSTREAM_API_KEY` | optional (live AIS; without it: AISHub or demo replay) | catch-all → server/providers/vessels/ais-live.js / ais-serverless.js (`/api/ais-live`) | no |
| `AISSTREAM_URL` | optional | catch-all → vessels/ais-live.js | no |
| `AISSTREAM_BOUNDING_BOXES` | optional | catch-all → vessels/ais-live.js | no |
| `AISSTREAM_MESSAGE_TYPES` | optional | catch-all → vessels/ais-live.js | no |
| `AISSTREAM_SILENCE_TIMEOUT_MS` | optional | catch-all → vessels/ais-live.js | no |
| `AISSTREAM_COLLECT_MS` | optional | catch-all → vessels/ais-serverless.js (bounded collector) | no |
| `AISSTREAM_COLLECT_QUIET_MS` | optional | catch-all → vessels/ais-serverless.js | no |
| `AISSTREAM_SNAPSHOT_TTL_MS` | optional | catch-all → vessels/ais-serverless.js | no |
| `AISHUB_USERNAME` | optional (keyless delayed AIS fallback) | catch-all → vessels/ais-serverless.js | no |
| `KV_REST_API_URL` | optional (shared AIS snapshot cache) | catch-all → vessels/kv-store.js | no |
| `KV_REST_API_TOKEN` | optional | catch-all → vessels/kv-store.js | no |
| `UPSTASH_REDIS_REST_URL` | optional | catch-all → vessels/kv-store.js | no |
| `UPSTASH_REDIS_REST_TOKEN` | optional | catch-all → vessels/kv-store.js | no |
| `TOMTOM_API_KEY` | optional (live traffic; keyless = DEGRADED simulation) | catch-all → server/providers/traffic.js (`/api/tomtom/*`) | no |
| `TOMTOM_DAILY_TILE_BUDGET` | optional | catch-all → traffic.js | no |
| `TOMTOM_DAILY_REQUEST_BUDGET` | optional | catch-all → traffic.js | no |
| `OVERPASS_ENDPOINTS` | optional | catch-all → server/providers/overpass/constants.js + transport.js (`/api/overpass`, Street Traffic roads) — **new 2026-09-19** | no |
| `OVERPASS_UPSTREAMS` | optional | catch-all → overpass/constants.js; `road_network_status` tool | no |
| `OVERPASS_MIRROR_TIMEOUT_MS` | optional | catch-all → overpass/constants.js | no |
| `OVERPASS_TOTAL_TIMEOUT_MS` | optional | catch-all → overpass/constants.js | no |
| `ROAD_NETWORK_SOURCE` | optional | catch-all → overpass/constants.js; server/tools/traffic.js | no |
| `NASA_FIRMS_MAP_KEY` | optional (Fires row, `/api/sources/fires`) | catch-all → server/sources/nasa-firms.js | no |
| `FIRMS_MAP_KEY` | optional (legacy `/api/firms` provider) | catch-all → server/providers/firms.js | no |
| `LL2_API_TOKEN` | optional | catch-all → server/providers/space/launch-library.js | no |
| `TFL_APP_KEY` | optional | catch-all → server/providers/cctv/sources.js | no |
| `OPENAI_API_KEY` | optional (voice/HUD summary; OnDemand-only voice does not need it) | catch-all → server/providers/openai/{hud-summary,realtime}.js | no |
| `OPENAI_HUD_SUMMARY_MODEL` | optional | catch-all → openai/hud-summary.js | no |
| `OPENAI_REALTIME_MODEL` | optional | catch-all → openai/realtime.js | no |
| `OPENAI_REALTIME_MODEL_MINI` | optional | catch-all → openai/realtime.js | no |
| `OPENAI_REALTIME_VOICE` | optional | catch-all → openai/realtime.js | no |
| `OPENAI_REALTIME_REASONING_EFFORT` | optional | catch-all → openai/realtime.js | no |
| `OPENAI_REALTIME_CONTEXT_TOKENS` | optional | catch-all → openai/realtime.js | no |
| `OPENAI_REALTIME_CONTEXT_RETENTION` | optional | catch-all → openai/realtime.js | no |
| `GEV_RATELIMIT_GOOGLE_PER_MIN` | optional | catch-all → server/providers/places/google.js | no |
| `GEV_RATELIMIT_OPENAI_PER_MIN` | optional | catch-all → server/providers/openai/rate-limit.js | no |
| `GOOGLE_MAPS_API_KEY` | optional (browser Places/Maps) | local dev only (server/standalone/vite.config.js / src/main.js) — not read by the deployment; `src/main.js` reads it at BUILD time via `import.meta.env` | no |
| `GOOGLE_MAPS_SERVER_API_KEY` | optional | src/keySetupCore.mjs (key-setup UI only) | no |
| `CESIUM_ION_TOKEN` | optional (Cesium ion assets) | local dev only (server/standalone/vite.config.js / src/main.js) — not read by the deployment; `src/main.js` at BUILD time | no |
| `CCTV_SOURCES_FILE / CCTV_SOURCES_JSON / CCTV_AUSTIN_ROWS_URL / CCTV_CALGARY_ROWS_URL / CCTV_*_MAX_SOURCES / CCTV_*_ENABLED / CCTV_*_DISTRICTS / CCTV_*_SOURCES_FILE / CCTV_FORCE_AUSTIN / CCTV_PREFER_AUSTIN / CCTV_MAX_SOURCES / CCTV_GROUND_HEIGHTS_FILE` | optional (CCTV source-pack tuning; 30 names) | catch-all → server/providers/cctv/{catalog,sources,groundHeights}.js | no (none of these) |
| `VITE_AIS_LIVE_API_URL / VITE_AIS_LIVE_MAX_ROWS / VITE_AIS_LIVE_LABEL_MAX_ROWS` | optional (build-time) | Vite build (browser bundle, `import.meta.env`) (src/data/aisLiveVessels.js, src/standalone/*) | no (none of these) |
| `GEV_ALLOC_* (CHUNK, CHUNKS, ENTRIES, PROFILE, SOLVE_MS, STABILIZATION_CHUNKS, WARMUP)` | optional (allocation micro-benchmark) | src/overlays/worldOverlayAllocation.worker.mjs (test/benchmark only) | no (none of these) |
| `GEV_KEY_SETUP_EXTERNAL_KEYS / GEV_LAUNCHER / GEV_HARDEN_FAILED / GEV_STORE_UNREADABLE / PINOKIO_SHARE_VAR` | optional | local dev only (server/standalone/vite.config.js / src/main.js) — not read by the deployment (Pinokio key-setup flow) | no (none of these) |
| `HOST / PORT` | optional | server/serverless/dev-server.mjs, server/standalone/vite.config.js (local only) | no (none of these) |
| `BASE_URL / DEV` | n/a | Vite build (browser bundle, `import.meta.env`) | no (none of these) |

Present on the project but read by nothing in this code base: `ASK_ENABLED`, `CI`, `ASK_THE_DEAL_ALLOWED_ORIGIN`,
`DOC_BUSINESS_PLAN_URL`, `DOC_BUSINESS_PLAN_PDF_URL`, `DOC_MOU_URL`, `DOC_GANTT_URL` (previous app) and the deny-listed
`ONDEMAND_KNOWLEDGE_PLUGIN_IDS`, `ELEVENLABS_API_KEY`. **Missing and needed for LIVE rows:** `OPENSKY_CLIENT_ID`,
`OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `TOMTOM_API_KEY`; optional: `OVERPASS_ENDPOINTS` (+ alias), KV
credentials, `AISHUB_USERNAME`.

## 3. Operator runbook

```bash
# 1. exact tree
unzip ondemand-spatial-closeout-<sha>.zip -d ondemand-spatial && cd ondemand-spatial
# 2. install, test, build (Node 24 recommended; Vercel builds on 24.x from package.json engines)
PUPPETEER_SKIP_DOWNLOAD=1 npm ci && npm test && npm run build      # expect 4,35x pass / 0 fail, 9 functions
# 3. link the checkout to the existing project (no Git push involved)
npx vercel link --scope schoolhack-web-team --project ondemand-eand-spatial --yes
# 4. preview deployment (inherits the project's env vars); NEVER --prod here
npx vercel deploy --scope schoolhack-web-team
# 5. verify (replace <host> with the printed preview URL)
curl -s https://<host>/api/ondemand/health?envNames=1 | jq '.ondemand, .config.flowVersion, .config.spatialFlowId'
curl -s "https://<host>/api/sources/earthquakes?starttime=$(date -u -d '-24 hours' +%Y-%m-%dT%H:%M:%SZ)" | jq '.count'
curl -s -H "x-selftest-token: $ONDEMAND_SELFTEST_TOKEN" https://<host>/api/ondemand/selftest | jq '.summary'   # expect 9 / 0 / 1
# 6. promote ONLY after every check above is green
npx vercel promote <deployment-url> --scope schoolhack-web-team
```

Upstream keys (add in Vercel → Settings → Environment Variables, production + preview):

| Variable(s) | How to obtain | Limits / behaviour in this app |
|---|---|---|
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | OpenSky Network account → account page → "API client" → create a client; the adapter exchanges them at the OAuth2 client-credentials token endpoint `https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token` | tokens expire after ~30 min and are refreshed by `server/providers/aircraft/opensky.js`; anonymous access is rate-limited; scene bounding-box queries (`OPENSKY_BBOX_DEGREES` 1.5°); cloud egress has connect-timed-out to opensky-network.org (2026-09-18/19), so the adsb.lol → adsb.fi fallback and the 10-min breaker stay |
| `AISSTREAM_API_KEY` | sign up at https://aisstream.io (GitHub login) → API keys; WebSocket `wss://stream.aisstream.io/v0/stream`, subscription `{"APIKey": …, "BoundingBoxes": [[[lat,lon],[lat,lon]]]}` | caution: aisstream/aisstream#15 (13 Mar 2026) — subscription accepted, socket open, zero messages; the bounded collector keeps AISHub (`AISHUB_USERNAME`) and the labelled demo replay as fallbacks and reports `DEGRADED` with the reason |
| `TOMTOM_API_KEY` | TomTom Developer Portal (free trial) → key with the Traffic API enabled; Flow Segment Data `GET /traffic/services/4/flowSegmentData/{style}/{zoom}/json?point=lat,lon&key=…` | flow updated every ~30 s; keyless returns 401 (the proxy answers a structured 503 and the row reads `DEGRADED · TomTom · TOMTOM_API_KEY not set …`); daily soft caps `TOMTOM_DAILY_TILE_BUDGET` 40,000 / `TOMTOM_DAILY_REQUEST_BUDGET` 2,000 |
| `OVERPASS_ENDPOINTS` (alias `OVERPASS_UPSTREAMS`) | comma-separated mirror list in priority order | default `kumi.systems, private.coffee, overpass-api.de, lz4., z.` (probe 2026-09-19); from Vercel `iad1` kumi.systems and private.coffee are intermittently reachable, overpass-api.de/lz4/z answer 406 — recommend a vetted/private mirror or a self-hosted Overpass (or a planet-extract road network) listed FIRST; `OVERPASS_MIRROR_TIMEOUT_MS` 12 s / `OVERPASS_TOTAL_TIMEOUT_MS` 40 s keep a rotation inside the 60 s function ceiling |

Conditions and unblocks:

- **Delete `GODS_EYE_FLOW_VERSION` (`usC3wgbut65gTkaR`) only after** the real deployment's health reports
  `config.flowVersion.source = ONDEMAND_SPATIAL_FLOW_VERSION` and `resolvedVia = canonical` — which, because the code
  checks the alias FIRST, happens only once the alias is gone: confirm both variables hold the same value, delete the
  alias, redeploy, re-check. Until then health reads `GODS_EYE_FLOW_VERSION` / `alias` (verified 2026-09-19 on
  `dpl_33CfSGEWDxgimgodxnHzJUW3CbwT`).
- **Git-author unblock for production:** link each committer's GitHub account to the Vercel team (`goose-bot`,
  `akleem@schoolhack.ai`), or keep deploying from the CLI (CLI/API deployments are not subject to the check).
- **Canonical remote:** the Vercel project is Git-linked to `mk42-ai/ondemand-eand-spatial` (`main`); this branch lives on
  `mk42-ai/gods-eye-view` `ondemand-serverless`. Either re-link the project or land the branch on the linked repo before
  relying on Git-triggered deploys.

## 4. OnDemand dashboard registration

Pack: `docs/registration/ONDEMAND_REGISTRATION_PACK.md`, tool definitions `docs/ondemand-tools/*.json`
(`docs/ondemand-workflows/tools/earthquake_search.openapi.json`), skills `docs/ondemand-skills/*.md`, registry
`src/registry/capabilities.json`. Agent creation is dashboard-only (REST `GET /plugin/v1/list` total 0 on 2026-09-18).

1. **Agent** — create under the name **OnDemand Spatial** (persona and nine skills from the pack; the skill slugs are
   `ondemand-spatial-<x>`). Return the **agent id** → `src/registry/capabilities.json` `ondemand.agent.pluginId` and the
   deployment variable `ONDEMAND_SPATIAL_AGENT_ID`.
2. **Tool `earthquake_search`** — import the OpenAPI definition from the pack; set the server URL to
   `https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app/api/sources/earthquakes` (the Part A preview;
   replace with the promoted production host when it exists). Fields to fill: name `earthquake_search`, description from
   the pack, operation `GET /api/sources/earthquakes`, parameters `starttime`, `endtime`, `minmagnitude`, `maxmagnitude`,
   `latitude`, `longitude`, `maxradiuskm`, `limit` (≤ 200), no auth. Return the **tool id** →
   `capabilities[earthquake.search].ondemand_tool_id`.
3. **Workflow** — `6aace534859f7b0abb53d99a` ("OnDemand Spatial Advanced Workflow", display name renamed 2026-09-18
   10:41:47Z via `PATCH /workflow/{id}/name` → 200, id and v1 definition unchanged). Note: the 26-character spelling
   `6aace534859f9f7b0abb53d99a` that appears in some briefs is not the id (it answers 404); the project variable
   `ONDEMAND_SPATIAL_WORKFLOW_ID` holds the 24-character id above.
4. **Passed test call** — from the agent, ask for "earthquakes in the last 24 hours near Austin"; the tool call must
   return `source: USGS`, `count ≥ 0` (a live 24 h query on 2026-09-19 returned 100 events). Paste the tool id, the agent
   id and the test-call transcript back; that flips registry row 1 (USGS earthquakes) from `CREATED` to
   `CREATED / TESTED` and unblocks row 2 (Fires — `fire_detection_search`, needs `NASA_FIRMS_MAP_KEY`).

## 5. Expected badge text per MOVEMENT layer

| Row | Without keys (today) | With keys |
|---|---|---|
| Satellites | `LIVE · CelesTrak · <age>` (no key needed; celestrak.org → celestrak.com → cached → bundled TLE snapshot = `STALE`) | same |
| Live Flights | `DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` | `LIVE · OpenSky` (OAuth2 client credentials; adsb.lol/adsb.fi remain the fallback) |
| Military Flights | `LIVE · adsb.lol · <age>` (no key) | same |
| Live Vessels | `DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not live AIS` (coastal scenes) / `Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` (inland) | `LIVE · AISStream`, or `DEGRADED · AISStream · <reason>` when the feed delivers no frames (issue #15) |
| Street Traffic | `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)`; when every Overpass mirror fails: `DEGRADED · Overpass · all 5 mirrors failed · last: <mirror> HTTP 406` | `LIVE · TomTom flow · <n>% cov` (road network still subject to Overpass) |

Captured at `7a24c7a` on the sandbox preview https://sb-2wb9cvfm6b9q.vercel.run (all five toggles ON, DENSE satellites,
1440×900) — Austin (MGRS 14R PU 1994 4730):

| Row | Badge | Subtext (verbatim, 2026-09-19 02:06:56Z) |
|---|---|---|
| Satellites | `ON` | `LIVE · CelesTrak · 15m ago` |
| Live Flights | `DEGRADED` | `DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` |
| Military Flights | `ON` | `LIVE · adsb.lol · just now` |
| Live Vessels | `ON` | `Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` |
| Street Traffic | `DEGRADED` | `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)` |

Galveston Bay (`#lat=29.55&lon=-94.80&alt=12000`, 12 demo vessels, 689 flights, 25 military, 11.5K satellites):

| Row | Badge | Subtext (verbatim, 2026-09-19 02:18:42Z) |
|---|---|---|
| Satellites | `ON` | `LIVE · CelesTrak · 27m ago` |
| Live Flights | `DEGRADED` | `DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` |
| Military Flights | `ON` | `LIVE · adsb.lol · just now` |
| Live Vessels | `DEGRADED` | `DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not live AIS` |
| Street Traffic | `DEGRADED` | `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)` |

Captured on the REAL project (deployment #2, `0677f16`, 2026-09-19T02:45:12Z) — Austin:

| Row | Badge (toggle) | Subtext (verbatim) |
|---|---|---|
| Satellites | `ON` | `LIVE · CelesTrak · 2m ago` |
| Live Flights | `DEGRADED` | `DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` |
| Military Flights | `ON` | `LIVE · adsb.lol · just now` |
| Live Vessels | `ON` | `Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` |
| Street Traffic | `LOADING` | `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) · SIMULATED — add TomTom key for live` |

## 6. Links

- This run's exports: `ondemand-spatial-closeout-<final sha>.zip` (workspace root; fresh download link in the run's
  response) and the previous run's `ondemand-spatial-closeout-7a24c7a.zip` / `ondemand-spatial-closeout-4dc98fc..7a24c7a.patch`
  (re-attached from the run of 2026-09-19 02:25Z).
- Prior bundles (blob SAS links expire ~7 days): 143239 https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aad33576ee0bd14717728bb/generated/code-files-20260918-143239_v1.zip · 080112 https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacdaab6ee0bd14717722ed/generated/code-files-20260918-080112_v1.zip · 070158 https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacdaab6ee0bd14717722ed/generated/code-files-20260918-070158_v1.zip · 061656 https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacbeed6ee0bd14717721db/generated/code-files-20260918-061656_v1.zip · 055245 https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aacbeed6ee0bd14717721db/generated/code-files-20260918-055245_v1.zip
- API contract: https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aab7efbcc6f5bb3618919ab/generated/ONDEMAND_API_CURRENT_v1.md (repo copy `docs/ONDEMAND_API_CURRENT.md`)
- Brand source record: `docs/brand/BRAND_SOURCE.md`
- Before screenshot (user's outage capture, all rows UNAVAILABLE): https://airevprod.blob.core.windows.net/on-demand-prod/6692b763e851d28a036ab30e/media/canvas-screenshot-385x525_1gud.png
- After screenshots (7a24c7a): https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aade189992c8f198df14e4c/ui-proof/after-austin-1440x900_v1.png and https://airevprod.blob.core.windows.net/on-demand-agent/agent-outputs/6692b763e851d28a036ab30e/6aab3596cc6f5bb3618917b7/6aade189992c8f198df14e4c/ui-proof/after-galveston-1440x900_v1.png; real-project capture `docs/audit/assets/deployment-austin-1440x900.png`
- Previews: https://sb-60dkzxm81yfw.vercel.run (rebrand) · https://sb-5z1tt82ep4go.vercel.run (movement fix) · https://sb-2wb9cvfm6b9q.vercel.run (Overpass mirrors; ephemeral) · real project https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app

## 7. Proofs

| Proof | Value |
|---|---|
| Rebrand commits | `ff596ee` 2026-09-18T11:16:44Z · `64d079e` 2026-09-18T11:17:03Z · `b26fc2f` 2026-09-18T11:17:22Z |
| Movement-layer commits | `04db22b` 14:28:55Z · `aef74d7` 14:29:21Z · `75a930d` 14:29:21Z · `cfea752` 14:29:54Z · `fb4c5ae` 14:29:54Z · `4dc98fc` 14:29:54Z (2026-09-18) |
| Later commits | `ab23c7b` `1813f0d` 17:46:48Z · `bcf881f` `6320b58` 17:47:13Z · `a62d4a7` 18:08:47Z · `7ae8a50` 18:44:08Z · `68a51bf` 18:55:50Z (2026-09-18) · `7a24c7a` 2026-09-19T02:24:35Z · `0677f16` 2026-09-19T02:41:15Z · this run's docs commit(s) — see `git log --format='%H %cI %s'` |
| Test counts | unit 4,352 / 4,351 pass / 0 fail / 1 skip (7a24c7a) · ondemand 219 · serverless 57 → 58 (0677f16) · format 964 files · boundaries ✓ · build ✓ · 9 functions |
| Deployments | baseline `dpl_743G2gRzJbm4Vxm9d1PZQtqJTo7i` (createdAt 1789756747832, 4dc98fc) · `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9` BLOCKED (production) · **new** `dpl_GDb1kCXDZRQzYdS8BzNTt5JvLuQq` (7a24c7a, READY 02:37:44Z) · **new** `dpl_33CfSGEWDxgimgodxnHzJUW3CbwT` (0677f16, READY 02:41:20Z) |
| Vercel env ids | `ONDEMAND_SPATIAL_WORKFLOW_ID` `lTU2obzhz3oJXEMI` · `ONDEMAND_SPATIAL_FLOW_VERSION` `siAgsm6hBOQrEYcY` · `GODS_EYE_FLOW_VERSION` `usC3wgbut65gTkaR` · `ONDEMAND_SELFTEST_TOKEN` `NGrV0CvtudZY76Yj` |
| Selftest | sandbox 2026-09-19T01:47:41Z: 9 passed / 0 failed / 1 skipped, 38,972 ms total (min 270 · max 14,036 · mean 4,872 ms) |
