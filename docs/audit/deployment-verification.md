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
