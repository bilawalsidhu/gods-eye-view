# Changelog

This changelog records public product changes. For the authoritative description
of current runtime behavior, see [`docs/CURRENT-STATE.md`](docs/CURRENT-STATE.md).

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
