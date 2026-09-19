# Verification — emoji icons replaced by the Lucide SVG set (2026-09-19)

Branch `ondemand-serverless`; work started from the actual tip `18e2a68` (the brief named `7a24c7a`, which is three
commits behind: `0677f16`, `5779800`, `18e2a68`). Nothing under `api/`, no environment variable, the OnDemand
workflow definition, the registration pack and the persisted-state identifiers (`src/data/layerState.js` tokens)
were touched. Evidence ledger and full mapping: `docs/brand/ICON_SOURCE.md`; manifest: `public/brand/icons/icons.json`.

## Timeline (UTC)

| When | Step |
|---|---|
| 04:06:56Z | Workspace inspected; `git rev-parse HEAD` = `18e2a682aab9f2d76e20a5b2e182f25aa8d42935` |
| 04:08:13Z–04:30:17Z | Inventory scans (Emoji blocks, Geometric Shapes, VS16/ZWJ/regional indicators, HTML entities, JS escapes) |
| 04:14:14Z | `lucide-static@1.47.0` (ISC) installed with an exact pin |
| 04:21:33Z → 05:10:13Z | `scripts/sync-lucide-icons.mjs` (SVGO 4.0.0 + normalisation) → `public/brand/icons/` (57 SVG + LICENSE + LICENSE-icons.md + icons.json) |
| 05:10:58Z | 57/57 `sourceUrl`s (unpkg) answered HTTP 200; 57/57 SVGs parse as XML; unpkg bytes == package bytes |
| 04:24:10Z–05:11Z | 137 emoji / glyph icon sites replaced; `src/ui/icons/layerIcon.js` + `src/ui/styles/icons.css`; 8-test boundary suite |
| 05:12:05Z–05:13:35Z | Gates (below) |
| 05:14:23Z–05:19:02Z | BEFORE: `18e2a68` built and served on a second sandbox; screenshot + DOM counts |
| 05:19:45Z–05:21:27Z | AFTER build deployed to the preview sandbox (Node 24 `npm ci`, `npm run build`, dev-server) |
| 05:21:55Z–05:24:25Z | AFTER: headless-browser verification, transcript, screenshots + panel crops |

## Gates (`package.json` scripts, run locally on Node 22.23.2; production build repeated on Node 24 in the sandbox)

| Gate | Command | Result |
|---|---|---|
| format | `npm run format:check` | pass — 966 source files |
| boundaries | `npm run check:boundaries` | pass — 109 export groups built and checked |
| unit | `npm test` | **4,360 tests: 4,359 pass / 0 fail / 1 skip** (baseline 4,351 pass / 0 fail / 1 skip; +8 new boundary tests) |
| ondemand | `npm run test:ondemand` | 219 / 219 pass |
| serverless | `npm run test:serverless` | 58 / 58 pass (57 at `7a24c7a`; `0677f16` added one) |
| build | `npm run build` | pass (`dist/brand/icons` = 60 files) |
| functions | `api/**/*.js` minus `_config.js` | **9**: `api/[...route].js`, `api/ondemand/chat.js`, `health.js`, `media.js`, `selftest.js`, `sessions.js`, `stt.js`, `tts.js`, `workflow.js` |

## Headless-browser verification (ui-validator, Chromium 1440×900, Austin scene)

Share link `#lat=30.25146&lon=-97.7533&alt=800&heading=0&pitch=-35&v=2&l=a.f.m.s.t.j.b&lo=s.c.d&hv=1&hud=tactical&ui=d.c.0`
(near the Jenga Tower, MGRS 14R PU 1994 4730; all seven MOVEMENT toggles ON, DENSE satellites, DATA LAYERS panel expanded;
the panel lists every group — Movement / Cameras / Infrastructure / Events / Utilities — there is no per-group collapse).
Emoji regex applied to `textContent` and `innerHTML`: `[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}\u{25A0}-\u{25FF}\u{2300}-\u{23FF}\u{2160}-\u{216F}\u{224B}\u{1F1E6}-\u{1F1FF}]`.

| Measure | BEFORE (`18e2a68`) | AFTER |
|---|---|---|
| emoji / glyph matches in `#data-panel` textContent | 21 | **0** |
| emoji / glyph matches in `#data-panel` innerHTML | 21 | **0** |
| matches in `document.body` textContent / innerHTML | — | **0 / 0** |
| `#data-panel svg[aria-hidden="true"]` | 0 | **19** (18 row icons + collapse button) |
| `svg.od-icon[aria-hidden="true"]` on the page | 0 | **51** (52 `svg.od-icon` total; the HUD REC dot is `role="img"`) |
| DATA LAYERS rows with an inline `<svg data-icon>` | 0 / 18 | **18 / 18** |
| row icon box / stroke (computed) | — | 18px × 18px, stroke-width 1.75px |
| row icon colour by state | — | live `rgb(59, 183, 149)` (#3BB795), degraded `rgb(255, 173, 114)` |

MOVEMENT rows, verbatim (AFTER, 05:24Z):

| Icon | Label | Badge | Subtext |
|---|---|---|---|
| `satellite` | Satellites | ON | LIVE · CelesTrak · 33m ago (chip: DENSE) |
| `plane` | Live Flights | DEGRADED | DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed |
| `shield` | Military Flights | ON | LIVE · adsb.lol · 7s ago |
| `ship` | Live Vessels | ON | Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast) |
| `car` | Street Traffic | DEGRADED | DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) |
| `bus` | Transit | ON | GTFS-RT · 11s ago |
| `bike` | Bike Share | ON | GBFS · 23s ago |

BEFORE, same rows: 🛰️ Satellites [ON] · ✈️ Live Flights [ON] · 🎖️ Military Flights [ON] · ◭ Live Vessels [ON] · 🚗 Street Traffic
[DEGRADED] · 🚌 Transit · 🚲 Bike Share (the screenshot in the brief shows the same rows in an UNAVAILABLE state on a
different deployment; the row icon there is the same glyph). `/api/ondemand/health` answers HTTP 200 on the preview
(the keyless sandbox reports `configured: false`, unchanged from before this work — no environment variable was added).

Screenshots: `before-austin-datalayers-1440x900.png`, `after-austin-datalayers-1440x900.png` and the panel crops
`before-austin-datalayers-panel-crop.png` / `after-austin-datalayers-panel-crop.png` (attached to the run).

## Inventory (pre-change, `file:line → glyph → component → replacement`)

| # | file:line (at 18e2a68) | glyph | code point | component | label / role | replaced by |
|---|---|---|---|---|---|---|
| 1 | `src/app/constructCatalog.js:137` | ▲ | U+25B2 | DATA LAYERS › Events | FIRMS Active Fires row icon | flame |
| 2 | `src/app/layers/firms.js:22` | ▲ | U+25B2 | DATA LAYERS › Events | fires layer default icon | flame |
| 3 | `src/data/bhoteKoshiEmbeddedMedia.js:995` | ↗ | U+2197 | Bhote Koshi embedded media card | OPEN ORIGINAL link | external-link |
| 4 | `src/data/bhoteKoshiEvent.js:824` | × | U+00D7 | Bhote Koshi event panel | close event layer | x |
| 5 | `src/data/bhoteKoshiEvent.js:848` | ‹ | U+2039 | Bhote Koshi event panel | previous story beat | chevron-left |
| 6 | `src/data/bhoteKoshiEvent.js:854` | › | U+203A | Bhote Koshi event panel | next story beat | chevron-right |
| 7 | `src/data/bhoteKoshiEvent.js:857` | ▶ | U+25B6 | Bhote Koshi event panel | PLAY | play |
| 8 | `src/data/bhoteKoshiEvent.js:858` | ▶ | U+25B6 | Bhote Koshi event panel | PLAY SCENE | play |
| 9 | `src/data/bhoteKoshiEvent.js:859` | ◉ | U+25C9 | Bhote Koshi event panel | CINEMATIC | circle-dot |
| 10 | `src/data/bhoteKoshiEvent.js:860` | ↺ | U+21BA | Bhote Koshi event panel | FULL STORY | rotate-ccw |
| 11 | `src/data/bhoteKoshiEvent.js:861` | ↗ | U+2197 | Bhote Koshi event panel | OPEN ORIGINAL | external-link |
| 12 | `src/data/bhoteKoshiEvent.js:862` | ⌖ | U+2316 | Bhote Koshi event panel | LOWER GORGE corridor | crosshair |
| 13 | `src/data/bhoteKoshiEvent.js:871` | ↗ | U+2197 | Bhote Koshi event panel | OPEN PUBLIC MAP | external-link |
| 14 | `src/data/bhoteKoshiEvent.js:2581` | ↔ | U+2194 | Bhote Koshi imagery split | divider handle | move-horizontal |
| 15 | `src/data/bhoteKoshiEvent.js:2661` | ■ | U+25A0 | Bhote Koshi event panel | RELEASE CAMERA / CINEMATIC toggle | square / circle-dot |
| 16 | `src/data/bhoteKoshiEvent.js:2661` | ◉ | U+25C9 | Bhote Koshi event panel | RELEASE CAMERA / CINEMATIC toggle | square / circle-dot |
| 17 | `src/data/bhoteKoshiEvent.js:3047` | ▶ | U+25B6 | Bhote Koshi event panel | PLAY SHOT | play |
| 18 | `src/data/bhoteKoshiEvent.js:3049` | Ⅱ | U+2161 | Bhote Koshi event panel | PAUSE | pause |
| 19 | `src/data/bhoteKoshiEvent.js:3052` | ↺ | U+21BA | Bhote Koshi event panel | REPLAY CINEMATIC | rotate-ccw |
| 20 | `src/data/bhoteKoshiEvent.js:3053` | ↺ | U+21BA | Bhote Koshi event panel | REPLAY | rotate-ccw |
| 21 | `src/data/bhoteKoshiEvent.js:3054` | ▶ | U+25B6 | Bhote Koshi event panel | PLAY | play |
| 22 | `src/data/bhoteKoshiEvent.js:3061` | ▶ | U+25B6 | Bhote Koshi event panel | PLAY SCENE | play |
| 23 | `src/data/bhoteKoshiEvent.js:3082` | ↺ | U+21BA | Bhote Koshi event panel | FULL STORY | rotate-ccw |
| 24 | `src/data/bhoteKoshiEvent.js:3804` | 🌊 | U+1F30A | Events layer catalog | Bhote Koshi event layer icon | waves |
| 25 | `src/data/bhoteKoshiLocator.js:1093` | ◎ | U+25CE | Events layer catalog | Bhote Koshi locator layer icon | locate |
| 26 | `src/data/infrastructure.js:23` | ▣ | U+25A3 | DATA LAYERS › Infrastructure | Data Centers row icon | server |
| 27 | `src/data/infrastructure.js:38` | ▰ | U+25B0 | DATA LAYERS › Infrastructure | Dams row icon | dam |
| 28 | `src/data/localGeojsonCore.js:323` | 📍 | U+1F4CD | Local GeoJSON layers | default row icon | map-pin |
| 29 | `src/data/localLayers.js:14` | ▲ | U+25B2 | DATA LAYERS › Events | FIRMS Active Fires row icon (standalone catalog) | flame |
| 30 | `src/data/transitFeeds.js:41` | 🚌 | U+1F68C | Transit selection card / labels | bus mode glyph | bus (name only; card title is text) |
| 31 | `src/data/transitFeeds.js:42` | 🚊 | U+1F68A | Transit selection card / labels | tram mode glyph | tram-front (name only) |
| 32 | `src/data/transitFeeds.js:43` | 🚇 | U+1F687 | Transit selection card / labels | subway mode glyph | train-front (name only) |
| 33 | `src/data/transitFeeds.js:44` | 🚆 | U+1F686 | Transit selection card / labels | rail mode glyph | train-front (name only) |
| 34 | `src/data/transitFeeds.js:45` | ⛴️ | U+26F4 U+FE0F | Transit selection card / labels | ferry mode glyph | ship (name only) |
| 35 | `src/data/transitFeeds.js:46` | 🚏 | U+1F68F | Transit selection card / labels | unknown mode glyph | signpost (name only) |
| 36 | `src/hud.js:202` | ● | U+25CF | HUD (top-right) | REC blinking dot | circle (od-icon--solid, label "Recording") |
| 37 | `src/keySetup.js:62` | 🔴 | U+1F534 | Key setup panel | tier dot metered (red) / free (amber) | circle + data-tier colour |
| 38 | `src/keySetup.js:62` | 🟡 | U+1F7E1 | Key setup panel | tier dot metered (red) / free (amber) | circle + data-tier colour |
| 39 | `src/keySetup.js:111` | ↗ | U+2197 | Key setup panel | GET KEY / MANAGE external link | external-link |
| 40 | `src/keySetup.js:111` | ↗ | U+2197 | Key setup panel | GET KEY / MANAGE external link | external-link |
| 41 | `src/layers/alpr/index.js:237` | 📷 | U+1F4F7 | DATA LAYERS › Cameras | Mapped ALPR Cameras row icon | camera |
| 42 | `src/layers/awareness/controls.js:13` | ◎ | U+25CE | Global Context layer | row icon | globe |
| 43 | `src/layers/awareness/rendering.js:52` | ➜ | U+279C | Global Context off-screen markers | direction arrow (rotated) | arrow-right |
| 44 | `src/layers/bikeshare/controls.js:9` | 🚲 | U+1F6B2 | DATA LAYERS › Movement | Bike Share row icon | bike |
| 45 | `src/layers/bikeshare/queries.js:19` | 🚲 | U+1F6B2 | HUD detection label (Cesium label) | bike-share dock label | text "BIKES …" (label) |
| 46 | `src/layers/bikeshare/selection.js:36` | 🚲 | U+1F6B2 | Bike-share selection card | availability line | text "BIKES …" |
| 47 | `src/layers/bikeshare/selection.js:41` | ⚠️ | U+26A0 U+FE0F | Bike-share selection card | Not installed warning | text "WARNING Not installed" |
| 48 | `src/layers/bikeshare/selection.js:42` | ⚠️ | U+26A0 U+FE0F | Bike-share selection card | Not renting warning | text "WARNING Not renting" |
| 49 | `src/layers/bikeshare/selection.js:43` | ⚠️ | U+26A0 U+FE0F | Bike-share selection card | Not returning warning | text "WARNING Not returning" |
| 50 | `src/layers/cctv/controls.js:18` | 📹 | U+1F4F9 | DATA LAYERS › Cameras | Cameras row icon | cctv |
| 51 | `src/layers/directions/index.js:34` | 🚗 | U+1F697 | Directions row chips | DRIVE mode icon name | car |
| 52 | `src/layers/directions/index.js:35` | 🚶 | U+1F6B6 | Directions row chips | WALK mode icon name | footprints |
| 53 | `src/layers/directions/index.js:36` | 🚲 | U+1F6B2 | Directions row chips | BIKE mode icon name | bike |
| 54 | `src/layers/directions/index.js:118` | ✓ | U+2713 | Directions row chips | SET A confirmed chip | text "A SET" |
| 55 | `src/layers/directions/index.js:129` | ✓ | U+2713 | Directions row chips | SET B confirmed chip | text "B SET" |
| 56 | `src/layers/directions/index.js:1251` | 🧭 | U+1F9ED | DATA LAYERS › Utilities | Directions row icon | compass |
| 57 | `src/layers/earthquakes/index.js:30` | 🌋 | U+1F30B | DATA LAYERS › Events | Earthquakes row icon | activity |
| 58 | `src/layers/firms/model.js:383` | ▲ | U+25B2 | World overlay (canvas) | ambient fire card title | text "FIRE <frp> MW" (canvas) |
| 59 | `src/layers/flights/queries.js:267` | ✈️ | U+2708 U+FE0F | DATA LAYERS › Movement | Live Flights row icon | plane |
| 60 | `src/layers/installations/controls.js:11` | ⌖ | U+2316 | DATA LAYERS › Infrastructure | Military Installations row icon | radar |
| 61 | `src/layers/launches/controls.js:7` | 🚀 | U+1F680 | DATA LAYERS › Events | Rocket Launches row icon | rocket |
| 62 | `src/layers/launches/panel.js:311` | › | U+203A | Space mission roster | row chevron | chevron-right |
| 63 | `src/layers/launches/panel.js:455` | ‹ | U+2039 | Selected space mission panel | PREV / NEXT mission chevrons | chevron-left / chevron-right |
| 64 | `src/layers/launches/panel.js:455` | › | U+203A | Selected space mission panel | PREV / NEXT mission chevrons | chevron-left / chevron-right |
| 65 | `src/layers/launches/panel.js:455` | × | U+00D7 | Selected space mission panel | Deselect mission close | x |
| 66 | `src/layers/launches/panel.js:461` | Ⅱ | U+2161 | Mission replay transport | pause toggle | pause |
| 67 | `src/layers/launches/panel.js:462` | × | U+00D7 | Mission replay transport | Cancel replay | x |
| 68 | `src/layers/launches/replay.js:218` | ▶ | U+25B6 | Mission replay transport | play / pause toggle | play / pause |
| 69 | `src/layers/launches/replay.js:218` | Ⅱ | U+2161 | Mission replay transport | play / pause toggle | play / pause |
| 70 | `src/layers/military/queries.js:201` | 🎖️ | U+1F396 U+FE0F | DATA LAYERS › Movement | Military Flights row icon | shield |
| 71 | `src/layers/radio/controls.js:7` | ◉ | U+25C9 | DATA LAYERS › Utilities | Radio row icon | radio |
| 72 | `src/layers/satellites/controls.js:95` | 🛰️ | U+1F6F0 U+FE0F | DATA LAYERS › Movement | Satellites row icon | satellite |
| 73 | `src/layers/satellites/controls.js:508` | ✕ | U+2715 | DATA LAYERS › Movement › Satellites | DENSE chip failed state | text "DENSE FAILED" |
| 74 | `src/layers/submarineCables/lifecycle.js:10` | ≋ | U+224B | DATA LAYERS › Infrastructure | Submarine Cables row icon | cable |
| 75 | `src/layers/traffic/controls.js:15` | 🚗 | U+1F697 | DATA LAYERS › Movement | Street Traffic row icon | car |
| 76 | `src/layers/transit/lifecycle.js:120` | 🚌 | U+1F68C | DATA LAYERS › Movement | Transit row icon | bus |
| 77 | `src/layers/vessels/queries.js:254` | ◭ | U+25ED | DATA LAYERS › Movement | Live Vessels row icon | ship |
| 78 | `src/locationStatus.js:13` | 📍 | U+1F4CD | LOCATION tray mini-status | "Location: --" pin | map-pin (rendered by locationControls.js) |
| 79 | `src/locationStatus.js:46` | 📍 | U+1F4CD | LOCATION tray mini-status | preset city pin | map-pin |
| 80 | `src/locationStatus.js:54` | 📍 | U+1F4CD | LOCATION tray mini-status | searched place pin | map-pin |
| 81 | `src/ondemand/entityChat.js:511` | × | U+00D7 | ASK ONDEMAND overlay | close button | x |
| 82 | `src/overlays/worldOverlayAllocation.worker.mjs:464` | ▲ | U+25B2 | World overlay (canvas) allocation probe | synthetic fire card title | text "FIRE <n> MW" (canvas) |
| 83 | `src/overlays/worldOverlayAllocation.worker.mjs:554` | ▲ | U+25B2 | World overlay (canvas) allocation probe | synthetic fire card title | text "FIRE <n> MW" (canvas) |
| 84 | `src/ui/panelChrome.js:293` | ◀ | U+25C0 | Right-rail panel collapse buttons | collapsed / expanded | chevron-left / chevron-right |
| 85 | `src/ui/panelChrome.js:293` | ▶ | U+25B6 | Right-rail panel collapse buttons | collapsed / expanded | chevron-left / chevron-right |
| 86 | `src/ui/panelChrome.js:295` | + / − | U+002B / U+2212 | Left/other panel collapse buttons | expand / collapse | plus / minus |
| 87 | `src/ui/radioBindings.js:51` | ▶ | U+25B6 | Cockpit utility tray | display options toggle | chevron-right / chevron-left |
| 88 | `src/ui/radioBindings.js:51` | ◀ | U+25C0 | Cockpit utility tray | display options toggle | chevron-right / chevron-left |
| 89 | `src/ui/radioBindings.js:60` | ▶ | U+25B6 | Cockpit utility tray | radio controls toggle | chevron-right / chevron-left |
| 90 | `src/ui/radioBindings.js:60` | ◀ | U+25C0 | Cockpit utility tray | radio controls toggle | chevron-right / chevron-left |
| 91 | `src/ui/radioPresentation.js:130` | ● | U+25CF | Radio category <select> | option swatch bullet | text only (<option> cannot hold markup; colour stays) |
| 92 | `src/ui/radioPresentation.js:243` | Ⅱ | U+2161 | Context radio mini controls | play / pause | pause / play |
| 93 | `src/ui/radioPresentation.js:243` | ▶ | U+25B6 | Context radio mini controls | play / pause | pause / play |
| 94 | `src/ui/radioPresentation.js:258` | Ⅱ | U+2161 | Cockpit radio controls | play / pause | pause / play |
| 95 | `src/ui/radioPresentation.js:258` | ▶ | U+25B6 | Cockpit radio controls | play / pause | pause / play |
| 96 | `src/ui/styles/command-dock-compact.css:92` | › | U+203A | Command dock tray titles (CSS ::after) | expand chevron | chevron-right.svg as currentColor mask |
| 97 | `src/ui/styles/command-dock-compact.css:99` | ‹ | U+2039 | Command dock VISUAL PRESETS title (CSS ::after) | expand chevron | chevron-left.svg as currentColor mask |
| 98 | `src/ui/templates/cockpit.html:241` | ◀ | U+25C0 | Cockpit utility tray | display options toggle (initial) | chevron-left |
| 99 | `src/ui/templates/cockpit.html:254` | ◀ | U+25C0 | Cockpit utility tray | radio controls toggle (initial) | chevron-left |
| 100 | `src/ui/templates/cockpit.html:260` | ◀ | U+25C0 | Cockpit radio controls | previous station | skip-back |
| 101 | `src/ui/templates/cockpit.html:260` | ◀ | U+25C0 | Cockpit radio controls | previous station | skip-back |
| 102 | `src/ui/templates/cockpit.html:261` | ▶ | U+25B6 | Cockpit radio controls | play | play |
| 103 | `src/ui/templates/cockpit.html:262` | ▶ | U+25B6 | Cockpit radio controls | next station | skip-forward |
| 104 | `src/ui/templates/cockpit.html:262` | ▶ | U+25B6 | Cockpit radio controls | next station | skip-forward |
| 105 | `src/ui/templates/command-dock.html:17` | ◯ | U+25EF | VISUAL PRESETS | Normal | circle |
| 106 | `src/ui/templates/command-dock.html:22` | ▦ | U+25A6 | VISUAL PRESETS | CRT | tv |
| 107 | `src/ui/templates/command-dock.html:27` | 🌙 | U+1F319 | VISUAL PRESETS | NVG | moon |
| 108 | `src/ui/templates/command-dock.html:32` | 🌡️ | U+1F321 U+FE0F | VISUAL PRESETS | FLIR | thermometer |
| 109 | `src/ui/templates/command-dock.html:37` | ✦ | U+2726 | VISUAL PRESETS | Anime | sparkles |
| 110 | `src/ui/templates/command-dock.html:42` | ◐ | U+25D0 | VISUAL PRESETS | Noir | contrast |
| 111 | `src/ui/templates/command-dock.html:47` | ❄ | U+2744 | VISUAL PRESETS | Snow | snowflake |
| 112 | `src/ui/templates/command-dock.html:75` | + | U+002B | LOCATION tray | collapse button (initial) | plus |
| 113 | `src/ui/templates/command-dock.html:78` | 📍 | U+1F4CD | LOCATION tray mini-status | Location: -- pin (initial markup) | map-pin |
| 114 | `src/ui/templates/command-dock.html:89` | &#x1F50E; | HTML entity | LOCATION tray | search toggle | search |
| 115 | `src/ui/templates/context.html:28` | ◀ | U+25C0 | Context radio mini controls | previous station | skip-back |
| 116 | `src/ui/templates/context.html:28` | ◀ | U+25C0 | Context radio mini controls | previous station | skip-back |
| 117 | `src/ui/templates/context.html:29` | ▶ | U+25B6 | Context radio mini controls | play | play |
| 118 | `src/ui/templates/context.html:30` | ▶ | U+25B6 | Context radio mini controls | next station | skip-forward |
| 119 | `src/ui/templates/context.html:30` | ▶ | U+25B6 | Context radio mini controls | next station | skip-forward |
| 120 | `src/ui/templates/context.html:39` | ▶ | U+25B6 | Global context panel | expand (collapse button) | chevron-right |
| 121 | `src/ui/templates/context.html:62` | 🛸 | U+1F6F8 | Global context actions | Reclassify as TR-3B | triangle |
| 122 | `src/ui/templates/context.html:97` | + | U+002B | Radio section | expand button (initial) | plus |
| 123 | `src/ui/templates/display-controls.html:6` | &#x25C0; | HTML entity | DISPLAY panel | collapse button | chevron-left |
| 124 | `src/ui/templates/display-controls.html:10` | &#x25CE; | HTML entity | DISPLAY panel | HUD toggle | scan-eye |
| 125 | `src/ui/templates/display-controls.html:24` | &#x25A3; | HTML entity | DISPLAY panel | DETECT toggle | scan |
| 126 | `src/ui/templates/display-controls.html:55` | − | U+2212 | Parameter slider panel | collapse button (initial) | minus |
| 127 | `src/ui/templates/display-controls.html:65` | &#x2708; | HTML entity | DISPLAY panel | 3D aircraft toggle | plane |
| 128 | `src/ui/templates/display-controls.html:125` | &#x25A1; | HTML entity | DISPLAY panel | Clean UI toggle | square |
| 129 | `src/ui/templates/display-controls.html:130` | &#x2728; | HTML entity | DISPLAY panel | Bloom toggle | sun |
| 130 | `src/ui/templates/display-controls.html:140` | &#x1F50D; | HTML entity | DISPLAY panel | Sharpen toggle | focus |
| 131 | `src/ui/templates/layer-panels.html:9` | + | U+002B | DATA LAYERS panel | collapse button (initial) | plus |
| 132 | `src/ui/templates/layer-panels.html:22` | + | U+002B | CAMERAS panel | collapse button (initial) | plus |
| 133 | `src/ui/templates/layer-panels.html:78` | + | U+002B | SCENES panel | collapse button (initial) | plus |
| 134 | `src/ui/templates/scene-chrome.html:30` | &#x1F517; | HTML entity | Globe actions | Copy share link | link |
| 135 | `src/voice/ondemand/ui.js:190` | › | U+203A | OD VOICE readout | transcript speaker mark | chevron-right |
| 136 | `src/voice/ondemand/ui.js:195` | ‹ | U+2039 | OD VOICE readout | answer speaker mark | chevron-left |
| 137 | `src/voice/ondemand/ui.js:206` | ✗ | U+2717 | OD VOICE workflow telemetry | failed intent mark | text "(failed)" |

