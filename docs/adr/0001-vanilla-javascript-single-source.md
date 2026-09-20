# 0001 — Vanilla JavaScript is single-source (no TypeScript ports)

Status: accepted (2026-08-29, reaffirmed 2026-09-10)

## Context

The repo's pre-merge main line carried a TypeScript scaffold and `.ts`
ports of several data-layer modules. During the period both lines lived,
the TS ports silently missed real bug fixes that landed in the `.js`
modules — two sources of truth for one behavior, and the slower one kept
winning by accident.

## Decision

Vanilla JavaScript (ESM + JSDoc types) is the single source. No `.ts`
module ports; no parallel typed shims. Types are expressed with JSDoc and
validated by the `eslint-plugin-jsdoc` gate (types resolve, param names
match signatures — enforced in `eslint.config.js` over `src/**/*.js`).

## Consequences

- One implementation per behavior; drift is structurally impossible.
- Editor type support still works: `import('cesium')` JSDoc forms resolve
  from the cesium package itself (no `tsconfig.json`, no `tsc` anywhere —
  the former `types/*.d.ts` belonged to the deleted React experiment and
  left in the 2026-09-16 cleanup).
- New modules are `.js` + JSDoc by default; a PR introducing `.ts` source
  under `src/` should be rejected with a pointer here. (Pages Function
  handlers are likewise `.js` — `src/config/apiEndpoints.test.mjs` fails
  the suite if a `.ts` handler appears.)
