# KNOWN ISSUES

Updated: August 29, 2026

This file tracks active runtime issues only.

This file records current known issues; historical planning material is not part
of the public release.

---

## Open

### Street traffic can be slow/uneven when panning across dense city blocks
Status: Open (partially mitigated)

Context:
- Current traffic loader fetches one clamped viewport tile at a time (major pass, then full pass).
- In dense cores, some visible roads can appear late after city jumps or fast pans.
- Zooming into adjacent streets does not always immediately trigger higher-detail coverage for all visible roads.

Current mitigation in runtime:
- Fair per-road dot budget allocation (reduces hard starvation under global `MAX_DOTS` cap).
- Center-shift threshold (reduces stale overlap lock while panning).

Next iteration candidates:
- Prioritize currently visible road segments inside the active viewport before off-center segments.
- Add neighbor prefetch ring for nearby tiles after jump-to-city actions.
- Add adaptive dot cap by frame time (coverage first, density second).
- Promote sync chip from loading indicator to true multi-phase progress.

---

### Height-datum residuals
Status: Open (accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  the height-datum section in `docs/CURRENT-STATE.md`.

---

## Closed / Intentional (for clarity)

### CCTV panel can appear "missing" after layout refactors
Status: Closed as fixed on `main` (September 2026)

Context:
- Panel positions persisted in local storage could restore off-screen after
  UI changes (audit U2: a panel restored at `x:-192` was unreachable until
  the panel store was cleared).

Fix:
- `clampPanelToViewport` (`src/ui/panelViewportClamp.js`, PR #215) is applied
  by BOTH callers that can place a panel — the localStorage position restore
  and the drag handler — so a position saved at one window size can no longer
  land off-screen at another. Pure math pinned by
  `src/ui/panelViewportClamp.test.mjs`.
- `purgeStalePanelStorage` (`src/ui/panelStoragePurge.js`, PR #190) removes
  superseded generations of the versioned panel key families at panel init,
  so stale-version keys stop accumulating (and old workarounds like deleting
  `godsEyeView.v6.panelPos.*` by hand are obsolete).

Validation:
- `node --test src/ui/panelViewportClamp.test.mjs
  src/ui/panelStoragePurge.test.mjs` plus the restore-path wiring in
  `src/ui.js` (both call sites clamp).

---

### CCTV layer dead on init; `/api/realtime/debug-log` and HUD summary 404/405 in production
Status: Closed as fixed on `main` (August 2026)

Context:
- Two independent root causes produced a dead CCTV layer and the console errors
  `POST /api/realtime/debug-log 405` / `[HUD] AI summary unavailable: HTTP 405`:
  1. Production was deployed as a static site with **no** Pages Functions, so
     every keyless dev middleware 404'd; a stray legacy handler answered the
     debug-log POST with 405. All keyless endpoints now exist under
     `functions/api/**` (see `docs/PLAN.md` Phase 1).
  2. `cctv.js` `init()` referenced a `priorsPromise` variable a refactor had
     lost — `ReferenceError` before any camera rendered. Restored (the
     `resolveGroundPriors` batch applies post-hoc again).

Validation:
- `node --test src/data/cctv.test.mjs` (browser-side init paths), the
  `functions/api/**` suites, and the runbook's post-deploy checklist
  (`docs/RUNBOOK.md`).

---

### Label-solve worker fast path crashed on every solve
Status: Closed as fixed on `main` (August 2026)

Context:
- `labelSolve.worker.js` built its ordered-placement corners table with
  shorthand properties (`{ py }`, `{ px }`) that named no variable, so
  `firstOrderedPlacement` threw `ReferenceError` on every invocation — the
  worker's dense fast path never ran and solves fell back. The E/C corners now
  carry the same centered coordinates their siblings use. Found by the strict
  ESLint baseline (`no-undef`), which is exactly why `npm run lint` is a gate.

---

### `processChunked` fallback scheduler crashed instead of yielding
Status: Closed as fixed on `main` (August 2026)

Context:
- In any environment without `requestIdleCallback`, the `setTimeout` fallback
  was doubly broken: the timer invoked `runSlice()` with no deadline, so the
  first slice died on `deadline.timeRemaining()` (`TypeError`), and the
  reschedule line referenced the bare `requestIdleCallback` global, so even
  past that it would `ReferenceError` after one slice. Fallback slices are now
  bounded by `chunkSize` (which also gives the long-unused parameter its
  documented purpose), and rescheduling goes through the same scheduler that
  started the drain. Found by the new unit tests; both behaviors are pinned.

---

### Proxy SSRF and error-surface hardening gaps
Status: Closed as fixed on `main`

Context:
- Proxy middleware previously allowed broader error/internal surface area and looser upstream handling.
- Current `main` includes hardened proxy behavior in `vite.config.js`:
  - CCTV upstream URL no longer accepted from client query params.
  - Error payloads are sanitized.
  - OpenSky cache stores successful responses only.
  - OpenSky token refresh is coalesced.
  - GBFS/CCTV memory growth is bounded.

Validation target:
- `vite.config.js`

---

### NVG vignette edge color bleed
Status: Closed as fixed in current shader composite

Context:
- Earlier builds leaked original scene colors near the NVG tube edge.
- Current composite now masks NVG output with tube falloff before final blend, removing the color edge bleed.

Validation target:
- `src/styles/surveillance.js`

---

### Wildfires layer unavailable / static bundled snapshot
Status: Closed — live FIRMS integration shipped (2026-07-16)

Context:
- Wildfires (NASA FIRMS) were removed from runtime in v0.5.3, returned June 2026 as a
  bundled-snapshot layer (`local-firms`, 2026-05-25 data, ~58 MB in-repo), and were
  converted to **live NASA FIRMS data** on 2026-07-16: the `/api/firms` proxy merges
  three VIIRS NRT sources (trailing 24 h, 30 min cache, serve-stale-on-failure) and the
  bundled snapshot was deleted. Requires a free server-side `FIRMS_MAP_KEY`; without it
  the layer shows a KEY REQUIRED state.
- Weather radar is still held out of OSS v1 after QA found the previous overlay did not provide reliable visible value.
