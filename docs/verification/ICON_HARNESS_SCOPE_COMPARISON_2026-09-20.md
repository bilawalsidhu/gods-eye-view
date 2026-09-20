# Icon harness scope comparison — the 90 → 53 `svg[data-icon]` delta (2026-09-20)

Headless Chromium (repo `puppeteer` + `/usr/bin/chromium`, swiftshader) driven by `scripts/qa-icon-harness.mjs` against the fresh keyless node24 sandbox **https://sb-4hcy4jcldizn.vercel.run** (created 2026-09-20T07:45:11Z, expires 2026-09-20T09:15:11Z) built from the post-fix tree (`0c90689`), 1440×900, both scenes, both scopes. Raw results and PNG proofs: `docs/verification/icon-harness-2026-09-20/` (one JSON per run; every number below is copied from those files).

## 1. What produced 90 and what produced 53 — the two scopes, reconstructed

| Aspect | "90/91" sweep (13eb0e3 → 1b9e9a8 passes, 2026-09-19 08:57Z–10:20Z) | "53/54" pass (bf57053, 2026-09-20 04:04Z–04:08Z) |
|---|---|---|
| Harness script | **none committed** — an ad-hoc Puppeteer script kept outside the repository (no `harness`/`verify` script exists in the 2026-09-19 10:24Z export `code-files-20260919-102417_v1.zip`, in any other pass export, or in `git log -p -- scripts/` — the 64 `scripts/qa-*.mjs` files are identical across every export). Scope reconstructed from `docs/audit/closeout-2026-09-19.md` ("Headless sweep … five MOVEMENT toggles ON + Directions/Radio/Space Missions/Earthquakes/Global Context, every panel expanded, 55 s settle") and `docs/audit/icons-verification-2026-09-19.md`. | ad-hoc `/tmp/gev-harness/verify.mjs` of the 2026-09-20 turn (also uncommitted). **Both are superseded by `scripts/qa-icon-harness.mjs`, committed with this note**, whose `--scope 90` / `--scope 53` modes encode the two configurations; a `diff` between the two historical scripts is therefore not possible and the scope difference is documented here instead. |
| Viewport | 1440×900 | 1440×900 |
| Scenes | Austin `#lat=30.25146&lon=-97.7533&alt=800&heading=0&pitch=-35` (MGRS 14R PU 1994 4730) and Galveston Bay `#lat=29.45&lon=-94.85&alt=45000&pitch=-55` | same two scenes |
| Layers ON | five MOVEMENT (Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic) **+ Directions + Radio + Space Missions (30d) + Earthquakes (24h)** | five MOVEMENT **+ Data Centers** (for the POI check) |
| Panels | **every** collapsible panel expanded (DATA LAYERS, DISPLAY, Global Context, CCTV, scene, radio, mission …) | DATA LAYERS, DISPLAY, Global Context expanded |
| Settle | 55 s | 45–60 s |
| Count scope | document-wide `document.querySelectorAll("svg[data-icon]")` | document-wide (identical DOM scope) |
| Chat overlay | 90 closed → **91** with ASK ONDEMAND open (close icon) | 53 closed → **54** open |

## 2. Measured today — scope → count, per-panel contribution, stroke compliance

| Scene | Scope | `svg[data-icon]` (chat closed) | …with ASK ONDEMAND open | stroke-width set | black icons | DATA LAYERS rows 18 px / 1.75 | emoji DL / doc | glyphs | UNAVAILABLE | HTTP 502 (network / text) |
|---|---|---|---|---|---|---|---|---|---|---|
| Austin (MGRS 14R PU 1994 4730) | 53 | **54** | **55** | {"1.75": 54} | 0 | 18/18 (computed 1.75px: 18) | 0 / 0 | 0+0 | 0 | 0 / 0 |
| Austin (MGRS 14R PU 1994 4730) | 90 | **89** | **89** | {"1.75": 89} | 0 | 18/18 (computed 1.75px: 18) | 0 / 0 | 0+0 | 0 | 0 / 0 |
| Galveston Bay | 53 | **54** | **55** | {"1.75": 54} | 0 | 18/18 (computed 1.75px: 18) | 0 / 0 | 0+0 | 0 | 0 / 0 |
| Galveston Bay | 90 | **89** | **89** | {"1.75": 89} | 0 | 18/18 (computed 1.75px: 18) | 0 / 0 | 0+0 | 0 | 0 / 0 |

### Per-panel contribution (icons grouped by the nearest panel/container id; `stroke175` = icons carrying `stroke-width="1.75"`)

| Panel / container | austin scope 53 | austin scope 90 | galveston scope 53 | galveston scope 90 |
|---|---|---|---|---|
| `cctv-panel` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `cockpit-display-toggle-btn` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `cockpit-radio-next-btn` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `cockpit-radio-play-btn` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `cockpit-radio-prev-btn` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `cockpit-radio-toggle-btn` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `command-dock` | 3 (1.75: 3, visible: 0) | 3 (1.75: 3, visible: 1) | 3 (1.75: 3, visible: 0) | 3 (1.75: 3, visible: 1) |
| `context-radio-dock` | 3 (1.75: 3, visible: 0) | 3 (1.75: 3, visible: 0) | 3 (1.75: 3, visible: 0) | 3 (1.75: 3, visible: 0) |
| `control-panel-popover` | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) |
| `data-panel` | 19 (1.75: 19, visible: 19) | 19 (1.75: 19, visible: 19) | 19 (1.75: 19, visible: 19) | 19 (1.75: 19, visible: 19) |
| `global-context-panel` | 2 (1.75: 2, visible: 1) | 2 (1.75: 2, visible: 1) | 2 (1.75: 2, visible: 1) | 2 (1.75: 2, visible: 1) |
| `hud-rec-dot` | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) |
| `hud-toggle` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `other:#orbit-indicator` | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) |
| `pp-toggles` | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) | 7 (1.75: 7, visible: 0) |
| `radio-panel` | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) | 1 (1.75: 1, visible: 1) |
| `scene-panel` | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) | 1 (1.75: 1, visible: 0) |
| `space-mission-panel-host` | 0 | 35 (1.75: 35, visible: 30) | 0 | 35 (1.75: 35, visible: 30) |
| `top-center-actions` | 2 (1.75: 2, visible: 2) | 2 (1.75: 2, visible: 2) | 2 (1.75: 2, visible: 2) | 2 (1.75: 2, visible: 2) |

### Icon names per panel (scope 90 vs scope 53, Austin) — what the extra layers/panels add

| Panel | scope 53 icons | scope 90 icons |
|---|---|---|
| `cctv-panel` | chevron-left×1 | chevron-left×1 |
| `cockpit-display-toggle-btn` | chevron-left×1 | chevron-left×1 |
| `cockpit-radio-next-btn` | skip-forward×1 | skip-forward×1 |
| `cockpit-radio-play-btn` | play×1 | play×1 |
| `cockpit-radio-prev-btn` | skip-back×1 | skip-back×1 |
| `cockpit-radio-toggle-btn` | chevron-left×1 | chevron-left×1 |
| `command-dock` | map-pin×1, plus×1, search×1 | map-pin×1, plus×1, search×1 |
| `context-radio-dock` | play×1, skip-back×1, skip-forward×1 | play×1, skip-back×1, skip-forward×1 |
| `control-panel-popover` | circle×1, contrast×1, moon×1, snowflake×1, sparkles×1, thermometer×1, tv×1 | circle×1, contrast×1, moon×1, snowflake×1, sparkles×1, thermometer×1, tv×1 |
| `data-panel` | activity×1, bike×1, bus×1, cable×1, camera×1, car×1, cctv×1, compass×1, dam×1, flame×1, minus×1, plane×1, radar×1, radio×1, rocket×1, satellite×1, server×1, shield×1, ship×1 | activity×1, bike×1, bus×1, cable×1, camera×1, car×1, cctv×1, compass×1, dam×1, flame×1, minus×1, plane×1, radar×1, radio×1, rocket×1, satellite×1, server×1, shield×1, ship×1 |
| `global-context-panel` | chevron-right×1, triangle×1 | chevron-right×1, triangle×1 |
| `hud-rec-dot` | circle×1 | circle×1 |
| `hud-toggle` | scan-eye×1 | scan-eye×1 |
| `other:#orbit-indicator` | rotate-ccw×1 | rotate-ccw×1 |
| `pp-toggles` | chevron-left×1, focus×1, minus×1, plane×1, scan×1, square×1, sun×1 | chevron-left×1, focus×1, minus×1, plane×1, scan×1, square×1, sun×1 |
| `radio-panel` | plus×1 | minus×1 |
| `scene-panel` | plus×1 | plus×1 |
| `space-mission-panel-host` | — | chevron-left×1, chevron-right×31, pause×1, x×2 |
| `top-center-actions` | layers-minus×1, link×1 | layers-minus×1, link×1 |

## 3. Header, clear-layers control and Material Symbols inventory (measured)

| Scene / scope | title-bar lockup loaded | h1 | subtitle | share `link` icon 1.75 | `#clear-selected-layers` | Material Symbols elements in DOM (total / visible) |
|---|---|---|---|---|---|---|
| austin / 53 | True (`/brand/logo-light.svg`) | OnDemand Spatial | SPATIAL INTELLIGENCE CONSOLE | True | svg `data-icon=layers-minus` 18×18 px, stroke 1.75 (computed 1.75px), Material Symbols inside: False | 30 / 6 — {"other:#celestial-ring-overlay": 2, "top-center-actions": 3, "cockpit-speed-rim": 1, "cockpit-altitude-rim": 1, "cockpit-vision-previous": 1, "cockpit-vision-next": 1, "cockpit-hud": 2, "cockpit-context-previous": 1, "cockpit-context-next": 1, "cockpit-context-toggle": 1, "cockpit-context-direction": 1, "cockpit-route": 1, "cockpit-brief-previous": 1, "cockpit-brief-next": 1, "cockpit-signal-toggle": 1, "cockpit-reset-globe": 1, "other:#map-view-switch": 1, "pp-toggles": 3, "context-radio-dock": 3, "global-context-panel": 2, "cockpit-entry": 1} |
| austin / 90 | True (`/brand/logo-light.svg`) | OnDemand Spatial | SPATIAL INTELLIGENCE CONSOLE | True | svg `data-icon=layers-minus` 18×18 px, stroke 1.75 (computed 1.75px), Material Symbols inside: False | 30 / 6 — {"other:#celestial-ring-overlay": 2, "top-center-actions": 3, "cockpit-speed-rim": 1, "cockpit-altitude-rim": 1, "cockpit-vision-previous": 1, "cockpit-vision-next": 1, "cockpit-hud": 2, "cockpit-context-previous": 1, "cockpit-context-next": 1, "cockpit-context-toggle": 1, "cockpit-context-direction": 1, "cockpit-route": 1, "cockpit-brief-previous": 1, "cockpit-brief-next": 1, "cockpit-signal-toggle": 1, "cockpit-reset-globe": 1, "other:#map-view-switch": 1, "pp-toggles": 3, "context-radio-dock": 3, "global-context-panel": 2, "cockpit-entry": 1} |
| galveston / 53 | True (`/brand/logo-light.svg`) | OnDemand Spatial | SPATIAL INTELLIGENCE CONSOLE | True | svg `data-icon=layers-minus` 18×18 px, stroke 1.75 (computed 1.75px), Material Symbols inside: False | 30 / 6 — {"other:#celestial-ring-overlay": 2, "top-center-actions": 3, "cockpit-speed-rim": 1, "cockpit-altitude-rim": 1, "cockpit-vision-previous": 1, "cockpit-vision-next": 1, "cockpit-hud": 2, "cockpit-context-previous": 1, "cockpit-context-next": 1, "cockpit-context-toggle": 1, "cockpit-context-direction": 1, "cockpit-route": 1, "cockpit-brief-previous": 1, "cockpit-brief-next": 1, "cockpit-signal-toggle": 1, "cockpit-reset-globe": 1, "other:#map-view-switch": 1, "pp-toggles": 3, "context-radio-dock": 3, "global-context-panel": 2, "cockpit-entry": 1} |
| galveston / 90 | True (`/brand/logo-light.svg`) | OnDemand Spatial | SPATIAL INTELLIGENCE CONSOLE | True | svg `data-icon=layers-minus` 18×18 px, stroke 1.75 (computed 1.75px), Material Symbols inside: False | 30 / 6 — {"other:#celestial-ring-overlay": 2, "top-center-actions": 3, "cockpit-speed-rim": 1, "cockpit-altitude-rim": 1, "cockpit-vision-previous": 1, "cockpit-vision-next": 1, "cockpit-hud": 2, "cockpit-context-previous": 1, "cockpit-context-next": 1, "cockpit-context-toggle": 1, "cockpit-context-direction": 1, "cockpit-route": 1, "cockpit-brief-previous": 1, "cockpit-brief-next": 1, "cockpit-signal-toggle": 1, "cockpit-reset-globe": 1, "other:#map-view-switch": 1, "pp-toggles": 3, "context-radio-dock": 3, "global-context-panel": 2, "cockpit-entry": 1} |

## 4. Layer states at assertion time (badge · reason)

**Austin (MGRS 14R PU 1994 4730) — scope 53** (layers requested: Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic, Data Centers; enabled: [["Satellites", true], ["Live Flights", true], ["Military Flights", true], ["Live Vessels", true], ["Street Traffic", true], ["Data Centers", true]]; camera after settle {"lat": 30.25146, "lon": -97.7533, "altM": 800}; assertions at 2026-09-20T07:48:20.748Z)

| # | Row | Badge | Reason / subtext |
|---|---|---|---|
| 1 | Satellites | `ON` | LIVE · CelesTrak · 1m ago \| DENSE \| STATION 20 \| NAV 91 \| GEO 567 \| VISUAL 153 |
| 2 | Live Flights | `DEGRADED` | DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed |
| 3 | Military Flights | `ON` | LIVE · adsb.lol · 28s ago |
| 4 | Live Vessels | `ON` | Demo replay · No vessels in scene (demo replay covers the Texas Gulf coast) |
| 5 | Street Traffic | `LOADING` | DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) · SIMULATED — add TomTom key for live |
| 6 | Transit | `OFF` | GTFS-RT · never |
| 7 | Bike Share | `OFF` | GBFS · never |
| 8 | Cameras | `OFF` | CCTV + Street View fallback · never |
| 9 | Mapped ALPR Cameras | `OFF` | OpenStreetMap · community mapped · never |
| 10 | Mapped Installations | `OFF` | OpenStreetMap + optional Google Maps Places · never |
| 11 | Data Centers | `ON` | Local · 1m ago |
| 12 | Submarine Cables | `OFF` | TeleGeography · never |
| 13 | Dams | `OFF` | USACE · never |
| 14 | Space Missions (30d) | `OFF` | Launch Library 2 · never |
| 15 | Earthquakes (24h) | `OFF` | USGS · never |
| 16 | Active Fires | `OFF` | NASA FIRMS · LIVE · never |
| 17 | Directions | `OFF` | OSM routing · never |
| 18 | Radio | `OFF` | Radio Browser · never |

**Austin (MGRS 14R PU 1994 4730) — scope 90** (layers requested: Space Missions (30d), Radio, Directions, Earthquakes (24h), Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic; enabled: [["Space Missions (30d)", true], ["Radio", true], ["Directions", false], ["Earthquakes (24h)", false], ["Satellites", true], ["Live Flights", false], ["Military Flights", false], ["Live Vessels", false], ["Street Traffic", false]]; camera after settle {"lat": 30.25146, "lon": -97.7533, "altM": 21945917}; assertions at 2026-09-20T07:57:42.624Z)

| # | Row | Badge | Reason / subtext |
|---|---|---|---|
| 1 | Satellites | `ON` | LIVE · CelesTrak · 9m ago |
| 2 | Live Flights | `OFF` | OpenSky Network · never |
| 3 | Military Flights | `OFF` | adsb.lol · never |
| 4 | Live Vessels | `OFF` | AISStream · never |
| 5 | Street Traffic | `OFF` | OpenStreetMap · never |
| 6 | Transit | `OFF` | GTFS-RT · never |
| 7 | Bike Share | `OFF` | GBFS · never |
| 8 | Cameras | `OFF` | CCTV + Street View fallback · never |
| 9 | Mapped ALPR Cameras | `OFF` | OpenStreetMap · community mapped · never |
| 10 | Mapped Installations | `OFF` | OpenStreetMap + optional Google Maps Places · never |
| 11 | Data Centers | `OFF` | Local · never |
| 12 | Submarine Cables | `OFF` | TeleGeography · never |
| 13 | Dams | `OFF` | USACE · never |
| 14 | Space Missions (30d) | `ON` | Launch Library 2 · just now |
| 15 | Earthquakes (24h) | `OFF` | USGS · never |
| 16 | Active Fires | `OFF` | NASA FIRMS · LIVE · never |
| 17 | Directions | `OFF` | OSM routing · never |
| 18 | Radio | `ON` | Radio Browser · 7m ago |

**Galveston Bay — scope 53** (layers requested: Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic, Data Centers; enabled: [["Satellites", true], ["Live Flights", true], ["Military Flights", true], ["Live Vessels", true], ["Street Traffic", true], ["Data Centers", true]]; camera after settle {"lat": 29.45, "lon": -94.85, "altM": 45000}; assertions at 2026-09-20T07:52:44.151Z)

| # | Row | Badge | Reason / subtext |
|---|---|---|---|
| 1 | Satellites | `ON` | LIVE · CelesTrak · 5m ago \| DENSE \| STATION 20 \| NAV 91 \| GEO 567 \| VISUAL 153 |
| 2 | Live Flights | `DEGRADED` | DEGRADED · adsb.lol · OpenSky unreachable from this deployment (connect timeout) - adsb.lol regional feed |
| 3 | Military Flights | `ON` | LIVE · adsb.lol · 9s ago |
| 4 | Live Vessels | `DEGRADED` | DEGRADED · Demo replay · AISSTREAM_API_KEY not set - demo replay, not live AIS |
| 5 | Street Traffic | `DEGRADED` | DEGRADED · TomTom · TOMTOM_API_KEY not set — showing simulated flow on live OSM roads (set TOMTOM_API_KEY in Vercel for live speeds) |
| 6 | Transit | `OFF` | GTFS-RT · never |
| 7 | Bike Share | `OFF` | GBFS · never |
| 8 | Cameras | `OFF` | CCTV + Street View fallback · never |
| 9 | Mapped ALPR Cameras | `OFF` | OpenStreetMap · community mapped · never |
| 10 | Mapped Installations | `OFF` | OpenStreetMap + optional Google Maps Places · never |
| 11 | Data Centers | `ON` | Local · 53s ago |
| 12 | Submarine Cables | `OFF` | TeleGeography · never |
| 13 | Dams | `OFF` | USACE · never |
| 14 | Space Missions (30d) | `OFF` | Launch Library 2 · never |
| 15 | Earthquakes (24h) | `OFF` | USGS · never |
| 16 | Active Fires | `OFF` | NASA FIRMS · LIVE · never |
| 17 | Directions | `OFF` | OSM routing · never |
| 18 | Radio | `OFF` | Radio Browser · never |

**Galveston Bay — scope 90** (layers requested: Space Missions (30d), Radio, Directions, Earthquakes (24h), Satellites, Live Flights, Military Flights, Live Vessels, Street Traffic; enabled: [["Space Missions (30d)", true], ["Radio", true], ["Directions", false], ["Earthquakes (24h)", false], ["Satellites", true], ["Live Flights", false], ["Military Flights", false], ["Live Vessels", false], ["Street Traffic", false]]; camera after settle {"lat": 29.45, "lon": -94.85, "altM": 21945917}; assertions at 2026-09-20T07:59:12.550Z)

| # | Row | Badge | Reason / subtext |
|---|---|---|---|
| 1 | Satellites | `ON` | LIVE · CelesTrak · 11m ago |
| 2 | Live Flights | `OFF` | OpenSky Network · never |
| 3 | Military Flights | `OFF` | adsb.lol · never |
| 4 | Live Vessels | `OFF` | AISStream · never |
| 5 | Street Traffic | `OFF` | OpenStreetMap · never |
| 6 | Transit | `OFF` | GTFS-RT · never |
| 7 | Bike Share | `OFF` | GBFS · never |
| 8 | Cameras | `OFF` | CCTV + Street View fallback · never |
| 9 | Mapped ALPR Cameras | `OFF` | OpenStreetMap · community mapped · never |
| 10 | Mapped Installations | `OFF` | OpenStreetMap + optional Google Maps Places · never |
| 11 | Data Centers | `OFF` | Local · never |
| 12 | Submarine Cables | `OFF` | TeleGeography · never |
| 13 | Dams | `OFF` | USACE · never |
| 14 | Space Missions (30d) | `ON` | Launch Library 2 · 5s ago |
| 15 | Earthquakes (24h) | `OFF` | USGS · never |
| 16 | Active Fires | `OFF` | NASA FIRMS · LIVE · never |
| 17 | Directions | `OFF` | OSM routing · never |
| 18 | Radio | `ON` | Radio Browser · 8m ago |

## 5. Explanation of the 90 → 53 delta (evidence-backed)

The 90 → 53 difference is **not** a loss of icons on the DATA LAYERS surface and not a change in the DOM scope of the count (both passes counted `document.querySelectorAll('svg[data-icon]')` over the whole document at 1440×900): it is the set of layers/panels that were open. Re-running both configurations today on the same build (`0c90689`, which adds one icon — the lucide `layers-minus` on `#clear-selected-layers` — to every scope) gives **54** for the five-MOVEMENT-toggle scope and **89** for the 2026-09-19 sweep scope, on both scenes. The per-panel table above shows that the whole difference sits in **`#space-mission-panel-host`: 35 `svg[data-icon]` (31 roster `chevron-right` rows + prev/next chevrons + `pause` + two `x`)**, which exists only while the *Space Missions (30d)* layer is ON — 54 + 35 = 89; the remaining panels (DATA LAYERS 19, DISPLAY 7, control-panel popover 7, command dock 3, cockpit/context radio transports 3 + 5, Global Context 2, top-centre actions 2, HUD/orbit/rec 3, CCTV/scene collapse buttons 2, radio panel 1) contribute identically in both scopes (collapse buttons merely swap `plus`↔`minus`). The 2026-09-19 figure of 90/91 versus today's 89 is within the live-data variance of that roster (the number of missions Launch Library 2 returns in the 30-day window; the sandbox proxied it successfully today, 31 rows) plus the one icon added since. Two further facts explain why the 53-scope was the honest one for the five-toggle verification: (1) *Space Missions* is a Global-Context dependency (`src/contextModePolicy.js`: mode `space-missions` allows only `rocket-launches`, `satellites` and `radio`), so enabling it isolates Live Flights / Military Flights / Live Vessels / Street Traffic — in today's scope-90 runs the five MOVEMENT `setEnabled` calls issued after it returned `enabled: false` and the rows read `OFF` (see §4), i.e. "five MOVEMENT toggles ON **and** Space Missions ON" is not a reachable state in this build through the layer API, and the ASK ONDEMAND overlay could not open (no aircraft in view) so the +1 chat icon appears only in the 53-scope runs (54 → 55); (2) the 2026-09-19 sweep's own row table showed Space Missions `ON` alongside the movement rows, but the context policy is byte-identical between `13eb0e3` and this tip (`git diff 13eb0e3 HEAD -- src/contextModePolicy.js` is empty) and the sweep's harness was never committed, so how that combined state was reached is unrecorded; through the layer API it is not reachable, and the 90 therefore cannot be reproduced together with the five toggles. Every icon in every run carries `stroke-width="1.75"` (89/89 and 54/54), the 18 DATA LAYERS rows render inline 18×18 px SVGs in all four runs, and no emoji, U+21BB/U+21C4 glyph, `rgb(0,0,0)` icon, UNAVAILABLE badge or HTTP 502 was observed.

## 6. Files

- Harness: `scripts/qa-icon-harness.mjs` (this commit). Run: `node scripts/qa-icon-harness.mjs --url <preview> --scene austin --scope 90 --out docs/verification/icon-harness-2026-09-20`.
- Results: `docs/verification/icon-harness-2026-09-20/<scene>-scope<scope>.json` and PNGs `…-full.png`, `…-data-layers.png`, `…-display.png`, `…-header.png`, `…-clear-layers.png`, `…-chat.png`.

