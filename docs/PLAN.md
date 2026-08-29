# God's Eye View — Hardening & Quality Plan

Updated: August 29, 2026

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

## Phase 2 — Strict lint & code smells (IN PROGRESS)

- [x] ESLint 9 flat config (`eslint.config.js`): `js.configs.recommended` plus
      error-level discipline rules — `eqeqeq`, `no-var`, `prefer-const`,
      `curly`, `no-unused-expressions`, `no-implicit-coercion`,
      `prefer-template`, `object-shorthand`, strict `no-unused-vars` with a `^_`
      escape hatch. `npm run lint` runs with `--max-warnings 0`.
      `no-console` is deliberately off: the console IS this app's telemetry
      channel, in the browser and in Pages Functions.
- [x] Three latent runtime crashes fixed because the first lint baseline
      surfaced them (see Phase 1.2).
- [ ] Mechanical cleanup to green: ~469 findings (implicit coercions, dead
      locals, regex space runs, expression statements). In flight.
- [ ] Lint gate added to CI alongside `npm test`.

## Phase 3 — Test coverage toward 99% (OPEN)

The suite is the safety net for everything above: 2700+ co-located tests
(`npm test`, headless, plus two serialized allocation probes). Gaps to close:

- [ ] `src/ui.js` and `src/main.js` remain the least-tested modules (boot
      path, panel wiring). Extract-and-test the pure helpers first; do not
      chase line count by snapshotting the DOM.
- [ ] Pages Functions: happy paths are covered; add contract tests for the
      rate-limiter budget boundaries and the CCTV SSRF guard matrix.
- [ ] Measure, don't guess: add a coverage reporter (node's built-in
      `--experimental-test-coverage` first; c8 if per-branch data is needed)
      and publish the number in CI before claiming any percentage.
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
      `--report-only`). Headless Chrome cannot run in the primary dev
      container (see the runbook note), so the first live axe pass must run
      on a workstation.
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

## Phase 5 — Performance profile & WASM (OPEN)

Performance, reliability, and controlled system requirements are the priority.
Order of work, cheapest-first:

- [ ] Profile before rewriting: Chrome DevTools performance traces of a cold
      boot, a layer storm (all layers on), and a tracked flight under Cockpit.
      Output: a ranked list of main-thread hot spots appended to
      [PERFORMANCE.md](PERFORMANCE.md). No WASM before this exists.
- [ ] Algorithmic wins first (these are known, measurable, and don't need
      WASM): AIS row normalization batch sizes, detection projection worker
      backpressure, label solve cadence under dense mode.
- [ ] WASM candidates, only where profiling proves the JS is the bottleneck:
      the FIRMS heatmap renderer (`rust/firms-renderer/` — the crate is
      implemented and builds; `render_heatmap(lons, lats, brights, viewport)`
      returns an alpha-encoded RGBA buffer) and potentially SGP4 batch
      propagation for dense catalogs. SIMD only for splatting/inner loops
      that are already vectorizable. The FIRMS wiring is a visual-output
      change: it must land with runtime verification on a machine that can
      run the app, behind a JS fallback — not blind.
- [ ] Concurrency: audit every `await`-in-loop over large cohorts for
      parallelizable fan-out; verify the workers are actually parallel on the
      paths that matter (visibility, projection, label solve).

## Phase 6 — CI/CD, release, deploy (PARTIALLY DONE)

- [x] GitHub Actions (`.github/workflows/ci.yml`): test job (Node 24,
      allocation gate on) and build job (artifact upload). No deploy job by
      design — deploys are explicit (see runbook).
- [ ] Add the lint job once Phase 2 lands.
- [ ] GitHub release with changelog; then `wrangler pages deploy dist` to
      production and verify the Functions surface on the deployed URL
      (elevation, reverse-geocode, cctv, celestrak, debug-log) plus the
      globe itself rendering.

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
