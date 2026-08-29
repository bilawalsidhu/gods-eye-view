# God's Eye View — Runbook

Updated: August 29, 2026

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

Deploys are explicit and manual (Cloudflare Pages, project `globe`); there is
no auto-deploy job in CI by design.

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
   - `/api/openzenith/elevation?lat=30.201&lon=-97.705` → `elevation` ≈ 114 m
     for Austin (`x-oz-cache: HIT` on the second request)
   - `/api/openzenith/reverse-geocode?lat=30.201&lon=-97.705` → a
     `place.display_name`
   - `/api/cctv/sources` → camera catalog JSON
   - `/api/celestrak/stations` → ISS TLE text
   - `POST /api/realtime/debug-log` → 200 (the historic 405 is the regression
     signal this checklist exists for)
3. **CCTV layer** — enable it; icons must render (a dead layer with a console
   `ReferenceError` from `init()` is the historical failure mode).
4. **HUD AI summary** — no `HTTP 405` errors in console.

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
