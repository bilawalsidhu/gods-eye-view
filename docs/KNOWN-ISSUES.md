# KNOWN ISSUES

Updated: July 8, 2026

This file tracks active runtime issues only.

For the roadmap and open backlog, see the repository issue tracker.

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

### Weather does not draw under a photorealistic 3D map stack
Status: Open (declined — the available mechanism is not good enough)

Context:
- Weather is the only data layer that stops in Google 3D. Every other layer
  draws entities or primitives, which render regardless; Weather owns Cesium
  imagery, and a photoreal stack sets `globe.show = false`, which takes all
  globe imagery with it. The row reports `UNAVAILABLE · GLOBE HIDDEN IN 3D`.
- Cesium 1.138 can drape imagery on a `Cesium3DTileset`, and that was built and
  measured before being withdrawn. It works, but it cannot look right, for two
  reasons that are not ours to change.

Why draping was rejected:
- **Resolution follows the mesh, not the camera.** `ModelPrimitiveImagery`
  picks a level per model primitive from that primitive's own bounding
  rectangle, targeting one imagery tile per primitive
  (`desiredNumberOfTilesCovered = 1`, a hard-coded local with no setting).
  Measured at a fixed camera, refining only the tileset's detail from
  `maximumScreenSpaceError` 64 to 4 changed which weather levels were fetched.
  Because Google's mesh LOD and the imagery's power-of-two levels step
  independently, apparent sharpness oscillates as you descend: between about
  10,700 km and 7,800 km the imagery level did not change while the mesh
  refined, so the same tile was stretched across smaller primitives and every
  symbol grew. Descending made it worse.
- **Different primitives get different levels in the same frame** (levels 2, 3
  and 6 together, once measured), so the view is a patchwork rather than one
  consistent resolution.
- **Magnification is worst for exactly the layers worth draping.** Lightning,
  storm cells and warnings are drawn at a fixed pixel size inside the tile, so
  stretching a tile stretches the glyphs into blobs; a continuous field merely
  blurs.
- There is no lever. `minimumLevel` is the only input that could raise the
  chosen level, and it is a static floor: set high enough to help at mid
  altitude, it demands 16 to 64 imagery tiles per primitive higher up, past the
  ten-input limit at which Cesium silently truncates — from the top of the
  stack, dropping the sparse overlays and keeping the opaque field.

Workaround:
- Switch to a globe map stack (Esri Satellite, OSM, or an ion imagery stack) to
  use the Weather layer. The row says which state it is in.

---

### Weather tiles on screen can come from different moments
Status: Open (inherent to the source; mitigated by refreshing)

Context:
- Tiles are fetched only when the camera needs them. A tile already held is
  served from cache until the next refresh; a tile the camera has never asked
  for is fetched when it is first needed, and arrives current. So after a long
  gap since the last refresh, zooming or panning into new ground mixes what was
  cached then with what is being fetched now.
- It shows up most clearly between zoom levels, because each level is its own
  set of tiles: a storm visible at one level can be absent one level out, where
  the tile still holds the older frame.
- This is the cost of the layer's whole economy. Fetching every visible tile on
  every camera move would keep the globe internally consistent, and is exactly
  the spend the Weather panel exists to prevent — one exploratory session of a
  single layer is about 405 tiles against a 15,000-a-month allowance.
- The tile route does accept a time step, but only as an offset in minutes from
  now. There is no absolute stamp to pin a session to, so a single consistent
  frame cannot be requested even at a higher price.

Workaround:
- Press REFRESH. Every tile older than that moment is refetched once, which
  re-syncs what is on screen; the layer row's age is the honest reading of when
  that last happened.
- Shorten the auto-refresh interval if consistency matters more than spend.

---

### CCTV panel can appear "missing"
Status: Open (workaround available)

Context:
- The rails lay their panels out themselves. No panel is dragged into place at
  startup and no stored position is read, so a panel that looks missing is
  collapsed or its layer is off rather than parked off-screen. The CCTV panel
  starts collapsed and stays that way until you open it or a camera activates.

Workaround:
- Check that the CCTV layer is enabled in the Layers panel, then open the panel
  from its header control; it also opens on its own when a camera activates.
- To force it open on an ordinary load, store the expanded state and reload. In
  the browser console:
  - `localStorage.setItem('godsEyeView.v6.panelCollapsed.cctv-panel', '0');`
  - `location.reload();`
- Removing that key instead returns the panel to its default, which is collapsed:
  - `localStorage.removeItem('godsEyeView.v6.panelCollapsed.cctv-panel');`
  - `location.reload();`
- Neither console line changes anything when the page was opened from a share
  link: a shared view is laid out from the link, not from what this browser has
  stored, so open the panel from its header control instead.

Related keys (current versions):
- Panel collapsed state: `godsEyeView.v6.panelCollapsed.<panel-id>` — `'0'` open,
  `'1'` closed, absent means the panel's own default. A view opened from a share
  link ignores the stored value entirely.
- Panel positions: `godsEyeView.v8.panelPos.<panel-id>` — the versioned name for a
  stored position. The current layout writes none, so deleting one changes
  nothing.
- CCTV calibration: `godsEyeView.cctv.calibration.v2`

---

### Height-datum residuals (branch `feat/height-datum`, pending merge)
Status: Open (owner-accepted 2026-07-08, documented)

- **Cold-start floor latency:** at a freshly-visited airport, grounded/low aircraft
  float low for ~1–2 poll cycles (30–60 s) and rise as terrain floors resolve;
  a few stragglers take one more poll.
- **Born-grounded first poll:** a contact first seen on the ground with no altitude
  data renders at the geoid for ≤1 poll until its floor cell warms.
- Full context, improvement ideas, and the verification oracle
  (`scripts/qa-floor-verify.mjs`):
  `docs/superpowers/reports/2026-07-08-height-datum-handover.md`.

---

## Closed / Intentional (for clarity)

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
