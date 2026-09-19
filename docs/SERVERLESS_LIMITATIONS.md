# Serverless deployment: architecture, limitations, and verification

**Written:** 2026-09-17T06:28Z (start of this work) — 2026-09-17T07:xxZ (verification), audited commit `0d41b6be5490db1f10a171f238be75db4d4ec3b4` (branch `ondemand-serverless`).

This document covers the conversion of this repo's Vite dev-server provider
routes (`server/providers/**`) to a Vercel Serverless Function
(`api/[...route].js`). It is owned by the "serverless route conversion" work;
OnDemand-proxy-specific design (the 7 `api/ondemand/*.js` functions and
`server/ondemand/**`) is documented separately in
[`docs/ONDEMAND_PROXY_DESIGN.md`](./ONDEMAND_PROXY_DESIGN.md) — see §8.

## 1. Scope and files

| Path | What it is |
| --- | --- |
| `server/serverless/router.js` | Dependency-free Connect-mount-semantics router |
| `server/serverless/router.test.mjs` | Unit tests for the router |
| `server/serverless/app.js` | Builds the router from `localProviderPlugins()`, applies serverless guards |
| `server/serverless/app.test.mjs` | Integration tests for the guards / skip-list |
| `server/serverless/vercel-adapter.js` | Vercel `req`/`req.body` → plain-Node `req` bridging |
| `server/serverless/vercel-adapter.test.mjs` | Unit tests for the adapter |
| `server/serverless/dev-server.mjs` | Local Vercel-like static + `/api/*` emulator |
| `api/[...route].js` | The one Vercel Serverless Function |
| `vercel.json` | Deployment configuration |

## 2. Architecture of the conversion

**Why one catch-all function reusing the existing middleware code.** This
repo has no Express: `server/providers/local.js`'s `localProviderPlugins()`
returns 22 Vite plugin objects, each a thin `configureServer(server) {
server.middlewares.use('/api/<mount>', handler) }` wrapper around a plain
Node `(req, res)` (or `(req, res, next)`) handler. Those handlers are the
actual product logic (upstream fetch shaping, disk/memory caching, retry and
credit-governor policy) — converting them would mean re-implementing and
re-testing every one. Instead, `server/serverless/router.js` reimplements
just the ~130 lines of Connect `app.use`/`app.handle` mount semantics
(verified against the real implementation vendored inside Vite itself —
`node_modules/vite/dist/node/chunks/dep-*.js`, functions `proto.use` /
`proto.handle` / `call`) as a plain object with the same
`{ use(path, fn), handle(req, res, done) }` shape Vite's `server.middlewares`
exposes. `server/serverless/app.js` then calls the SAME
`plugin.configureServer({ middlewares: router, ... })` Vite would have
called, mounting the identical handler code, unmodified, with the identical
public paths and the identical `process.env.*` names. Zero duplication of
provider logic; the router is the only new "server" concept.

**Function count.** 1 catch-all (`api/[...route].js`) + 7 OnDemand functions
(`api/ondemand/{sessions,chat,media,stt,tts,workflow,health}.js`, owned by the
OnDemand-proxy work) = **8 Serverless Functions, ≤ 12** (Vercel Hobby plan
limit). Confirmed via `find api -name '*.js' | sort` at the end of this work
(see the final reply for the exact listing).

**Filesystem router + SPA fallback interaction.** Vercel matches static
output (`dist/**`, built by `vite build`) and Serverless Functions (anything
under `api/`) BEFORE evaluating `rewrites`. `vercel.json`'s only rewrite is
the SPA fallback `{"source": "/((?!api/).*)", "destination": "/index.html"}`
— a negative lookahead that excludes `/api/*`, so an unmatched `/api/*`
request is never silently rewritten to `index.html`; it reaches
`api/[...route].js`, which (via the not-found layer, §2 below) answers the
same `{"error":"Unknown API route"}` JSON the Vite dev server always has.

**Request flow.** `api/[...route].js` → `resolveRequestUrl(req)`
(`server/serverless/vercel-adapter.js`, prefers the real `req.url`, falls
back to Vercel's `req.query.route` catch-all segments) → `rehydrateBody(req)`
(replays an already-Vercel-parsed body back through the async-iterator and
`.on('data'/'end')` reading styles `server/providers/common/request.js`
uses) → `getServerlessApi()` (memoised singleton — a warm function instance
reuses the same constructed router across invocations) → `router.handle(req,
res)`, which walks the same plugin mounts, in the same order, as
`server/standalone/vite.config.js`.

## 3. Feature-flagged OFF in serverless

Two provider mounts are answered with a guard (`501
{"error":"unavailable_in_serverless", "feature", "message"}`) BEFORE the real
provider layer, only when serverless mode is active
(`server/serverless/app.js`); one is answered with a silent no-op. The
corresponding client code (§6) never calls the guarded endpoints in a
serverless build, so these guards are a safety net, not the primary
mechanism.

| Route | Why disabled here | What a non-serverless host needs |
| --- | --- | --- |
| `/api/ais-live` (+ `/track`) | **Superseded 2026-09-18 — no longer disabled.** The persistent relay `server/providers/vessels/ais-live.js` (`aisLiveProxy()`) is still never mounted in serverless mode for the reasons that follow — its `configureServer()` starts an (unref'd) `setInterval` whose tick opens a persistent outbound WebSocket to `wss://stream.aisstream.io` and AISStream allows only ONE connection per key. In its place `server/serverless/app.js` mounts `server/providers/vessels/ais-serverless.js` (`aisServerlessProxy()`): each poll of `/api/ais-live?bbox=lamin,lomin,lamax,lomax` runs ONE bounded collection (WebSocket open ≤ `AISSTREAM_COLLECT_MS`, default 8 s, closed early after `AISSTREAM_COLLECT_QUIET_MS` of silence), caches the snapshot per 0.25° box in memory (+ Vercel KV / Upstash REST when configured) and behind the edge (`s-maxage=30`), and answers `200` with a structured status: `live`, `stale` (last-good), `degraded` (AISHub / demo replay when `AISSTREAM_API_KEY` is absent), `empty` ("No vessels in scene"). See docs/MOVEMENT-LAYERS.md. | A long-running Node process still gives the richer persistent relay (`npm run dev`); the serverless collector is the documented alternative, not a workaround. |
| `/api/realtime/token` | `server/providers/openai/realtime.js` mints a short-lived OpenAI Realtime **client secret** using `OPENAI_API_KEY`. This is disabled here as a deliberate choice, not a technical impossibility — the mint call itself is a normal HTTPS POST a Function can make — but the surrounding session model (voice turn-taking, radio ducking, cost governors in `src/voice/*`) assumes a persistent per-user session and this conversion's job was route parity, not redesigning that. Disabling it server-side (and never calling it client-side, §6) means this deployment never mints a client secret at all. | The key server-side (as here) plus a host that can run the full voice session lifecycle the way the dev server does. |
| `/api/realtime/debug-log` | `server/providers/openai/debug-log.js` appends JSONL under `${sourceRoot}/.gev-logs`, where `sourceRoot` defaults to `defaultSourceRoot` (the deployed bundle directory, e.g. `/var/task` — see §5), which is read-only on Vercel. Answered as a silent `204` no-op rather than `501`, because it is a best-effort diagnostics sink the client only calls from within a connected Realtime session — which never starts under the client-side guard (§6) — so a residual call should not surface as a console error for a purely cosmetic log line. | Any writable disk (or swap it for a real log sink). |
| `/api/setup/*` (`gev-key-setup`) | Not guarded with a 501 — never mounted at all, in ANY mode (see `SKIP_ALWAYS` in `app.js`). `keySetupEndpoint()` (`server/standalone/key-setup.js`) validates and writes credentials into the checkout's `.env` / `pinokio/ENVIRONMENT` and calls `server.restart()`; both actions are meaningless once this is not a real Vite dev server, and the write target is read-only on Vercel regardless. `GET /api/setup/status` therefore falls through to the same "Unknown API route" 404 every unrecognized path gets, which is exactly the signal `src/keySetup.js` already uses to remove the whole in-app "POWER UP" panel (it was already dev-server-only and loopback-gated; see that file's own comment). | Configure provider keys as Vercel Environment Variables (§6) — there is no in-app substitute. |

## 4. Degraded-but-working behaviours

- **Per-instance memory caches.** Every provider's in-memory `Map`/cache
  (OpenSky snapshot cache, CelesTrak TLE cache, TomTom tile/budget counters,
  Overpass response cache, etc.) lives on the constructed router, which is
  memoised per warm function instance (`getServerlessApi()`). A cold start
  (or a different concurrent instance) starts with an empty cache; there is
  no cross-instance sharing.
- **`.gev-cache` redirected to the OS temp dir.** Several providers persist
  their cache to `path.join(process.cwd(), '.gev-cache', ...)`
  (`terrain.js`, `traffic.js`, `firms.js`, `space/celestrak.js`,
  `space/launch-library.js`, `aircraft/enrichment.js`) — some of these paths
  are literally top-level `const`s evaluated at MODULE IMPORT time
  (`server/providers/overpass/constants.js`'s `OVERPASS_DISK_DIR`,
  `server/providers/military-installations/constants.js`'s
  `MILITARY_INSTALLATION_DISK_DIR`), not inside their factory function.
  Vercel's function filesystem is read-only outside `/tmp`, so
  `server/serverless/app.js` calls `process.chdir(os.tmpdir())` once, in
  serverless mode, BEFORE dynamically `import()`-ing `../providers/local.js`
  — a *dynamic* import specifically because a static one would be hoisted
  and evaluated before the chdir runs (see the long comment in `app.js`).
  The cache then persists only for the lifetime of that (possibly frozen,
  possibly reused) `/tmp`, i.e. no better than the in-memory cache in
  practice, but no worse either — every provider already treats its disk
  cache as a best-effort accelerant with try/catch around every write.
- **Background timers survive only a warm instance's lifetime.**
  `terrain.js` and `aircraft/enrichment.js` each lazily start an unref'd
  15s cache-flush `setInterval` on first request (safe: never keeps a
  function instance artificially alive). `src/sources/transitService.js`'s
  `createTransitHistory()` — constructed eagerly inside `transitProxy()`,
  i.e. the moment `localProviderPlugins()` builds the plugin array,
  independent of any request — starts an unref'd 60s sweep interval
  (`src/sources/transitHistoryStore.js`). Both are harmless (unref'd: they
  never block a function from completing or freezing) but neither
  accomplishes anything once the instance is frozen or recycled; documented
  here rather than "fixed" because the task's own guidance is that
  unref'd construction-time timers are allowed, just worth calling out.
- **Cold-start latency.** The first request on a fresh instance pays for
  dynamically importing the entire `server/providers/**` graph (constructing
  all 22 plugins) plus, in serverless mode, one `process.chdir`. Subsequent
  requests on the same warm instance reuse `getServerlessApi()`'s memoised
  result.
- **`maxDuration: 60` and `/api/radio`.** Checked
  `server/providers/radio/catalog.js`: `/api/radio` proxies only station
  *discovery* metadata (`GET /stations`, `POST /click/:id` for click-through
  stats) — actual audio playback is a direct browser fetch of the station's
  own `streamUrl` (`src/layers/radio/playback.js`'s `new Audio()`), never
  proxied through this API. `maxDuration` therefore does not affect radio
  playback; the 60s ceiling only bounds this deployment's slowest real
  upstream calls (CelesTrak/Overpass/military-installations retries, the
  batched terrain-heights proxy).
- **Per-instance budget/credit governors.** TomTom's daily tile-budget
  counter (`traffic.js`) and OpenSky's credit governor both live in the same
  per-instance memory (backed by the same redirected `.gev-cache`), so the
  "daily budget" is really "this instance's view of the daily budget" —
  multiple concurrent instances each track their own.

## 5. Vercel config decisions (`vercel.json`)

- **`framework: null`.** Every relevant setting (`buildCommand`,
  `installCommand`, `outputDirectory`, `rewrites`, `headers`, `functions`) is
  specified explicitly, so the Vite zero-config preset has nothing useful
  left to contribute — and letting it guess would risk stacking an
  auto-added SPA rewrite or asset-caching header on top of the ones this
  file already sets, or auto-detecting a different output directory. `null`
  ("Other") is Vercel's explicit "take no framework-specific action" preset.
- **`installCommand: "PUPPETEER_SKIP_DOWNLOAD=1 npm ci"`.** `puppeteer` is a
  `devDependency` (used by `scripts/qa-*.mjs` browser QA scripts, never by
  the build or the serverless function); its Chromium download is multi-
  hundred MB and irrelevant to `vite build`. Skipping it materially speeds
  up `npm ci` and avoids a build-time dependency on being able to reach
  Chromium's download host at all.
- **Two non-overlapping `functions` patterns**: `functions["api/*.js"]` (`maxDuration: 60` + `includeFiles`) matches only the catch-all, and `functions["api/ondemand/*.js"]` (`maxDuration: 60`) matches the 7 OnDemand functions — overlapping globs were avoided so no function receives two conflicting configs. **`functions["api/*.js"].includeFiles`**
  narrows to just this directory's top-level file (today, only
  `api/[...route].js`) for the `includeFiles` override. `api/*.js` was
  chosen over the literal `api/[...route].js` deliberately: `[...]` is glob
  character-class syntax, so a literal, unescaped `api/[...route].js` key is
  a well-known Vercel gotcha that can silently fail to match the actual file
  (the character class `[...route]` — dot dot dot r o u t e — is not the
  same thing as the six literal characters `[...route]`). `api/*.js` matches
  the SAME single file today (nothing else sits directly under `api/`; the
  OnDemand functions are one level deeper, under `api/ondemand/`) without
  relying on bracket-escaping semantics that are easy to get subtly wrong
  and hard to notice failing (the function would still deploy and work for
  every OTHER route; only the cctv/military-installations config reads would
  break, at runtime, in production).
- **`includeFiles: "{config/**,src/data/local_data/cctv_ground_heights/**}"`.**
  Node File Trace statically bundles files reached via `import`, but not
  files read with `fs.readFileSync`/`fs.readFile` at a runtime-computed path
  — grepping `server/providers/{cctv,military-installations,regional,radio}/*`
  and `src/sources/*` for `readFileSync|readFile(` found exactly:
  - `server/providers/cctv/catalog.js` (`loadSourcesFromFile`, default
    `config/cctv_sources.austin.json`) and `server/providers/cctv/sources.js`
    (Tallinn/Warendorf loaders, `config/cctv_sources.{tallinn,warendorf}.json`
    — both live packs are ON by default; see `envEnabled()`'s `!== '0'`
    default in `cctv/catalog.js`) → covered by `config/**` (192 KB total,
    including the currently-unreferenced-by-name `cctv_sources.shinjuku.json`
    — included anyway since it is cheap and `CCTV_SOURCES_FILE` can point at
    it).
  - `server/providers/cctv/groundHeights.js` (`loadGroundHeights`, default
    `src/data/local_data/cctv_ground_heights/cctv_ground_heights.json`) →
    covered by `src/data/local_data/cctv_ground_heights/**` (2.0 MB).
  - `server/providers/military-installations/cache.js` reads from
    `.gev-cache/military-installations` — a RUNTIME-WRITTEN cache directory,
    not a shipped fixture; nothing to include.
  - `server/providers/regional/*` and `server/providers/radio/*` and
    `src/sources/*`: no `fs.readFileSync`/`readFile(` calls at all.

  Deliberately NOT included: the REST of `src/data/local_data/**`
  (`natural_earth/`, `neighborhoods/`, `dams/`, `datacenters/`,
  `telegeography_submarine_cables/` — ~7.6 MB). Confirmed by grep that these
  are all reached via `import(...)` with a literal JSON-module specifier
  from BROWSER-side modules (`src/data/naturalEarthRegions.js`,
  `src/data/neighborhoodPolygons.js`,
  `src/layers/submarineCables/bundledSource.js`) — Vite bundles them into
  the CLIENT build already; no server code reads them, so shipping them into
  the Function bundle too would just be ~7.6 MB of dead weight.
- **`rewrites`.** Only the SPA fallback, with a negative lookahead
  (`/((?!api/).*)`) so it can never shadow `/api/*` — see §2. No
  self-rewrite for `/api/*` is needed or added: Vercel's filesystem router
  already sends those paths to `api/[...route].js` directly.
- **`headers`.** `/` and `/index.html` get `X-Frame-Options: DENY` and
  `Content-Security-Policy: frame-ancestors 'none'`, reproducing
  `build/vite.js`'s dev-server `server.headers` (comment there: "these
  headers protect the document containing Provider Settings"). `/assets/(.*)`
  and `/cesium/(.*)` get `Cache-Control: public, max-age=31536000, immutable`
  — both directories are Vite/vite-plugin-cesium content-hashed build output,
  safe to cache forever.

## 6. Env var handling

Every provider API key (`OPENSKY_CLIENT_ID`/`SECRET`, `TOMTOM_API_KEY`,
`FIRMS_MAP_KEY`, `AISSTREAM_API_KEY`, `OPENAI_API_KEY`, `LL2_API_TOKEN`,
`GOOGLE_MAPS_SERVER_API_KEY`, etc.) stays exactly where it already was: read
server-side from `process.env` inside the unmodified provider handler code.
None of them are ever sent to the browser. The one new **client-visible**
flag is `VITE_SERVERLESS_MODE` — a Vite **build-time** define
(`import.meta.env.VITE_SERVERLESS_MODE`), so it must be set as a Vercel
**Build & Development** Environment Variable (available during
`buildCommand`), not only at runtime, or the shipped client bundle will not
know it is a serverless build. Server-side, the equivalent check
(`server/serverless/app.js`) accepts either `VITE_SERVERLESS_MODE=true`,
`SERVERLESS_MODE=true`, or simply running under Vercel at all
(`process.env.VERCEL` is set by the platform itself) — so the guards in §3
are active on Vercel with zero extra configuration even if
`VITE_SERVERLESS_MODE` is left unset for the build (only the client-side
banner/gating in §7 of this file — really §4 client wiring — depends on the
build-time flag specifically).

The dev-only key-setup panel (`/api/setup/*`, §3) is absent in this
deployment; **provider keys must be configured as Vercel Environment
Variables** instead of through that in-app panel.

## 7. Local emulator verification

Verified against `server/serverless/dev-server.mjs` (no real Vercel
deployment is part of this task) after `npm run build`, started as:

```
PORT=3011 VITE_SERVERLESS_MODE=true node server/serverless/dev-server.mjs
```

| Time (UTC) | Request | Status | Body (first ~200 chars) |
| --- | --- | --- | --- |
| 06:56:35Z | `GET /` | 200 | `<!DOCTYPE html>...` (index.html) |
| 06:56:35Z | `GET /assets/egm96-universal.esm-*.js` | 200 | minified JS |
| 06:56:35Z | `GET /cesium/Workers/transcodeKTX2.js` | 200 | Cesium worker source |
| 06:56:35Z | `GET /api/firms/status` | 200 | `{"hasKey":false,"lastFetch":null,"count":null,"stale":false,"ttlMs":1800000,"transactions":null}` |
| 06:56:35Z | `GET /api/tomtom/status` | 200 | `{"hasKey":false,"dailyCount":0,"budget":40000,"date":"2026-09-17"}` |
| 06:56:35Z | `GET /api/celestrak/active` | 200 | real TLE text (`CALSPHERE 1 ...`) — outbound network was reachable in this environment |
| 06:56:38Z | `GET /api/ais-live` | 501 | `{"error":"unavailable_in_serverless",…}` — **historical (2026-09-17)**; since 2026-09-18 this route answers 200 through the bounded collector (docs/MOVEMENT-LAYERS.md) |
| 06:56:38Z | `GET /api/realtime/token` | 501 | `{"error":"unavailable_in_serverless","feature":"voice-realtime","message":"Voice control (OpenAI Realtime ephemeral session) is unavailable in the serverless deployment"}` |
| 06:56:38Z | `GET /api/setup/status` | 404 | `{"error":"Unknown API route"}` |
| 06:56:38Z | `GET /api/does-not-exist` | 404 | `{"error":"Unknown API route"}` |
| 06:56:38Z | `GET /some/spa/route` | 200 | `<!DOCTYPE html>...` (SPA fallback → index.html) |
| 06:56:38Z | `GET /api/ondemand/health` | 200 | `{"ondemand":"not configured",...,"configured":false,"checkedAt":"2026-09-17T06:56:38...` — resolved via the literal-file precedence over the catch-all; whatever the OnDemand work had implemented by this point (see docs/ONDEMAND_PROXY_DESIGN.md, not this document, for what that response means) |
| 06:56:55Z | `POST /api/realtime/debug-log` (JSON body) | 204 | *(empty)* |
| 06:56:55Z | `POST /api/overpass` (JSON body `{"query":"..."}`) | 400 | `{"error":"Exactly one data query is required"}` — the REAL overpass handler's own validation ran against a body Vercel-style pre-parsing had already consumed once, proving `rehydrateBody()` works end-to-end against real provider code, not just its own unit tests |
| 06:56:55Z | `GET /api/firmsx` | 404 | `{"error":"Unknown API route"}` — confirms the mount boundary rule against a REAL provider mount (`/api/firms`), not just the router's own unit tests |
| 06:56:55Z | `GET /api/adsbdb/route/BAW123` | 200 | `{"found":true,"airline":"British Airways",...}` — real upstream adsbdb.com lookup succeeded |

Server access log (`method path status ms`, as required):

```
GET / 200 4ms
GET /assets/egm96-universal.esm-D6y_VLZc.js 200 8ms
GET /cesium/Workers/transcodeKTX2.js 200 1ms
GET /api/firms/status 200 73ms
GET /api/tomtom/status 200 1ms
GET /api/celestrak/active 200 2888ms
GET /api/ais-live 501 1ms   (historical 2026-09-17 log; 200 since 2026-09-18)
GET /api/realtime/token 501 1ms
GET /api/setup/status 404 1ms
GET /api/does-not-exist 404 0ms
GET /some/spa/route 200 1ms
GET /api/ondemand/health 200 2ms
```

No unhandled crash or hang occurred for any request (the one live upstream
call that could plausibly fail in a network-restricted environment,
`/api/celestrak/active`, succeeded here in ~2.9s; the router's own error
path — verified in `router.test.mjs` and exercised for real by every
provider's own try/catch — would have produced a clean JSON error rather
than a crash either way). `npm run test:serverless` (`node --test
server/serverless/*.test.mjs`, 30 tests across `router.test.mjs`,
`vercel-adapter.test.mjs`, `app.test.mjs`) passed in full.

## 8. Divergence from the earlier FalKonEye integration architecture doc

This document covers only the provider-route → serverless-function
conversion. The OnDemand-proxy integration's own design notes (and any
divergence from an earlier architecture doc for that integration) live in
[`docs/ONDEMAND_PROXY_DESIGN.md`](./ONDEMAND_PROXY_DESIGN.md), maintained by
that work — see that file for details.

## 9. Env vars dropped from the candidate list (and why)

The task's candidate list for `.env.example` was: `ONDEMAND_API_KEY`, `ONDEMAND_BASE_URL`,
`ONDEMAND_SPATIAL_AGENT_ID`, `ONDEMAND_SPATIAL_FLOW_ID`, `GODS_EYE_FLOW_VERSION`,
`ONDEMAND_REASONING_ENDPOINT_ID`, `ONDEMAND_FULFILLMENT_ENDPOINT_ID`. Only names backed by
`docs/ONDEMAND_API_CURRENT.md` were kept (full rationale: `docs/ONDEMAND_PROXY_DESIGN.md` §5).

| Variable | Disposition | Reason (contract §) |
|---|---|---|
| `ONDEMAND_API_KEY` | kept | the `apikey` header (§1) |
| `ONDEMAND_BASE_URL` | kept | documented base URL / alternate hosts (§1) |
| `ONDEMAND_SPATIAL_AGENT_ID` | kept | default `pluginIds` entry (§2.1, §3.1) |
| `ONDEMAND_SPATIAL_FLOW_ID` | kept | workflow id for `POST /workflow/{id}/execute` (§7.1) |
| `ONDEMAND_FULFILLMENT_ENDPOINT_ID` | kept | default `endpointId` of the fulfillment model (§3.1, §12) |
| `ONDEMAND_REASONING_ENDPOINT_ID` | **dropped** | no "reasoning endpoint" exists in the docs; `reasoningMode` is a guide-only free string, stream-only (§3.1, §12). Replaced by the optional `ONDEMAND_REASONING_MODE` string. |
| `GODS_EYE_FLOW_VERSION` | **dropped** (2026-09-17) → **kept as the accepted alias** of the canonical `ONDEMAND_SPATIAL_FLOW_VERSION` (2026-09-18) | workflow versioning is **NOT FOUND IN LIVE DOCS** (§7.3), so the value is never sent upstream; it is the repo's own informational label of the created workflow definition (default `'1'`). Resolution is **alias-first** (`GODS_EYE_FLOW_VERSION` → `ONDEMAND_SPATIAL_FLOW_VERSION` → default) so the value already provisioned on the Vercel project (env id `usC3wgbut65gTkaR`) keeps winning; `/api/ondemand/health` reports `config.flowVersion.source` (the env NAME that resolved), `resolvedVia: alias\|canonical\|default`, `canonical`, `alias`. |
| `ONDEMAND_REQUEST_TIMEOUT_MS` | added (local only) | proxy-side fetch timeout; explicitly *not* an OnDemand field |

The FalKonEye blueprint's `ONDEMAND_DEFAULT_MODEL`, `ONDEMAND_PLUGIN_IDS`, `ONDEMAND_WORKFLOW_ID`,
`ONDEMAND_COMPANY_ID`, `ONDEMAND_MAX_CONCURRENCY`, `ONDEMAND_RAG_RATE_PER_MIN`,
`ONDEMAND_DAILY_TOKEN_BUDGET` and `ONDEMAND_PROXY_SHARED_SECRET` were renamed, replaced, dropped or deferred
as itemised in `docs/ONDEMAND_PROXY_DESIGN.md` §5–§6. All pre-existing provider env-var names in
`.env.example` are untouched.

## 10. Function count and Hobby-limit compliance

`find api -name '*.js'` → `api/[...route].js` + `api/ondemand/{chat,health,media,selftest,sessions,stt,tts,workflow}.js`
= **9 Serverless Functions ≤ 12** (Vercel Hobby cap; `api/ondemand/_config.js` is an underscore-prefixed
private module, not a function — re-counted 2026-09-19). The legacy provider mounts share the single
catch-all, so adding a provider route never adds a function. Helper modules live under
`server/serverless/`, `server/ondemand/` and `server/providers/` (outside `api/`), so they are never
counted as functions. Real-Vercel note (2026-09-18): the platform matches `api/[...route].js` for ONE
path segment only, so `vercel.json` carries a first rewrite `/api/:__gev_api_path*` → `/api/route`
and `server/serverless/vercel-adapter.js` strips the two query keys that rewrite injects
(commit `7ae8a50`).

## 11. Street Traffic road network — Overpass mirrors (closeout 2026-09-19)

The Street Traffic layer paints its flow (live TomTom when `TOMTOM_API_KEY` is set, simulated
otherwise) on OpenStreetMap roads fetched through the same-origin `POST /api/overpass` proxy
(`server/providers/overpass.js` → `overpass/transport.js`). From cloud egress the public Overpass
mirrors are not dependable: measured from Vercel `iad1` on 2026-09-18 and again from the agent
sandbox on 2026-09-19T01:28Z (`[out:json][timeout:25];node(1);out;`, POST, this User-Agent,
`Accept: application/json`) — `overpass.kumi.systems` 200 in 1.4 s, `overpass.private.coffee`
round-robin members answering 200 in 1.7–4.7 s or timing out at 12 s, `overpass-api.de` /
`lz4.` / `z.` HTTP 406 on every probe (client refusal; the community thread
https://community.openstreetmap.org/t/overpass-api-error-406/143198 attributes it to the April 2026
rule changes, resolved for some clients by an identifying `User-Agent` + POST body — this client
already sends both and is still refused from these egresses).

What the closeout changed — scoped to this adapter only (CelesTrak, OpenSky, adsb.lol/adsb.fi,
AISStream, TomTom, the OnDemand proxy, the deny-list and the function count are untouched):

- **Configurable mirrors.** `OVERPASS_ENDPOINTS` (canonical; comma-separated, trimmed, empty entries
  ignored, duplicates collapse) → `OVERPASS_UPSTREAMS` (accepted alias, 2026-09-18) → the code default
  `kumi.systems, private.coffee, overpass-api.de, lz4.overpass-api.de, z.overpass-api.de` (reachable
  first, refusing mirrors kept LAST rather than dropped — a refusal is per-egress and may lift).
  `server/providers/overpass/constants.js` `resolveOverpassEndpoints()`; the `road_network_status`
  tool reports which name supplied the list (`endpointsSource`).
- **Headers every mirror receives.** `User-Agent` = the ONE shared provider UA
  (`server/providers/common/upstream.js` `PROVIDER_USER_AGENT`, `ondemand-spatial/<major.minor>
  (+repo URL)`), `Accept: application/json`, `Content-Type: application/x-www-form-urlencoded`, body
  `data=<query>` via POST. `src/tooling/overpassMirrors.test.mjs` pins them on every request.
- **Rotation through the shared upstream helper.** Each mirror is one `fetchUpstream()` call
  (per-attempt timeout, body cap, status vocabulary; `retries: 0` — the NEXT mirror is the retry).
  HTTP 406 / 429 / any 5xx (plus 403 / 408), a rate-limit or runtime-error body, an oversized body,
  a network error or a timeout all move to the next mirror. Per-mirror budget
  `OVERPASS_MIRROR_TIMEOUT_MS` (default 12 s, was 22 s) and whole-rotation budget
  `OVERPASS_TOTAL_TIMEOUT_MS` (default 40 s) keep a five-mirror rotation inside the 60 s function
  ceiling; the road query carries an explicit `[timeout:20]`. A query every mirror rejects
  (400-class) is still passed through as upstream's own verdict — never dressed up as an outage.
- **DEGRADED rendering.** When every mirror fails the proxy answers **HTTP 503** with
  `X-Provider-Status: degraded`, `X-Provider-Source: Overpass`, `X-Provider-Error: <reason>` and a
  JSON body `{ error, provider, failures[] }`, where the reason summarises the rotation —
  `all 5 mirrors failed · last: kumi.systems HTTP 406`, or `3 of 5 mirrors failed, 2 skipped (time
  budget) · last: private.coffee timed out after 12 s`. Last-good roads from memory or disk still win
  over that answer (served `stale`). The client (`src/layers/traffic/ingestion.js`
  `describeRoadError`, `controls.js getStats`) presents it like every other MOVEMENT degradation —
  `status`/`providerStatus` `degraded`, `providerError` = the reason, source `Overpass`, no `error`
  (which would read UNAVAILABLE / LOAD FAILED) — so the DATA LAYERS row reads exactly
  `DEGRADED · Overpass · <reason>` (with ` · retrying` appended only while the bounded retry is in
  flight). Successful and stale answers now also carry `X-Provider-Status: live|stale` and
  `X-Provider-Source: Overpass (<mirror>)`.
- **Durable option.** A self-hosted or private Overpass instance (e.g. a regional extract in
  `overpass-api` Docker, or a paid instance) listed FIRST in `OVERPASS_ENDPOINTS` makes the row LIVE
  again from cloud egress; the public mirrors then serve only as fallbacks. Postpass is not
  Overpass-QL compatible and is not a drop-in entry for this list.
