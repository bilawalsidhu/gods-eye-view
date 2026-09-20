# 0006 — Render governor owns the render loop

Status: accepted (shipped 2026-09; low-demand tier 2026-09-15)

## Context

A photoreal 3D globe with 17 live data layers can burn a GPU at 60 fps
forever. Cesium's `requestRenderMode` stops the loop when nobody needs
it — but "nobody needs it" is a property of the whole app, and every
feature that animates (style transitions, detection overlay, camera
verbs, scope mask) had a reason to keep rendering.

## Decision

Binary ref-counted render mode, single owner: `src/renderGovernor.js`
exposes `holdContinuousRender(name)` / `releaseContinuousRender(name)`;
the governor keeps `requestRenderMode` OFF while any hold exists and ON
(pausable loop) when the count is zero. Every consumer registers a NAMED
hold — `getRenderGovernorDiagnostics().holds` must always explain why the
loop is running.

On top of the binary mode, a low-demand tier drops
`viewer.targetFrameRate` to 30 while `style-anim` is the SOLE continuous
holder and the camera is settled; any second hold, camera motion, or full
idle restores 60 immediately (pure decision table `resolveGovernorTargetFrameRate`,
unit-pinned).

## Consequences

- Holding continuous render without releasing is a render leak: name
  every hold, release in the same lifecycle that acquired it, and check
  `getRenderGovernorDiagnostics()` when a QA suite shows unexpected GPU
  load.
- Idle boot is never "idle" under the retro default (ADR 0005) — the
  style-anim hold is legitimate; harnesses asserting idle must switch to
  `normal` first.
- Features must not spin their own `requestAnimationFrame` loops to
  escape the governor; that reintroduces exactly the cost the governor
  exists to bound.
