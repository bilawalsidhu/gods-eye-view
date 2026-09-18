# Deployment verification — ondemand-serverless

| Item | Value |
|---|---|
| Audited commit | `0d41b6be5490db1f10a171f238be75db4d4ec3b4 2026-09-16 11:57:56 -0700 Merge pull request #626 from bilawalsidhu/fix/vessel-partial-feed-status` |
| Deployed branch / head | `ondemand-serverless` @ `7b5161d` (+ this verification commit) |
| Deployment target | Vercel Sandbox (Firecracker microVM, runtime node24 = Node v24.14.1), sandbox id `sbx_OcjVThKWIPZ3JOQo5AlzRWXLXoPo`, published port 3000 |
| Server process | `npm run dev:serverless` → `server/serverless/dev-server.mjs` serving `dist/` (SPA fallback) + `api/**` functions with Vercel's file-system resolution order (literal file → catch-all) |
| Environment | `.env`: VITE_SERVERLESS_MODE=true, SERVERLESS_MODE=true, HOST=0.0.0.0, PORT=3000 — **no provider secrets, no ONDEMAND_API_KEY** |
| LIVE PREVIEW URL | https://sb-307x6fgbxmou.vercel.run |
| Sandbox npm ci | 2026-09-17T07:08:15Z → 07:08:20Z, exit 0 (PUPPETEER_SKIP_DOWNLOAD=1) |
| Sandbox production build | 2026-09-17T07:08:39Z → 07:08:49Z, `npm run build` exit 0, ✓ built in 7.59s, dist/cesium/{Assets,Cesium.js,ThirdParty,Widgets,Workers} present |

## 1. GET / (must be 200)

- Request (UTC): 2026-09-17T07:09:33Z — `curl -sS -o /dev/null -w '%{http_code}' https://sb-307x6fgbxmou.vercel.run/`
- **HTTP status: 200**

```
HTTP/2 200 
date: Thu, 17 Sep 2026 07:09:34 GMT
content-type: text/html; charset=utf-8
server: Vercel
x-vercel-id: iad1::d4tk5-1789628974154-95a2c55d43da
strict-transport-security: max-age=63072000
cache-control: public, max-age=0, must-revalidate
x-vercel-internal-path-type: sandbox
x-vercel-internal-metadata-state: origin_fresh
x-vercel-internal-cache-level: unknown
x-vercel-internal-project-id: u
x-vercel-internal-owner-id: u
x-vercel-internal-deployment-id: u
x-vercel-internal-proxy-pool: blue
x-vercel-internal-request-cpu-ms: 1
x-vercel-internal-proxy-cpu-load: 58
x-vercel-internal-timing: vcoe_from_proxy=25
```

First 12 lines of the body:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <link rel="stylesheet" href="/cesium/Widgets/widgets.css">
  <script src="/cesium/Cesium.js"></script>

  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>God's Eye View</title>
  <link rel="icon" type="image/svg+xml" href="/logo.svg" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
```

## 2. GET /api/ondemand/health (must be the 'not configured' shape)

- Request (UTC): 2026-09-17T07:09:34Z — `curl -sS https://sb-307x6fgbxmou.vercel.run/api/ondemand/health`
- **HTTP status: 200**

Response headers:
```
HTTP/2 200 
date: Thu, 17 Sep 2026 07:09:34 GMT
content-type: application/json; charset=utf-8
content-length: 344
cache-control: no-store
server: Vercel
x-vercel-id: iad1::mppf8-1789628974221-b52d446ded56
strict-transport-security: max-age=63072000
x-vercel-internal-path-type: sandbox
x-vercel-internal-metadata-state: origin_fresh
x-vercel-internal-cache-level: unknown
x-vercel-internal-project-id: u
x-vercel-internal-owner-id: u
x-vercel-internal-deployment-id: u
x-vercel-internal-proxy-pool: blue
x-vercel-internal-request-cpu-ms: 0
x-vercel-internal-proxy-cpu-load: 45
x-vercel-internal-timing: vcoe_from_proxy=11
```

Response body (verbatim):
```json
{"ondemand":"not configured","chat":"not configured","speech":"not configured","media":"not configured","workflow":"not configured","plugins":{},"configured":false,"checkedAt":"2026-09-17T07:09:34.231Z","message":"ONDEMAND_API_KEY is not set. Set it in the Vercel project Environment Variables (or in .env for local dev) and redeploy/restart."}
```

Pretty-printed:
```json
{
    "ondemand": "not configured",
    "chat": "not configured",
    "speech": "not configured",
    "media": "not configured",
    "workflow": "not configured",
    "plugins": {},
    "configured": false,
    "checkedAt": "2026-09-17T07:09:34.231Z",
    "message": "ONDEMAND_API_KEY is not set. Set it in the Vercel project Environment Variables (or in .env for local dev) and redeploy/restart."
}
```

- Verified (UTC 2026-09-17T07:09:34Z): every one of ondemand/chat/speech/media/workflow is `"not configured"`, `plugins` is `{}`, HTTP 200, and the message names the missing ONDEMAND_API_KEY. No other AI provider was contacted.

## 3. Additional route checks on the live preview

| UTC | Method | Path | Status | Content-Type | Body (first 160 chars) |
|---|---|---|---|---|---|
| 2026-09-17T07:09:50Z | GET | `/api/firms/status` | 200 | application/json | `{"hasKey":false,"lastFetch":null,"count":null,"stale":false,"ttlMs":1800000,"transactions":null}` |
| 2026-09-17T07:09:50Z | GET | `/api/tomtom/status` | 200 | application/json | `{"hasKey":false,"dailyCount":0,"budget":40000,"date":"2026-09-17"}` |
| 2026-09-17T07:09:50Z | GET | `/api/celestrak/active` | 200 | text/plain | `CALSPHERE 1             
 1 00900U 64063C   26259.82940569  .00000472  00000+0  47004-3 0  9995
 2 00900  90.2178  73.8919 0026477  19.3115  86.8850 13.76705816` |
| 2026-09-17T07:09:53Z | GET | `/api/ais-live` | 501 | application/json; charset=utf-8 | `{"error":"unavailable_in_serverless","feature":"ais-live","message":"Live vessel relay (AISStream WebSocket) is unavailable in the serverless deployment"}` |
| 2026-09-17T07:09:53Z | GET | `/api/realtime/token` | 501 | application/json; charset=utf-8 | `{"error":"unavailable_in_serverless","feature":"voice-realtime","message":"Voice control (OpenAI Realtime ephemeral session) is unavailable in the serverless de` |
| 2026-09-17T07:09:53Z | POST | `/api/realtime/debug-log` | 204 | – | `` |
| 2026-09-17T07:09:53Z | GET | `/api/setup/status` | 404 | application/json | `{"error":"Unknown API route"}` |
| 2026-09-17T07:09:53Z | GET | `/api/does-not-exist` | 404 | application/json | `{"error":"Unknown API route"}` |
| 2026-09-17T07:09:54Z | GET | `/some/spa/route` | 200 | text/html; charset=utf-8 | `<!DOCTYPE html> <html lang="en"> <head>   <link rel="stylesheet" href="/cesium/Widgets/widgets.css">   <script src="/cesium/Cesium.js"></script>    <meta charse` |
| 2026-09-17T07:09:54Z | GET | `/cesium/Widgets/widgets.css` | 200 | text/css; charset=utf-8 | `/* packages/widgets/Source/shared.css */ .cesium-svgPath-svg {   position: absolute;   top: 0;   left: 0;   width: 100%;   height: 100%;   overflow: hidden; } .` |
| 2026-09-17T07:09:54Z | POST | `/api/ondemand/sessions` | 503 | application/json; charset=utf-8 | `{"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` |
| 2026-09-17T07:09:54Z | POST | `/api/ondemand/chat` | 503 | application/json; charset=utf-8 | `{"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` |
| 2026-09-17T07:09:54Z | GET | `/api/ondemand/workflow?action=stream-logs` | 503 | application/json; charset=utf-8 | `{"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` |
| 2026-09-17T07:09:54Z | POST | `/api/ondemand/tts` | 503 | application/json; charset=utf-8 | `{"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` |

Notes: `/api/celestrak/active` reaches celestrak.org from the sandbox (a 200 with TLE text proves the legacy provider handler runs unchanged inside the catch-all; a 5xx JSON would indicate an upstream/network failure handled by the provider). `/api/ondemand/*` routes other than health answer 503 `not_configured` because no ONDEMAND_API_KEY is deployed — by design for this run. `/api/ais-live` and `/api/realtime/token` are feature-flagged off (501) in serverless mode; `/api/setup/status` is intentionally unmounted (404) so the in-app key panel hides itself.

## 4. Production run (real Vercel function runtime) — 2026-09-17T08:09Z–08:13Z

### 4.1 Resolution of `finalProductionUrl`

| Check | Result (UTC) |
|---|---|
| Project linked to `bilawalsidhu/gods-eye-view` or named `gods-eye-view` / `gods-eye-view-ondemand-serverless` on the Vercel account (user `navnit-5790`, team `schoolhack-web-team`, plan pro) | **none** — the account's projects are `ondemand-hq`, `airev-ondemand-deck`, `ondemand-agent`, `rilian-airev-ondemand-deck`, `ondemand-eand-spatial`, `ondemand-eand-spatial-jyxd`, `airev-ondemand-investor-deck`, `on-demand-ai-investments` (pre-executed project listing consumed 2026-09-17T08:09Z) |
| `ondemand-eand-spatial` (`prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO`) production target | `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9`, commit `e799775a`, readyState **BLOCKED**; alias `https://ondemand-eand-spatial-schoolhack-web-team.vercel.app/` → **404 `DEPLOYMENT_NOT_FOUND`** (2026-09-17T08:09:45Z) |
| `ondemand-eand-spatial` latest READY deployment | `dpl_FKoHEVctqpLzNMaHV9sSRdmzcrw6`, readyState READY (STAGED), alias `https://ondemand-eand-spatial-opal.vercel.app`, git ref `feat/exec-brief-v1.4-b7c0d3d`, commit `b8cdcf501aa77ada93dde682a8c6fec35f9c5637` of `mk42-ai/ondemand-eand-spatial` |
| **finalProductionUrl** | **`https://ondemand-eand-spatial-opal.vercel.app`** — chosen because production is BLOCKED (rule: production alias only if READY, otherwise the READY preview alias) |
| Does it serve `/api/ondemand/health`? | **No.** `GET /api/ondemand/health` → 404 `text/plain`, `x-vercel-error: NOT_FOUND` (2026-09-17T08:09:46Z). The host serves a different Vite application (`<html lang="en" data-theme="light">`, no Cesium assets). **It is not the OnDemand Spatial serverless build.** |
| `vercel deploy` of the branch | not run — `vercel link` / `vercel deploy` / `vercel env pull` are refused by the environment guardrail (`vercel: BLOCKED by platform policy — the Vercel CLI is not available in this environment`, exit 126, 2026-09-17T08:12:26Z); no `.vercel/` or `.env.production.local` was created |

### 4.2 Production smoke matrix — `https://ondemand-eand-spatial-opal.vercel.app` (deployment `dpl_FKoHEVctqpLzNMaHV9sSRdmzcrw6`)

| Route | Expected (OnDemand Spatial build) | Actual status | UTC | Note |
|---|---|---|---|---|
| `GET /` | 200 | **200** `text/html` | 2026-09-17T08:12:13Z | a different application (exec-brief app), not `index.html` of this repo |
| `GET /api/ondemand/health` | 200, configured/healthy | **404** `text/plain` | 2026-09-17T08:12:13Z | Vercel platform `NOT_FOUND` — route does not exist on this deployment; no env-var finding can be derived because the OnDemand Spatial functions are not deployed here |
| `GET /api/celestrak/active` (legacy provider via catch-all) | 200 + ≥1 three-line TLE set | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` — no TLE data; assertion not evaluable |
| `GET /api/ais-live` | 501 | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` |
| `GET /api/realtime/token` | 501 | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` |
| `GET /api/setup/status` | 404 (JSON `Unknown API route`) | **404** `text/plain` | 2026-09-17T08:12:14Z | Vercel `NOT_FOUND`, not the catch-all's JSON 404 |

**Conclusion:** 0 / 6 expectations of the OnDemand Spatial build are met on `finalProductionUrl` because the branch is not deployed there. The same matrix against the previous turn's ephemeral sandbox running this branch (`https://sb-307x6fgbxmou.vercel.run`, evidence only, not a Vercel function runtime) at 2026-09-17T08:12:14Z gave 200 / 200 (all `not configured`, no key) / 200 with TLE (`CALSPHERE 1`, epoch `26259.82940569`) / 501 / 501 / 404 — i.e. 6 / 6 as designed.

### 4.3 Live 10-step contract test

- **Key retrieval (`env-pull` mode):** `vercel env pull .env.production.local --environment=production` → refused by the guardrail (exit 126, 2026-09-17T08:12:26Z); additionally `ONDEMAND_API_KEY` is a `sensitive` variable on the project, which Vercel never returns via pull. No file was created; nothing to remove.
- **Proxy mode (forced):** `node scripts/ondemand-contract-test.mjs --mode proxy --proxy-base https://ondemand-eand-spatial-opal.vercel.app/api/ondemand --json-out docs/ondemand-workflows/contract-baseline.json` at 2026-09-17T08:26:10Z (script commit `30791c7`): step 1 `session create + reuse` **FAIL 187 ms** — `proxy route not present at https://ondemand-eand-spatial-opal.vercel.app/api/ondemand (HTTP 404 The page could not be found NOT_FOUND)`; steps 2–9 **SKIP** (`dependency: step 1 failed`); step 10 latency summary PASS; `CONTRACT RESULT: mode=proxy passed=1 failed=1 skipped=8 totalMs=187`, exit 1. **Proxy mode was used because the key cannot be pulled; it could not exercise any contract shape because no OnDemand Spatial deployment is reachable.**
- **Harness self-check (not a baseline):** the same command against the sandbox emulator (`https://sb-307x6fgbxmou.vercel.run/api/ondemand`, no key) at 2026-09-17T08:26:10Z reaches the proxy and fails at step 1 with the proxy's own `HTTP 503 {"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` (275 ms), proving the harness wiring; recorded under `harnessSelfCheck` in `contract-baseline.json`.
- **Gate 1 status:** EXIT BLOCKED — see `docs/audit/gates.md`.

## 5. Selftest run on the sandbox emulator — 2026-09-18T05:47Z (commit 2ed4d78, sandbox sbx_CHYYYEfPHVf9TgYwIrYaHLjqRuiB)

Deploy tier **T2** (the `vercel` CLI is a guardrail shim here — `vercel whoami` exits 126 — so T1/T1-newproject were impossible). The branch runs in a fresh node24 Vercel Sandbox via `npm run dev:serverless` over `dist/` + `api/**`; ONDEMAND_API_KEY (masked `<redacted>`), ONDEMAND_SELFTEST_TOKEN, ONDEMAND_BASE_URL, ONDEMAND_ENDPOINT_ID=predefined-gpt-5.6-luna, ONDEMAND_REASONING_MODE=dynamic, GODS_EYE_FLOW_VERSION=0, VITE_SERVERLESS_MODE=1 were injected as process environment only — no `.env` file exists in the sandbox. `keyPresentAtRuntime: true`. Preview host: `sb-5hfcfkb7a79s.vercel.run`.

| Route | Expected | Actual | UTC | Note |
|---|---|---|---|---|
| `GET /` | 200 | **200** | 2026-09-18T05:47:35Z | SPA shell (Cesium tags present) |
| `GET /api/ondemand/health` | 200 configured | **200** | 2026-09-18T05:47:35Z | `ondemand: healthy, chat: healthy, speech: degraded (by design), media: healthy, workflow: healthy`, `configured: true`, `reasoningModeInvalid: false`; sources: baseUrl←ONDEMAND_BASE_URL, reasoningEndpointId←ONDEMAND_ENDPOINT_ID, fulfillmentEndpointId←ONDEMAND_ENDPOINT_ID, reasoningMode←ONDEMAND_REASONING_MODE (valid), flowVersion←GODS_EYE_FLOW_VERSION, spatialFlowId unset |
| `GET /api/celestrak/active` | 200 TLE | **200** | 2026-09-18T05:47:35Z | legacy provider through `api/[...route].js`; first set: `CALSPHERE 1` / `1 00900U 64063C   26260.93151762  .00000…` |
| `GET /api/ais-live` | 501 | **501** | 2026-09-18T05:47:39Z | `unavailable_in_serverless` (flagged off) |
| `GET /api/realtime/token` | 501 | **501** | 2026-09-18T05:47:39Z | `unavailable_in_serverless` (flagged off) |
| `GET /api/setup/status` | 404 | **404** | 2026-09-18T05:47:39Z | catch-all JSON `Unknown API route` (key panel unmounted) |
| `GET /api/ondemand/selftest (no header)` | 404 (no header) | **404** | 2026-09-18T05:47:39Z | `{"error":"not_found"}` — route invisible without the token |
| `GET /api/ondemand/selftest (with x-selftest-token)` | 200 (token) | **200** | 2026-09-18T05:47:39Z | 10-step JSON: passed 8 / failed 0 / skipped 2 (step 4: account has no agents; step 8: no flow id), ttfd 1,435 ms, durationMs 29,177; sessionIdHash only |
| `GET /api/ondemand/selftest` (repeat 75 s after the previous run started) | 200 (window elapsed) | **200** | 2026-09-18T05:48:54Z | the limiter counts 60 s from the start of the last run, so a second full run was allowed |
| `GET /api/ondemand/selftest` (2nd call 3 s after a run started, 2026-09-18T05:50:26Z) | 429 | **429** | 2026-09-18T05:50:29Z | in-flight/60-s limiter; `Retry-After` header present |

Selftest step table (from the response; saved verbatim with provenance to `docs/ondemand-workflows/contract-baseline.json`):

| # | Step | Status | HTTP | Latency ms | ttfd ms | Note |
|---|---|---|---|---|---|---|
| 1 | session create + reuse | PASS | 200 | 265 | — | sessionId=*** |
| 2 | sync prompt | PASS | 200 | 2453 | — | answer.length=2 |
| 3 | SSE stream | PASS | 200 | 3786 | 1435 | heartbeat=true fulfillmentDeltas=25 timeToFirstDeltaMs=1435 |
| 4 | built-in tool/plugin invocation | SKIP | 200 | 165 | — | no plugin id in env and the account's Agents API listing is empty (GET /plugin/v1/list -> HTTP 200, total=0); no documented chat agent id wa |
| 5 | STT on in-script generated WAV | PASS | 200 | 10840 | — | mediaId=6aacd0827b8af592f50397d2 textLength=0 |
| 6 | TTS | PASS | 200 | 2695 | — | contentType=application/octet-stream bytes=41856 container=mp3 |
| 7 | Media PNG analysis | PASS | 200 | 6998 | — | actionStatus=completed context="The image is a tiny abstract pixel-art or icon-like graphic composed of a tightly packed grid of square pixe |
| 8 | workflow | SKIP | — | 0 | — | ONDEMAND_SPATIAL_FLOW_ID unset on the deployment — auto-skipped by design |
| 9 | session-memory follow-up | PASS | 200 | 1974 | — | answer contains the step-2 code word |
| 10 | latency summary | PASS | — | 0 | — | min=265ms max=10840ms mean=4144ms totalMs=29011 |

Gates before deploy (commit 2ed4d78): `format:check` pass (930 files) · `check:boundaries` pass · `npm test` 4145 tests / 4144 pass / 0 fail / 1 skipped · `test:ondemand` 136/136 · `test:serverless` 30/30 · `vite build` exit 0 · functions under `api/`: 9 (`api/[...route].js` + 8 `api/ondemand/*.js`; `api/ondemand/_config.js` is an underscore helper, not a function).


## 6. Gate 3 row 1 — earthquake.search verification — 2026-09-18T06:13Z (commit 5da207c, sandbox sbx_Fp2WF0A4uY1XmiGmDU3vphQWqtfS)

Preview `sb-pg1bhjba1gcs.vercel.run`; runtime-only env as in §5; function count still 9. Full detail: `docs/audit/gate3-row1-earthquake-verification.md`.

| Check | HTTP | Latency ms | UTC | Note |
|---|---|---|---|---|
| a: `/api/sources/earthquakes?starttime=2026-09-17T06:13:42Z&minmagnitude=4…` | 200 | 296 | 2026-09-18T06:13:42Z | 12 USGS events |
| b: `/api/sources/earthquakes?latitude=25.2&longitude=55.3&maxradiuskm=1500…` | 200 | 342 | 2026-09-18T06:13:42Z | 14 events (Gulf circle) |
| c: `/api/sources/earthquakes?foo=bar` | 400 | 79 | 2026-09-18T06:13:42Z | invalid_query unknown=[foo] |
| d: `/api/ondemand/health` | 200 | 364 | 2026-09-18T06:13:42Z | chat/media/workflow healthy, sources resolved |
| e: `OnDemand sync query (session+query)` | 200 | 7682 | 2026-09-18T06:13:43Z | tool not attachable (NOT FOUND IN LIVE DOCS); context-injected answer cites 10/10 USGS ids |
| f: `/api/ondemand/selftest` | 200 | 29253 | 2026-09-18T06:13:51Z | selftest 8/0/2 unchanged |

## 7. Speech/benchmark/tier release — sandbox verification 2026-09-18T06:59Z (commits e7e049b…fe9aab8, sandbox sbx_wFeQcG8RpJPrVWAvRaD6J9ehJTal)

Tier T2, preview `sb-26l9a6g6k6rt.vercel.run`, `npm run dev:serverless` over `dist/` + `api/**`; runtime-only env: ONDEMAND_API_KEY `[REDACTED]`, ONDEMAND_SELFTEST_TOKEN `[REDACTED]`, ONDEMAND_BASE_URL, GODS_EYE_FLOW_VERSION=0, VITE_SERVERLESS_MODE=1 (no endpoint overrides → TIER_DEFAULTS apply). No `.env` file in the sandbox. Function count 9.

| Check | Expected | HTTP | Latency ms | UTC | Note |
|---|---|---|---|---|---|
| `GET /` | 200 | **200** | 65 | 2026-09-18T06:59:07Z | SPA shell |
| `GET /api/ondemand/health` | 200 | **200** | 2628 | 2026-09-18T06:59:07Z | all five fields **healthy** (speech now probed live), full JSON below |
| `GET /api/celestrak/active` (catch-all) | 200 | **200** | 3485 | 2026-09-18T06:59:09Z | `CALSPHERE 1` / `1 00900U 64063C   26260.931517…` |
| `GET /api/sources/earthquakes?starttime=<now-24h>&minmagnitude=4.5&limit=20` | 200 | **200** | 326 | 2026-09-18T06:59:13Z | 10 events, e.g. `us7000ti83` M4.7, `us7000ti7x` M4.7, `us7000ti79` M4.5 |
| `GET /api/sources/earthquakes?latitude=25.2&longitude=55.3&maxradiuskm=1500&starttime=<now-30d>&minmagnitude=4` | 200 | **200** | 148 | 2026-09-18T06:59:13Z | 14 events |
| `GET /api/ais-live` | 501 | **501** | 65 | 2026-09-18T06:59:13Z | unavailable_in_serverless |
| `GET /api/realtime/token` | 501 | **501** | 55 | 2026-09-18T06:59:13Z | unavailable_in_serverless |
| `GET /api/setup/status` | 404 | **404** | 55 | 2026-09-18T06:59:14Z | catch-all JSON 404 |
| `GET /api/ondemand/selftest` (no header) | 404 | **404** | 66 | 2026-09-18T06:59:14Z | `{"error":"not_found"}` |
| `GET /api/ondemand/selftest` (token) | 200 | **200** | 31208 | 2026-09-18T06:59:45Z | passed 8 / failed 0 / skipped 2 (steps 4 and 8 skipped by account state); SSE ttfd 1815 ms; latency column = durationMs |
| `GET /api/ondemand/selftest` 3 s after a run started | 429 | **429** | 82 | 2026-09-18T06:59:17Z | 429 `rate_limited`, Retry-After 60 |

Full `/api/ondemand/health` JSON (secret-free):

```json
{
  "ondemand": "healthy",
  "chat": "healthy",
  "speech": "healthy",
  "media": "healthy",
  "workflow": "healthy",
  "plugins": {},
  "configured": true,
  "speechProbe": {
    "cached": false,
    "ageSec": 0
  },
  "reasoningModeInvalid": false,
  "config": {
    "tiers": {
      "ASK": {
        "fulfillmentEndpointId": "predefined-gpt-5.6-luna",
        "reasoningMode": "low"
      },
      "INVESTIGATE": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "low"
      },
      "DEEP": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "high"
      }
    },
    "apiKey": {
      "configured": true
    },
    "baseUrl": {
      "configured": true,
      "source": "ONDEMAND_BASE_URL"
    },
    "reasoningEndpointId": {
      "configured": true,
      "source": "default"
    },
    "fulfillmentEndpointId": {
      "configured": true,
      "source": "default"
    },
    "reasoningMode": {
      "configured": false,
      "source": "unset",
      "valid": true
    },
    "flowVersion": {
      "configured": true,
      "source": "GODS_EYE_FLOW_VERSION"
    },
    "spatialFlowId": {
      "configured": false,
      "source": "unset"
    }
  },
  "checkedAt": "2026-09-18T06:59:07.722Z",
  "message": "OnDemand API reachable; chat probe succeeded."
}
```

## 8. Gate 6 — principal workflow created + selftest step 8 live — sandbox verification 2026-09-18T07:31Z (commit aa6fd0c + this gate's commits, sandbox `sbx_DV7Jx2deyh9edv9XkSztio1dws7P`)

Tier T2, preview `https://sb-765981cquksp.vercel.run`, `npm run dev:serverless` over `dist/` + `api/**` (Node v24.14.1; `npm ci` 07:30:43Z, `npm run build` 07:30:53Z–07:31:00Z, server listening 07:31:18Z). Runtime-only env injected into the process: ONDEMAND_API_KEY `****`, ONDEMAND_SELFTEST_TOKEN `****` (one-time), ONDEMAND_BASE_URL, **ONDEMAND_SPATIAL_FLOW_ID=6aace534859f7b0abb53d99a**, **GODS_EYE_FLOW_VERSION=1**, VITE_SERVERLESS_MODE=1, SERVERLESS_MODE=true, HOST/PORT. The only `.env` in the sandbox is the repo's 303-byte non-secret serverless-mode file (no key in it — verified `grep -c ONDEMAND_API_KEY .env` → 0). Function count 9 (unchanged; ≤ 12).

Workflow under test: **`GodsEye Advanced Spatial Workflow` v1, id `6aace534859f7b0abb53d99a`** (recorded at creation; display name changed 2026-09-18T10:41:47Z to "OnDemand Spatial Advanced Workflow", id unchanged), created through the documented `POST /automation/api/workflow/` (201, 2026-09-18T07:16:04.335Z) and activated (200, 07:16:14.101Z) — full record in `docs/ondemand-workflows/README.md` and `docs/ondemand-workflows/verification-2026-09-18.json`.

| Check | Expected | HTTP | Latency ms | UTC | Note |
|---|---|---|---|---|---|
| `GET /` | 200 | **200** | 80 | 2026-09-18T07:31:19Z | SPA shell |
| `GET /api/ondemand/health?envNames=1` | 200 | **200** | 2560 | 2026-09-18T07:31:33Z | all five fields **healthy**; `config.spatialFlowId` `{configured:true, source:"ONDEMAND_SPATIAL_FLOW_ID"}`, `config.flowVersion` `{configured:true, source:"GODS_EYE_FLOW_VERSION"}`; full JSON below |
| `GET /api/ondemand/selftest` (no header) | 404 | **404** | 48 | 2026-09-18T07:32:45Z | `{"error":"not_found"}` |
| `GET /api/ondemand/selftest` (token) — run 1 | 200 | **200** | 44734 | 2026-09-18T07:31:35Z → 07:32:20Z | **passed 9 / failed 0 / skipped 1** (only step 4 — account has no agents); **step 8 PASS**: `executionId=6aace8f487fc428d7c18a1f3 status=executing logEvents=5 timeToFirstLogMs=298 firstLogUtc=2026-09-18T07:32:04.722Z polledMs=13828`; SSE ttfd 1956 ms; latency column = durationMs |
| `GET /api/ondemand/selftest` (token) — run 2 | 200 | **200** | 41777 | 2026-09-18T07:32:45Z → 07:33:27Z | passed 9 / failed 0 / skipped 1 again; step 8 `executionId=6aace938bb6a9a7035f43237 … timeToFirstLogMs=276`; SSE ttfd 1629 ms |
| `GET /api/ondemand/selftest` (token) 10 s after run 2 started | 429 | **429** | 41 | 2026-09-18T07:33:37Z | `{"error":"rate_limited","retryAfterSec":9}`, `Retry-After: 9` |
| `GET /api/sources/earthquakes?latitude=24.433&longitude=54.651&maxradiuskm=500&starttime=<now-30d>&minmagnitude=3` | 200 | **200** | 429 | 2026-09-18T07:33:27Z | `source:"USGS", coverage:"observed", count:0` (no M≥3 event within 500 km of OMAA in the last 30 days) |
| `GET /api/ondemand/workflow?action=status&executionId=6aace8f487fc428d7c18a1f3` (proxy → documented `GET /execution/{id}`) | 200 | **200** | 187 | 2026-09-18T07:33:28Z | `trigger.type:"api"`, `status:"executing"` at that moment |
| `GET /api/ondemand/workflow?action=stream-logs&executionId=…` | 501 | **501** | 53 | 2026-09-18T07:33:28Z | `{"error":"not documented","surface":"stream workflow logs","reference":"§7.1"}` — polling `?action=logs` is the documented surface |
| `GET /api/ais-live` | 501 | **501** | — | 2026-09-18T07:33:28Z | unavailable_in_serverless |
| `GET /api/setup/status` | 404 | **404** | — | 2026-09-18T07:33:28Z | catch-all JSON 404 |

Both selftest-started executions finished after the 12 s polling window — `GET /automation/api/execution/list?workflowID=6aace534859f7b0abb53d99a` at 2026-09-18T07:40:47Z: `6aace8f487fc428d7c18a1f3` **success** 164,464 ms, `6aace938bb6a9a7035f43237` **success** 170,404 ms (and the verification run `6aace54bbb6a9a7035f431fc` success 158,861 ms). The `structured_response` node output of `6aace8f487fc428d7c18a1f3` parsed to exactly the seven keys `message, entities, actions, evidence, sources, suggestedNextActions, runMeta` with actions `fly_to_location, track_entity, annotate_map, set_layer_visibility, frame_overhead, analyst_query` (all among the 28 MapAction names), `runMeta.mode = "selftest"`, `runMeta.intent = "anomaly_scan"`.

`docs/ondemand-workflows/contract-baseline.json` was updated **in place** with run 1 (the previous 8/0/2 baseline moved into `history[]`).

Full `/api/ondemand/health?envNames=1` JSON (secret-free — names only):

```json
{
  "ondemand": "healthy",
  "chat": "healthy",
  "speech": "healthy",
  "media": "healthy",
  "workflow": "healthy",
  "plugins": {},
  "configured": true,
  "speechProbe": {
    "cached": false,
    "ageSec": 0
  },
  "reasoningModeInvalid": false,
  "config": {
    "tiers": {
      "ASK": {
        "fulfillmentEndpointId": "predefined-gpt-5.6-luna",
        "reasoningMode": "low"
      },
      "INVESTIGATE": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "low"
      },
      "DEEP": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "high"
      }
    },
    "apiKey": {
      "configured": true
    },
    "baseUrl": {
      "configured": true,
      "source": "ONDEMAND_BASE_URL"
    },
    "reasoningEndpointId": {
      "configured": true,
      "source": "default"
    },
    "fulfillmentEndpointId": {
      "configured": true,
      "source": "default"
    },
    "reasoningMode": {
      "configured": false,
      "source": "unset",
      "valid": true
    },
    "flowVersion": {
      "configured": true,
      "source": "GODS_EYE_FLOW_VERSION"
    },
    "spatialFlowId": {
      "configured": true,
      "source": "ONDEMAND_SPATIAL_FLOW_ID"
    }
  },
  "checkedAt": "2026-09-18T07:31:33.106Z",
  "message": "OnDemand API reachable; chat probe succeeded.",
  "env": {
    "names": [
      "ONDEMAND_API_KEY",
      "ONDEMAND_BASE_URL",
      "ONDEMAND_SELFTEST_TOKEN",
      "ONDEMAND_SPATIAL_FLOW_ID",
      "SERVERLESS_MODE",
      "VITE_SERVERLESS_MODE"
    ],
    "sources": {
      "apiKey": "ONDEMAND_API_KEY",
      "baseUrl": "ONDEMAND_BASE_URL",
      "reasoningEndpointId": "default",
      "fulfillmentEndpointId": "default",
      "defaultPluginIds": "unset",
      "spatialFlowId": "ONDEMAND_SPATIAL_FLOW_ID",
      "reasoningMode": "unset",
      "flowVersion": "GODS_EYE_FLOW_VERSION",
      "requestTimeoutMs": "default"
    }
  }
}
```

## 9. Runtime verification — emulator (no Vercel deployment possible) — 2026-09-18T09:28Z (commits 881e5a3 / 6dde6d0, sandbox `sbx_OUGpHn0VupD18WFXpWFYqikgdvM1`)

**Label: emulator.** Preview `https://sb-63r5liykgi73.vercel.run`, `npm run dev:serverless` over `dist/` + `api/**` (Node v24.14.1; `npm ci` + `npm run build` 09:27:45Z–09:27:56Z; server up 09:28:11Z). Runtime-only env injected into the process: ONDEMAND_API_KEY `<redacted>`, ONDEMAND_SELFTEST_TOKEN `<redacted>` (fresh random token generated for this run), ONDEMAND_BASE_URL, ONDEMAND_SPATIAL_FLOW_ID=6aace534859f7b0abb53d99a (the repo's name for the flow id; also the built-in default), GODS_EYE_FLOW_VERSION=1, VITE_SERVERLESS_MODE=1, SERVERLESS_MODE=true. The only `.env` in the sandbox is the repo's non-secret serverless-mode file (`grep -c ONDEMAND_API_KEY .env` → 0). Function count 9.

**Why this is not a Vercel function-runtime run.** (1) The credential supplied this turn as `VERCEL_TOKEN` is byte-identical to the OnDemand API key already in use (it authenticates against OnDemand: `GET /plugin/v1/list` → 200 at 09:18:11Z) — it is not a Vercel token, so it was NOT transmitted to `api.vercel.com` or `api.github.com` (sending a live third-party secret to unrelated auth endpoints would only leak it). (2) Independently of the token, this build environment cannot create Vercel deployments: the `vercel` CLI is a guardrail shim (exit 126) and calling the Vercel deployment API from here is off-limits by platform policy. The file-upload flow the task specifies is implemented, ready to run from an operator machine, in `scripts/vercel-file-deploy.mjs` (dry-run verified: 1,312 files, no `.env`, no tests, no docs; `--target production` refused; token from env only, redacted from output). Once a READY preview exists, repeat this table against it and save the selftest as `docs/ondemand-workflows/contract-baseline.vercel.json`.

| Check | Expected | HTTP | Latency | UTC | Note |
|---|---|---|---|---|---|
| `GET /` | 200 | **200** | 57 ms | 2026-09-18T09:28:28.887Z | SPA shell, 59,348 bytes |
| `GET /api/ondemand/health` | 200, chat/media/workflow healthy | **200** | 1,702 ms | 09:28:30.599Z | ondemand/chat/speech/media/workflow all **healthy**; sources: baseUrl←ONDEMAND_BASE_URL, reasoningEndpointId/fulfillmentEndpointId←default, flowVersion←GODS_EYE_FLOW_VERSION, spatialFlowId←ONDEMAND_SPATIAL_FLOW_ID; **leak grep**: full key, its first/last 8 characters and the selftest token absent from every response body |
| `GET /api/ondemand/health?envNames=1` | names only | **200** | 176 ms | 09:28:30.786Z | names: ONDEMAND_API_KEY, ONDEMAND_BASE_URL, ONDEMAND_SELFTEST_TOKEN, ONDEMAND_SPATIAL_FLOW_ID, SERVERLESS_MODE, VITE_SERVERLESS_MODE (no values) |
| `GET /api/celestrak/stations` (catch-all) | 200, real TLE | **200** | 1,073 ms | 09:28:31.870Z | `ISS (ZARYA)` / `1 25544U 98067A   26261.14280998 …` (3,360 bytes) |
| `GET /api/ais-live` | 501 | **501** | 586 ms | 09:28:32.468Z | `unavailable_in_serverless` (AISStream WebSocket relay) |
| `GET /api/realtime/token` | 501 | **501** | 43 ms | 09:28:32.522Z | `unavailable_in_serverless` (voice-realtime) |
| `GET /api/setup/status` (key-setup) | 404 | **404** | 49 ms | 09:28:32.583Z | `{"error":"Unknown API route"}` |
| `GET /api/sources/earthquakes?starttime=<now−24h>&minmagnitude=4.5&limit=50` | 200 | **200** | 338 ms | 09:28:32.933Z | **10 events** (e.g. `us7000ti89` M5.0 07:19Z, `us7000ti83` M4.7, `us7000ti7x` M4.7); USGS generated 09:28:32Z |
| `GET /api/sources/earthquakes?latitude=25.2&longitude=55.3&maxradiuskm=1500&starttime=<now−30d>&minmagnitude=4&limit=100` (Gulf circle) | 200 | **200** | 297 ms | 09:28:33.243Z | **14 events** (e.g. `us7000thr6` M4.7 09-15, `us7000th9l` M4.3, `us7000tg53` M4.3) |
| `GET /api/sources/earthquakes?foo=bar` | 400 | **400** | 46 ms | 09:28:33.300Z | `invalid_query`, `unknown:["foo"]` |
| `GET /api/sources/fires?bbox=51,24,57,27` (row 2, no key on the emulator) | 503 | **503** | 44 ms | 09:28:33.355Z | `{"error":{"code":"not_configured","message":"NASA_FIRMS_MAP_KEY is not configured on the server; …","param":"NASA_FIRMS_MAP_KEY"}}` — structured, no upstream call |
| `GET /api/sources/fires?bbox=…&sensor=x` | 400 | **400** | 41 ms | 09:28:33.407Z | `unknown_param` `sensor` (whitelist lists the eight accepted names) |
| `GET /api/sources/demo/timezone?lat=24.433&lon=54.651` | 200 | **200** | 56 ms | 09:28:33.474Z | `+04:00`, completeness `estimated` |
| `GET /api/ondemand/selftest` (no header) | 404 | **404** | 123 ms | 09:28:33.608Z | `{"error":"not_found"}` |
| `GET /api/ondemand/selftest` (token) | 200, 9 passed | **200** | 45,473 ms | 09:28:46.216Z → 09:29:31.698Z | **passed 9 / failed 0 / skipped 1** (step 4: account has no agents); SSE **time-to-first-delta 1,783 ms** (emulator reference 1,435 ms → +348 ms); step 8 workflow `executionId=6aad046b859f7b0abb53da19`, **time-to-first-log 259 ms** (full-run reference 657 ms → −398 ms; different measurement point, see below); saved as `docs/ondemand-workflows/contract-baseline.emulator.json` |
| `POST /api/ondemand/chat` `mode:"capability-loop"` — "active fires or earthquakes above magnitude 4 in this viewport in the last 7 days?", Gulf bbox 51,24,57,27, tier INVESTIGATE | 200, valid 7-key answer | **200** | 14,838 ms | 09:29:47.515Z | OnDemand selected **earthquake.search** (bbox params, 7-day window) **and fires.search** (bbox, day_range 7) from the 3-entry catalogue; executed both — USGS 200 count 0 (666 ms), FIRMS **503 not_configured** (no key); answer valid, sources `used` / `failed`, message states the fire check could not be completed; latencies session 205 / decision 3,381 / execute 666 / answer 10,353 ms; session id hashed |

**ttfd / ttfl notes.** Time-to-first-delta is step 3's first `fulfillment` SSE chunk (1,783 ms here vs 1,435 ms reference — same endpoint `predefined-gpt-5.6-luna`, run-to-run variance). Time-to-first-log in the selftest is the first `GET /execution/{id}/logs` poll that returns ≥ 1 event after `execute` (259 ms), whereas the 657 ms reference was measured by the CLI verification run of 07:16Z with a 4 s poll interval — both show the workflow starts within the first second; the ~163 s end-to-end duration is unchanged by design.

Full `/api/ondemand/health` JSON (secret-free):

```json
{
  "ondemand": "healthy",
  "chat": "healthy",
  "speech": "healthy",
  "media": "healthy",
  "workflow": "healthy",
  "plugins": {},
  "configured": true,
  "speechProbe": {
    "cached": false,
    "ageSec": 0
  },
  "reasoningModeInvalid": false,
  "config": {
    "tiers": {
      "ASK": {
        "fulfillmentEndpointId": "predefined-gpt-5.6-luna",
        "reasoningMode": "low"
      },
      "INVESTIGATE": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "low"
      },
      "DEEP": {
        "fulfillmentEndpointId": "predefined-claude-sonnet-5",
        "reasoningMode": "high"
      }
    },
    "apiKey": {
      "configured": true
    },
    "baseUrl": {
      "configured": true,
      "source": "ONDEMAND_BASE_URL"
    },
    "reasoningEndpointId": {
      "configured": true,
      "source": "default"
    },
    "fulfillmentEndpointId": {
      "configured": true,
      "source": "default"
    },
    "reasoningMode": {
      "configured": false,
      "source": "unset",
      "valid": true
    },
    "flowVersion": {
      "configured": true,
      "source": "GODS_EYE_FLOW_VERSION"
    },
    "spatialFlowId": {
      "configured": true,
      "source": "ONDEMAND_SPATIAL_FLOW_ID"
    }
  },
  "checkedAt": "2026-09-18T09:28:28.944Z",
  "message": "OnDemand API reachable; chat probe succeeded."
}
```

## Step 5 — plugin-verified Vercel evidence (2026-09-18)

Evidence supplied by the operator's Vercel-API tooling (`getVercelProject` / `listVercelDeployments` / `listVercelEnvVars`) on 2026-09-18 and recorded here verbatim; it was not re-queried from this build environment (which has no Vercel API access — see §9). Env-var **ids** below are Vercel metadata identifiers, not values; no secret value appears anywhere in this repository.

### Project

| Field | Value |
|---|---|
| Project | `ondemand-eand-spatial` — id `prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO` |
| Team | `schoolhack-web-team` (`team_aft8hHPiYnHp6I534L3DQScA`) |
| Framework / plan | vite / pro |
| Git link | `mk42-ai/ondemand-eand-spatial` (repoId 1366177817), production branch `main` |
| Project `updatedAt` | 1789710821256 |
| Custom domain | `ondemand-eand-spatial-opal.vercel.app` (verified, bound to branch `feat/exec-brief-v1.4-b7c0d3d`) |

### Deployments

| Deployment | State | URL / aliases | Git | Timestamps | Notes |
|---|---|---|---|---|---|
| Latest READY (preview target, **not** the `ondemand-serverless` branch) — `dpl_FKoHEVctqpLzNMaHV9sSRdmzcrw6` | READY (readySubstate STAGED) | `https://ondemand-eand-spatial-rnbt5ofc8-schoolhack-web-team.vercel.app`; alias `ondemand-eand-spatial-opal.vercel.app` | branch `feat/exec-brief-v1.4-b7c0d3d`, commit `b8cdcf501aa77ada93dde682a8c6fec35f9c5637` ("exec-brief v1.4.0 verification record") | createdAt 1789187529848 · buildingAt 1789187530783 · readyAt 1789187562890 | inspector `https://vercel.com/schoolhack-web-team/ondemand-eand-spatial/FKoHEVctqpLzNMaHV9sSRdmzcrw6`; lambdaRuntimeStats `nodejs: 2`; no build-error lines |
| Production — `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9` | **BLOCKED** | `https://ondemand-eand-spatial-gk1p1ydur-schoolhack-web-team.vercel.app`; aliases `ondemand-eand-spatial-schoolhack-web-team.vercel.app`, `ondemand-eand-spatial-git-main-schoolhack-web-team.vercel.app` | commit `e799775a9815c96519a01635c8eb014ae6ae02dc` ("fix build issue") | createdAt 1789137161396 | — |

**Blocked git-source deployments (9 ids listed by the tooling):** `dpl_X8MPQiEK1HdAghFDVJH1gwehjRFQ`, `dpl_41r6CgA19C4yDrF1TCw2FZvAD1Jf`, `dpl_CDVGparwS9NXHQnXvzMRSSrsRrBG`, `dpl_hmqPU37q4FMfB562ZvvX9t2D6cgr`, `dpl_3mhR1kgtKDG69iWqas6Yeha3MSVF`, `dpl_9wiV2ZGRG45DeYNoik5YKGm8FNQh`, `dpl_9UNerDejHsnkhdsENmsctmP43xa7`, `dpl_A45jP8NVJX6mHFcB888CZrT45TvP`, `dpl_BRY8mZjS5dxwHzGbTjk8GhRHKsNb` — all BLOCKED with `errorMessage: "The deployment was blocked because Vercel couldn't find a Git account for the commit author."` (commit author `goose-live-build@users.noreply.github.com`). No build-error lines exist for the READY deployments. A deployment listing filtered to the `ondemand-serverless` branch returned **0 deployments (total 0)** — i.e. **no real Vercel function-runtime deployment of this branch exists yet.**

### Environment variables (19 total; ids are Vercel metadata, values never read)

| Variable | Type | Env id | Note |
|---|---|---|---|
| `GODS_EYE_FLOW_VERSION` | plain | `usC3wgbut65gTkaR` | created this pass (production + preview, createdAt ≈ 1789710821). Since the 2026-09-18 rebrand this name is the accepted **alias** of the canonical `ONDEMAND_SPATIAL_FLOW_VERSION`; resolution is alias-first (alias → canonical → default `'1'`) precisely so this provisioned value keeps winning without any Vercel change — `/api/ondemand/health` then reports `config.flowVersion.source: "GODS_EYE_FLOW_VERSION"`, `resolvedVia: "alias"`, plus `canonical` / `alias`. The recorded health payloads above (`source: "GODS_EYE_FLOW_VERSION"`) predate the `resolvedVia` field. |
| `ONDEMAND_REASONING_ENDPOINT_ID` | sensitive | `I0TXIH0rgSDwzEJB` | created this pass |
| `ONDEMAND_FULFILLMENT_ENDPOINT_ID` | sensitive | `tdtHQKHrAMllvoir` | created this pass |
| `ONDEMAND_SELFTEST_TOKEN` | sensitive | `NGrV0CvtudZY76Yj` | created this pass |
| `VITE_SERVERLESS_MODE` | — | `jJi4gru0prYHBRJ9` | pre-existing |
| `ONDEMAND_BASE_URL` | — | `yMQQNn22fENoPDsY` | pre-existing |
| `ASK_ENABLED` | — | `gRQF3MguQvx3Cxqy` | pre-existing |
| `ONDEMAND_API_KEY` | sensitive | `wNMsI3sIbGdQb59Y` | pre-existing — see the SECURITY note in `docs/audit/RUN-REPORT.md` (rotation) |
| `CI` | — | `dTOvEUiy7hhAck00` | pre-existing |
| `ONDEMAND_API_BASE`, `ONDEMAND_ENDPOINT_ID`, `ONDEMAND_REASONING_MODE` | — | — | pre-existing; accepted by this branch as documented aliases / canonical names (`docs/ONDEMAND_PROXY_DESIGN.md` §10) |
| `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` | — | — | pre-existing; **denied alias** on this branch (never read — `server/ondemand/config.js` deny-list) |
| `ASK_THE_DEAL_ALLOWED_ORIGIN`, `DOC_*` URLs | — | — | pre-existing; belong to the exec-brief app, unused by this branch |
| `ELEVENLABS_API_KEY` | sensitive | `eazEtCde0VLgUCIO` | pre-existing; **flagged — deny-listed by this branch (never read, never forwarded); recommend removal from the project** |

### Conclusion

**Stable deployment URL for the `ondemand-serverless` branch = NONE.** The sandbox previews (`sb-5hfcfkb7a79s.vercel.run`, `sb-pg1bhjba1gcs.vercel.run`, and this session's later `sb-26l9a6g6k6rt`, `sb-765981cquksp`, `sb-63r5liykgi73`) are ephemeral emulator previews. Consequently `src/registry/capabilities.json` keeps `endpoint_url: null` for the Seismic (`earthquake.search` / tool `earthquake_search`) and Fires (`fires.search` / tool `fire_detection_search`) rows, with `endpoint_url_pending_reason: "no stable Vercel function-runtime deployment of ondemand-serverless yet"` and the relative `endpoint_path` (`/api/sources/earthquakes`, `/api/sources/fires`) recorded instead; the dashboard registration (`docs/audit/gate3-row1-registration.md`) must wait for a READY deployment of this branch (`scripts/vercel-file-deploy.mjs` from an operator machine, §9).
