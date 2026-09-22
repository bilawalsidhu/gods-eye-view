# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

## [0.10.0] — 2026-09-20

New live layers (transit + synthetic traffic), the production regional-brief
API, two render-performance policies, and a quality-infrastructure wave:
strictest lint tier (sonarjs), 11 architecture decision records, an
aegis secrets gate in CI, and a coverage ratchet that fails on collapse.

### Added

- **Transit vehicles (MBTA + OVapi + MetroMN)**. A new `transitVehicles`
  layer polls keyless GTFS-Realtime `VehiclePositions.pb` feeds and renders
  each vehicle as a route-coloured point primitive on the globe. A 200-LoC
  hand-rolled protobuf decoder (`src/data/gtfsRtDecode.js`) reads the
  GTFS-RT subset the layer needs (FeedMessage → entity[] → VehiclePosition →
  trip/position/status/timestamp); the bundling trade-off (no
  `gtfs-realtime-bindings` + `pbf` peer-dep) is documented in the file
  header. The `/api/gtfsrt/<feedId>` proxy lives in both runtimes (Vite dev
  middleware + Cloudflare Pages Function) with shared policy in
  `src/data/gtfsRtPolicy.js` so they cannot drift. Camera altitude gate
  (enter ≤ 80 km, exit ≥ 100 km) hides the layer from space. 5000-vehicle
  hard cap so a future feed addition cannot silently blow the GPU budget.
  Attribution: MBTA, OVapi, Metro Transit developer feeds (3 credits added
  to `dataCredits.js`).
- **Synthetic traffic vehicles (TomTom-flow fallback)**. A new
  `syntheticTraffic` layer (`src/data/syntheticTraffic.js`) covers
  viewports that no GTFS-RT feed serves — most of the world. It reads
  the existing TomTom flow tiles via `fetchFlowForBounds()`, picks
  strided eligible segments, and animates 1–3 phantom vehicles per
  picked segment along the polyline via `CallbackProperty`. Speed is
  scaled by `trafficLevel × road_type` (motorway ≈ 30 m/s free-flow,
  residential ≈ 8 m/s), with a 0.05-floor so jams stay visible. The
  layer is bbox-aware: when the camera viewport intersects any
  registered GTFS-RT service area (`GTFS_RT_SERVICE_BBOXES` in
  `gtfsRtPolicy.js`), the layer auto-suppresses so real buses don't
  double up with synthetics. Camera altitude gate matches
  transitVehicles (80 km enter / 100 km exit). Hard cap 350 phantoms
  per refresh keeps the GPU budget honest. Attribution: the existing
  dynamic `TOMTOM_CREDIT` is registered on first enable.
- **Regional brief API on production**. The legacy always-empty Pages
  Function stub behind the cockpit's Regional News card was replaced by a
  real implementation shared with the dev middleware via
  `src/data/regionalBriefPolicy.js`, so production deployments serve the
  same briefs local development does (dev/prod parity contract, ADR 0003).
- **Aegis secrets gate in CI**. A bookworm-built aegis binary rides the
  `gev-ci-node:1` pipeline image; the GitForge security job scans for
  high-severity secrets against `.aegis-baseline.json` so only NEW
  findings fail the build. Documented allowlisted doc-keys stay allowlisted.
- **Coverage ratchet**. `test:coverage` runs c8 with floors (lines 91,
  statements 91, functions 90, branches 80) just below the measured
  baseline (91.58/91.58/91.21/81.19 on 2026-09-20) — the CI job gates
  collapse, not variance (ADR 0008).
- **Architecture decision records**. `docs/adr/` seeds 12 records covering
  the decisions a contributor can't derive from the code: single-source
  vanilla JS, Pages Functions as the canonical keyless runtime, enforced
  dev/prod parity, Cesium version pins, CRT first-run default, render
  governor, enforced CSP, the coverage boundary, the keyless contract,
  GitForge as primary CI, why prettier was declined, and the
  world-overlay lane host that all screen-space annotation renders
  through.
- **DATA_SOURCES.md parity test**. `dataCredits.test.mjs` now enforces
  two-way key parity between `dataCredits.js` and `DATA_SOURCES.md`, so a
  layer added to one cannot silently miss the other.

### Performance

- **Voice-only view-target prewarm.** The move-end → depth-readback prewarm
  (`scene.pickPosition` — the worst main-thread stall in the runtime profile,
  docs/PERFORMANCE.md) is now gated by an active voice session. While the
  Realtime controller sits at `idle`/`error` (the default for every
  non-voice session), the listener still registers for the camera-verbs
  contract but no longer triggers a depth readback. The controller flips
  the counter on every `setStatus` (`connecting`/`listening`/`executing` →
  on, `idle`/`error` → off). Voice tool callers see the same prewarm
  behaviour as before; non-voice users stop paying the readback cost on
  every camera move.

- **Render-resolution scale policy (HiDPI GPU/dedicated memory)**. Cesium now
  defaults `sceneResolutionScale` to 0.75 on displays whose `devicePixelRatio`
  exceeds 1.5, and 1.0 otherwise. The previous always-1.0 setting forced the
  backing store to CSS × DPR — ~106 MiB of color + depth on a 2560×1440 @ DPR
  2 display, with ~4× the per-pixel fragment cost. The 0.75 scale renders
  0.75² = 56.25% as many pixels — a deterministic ~44% (43.75%) reduction in
  color + depth backing-store bytes and in the per-pixel fragment-work bound.
  That figure is an arithmetic consequence of the resolution change, not a
  separately measured number; realized bandwidth savings vary with scene
  overdraw and texture traffic. Visible loss against the photoreal tiles is
  negligible (MSAA 2× hides the upscale). `?renderScale=N` (0.5..2) forces an
  explicit value for A/B capture. Policy lives in `src/sceneRenderScale.js`
  and is applied in `src/main.js` next to the existing tile-cache policy.

### Fixed

- **GTFS-RT proxy relayed bodies as bytes, not UTF-8 text** — protobuf
  payloads passing through the dev middleware as text could be mangled
  by re-encoding; both runtimes now relay `Uint8Array` bodies.
- **Synthetic-traffic phantoms frozen at ECEF origin** — an audit catch:
  vehicles animated around Cartesian(0,0,0) instead of their segment
  when a refresh raced a viewport move; plus cross-feed prune and
  bbox-suppression oscillation fixes in the same sweep.
- **Route dolly could seed its floor from an impossible mesh answer** —
  on a not-yet-streamed tile, `scene.sampleHeight` answered -14,971 m
  (RUN 3m's per-frame trace, software GL); the mesh probe adopted it as
  the floor and counted it as coverage, so the arming hold was skipped
  on a garbage `floorKnown` and the camera's first eye was set ~15 km
  underground before the per-frame raw clamp snapped it back.
  `probeMeshFloorM` now treats an answer outside the physical band
  (~-10.9 km trench to ~+8.8 km peak) as silence at the source — it
  contributes nothing and does not count as coverage — so the designed
  degradation (arming hold, safe seed, per-frame refinement) stays in
  force.
- **QA harness drift** (two deterministic reds, shipped code correct):
  `qa-floor-hold.mjs`/`qa-voice-wav.mjs` passed puppeteer 25's now-async
  `executablePath()` raw to `launch()`; `qa-radio.mjs` gained a
  compositor-frame pump after headless rAF starvation was proven to
  leave rAF-scheduled layout passes pending indefinitely; and
  `qa-view-target-prewarm.mjs` now tests b3de30c's actual contract
  (picks served with a voice session active, zero without) instead of
  the pre-gate behaviour.

### Changed

- **Strictest lint tier**. eslint now validates JSDoc (types + require
  tiers) and runs `eslint-plugin-sonarjs`; all 44 code-smell findings
  fixed, zero warnings tolerated.
- **`test:coverage` floors + `--parallel-only`** (see Added) and the
  `playwright` devDependency dropped — puppeteer drives every harness;
  nothing imported playwright.

### Accessibility

- **WCAG 2.1 AA→AAA pass** (2026-09-13, re-verified 2026-09-20): axe
  audit reports 0 violations in both audited states; focus-visible
  rings restored on the DISPLAY rail, accessible names added to
  nameless sliders and the search input, shell landmark roles pinned,
  layer-chip state folded into accessible names with polite
  live-region announcements, and HUD contrast fixed scrim-first
  against the measured worst-case composite (old tokens failed AA at
  2.96:1; now 9.69:1 / 5.67:1 worst case, identity hues untouched).
- **AAA conformance ledger**: `docs/ACCESSIBILITY.md` assesses all 25
  WCAG 2.1 AAA criteria individually (MET 12 / PARTIAL 3 / N/A 8 /
  UNMET 2, each with rationale) — necessary because axe-core 4.13.0
  ships zero rules tagged `wcag21aaa`, so the automated AAA run is
  near-empty and the ledger is the assurance of record.

### Security

- **puppeteer ^25.11.0** — closes 2 high-severity `extract-zip`
  advisories in the transitive dependency chain.

## [Unreleased]

_Working notes below this line are retained verbatim from June–August
2026, predate the 0.8.0–0.9.2 release fold, and are kept for history —
do not treat their headers as shipping state._

## [0.9.2] — 2026-09-18

### QA

- The E2E heading-regression suite (b3) judges aircraft/military heading
  alignment against the analytic flight arc sampled at the aircraft's
  DISPLAYED position instead of its newest raw fix. During the poll phase
  the newest fix legitimately predates the rendered time by up to one poll
  interval, which at turn rates can be tens of degrees of legal tangent
  lag — the old check misread that as a heading defect. Position anchoring
  keeps the ±35° tolerance meaningful.
- The sprite (b5) and heading (b3) suites classify OS-level network
  disconnect codes (`ERR_NETWORK_CHANGED`, `ERR_INTERNET_DISCONNECTED`, …)
  as tolerated environment noise — counted and reported, never silently
  dropped, and generic `ERR_FAILED` still fails.
- The radio-panel suite converges on "painted AND the label solve revision
  held still", not paint alone — no more racing the arbiter's first pass.
- The L9 matrix suite gets a measured 95-minute budget (its D-wave tail
  overran the old 75) and pumps a frame through the render governor before
  reading each bundled layer's stats, so late-loading layers no longer
  read as empty.
- The CCTV proxy test's wall-clock bounds get 100× headroom so a loaded
  CI box's timer coalescing cannot flake them.
- The quiet-window sweep triage (RUN 3c–3g) fixed seven suites by root
  cause instead of bar-nudging: qa-cables-shot settles in Node (a 240-tick
  pumped loop inside one evaluate exceeds that evaluate's own
  protocolTimeout — it bounds ONE CDP call, not a loop) with a wall-clock
  cap under load; qa-height-datum activates each probed camera (coverage
  entities exist only for the active camera's neighbor cohort); qa-
  cockpit-utility's request stub counts requests (a boolean counter made
  every held request ignore the module's AbortSignal); qa-flyroute-cinema
  separates acquisition from cruise at ~1 fps sampling; qa-labels gets a
  software-GL paint budget (its 10 ms bar predates the SwiftShader backend
  it pins; observed floor 25–31 ms) and asserts the relief valve engages
  only on slow paints; qa-perf stubs the HUD summary (a keyless server
  re-types it every 15 s, so 16 consecutive quiet seconds never exist) and
  uses a software-GL motion floor with the 5×-idle ratio intact.
- Suites that need a live upstream self-declare it: qa-traffic-baseline
  probes `/api/overpass` ('the baseline needs live OSM'), qa-vessel-cards
  and qa-vessel-datum check `/api/ais-live` status ('live AIS needs a
  keyed server') — matched by `ENV_GATE_MARKERS` in
  `scripts/lib/qaSuiteContracts.mjs` so both orchestrators report ENV-GATED
  instead of FAIL. No live-feed suite fabricates data to look green.
- qa-cockpit-utility's portal round-trip probe runs its phases as short
  evaluates with the compositor pump in Node between them — ~16 pump
  roundtrips inside one evaluate exceeded that evaluate's own
  protocolTimeout under a load burst. Its ceiling is 25 minutes: the
  armored probe survives a mid-run burst, but the degraded throughput
  cannot fit the 15-minute default.
- qa-flyroute-cinema's capture loop ends on the DOLLY'S OWN COMPLETION —
  `getActiveCameraMotion()` clearing to null — never on stillness (every
  stillness heuristic misread an acquisition hold as finished) and never
  on wall clock alone: `advanceRouteFlight` clamps its tick to 0.25 s of
  simulation time per rendered frame, so at software-GL cadence the
  81-second flight needs 5–9 wall minutes and a wall-clock budget cut it
  at ~17% with a false-passing wings-level bar. Module state is read
  through the exact URL the app booted (resource timing) — a bare
  harness import creates a second empty instance once the dev server has
  stamped the module `?t=` after an edit. Acceleration is differenced in
  the dolly's sim time over 5-frame medians: wall-time windows turn a
  3.9 s frame gap into a 74 m/s² ghost, and postRender re-renders without
  a motion tick (27/365 single-frame dropouts) into 45.7. Its derivative
  checks (roll rate, descent/climb, cruise wander) remain
  density-conditional — below the 60-sample floor they report
  INCONCLUSIVE with evidence instead of failing on quantization spikes.
- Both orchestrators spawn suites in their own process group and kill the
  GROUP on ceiling timeout: killing only the node process orphaned a
  Chrome that pegged ~7 cores for 40 minutes and manufactured the very
  load the quiet-window gate was waiting out. The quiet gate itself now
  requires two consecutive sub-threshold samples — the 1-minute average
  lags a ramping co-tenant storm, and a single quiet reading once opened
  a sweep at load 6.9 into a spike that reached 33.
- Closed the sweep: RUN 3p is green on the last suite — 28 checks, 0
  fail; the flight ran to completion (47 frames over 674 s wall, slot
  cleared), peak sim acceleration 24.1 m/s², min AGL 248 m, cruise range
  34 m. Every QA suite is now green or honestly ENV-GATED.

### Coverage

- `npm run test:coverage` now reports honest numbers: the traffic-timing
  test boots a real vite dev server whose SSR module runner re-compiled the
  whole traffic graph under a second filename, and c8 merged that copy's
  near-zero counts into the real ones (flowMatch read 42.97% in the batch
  but 100% solo). That one file is now skipped under coverage (it still
  runs in `npm test`), enforced by runner-contract tests. Batch coverage
  is 90.33%, with cctvViewshed at 100% and new seam tests for the CCTV
  calibration/pose/catalog internals and the frustum-volume primitive.

No user-facing behavior changes; the only served-surface delta is a
test-seam export in the CCTV module.

## [0.9.1] — 2026-09-16

### Fixed

- Boot can no longer hang forever on the Google 3D Tiles asset fetch: the
  tileset await is bounded by a 60s watchdog that falls back to the Cesium
  globe like any other tileset failure. Previously a stalled connection to
  the asset endpoint left the app on the "Loading Google 3D Tiles…" screen
  indefinitely (observed as QA boot waits exceeding 150s with no error).
- The Map Source tray's keyboard focus hand-off keeps retrying for 2s
  (was 720 ms) before giving up. On slow renderers (software WebGL) the
  tray's fade-to-visible outlasted the old bound, so every retry no-op'd
  and the tray could open with keyboard focus stranded on the disclosure —
  the exact strand the hand-off exists to prevent (a11y; PR #171 follow-up).

### QA

- `qa-floor-hold` boots on Linux: its Chrome launch no longer defaults to
  the macOS-only `--use-angle=metal` backend (which wedges WebGL context
  creation off macOS and hung the suite's boot wait on every run). Linux
  defaults to SwiftShader, taking the suite's designed bare-earth DEM
  oracle path; the rendered-mesh oracle is now enforced as untrusted under
  SwiftShader as the header always promised, and "visible" counts both of
  the contact's visuals (fleet billboard and the 3D model that takes over
  when the contact becomes model-eligible).
- `qa-l9-matrix` A5 credential scan ignores known-fake fixture literals
  (repeated-character padding used by the sanitizer tests), so the check
  measures real credential material again.

## [0.9.0] — 2026-09-16

### Added

- Strictest lint gate: `eslint-plugin-jsdoc` validation (every exported
  symbol documented, parameters and returns typed) plus
  `eslint-plugin-unicorn` correctness rules, both at zero warnings.
  The JSDoc tier was authored to zero across the previously undocumented
  3,934-symbol gap, and the check is wired into `npm run lint` so the
  documentation surface cannot regress silently.
- GPU/VRAM governor batch: the Google Photorealistic 3D-Tileset cache is
  capped (384 MB + 128 MB overflow instead of the 2.5 GB helper default —
  measured boot residency is ~220 MB, so a downtown fly-through stays
  resident while bounding the worst-case spike), the render loop drops to
  30 fps while the style crossfade is the only continuous-render holder
  and the camera is still, and backing-store DPR is capped. Escape
  hatches: `?tileCacheMB=`, `?msaa=`, `?preserveBuffer=1`.

### Security

- The pilot Content-Security-Policy is now enforced (no longer
  report-only), HSTS is stamped on responses, and every API response
  carries `X-Content-Type-Options: nosniff`.

### Accessibility

- WCAG 2.1 AAA contrast: design tokens ratcheted to the 7:1/4.5:1
  large-text tiers and every literal palette entry audited against them.

### Fixed

- The aircraft model pipeline's type-enrichment seam (`_ensureModel`)
  requested adsbdb lookups with the priority flag, which bypassed the
  rolling ambient token bucket entirely — a zoom-in that admitted dozens
  of model-eligible aircraft spent unbudgeted upstream requests (the
  exact 2026-07-03 field-bug shape, re-entering through a second door).
  Model-eligibility enrichment is now charged against the bucket while
  keeping its queue priority; an exhausted bucket skips cleanly and the
  ambient sweep retries after refill. `scripts/qa-enrich-ambient.mjs`
  gained a budget probe and E10/E11 assert the stall/refill contract.
- Keyless `POST /api/openai/hud-summary` answered 503, which Chrome logs
  as an un-suppressible console error for any non-2xx subresource. Both
  runtimes now degrade with the keyless 200 `unavailable: true` shape
  (the HUD falls back to static text); `/api/realtime/token` keeps its
  503 because voice suites gate on that signal.
- The traffic layer left `_fetching` set when disabled mid-fetch; a
  rapid disable/enable cycle could wedge its refresh loop. Lifecycle
  tests pin the reset.

### Removed

- The dormant `src/react/` experiment (17 TSX/TS files) and the
  `tsconfig.json` + ambient type declarations that existed only to
  typecheck it, along with the dead `react`, `react-dom`, `@types/*`,
  and `typescript` dependencies. Revival is a `git checkout` of any
  pre-0.9.0 commit.

### Internal

- Test coverage waves: new suites for logoGaze, splitFlap, celestialRing,
  opensky, cctvSources, bikeshare runtime, cctvGizmo, IntelHUD, the
  scene director's panel/storage paths, the annotation engine and
  resolver (both to 100% statement coverage), cockpit cloud effects
  (100%), and the voice session/action surfaces (gevRealtime 65→91%,
  gevActions 60→86%). The style-loop and loading-ticker cores were
  carved into pure modules to make that testing possible.
- The e2e orchestrator (`scripts/qa-all.mjs`) gained per-suite argv
  contracts, per-suite timeouts, and an ENV-GATED result class for
  suites that require API keys this machine does not have. The
  google-places endpoints now answer keyless with the honest 200
  `{ places: [], error, unavailable: true }` contract (dev middleware
  and Pages Function alike) instead of a console-poisoning 503, and
  the qa-firstrun/mutation harness anchors were re-pointed after
  source drift (radioPanel.js, realtimeSession.js, div launcher).

## [0.8.1] — 2026-09-14

### Fixed

- Production deploys to Cloudflare Pages failed outright since the radio
  broker unification: `functions/api/radio/[[path]].js` instantiated its
  catalog broker at module scope, and the broker stamps its catalog with
  `crypto.randomUUID()` — a disallowed global-scope operation in workerd
  ("Disallowed operation called within global scope"). Node tolerates the
  pattern, so the dev/prod parity tests never saw it. The broker is now
  created lazily on the first request (the per-isolate singleton is
  preserved), and the deployed surface serves the radio layer again.

## [0.8.0] — 2026-09-14

### Security

- Same-site origin gates on every state-changing API route, default-on
  rate limiting for the Pages Functions, and a pilot Content-Security-Policy
  on the deployed surface.
- Server-side redaction for the realtime debug-log endpoint (both the dev
  middleware and the Pages Function) — client-supplied payloads can no
  longer smuggle secrets into server logs.
- The adsb.lol route now serves the same 12-second cache + stale contract
  as dev; the radio proxy was unified on one shared broker with its SSRF
  validator deduped so radio and CCTV cannot drift apart; Overpass and
  military-installations share one policy module with a planet-wide mirror
  list; CCTV sources validate URLs at load time and cap reads/bounded
  streams; the last unvalidated request parameters in the Pages handlers
  are clamped.

### Fixed

- Both Web Worker ports of the horizon-occlusion check used an
  inverted occlusion predicate — vessels and detection objects could
  disappear or persist at the wrong side of the horizon. Found by the
  concurrency audit; unit-pinned against Cesium's own occluder.
- The detection projection worker now applies backpressure and reuses the
  last real answer instead of serving stale or dropped projections under
  load.
- Panel positions persisted at one window size can no longer restore
  off-screen at another (both the restore path and the drag handler clamp
  to the viewport), and superseded generations of panel storage keys are
  purged at init.
- The launch payload table no longer fabricates facts: explicit upstream
  nulls render as "unavailable" markers instead of 0 KG / 0,0 / inherited
  orbit names.
- Dead JSON twin chunks are no longer shipped in the build.

### Performance

- The render-perf five landed with A/B captures: uncapped world-overlay
  backing-store DPR, the compass-tape `innerHTML` rebuild, the 58
  `backdrop-filter` rules, `msaaSamples`, and `preserveDrawingBuffer`.
- Label solve under dense mode: the candidate sort's engine-sort path was
  replaced with an insertion + pooled bottom-up merge — same-window
  medians 5.4–9.0× faster at 2k–3.3k candidates, byte-identical to the
  allocation baseline.
- Material Symbols is subsetted via `icon_names`; duplicate
  `fromDegrees` work dropped from AIS row normalization.
- SGP4 batch propagation was profiled as the second WASM candidate and
  measured NOT to qualify (steady state ~0.3 ms/frame; capture in
  `docs/PERFORMANCE.md`), closing the WASM backlog.

### Accessibility

- Landmark pass closed the last axe violations; chip state changes are
  announced, keyboard paths repaired, worst-case contrast fixed, and a
  test pins accessible names for every form control. The scene director's
  two blocking `window.prompt` calls became real `<dialog>` elements.

### Added

- Keyless geocoding: `/api/geocode` serves an OpenStreetMap Nominatim
  path so search works without a Google key; an optional
  server-restricted Google key remains available.
- Progressive web app hardening: bundle-budgets gate on the build output
  (dist growth is a reviewed decision; the offline shell can no longer be
  silently dropped from the precache manifest).
- Level-gated logger with a ring buffer for the noisy subsystems.

### Internal

- `src/ui.js` (10.4k lines) is split into focused modules under `src/ui/`;
  the flights fork shares one tracking-pipeline factory; 13 overlay
  factory clones collapsed into one `createOverlayEntry`; the 5.9k-line
  `vite.config.js` became a slim assembly of per-endpoint proxy modules
  with an enforced dev/prod route inventory.
- Coverage 75.3% → 80.82% lines, including the worst large modules, the
  four previously untested Pages handlers, the rate-limiter budget
  boundaries, and first-run experience wiring. The suite (3,147 tests)
  runs on both calibrated Node majors with allocation budgets enforced.
- A local GitForge pipeline (`.gitforce.yml` + pre-warmed CI images)
  mirrors the GitHub workflow gate-for-gate.

## [0.7.0] — 2026-09-10

### Added

- Added a PWA surface (`vite-plugin-pwa`): precached app shell + service
  worker so the globe client boots offline-first; precache manifest excludes
  what can lazy-load.
- Added the FIRMS 100k-point renderer in Rust compiled to WASM
  (`rust/firms-renderer/`, Gaussian-splat style accumulation), bundled under
  `public/wasm/firms-renderer/` and loaded dynamically by the FIRMS layer,
  with a canvas fallback when WASM is unavailable.
- Added production Pages Functions for FIRMS (`functions/api/firms.js`:
  keyed 3-source sweep with post-filter tallies, Cache API freshness, and
  stale-on-upstream-failure) and TomTom flow tiles
  (`functions/api/tomtom.js`: dev-parity routes, tile bounds validation,
  120 s single-flight cache, per-isolate daily budget serving stale tiles
  over budget, and a no-key-in-any-response invariant).

### Security

- Replaced the open `/api/tomtom` forwarder — it relayed ANY path on
  api.tomtom.com with the account key appended and a nonexistent upstream
  path (an open, billable proxy that was also simply broken).
- `/api/realtime/token` is now POST-only with an Origin-host same-origin
  guard (dev middleware, Pages Function, and client aligned): a cross-site
  simple GET could previously mint billable OpenAI sessions with no
  preflight.
- `/api/realtime/debug-log` no longer lets a client-supplied `loggedAt`
  spoof the server timestamp (record nested, line built with
  `JSON.stringify`) and sits behind the opt-in rate limiter.
- Layer-toggle panel rows are built with `textContent` instead of
  `innerHTML` interpolation.

### Accessibility

- CCTV ambient cards enter the world-overlay accessible mirror
  (`accessibilityLabel` + `activate`).
- The boot fly-in respects `prefers-reduced-motion` (shared helper).
- Voice button state is carried by `aria-pressed` and a `role="status"`
  live region; orbit indicator state is text-carried before the class
  toggle inside a live region; the scene-shot label is a real `<button>`.
- Global keyboard shortcuts ignore Ctrl/Meta/Alt; `--text-dim` raised to
  5.3:1 (WCAG AA); 7–8 px telemetry text bumped to 9 px; clipped mirror
  buttons get an un-clipped `:focus-visible` style.

### Fixed

- Fixed the military flights layer ingesting nothing in dev: it polls bare
  `/api/adsblol`, but only `/api/adsblol/mil` had a dev middleware, so the
  SPA fallback answered the layer with `index.html`. The dev server now
  serves the same cached feed on both paths (Pages already did via
  `functions/api/adsblol.ts`).
- Fixed every `qa-*` browser harness on Linux: Chrome was launched with
  the macOS-only `--use-angle=metal`, leaving WebGL uninitialized. The
  platform choice now lives in `scripts/lib/webglLaunchArgs.mjs`.
- Fixed track-regression harness integrity (`100 passed / 0 failed / 0
  skipped`): the military synthetic-fleet shim pointed at the registry
  endpoint instead of the layer's feed, the TLE browser cache served
  catalog phases instead of the shimmed mutations, the `sampleHeight`
  bound pinned an environment-dependent absolute count, and keyboard
  interactions raced fixed sleeps (same treatment for the Map Source tray
  QA, now 4/4 stable, with honest environment-bound skips).
- Removed verified-dead code (8 unused exports, the orphaned
  `labelSolve.worker.js`, the dead `flyToPreset` preset table) and
  corrected doc drift in `CLAUDE.md`, `apiEndpoints.js`, and this file's
  previous entries (see `docs/PLAN.md` Phase 7 for the full ledger).

## [Unreleased]

### Added

- Added a measured test-coverage baseline (Node's built-in reporter; 66.2%
  lines / 75.9% branches across loaded modules, 155 of 170 non-test modules
  reached), a `npm run test:coverage` script, and a CI job that publishes the
  number. Contract tests added for the six visual-style shader modules
  (uniform metadata ↔ GLSL declarations) and for `processChunked`'s sync,
  idle, and fallback paths.
- Added a strict ESLint 9 gate (`npm run lint`, zero warnings) with a flat
  config that documents the repo's style policy, and a `lint` job in CI.
- Added a Cloudflare Pages Functions production surface for every keyless dev
  API middleware (celestrak, launches, adsbdb, opensky-track, adsblol
  mil/trace, cctv, openzenith, realtime token/debug-log, hud-summary) with
  shared worker-safe handler modules, response caps, request coalescing, and a
  shared track cache.
- Added the OpenZenith keyless elevation and reverse-geocode proxy
  (`/api/openzenith/**`), edge-cached, and a browser localStorage caching tier
  (`src/data/localCache.js`) now used by adsbdb enrichment (30 days, negatives
  included), CelesTrak TLE groups (6 hours), and OpenZenith place lookups
  (30 days). Tracked aircraft readouts can name the place they are over.
- Added `docs/PLAN.md` (quality roadmap with status ledger) and
  `docs/RUNBOOK.md` (dev, gates, deploy, post-deploy verification, operational
  gotchas), plus `docs/DATA_SERVICES_CATALOG.md` for candidate data services.

### Fixed

- Fixed the CCTV layer failing to initialize in the browser: `init()`
  referenced a variable a refactor had lost (`priorsPromise`), throwing before
  any camera rendered. Ground-prior batching applies post-hoc again.
- Fixed the label-solve worker crashing on every ordered-placement solve
  (shorthand `{ py }`/`{ px }` named no variable), which had silently disabled
  its dense fast path.
- Fixed `/api/realtime/debug-log` and the HUD AI summary failing with 404/405
  in production: the endpoints now exist as Pages Functions.
- Fixed the `processChunked` `setTimeout` fallback crashing instead of
  yielding: timer-driven slices invoked the drain loop with no deadline
  (`TypeError` on `timeRemaining()`), and the reschedule referenced the bare
  `requestIdleCallback` global (`ReferenceError` after one slice). Fallback
  slices are now bounded by `chunkSize` and reschedule via the active
  scheduler.
- Fixed a tautological assertion in the route-cinematics suite that compared a
  value with NaN instead of asserting `Number.isNaN`.

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
