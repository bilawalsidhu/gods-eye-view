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

The suite is the safety net for everything above: 2748+ co-located tests
(`npm test`, headless, plus two serialized allocation probes). Gaps to close:

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
- [ ] Live axe pass over HUD, layer panel, first-run launcher, and voice
      overlay; triage the report into fixes.
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

Open backlog, cheapest-first (re-verify each against this tree before
acting — the audit described upstream's tree):

- [ ] Icon font subsetting (PR #239): the full Material Symbols variable font
      (~330 KB, render-blocking) serves 28 glyphs, and a second icon family
      stylesheet nothing uses is fetched every boot. Subset via
      `icon_names=`; generate the glyph list from source (element text AND
      `textContent` assignments — a missing glyph renders the literal word
      mid-cockpit, no missing-glyph box) and pin it with a test.
- [ ] Render-perf five (issue #8): gate `preserveDrawingBuffer` to capture
      modes (`main.js`), drop `msaaSamples: 4` → 2 or adaptive, replace the
      worst `backdrop-filter: blur()` panels (58 rules — compositor reads and
      blurs the WebGL canvas beneath every frame), build the compass tape
      once and slide it via `transform` (it currently rebuilds `innerHTML` on
      division changes during camera motion), cap the world-overlay canvas
      backing-store DPR (`worldOverlay.js`, ~19 MB at DPR 2). Each with a
      before/after measurement.
- [ ] Security gate for key-bearing endpoints (PR #242, issues #16–#18,
      #22–#24): same-site request gate for `/api/realtime/token`,
      `/api/openai/hud-summary`, `/api/google/nearby-places`,
      `/api/realtime/debug-log`; default-on rate limiting for exposed
      deployments; server-side redaction/shape validation for debug-log
      instead of browser-side. Note the CSP trap PR #242 verified: Knockout
      inside `@cesium/widgets` needs `'unsafe-eval'` in `script-src` or the
      widget never initializes. Extract the middleware out of
      `vite.config.js` (issue #41) first so these are testable per-module.
      Apply the same review to `functions/api/**` (the audit never saw it).
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
- [ ] Bundle budgets (issue #40): egm96-universal 2.77 MB (1.87 MB gzip),
      regions 1.99 MB, index 1.35 MB, plus multi-MB datasets; audit what
      ships by default vs loads on layer enable, then add CI chunk budgets.
      Pairs with the PWA precache manifest (don't precache what you can
      lazy-load).
- [ ] Test-suite portability: `.gitattributes` (`* text=auto eol=lf`) +
      newline-agnostic source anchors (issue #88; several tests regex
      `src/ui.js`), and note the formatter constraint (PR #227): ~86 tests
      assert source text, so a repo-wide format pass requires re-pinning
      them first.
- [ ] `track-regression.mjs` ground probe: pin no absolute `sampleHeight`
      count (deterministically 3 vs the expected ≥4 on upstream; cold-cache
      terrain timeout) and add the timed-out-driver guard so a timeout can't
      read as "flat" (issue #44, PR #171's approach).
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
