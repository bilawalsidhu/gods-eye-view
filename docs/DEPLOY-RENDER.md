# Deploying on Render

`render.yaml` is a Render Blueprint for this repository. It deploys one web
service: `vite build` produces the bundle and `vite preview` serves it together
with the same API provider middleware the dev server runs.

## Why `vite preview` is the server

Each provider in `server/providers/` declares both `configureServer` and
`configurePreviewServer`, so the built bundle gets the identical API surface as
`npm run dev` — `/api/opensky`, `/api/cctv/*`, `/api/realtime/token` and the
rest. `src/tooling/previewServing.test.mjs` exercises both paths against real
servers.

One provider deliberately does not attach: the in-app credential editor
(`/api/setup/*`), which refuses outside development. A public deployment
therefore cannot be talked into writing keys to disk — set them as environment
variables instead.

`server/standalone/render.config.js` adds only what a managed host dictates:
the assigned port, the hostname it routes on, security headers, and a long
cache for content-hashed assets.

## Deploy it

1. Push this repository to GitHub.
2. Render → **New** → **Blueprint** → pick the repository.
3. Render reads `render.yaml` and prompts for every value marked
   `sync: false`. Fill in what you have — **`OPENAI_API_KEY`** switches on
   voice control and the console's scene analyst. Leave the rest blank and the
   app starts with keyless fallbacks: Esri World Imagery, anonymous OpenSky,
   simulated traffic.
4. First build takes a few minutes (Cesium is large). After that the service
   answers on `https://<name>.onrender.com`.

Adding or changing a key later: Render dashboard → the service →
**Environment** → edit → the service restarts with it.

## Choices worth knowing

**Plan.** `starter` keeps the service always-on. `free` costs nothing but
sleeps after inactivity, so the first load pays a cold start. The build peaks
around 600 MB of memory — if it is killed, move to `standard`.

**`npm ci --include=dev`.** Render builds with `NODE_ENV=production`, and both
the build (`vite`) and the server (`vite preview`) live in `devDependencies`.
Without the flag the build fails on a missing `vite`.

**`PUPPETEER_SKIP_DOWNLOAD=1`.** Puppeteer is a devDependency used only by the
QA scripts; the flag skips a ~200 MB Chromium download on every build.

**Custom domains.** Vite refuses a request whose `Host` header is not
allow-listed, which is what stops DNS rebinding from reaching the
key-brokering proxies. Render's own hostname is allowed automatically through
`RENDER_EXTERNAL_HOSTNAME`; add custom domains to `GEV_ALLOWED_HOSTS`
(comma separated).

## Read this before you share the URL

A deployed instance is **public**, and its proxies spend *your* provider quota
for anyone who loads the page. `render.yaml` therefore sets
`GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` rather than
leaving them unlimited. They are per-IP, per-process guards that reset on
restart — **not** billing caps. Set provider-side budgets too:

- OpenAI → Settings → Limits (usage limits)
- Google Cloud → Billing → Budgets & alerts, plus per-API quotas

Two keys are compiled into the browser bundle by design because they are used
client-side, and will be visible in devtools:

- `GOOGLE_MAPS_API_KEY` — restrict by HTTP referrer to the service domain
- `CESIUM_ION_TOKEN` — use a public `assets:read` token with URL restrictions

Everything else (`OPENAI_API_KEY`, `GOOGLE_MAPS_SERVER_API_KEY`,
`AISSTREAM_API_KEY`, `FIRMS_MAP_KEY`, OpenSky credentials) stays server-side.
See `SECURITY.md`.

## Other hosts

Nothing in the config is Render-specific beyond two environment variable names.
Any platform that sets `PORT` and runs Node 24 works:

```sh
npm ci --include=dev
npm run build
PORT=8080 HOST=0.0.0.0 GEV_ALLOWED_HOSTS=your.domain npm run start
```
