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
| 2026-09-17T07:09:50Z | GET | `/api/celestrak/active` | 200 | text/plain | `CALSPHERE 1              1 00900U 64063C   26259.82940569  .00000472  00000+0  47004-3 0  9995 2 00900  90.2178  73.8919 0026477  19.3115  86.8850 13.76705816` |
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
