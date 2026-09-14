# God's Eye View — Hardening & Quality Plan

Updated: September 10, 2026

This is the working plan for taking the console from "works" to "held to a
quality bar": strict lint, broad coverage, WCAG 2.1 AA, honest documentation,
CI gates, and releases. It is written as phases with an honest status ledger —
items marked done are done with verification, items marked open are not
started or only partially landed. Nothing here is aspirational filler.

Companion documents:

- [DATA_SERVICES_CATALOG.md](DATA_SERVICES_CATALOG.md) — candidate data services and signup checklist
- [CURRENT-STATE.md](CURRENT-STATE.md) — what ships today, feature by feature
- [KNOWN-ISSUES.md](KNOWN-ISSUES.md) — open runtime issues only
- [PERFORMANCE.md](PERFORMANCE.md) — measured baseline (results, not a benchmark)

---

## Phase 0 — Baseline audit (DONE)

Full inventory of tests, lint, build, e2e harnesses, a11y, and scanners.
Findings that drove the phases below:

- No linter, no CI, no release process. Test runner silently skipped any test
  file whose name contained `[[...]]` (see Phase 2).
- Production deployed as a static site with **no** Pages Functions, while the
  dev server ran 15+ API middlewares — every keyless data path 404'd in
  production (this also produced the `/api/realtime/debug-log` 405 and the HUD
  "AI summary unavailable: HTTP 405" errors).
- CCTV layer dead in the browser (see Phase 1).

## Phase 1 — Correctness: blockers, data sources, parity (DONE)

1. **Pages Functions parity.** Every keyless dev middleware now has a
   production counterpart under `functions/api/**`: celestrak, launch-library,
   adsbdb, opensky-track, adsblol (mil + trace), cctv, openzenith,
   realtime token + debug-log, hud-summary. Shared logic lives in worker-safe
   modules executed by BOTH runtimes (`functions/_lib.js`, `functions/_upstream.js`,
   `functions/api/openzenith/_handler.js`, `src/data/cctvSources.js`).
   The 405 debug-log / HUD-summary errors are fixed at the root: the endpoints
   exist and answer.
2. **CCTV.** Root cause of the dead layer: `init()` referenced a variable a
   refactor had lost (`priorsPromise`), throwing `ReferenceError` before any
   camera rendered. Restored, plus the source/health/passthrough subsystem was
   re-homed into worker-safe `src/data/cctvSources.js` shared by both runtimes.
   A second latent crash (`labelSolve.worker.js` shorthand `{ py }`/`{ px }`
   naming no variable) killed the label-solve worker's dense fast path on every
   call; fixed.
3. **Data source audit.** adsbdb enrichment queue (bounded inflight, drip
   pacing, per-session dedupe) ported to a Pages Function with a shared track
   cache; OpenSky/CelesTrak/adsb.lol responses capped and coalesced; NASA FIRMS,
   GBFS, TomTom documented where a Function port is deliberately deferred
   (see "Deliberately deferred").
4. **OpenZenith integration** (`/api/openzenith/**`): free keyless elevation and
   reverse geocoding, edge-cached 1 h, validated against the live service, with
   the tracked-target readout gaining "over <city>, <state>".
5. **Browser caching tier** (`src/data/localCache.js`): namespaced localStorage
   cache, 500-entry LRU-by-read cap, quota-safe, never throws. Consumers:
   adsbdb enrichment (30 d, negatives cached, cache hits bypass the drip
   budget), CelesTrak TLE groups (6 h, 128 KB per-entry cap), OpenZenith places
   (30 d, ~100 m cells, single-flight per cell).

## Phase 2 — Strict lint & code smells (DONE)

- [x] ESLint 9 flat config (`eslint.config.js`): `js.configs.recommended` plus
      error-level discipline rules — `eqeqeq`, `no-var`, `prefer-const`,
      `curly`, `no-unused-expressions`, `no-implicit-coercion`,
      `prefer-template`, `object-shorthand`, strict `no-unused-vars` with a `^_`
      escape hatch. `npm run lint` runs with `--max-warnings 0`.
      `no-console` is deliberately off: the console IS this app's telemetry
      channel, in the browser and in Pages Functions.
- [x] Three latent runtime crashes fixed because the first lint baseline
      surfaced them (see Phase 1.2).
- [x] Mechanical cleanup to green (2026-08-29): 469 errors + 15 dead
      directives across 112 files resolved with zero behavior change — lint,
      the full suite (2706+1+13), and the build all verified green. Five
      `!!` coercions in `ui.js` keep justified inline disables because
      source-contract tests pin the literal text (the suite caught the first
      rewrite attempt — the guardrails work).
- [x] Lint job added to CI alongside test and build.

## Phase 3 — Test coverage toward 99% (OPEN)

The suite is the safety net for everything above: 2891 co-located tests
(`npm test`, headless, plus two serialized allocation probes). Gaps to close:

**Coverage measurement integrity (2026-09-13):** `npm run test:coverage`
now wraps the runner in **c8** (`--parallel-only`, new runner flag) instead
of Node's built-in reporter. The built-in reporter under-reports large
heavily-tested files: it credited `flights.js` **34.80%** while raw
`NODE_V8_COVERAGE` dumps from the very same test child processes record the
reporter's "uncovered" functions executing (verified: V8 count ≥ 1 on the
`getDetectableObjects` function the reporter flagged; c8 measures the same
file at **75.1%**). On every module checked where the two tools disagree,
c8 agrees with the built-in reporter — so the historic per-module numbers
below are reliable EXCEPT for flights.js, which was never the worst large
module. Corrected c8 truth (2026-09-13): `src` **75.3%** lines,
`functions/` **99.31%**. Real worst large modules now:
`mapStackController.js` 38.2%, `traffic.js` 39.2%,
`worldAnnotationRenderer.js` 47.6%, `firstRunExperience.js` 48.2%,
`bikeshare.js` 57.8%. The allocation probes still never run under coverage:
instrumentation itself allocates and would fail their calibrated budgets
(the focus probe fails its median the moment coverage is enabled), so the
runner now ships an explicit `--parallel-only` skip with a warning, and
plain `npm test` keeps the allocation gate.

- [x] Measure, don't guess (2026-08-29): baseline published via
      `npm run test:coverage` (Node's built-in reporter) and a CI `coverage`
      job. Measured: **66.22% lines / 75.87% branches / 63.04% functions**
      across the 155 non-test modules the suite loads; 67 of them are already
      at 100% lines. 15 modules are never imported by any test (0% by
      omission): `src/main.js`, `src/ui.js`, `src/camera.js`, `src/orbit.js`,
      `src/annotations/index.js`, `src/data/localLayers.js`, the six
      `src/styles/*.js` shaders, and the three `src/workers/*.js` (browser
      threads). Note the reporter only sees loaded modules — the honest
      repo-wide number is lower than the headline.
- [x] First tranche of weak-spot tests (2026-08-29): contract tests for the
      six visual-style shaders (uniform metadata ↔ GLSL declarations ↔ ui.js
      registry) and full-path tests for `processChunked` — which flushed out
      two real crashes in its `setTimeout` fallback (see KNOWN-ISSUES) and
      resolved the pending `chunkSize` decision (see Phase 5).
- [x] Data-integrity regression tranche (2026-09-10): earthquake
      replacement-swap safety (malformed row skipped, all-malformed feed
      preserves last-good entities) and military-installation bounds-midpoint
      derivation (center precedence, half-filled/inverted boxes dropped).
      Both pin silent-data-loss contracts (see Phase 7).
- [ ] `src/ui.js` and `src/main.js` remain the least-tested modules (boot
      path, panel wiring). Extract-and-test the pure helpers first; do not
      chase line count by snapshotting the DOM.
- [ ] Next weakest loaded modules per the report: `flights.js` (34% lines,
      2% functions), `traffic.js` (41%), `mapStackController.js` (0%
      functions), `logoGaze.js` (26%), `cctvGizmo.js` (30%).
- [ ] Pages Functions: happy paths are covered; add contract tests for the
      rate-limiter budget boundaries and the CCTV SSRF guard matrix.
- [ ] Definition of done: coverage measured and published; weak spots
      identified from the report get tests. The number follows the tests, not
      the other way around.

## Phase 4 — WCAG 2.1 accessibility (IN PROGRESS)

Note on the bar: the original goal named AAA; this plan treats AA as the
gate (AAA's 7:1 contrast and sign-language/extended-audio requirements are
not achievable over arbitrary satellite imagery without redesigning the
visual identities) and fixes AAA-level items where they are free.

- [x] Static audit applied (2026-08-29):
      - **2.4.7 Focus Visible** — `.style-btn`, `.pp-toggle-btn`,
        `.pp-select`, `.pp-slider`, `.param-slider`, `.location-pill`,
        `.poi-pill` set `outline: none` with no replacement; keyboard users
        had NO focus indicator on the DISPLAY rail. Restored as a
        keyboard-only `:focus-visible` ring using the existing accent token
        (matches the convention already used by `.map-stack-chip` and the
        cockpit controls).
      - **4.1.2 / 3.3.2 Names & Labels** — added accessible names to the
        scope-feather, bloom-intensity, and sharpen-intensity sliders
        (previously nameless) and the location search input (placeholder
        only, which is not an accessible name).
      - Decorative emoji glyphs next to text labels marked `aria-hidden`;
        the icon-only search button given a real name.
- [x] `scripts/qa-a11y.mjs` — axe-core audit harness (WCAG 2.1
      A/AA/AAA + best-practice tags, boot + panel-expanded states, JSON
      report to `qa-shots/a11y/report.json`, gate mode unless
      `--report-only`). (Runbook note superseded 2026-09-10: headless
      Chrome DOES run in the primary dev container with
      `executablePath: /usr/bin/google-chrome` and `--no-sandbox` — the
      profiling harness runs it daily. The axe pass can run here too.)
- [x] Live axe pass over HUD, layer panel, first-run launcher, and voice
      overlay; triage the report into fixes. DONE 2026-09-13 — qa-a11y
      (boot + panel-expanded) reports 0 violations across
      wcag2a/2aa/21aa/2aaa/21aaa + best-practice. Findings fixed:
      `#first-run-launcher` aria-allowed-role (aside + role=dialog → div);
      axe `region` landmark pass — named roles on the EXISTING shell
      containers (no wrappers, so nothing can re-anchor the fixed
      full-screen canvas): `#cesiumContainer` role=application, `#title-bar`
      role=banner, `#style-indicator` + the dock/panel trays role=region
      with unique labels. Along the way: the first-run launcher's
      `<header>` became a div — its parents are not sectioning content, so
      it exposed a second banner landmark (axe
      landmark-no-duplicate-banner). Pinned by `src/shellLandmarks.test.mjs`.
- [ ] Keyboard: verify focus order in the DISPLAY rail and layer rows; every
      click-only custom control needs a key path.
- [ ] ARIA states for the async chips (loading/failed) — `aria-busy` and
      live-region announcements where a chip changes state on its own.
- [ ] Contrast: HUD text over arbitrary imagery is the hard case — verify
      the existing text shadows/scrims against AA, and prefer scrim changes
      over color changes that would break the IR/NVG/FLIR visual identities.
      Reduced-motion is already respected (7 CSS blocks + JS callers).

## Phase 5 — Performance profile & WASM (IN PROGRESS)

Performance, reliability, and controlled system requirements are the priority.
Order of work, cheapest-first:

- [x] Profile before rewriting (2026-09-10): `scripts/profile-runtime.mjs`
      drives the real app through boot / layer storm / detection-100% / idle
      scenes, sampling FPS, longtasks, heap, and CDP CPU self-time; the ranked
      findings are recorded in
      [PERFORMANCE.md](PERFORMANCE.md) ("Software-rendered CPU profile").
      Headline: boot is shader-compile/texture-init bound; the worst
      app-controlled stall is a synchronous depth readback on the HUD label
      path (fixed — see below); detection at 100% density is 79% idle; idle
      honors the render governor (94% idle). No WASM before this existed; the
      profile now exists and the verdict is recorded there.
- [x] Profiled hotspot fixed: HUD label context no longer performs the
      `pickPosition` depth-buffer readback (surface-only pick, cache scoped
      per mode); `celestialRing._clear` no longer repeats per-frame clears
      and style writes on non-full-globe views.
- [x] Candidate already identified by the lint pass: `processChunked`'s async
      path computed its `chunkSize` slice and then never used it. Resolved
      (2026-08-29): the parameter now bounds the `setTimeout` fallback's
      slices (whose documented purpose is "still yields between chunks" —
      previously that path crashed outright, see KNOWN-ISSUES), while the
      `requestIdleCallback` path stays deliberately deadline-driven: with a
      real idle budget, chunk size is the browser's call, and a test pins
      that intent so it cannot drift silently.
- [ ] Algorithmic wins first (these are known, measurable, and don't need
      WASM): AIS row normalization batch sizes, detection projection worker
      backpressure, label solve cadence under dense mode. Plus the render-perf
      list from the community audit (Phase 7): `preserveDrawingBuffer`,
      `msaaSamples`, the 58 `backdrop-filter` rules, the compass-tape
      `innerHTML` rebuild, and the uncapped world-overlay backing-store DPR.
      Each must land with a before/after capture from
      `scripts/profile-runtime.mjs` or a workstation trace.
- [x] WASM: FIRMS heat renderer wired (2026-09-10). `rust/firms-renderer/`
      renders the cells-band aggregation (`global`/`regional` LODs) as ONE
      Gaussian-splat texture on a single ground rectangle via
      `src/data/firmsHeatTexture.js`, replacing ≤3600 per-cell rectangle
      entities (N ground primitives → 1). The legacy entity render stays as
      first paint + automatic fallback (any load/render failure,
      `?firmsWasm=0`). Runtime-verified in headless Chrome against REAL NASA
      data through the dev proxy (37,437 detections): 527 cells → 1 entity,
      splat pass 14.8 ms regional / 42.6 ms global; 13 unit tests pin the
      layout/splat math; A/B numbers in
      [PERFORMANCE.md](PERFORMANCE.md) ("FIRMS heat-texture A/B") —
      including the honest caveat that software rendering cannot reward the
      draw-call reduction (fps unchanged; the win is hardware-GL draw-call
      count + a proven-cheap generation cost). The proxy gained a keyless
      source (NASA's public 24h SNPP VIIRS CSV) so the layer works without a
      MAP_KEY and CI/QA exercise it for free.
- [ ] WASM candidate 2 — SGP4 batch propagation for dense catalogs: NOT
      wired. Needs a dense-catalog scene added to `profile-runtime.mjs`
      before it qualifies (same bar the FIRMS work met). SIMD only for
      splatting/inner loops that are already vectorizable.
- [ ] Concurrency: audit every `await`-in-loop over large cohorts for
      parallelizable fan-out; verify the workers are actually parallel on the
      paths that matter (visibility, projection, label solve).

## Phase 6 — CI/CD, release, deploy (PARTIALLY DONE)

- [x] GitHub Actions (`.github/workflows/ci.yml`): lint (`--max-warnings 0`),
      test (Node 24, allocation gate on), coverage (publishes the measured
      number), and build (artifact upload). No deploy job by design — deploys
      are explicit (see runbook).
- [ ] Resolve the lockfile duplication: the tree carries both
      `package-lock.json` and `pnpm-lock.yaml`/`pnpm-workspace.yaml`. npm is
      the canonical path for CI, scripts, and docs; the pnpm files are stale
      and should be removed unless a pnpm workflow is adopted deliberately.
- [ ] Add an `npm audit` production gate (fail on high/critical in the
      runtime dependency set; dev-only advisories waived with rationale in a
      waiver file, not silently).
- [ ] Add a build gate that fails on Node-core externalization warnings in
      browser chunks (issue #34) — currently clean; keep it that way with a
      check rather than vigilance.
- [ ] GitForge pipeline mirroring ci.yml (lint/test/build) with the GitHub
      Actions run kept as the sync mirror — per the standing CI/CD routing
      directive.
- [ ] GitHub release with changelog; then `wrangler pages deploy dist` to
      production and verify the Functions surface on the deployed URL
      (elevation, reverse-geocode, cctv, celestrak, debug-log) plus the
      globe itself rendering.

## Phase 7 — Community audit integration (IN PROGRESS)

A 2026-09-10 sweep of upstream PRs and issues (bilawalsidhu/gods-eye-view —
the fork has none) produced a verified backlog. Items below were cross-checked
against this tree before acting; "fixed here" means landed in this repository
with its own verification.

Fixed here (2026-09-10):

- [x] FIRMS proxy `fires.push(...records)` RangeError — a global VIIRS sweep
      returns ~131k rows, past V8's ~124k argument limit, and the throw was
      swallowed so healthy sources reported `ok:false` (PRs #181/#156).
      Fixed + `ok` bookkeeping moved after the rows land.
- [x] GBFS proxy hardening — `redirect: 'manual'`, refuse 3xx (PRs
      #180/#30), streaming byte cap via the existing `readResponseTextCapped`
      replacing the post-decode character-length compare (issues #31/#32).
- [x] `/api/google/text-search` lat/lon range validation (issue #19).
- [x] Overpass `out geom` omits `center`: military installations derive the
      point from the bounds midpoint instead of silently dropping every
      way/relation (PR #102; measured upstream: 149/228 kept over San Diego,
      0 over Warendorf). Regression tests pin center precedence and
      half-filled/inverted box rejection.
- [x] Earthquake replacement-swap safety (PR #198).
- [x] Map Source tray focus hand-off — retry until focus actually lands
      instead of a fixed 240 ms timer that no-ops against the 180 ms
      visibility fade (PR #171, issue #54).
- [x] `node:fs` branches replaced with JSON import attributes in
      `naturalEarthRegions.js` / `neighborhoodPolygons.js` (PRs #112/#34).

Deep review sweep (2026-09-10, three-agent pass: security / code-quality /
accessibility), fixed here:

- [x] `functions/api/tomtom` — the old `.ts` forwarder relayed ANY path on
      api.tomtom.com with the account key appended (open, billable proxy,
      `ACAO:*`) and built a nonexistent upstream path, so the flow layer was
      broken on Pages anyway. Replaced with a full dev-parity rewrite:
      `/status` + `/flow/{z}/{x}/{y}.pbf` routes, `isValidTileCoord` bounds
      check, 120 s TTL cache with single-flight, per-isolate daily budget
      (`TOMTOM_DAILY_TILE_BUDGET`, default 40 000, UTC rollover) that serves
      stale tiles rather than a dead layer, empty-body = failed fetch, and a
      no-key-in-any-response invariant. 11 tests.
- [x] `/api/realtime/token` CSRF — a cross-site `<img>`/form GET could mint
      billable OpenAI sessions (no preflight on simple requests). Now
      POST-only + Origin-host same-origin guard, mirrored in the dev
      middleware and the client (`gevRealtime.js` sends POST). 9 tests.
- [x] `/api/realtime/debug-log` — client-supplied `loggedAt` could spoof the
      server timestamp (spread into the log line). Now nested
      `{loggedAt, record}` and behind the opt-in limiter
      (`GEV_RATELIMIT_OPENAI_PER_MIN` → 429 + Retry-After), dev middleware
      mirrored. Tests pin the nested shape and the spoof rejection.
- [x] Layer-toggle panel `innerHTML` interpolation of layer names →
      `textContent` (`manager.js`).
- [x] Dead code removal (every ref verified before deletion — substring
      greps lie: `flyToPreset` vs `flyToPresetLocation`): `resetAircraft-
      RecessionParams`, `AIS_WATCHDOG_STATUSES`, `DENSITY_STOPS`,
      `_normalizeName` alias, `isRadioCountryCode`, `getSceneRecipeById`,
      `VOICE_MODEL_RATES_VERIFIED_ON`, `resetFocusDeemphasisParams`,
      camera.js `flyToPreset`/`CAMERA_PRESETS`, and the orphaned
      `labelSolve.worker.js` (262 lines, zero refs).
- [x] CLAUDE.md drift: layer table missing planets/military installations/
      military awareness rows, `local_data` list, voice-system description
      (`realtimeSession.js` owns the frozen tool schemas), detection throttle
      500 ms → 125 ms `LABEL_SOLVE_INTERVAL_MS`. Stale "wrangler dev on port
      8787" claim removed from `apiEndpoints.js`; lying `.gitignore` entry
      for tracked `wrangler.toml` removed.
- [x] Accessibility batch: CCTV ambient cards gained `accessibilityLabel` +
      `activate` so they enter the world-overlay accessible mirror; boot
      fly-in (`flyToAustin`) respects `prefers-reduced-motion` (shared
      helper from `cameraVerbs.js`); `--text-dim` raised to 5.3:1 (AA);
      `.scene-shot-label` is now a real `<button>` (keyboard-reachable);
      clipped mirror buttons get an un-clipped `:focus-visible` style;
      `#intel-hud` marked `aria-hidden` (decorative telemetry duplicate);
      voice button state carried by `aria-pressed` + a `role="status"`
      live region; global keydown shortcuts ignore Ctrl/Meta/Alt combos;
      orbit indicator text set before class toggle inside a live region.

Open backlog, cheapest-first (re-verify each against this tree before
acting — the audit described upstream's tree):

- [x] Icon font subsetting (PR #239): DONE 2026-09-13. index.html requests
      Material Symbols Outlined with `icon_names=` (30 entries extracted
      from source — including ternary-assigned glyphs like
      `right_panel_open` that a static-assignment scan alone would have
      missed) and the unused `Material Icons Round` stylesheet is gone.
      Measured with a Chrome UA: the variable font drops 330,416 → 3,972
      bytes (−98.8%). `src/iconSubset.test.mjs` re-extracts candidates
      with a deliberately broad window-scan (over-inclusion is safe —
      Google ignores unknown `icon_names` names, verified 200 — while a
      missing glyph renders as its literal word) and fails when a rendered
      glyph is absent from the URL; a second test pins the unused-family
      removal. Browser probe: `document.fonts` reports the subset loaded
      and sampled icons render ligature-narrow, not word-wide. Gates:
      lint 0, 2,981 tests, build ok.
- [x] Render-perf five (issue #8) — DONE 2026-09-13, all five with
      before/after captures from the new instrument
      `scripts/profile-render-perf.mjs` (headless Chrome at
      devicePixelRatio 2, SwiftShader A/B on one machine; DOM/byte counts
      are portable, frame times are not):
  1. `preserveDrawingBuffer`: now resolved by `src/renderContextOptions.js`
     (unit-tested, imported by `main.js`) — default OFF, `?preserveBuffer=1`
     restores. The one in-app pixel reader (voice-vision snapshot) captures
     with the requestRender→postRender→drawImage same-task pattern, proven
     FRAME-CAPTURED with the attribute off (lit fraction 0.968 vs 0.944
     with it on).
  2. `msaaSamples` 4 → 2 (`?msaa=N` override; verified `scene.msaaSamples`=2
     live): multisample target ~19.8 → ~9.9 MiB at 1440×900 per frame.
  3. Worst `backdrop-filter` surfaces de-blurred (persistent dock: command
     dock + location/control/voice wings + `.location-inner`; both rails:
     `.panel-inner`/`.data-panel-inner`; `#first-run-launcher`): boot
     census 19 → 14 active surfaces, compositor blur reads 6.1 → 1.7
     MiB/frame (−72%). Remaining blurs are transient trays, popovers, and
     on-demand panels by design; de-blurred panels raise background alpha
     (0.72 → 0.92) which also steadies AAA text contrast.
  4. Compass tape built once (`_updateCompassTape` + `compassTapeLayout`
     in cockpitMath): 720° sweep childList mutations 336 → 0; per update
     one `--tape-shift` custom-property write (the tape now slides
     smoothly between the 30° snaps instead of re-parsing 7 spans per
     crossing); rendered labels verified identical at N/E/S/W sampling
     points; qa-cockpit-utility READY.
  5. World-overlay backing-store DPR capped at 1.5 (`?overlayDpr=N`
     override): 2880×1800 → 2160×1350 per canvas, 39.6 → 22.2 MiB across
     the shared+detection pair (−44%). qa-overlay-baseline
     `--scene detection-50` [OK] under the cap (6,663 observations,
     paint 14.5 ms).
  Gates: lint 0, 2,990 tests, build ok. Residual a11y finding surfaced by
  `qa-a11y` while verifying item 3 (pre-existing, not caused by this unit):
  axe `region` — top-level content (Cesium canvas, h1/subtitle,
  #style-indicator) sits outside landmarks; fixed this pass:
  `#first-run-launcher` aria-allowed-role (aside+role=dialog → div).
  The landmark pass landed separately (see the Phase 4 axe entry): qa-a11y
  is now 0 violations in both states.
- [ ] Security gate for key-bearing endpoints (PR #242, issues #16–#18,
      #22–#24): REMAINING after the 2026-09-10 sweep — same-site request
      gate for `/api/openai/hud-summary` and `/api/google/nearby-places`
      (token + debug-log are done); default-on rate limiting for exposed
      deployments (the opt-in `GEV_RATELIMIT_*` pattern exists); server-side
      redaction/shape validation for debug-log beyond the nesting fix.
      Note the CSP trap PR #242 verified: Knockout
      inside `@cesium/widgets` needs `'unsafe-eval'` in `script-src` or the
      widget never initializes. Extract the middleware out of
      `vite.config.js` (issue #41) first so these are testable per-module.
      The `functions/api/**` review happened (sweep above): tomtom forwarder
      replaced, firms/ais-live/token/debug-log hardened; remaining
      functions need the body-cap/bbox-clamp treatment (see backlog item
      on Overpass/military-installations).
- [ ] Split server-side Google key from the browser key (PR #110, issue #33):
      optional `GOOGLE_MAPS_SERVER_API_KEY` read as
      `SERVER_KEY || BROWSER_KEY` so a single-key setup keeps working.
- [ ] Keyless geocoding fallback (PR #166, issues #211/#213) or, minimally,
      docs naming every API to enable (Map Tiles, Places, Geocoding) —
      location search currently throws on keyless installs.
- [ ] Allocation gates calibrated for every supported Node major (issue #39):
      CI fails on an uncalibrated runtime (better than upstream's silent
      skip), but budgets are Node-24-only while `package.json` advertises
      Node 24 and 26.
- [x] Bundle budgets (issue #40): DONE 2026-09-13 in two moves — the precache
      diet (Batch 6 icon-subset entry: shell-only `globPatterns`, 19 MB →
      6.0 MB precache) decided what ships by default vs lazy-loads, and
      `npm run check:budgets` (`scripts/check-bundle-budgets.mjs` + policy
      table `src/config/bundleBudgets.js`) now gates the build output in CI's
      build job: per-chunk ceilings over the measured artifacts (index chunk
      capped AT workbox's 6 MiB per-file limit, egm96 3.0 MB, regions 2.15 MB,
      marine 0.7 MB, SF 0.26 MB, CSS 220 KB, 512 KB default for unbudgeted
      chunks), a precache-shell total, a dist-total ceiling, and a cross-check
      that the built sw.js manifest still lists every shell file — workbox
      silently drops over-cap files, which breaks the offline shell without
      any other signal.
- [ ] Test-suite portability: `.gitattributes` (`* text=auto eol=lf`) +
      newline-agnostic source anchors (issue #88; several tests regex
      `src/ui.js`), and note the formatter constraint (PR #227): ~86 tests
      assert source text, so a repo-wide format pass requires re-pinning
      them first.
- [x] `track-regression.mjs` harness integrity (2026-09-10 sweep, verified
      100/100 in a software-GL environment): the military synthetic-fleet
      shim pointed at `/api/adsblol/mil` (the registry endpoint) while the
      layer polls `/api/adsblol` — the fleet under test was never synthetic
      and the jitter/pull-out/orphan invariants silently skipped offline;
      the TLE-mutation phases now purge the `tleCache.js` localStorage keys
      the browser cache (added after the harness was written) would have
      served instead of the shimmed refresh; the `sampleHeight` bound drops
      the absolute-count pin (cold-cache terrain deterministically yields 3)
      and guards on frames-actually-ran so a timed-out driver can't read as
      "flat"; keyless-Google-tile 400s join the benign-noise filter; and all
      keyboard interactions wait on state (with bounded retries) instead of
      fixed sleeps — same treatment applied to `qa-map-source-tray.mjs`
      (4/4 stable) plus a `checkSkip` path for Google-key-bound assertions.
      The macOS-only `--use-angle=metal` default that broke every `qa-*`
      script on Linux moved into `scripts/lib/webglLaunchArgs.mjs`.
- [ ] Accessible-name invariant test (PR #216): every `<input>` in
      `index.html` carries `aria-label`, `aria-labelledby`, or an associated
      `<label>` — feeds Phase 4.
- [ ] Panel viewport clamping + legacy localStorage key purge (PRs
      #215/#190; local tree is at layout `v6`/position `v8` and only
      notifies about `v6`).
- [ ] CCTV source-pack URL validation at load time (PR #185, issue #29) and
      the wider CCTV proxy audit (issues #25–#28: bounded timeouts, byte
      caps, Range-header validation, body-size caps on the image path).
- [ ] `.overpass` mirror list diversity (PR #104): the four mirrors are
      effectively three distinct hosts, and regional-only mirrors poison the
      24 h cache with silently-empty results — only planet-wide instances
      belong in the list.
- [ ] FIRMS/Node IPv6 `autoSelectFamily` fix (issue #68/PR #126):
      `net.setDefaultAutoSelectFamily(false)` at proxy init for hosts where
      IPv6 is unreachable.
- [ ] DATA_PRESET honesty (PR #197 pattern): never fabricate a value to fill
      a slot ("CLASSIFIED" vs "PAYLOAD DATA UNAVAILABLE", preserve null mass
      as null). Port the normalization tests where the launch payload
      rendering matches.

## Phase 8 — Post-0.7.0 gap analysis & systematic roadmap (2026-09-10)

A re-verification pass after v0.7.0 shipped. Every number below was measured
against THIS tree (grep/wc/`npm test -- --coverage`) in this pass — where the
community audit's counts differed, these are the real ones. Batches are
ordered by value-per-risk; each is self-contained and committable.

### Measured state (2026-09-10)

- **Coverage**: 66.64% lines / 76.06% branch / 63.06% functions. Worst large
  modules: `flights.js` 34.69%, `vite.config.js` 40.27%, `traffic.js`
  40.54%, `mapStackController.js` 38.21%, `worldAnnotationRenderer.js`
  47.59%, `firstRunExperience.js` 48.22%, `bikeshare.js` 57.82%,
  `splitFlap.js` 59.69%, `cctvSources.js` 60.80%, `annotationResolver.js`
  62.17%, `gevActions.js` 62.31%. Worst small: `logoGaze` 26.49%,
  `cctvGizmo` 30.40%, `cockpitCloudEffects` 37.74%, `celestialRing` 37.90%.
- **Monoliths**: `src/ui.js` 10,417 lines; `vite.config.js` 5,957 lines;
  the flights fork totals 9,312 lines (`flights.js` 5,437 +
  `militaryFlights.js` 3,875) with duplicated ingestion/label/render
  pipelines.
- **Smells, recounted**: 862 `console.*` call sites (the audit's "147"
  sampled upstream, not here); 31 files bypass `apiEndpoints.js`;
  13 `create*OverlayEntry` factory clones; 2 blocking `window.prompt`
  dialogs (`src/scenes/director.js:519`, `:582`).
- **Headers**: `public/_headers` sets no CSP at all.
- **Pages Functions**: 8 untested `.ts` handlers — `adsblol.ts`,
  `ais-live.ts`, `analytics.ts`, `military-installations.ts`, `overpass.ts`,
  `radio.ts`, `regional-brief.ts`, `weather.ts` — beside the tested `.js`
  convention (firms, tomtom, launches, opensky-track, cctv, openzenith,
  adsblol/mil, adsblol/trace, realtime/*).
- **PWA**: precache manifest is 10 entries / ~6.1 MB.

### New findings this pass (not in the community audit)

- [ ] **`functions/api/radio.ts` breaks the SECURITY.md contract** (P0):
      SECURITY.md promises allowlist + redirect rejection + private-IP
      rejection + TLS pinning, but the Pages handler is a 52-line thin
      pass-through with none of it — those guardrails live only in the dev
      middleware (`radioProxyMiddleware`, `vite.config.js`). Fix by
      extracting the destination policy into a worker-safe shared module
      (the `cctvSources.js` pattern) used by both runtimes, with tests,
      then restore the unqualified SECURITY.md wording. Until fixed, the
      security claim on Pages is false.
- [ ] **`functions/api/adsblol.ts` dev/prod drift** (P0): dev serves a 12 s
      cache with stale-on-error; the Pages handler is a raw pass-through
      (no cache, no stale) — a slow or flapping adsb.lol feed takes the
      military layer down on Pages but not in dev. Port to `.js`, mirror
      the dev caching policy, add tests next to `adsblol/mil.test.mjs`.
- [ ] **Console surface**: 862 sites is too many to migrate blindly and too
      many to leave. Introduce a small logger module (level-gated, ring
      buffer for the existing debug-log function) and migrate per-module —
      start with the hot paths (`flights.js`, `ui.js`, `detection.js`),
      leave `?debug` gated logging explicit.

### Batch 1 — Correctness & security hardening (P0, small, independent)

- [x] Overpass + military-installations Pages handlers: DONE 2026-09-11,
      and worse than clamps-and-caps — `overpass.ts` relayed ANY unsanitized
      body to a mirror (planet-scale queries, no caps, no cache, no
      simplify), and `military-installations.ts` read a `bbox` param the
      client has never sent (it sends south/west/north/east), so the layer
      400'd on every production request while dev worked. Both were deleted
      and replaced by `functions/api/overpass.js` +
      `functions/api/military-installations.js`, which import the new shared
      worker-safe policy module `src/data/overpassPolicy.js` (sanitizer,
      mirror fan-out, simplify, bbox validation/quantization/cache keys, and
      the one `buildMilitaryInstallationsQuery` builder) — the exact module
      `vite.config.js` now uses, so the runtimes cannot drift (~19 KB of
      policy extracted from the config). Dev-parity contracts implemented:
      405/413/400/429/503-busy/degraded-verbatim/502 for overpass;
      GET-only, snapped-grid keying with `exact=1` re-ask, HIT/INFLIGHT/
      MISS/STALE headers, {elements, saturated, elementCap, retrievedAt,
      status} payload, stale-then-503 for installations. 20 new tests.
      Honest difference (documented in-file): dev's disk-cache tiers have no
      workerd analogue — Pages serves memory-stale at any age instead.
      Related routing fix in the same unit: `functions/api/tomtom.js` was an
      exact-route file, but the client only calls SUBPATHS
      (`/api/tomtom/status`, `/api/tomtom/flow/{z}/{x}/{y}.pbf`) — Pages
      routes static function files at their exact path only, so every
      production tomtom request fell through to the SPA. Moved to
      `functions/api/tomtom/[[path]].js` (tests moved alongside, 11/11).
- [x] Same-site request gate for `/api/openai/hud-summary` and
      `/api/google/nearby-places` (completes the token/debug-log pattern;
      PR #242 remainder): DONE 2026-09-11, generalized beyond the plan —
      every cost-bearing endpoint is now gated, and Google Places gained a
      Pages handler at all (`functions/api/google/[[path]].js`; previously
      BOTH places endpoints fell through to the SPA on static deployments —
      same fall-through class as the tomtom routing bug). One shared
      implementation, `sameSiteViolation` in `functions/_lib.js`: POST
      endpoints compare the `Origin` host against the request host (browsers
      always attach Origin to POSTs), GET endpoints read `Sec-Fetch-Site`
      (GET fetches carry no Origin). Anything except same-origin/`none` is a
      cross-site drive-by burning this deployment's quota → sanitized 403.
      Absent headers = non-browser client (curl, agents) — deliberately
      allowed, throttled instead. Wired into token (Origin variant message),
      hud-summary, debug-log, and both google subpaths (which keep the
      client's `places: []` error envelope on every failure).
- [x] Default-on rate limiting for exposed deployments: DONE 2026-09-11 via
      `createDefaultOnRateLimiter` in `functions/_lib.js` — on Pages the
      `GEV_RATELIMIT_OPENAI_PER_MIN` (default 30/min/IP) and
      `GEV_RATELIMIT_GOOGLE_PER_MIN` (default 60/min/IP) throttles engage
      with NO env configured; a positive integer overrides; `0` (or any
      other non-positive value) is the documented unlimited escape hatch.
      Dev's middlewares stay opt-in — localhost-bound, so unlimited is
      acceptable there. Same caching discipline as the existing opt-in
      factory (keyed on the raw env value, reused per isolate). Fixed
      en route: the factory's cache key initialized to `undefined`, so the
      very first unset-env call "matched" and built NO limiter — the
      default-on path was silently unlimited until a sentinel initial key
      made unset a real cache state. Also fixed a latent `Number(null) → 0`
      bug shared by both runtimes: a MISSING `lat`/`lon` param parsed as 0
      and queried Google for 0°N 0°E; the new shared
      `parseCoordinateParam` (in `src/data/googlePlacesPolicy.js`) treats
      missing/blank as invalid in dev and Pages alike. Tests: factory unit
      tests in `functions/_lib.test.mjs`, default-on + escape-hatch + 403
      gate coverage in the token/hud-summary/debug-log/google suites.
- [x] CSP in `public/_headers` — DONE 2026-09-11, shipped as
      `Content-Security-Policy-Report-Only` (the plan's "report-only mode
      first, watch, then enforce"). Includes `'unsafe-eval'` for the
      Knockout code inside `@cesium/widgets` (and the Maps JS API) and
      `'wasm-unsafe-eval'` for the Cesium decoders + FIRMS WASM renderer;
      `connect-src` covers the only DIRECT browser fetch targets — Google
      3D tiles, Cesium ion, the OpenAI Realtime SDP exchange, the re:Earth
      terrain mesh — while every data layer stays same-origin through the
      proxies (`'self'`). `media-src https:` is the one broad directive:
      radio streams play from arbitrary broadcaster hosts by design. The
      header file documents each directive's justification inline; no
      report-uri yet (violations are console-visible), so enforcement is a
      copy-to-enforcing-header once production reports are quiet.

### Batch 2 — e2e fleet validation (cheap now, high information)

- [x] Run `scripts/qa-l9-matrix.mjs` headless on this box (Linux/SwiftShader
      now works via `scripts/lib/webglLaunchArgs.mjs`); fix what falls out
      and extend the `checkSkip` keyless pattern to scripts that still
      hard-require Google keys. This validates ~39 QA scripts in one pass
      and tells us which are dead.
      Done 2026-09-11. Three matrix runs triaged every failure to root
      cause; the D7 fix wave (`1c16f46`) then drove `qa-cockpit-utility`
      from 43/52 to 52/52 READY across two consecutive runs: subject
      attrition now re-acquires via `awareness.navigateNext` before the
      `trackById` fallback; the utility-strip boundary seeds derive from
      production's own decision budget (launcher scrollHeight, the
      minTop-anchored flip point — the REC-anchored band self-normalizes
      `available` to the rendered strip, so no card position there can
      flip the decision); the height lever no longer double-subtracts the
      rendered-vs-specified drift; the held-request stub re-raises
      camera `moveEnd` while a follow camera tracks a moving subject
      (Cesium never fires it, which starved the module's 500 ms debounce);
      server-owned 5xx/429/420 on local `/api/` targets are tolerated as
      environment, with the count logged. Matrix findings feeding later
      batches: live per-IP budgets (adsb.lol 420s under repeated runs)
      cap how many fleet runs can share one warm server; a4/a10-style
      feed-fallback attrition (UUID row ids) is environmental for
      cockpit-trackable checks.
      Wave 2 (2026-09-12, box reboot): the D-wave triage reached root
      cause on D4 and D6 and shipped product fixes, not harness
      tolerances.
      **D4 — empty-space deselect eaten on every click.** The
      tracking-click duration gate measured handler-processing time:
      under SwiftShader the LEFT_UP action runs 0.5–2.6 s after the
      physical release, so every instant tap exceeded the 400 ms window.
      Three stacked product fixes in `trackingClickGesture.js`: the
      clock measures press duration from DOM event stamps (stamps
      survive queue delay), a quantization floor
      `max(2 × recent-peak rAF gap, learned tap-quantization baseline)`
      forgives burst-frame stamp gaps (both estimates decay with
      τ = 30 s; a press is never forgiven by its own gap), and when the
      floor itself reaches the click window all presses report instant —
      a machine that cannot express the tap/hold distinction must not
      lose working clicks; travel stays the only enforceable gate. The
      final defect looked like a stale vite module but was not: CDP
      headless Chrome generates NO compatibility mousedown/mouseup —
      only `pointerdown`/`pointerup` — so the stamp clock (and any
      mouse-bound listener) silently never ran while Cesium's
      pointer-based handler kept working. `domEventPressClock` now binds
      pointer events with a mouse fallback (never both), plus
      pointercancel. Harness side: group 5 of `qa-cctv-v2` settles the
      camera before searching, re-verifies empty targets at click time
      (the monitor plane's screen extent shifts), re-baselines pose with
      forced renders (under requestRenderMode the signature is frozen,
      so the first forced render applied Cesium's ~4 m terrain-collision
      nudge and framed the click for it), waits for the one-shot
      mesh-floor pass on the module's timeline instead of fixed budgets,
      and aborts cleanly when the upstream camera catalog 404s. Result:
      48 passed / 0 failed / 6 inconclusive (the documented headless
      patterns: GL drain, late-floor viewshed rebuild, gizmo-drag chain).
      **D6 — attribution lightbox (and the globe itself) broke on
      mobile.** `main.js` imported CesiumWidget.css but not Viewer.css,
      so `.cesium-viewer`/`.cesium-viewer-cesiumWidgetContainer` had
      auto height and the widget's `height:100%` resolved against
      nothing — the canvas collapsed to 280px of a 760px mobile
      viewport (and rode ~80% on desktop). Importing Viewer.css fills
      the chain; the app's `!important` chrome hides keep stock UI
      dead. `qa-attribution-b12`: 21/0/3 owner-decision skips. D9
      (`qa-floor-verify`) PASS on the same build.
      **Matrix run 5 (2026-09-12, full 70-check pass, 98.2 min):** 42 PASS /
      2 PASS-with-skips / 4 FAIL / 2 CRASH / 20 SKIPPED. D2, D3, D4 (49/0/5),
      D5, D9, D10, D12 all green on the fixed build — the D-wave product
      fixes held under the full fleet. Arbitration of the residuals:
      D6's CRASH is a parser artifact already fixed on disk (the suite's
      own RESULT line, "21 passed, 0 failed, 3 skipped (owner decision)",
      carried a trailing parenthetical the RESULT_RE rejected; verified
      standalone at 21/0/3). D1's two display-floor records are harness
      calibration, not product: the regime assertion reads the floor at
      the billboard's DISPLAY cell while the billboard sits at its FIX-cell
      floor + lift (204.5 = 203.0 + 1.5 exactly); with the full-height
      canvas streaming better tile coverage the mesh floor now resolves
      per-cell where a smooth DEM fallback used to agree within the 1.0 m
      tolerance. Remaining for the next unit: C11 (bundled layers read
      count=0/error=none — the enable transaction never landed), C16
      (post-quiesce camera flight did not move), D7 (cockpit-exit listener
      arithmetic 4→4 vs expected +1), D8 (3 radio overlay-paint records).
      **Run-5 residual unit (2026-09-12, all verified on the fixed
      build):** the unifying defect was *frame-scarcity reads* — under
      SwiftShader a fixed settle can expire with zero rendered rAF ticks,
      so any assertion sampled after one races the mechanism that was
      supposed to deliver the state. **D1** (`track-regression`): product
      seam `_displayFloorStateForTest()` (flights.js) exposes the clamp's
      sticky cell + post-hold effective floor, so floor assertions read
      the product's truth instead of a raw-cell harness recomputation
      (a sticky boundary cell made run 5 read 203.0 vs the harness's
      192.4); regime IN now polls for the stand-aside contract
      (`|entityH − subjectH| ≤ 3` while the GLB owns the visual) and the
      loading records poll to convergence instead of blind settles.
      100/0/0. **D7** (`qa-cockpit-utility`): product fix — ui.js
      `restoreTrackingFrame` gains a `refocusTrackedById` fallback so
      cockpit-exit tracking restoration survives an entity-id swap;
      harness: camera-reframe convergence poll (probe proved the reframe
      lands in 250–500 ms, the old 180 ms sample just expired) and an
      attrition-hardened cockpit entry (3× recover-via-ensureTrackedFlight).
      READY, 0 failures. **D8**: held, 106/0/0. **C11/C16**
      (`qa-l9-matrix`): two harness defects, product exonerated by an
      isolated probe (installations: ready, 81 records, ~3 s on a quiet
      page). (a) C11 fired its `/api/military-installations` cross-check
      seconds before settle() enabled the layer at the same camera — two
      near-simultaneous identical Overpass queries serialize upstream and
      the layer's fetch (the thing under test) is the one that waits:
      loading=true / lifecycle=enabling for the whole poll budget. The
      probe now runs only in branches that consume it, after the poll;
      the lifecycle queue is drained (with a busy-queue CRASH guard)
      before the segment; the poll is 60×1 s. (b) the post-quiesce
      drain was one long in-page sleep loop — itself a victim of the
      saturation it measures (two 200 s eval timeouts back to back); it
      is now Node-side short-eval snapshots (instantaneous reads, 5 s
      fail-fast retries, 3 min budget) where null honestly means "never
      got one readable snapshot". Verdict discipline kept: still-loading
      at budget expiry is a CRASH (inconclusive) carrying
      status/loading/lifecycle/observed evidence, never a bare
      "rendered 0".

### Batch 3 — Coverage campaign (P1, mechanical but large)

- [x] Pages Functions first (2026-09-13): the four untested handlers
      (ais-live, analytics, regional-brief, weather) now carry co-located
      worker-safe tests locking their degradation contracts, CORS method
      policy, and (weather) the host/path rewrite + upstream-error
      pass-through; `functions/` measures **99.31% lines** (c8). Also
      removed the stale pre-Batch-1 `overpass.ts` +
      `military-installations.ts` duplicates that had been sitting on the
      same Pages routes as their hardened `.js` ports since 45e8ad4.
- [x] Measurement honesty (2026-09-13): coverage moved to c8 (see Phase 3
      note); flights.js was mis-prioritized by the reporter bug — its true
      coverage is 75.1%. 11 new flights tests (2026-09-13) lock the
      detection/query read surfaces: `getDetectableObjects` (stride/seed
      sampling, hidden-contact skip, cockpit self-exclusion, object-identity
      caching), `getAllPositions`, `hasContact` (null-when-cannot-know),
      `findByQuery` tiered identity matching (hex > callsign >
      registration), `getNearby` (range/sort/includeHidden), and
      `getAnalystRecords` truncation.
- [x] Then the REAL worst large modules (2026-09-13, measured by c8 after):
      `mapStackController.js` 38.2% → **100%** (14 tests: MAP_STACKS
      contract, constructor fallbacks, unavailable/unknown-id refusals, the
      OSM happy path with Re:Earth terrain, provider/terrain caching, the
      flat-ellipsoid fallback + its cache, photoreal round-trip, the M7
      stale-switch race with a deferred `IonImageryProvider.fromAssetId`
      stub, error rollback, the ion world-terrain regime, silent switches,
      unsupported-kind throw. Test seam lesson: Cesium's ESM namespace is
      frozen — patch the mutable class statics
      (`IonImageryProvider.fromAssetId`, `CesiumTerrainProvider.fromUrl`,
      `Terrain.fromWorldTerrain`) and use the real offline-safe
      constructors); `worldAnnotationRenderer.js` 47.6% → **97.7%** (10
      tests through a real `CustomDataSource`: building volume/cage/glow
      with ground-sampling percentile + anchor fallback + invalid-sample
      rejection, area dash-vs-glow + synthesized alpha, the GevRouteFlow
      per-frame uniform contract, arrow midpoint labels, ring-radius
      clamps, alpha clamping, remove/destroy. The four browser globals
      `HTMLCanvasElement/HTMLImageElement/ImageBitmap/OffscreenCanvas` are
      stubbed per `hybridAnnotationRenderer.test.mjs` because Cesium's
      Material factory touches them even for pure-GLSL fabrics);
      `traffic.js` 39.2% → **46.35%** via a `_trafficInternalsForTest` seam
      (12 tests locking the Overpass query shape, one-way semantics,
      waypoint sub-sampling, dot-budget fairness/largest-remainder under a
      starved cap, altitude spacing bands, and viewport geometry); the
      residual gap is the viewer-bound render/animate/fetch lifecycle,
      which the Puppeteer QA suites own. `gevActions.js` 60.2% → 60.3%: the
      pure helpers (`readLayerLifecycleSummary` fallback chain,
      `knownRadioLocation` bounds-midpoint/country-center branches) gained
      4 tests; the rest of that module's gap is runner flow already
      covered by 77 tests, diminishing returns. Net: `src/` 75.3% →
      **80.16%** lines.
- [ ] Milestone honesty: the 99% goal is aspirational; 80% lines on all
      `src/data/` + `functions/` is the credible 0.8 target (modules with
      heavy Cesium coupling are integration-tested via the QA harness
      instead). src/ now sits at 80.16% — at the target line; the next
      coverage wins are per-module judgement calls, not bulk campaigns.

### Batch 4 — Architecture debt (P1, unblocks everything else)

- [x] Extract `vite.config.js` middlewares into per-endpoint modules
      (issue #41). DONE 2026-09-13: the config is now a ~290-line assembly
      and each middleware lives in `vite/proxies/<endpoint>.js` (radio,
      celestrak, launches, tomtom, firms, terrain-heights, openzenith,
      adsbdb, overpass, opensky, adsblol, track-backfill, gbfs, cctv,
      ais-live, realtime, google-places, military-installations, regional)
      with shared infrastructure (rate limiters, same-site gates, capped
      readers, OpenSky OAuth) in `vite/proxies/_shared.js`. Bodies moved
      verbatim (line-integrity verified against the original); declarations
      are exported so unit tests import the true homes
      (`radioProxy/overpassProxy/installationProxy/regionalProxy.test.mjs`
      repointed; the `export {…} from overpassPolicy` re-export shim in the
      old config is gone). Prerequisite for testing the dev side of every
      parity fix is now in place: the four proxy suites run green against
      the modules directly (47/47), and a live smoke of all 20 dev proxies
      (keyless contracts + real upstream data) passed on the new assembly.
- [x] Consolidate `apiEndpoints.js` (31 bypassers). DONE 2026-09-13:
      `src/config/apiEndpoints.js` now carries `api` — a single builder
      inventory (34 builders) with one function per concrete client-callable
      route; all ~36 call sites migrated byte-for-byte (asserted script,
      one exact-match replacement per site), so no client code composes
      `/api/...` literals anymore. The new
      `src/config/apiEndpoints.test.mjs` locks the parity contract the
      docs only used to assert: every inventory route must be served by
      BOTH the dev middleware (walked from `createViteConfig()` plugins)
      AND a Pages Function (walked from `functions/api/`), every dev mount
      and every Pages route must be declared, and every builder must emit
      the exact URL its call site used to compose. The test immediately
      caught four routes with a dev middleware but NO Pages Function —
      `/api/terrain/heights`, `/api/route`, `/api/weather-effects`,
      `/api/gbfs` silently 404'd on Pages deployments (bikeshare, route,
      camera-weather and ground-floor layers were prod-broken) — all four
      now have workerd ports over shared worker-safe policy modules
      (`src/data/routePolicy.js`, `weatherEffectsPolicy.js`, `gbfsPolicy.js`;
      the dev middlewares were refactored onto the same code, so the
      runtimes cannot drift). Inverse finding: `/api/weather` had a Pages
      Function with no dev mount and no caller — dead endpoint deleted
      (`functions/api/weather.ts` + test). Also closed: `/api/analytics`
      had a client caller (`src/react/hooks/useSessionTracking.ts`) but no
      dev mount — added `vite/proxies/analytics.js`. NOTE for Batch 5: the
      whole `src/react/` tree is imported by nothing (unwired experiment);
      deletion or revival is an owner decision, only referenced here.
- [x] One `createOverlayEntry` helper for the 13 factory clones. DONE
      2026-09-13: `src/overlays/overlayEntry.js` now owns the three
      host-default presentation flags (`interactive: false`,
      `horizonCull: true`, `terrainOcclusion: false`) that all 13
      `create*OverlayEntry` factories (earthquakes, satellites ISS, radio
      ×3, bikeshare, trackedReadout, cctv projection, cctvCards
      thumbnail, submarine cables, rocket launches ×2, local
      infrastructure) re-declared verbatim. `...entry` wins, so genuine
      per-entry decisions stay at the call site (CCTV thumbnails keep
      `interactive: true`; local-infrastructure cards deliberately omit
      `verticalOnly`). Verified against the host normalizer
      (worldOverlay.js `_normalizeEntry`): an absent field normalizes
      exactly as the baseline value, so outputs are behaviorally
      identical. The two `apply*OverlayPolicy` merges
      (vesselLabels, firmsHeatmap) deliberately stay explicit — they
      spread `...card` first, so moving their flags to pre-spread
      defaults would flip precedence.
- [ ] Logger migration (see new findings) after Batch 1 lands. STARTED
      2026-09-13: `src/logger.js` — level-gated (`?log=<level>` or
      `window.__godsEyeView.logger.setLogLevel`, default `debug` so
      migrated call sites keep their shipped console behavior) with a
      bounded 500-entry ring buffer (`peekLogBuffer`/`drainLogBuffer`)
      that records even gate-suppressed entries, plus
      `recordDebugEvent` — the voice debug-log pipeline
      (`gevRealtime.debugLog` → `/api/realtime/debug-log`) now lands its
      sanitized records there too. Hot paths migrated (flights.js 9,
      ui.js 8, detection.js 3 call sites; `console.log`→`logDebug` so
      even the console METHOD is preserved for the boot-verification
      lines QA asserts on). Remainder of the ~840 sites migrate
      per-module as they're touched; `?debug`-gated logging stays
      explicit.

### Batch 5 — Large refactors (P2, each needs its own plan + tests first)

- [x] Split `src/ui.js` along its existing section banners into
      `src/ui/*` — behavior-preserving, moved with their co-located
      tests. DONE 2026-09-13, all 5 seams:
      `src/ui/CockpitViewController.js` (seam 1: the cockpit HUD loop,
      1,616 lines, byte-identical), `src/ui/radioPanel.js` (seam 2:
      the five Radio panel methods, 815 lines, transform-identical),
      `src/ui/cctvPanel.js` (seam 3: the thirteen CCTV panel
      methods + the `CCTV_CAL_FIELDS` calibration table +
      `signedNormalizeDeg`, 623 lines, transform-identical; public
      three stay as thin delegates so the method surface is
      unchanged), `src/ui/panelAdaptiveLayout.js` (seam 4: the six
      adaptive rail/accordion methods + the two obstacle-selector
      constants, ~770 lines, transform-identical; all six stay as thin
      delegates because qa-radio calls the sync methods at runtime),
      and `src/ui/locationBar.js` (seam 5: the thirteen location-bar
      methods — city pills, QWERTY POI row, geocode search, world-jump
      transitions, mini-status — 356 lines, transform-identical; six
      stay as thin delegates for the voice/scene/init callers).
      ui.js 10,500 → 6,438 lines. Source-text contract tests re-pointed
      per seam. Gates per seam: lint clean, 2,971 tests + 14
      allocation probes, build ok, and the matching QA harnesses
      (seam 2: qa-radio 106/106, qa-cockpit-utility 52/52; seam 3:
      qa-cctv-v2 48/48 after one live-data flake run — a real camera
      parked at the scripted click point — didn't reproduce; seam 4:
      qa-radio 106/106, qa-cockpit-utility 52/52 after one live-data
      flake run — the tracked flight was attrited from the live
      adsb.lol feed mid subject-transition, dropping Cockpit out;
      rerun didn't reproduce; seam 5: qa-cockpit-utility 52/52,
      including the Location-pill → world-jump → Contact-handoff check
      that drives the moved code).
- [x] Unify the flights fork: DONE 2026-09-13, both sub-units shipped
      (c+d folded into them — the trail/model-spec config and the
      `_ForTest` surface landed with their owning sub-unit). The shared
      pipeline is `src/data/flightsTracking.js` (1,284 lines) exporting
      `createFlightTrackingPipeline(config)`: the 45 verbatim fns plus
      the 11 near-identical fns as closures over ~80 state items, with
      the 15 per-layer hooks passed in and the 11 near-deltas expressed
      as role-named knobs — `trackedFocusScaleBase` (1 vs
      BILLBOARD_SCALE 0.7), `trackedLabelAccent` ('#39d0ff' vs
      '#ffd166'), `unmodeledTrackedColor`/`modeledIconColor` (cyan vs
      amber family), `infoSpeed`/`infoHeading` accessors
      (`velocity|true_track` vs `speedMps|track`), `fleetFreshnessColor`,
      `trailFloorFix` (military's `_trailFloorPosition`; flights omits
      it → falsy → raw push), an optional-call `requestTypeEnrichment`
      (flights only), and per-spec `blendAmount` supplied by military's
      own `_modelSpec`. `_driveFleetModelHandoff` needed no knob (the
      divergent heading offset is military `_modelMatrix`'s existing
      default param). `flights.js` (4,506 lines) and
      `militaryFlights.js` (4,973 → 3,018 lines) keep their divergent
      fns, ingestion, and layer object, and address shared state
      through their private `p` instance; each re-exports its 6 moved
      `_ForTest` probes as signature-verbatim wrappers. Combined
      9,358 → 8,808 lines with ONE copy of the
      tracking/DR-display/billboard/cockpit/trail pipeline. Proof:
      transform-identity (all 56 moved bodies byte-identical to their
      originals after the `p.` rename), mechanical B checks (no
      leftover moved decls, wrapper signatures match HEAD, all 24
      factory config keys provided by both layers with only the two
      designed absences, knob values pinned to the originals), gates
      per sub-unit (lint 0 warnings, 2,973 tests + allocation probes,
      build ok) and qa-cockpit-utility READY per sub-unit (sub-unit b
      run 1 hit two cold-server timing failures in the
      installations-gating probes — payloads identical to the run that
      passed after sub-unit a except for lifecycle phase; rerun READY
      0 failures). Seven white-box test files re-pointed to read
      `layer + factory` combined source with `p.`-prefixed pins.

### Batch 6 — Perf, bundle, a11y remainder (P2/P3)

- [ ] Render-perf five (Phase 7 backlog) with before/after measurements —
      DONE, see the Batch 6 entry above (instrument:
      `scripts/profile-render-perf.mjs`).
- [ ] Icon font subsetting (PR #239) + precache diet: audit the 6.1 MB
      manifest — don't precache multi-MB datasets that can lazy-load on
      first layer enable.
- [x] Bundle budgets in CI (issue #40) once the diet lands — DONE
      2026-09-13: `npm run check:budgets` after the production build in the
      CI build job; policy table `src/config/bundleBudgets.js` (7 unit tests:
      table shape, real-artifact classification, every violation mode, and
      source pins on the workbox globPatterns/cap and the CI wiring), CLI
      `scripts/check-bundle-budgets.mjs` (prints the measured-vs-budget
      table, exits non-zero, `--json` for machine runs). Verified against the
      fresh build: dist 30.3 MB, precache shell 6.15 MB / 6.35 MB budget,
      index chunk 5.91 / 6.00 MiB (workbox cap), all 9 artifacts OK, PASS.
- [x] `window.prompt` → accessible modal in `director.js` (a11y +
      testability; blocking dialogs also freeze the render loop).
      DONE 2026-09-13: new `src/ui/promptDialog.js` provides
      `promptDialog()` / `confirmDialog()` on the native `<dialog>`
      element — `showModal()` supplies the focus trap, inert page, and
      focus restoration; the field is visibly labelled, `aria-labelledby`
      names the dialog, initial text is preselected like `window.prompt`,
      and Enter explicitly activates Confirm (implicit form submission
      would hit the first submitter — Cancel — silently inverting the
      gesture; caught by the browser probe, pinned by a unit test).
      All four blocking calls in `director.js` are replaced (shot
      rename, new scene, delete scene, delete shot); the styled dialogs
      live in `style.css` (token-based, AAA contrast, `:focus-visible`
      rings, reduced-motion guarded). A scratch Puppeteer probe verified
      in real Chrome: modal opens focused, requestAnimationFrame keeps
      firing while the dialog is up (the render loop no longer freezes),
      Enter creates the scene, Esc cancels, Cancel keeps, Confirm
      deletes; 6 unit tests pin the wiring + no-blocking-dialogs source
      pin. Gates: lint 0, 2,979 tests, build ok.
- [ ] Remaining Phase 7 backlog items (portable tests, panel clamping,
      CCTV source-pack validation, `.overpass` mirrors, FIRMS IPv6,
      DATA_PRESET honesty, accessible-name test, allocation gates on
      Node 26, Google server-key split, keyless geocoding).
- [ ] **Google ToS attribution (owner decision owed, surfaced by matrix
      C13 every run)**: the operator detached the Cesium credit container on
      2026-08-29 (src/main.js — decision + caveat recorded there), but
      Google Maps Platform ToS requires visible attribution for
      Photorealistic 3D Tiles. Either restore a visible credit line or ship
      an equivalent attribution surface; until then the L9 matrix reports
      C13 as SKIPPED[OWNER-RUN] rather than silently dropping the
      compliance signal.

### Process debt

- [ ] Version-bump discipline: `package.json` rode at 0.1.0 until v0.7.0 —
      add "bump version + changelog" to the release checklist so tags and
      package version never diverge again.
- [ ] GitForge pipeline (task #7 of the session plan) remains BLOCKED on
      the interactive `gitforge auth --login`; the gateway rejects the
      CLI's stored credentials and the orchestrator is down. No gitforge
      remote exists for this repo yet. GitHub Actions (lint + tests +
      build) remains the active CI.
- [ ] GitHub repo was renamed `gods-eye-view` → `Globe` (origin URL still
      uses the old name and works only via redirect) — update the origin
      URL on next push round.

## Deliberately deferred (documented, not forgotten)

These are known gaps with reasons, not oversights:

- **gbfs / tomtom / firms / google-\* / military-installations / regional-brief
  / weather-effects Pages Functions**: keyed or self-hostable paths whose dev
  middlewares carry credentials; porting them without a key story would either
  leak keys or fake data. Revisit after the key-signup pass
  (see [DATA_SERVICES_CATALOG.md](DATA_SERVICES_CATALOG.md)).
- **AISStream WebSocket in production**: requires Durable Objects (stateful
  WebSocket relay), a paid-plan dependency. Vessels remain dev-server-only
  until that is justified.
- **Per-isolate rate limiting**: Cloudflare isolates are per-colo, so the
  limiter's "per minute" is per-isolate. A global limit needs
  Durable Objects or Workers KV — accepted for now because the limiter's job
  is burst protection, not accounting.
- **One dev-only dependabot alert** (`extract-zip` via puppeteer): accepted
  with rationale rather than a semver-incompatible override; it never ships.
