# Architecture Decision Records

Short-lived context does not survive in code review threads or chat logs.
These records capture the decisions that are expensive to reverse or that
keep being re-litigated, so a contributor (or a future session) reads WHY
before proposing to change it.

Format: one numbered file per decision, `NNNN-kebab-title.md`, status
header, context, decision, consequences. Superseded records stay (their
status line points at the replacement) — history is the record.

There is deliberately no `docs/ARCHITECTURE.md` duplicating this repo's
structure: the checked-in `CLAUDE.md` IS the architecture document (module
map, layer inventory, performance architecture, dev/prod parity contract)
and is verified against the tree every session. A second copy would only
drift.

## Index

- [0001 — Vanilla JavaScript is single-source (no TypeScript ports)](0001-vanilla-javascript-single-source.md)
- [0002 — Cloudflare Pages Functions are canonical (no Workers subproject)](0002-pages-functions-canonical.md)
- [0003 — Dev/prod parity is enforced, not aspirational](0003-dev-prod-parity-enforced.md)
- [0004 — Cesium packages are pinned via overrides](0004-cesium-pins.md)
- [0005 — Retro/CRT is the first-run style](0005-retro-first-run.md)
- [0006 — Render governor owns the render loop](0006-render-governor.md)
- [0007 — CSP is enforced with a maintenance contract](0007-csp-enforced.md)
- [0008 — Coverage boundary: behavior tests over scene-coupled shells](0008-coverage-boundary.md)
- [0009 — Keyless endpoints answer 200 with `unavailable: true`](0009-keyless-contract.md)
- [0010 — GitForge is the primary CI platform](0010-gitforge-primary-ci.md)
- [0011 — Prettier is declined; ESLint owns format](0011-prettier-declined.md)
- [0012 — Screen-space annotation renders through the world-overlay lane host](0012-world-overlay-lane-architecture.md)
- [0013 — AIS vessels stay dev-only until a DO relay is justified](0013-ais-production-relay.md)
- [0014 — Key signup is operator configuration, not code](0014-key-signup-pass.md)
- [0015 — Rate limits are per-isolate burst protection, not accounting](0015-per-isolate-rate-limiting.md)
