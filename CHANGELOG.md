# Changelog

## ALPR camera locations

- Label the loaded camera count as nearby, show a purple-dot legend, and add
  SHOW NEAREST to frame and select a loaded camera when none are on screen,
  using the available 3D-tile or globe terrain height.

- Keep nearby camera markers and selection stable during rotation, use bounded
  ground-centered coverage instead of the horizon rectangle, and reuse in-flight queries.

- Add optional, source-labeled OpenStreetMap ALPR camera locations, bounded city queries,
  cached-response and coverage notices, selection cards, share links, and voice toggles.
- Separate the request adapter, camera model, presentation, and instance lifecycle.
  Source cancellation also guards late response bodies and rejects invalid query bounds.

## Release disabled infrastructure rendering

- Remove built Data Center, Dam and Submarine Cable entities when their layers
  are disabled, avoiding retained visualizer work and entity memory.
- Keep parsed datasets cached for re-enable; rebuild entities without refetching.

## Camera layer components

- Separate camera source requests, placement, frames, projection, cards and calibration.
- Own visibility listeners and pending initialization within each layer lifetime.
- Preserve existing camera catalogs, URL families, geometry and playback behavior.

## Traffic and bikeshare components

- Separate traffic loading, animation, styling and lifecycle into factory-owned components.
- Give each flow source its own bounded decode cache and cancellation checks.
- Separate bikeshare registry, station requests, rendering, selection and proximity handling.

## Installation and context components

- Separate mapped-site requests, records, placement, selection and viewport lifecycle.
- Separate proximity queries, subject tracking, navigation/history, panel and direction rendering.
- Retain source and ground-floor ownership in standalone composition; reject malformed
  installation snapshots and ignore failures from cancelled requests.

## Satellite and mission layer components

- Separate catalog loading, orbit calculations, display, tracking and interaction
  into instance-owned satellite components.
- Separate mission ingestion, paths, placement, cards, roster, replay and camera
  operations, retaining existing layer controls and satellite coordination.
- Cancel late mission source work and reject malformed launch snapshots.

## Fire layer components

- Split fire source loading, state, rendering, cards, selection and viewport work
  into reusable components with application-owned scene services.
- Cancel late refreshes, retain good data after malformed responses, and preserve
  selection identity without repeating a user-selection notification on refresh.

## Earthquake components

- Separate earthquake snapshot loading, record validation, and display ownership.
- Cancel pending earthquake refreshes on disable or destruction, retaining the
  last good snapshot after malformed or failed refreshes.

## September 8, 2026

Earthquake refreshes validate the complete feed and construct replacement entities before clearing the previous snapshot. Malformed rows and duplicate rendered IDs retain the last good entities, overlays, count and timestamp and report a malformed response; unknown magnitude is excluded from M2.5+ rendering.

Non-object or array-valued properties reject the response instead of being treated as an unknown magnitude.

Launch payloads with missing records now say PAYLOAD DATA UNAVAILABLE. Missing names use Unnamed payload; absent or invalid mass stays unknown instead of appearing as 0 KG.

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [Unreleased]

### Added

- Added the Ocean Currents field layer (share token `n`): an animated
  streakline rendering of the surface-current field over the camera's view,
  served by `/api/ocean/field` as a two-tier ladder — IOOS HF-radar total
  vectors (0.5–6 km, hourly) put through QC gates and a two-pass Barnes objective
  analysis with holdout cross-validation where the network reaches, and NOAA
  CoastWatch's geostrophic-only 0.25° altimetric analysis everywhere else. The legend
  names the tier, its dataset, its age, its coverage over water, and (for
  radar) the holdout RMSE, so an observed 1 km field and a two-day-old 28 km
  model field are never presented as the same thing, and a view served by both
  is labeled `composite` and states the split. Coverage is measured over
  water cells using the bundled GSHHG mask, and cells with no data are drawn as
  nothing rather than as slack water. Tier logic and ingest live in
  `src/server/ocean/*` rather than in `vite.config.js` (issue #41).
- Added the Ocean Conditions layer: ~900 NOAA NDBC buoy stations from one
  server-cached bulk feed, of which the 20–30% that report significant wave
  height are color-banded by it (the reporting fraction varies by hour; three
  same-day samples gave 20.5%, 21.9% and 29.7%), with
  sparse observation cards, Open-Meteo Marine forecast lines (`FC`-labeled),
  ocean-point forecast cards, analyst-query coverage, voice aliases
  ("buoys", "sea state", "waves"), and share token `o`.
- Added a person-overboard drift Monte Carlo MVP: USCG PIW-1 leeway
  coefficients (Allen & Plourde 1999 / Allen 2005; Breivik & Allen 2008
  formulation), 10⁴-particle ensembles run in a worker over a 5×5
  Open-Meteo forecast grid, rendered as a scrubbable particle cloud labeled
  `SIMULATED DRIFT ENSEMBLE — NOT A SAR PRODUCT`, started from a `▶ DRIFT`
  chip on buoy and ocean-point cards.
- Added a bundled global land/sea mask (GSHHG-derived, 1/8°, three-state)
  that gates ocean clicks instantly — land clicks produce nothing, water
  clicks get their card and DRIFT chip before any network round-trip, and
  coastal cells keep the honest live-probe fallback.
- Added drift-particle beaching: ETOPO bathymetry (2 arc-min, `z ≥ 0` ⇒
  land, with the bundled mask as offline fallback) freezes particles at
  their last water position, recolors them, and the scrub panel reports
  `⚓ N beached`.
- Upgraded the drift integrator from forward Euler to classical RK4
  (convergence-tested against closed-form trajectories), added a per-step
  turbulent-diffusion term, a deterministic control particle (particle 0:
  unperturbed best-estimate track), and mean-drift/spread diagnostics.
- Added a drift parameter window: horizon (6/12/24/48 h), particle count,
  turbulence σ, FORECAST/HINDCAST direction, and a RERUN button that
  re-runs the same seed with new parameters. Backward (hindcast) runs are
  labeled `REVERSE DRIFT — origin hypothesis` and clock as `T−hh:mm`; the
  forcing grid now carries 48 h of past hours to feed them.

### Changed

- The HF-radar Barnes length scale is retuned from `L = 2d + 6 km` to
  `L = 2.05·d`, with a 2.05 km floor, putting the two-pass half-amplitude
  wavelength at 4× the observation spacing instead of 10.5×. The old rule
  smoothed the 2 km product to a 19.5 km half-amplitude scale — barely finer
  than the global tier it exists to improve on — and its response at the data's
  own Nyquist wavelength (2Δ = 3.7 km at a measured 1.86 km spacing) was
  0.0000. Measured effect on a live offshore Monterey box: holdout RMSE 0.069 →
  0.043 m/s at full coverage. The trade is spatial reach: a narrower kernel
  constrains fewer cells, so on a 1° coastal box the radar share of the
  composite falls from 30% to 11% and HYCOM fills the rest.
- The drift simulation's initial position scatter is now a labelled control,
  **last known position uncertainty**, with three bands — witnessed 300 m,
  estimated 1 km, uncertain 5 km — defaulting to 1 km rather than the previous
  hardcoded 300 m. It is a physical uncertainty (how well the entry point is
  known), not a display parameter, and the spread the panel reports is
  uninterpretable without it; a 300 m assumption on a position that was actually
  estimated understates the search area.
- The Ocean Currents layer's global tier is now **HYCOM ESPC-D-V02** rather than
  NOAA CoastWatch's blended altimetry. The altimetry product is
  `surface_geostrophic_eastward_sea_water_velocity` — absolute geostrophic
  velocity and nothing else: no Ekman, no wind drift, no tides. Measured against
  OSCAR (geostrophic + Ekman + buoyancy) over 77,715 matched cell-days, its
  missing ageostrophic component is 0.176 m/s RMS globally and 0.351 m/s within
  10° of the equator, where the omitted signal is comparable to the retained
  one; its own near-real-time and delayed-time versions differ by 0.228 m/s RMS
  over 79,365 matched pairs, which is 2–3× the HF-radar tier's reported error;
  and its measured effective resolved wavelength is ~300 km, not the 0.25° its
  grid implies. HYCOM is a primitive-equation forecast carrying wind-driven flow
  and eight astronomically forced tidal constituents on a 0.04°×0.08° grid at
  3-hourly steps from −10 d to +5 d, so it is physically comparable to the
  HF-radar tier — which contains tides — instead of merely adjacent to it. The
  altimetry product is retained as an automatic fallback, and the legend names
  whichever source served along with its physics.

### Fixed

- **The HYCOM tier never actually served.** `parseHycomAscii` required both
  velocity components to carry a coordinate map named exactly `time`, but the
  THREDDS FMRC aggregation numbers the two axes apart — the `.dds` declares
  `water_u[time]` beside `water_v[time1]` — so the parser rejected every
  well-formed response as shape drift and `globalTier` fell through to the
  altimetry fallback on 100% of requests. Measured across five disjoint boxes
  (Monterey, mid-Pacific, North Sea, antimeridian, equator): 5/5 failed against
  a healthy upstream, and renaming `time1` to `time` in a captured body made the
  same parser succeed. The time map is now matched by family, which is safe
  because the two axes are the same axis under two names (max |time − time1| = 0
  across all 129 steps) and the cross-component equality check on the VALUE
  still refuses a genuine mismatch. The test fixture reproduced the server's
  variable *ordering* quirk but not its *naming* quirk, so all 52 of the
  module's tests passed against a body the server never sends; the builder now
  emits the real shape, which turns 10 of them into a regression guard.
- A forecast field is no longer labelled `just now`. `fieldGrid.resolveAgeMs`
  clamped its input with `Math.max(0, …)`, discarding the negative `ageMs` that
  HYCOM reports on purpose for a step valid ahead of now, so a field valid five
  days out rendered as a just-published analysis with `stale: false` — the one
  substitution `hycomCurrents.js` had gone to trouble to avoid. The sign is kept
  on the fetcher-reported branch (measured against *now*) and still clamped on
  the derived branch (measured against the *requested* instant, which may be
  historical); `formatAge` renders a negative age as `4 days ahead`;
  `isForecast` / `forecastLeadMs` ride through `provenance` and `sources[]`; and
  the caveat that fires for a future valid time now distinguishes a forecast
  step from the altimetry fetcher's "newest published step" limit.
- The Ocean Currents layer reported no status at all. It exposed `getStatus()`
  while `DataLayerManager` reads `getStats()` and early-returns a
  `{count: 0, lastUpdate: null}` stub for anything else, so the DATA panel row
  showed a blank count and "never" permanently — including while `refresh()` was
  failing. It is the only one of ~25 layer modules that used the other name. The
  contract test asserted the wrong name too, certifying the break rather than
  catching it; it now drives `DataLayerManager._moduleStats` itself. `getStats()`
  also reports which rung served, so the row cannot advertise HF radar over a
  view that is 89% model fill.
- `/api/ocean/field` answered HTTP 500 `ocean proxy error` for every malformed
  request. `normalizeBox` signals refusal by throwing, so the handler's
  `if (!box)` 400 branch was unreachable and the throw fell through to the outer
  catch. Verified live against five invalid inputs, all 500 before and 400 after.
  A new `tryNormalizeBox` returns the refusal instead of throwing, bounds are
  read for presence rather than finiteness (`Number(null) === 0` turned an
  omitted bound into a valid zero), and the 400 names which bound was wrong.
  Four route-level tests now drive the middleware; previously all 26 tests in
  `oceanProxy.test.mjs` called pure helpers, leaving dispatch, method checks and
  status codes covered by nothing.
- The bundled land/sea mask no longer puts a Node builtin in a browser module.
  `data/landSeaMask.js` branched on an `isNode` check around a dynamic fs
  import, reintroducing exactly what upstream removed in `6d83bb6`; Vite
  externalizes `node:*` for the browser and only warns, so it survived the
  build. The binary asset has no import-attribute equivalent, so it is now two
  modules over one pure codec — `data/landSeaMask.js` fetches, the new
  `server/landSeaMaskNode.js` reads the file — and `browserModuleBoundary.test.mjs`
  gains a second assertion that no browser module imports from `src/server/`,
  which is what makes excluding that tree from the first assertion sound.
- Voice could not turn the current field on. `ocean-field` was in the layer
  registry and `main.js` but in none of the tool enums and had no aliases, so
  "show me the ocean currents" resolved to `ocean-conditions` — the buoys.
- The global tier was described as "blended geostrophic + Ekman" in four places.
  It has no Ekman component at all; the dataset's CF `standard_name` is
  `surface_geostrophic_*_sea_water_velocity` and its metadata contains no
  mention of wind. Corrected in `fieldGrid.js`, its `@file` block, the
  `provenance.method` string the legend renders from, and `DATA_SOURCES.md`.
- The drift forcing grid is now georeferenced to the coordinates Open-Meteo
  **served**, not the ones requested. Open-Meteo snaps each requested point to
  its own 1/12° cell centre, so the requested lattice attributed every velocity
  to a point it was not sampled at — bounded by the cell half-diagonal, 5.94 km
  at 36.8°N, and measured at 3.87 km max / 3.82 km median over the Monterey
  grid. Correcting it moves a 24 h ensemble endpoint 1.315 km on a 10.227 km
  drift. Separately, upstream answers a request that lands on land by
  substituting a different cell's water, observed up to 22.5 km away; those
  nodes are now identified against their row/column consensus and **dropped**
  (their series blanked to a NaN gap) rather than georeferenced at all. The
  payload reports `maxNodeSnapM`, dropped-node counts, and the marine-vs-wind
  endpoint skew.
- A 48 h drift run no longer silently integrates its tail on a frozen field.
  `forecast_days` was 2, whose axis ends at (today + 1) 23:00 UTC, giving a run
  launched at hour *h* only (47 − *h*) hours of forward lead — so **every** 48 h
  run extrapolated past the end of its forecast, by 1 to 24 h, while reporting
  `degraded = false`. Measured cost at Monterey: the mean endpoint shifted
  10.653 km against a correctly-forced mean drift of 5.575 km. The request now
  covers the longest offered horizon, and time clamping is reported separately
  from value gaps (`clampedInTime` / `clampedFrames`) because they are
  different failures.
- Two overlapping drift starts no longer leak a GPU collection and a DOM panel.
  `start()` awaited seconds of I/O before taking ownership, and `dispose()` only
  ever reached the current run, so the orphaned panel's callbacks kept driving
  the surviving simulation. A monotonic run token now retires the superseded
  start at every await.
- The drift simulation can run more than once: disposing a run no longer
  destroys its particle collection twice (Cesium's `PrimitiveCollection`
  destroys on `remove`), which had bricked every start after the first.

- Separate map source factories from switching and resource ownership; retain current source IDs, attribution and fallbacks.

- Separate radio directory loading, station selection, globe presentation and playback into composed components with an explicit metadata source.

- Separate submarine cable sources and rendering components, and export bundled geography lookup modules.

### Fixed

- Traffic now retries a failed destination after city navigation without a layer
  toggle. Camera departure cancels pending work, arrival checks the final view,
  and superseded requests cannot keep a newer view loading.

### Added

- Add Ontario 511 as a keyless CCTV source pack, including Kitchener-area
  highway cameras, with server-registered still URLs and attribution.
- CCTV Mesh adds Finland: Fintraffic road weather cameras, keyless, nationwide, 300 by default. Each camera view of a station is placed separately; ambient stills refresh on the source's 10-minute cadence (the active camera keeps the usual 10-second refresh).
- Add DriveBC highway cameras for British Columbia to the CCTV layer: the 250
  nearest Vancouver and Victoria by default, with Open Government Licence –
  British Columbia attribution. `CCTV_DRIVEBC_MAX_SOURCES` sets the cap and
  `CCTV_DRIVEBC_ENABLED=0` turns the pack off.
- Add TxDOT highway cameras for Texas as a keyless CCTV pack: the Austin and
  San Antonio districts by default (`CCTV_TXDOT_DISTRICTS` selects any of the
  25), only cameras reporting Device Online, snapshots decoded from TxDOT's
  JSON-wrapped JPEG for the official origin only.
- Add Estonia CCTV source packs: Tallinn intersection stills (`ristmikud.tallinn.ee`,
  curated catalog) and nationwide Transpordiamet / Tarktee road-weather cameras
  (DATEX2 locations + rotating JPEG URLs), with Tallinn city POIs and attribution.
- Add a Warendorf (Germany) source pack: the Stadt Warendorf Marktplatz webcam, with a
  curated pose.
- Add Live Traffic NSW (Transport for NSW, CC BY 4.0) as a keyless CCTV pack: 217
  Sydney and regional cameras with compass headings and view descriptions.
- CCTV monitor planes no longer clip into the terrain. The plane is lifted
  rigidly by the largest clearance deficit over a 3×3 grid of support points
  against the ground under each (the ground at the mount where nothing finer is
  known), and the client honours pack ranges instead of inflating them to 220 m.
  `src/data/local_data/cctv_ground_heights/` ships precomputed ground heights under
  every camera's mount and plane footprint (3,445 of 3,446 cameras), aligned to work
  with Google Photorealistic 3D Tiles; cameras with shipped heights are placed
  with zero runtime sampling, and the rest resolve the ground under their plane
  from the Re:Earth DEM on activation. The footprint lift is capped at 60 m
  above the mount-based lift so a tower under a far edge cannot launch the plane.

- Press backtick (`) to toggle a rendered-frame-rate readout beneath the logo.
  Typing fields retain the key; monitoring stops when hidden.


- Extract vessel feed, store, rendering, selection, trail and card components with explicit source and scene services.
- Bound contact retention for incomplete vessel observations, preserve source freshness and refresh history references in place.
- Cancel pending vessel history during selection and layer teardown.

- Split military flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Share the existing aircraft calculations and give military classification an explicit source and cleanup lifecycle. Preserve known military identities even when the source has no position for them.

- Split civil flights into instance-owned state, ingestion, motion, rendering, tracking and query components. Cancel enrichment on teardown and resolve model assets through the application.

- Separate aircraft/vessel transport and normalization from layer rendering, preserving observation timestamps, altitude datums and optional history.
- Retain absent aircraft during partially admitted snapshots and bound source error messages.

- Drive share updates, Location feedback and Scene controls through immutable state snapshots and disposable subscriptions.
- Keep stale lookup/load completions from publishing accepted results and retain shot rows during playback progress updates.
- Export the existing Scene director with explicit playback and editing outcomes.

- Separate UI assembly from standalone engine wiring, with dedicated panel layout, position, notice and recording owners.
- Stop pending UI presentation and drag work during disposal; preserve accessible status text when stopping its decoration.
- Organize component styles behind the same ordered stylesheet entry and include 3D model controls in the current-state snapshot.

- Separate Scene controls and text presentation from project/playback operations; revoke replaced row listeners and suppress stale completion feedback.
- Preserve shot-label identity on selection so double-click rename can complete.

- Split Cockpit camera/controller, instruments, briefing, signals and layout into focused modules with explicit application operations.
- Give Display portal moves cancellable focus/scroll restoration and stop Cockpit work before asynchronous UI teardown.

- Separate Context controls, mode transitions and layer restoration; release tab listeners and suppress late panel/search feedback after disposal.

- Separate camera-panel controls, frame loading, calibration editing and status display; cancel stale image and calibration work on camera changes or disposal.

- Restore UI observer, resize-listener and CCTV subscription cleanup after Location extraction.

- Extract Radio controls and tuner presentation with explicit actions and complete listener/subscription cleanup.

- Extract Location controls and cancellable search presentation; preserve navigation handoff and prevent delayed POI expansion after closing the row.

- Separate Layers panel presentation and clear-control bindings from layer lifecycle operations; revoke listeners and subscriptions on replacement or teardown.

- Extract Map Source controls with listener cleanup and protection against obsolete selection feedback.

- Separate visual effects, presets and animation from Display controls, with explicit stage ownership and teardown.

- Extract Display control bindings with synchronous listener cleanup; preserve existing visual actions and native input behavior.

- Extract application shortcuts and shader-parameter controls into reusable UI
  components, preserving inputs and cleaning up listeners on rebuild/disposal.

- Extract adaptive panel rail placement and measurement into reusable UI modules,
  preserving obstacle clearance, responsive allocation, disclosure and scroll behavior.

- Extract shared surface keyboard handling for the welcome launcher and Provider
  Settings, preserving Tab/Escape behavior and releasing the listener on teardown.

### Added

### Security

- Validate configured Google Places coordinates and text queries before rate
  limiting or upstream requests; preserve the keyless capability response.
- Bound CCTV media response headers to 15 seconds and cancel error bodies.
  Cap buffered snapshot downloads at 16 MiB while streaming.


- Cancel the active location lookup when its controls are disposed.


### Fixed

- Extract panel disclosure and hover/focus controls into a reusable module;
  cancel their listeners and pending work during replacement and teardown.

- Reuse cached military aircraft during adsb.lol rate limits and server errors,
  honor bounded retry delays, and preserve cached observation times and stale
  indicators. Show installation zoom guidance without a false LOAD FAILED.

- GBFS rejects upstream redirects, caps streamed responses at 5 MiB, and keeps
  its deadline active through body reads. Rejected downloads are cancelled.


- Split Overpass/installation search, regional briefing/weather, local voice
  handlers and standalone key setup into focused modules. Preserve routes,
  source behavior, tool schemas and credential restrictions.

- Restore data-provider routes under local build preview and return JSON 404s
  for unmatched API requests. Credential editing remains development-only.

- Extract CCTV catalog/media and Radio Browser directory providers into focused
  Node modules, preserving their routes and policies and isolating CCTV catalogs
  by provider instance and application root.

- Simplify POWER UP to one Google Maps entry. Keep the optional server key
  available through environment configuration without a second setup row or
  missing-key reminder.

- Separate terrain, traffic, FIRMS and GBFS middleware into focused provider
  modules, preserving local configuration, routes and cache/error behavior.

- Split satellite and launch-feed server providers into focused modules with
  portable request URL builders, preserving routes and cache/error behavior.

- Keep landmark names when geocoding returns only address components, preventing
  the United States Capitol annotation from moving to a Washington hotel.
  Unrelated outlines leave the valid geocoded marker in place.

- Split aircraft and vessel server providers into focused modules for source
  fetching, AIS records/tracks and shared request helpers; preserve existing
  routes, local setup, fallback behavior and rendering.


### Changed
- Separate explicit browser build settings from standalone environment loading
  and local provider middleware. Preserve provider behavior and root named exports.
- Rename standalone browser startup to `src/standalone/` and add a Node-only
  `gods-eye-view/build/vite` export with checked package ownership.


### Development

- Extract application lifecycle and viewer exports. Split standalone startup into
  scene setup, controls, layer registration, tools and loading UI. Startup failure
  and terminal shutdown release acquired resources and cancel delayed work.

- Adopt Prettier tooling contributed by RohanDaCoder (#227), with an explicit
  file scope, pinned formatter and Linux/Windows CI checks. Format the reusable
  infrastructure modules and their consumer tests. Package boundary checks keep
  those exports separate from app startup and local Node services.

### Fixed

- Reduce terrain-height timeouts when Re:Earth slows down. Batches are
  sized against measured response latency on both browser and server to reduce
  request timeouts, and a partial upstream failure now
  keeps the heights that did resolve rather than discarding them. A position
  the upstream answers with no height is reported as an absent reading instead
  of a failed refresh, so the log distinguishes a slow or broken upstream from
  one that simply has no value for a coordinate.

- Separate optional Google server credentials for Places and Street View from
  the browser key, contributed by Tom-Neverwinter (#110). Provider Settings,
  Pinokio's app-specific credential handling and setup diagnostics recognize
  both keys. The Street View tool prefers the server key across environment
  and `.env` sources. Existing single-key and keyless setups remain supported.

- Complete the first-run, view-target prewarm, cockpit-plates and floor-hold
  browser harness renderer portability fixes contributed by Tom-Neverwinter.
  macOS retains Metal; other platforms default to SwiftShader. Cockpit renderer
  assertions and evidence labels follow the actual selected mode. Floor-hold
  explicitly selects its measured 2D billboard mode and keeps its mesh and terrain assertions; software runs are not real-GPU evidence.
  First-run QA now checks the existing attribution Escape-close/focus-return
  behavior while preserving the launcher-underneath regression checks.


- Datacenter and dam factories are available through scoped package exports with
  explicit context, overlay and render callbacks. The standalone app uses the
  same implementation and bundled datasets.

- Local GeoJSON layers share concurrent loads, cancel pending fetches on destruction,
  discard late results, and remove their entity-context records on teardown.

- Unchanged local infrastructure overlays no longer sustain idle rendering.
  Ground samples wait for visible terrain to settle and cannot place a marker
  below its loaded surface; roofs and valid below-sea-level heights are retained.
  Already sampled markers also follow higher terrain as close-up tiles refine.

- Datacenter and dam marker stems use bounded, zoom-dependent active sets with
  stable selection during camera motion. Close-up stems scale to the actual
  camera distance; source totals and submarine cables remain unchanged.

- Keyboard focus rings now survive active/selected button styles across the
  interface. Visual Styles, Location cities and points of interest, search,
  Context/mission actions, Cockpit utilities, and sliders retain a distinct
  focus indicator.
- A short Space press activates a focused control only on key release. Holding
  Space for 500 ms blurs that control before push-to-talk starts, and release is
  then consumed so it cannot also activate the old control. The same hold works
  from the map or page background; text-entry controls remain protected.
- The Location disclosure is reachable with Tab and shows keyboard focus;
  its city, point-of-interest, and search controls do too. Escape from inside
  the tray returns focus to its disclosure and discards any unfinished search;
  Escape on the disclosure itself closes the tray and clears that focus.
- Data Layers ON/OFF buttons show a keyboard focus ring independently of
  their enabled and feed-status colors.
- Display buttons, layout selectors, mode buttons, and sliders show a visible
  keyboard focus ring, including the controls used in Cockpit Display. Enabled
  CCTV camera dropdowns also show keyboard focus.
- Context tabs keep a distinct keyboard ring when selected. Their existing
  Left/Right arrow navigation continues to switch Contacts and Space Missions,
  and both choices remain reachable through ordinary Tab navigation.
- Tabbing through the Space Missions roster now drives the same temporary globe
  rotation and mission-marker highlight as pointer hover, without selecting the
  mission. Keyboard and pointer previews no longer cancel each other.
- Radio power controls, Search Nearby Sites, and Clear Selected Layers retain
  keyboard focus while their async work is busy. They expose that busy state to
  assistive technology and ignore repeated activation until the work settles.
- Live Contacts results retain keyboard focus by contact identity when counts,
  distance order, or pages refresh. If a focused contact departs or rotates off
  the visible page, focus moves to the named explanatory note at the end of the
  list and survives later refreshes there, so the next Tab proceeds beyond the
  list instead of restarting at Contacts or silently selecting another contact.
- Cockpit Live Signals retains keyboard focus during live updates and contact
  reordering, allowing Tab to continue to Display and Radio. If the focused
  contact leaves the list, focus moves to the current briefing tab.
- Cockpit-only Display and Radio launchers show complete inset focus rings.
- Escape collapses the nearest expanded panel containing keyboard focus and
  returns focus to that panel's disclosure when closing from its contents.
  Escape on the disclosure itself closes without leaving the collapsed control
  focused. Cockpit Contact and Live Signals panels follow the same nesting rule.
- Cesium's bottom-left Data attribution control and lightbox Close control are
  in the Tab order and support Enter and Space. Close, Escape, and backdrop
  dismissal restore focus and synchronize the disclosure state.

- CCTV testing uses the normal launcher for keyless startup, credential loading,
  localhost binding, and explicit LAN-exposure warnings while retaining its
  smaller source-pack limits.
- CelesTrak, Launch Library, terrain-height, and aircraft-enrichment failures
  return generic error messages. Related diagnostics omit raw exception details
  and upstream error bodies; response statuses and cache fallback remain intact.
  Includes the security fixes contributed by Tom-Neverwinter in PR #171.

### Fixed

- Map Source keyboard opening retries focus until the selected tile is visible.
  Leaving the disclosure, pointer interaction, or closing the tray cancels the
  pending handoff so delayed work cannot pull focus back.

- Scope, Bloom, Sharpen, location search and generated style sliders expose
  explicit accessible names. The first-run checkbox retains its native label.
- FIRMS records a source as successful only after appending its rows, avoiding
  contradictory success/failure status if aggregation throws.
- Radio country filtering and voice country requests now resolve common English
  names and exonyms that `Intl.DisplayNames`' primary label omits, so requests
  like "play radio in Turkey" no longer fail closed (Turkey → Türkiye, plus
  Myanmar/Burma, UAE, Holland, Swaziland, East Timor, Cabo Verde, Vatican).
  Ambiguous names such as a bare "Congo" or "Korea" still fail closed.
- Mapped-site outages show their scheduled retry countdown and distinguish
  known Overpass rate limits, timeouts, and query failures. Search feedback no
  longer claims a refresh succeeded while the layer is unavailable or loading.
- Mapped installations retain valid ways and relations that provide bounds but
  no center. Invalid, inverted, and excessively wide bounds are rejected.
- Clicking a selected installation again or clicking elsewhere clears its
  selection; later refreshes no longer reclaim it after a click-away.
- Visual presets explain their effects on hover. Unavailable map sources name
  missing credentials and Provider Settings, while configured-but-failed
  Google 3D routes explain the failure without asking for another key.

- The Overpass proxy now rotates to the next mirror on any non-2xx upstream
  response, not only on 5xx. `overpass-api.de` and its `lz4` alias answer 406 to
  the proxy's User-Agent while two of the configured mirrors answer 200 to the
  identical request, so the fan-out stopped at the first refusal with healthy
  mirrors untried. The refusal was also cached to memory and disk and served as
  data — boundary-class queries hold a month-long TTL — which affected every
  Overpass-backed feature: road geometry, annotation outlines and place lookup.
- Existing cached refusals are now ignored immediately, including during
  stale-data fallback. Concurrent identical requests share the same last-good
  fallback when all mirrors refuse, without duplicating upstream requests.
- A keyless place lookup no longer remembers a network failure as "no such
  place". A blip while Photon was answering used to be memoized for the rest of
  the session, so the query kept returning not-found from memory on a network
  that had since recovered. A miss is now cached only when every source
  consulted actually returned a verdict.

### Added

- Keyless place search. The LOCATION search box and the `fly_to_location` voice
  tool now resolve place names through Photon (komoot, over OpenStreetMap) when
  no Google Maps key is configured — previously the lookup threw. Google stays
  the primary path and is unchanged when it answers; the fallback also covers a
  key whose Geocoding API is not enabled, which Google reports as HTTP 200 with
  `REQUEST_DENIED`, so an empty result is the detector rather than an error.
- The same keyless fallback now covers the remaining two place lookups: map
  annotations ("annotate the botanical garden") and the Radio layer's
  "near \<place>" selection. Radio previously threw without a key, which
  surfaced as a failed voice turn rather than as a station it could not place;
  annotations silently failed to anchor. Annotation footprints match OSM on the
  resolved feature's canonical name, so locality words in the request cannot
  pull the outline onto a neighbouring building.

- Refresh vulnerable transitive dependencies and update browser/image tooling
  to Puppeteer 25.10.0 and Sharp 0.35.4. Cesium remains on 1.138.0.
  Browser QA awaits the new asynchronous executable-path lookup.

## [0.1.1] — 2026-09-01 — Installation and live-data fixes

### Changed

- Tightened the README opening around keyless setup, source freshness, modeled
  experiences, and the accessibility of the provider stack.

### Fixed

- Pinokio now recognizes its nested successful-install marker, so a completed
  one-click install exposes Start instead of returning to Install.
- The keyless `dev-fresh.sh` startup summary now names Esri World Imagery with
  keyless terrain and identifies OpenStreetMap as the fallback.
- All three VIIRS sources now reach the Active Fires layer. Merging a source's
  detections used argument spread, which exceeds the engine's argument limit on
  the two largest sources and dropped them entirely — leaving roughly a third of
  global detections while reporting each dropped source twice, once as
  successful with its real count and once as failed.
- `./scripts/dev-fresh.sh` no longer crashes on stock macOS bash 3.2 when no
  provider keys are exported: expanding the empty external-keys provenance
  array under `set -u` was fatal there. Launches with exported keys are
  unchanged.

### Security

- GBFS proxy body-size cap now measures the response in bytes
  (`Buffer.byteLength`) instead of JavaScript string length, so the
  `GBFS_MAX_BODY_BYTES` limit holds for multi-byte payloads and cannot be
  overrun by non-ASCII upstream responses.

## [0.1.0] — 2026-08-31 — One-click install, keyless boot, Provider Settings

### Added
- **One-click install** via Pinokio. Keyless boot lands on a live Esri World
  Imagery satellite globe with keyless terrain; OSM takes over automatically if
  Esri is unreachable, and the globe continues without terrain if its source is
  unavailable.
- **Provider Settings** (the POWER UP panel): add, replace, or remove API keys
  inside the app. Credential files are made owner-only before any secret is
  written — verified on macOS and Windows — and keys configured outside the
  panel are shown read-only, never rewritten.
- **Keyless capability responses**: the optional HUD summary and place-search
  endpoints return a deliberate "not configured" success instead of errors, and
  never consume rate-limit quota.
- `.gitattributes` normalizes line endings, so Windows clones pass the full
  test suite out of the box (#81 — thanks @ethanstoner).

### Changed
- README rewritten keyless-first around the provider ladder: zero keys → free
  Cesium ion (eligible personal, non-commercial use) → billing-enabled Google
  Maps.
- Browser-built data modules no longer import `node:fs`; a repo-wide boundary
  scan test keeps it that way (#83 — thanks @ethanstoner).
- Aircraft-identity voice answers explicitly cover operator, type, and route,
  and say so plainly when enrichment is unavailable instead of guessing.

### Security
- Provider Settings answers only local, unproxied requests and disables itself
  entirely whenever the server is shared. Public datacenter and dam datasets
  omit contact-oriented fields (see the dataset READMEs).

## Pre-release development history

The dated entries and internal milestone numbers below predate the first
tagged GitHub Release. They are retained as project history and do not
represent previously published GitHub Releases.

## [Unreleased] — 2026-08-24

### Added

- Added honest aircraft identity narration: callsign, operator, registration,
  type, and route come only from selected-contact context, and missing operator,
  route, or type enrichment is named explicitly.
- Added local, publication-compatible copies of the two README PNGs, with source
  records and third-party-license boundaries in `docs/media/README.md`.
- Added regression coverage for aircraft identity narration and optional-key
  loading feedback.

### Changed

- First-run presentation now opens with Detection `DENSE` at 75%, `ELASTIC`
  allocation, Fade 7%, Outside 1%, scope feather 11%, and aircraft 3D models in
  `PROXIMITY`. Stored state and share links still override these baselines.
- The 17 selected README GIFs remain unchanged and are documented separately
  from the two owner-published PNGs.
- Bundled datacenter and dam snapshots now omit contact-oriented fields and
  note values containing email or phone identifiers. Feature geometry, names,
  operator/capacity/river metadata, counts, and ODbL terms are unchanged.
- Public documentation and the L9 release matrix no longer reference non-public
  planning material or repository history.

### Fixed

- A missing optional FIRMS key no longer turns the complete Environmental
  mission into `LOAD FAILED`. The FIRMS row still reports `KEY REQUIRED`, while
  earthquakes continue to load. Real lifecycle and fetch failures retain
  failure priority.
- The mapped-installations layer retries after an unavailable request when it is
  enabled or the camera settles.
- Aircraft trails attach to the rendered aircraft transform and remain near the
  rear center across headings. Parked aircraft do not draw a moving head
  segment.
- Grounded aircraft keep validated floor evidence through temporary terrain
  outages and wait for measured photoreal-surface evidence before a 3D model
  takes over from its billboard.
- Cockpit altitude uses aviation MSL data rather than Cesium render height.

### Security

- Production transitive dependencies resolve to patched DOMPurify and
  protobufjs releases without changing the Cesium version or application APIs.
- Production dependency audit reports no known advisories; remaining audit
  findings are confined to development and QA tooling.

## [Unreleased] — 2026-08-23

### Added

- Added a first-run mission launcher for Contacts, Space Missions,
  Environmental, and manual exploration.
- Added terrain-validity gating and bounded last-known placement for grounded
  aircraft models.

### Changed

- Environmental consistently presents both earthquakes and NASA FIRMS fires,
  with honest optional-key degradation.
- The tracked aircraft trail acceptance bar is visual: roughly rear-center,
  stable across headings, with minor hull overlap allowed and no conspicuous
  top, bottom, or lateral projection.

## [Unreleased] — 2026-08-18 to 2026-08-22

### Added

- Added the four-source Map Source tray, share-link v2 state, cockpit/context
  voice parity, MSL altitude readouts, and close-range tracked aircraft models.
- Added the L9 release-candidate matrix, AIS feed watchdog, voice cost controls,
  satellite classes, and the shared world-overlay host.
- Added deterministic first-run, map-source, floor, overlay, tracking, and
  aircraft-model regression harnesses.

### Changed

- Consolidated world labels, cards, tracked readouts, CCTV thumbnails, cable
  labels, mission labels, and detection presentation under shared allocation and
  lifecycle rules.
- Reduced idle rendering through the render governor and explicit scope mask.
- Improved cockpit layout, context restoration, keyless feed honesty, and
  aircraft 2D/3D handoffs.

### Fixed

- Fixed degenerate depth picks, map-source restore states, route-camera motion,
  bright-ground label readability, grounded display flooring, and cross-layer
  tracking cleanup.
- Fixed stale overlay callbacks, parked-idle render leaks, cable-label sweep
  starvation, and several share-link state conflicts.

## [Unreleased] — 2026-08-02 to 2026-08-16

### Added

- Added Global Context modes, Cockpit briefing surfaces, Radio context,
  satellite mission replay, and real per-class aircraft models with adjacent
  provenance records.
- Added a shared screen-space overlay system with bounded allocation for labels,
  cards, callouts, detection brackets, and selected-object presentation.

### Changed

- Unified right-side product controls and responsive cockpit/map layouts.
- Migrated public-safe neighborhood geometry to DataSF and tightened safe local
  development defaults.
- Improved proxy resilience, annotation outline bounds, CCTV enable pacing,
  contact de-emphasis, and deterministic visual stacking.

## [Unreleased] — July 2026

### Added

- Added live NASA FIRMS fires, optional live TomTom traffic, Caltrans and TfL
  CCTV packs, CCTV viewsheds and direct-manipulation calibration, citywide CCTV
  cards, Natural Earth regions, analyst queries, and voice routing QA.
- Added the end-to-end vertical-datum system for aircraft, vessels, CCTV,
  annotations, trails, and terrain-aware rendering.
- Added aircraft class silhouettes, path-derived display heading, ADSBDB
  enrichment, cached CelesTrak TLE lookup, and next-ISS-pass prediction.

### Fixed

- Fixed elevated-airport aircraft placement, vessel sea-surface placement,
  close-zoom FIRMS anchors, antimeridian region framing, annotation resolution,
  cross-layer tracking ownership, and CCTV projection lifecycle issues.

## [Unreleased] — June 2026

### Added

- Added OpenAI Realtime voice control, scene-aware entity context, viewport image
  grounding, the AI HUD summary, live AIS vessels, infrastructure layers, map
  source switching, free-text navigation, and server-side data proxies.
- Added hybrid map annotations, 3D aircraft, panoptic detection, tracking
  harnesses, and public data attribution.
- Added MIT source licensing, security guidance, contribution guidance, data
  source notices, and third-party asset boundaries.

### Changed

- Removed the experimental AI video-edit style and retained seven deterministic
  visual styles.
- Moved Realtime text-history trimming to the server-side retention policy while
  keeping only the latest viewport image in conversation context.

## [0.7.0] — 2026-02-18

- Added the Bikeshare Pulse layer and panoptic label improvements.
- Improved tracked-item boxes, post-render alignment, and CCTV projection
  quality.
- Removed the experimental shift-drag CCTV calibration interaction.

## [0.6.0] — 2026-02-10

- Added the initial multi-layer 3D globe experience, visual styles, live
  aircraft, satellites, earthquakes, CCTV, traffic, FIRMS, infrastructure, and
  performance controls.
- Added entity inspection, tracking, scenes, keyboard controls, and shareable
  views.

## [0.1.0] — 2026-02-09

- Initial project version.
