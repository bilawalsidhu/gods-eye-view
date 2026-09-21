# 0012 — Screen-space annotation renders through the world-overlay lane host

Status: accepted (2026-09; drafted as ADR 2026-09-20, roadmap R4)

## Context

Several features draw in SCREEN space over the 3D scene, not in world
space: detection brackets and callouts (`src/data/detection.js`), the
callout/label/focus-ring/scanline artwork, and future HUD-ish overlays.
None of them can be Cesium entities — entities live in world space and
billboard through the globe's projection pipeline — and none of them can
own a DOM node per object: at DENSE density the detection overlay alone
tracks hundreds of moving objects at 60 fps, and per-object DOM is the
layout-thrash path that makes that impossible.

Before the shared host, the risk each feature carried was compositing
chaos: N features each with their own canvas (or worse, fighting over
one), no defined z-order, and every feature clearing "its" pixels while
stomping a neighbor's.

## Decision

One overlay canvas (`#world-overlay-canvas`) hosted by
`src/overlays/worldOverlay.js`, composed of a Z-ORDERED STACK OF PAINT
LANES. Each lane registers a `painter` callback (plus an optional
`postRender`) and owns nothing about the canvas itself; the host clears
and composites all lanes every frame the scene is in continuous render
mode (ADR 0006's governor decides when frames flow).

Rules that make the stack safe:

- **Painters draw idempotently from current state.** A lane paints what
  is true NOW; it never increments, never accumulates, never relies on
  "the frame before". Any frame may be the only frame ever painted.
- **The host owns the canvas; lanes own their pixels' intent.** Clearing
  happens once per frame at the host — no lane clears the canvas, so no
  lane can erase a neighbor.
- **Heavy math leaves the main thread.** Screen projection + horizon
  occlusion for tracked objects run in `detectionProjection.worker.js`;
  the main thread falls back to synchronous projection only when the
  worker result is not ready (first frame).
- **Placement is arbitrated, not greedy.** Label/callout placement goes
  through `src/data/labelArbiter.js` (spatial hash, incumbent
  preservation, ordered fast-path at ≥90% capacity) on a 125 ms solve
  throttle — the solve, not the paint, is the expensive part.
- **Solve results are observable.** The host publishes diagnostics
  (`solveRevision`, per-solve timings) on the canvas element's dataset,
  which is what QA suites assert against — never against private module
  state.

## Consequences

- A new screen-space feature registers a lane; it must NOT create its
  own canvas, DOM overlay, or rAF loop. Features that spin their own
  loop also bypass the render governor (ADR 0006) — both are review
  blockers.
- Painting happens only in continuous render mode: an overlay change
  while idle appears on the next rendered frame. Features that mutate
  lane state while idle must request a render (or hold one, briefly).
- Headless QA of overlay output must force frames before reading pixels
  or the lane datasets — a settled scene produces no BeginFrames and so
  no paint (see `scripts/lib/headlessFrames.mjs`).
- The single canvas is a shared bottleneck by design: a lane that wants
  full-canvas effects (the scanlines lane) pays for them on every
  continuous frame, which is exactly the cost visibility a per-feature
  canvas would hide.
