# 0005 — Retro/CRT is the first-run style

Status: accepted (operator ruling, 2026-08-29)

## Context

The style system ships five looks (normal, retro/CRT, and the operator
themes). The default was reconsidered when the CRT shader's animated
`time` uniform was found to hold continuous rendering from boot forever —
which looks, to a perf audit, like a render leak.

## Decision

First-run default is `retro` (`setStyle('retro', { applyPreset: true })`
at boot). The continuous-render hold is the aesthetic working as
designed, NOT a leak: the governor reports `holds: ["style-anim"]`
indefinitely on a default boot.

## Consequences

- Perf harnesses must first `setStyle('normal')` before measuring idle
  baselines — qa-perf does exactly that; new perf tooling must too.
- The idle cost of the default boot is bounded by design, not by
  accident: the governor drops `targetFrameRate` to 30 while `style-anim`
  is the SOLE holder and the camera is settled, and the style loop
  advances uniforms at 30 Hz (wall-clock `time` uniform — animation speed
  unchanged). Both behaviors are unit-pinned
  (`resolveGovernorTargetFrameRate`, `src/ui/styleAnimationCadence.js`).
- Changing the default style is an operator decision, not a cleanup.
