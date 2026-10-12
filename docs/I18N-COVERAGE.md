# i18n Coverage — God's Eye View zh-CN

Status ledger for the Simplified Chinese localization, per module. This file
is the review checklist for "complete own-UI coverage": every row records the
implementation state, how it was verified, and anything deliberately left
English with a reason. Update it whenever UI text is added or moved.

Verified against base `6be2559` on `codex/i18n-zh-cn`, including the
2026-10-09 acceptance-review fixes (privacy-mode storage guards, keyed panel
collapse actions, sync-chip initial copy, locale-pinned QA gates).

Legend: ✅ translated + verified · 🟡 translated, partial (see note) · ⬜ kept
English by decision · ➖ not applicable.

## Architecture

| Piece | State | Verified by |
| --- | --- | --- |
| `src/i18n/core.js` engine (keys, `{param}` interpolation, en fallback, plurals, Intl formatters) | ✅ | `src/i18n/core.test.mjs` (13 tests) |
| Locale packs (35 namespaces, en + zh-CN) | ✅ | `src/i18n/locales/parity.test.mjs` (key + placeholder parity) |
| Saved > browser > en locale resolution, `gods-eye-view.locale` persistence | ✅ | `src/i18n/browser.js` + live browser matrix (below); storage is resolved inside the guards, so a privacy mode whose `localStorage` **getter** throws cannot block startup (`browser.test.mjs` + a real browser session with a throwing getter) |
| Pre-paint loading-screen localization (`public/locale-boot.js`) | ✅ | `src/i18n/bootMarkup.test.mjs` + browser: zh first paint |
| No-reload switch via Display-panel language select | ✅ | live matrix: open panels re-render instantly |
| Static markup binding (`data-i18n`, `data-i18n-attr`) | ✅ | `src/ui/staticI18n.js` + browser |
| English regression (default locale byte-identical output) | ✅ | existing suite green; en pack values verbatim |

## Live browser acceptance matrix (dev server, Chrome)

| Scenario | Result |
| --- | --- |
| Saved `zh-CN`, cold load | ✅ zh loading screen pre-paint, zh welcome launcher, zh HUD/dock |
| Browser locale `zh` (no saved choice) | ✅ detected → zh (headless system locale) |
| Saved `en` on a zh machine | ✅ en boot, beats browser preference |
| Persistence across reload | ✅ choice survives; no re-prompt |
| zh↔en switch, no reload | ✅ open panels re-render in place; `document.documentElement.lang` follows |
| Switch with a selected/tracked contact | ✅ subject, cohort distances, camera and trail preserved (SWA396 across zh→en→zh) |
| Injection probe (`<img onerror>` via search) | ✅ rendered as text; no element created, no handler fired |
| Share link | ✅ `#v=2` protocol unchanged; copy toast localized (honest failure path verified in sandbox) |
| Layout 1440×900 / 1024×768 / 800×600 | ✅ no clipped chrome, no horizontal overflow (qa-artifacts/i18n/*.png) |
| Production `build` + `preview` | ✅ zh detected and applied in dist output, no page errors |

Evidence screenshots: `qa-artifacts/i18n/` (git-ignored; regenerate with the
steps in the PR description).

## Module coverage

### Chrome and shells
| Module | State | Notes |
| --- | --- | --- |
| `index.html` + loading screen | ✅ | pre-paint zh; brand title kept |
| Title bar, top actions, style indicator, status chips, toast | ✅ | `chrome` pack; chip labels re-render via `loadingFeedback` |
| Welcome launcher (`welcome.html`, `firstRunExperience.js`) | ✅ | incl. runtime-painted ENVIRONMENTAL tile title |
| Command dock (visual presets, location bar, search) | ✅ | `dock` pack |
| Display panel (`display-controls.html`, `visualSettings.js`) | ✅ | language selector lives here; style status labels keyed |
| Data Layers panel (`layerPanel.js`) | ✅ | groups, states, meta lines, ages; every registered layer id keyed |
| Context rail (contacts/missions/radio/SDR) | ✅ | `context`, `radio`, `sdr` packs |
| Weather rail cards + timeline (`weatherPanel.js`, `rail*.js`) | ✅ | `weather` pack; UTC suffix kept |
| Cockpit (`cockpit.html`, `cockpit*.js`) | ✅ | `cockpit` pack; classification banner + instrument abbreviations kept |
| HUD (`hud.js`, `hudLocality.js`, `hudSummaryResponse.js`) | 🟡 | labels/bands/regions/locality zh; `TOP SECRET // SI-TK // NOFORN` banner kept verbatim (visual-design contract); HUD summary provenance layer NAMES pass through registration English (voice/HUD matching keys) |
| Provider Settings (`provider-settings.html`, `keySetup.js`, `keySetupCore.mjs`) | ✅ | rows/status/OAuth flow zh; server validation/refusal strings kept English (protocol responses rendered verbatim) — documented exclusion |
| Voice UI (`voice/*`) | ✅ | spoken replies + cards zh; tool schemas/system prompts untouched |
| Scenes director UI (`sceneControls/Presentation/Sharing`) | ✅ | `scenes` pack; director-produced statuses keyed at production |
| Street Level UI | ✅ | `streetlevel` pack; provider chips keep Mapillary |
| Recent Imagery UI (`recentImagery.js`, `imageryBoxTool.js`) | ✅ | `imagery` pack; NASA GIBS/HLS/VIIRS credit kept |
| Map stack chips (`maps/*`, `mapStackChips.js`) | ✅ | provider names kept |
| Location bar presets (`locations.js` + `location*`) | ✅ | record `name` fields stay English (geocoder/voice/CCTV matching keys); display resolves via `location` pack |
| MCP panel host (`globePanelRuntime.js`) | ⬜ | serialized into the host page without imports; dev-hosted fallback surface — excluded, listed for a future wave |

### Layer families (cards, panels, summaries, overlays)
| Family | State | Pack |
| --- | --- | --- |
| Launches / Space Missions | ✅ | `space` |
| Satellites (+ class legend) | ✅ | `space` (DENSE chip token kept) |
| Global Context / awareness | ✅ | `awareness` (engine reason strings translated at panel edge) |
| Earthquakes | ✅ | `geology` |
| Submarine cables | ✅ | labels are data; row name keyed |
| Weather (radar/lightning/clouds) | ✅ | `atmos` |
| Wind | ✅ | `atmos` |
| Cyclones | ✅ | `hazard` |
| FIRMS fires | ✅ | `hazard` |
| Fire perimeters | ✅ | `hazard` |
| Flights / Military / Vessels (tracked cards, HUD AIS) | ✅ | `fleet` |
| Aircraft classes + AIS vessel types | ✅ | parallel key maps; data tokens byte-identical |
| Local ADS-B | ✅ | `sensors` (ICAO/ALT/GS/TRK/V-S abbreviations kept) |
| Traffic | ✅ | `ground` (TomTom/OSM/Hybrid chip tokens kept) |
| Transit / Bikeshare | ✅ | `ground` |
| Directions (turn-by-turn) | ✅ | `ground`; served OSRM instruction recomposed client-side |
| ALPR | ✅ | `sensors` |
| Installations | ✅ | `sensors` |
| Radio (layer) | ✅ | `airwaves` incl. directory status sentences |
| Draw / annotations | ✅ | `draw` |
| Bhote Koshi event panel | ✅ | `events`; evidence data titles are join keys, kept |
| Analyst answer card caveats | ✅ | `analyst` |
| Scenarios/director flows | ✅ | `director`; field-validation internals kept (diagnostic) |

### Deliberate English exclusions
| Content | Reason |
| --- | --- |
| Layer registration `name:`/`source:` fields | voice/HUD/QA matching keys; display resolves via `PANEL_LABEL_KEYS` / pack maps |
| Portable boundary modules (`layers/*/source|records|recordPolicy|ingestion` for flights/military/vessels, `sources/*`, `director/playback.js`) | portable package graphs stay free of presentation; composed status strings translate at the presentation edge |
| Server protocol error JSON (Provider Settings, OpenAI realtime, regional providers, Overpass, GBFS, terrain) | server responses rendered verbatim by contract; the browser presents its own fallback copy where one exists |
| Voice tool schemas, system prompts, action ids, `server/providers/openai/tools.js` | model contract, not UI |
| Entity names (callsigns, MMSI, ship/satellite names), coordinates, MGRS | data |
| Brands: God's Eye View, Cesium, Google, Bing, Esri, OSM, TomTom, Mapillary, NOAA, NHC, CelesTrak, adsb.lol, AISStream, OpenSky, Radio Browser, USGS, NASA, InciWeb, WebUSB, RTL-SDR | proper nouns |
| Units and conventions: kt, ft, km, m, dBZ, MW, UTC, °C, FL, MGRS, GSD, NIIRS, ALT, ONA, COLL, HDG, BRG, ICAO, MMSI, MSG/S, N/E/S/W compass | standard symbols per task rules |
| HUD classification banner `TOP SECRET // SI-TK // NOFORN` | fictional visual-design marking, pinned by source-shape tests |
| `data/dataCredits.js` attribution lines | legal text kept verbatim (may gain a gloss later without replacing the original) |
| Analyst spec-error templates, director field-validation messages | model-/developer-facing diagnostics |
| Third-party content (live feeds, provider pages, model voices) | outside own UI; speech audio language follows the realtime model, documented in README |

### Known gaps (honest ledger)
- HUD summary provenance lists layer registration names (English) — the
  summary line prefix/state is zh, names stay matching keys.
- Loading-chip detail lines that embed producer `statusMessage` strings
  (e.g. `adsb.lol · 250nm regional fallback`) keep the producer's English.
- Some state-held error/status lines re-render on their next data tick rather
  than instantly at switch (directions/routing errors, firms context records,
  cockpit pushed signal rows ≤250 ms, transient voice `say()` lines).
- Story/evidence titles inside `event.json` (Bhote Koshi data) and recipe shot
  titles stay English (join keys for packs/append matching).
- Voice replies generated by the realtime model follow the model's language,
  not the UI locale; the app's own spoken lines and cards are zh.
- `globePanelRuntime.js` (MCP host fallback UI) remains English (import-free
  surface).

## Automated checks

Numbers below were re-run against the acceptance-review fixes on
Windows / Node 24.16.0 / Chrome 152, dev server on `localhost:4173`
(2026-10-10). Every gate row states what actually ran on THIS commit and
what remains environment-blocked.

- `npm test` — measured on the current merged head (upstream/main of
  2026-10-10 merged into the i18n-only chain): **6,279 tests; 6,268 pass,
  1 fail**, the baseline `codexOauthRealtime` Windows fixture. Upstream's
  new surface was localized as part of the merge (source-unavailable
  layer state, route-source error messages at the display edge, the AIS
  awaiting-positions label); `check:boundaries` and `build` stay green.
- `npm run test:track` — 106/109 functional assertions pass on the merged
  head; the 3 failures are the "no console errors" checks tripped by this
  machine's network dropping Google Fonts / Esri / terrain hosts
  (ERR_CONNECTION_CLOSED) mid-run — the same environment class the
  reviews recorded, not locale failures.
- `npm run test:track` — **109/109**, re-run on the current commit.
- `npm run format:check` (1,380 files), `npm run check:boundaries`,
  `npm run build` — green.
- i18n suites: `core.test.mjs` (13), `browser.test.mjs` (10, incl. the
  privacy-mode getter/getItem/setItem guards), `locales/parity.test.mjs` (3),
  `bootMarkup.test.mjs` (5), `cctvSyncChip.test.mjs` (5: loading →
  grid-ready → locale switch keeps the completion semantics and the dwell
  timer, including the REAL subscription order — state render pass first,
  then the label repaint — so the render pass cannot clear the ready mode).

### Locale-relevant browser gates (this commit)

| Gate | Result on this commit | Notes |
| --- | --- | --- |
| `qa:panel-resize` | pass (2026-10-09/10 acceptance runs) | locale-independent |
| `qa:map-source-tray` | locale assertions fixed; **2 environment failures remain** | The gate pins `en`; the Esri fallback message asserted in English renders correctly (80 assertions pass). The remaining failures are network-environmental on this machine: `services.arcgisonline.com/?f=json` is CORS-unreachable (Esri classifies "unavailable" instead of "tile requests failed") and Bing `http:` tile probes are CSP-blocked, tripping the "no console errors" check. Not locale- or translation-related. |
| `qa:street-level:fixtures` | **fail at step 13 in this environment (flaky)** | Steps 1–12 pass (the earlier zh `BUTTON:开` failure is fixed by the locale pin). Step 13's photo click intermittently misses selection (`selectedId:null, images:0`) — observed on cold servers and after Google-3D network failures push the globe to the OSM fallback basemap; it passed 29/29 twice on a warmed server on 2026-10-09. The gate now re-finds the pick and retries the click (bounded) instead of a single shot. Environment/timing, not locale; needs an upstream look at pick-routing under the OSM fallback. |
| `qa:transit-heading` | pass 5/5 | launch no longer hardcodes the macOS Chrome path (`GEV_QA_CHROME` > historical path > puppeteer default) |
| `qa:transit` (full) | launch fixed; Boston section times out here | 12/12 heading-regression assertions pass on Windows; the MBTA section waits 90 s for real GTFS-RT vehicles — live-feed dependency. |
| production `build` + `preview` | **re-verified on this commit** | headless zh boot: canvas renders, `无处遁形`, param-panel aria `折叠 参数`, no page errors. |

### Browser acceptance matrix notes

Live matrix verified 2026-10-09/10 (zh/en first paint, saved vs detected
locale, persistence, no-reload switching with tracked contact preserved,
XSS-inert interpolation, share protocol intact, 1440×900 / 1024×768 /
800×600). Re-verified after the acceptance fixes in a throwing-localStorage
privacy-mode browser session (boot succeeds; `展开 数据图层` / `折叠 显示`
/ `折叠 参数` labels; zh chips; no page errors) and a live zh↔en switch
confirming the param-panel aria follows the locale
(`折叠 参数` ↔ `Collapse PARAMETERS`).
