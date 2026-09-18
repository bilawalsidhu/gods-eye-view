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
| Does it serve `/api/ondemand/health`? | **No.** `GET /api/ondemand/health` → 404 `text/plain`, `x-vercel-error: NOT_FOUND` (2026-09-17T08:09:46Z). The host serves a different Vite application (`<html lang="en" data-theme="light">`, no Cesium assets). **It is not the God's Eye serverless build.** |
| `vercel deploy` of the branch | not run — `vercel link` / `vercel deploy` / `vercel env pull` are refused by the environment guardrail (`vercel: BLOCKED by platform policy — the Vercel CLI is not available in this environment`, exit 126, 2026-09-17T08:12:26Z); no `.vercel/` or `.env.production.local` was created |

### 4.2 Production smoke matrix — `https://ondemand-eand-spatial-opal.vercel.app` (deployment `dpl_FKoHEVctqpLzNMaHV9sSRdmzcrw6`)

| Route | Expected (God's Eye build) | Actual status | UTC | Note |
|---|---|---|---|---|
| `GET /` | 200 | **200** `text/html` | 2026-09-17T08:12:13Z | a different application (exec-brief app), not `index.html` of this repo |
| `GET /api/ondemand/health` | 200, configured/healthy | **404** `text/plain` | 2026-09-17T08:12:13Z | Vercel platform `NOT_FOUND` — route does not exist on this deployment; no env-var finding can be derived because the God's Eye functions are not deployed here |
| `GET /api/celestrak/active` (legacy provider via catch-all) | 200 + ≥1 three-line TLE set | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` — no TLE data; assertion not evaluable |
| `GET /api/ais-live` | 501 | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` |
| `GET /api/realtime/token` | 501 | **404** | 2026-09-17T08:12:14Z | `NOT_FOUND` |
| `GET /api/setup/status` | 404 (JSON `Unknown API route`) | **404** `text/plain` | 2026-09-17T08:12:14Z | Vercel `NOT_FOUND`, not the catch-all's JSON 404 |

**Conclusion:** 0 / 6 expectations of the God's Eye build are met on `finalProductionUrl` because the branch is not deployed there. The same matrix against the previous turn's ephemeral sandbox running this branch (`https://sb-307x6fgbxmou.vercel.run`, evidence only, not a Vercel function runtime) at 2026-09-17T08:12:14Z gave 200 / 200 (all `not configured`, no key) / 200 with TLE (`CALSPHERE 1`, epoch `26259.82940569`) / 501 / 501 / 404 — i.e. 6 / 6 as designed.

### 4.3 Live 10-step contract test

- **Key retrieval (`env-pull` mode):** `vercel env pull .env.production.local --environment=production` → refused by the guardrail (exit 126, 2026-09-17T08:12:26Z); additionally `ONDEMAND_API_KEY` is a `sensitive` variable on the project, which Vercel never returns via pull. No file was created; nothing to remove.
- **Proxy mode (forced):** `node scripts/ondemand-contract-test.mjs --mode proxy --proxy-base https://ondemand-eand-spatial-opal.vercel.app/api/ondemand --json-out docs/ondemand-workflows/contract-baseline.json` at 2026-09-17T08:26:10Z (script commit `30791c7`): step 1 `session create + reuse` **FAIL 187 ms** — `proxy route not present at https://ondemand-eand-spatial-opal.vercel.app/api/ondemand (HTTP 404 The page could not be found NOT_FOUND)`; steps 2–9 **SKIP** (`dependency: step 1 failed`); step 10 latency summary PASS; `CONTRACT RESULT: mode=proxy passed=1 failed=1 skipped=8 totalMs=187`, exit 1. **Proxy mode was used because the key cannot be pulled; it could not exercise any contract shape because no God's Eye deployment is reachable.**
- **Harness self-check (not a baseline):** the same command against the sandbox emulator (`https://sb-307x6fgbxmou.vercel.run/api/ondemand`, no key) at 2026-09-17T08:26:10Z reaches the proxy and fails at step 1 with the proxy's own `HTTP 503 {"error":"not_configured","message":"ONDEMAND_API_KEY is not set on the server."}` (275 ms), proving the harness wiring; recorded under `harnessSelfCheck` in `contract-baseline.json`.
- **Gate 1 status:** EXIT BLOCKED — see `docs/audit/gates.md`.

## 5. Selftest run on the sandbox emulator — 2026-09-18T05:47Z (commit 2ed4d78, sandbox sbx_CHYYYEfPHVf9TgYwIrYaHLjqRuiB)

Deploy tier **T2** (the `vercel` CLI is a guardrail shim here — `vercel whoami` exits 126 — so T1/T1-newproject were impossible). The branch runs in a fresh node24 Vercel Sandbox via `npm run dev:serverless` over `dist/` + `api/**`; ONDEMAND_API_KEY (masked `G7Gg…VjnL`), ONDEMAND_SELFTEST_TOKEN, ONDEMAND_BASE_URL, ONDEMAND_ENDPOINT_ID=predefined-gpt-5.6-luna, ONDEMAND_REASONING_MODE=dynamic, GODS_EYE_FLOW_VERSION=0, VITE_SERVERLESS_MODE=1 were injected as process environment only — no `.env` file exists in the sandbox. `keyPresentAtRuntime: true`. Preview host: `sb-5hfcfkb7a79s.vercel.run`.

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

