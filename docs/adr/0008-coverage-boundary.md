# 0008 — Coverage boundary: behavior tests over scene-coupled shells

Status: accepted (2026-09-20, closing the 99%-line campaign)

## Context

The coverage campaign drove line coverage from 90.55% to 91.59% and
eliminated the entire mid/long tail of under-tested modules. The
remaining uncovered mass is ~8,600 statements in 17 scene-coupled
modules (per-frame render loops, live-socket lifecycles, WebGL paint
paths: `cctv.js`, `flights.js`, `ui.js`, `gevActions.js`, ...). Pushing
THOSE past their current shape with the unit harness would require
either mocking Cesium to the point of testing the mocks, or rewriting
production modules with dependency-injection seams whose only customer
is the test.

## Decision

The unit-coverage boundary is behavior-meaningful tests up to the
render/scene shell. Specifically:

- Pure logic is extracted and tested when a real seam exists
  (policy modules, decision tables, samplers) — this is how the
  campaign's modules were closed, and how new modules must ship.
- Scene-coupled shells are covered by the Puppeteer QA battery
  (`scripts/qa-*.mjs`, real browser, real WebGL via SwiftShader) —
  that is their honest harness. Listing them in the unit report is
  measurement, not debt.
- Defensive arms that cannot be reached through any public path, and
  DEV-gated arms, are individually justified in `docs/PLAN.md` (24
  files / 122 statements at campaign close) — never bulk-excluded.

A c8 line floor (set in the `test:coverage` script flags, ratcheted
upward deliberately) prevents silent regression below the measured
baseline; the floor is below today's number so it gates collapse,
not variance.

## Consequences

- "99% coverage" is pursued as: every NEW module ships tested at its
  real seam, and the boundary table in `docs/PLAN.md` shrinks as
  integration harnesses mature — not by chasing the last percent with
  mock theater.
- A PR that lowers the number fails the floor; a PR that needs to
  lower the FLOOR says so in review, with a reason.
