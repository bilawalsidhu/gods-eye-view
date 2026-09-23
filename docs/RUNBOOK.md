# God's Eye View — Runbook

Updated: September 20, 2026

Operational commands and procedures: local development, quality gates,
deploying to production, verifying a deployment, and the failure modes that
have actually bitten.

For architecture see [CLAUDE.md](../CLAUDE.md); for the quality roadmap see
[PLAN.md](PLAN.md).

---

## Local development

```bash
npm install
cp .env.example .env          # add GOOGLE_MAPS_API_KEY at minimum
npm run dev -- --host localhost --port 4173
```

- Requires Node 24.14.x or 26.x (enforced by `package.json`).
- The dev server mounts every API middleware in `vite.config.js`; the CCTV and
  OpenZenith paths work keyless out of the box.
- `scripts/dev-fresh.sh` (macOS) pulls keys from Keychain.

## Quality gates (run before every commit)

```bash
npm run lint        # ESLint 9, --max-warnings 0 — must exit 0
npm test            # full suite, headless (~2 min); includes allocation probes
npm run test:coverage  # same battery + Node's built-in coverage table (published in CI)
npm run test:track  # tracking invariants
npm run build       # production build must succeed
```

Notes that save time:

- Run ONE test file directly: `node --test src/data/flights.test.mjs`.
  Do NOT route single files through `scripts/run-unit-tests.mjs` (it always
  runs the whole plan), and never name a test file with `[[...]]` —
  `node --test` glob-expands brackets to nothing and reports
  "tests 0 / fail 0" with exit 0.
- `GEV_REQUIRE_ALLOCATION_GATE=1 npm test` fails on runtimes whose allocation
  behavior is uncalibrated; CI sets this.
- Tests must never touch the network — mock `globalThis.fetch`.

## Deploying to production

### Pre-release checklist (run when cutting a version tag)

`package.json` rode at 0.1.0 until v0.7.0 shipped — tags and the package
version diverged for the project's whole first life. Never again:

1. **Bump `package.json` version** to match the release; `npm install` to
   refresh the lockfile entry.
2. **Changelog**: add the release section (user-visible changes, not commit
   logs) before tagging, so the tag documents itself.
3. Tag `vX.Y.Z` on the release commit; tag and `package.json` must match
   exactly.
4. Full gate battery: `npm run lint && npm test && npm run build && npm run
   check:budgets && npm run check:audit`.
5. Push `main` + the tag; then deploy (below).

Deploys are explicit and manual (Cloudflare Pages, project `globe`); there is
no auto-deploy job in CI by design.

### Release cadence policy

The rules every release follows, so the checklist above never needs
re-derivation (formalized 2026-09-20 after the v0.10.0 prep):

- **Version policy**: **minor** for a new data layer or a new production API
  surface (Pages Function route); **patch** for fixes, perf, and docs.
  Never bump major without a breaking-API discussion in PLAN.md first.
- **Changelog fold rule**: each release gets a new dated `## [x.y.z]` block
  at the top, written from user-visible changes only. Pre-fold working notes
  are demoted under a dated banner ("retained verbatim… do not treat their
  headers as shipping state"), never deleted — history stays auditable.
- **Tag names are immutable**: an existing tag name can never be reused
  (the v0.8.0 burn proved this the hard way — an interrupted release forced
  v0.8.1). Pick the next number; never re-point or re-create a name.
- **Push order**: GitForge remote first, then GitHub (mirror). GitForge CI
  is the pipeline of record (ADR 0010); a red GitHub Actions run is not a
  code signal.
- **Hold pushes while browser QA runs**: a push triggers the GitForge
  pipeline, and its container churn on the shared workspace breaks any
  concurrently running Puppeteer suite (`ERR_NETWORK_CHANGED` mid-navigation).
  Commit locally during a QA run; push only after the last suite exits.
- **Order is pinned**: build → deploy → verify (checklist below) → tag →
  publish. Publishing before verification risks burning a version number on
  an unverified artifact — the repo's immutable-releases setting makes that
  mistake permanent (see the v0.8.1 note below).

```bash
npm run build
npx wrangler pages deploy dist --project-name globe --branch main
```

`functions/` is auto-bundled by Pages at deploy time — nothing extra to ship.
Local verification of the production bundle (no `--project-name` flag):

```bash
npx wrangler pages dev dist --port 8788 --compatibility-date=2026-01-01
```

## Post-deploy verification checklist

1. **Globe renders** — Google 3D tiles load; camera controls work.
2. **Functions surface** (keyless, should answer 200):
   - `/api/openzenith/elevation?lat=30.201&lon=-97.705` → a plausible Austin
     elevation (~90–130 m for that spot; verified 99 m)
   - `/api/openzenith/reverse-geocode?lat=30.201&lon=-97.705` → a
     `place.display_name`
   - `/api/cctv/sources` → camera catalog JSON
   - `/api/celestrak/stations` → ISS TLE text
   - `POST /api/realtime/debug-log` → 204 (the historic 405 is the regression
     signal this checklist exists for)
   - Cache header is `x-gev-openzenith-cache: HIT|MISS|STALE`; the cache is
     per-isolate, so rapid repeat requests legitimately alternate HIT/MISS
     across Cloudflare isolates. HITs present ⇒ caching works.
3. **CCTV layer** — enable it; icons must render (a dead layer with a console
   `ReferenceError` from `init()` is the historical failure mode).
4. **HUD AI summary** — no `HTTP 405` errors in console.

### 2026-09-14 verification run (v0.8.1 deploy, production alias)

Ran against `https://globe-52p.pages.dev` after the radio lazy-broker fix
(`b880f87`) shipped. Results:

| Check | Result |
| --- | --- |
| `/` (app shell) | 200 |
| `/api/radio/stations` | **200 with live catalog** — the route the module-scope `randomUUID` defect had blocked deploy-wide |
| `/api/cctv/sources` | 200 (Austin cameras) |
| `/api/openzenith/reverse-geocode` | 200 (`place.display_name`) |
| `/api/terrain/heights` | 200 (first hit 502'd — cold isolate; upstream was briefly unreachable; resolved on retry) |
| `POST /api/realtime/debug-log` | 204 |
| `/api/celestrak/starlink` | **502 persistent** — CelesTrak blocks/ignores Cloudflare egress IPs (dev middleware answers 200 with the identical shared code; the variable is the datacenter IP, not the code). See KNOWN-ISSUES. |
| `/api/launches` | **429 passthrough** — Launch Library 2 anonymous throttle on shared Cloudflare egress; the handler forwards it by contract. Fix is `LL2_API_TOKEN` as a Pages secret (owner-side; no token on this machine). |
| Photoreal globe | **Renders** — verified headless: 685 `tile.googleapis.com` tile requests all 200, tileset traversal active, forced-render screenshot shows full photoreal Austin. |

Two harness findings worth keeping:

- **Headless screenshots need a forced render.** The render governor's
  `requestRenderMode` presents frames on demand; a headless session has no
  input events, so `page.screenshot()` can capture a stale frame from before
  tiles arrived (looks like a blank globe). Force it before capturing:
  `scene.requestRenderMode = false; setTimeout(() => { scene.requestRenderMode = true; }, 2000);`
  Real users are unaffected — the boot fly-in renders continuously and any
  input triggers frames.
- **The `GOOGLE_MAPS_API_KEY` sentinel path is real and correct.** This
  machine's `.env` carries the scaffolded placeholder
  (`your_google_maps_api_key_here`, exactly 29 chars), and main.js correctly
  treats it as absent. The photoreal tiles still work because the real
  `CESIUM_ION_TOKEN` authorizes Cesium ion asset 2275209 (Google 3D Tiles via
  ion) — the Google key itself only gates geocoder/Places features. A
  keyless-build deploy is therefore not automatically a blank globe.

Order matters: **deploy, verify, THEN tag and publish the release.** v0.8.1's
release was published before the render verification ran; the verification
happened to clear it, but the repo's immutable-releases setting makes a
published tag un-repointable — a verification failure after publishing would
have forced a v0.8.2.

### 2026-09-15 bundle refresh (no release)

Re-deployed from `main` at 654ada6 so the deployed artifact matches the
branch head exactly (the four commits since v0.8.1 were docs, CI config,
and dev-only dependency bumps — no shipped-code changes, hence no version
bump or tag). Verified: production alias serves the new bundle
(`assets/index-C0r3aEys.js` matches the local build), shell/radio/cctv/
reverse-geocode 200, debug-log 204; celestrak 502 and launches 429 persist
as documented above. First GitForge-CI-green commit to ship.

### 2026-09-22 verification run (v0.10.0 deploy, production alias)

Deployed from `main` at `b3c8c97` (the release commit) with
`npx wrangler pages deploy dist --project-name globe --branch main`;
GitForge pipeline on that commit was green before the deploy. The whole
checklist is now scripted: `node scripts/verify-prod-render.mjs` boots the
production alias headless, skips the first-run modal
(`gev:first-run-mission-session:v1` written before page scripts run), sets the
camera over KAUS (derived from live instances — the bundle does not expose
`window.Cesium`), forces a rendered frame past the governor, and probes the
Functions surface same-origin.

| Check | Result |
| --- | --- |
| `/` (app shell) | 200 |
| `/api/openzenith/elevation` | 200 — Austin elevation **99 m**, the RUNBOOK's expected value |
| `/api/openzenith/reverse-geocode` | 200 (`place.display_name`) |
| `/api/cctv/sources` | 200 |
| `POST /api/realtime/debug-log` | 204 |
| `/api/radio/stations` | 200 |
| `/api/regional-brief?latitude=…&longitude=…` | **200 with real place + weather** — the new 0.10.0 production API works (GET with `latitude`/`longitude`; a POST probe correctly 405s, a `lat`/`lon` probe correctly 400s) |
| `/api/celestrak/stations` | 502 — the documented CF-egress block, unchanged |
| Photoreal globe | **Renders** — headless screenshot over KAUS shows the Colorado River, MetCenter ponds, and airport runways; 219/221 `googleapis.com` tile requests 200 (2 status-0 entries are resource-timing noise) |

Note for the next run: assert the tile stream with a threshold, not strict
equality — a CDN stream legitimately mixes 304 revalidations into an otherwise
healthy frame.

### 2026-09-23 verification run (v0.10.1 deploy, production alias)

Deployed from `main` at `3e8eb82` (the release commit) with
`npx wrangler pages deploy dist --project-name globe --branch main`; local
gate battery green before the deploy (lint zero-warnings, unit suite
3,988 + 14 allocation-gated tests, build, bundle budgets, dependency
audit). This is the first release whose GitForge pipeline evidence is
partial for an infra reason — see the trigger note below.

| Check | Result |
| --- | --- |
| `/api/openzenith/elevation` | 200 — **99 m**, expected value; `x-gev-openzenith-cache: MISS` header present |
| `/api/openzenith/reverse-geocode` | 200 (real Austin `place.display_name`) |
| `/api/cctv/sources` | 200 (Austin camera inventory) |
| `POST /api/realtime/debug-log` | 204 |
| `POST /api/openai/hud-summary` | 200 (keyless honest degrade — no 405) |
| `/api/celestrak/stations` | 502 — the documented CF-egress block, honest error body |
| `scripts/verify-prod-render.mjs` | **PASS, 8/8** — boots, canvas fills 1600×900 (no 300×150 regression), camera 2500 m over target, tiles loaded, photoreal stream 146/148 → 200, CCTV 200, debug-log 204, regional-brief 200, no console errors |

**GitForge trigger defect (2026-09-23, unfixed — owned by the GitForge
session):** pushes to `mkinney/gods-eye-view` after 18:15 UTC write
`ci.trigger.delivered` events (verified in the `events` table for
`3e8eb82` and `7020b22`) but create NO pipeline row and NO run row; other
repositories' triggers kept creating runs in the same window, so the
drop is repo-specific, not a gateway/CI outage. The 18:15 push created
pipeline `61a013cb` (active) + run `aa166a44` normally. Consequence: the
lint + unit jobs DID succeed in-run on `d8b51755` before its build job
hit the 1800 s timeout under fleet load, and the release commit's full
battery ran green locally; re-verify on GitForge once the trigger path
is repaired (any push re-tests it).

## Credentials & environment

All keys are optional except `GOOGLE_MAPS_API_KEY`. See `.env.example` for the
full list and [DATA_SERVICES_CATALOG.md](DATA_SERVICES_CATALOG.md) for what
each unlocks. Never commit `.env` or key material. Server-side keys for Pages
Functions are set as Cloudflare Pages environment variables (dashboard →
Settings → Environment variables), not in the repo.

## Known operational gotchas

Headless Chrome in a hardened container: `puppeteer.launch()` may start but
every real navigation hangs (even against a static file server) when the
host's seccomp/apparmor rules break Chrome's render/network processes —
`about:blank` works, `http://127.0.0.1:8901/x.html` never commits. If QA
scripts stall in `page.goto`, run them on a workstation, not the container.

| Symptom | Cause | Fix |
| --- | --- | --- |
| `git push` fails "Could not resolve host" | transient DNS | wait a few seconds, retry |
| Vite dev server won't die; `pkill -f vite` kills your own shell | `pkill -f` matches its own command line | kill by recorded PID (`echo $! > /tmp/dev.pid`) |
| Pages Function returns `{"error":"not found"}` in dev only | Connect strips the mount prefix from `req.url` | the dev bridge must re-prepend `/api/<mount>` when building the `Request` |
| Worker-runtime `Buffer is not defined` | workerd has no node primitives | shared modules use `Uint8Array`/web APIs only — see `functions/_lib.js` |
| Tests pass but a `[[path]].test.mjs` never ran | bracketed names are glob-skipped by `node --test` | use plain filenames (e.g. `cctv.test.mjs`) |
| Cached negative looks wrong after a fix upstream | localStorage caches negatives by design (adsbdb 30 d, OpenZenith places 30 d) | clear the site's storage, or bump the cache key format |
