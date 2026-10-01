# CLAUDE.md

Guide for Claude Code sessions in this fork of
[bilawalsidhu/gods-eye-view](https://github.com/bilawalsidhu/gods-eye-view).
Upstream is MIT, very active (near-daily releases) and strict about module
boundaries. This fork adds track history, alerts, replay, camera coverage
and a hosted profile. Feature docs: `docs/TRACKING.md`, `docs/HOSTED.md`.

## Commands

Node 24.14+ (or 26). Not 22, not 25.

```bash
npm ci
npm run dev                 # http://localhost:4173, local profile, SQLite in .gev-data/
npm test                    # full unit suite (~5,400 tests, ~90 s)
node --test src/gev/*.test.mjs   # just this fork's tests (fast)
npm run check:boundaries    # import-direction and package-ownership gates
npm run format              # prettier on owned files; run before committing
npm run build && GEV_AUTH_MODE=tokens GEV_SESSION_SECRET=... GEV_ACCESS_TOKENS=me:<24+chars> GEV_COOKIE_SECURE=0 npm run start:hosted
```

Every change must leave `npm test`, `npm run check:boundaries` and
`npm run format:check` green.

## Where this fork's code lives

| Path | Role |
| --- | --- |
| `server/providers/common/observations.js` | Bus the OpenSky, adsb.lol and AIS providers publish to (one-line hooks in those files) |
| `server/providers/common/cameraHooks.js` | Catalog getter and health samples from the CCTV proxy (hooks in `server/providers/cctv.js`) |
| `server/providers/store/` | One SQL surface for SQLite (`node:sqlite`) and Postgres (`pg`, tested with PGlite) |
| `server/providers/history/` | Thinning, recorder, retention, `/api/history/*` |
| `server/providers/alerts/` | Per-user rule engines, SSE, webhooks, satellite passes, `/api/watch/*` |
| `server/providers/cameras/` | Coverage grid and uptime, `/api/cameras/*` |
| `server/hosted/`, `server/production.js` | Hosted server: auth, quotas, static, connect-style middleware |
| `src/sources/alertRules.js`, `src/sources/cameraCoverage.js` | Portable pure logic shared by server and browser |
| `src/gev/console/` | Ops console UI, mounted from `src/main.js` after the app starts |
| `src/gev/*.test.mjs` | Tests for all of the above (the runner only discovers tests under `src/`) |

## Rules to keep

- Touch upstream files only at seams (provider hooks, `server/providers/local.js`,
  `src/main.js`, `scripts/package-boundaries.json`). Put new work in new
  folders so upstream merges stay easy.
- A new module reachable from a declared package export must be listed in
  `scripts/package-boundaries.json`, or `check:boundaries` fails.
- No Cesium text labels; world text goes through the world-overlay host.
- Errors returned to clients are fixed codes, never upstream error text.
- User-supplied URLs are never fetched except webhook hosts on the allowlist
  (`server/providers/alerts/channels.js`).
- Scope is objects and infrastructure: no face recognition, plate reading,
  person re-identification, stored camera frames, or unmasking aircraft the
  feeds hide. Camera features stay geometric (`docs/TRACKING.md`).

## Syncing with upstream

```bash
git remote add upstream https://github.com/bilawalsidhu/gods-eye-view.git   # once
git fetch upstream && git rebase upstream/main
npm ci && npm test && npm run check:boundaries
```
