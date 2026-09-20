# 0004 — Cesium packages are pinned via overrides

Status: accepted (2026-09-10)

## Context

CesiumJS ships as `cesium` plus the split `@cesium/engine` /
`@cesium/widgets` packages, and their version matrices are not
lockstep-compatible: `cesium` 1.144.0 is incompatible with
`@cesium/engine` 26.3.0 (breaking widget/engine API changes land
mid-major). A floating range let a routine `npm install` resolve a
combination that did not boot.

## Decision

`package.json` pins the exact versions and forces them through
`overrides`:

- `@cesium/engine` — `26.2.0`
- `@cesium/widgets` — `16.1.1`
- `cesium` — `1.144.0` (build asset source; `scripts/copy-cesium-assets.mjs`
  copies `Build/` into `public/cesium/` for the OSM-fallback path)

Bump all three together, deliberately, with the boot QA suite run
afterwards — never let the solver pick.

## Consequences

- Renovate-style bulk bumps will show the override; that is the point.
- A future engine bump that breaks widgets is caught in the PR that
  tries it, not on a deployed globe.
