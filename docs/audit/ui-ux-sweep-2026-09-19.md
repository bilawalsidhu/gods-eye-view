# UI/UX sweep + OnDemand integration verification — 2026-09-19 (branch `ondemand-serverless`)

Starting point `9ce49cd` (origin tip at 05:42:52Z; the local branch was re-pointed onto it — the parallel
five-commit series of the same icon work stays on `origin/ondemand-serverless-svg-icons` / PR #1 and was NOT
merged). Three work streams ran in parallel: **A** UI/UX sweep on the sandbox preview (this agent), **B**
OnDemand integration verification (sub-agent, read-only), **C** real Vercel project read (sub-agent, read-only).
Nothing under `api/`, no env-var name, the OnDemand workflow, the registration pack or persisted-state
identifiers were changed. All times UTC.

## 1. Sandbox preview

| Step | UTC | Result |
|---|---|---|
| `9ce49cd` tree copied to sandbox `sbx_IYwKc0PKi3hIOZmOOYOsTjza6ID2` (Node 24), `npm run build`, dev-server restart | 05:44:56Z → 05:45:18Z | HTTP 200 at https://sb-4rkbnrh6injr.vercel.run, `/brand/icons/ship.svg` 200 |
| Fixed files redeployed (rebuild + restart) | 05:55:28Z → 05:55:40Z | HTTP 200 |

## 2. Defect table (stream A)

Measured with the sanctioned headless driver (`ui_validate.py`, Chromium) on the Austin scene (`lat=30.25146
lon=-97.7533 alt=800`, MGRS 14R PU 1994 4730, every MOVEMENT toggle ON, DATA LAYERS expanded) and Galveston Bay
(`lat=29.55 lon=-94.80 alt=12000`). BEFORE = `9ce49cd` at 05:49:49Z–05:50:41Z (1440×900); AFTER = this commit at
05:55:40Z–06:03:01Z (1440×900, 1024×768, 390×844 emulation; Galveston 1440×900).

| id | surface | viewport | severity | found → fixed / deferred | evidence |
|---|---|---|---|---|---|
| UX-1 | DATA LAYERS row labels | 1440×900 | high | **Fixed.** BEFORE: 7 labels rendered on two lines — `Live Flights`, `Street Traffic`, `Mapped ALPR Cameras`, `Mapped Installations`, `Submarine Cables`, `Space Missions (30d)`, `Earthquakes (24h)` (`getClientRects().length > 1`). Fix: `.data-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-width: 0 }`, `.data-toggle-left { flex: 1 1 auto; min-width: 0 }`, `.data-toggle-right { flex: none }`, wide status chips `min-width 82 → 74px`, the count yields to a wide chip on every row (not only ALPR), full name kept in `title`. AFTER: wrapped = `[]` at 1440×900, 1024×768 and 390-emulation, Austin and Galveston. | `before-austin-1440x900.png`, `after-austin-1024x768.png`; DOM evals |
| UX-2 | DATA LAYERS list — last visible row half-clipped ("Street Traffic" in the user's capture), no scroll affordance | 1440×900 | high | **Fixed (affordance) / by design (scrolling).** The list already scrolled (`overflow-y: auto`, thin themed scrollbar; BEFORE list 251 px vs content 1359 px) but nothing said so. Fix: `LayerPanel` mirrors `data-overflow` / `data-at-end` onto the list on render, scroll and resize; `.data-panel-inner::after` fades the bottom edge while more rows are below; WebKit scrollbar 6 → 8 px. AFTER: `overflow:"true" atEnd:"false"` on load; a row still crosses the fold (it is a scroll container — a grid tall enough for 18 rows does not fit a 900 px viewport), but the fold is now signalled. | DOM eval `{"listH":249,"scrollH":1339,"overflow":"true","atEnd":"false"}` |
| A11Y-1 | 9 px reason strings (`.data-toggle-meta`), OFF badge text, chip text | all | high (SC 1.4.3) | **Fixed.** `--text-dim` rgba(243,243,243,.3) on the glass ground (#121213) = **2.51:1**. New token `--text-readable-dim` rgba(243,243,243,.68) = **8.15:1**, applied to meta, toggle and chip text. | contrast computed in `src/dataLayersA11y.test.mjs`; AFTER computed colour `rgba(243, 243, 243, 0.68)` |
| A11Y-2 | Toggle / chip boundary | all | medium (SC 1.4.11) | **Fixed.** Border rgba(255,255,255,.08) = **1.22:1** → `--control-border-aa` rgba(255,255,255,.35) = **3.22:1**. | AFTER `borderColor rgba(255, 255, 255, 0.35)` |
| A11Y-3 | Target size — toggle 38×20, wide toggle 82×20, chip 46×16, collapse button 22×22 | all | medium (SC 2.5.8) | **Fixed.** `min-height: 24px` on toggles and chips (chip padding 2→4 px), collapse button 22 → 24 px. AFTER: targets under 24 px = `[]`. | DOM eval |
| A11Y-4 | Feed-state changes not announced | all | medium (SC 4.1.3) | **Fixed.** `LayerPanel` mounts `<div class="data-layer-status" role="status" aria-live="polite" aria-atomic="true">` beside the list and announces `"<Layer>: <STATE>"` on a real transition of an enabled layer (never on first paint or OFF). AFTER: `{"dataLayerStatus":true,"role":"status","live":"polite"}`. | DOM eval; unit test |
| A11Y-5 | Reduced motion | all | low (SC 2.3.3) | **Fixed.** Global `@media (prefers-reduced-motion: reduce)` in `foundation.css` (animations/transitions 0.01 ms); HUD REC blink holds steady under the preference (`src/hud.js`). | source + unit test |
| A11Y-6 | Focus visible / name-role-value on toggles | 1440×900 | — | **Pass (source-verified).** `.data-toggle-btn:focus-visible` inset 2 px outline exists (`src/keyboardFocusStyles.test.mjs`); toggles are `<button>` with `aria-label` (`"Satellites: ON"`), `aria-pressed`/`aria-busy` handled by `LayerPanel`. Programmatic `focus()` in the eval does not trigger `:focus-visible` (computed `outline: none`), so the ring was verified from the stylesheet, not the screenshot. | DOM eval `{"focused":true,"role":"BUTTON","name":"Satellites: ON"}` |
| BRAND-1 | Rendered strings | all | — | **Pass.** `GodsEye` / `God's Eye` / `Gods Eye`: 0 in `textContent` and `innerHTML`; emoji ranges U+1F000–1FAFF / 2600–27BF / 2B00–2BFF: 0 in `innerHTML`; title "OnDemand Spatial". | DOM evals, both scenes |
| ICON-1 | Inline SVG icons | all | — | **Pass.** 18 rows = 18 `svg[data-icon]` (Austin, Galveston, 1024×768, 390-emulation). | DOM evals |
| NET-1 | Console / network | all | low | `GET /api/setup/status` → 404 on the keyless preview (the key-setup probe; pre-existing, harmless). No page errors, no other failed requests. | validator report |
| DEF-1 | Short viewports (1024×768): the DATA LAYERS list is only 122 px tall (~1.5 rows) because the left stack starts at `--left-stack-top: 26vh` and caps at `min(620px, 100vh − …)` | 1024×768 | medium | **Deferred** — changing the stack geometry touches the cockpit/left-rail layout contract (`src/panelStackLayout.test.mjs`, `cockpitMarkup.test.mjs`); needs a design decision (lower `--left-stack-top` on short viewports). | `after-austin-1024x768.png`, eval `{"listH":122}` |
| DEF-2 | 320 px reflow (SC 1.4.10) and true 390×844 rendering | mobile | medium | **Deferred / not measurable here** — headless Chromium's minimum window width is 500 px; the 390 px device-metrics override is applied only at capture time and every mobile capture timed out (see §5). At 500 px: no horizontal overflow (`scrollWidth 500 = innerWidth 500`). `responsive.css` has 720/520 px breakpoints; a 320 px pass needs a real device or a driver that can set the window size. | evals 06:00:00Z |
| DEF-3 | 200 % text resize (SC 1.4.4) | all | low | **Deferred** — not exercisable with `ui_validate.py` (no zoom control); CSS uses px sizes throughout the panel, so a browser-zoom pass should be done manually. | — |
| DEF-4 | `--text-dim` elsewhere (HUD dim labels, key-setup hints, radio chips) | all | medium | **Deferred** — the token is still 2.5:1 wherever it is used outside DATA LAYERS; the AA companion tokens are in place, adoption per surface is a follow-up. | `foundation.css` |
| DEF-5 | Header wordmark / favicon / manifest vs `logo_green.png` | all | — | **Not re-audited this run** — unchanged since the 2026-09-18 brand pass (`docs/brand/BRAND_SOURCE.md`, `public/brand/*`); no defect observed in the captures. | — |
| DEF-6 | Presets, DISPLAY toggles, radio/mission/event controls, chat/voice, search — full interaction sweep at three viewports | all | — | **Partially covered**: icons/targets/contrast of the DATA LAYERS panel only; the remaining surfaces were verified for icons in the previous run and not exercised control-by-control here (budget). | — |

Regression tests added: `src/dataLayersA11y.test.mjs` (7 tests — AA contrast of the new tokens and status colours,
no-wrap label rules, scroll/affordance rules, ≥24 px targets, live-region behaviour with a fake DOM, reduce-motion).

## 3. Gates (final tree)

| Gate | UTC | Result |
|---|---|---|
| `npm run format:check` | 05:54:34Z | ✓ 966 source files |
| `npm run check:boundaries` | 05:52:19Z–05:52:29Z | ✓ 109 export groups |
| `npm test` | 05:53:19Z–05:53:54Z | **4,367 tests — 4,366 pass / 0 fail / 1 skipped** (was 4,360 / 4,359 / 0 / 1 at `9ce49cd`; +7) |
| `npm run test:ondemand` | 05:53:54Z | 219 / 219 |
| `npm run test:serverless` | 05:53:54Z | 58 / 58 |
| `npm run build` | 05:54:47Z–05:54:54Z | ✓ built in 6.04 s |
| Functions | 05:54:54Z | **9** (`api/[...route].js` + `api/ondemand/{chat,health,media,selftest,sessions,stt,tts,workflow}.js`) ≤ 12 |

## 4. Integration matrix (stream B — sandbox preview, keyless; stream C — real project)

| check | endpoint | status | latency | UTC | note |
|---|---|---|---|---|---|
| OnDemand live docs | `gateway.on-demand.io/config/v1/public/docs/categories` | 403 | — | 05:52:08Z | live fetch refused; fell back to the repo's audited copy `docs/ONDEMAND_API_CURRENT.md` (retrieved 2026-09-17T05:56–57Z) |
| health (sandbox) | `GET /api/ondemand/health` | 200 | ~0.05 s | 05:54:30Z | `configured:false`, `flowVersion.source:"default"`, `spatialFlowId.source:"default"`; 0 key/token-shaped values in body or headers |
| selftest (sandbox, no token) | `GET /api/ondemand/selftest` | 404 | 0.088 s | 05:54:30Z | `{"error":"not_found"}` — the route hides itself while `ONDEMAND_SELFTEST_TOKEN` is unset (anti-enumeration) |
| earthquakes 24 h | `GET /api/sources/earthquakes?starttime=…&endtime=…` | 200 | — | 05:56:59Z | count **100** (USGS live) |
| earthquakes Gulf circle | `…?latitude=26&longitude=52&maxradiuskm=1500` | 200 | — | 05:56:59Z | count **14** |
| earthquakes unknown param | `…?window=24h` / `…&bogusParam=zzz` | 400 | 0.06–0.24 s | 05:54:30Z | `{"error":"invalid_query","unknown":[…]}` |
| CelesTrak proxy | `GET /api/celestrak/starlink`, `/active` | 200, 200 | fast | 05:54:30Z | live TLE text |
| chat (reasoning endpoint) | `POST /api/ondemand/chat` | 503 | 0.068 s | 05:54:33Z | `not_configured` — `ONDEMAND_API_KEY is not set on the server.` |
| workflow execute `6aace534859f7b0abb53d99a` v1 | `POST /api/ondemand/workflow?action=execute` | 503 | 0.053 s | 05:54:33Z | keyless refusal; prior baseline 163 s / 657 ms TTFL not re-measurable; `action=stream-logs` → 501 by design (OnDemand exposes log polling only) |
| speech STT / TTS | `POST /api/ondemand/stt`, `/tts` | 503, 503 | 0.04 s | 05:54:33Z | keyless refusal |
| media / sessions | `GET /api/ondemand/media`, `/sessions` | 503, 503 | 0.05 s | 05:54:33Z | keyless refusal |
| reasoning mode / plugin inventory / context injection | config fields on `health` (`reasoningMode`, `reasoningEndpointId`, `fulfillmentEndpointId`, `defaultPluginIds`) | — | — | 05:54:30Z | no dedicated endpoint; reported through `health.config` / `env.sources` |
| nine functions respond | see above + catch-all via earthquakes/celestrak/opensky/adsblol/ais-live/overpass (405 on GET) | 0 × 5xx | — | 05:54–05:57Z | every function answered with a deliberate status |
| registration pack vs routes | `src/registry/capabilities.json` v5 ↔ `api/`, `server/` | match | — | 05:57Z | 3 capability adapters + 9 skill docs present; workflow id = `config.js` default; the 1,450-line narrative pack was cross-checked through its machine-readable counterpart |
| **real project** health | `GET https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app/api/ondemand/health` | 200 | — | 05:46:28Z | `ondemand/chat/speech/media/workflow: healthy`, `configured:true`, `flowVersion.source = GODS_EYE_FLOW_VERSION` (alias), `spatialFlowId.source = ONDEMAND_SPATIAL_WORKFLOW_ID` (canonical) |
| real project earthquakes | `…/api/sources/earthquakes?window=24h`, `?hours=24` | 400, 400 | — | 05:46:29Z | `invalid_query` — the real params are `starttime/endtime` (see sandbox row) |
| real project selftest | `…/api/ondemand/selftest` (no token) | 404 | — | 05:46:30Z | token is a `sensitive` Vercel var — cannot be read or run from here |

### 4.1 Selftest — the 10 checks (`server/ondemand/contract-steps.js`, run order)

| # | check | skip rule |
|---|---|---|
| 1 | session create + reuse | — |
| 2 | sync prompt | — |
| 3 | SSE stream | — |
| 4 | built-in tool/plugin invocation | **skipped** when `env.sources.defaultPluginIds` is `unset`: "no default plugin configured on the deployment (ONDEMAND_SPATIAL_AGENT_ID unset)". This is the 1 skip in the 9 / 0 / 1 result of 2026-09-19T01:47Z. Un-skip by registering an agent/plugin on the OnDemand account (dashboard-only) and setting `ONDEMAND_SPATIAL_AGENT_ID`. |
| 5 | STT on in-script generated WAV | — |
| 6 | TTS | — |
| 7 | Media PNG analysis | — |
| 8 | workflow | skipped only when `env.sources.spatialFlowId` is `unset` — on the real project it is `canonical` (passed, 14,036 ms on 01:47Z) |
| 9 | session-memory follow-up | — |
| 10 | latency summary | — |

On this keyless sandbox none of the ten can run (`ONDEMAND_SELFTEST_TOKEN` and `ONDEMAND_API_KEY` unset → the route
answers 404). Credential fields the gated checks need (names only; all blank in `.env.example`): `ONDEMAND_API_KEY`,
`ONDEMAND_BASE_URL`, `ONDEMAND_SELFTEST_TOKEN`, `ONDEMAND_FULFILLMENT_ENDPOINT_ID`, `ONDEMAND_REASONING_ENDPOINT_ID`,
`ONDEMAND_REASONING_MODE`, `ONDEMAND_REQUEST_TIMEOUT_MS`, `ONDEMAND_SPATIAL_AGENT_ID`, `ONDEMAND_SPATIAL_FLOW_VERSION`,
`ONDEMAND_SPATIAL_WORKFLOW_ID`; movement feeds `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `OPENSKY_AUTH_MODE`,
`AISSTREAM_API_KEY`, `TOMTOM_API_KEY`. No credential was available to this run (`env | grep -c ONDEMAND` = 0).

### 4.2 Upstream vs app-side (MOVEMENT feeds, observed 05:54–06:05Z)

| feed | observed | class | basis |
|---|---|---|---|
| CelesTrak (Satellites) | `LIVE · CelesTrak` on sandbox and real project; proxy 200 | upstream healthy now | the user's capture ("CelesTrak unreachable") was a provider outage window |
| OpenSky (Live Flights) | `DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` | **upstream / network** (OpenSky connect timeout from cloud egress) + config (`OPENSKY_CLIENT_ID/SECRET` missing → anonymous tier) | the fallback feed is app-side by design |
| adsb.lol (Military) | `LIVE · adsb.lol` | upstream healthy now | the user's "HTTP 502" was provider-side |
| AISStream (Vessels) | `Demo replay · No vessels in scene` | **app-side (configuration)** — `AISSTREAM_API_KEY` missing → deliberate demo replay; the serverless relay limit is architectural | — |
| TomTom (Street Traffic) | `DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads` | **app-side (configuration)** — key missing; OSM roads via Overpass reachable (`kumi.systems`) | — |

## 5. Verbatim MOVEMENT badge transcriptions

Sandbox preview (this commit), Austin, 05:55:40Z–05:56:30Z: `Satellites | ON | LIVE · CelesTrak · 1h ago` ·
`Live Flights | DEGRADED | DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` ·
`Military Flights | ON | LIVE · adsb.lol · 17s ago` · `Live Vessels | ON | Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` ·
`Street Traffic | DEGRADED | DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds)` ·
`Transit | ON | GTFS-RT · …` · `Bike Share | ON | GBFS · …`. Galveston Bay 06:02:06Z–06:03:01Z: same five badges (Satellites ON, Live Flights DEGRADED, Military ON, Vessels ON demo replay, Traffic DEGRADED).

Real deployment `dpl_33CfSGEWDxgimgodxnHzJUW3CbwT` (`0677f16`, before the SVG icons), Austin, 06:04:41Z–06:05:45Z:
`🛰️ Satellites | ON | LIVE · CelesTrak · 2m ago | DENSE` · `✈️ Live Flights | DEGRADED | DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed` ·
`🎖️ Military Flights | ON | LIVE · adsb.lol · just now` · `◭ Live Vessels | ON | Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast)` ·
`🚗 Street Traffic | LOADING | DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) · SIMULATED — add TomTom key for live`.
Emoji present: yes (18 rows, 0 inline svgs) — the real project has not been redeployed since `0677f16`.

## 6. Captures

`before-austin-1440x900.png` (`9ce49cd`, 05:50Z), `after-austin-1024x768.png` (this commit, 05:59Z). The AFTER
captures at 1440×900 (Austin ×3, Galveston ×1) and the 390×844 emulations ended in `ui_validate.py` with
`TimeoutError: timed out` at its `Page.captureScreenshot` step (the driver's 0.4 s socket settle on a busy WebGL page);
every DOM assertion of those runs passed before the capture step and is recorded above. The sanctioned driver was not
worked around.

## 7. Real Vercel project (stream C, read-only, 05:44:49Z–05:46:30Z)

Project `prj_VbHbEhFSDFkdXCqlq8XqONoFWQHO` (framework vite, Git-linked to `mk42-ai/ondemand-eand-spatial`, production
branch `main`). Preview deployments: `dpl_33CfSGEWDxgimgodxnHzJUW3CbwT` READY 2026-09-19T02:41:20Z `0677f16` (current
preview target, https://ondemand-eand-spatial-j8s1kk2zd-schoolhack-web-team.vercel.app) · `dpl_GDb1kCXDZRQzYdS8BzNTt5JvLuQq`
READY 02:37:44Z `7a24c7a` · `dpl_743G2gRzJbm4Vxm9d1PZQtqJTo7i` READY 2026-09-18T18:39:07Z `4dc98fc` (+3 earlier `4dc98fc`
previews, 4 previews of 2026-09-12). Production: `dpl_7CAoCxdEQRQ7W12mzwz4iGKDK4V9` **BLOCKED** (2026-09-11T14:32:41Z,
"Vercel couldn't find a Git account for the commit author"), `dpl_2otSQj9GA2WSCXDYERHkAXwuJ5Ck` ERROR (build exit 1).
Both 19 Sep previews are behind the branch: `7a24c7a` by `0677f16 5779800 18e2a68 9ce49cd` + this commit; `0677f16` by
`5779800 18e2a68 9ce49cd` + this commit.

Env vars (21, names/targets/types only): `ASK_ENABLED` plain · `ASK_THE_DEAL_ALLOWED_ORIGIN` sensitive · `CI` plain ·
`DOC_BUSINESS_PLAN_PDF_URL` / `DOC_BUSINESS_PLAN_URL` / `DOC_GANTT_URL` / `DOC_MOU_URL` sensitive · `ELEVENLABS_API_KEY`
sensitive · `GODS_EYE_FLOW_VERSION` plain (**still present**) · `ONDEMAND_API_BASE` sensitive · `ONDEMAND_API_KEY` sensitive ·
`ONDEMAND_BASE_URL` plain · `ONDEMAND_ENDPOINT_ID` · `ONDEMAND_FULFILLMENT_ENDPOINT_ID` · `ONDEMAND_KNOWLEDGE_PLUGIN_IDS` ·
`ONDEMAND_REASONING_ENDPOINT_ID` · `ONDEMAND_REASONING_MODE` · `ONDEMAND_SELFTEST_TOKEN` sensitive · `ONDEMAND_SPATIAL_FLOW_VERSION`
plain (**present**) · `ONDEMAND_SPATIAL_WORKFLOW_ID` plain (**present**) · `VITE_SERVERLESS_MODE` plain. **MISSING:**
`OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `TOMTOM_API_KEY`.

## 8. Remaining human steps

1. Add `OPENSKY_CLIENT_ID` / `OPENSKY_CLIENT_SECRET`, `AISSTREAM_API_KEY`, `TOMTOM_API_KEY` to the Vercel project (Live
   Flights → live OpenSky, Vessels → live AIS, Street Traffic → live speeds).
2. Redeploy the real project from this commit (CLI): `unzip ondemand-spatial-ui-sweep-<sha>.zip && cd ondemand-spatial-ui-sweep-<sha> && PUPPETEER_SKIP_DOWNLOAD=1 npm ci && npm test && npm run build && npx vercel link --scope schoolhack-web-team --project ondemand-eand-spatial --yes && npx vercel deploy` (`--prod` once the Git-author block is lifted).
3. Delete `GODS_EYE_FLOW_VERSION` once `ONDEMAND_SPATIAL_FLOW_VERSION` is confirmed live (health will then report `canonical`).
4. Register the dashboard agent + `earthquake_search` (dashboard-only) and set `ONDEMAND_SPATIAL_AGENT_ID` to un-skip selftest check 4.
5. Overpass: keep the `kumi.systems` rotation or provision a private mirror in `OVERPASS_ENDPOINTS` (decision pending).
6. Deferred UI items DEF-1…DEF-6 above.
