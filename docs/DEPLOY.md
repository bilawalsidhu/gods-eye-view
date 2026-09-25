# Hosted deployment

Upstream God's Eye View is local-first: it binds to `localhost` and the app's
own [SECURITY.md](../SECURITY.md) calls it "not a hardened production service."
This document covers what changes when you host it anyway, and the files in this
repository that make that possible.

## What the runtime actually is

**`vite preview`, not a static file server.** The globe is a static bundle, but
every live layer — aircraft, ships, satellites, CCTV, traffic, weather, radio,
transit, voice — is served by middleware in `server/providers/`, and each of
those providers registers `configurePreviewServer` alongside `configureServer`.
So `dist/` served by a CDN would load the globe on keyless Esri/OSM imagery and
404 every `/api/*` route.

Two consequences:

- **Vite is a runtime dependency**, so `devDependencies` stay installed in the
  image and `NODE_ENV=production` is only set in the final stage.
- **Serverless does not fit.** The AISStream vessel feed holds a persistent
  WebSocket in the server process, and most providers keep warm in-memory or
  on-disk caches. This wants one long-lived container.

The in-app key-setup writer (`POST /api/setup/keys`, the "POWER UP" panel) is
registered `apply: 'serve'` — dev only. It is absent from a preview server, and
that absence is what makes hosting one safe at all: a visitor cannot write the
host's `.env` or probe which keys exist. `GET /api/setup/status` returns 404
here, and the client removes the whole surface.

## Files

| File | Purpose |
|------|---------|
| `Dockerfile` | Two-stage build; drops Puppeteer/`sharp` (QA-only) from the runtime image |
| `deploy/access-gate.js` | HTTP basic auth over everything, plus an unauthenticated `/healthz` |
| `deploy/vite.config.deploy.js` | The standalone config plus the gate, a platform port, and `allowedHosts` |
| `fly.toml` | Fly.io service definition |
| `render.yaml` | Render Blueprint |
| `npm start` | `vite preview --config deploy/vite.config.deploy.js` |

## The access gate is not optional

This server brokers your API keys. Anyone who can load the page can drive the
proxies and spend your OpenAI, Google, AISStream, TomTom and FIRMS quota for as
long as it runs — the same warning upstream gives for `HOST=0.0.0.0` on a LAN,
except the network is now the internet.

`deploy/access-gate.js` requires `GEV_BASIC_AUTH_USER` and
`GEV_BASIC_AUTH_PASS`. Both set gates the deployment; **neither** set serves it
open with a startup warning; **only one** set refuses to boot, because the
failure mode of guessing is a publicly spendable key broker. `/healthz` answers
ahead of the gate so platform health checks do not need the credentials.

Basic auth over HTTPS is a doorway, not a security model. If the deployment
matters, put Cloudflare Access or an identity-aware proxy in front of it and
keep the gate as defence in depth.

## Deploy: Fly.io

```bash
# 1. Install and authenticate (interactive — run this yourself)
#    Windows: winget install --id Fly.Flyctl
fly auth login

# 2. Claim a unique app name; keeps the committed fly.toml
fly launch --no-deploy --copy-config --name <your-app-name>

# 3. Credentials. Secrets are encrypted and never land in the repo.
fly secrets set \
  GEV_BASIC_AUTH_USER=<pick-one> \
  GEV_BASIC_AUTH_PASS=<a-long-random-string>

# 4. Optional providers — add only what you have
fly secrets set OPENAI_API_KEY=... AISSTREAM_API_KEY=... \
  GOOGLE_MAPS_API_KEY=... CESIUM_ION_TOKEN=... \
  OPENSKY_CLIENT_ID=... OPENSKY_CLIENT_SECRET=... \
  TOMTOM_API_KEY=... FIRMS_MAP_KEY=...

# 5. Ship. --remote-only builds on Fly's builders, so no local Docker daemon.
fly deploy --remote-only
```

`fly.toml` sets `auto_stop_machines = "stop"` with `min_machines_running = 0`,
so an idle private deployment costs almost nothing. A cold wake takes a few
seconds and starts the AISStream vessel cache from empty.

## Deploy: Render

Push this branch, then Render dashboard → **New → Blueprint** → select this
repository. `render.yaml` declares the service; every credential is marked
`sync: false`, so Render prompts for it and nothing sensitive is committed.

The free plan is a poor fit: its build container has run out of memory on
Cesium-sized bundles, and a free service sleeps after 15 minutes of inactivity.
`starter` is the smallest plan this app is comfortable on.

## Deploy: Hugging Face Spaces (free, no card)

A Docker Space is the only one of these three that needs no payment details, and
it is the roomiest: 2 vCPU and 16 GB RAM on the free tier, against Render free's
512 MB. A **private** Space is reachable only by you, so the Space itself is the
access control and the basic-auth gate becomes defence in depth.

This is what the `deploy/hf-space` branch is for: it is `deploy/hosted` plus the
front-matter Spaces requires in the root `README.md`. `app_port` there matches
the Dockerfile's `PORT`, and the image already runs as uid 1000, which is the uid
Spaces expects — so no image change is needed.

```bash
# 1. In the browser: huggingface.co -> New Space
#      SDK: Docker -> Blank, Visibility: Private
#    Then Settings -> Variables and secrets, add as SECRETS:
#      GEV_BASIC_AUTH_USER, GEV_BASIC_AUTH_PASS  (both, or it refuses to boot)
#    plus any provider keys you have.

# 2. In the browser: huggingface.co/settings/tokens -> create a WRITE token.

# 3. Push this branch as the Space's main branch.
git remote add space https://huggingface.co/spaces/<user>/<space-name>
git push space deploy/hf-space:main
```

Spaces builds the Dockerfile on push and streams the log in the Space's
**Logs** tab. A free Space sleeps after a period of inactivity and its storage is
ephemeral, so the provider disk caches rebuild on wake — nothing here needs a
volume.

To update it later, keep this branch a rebase of `deploy/hosted` rather than a
place to make changes:

```bash
git checkout deploy/hf-space && git rebase deploy/hosted
git push space deploy/hf-space:main --force-with-lease
```

## Environment

| Variable | Needed for |
|----------|-----------|
| `GEV_BASIC_AUTH_USER` / `GEV_BASIC_AUTH_PASS` | The access gate. Set both. |
| `HOST` / `PORT` | `0.0.0.0` and the platform's port. Already set in both configs. |
| `GEV_ALLOWED_HOSTS` | Optional comma-separated hostname allowlist. Default: any (the platform's domain is not knowable in advance). |
| `GOOGLE_MAPS_API_KEY` | Google Photorealistic 3D Tiles + place search. **Reaches the browser.** |
| `CESIUM_ION_TOKEN` | ion-hosted Google 3D, Bing imagery, world terrain. **Reaches the browser.** |
| `OPENAI_API_KEY` | Voice control. Server-side; the browser gets an ephemeral token. |
| `AISSTREAM_API_KEY` | Live vessels. Server-side WebSocket. |
| `OPENSKY_CLIENT_ID` / `_SECRET` | Higher aircraft rate limits. Unset still works (`OPENSKY_AUTH_MODE=anon`). |
| `TOMTOM_API_KEY` | Live traffic. Unset falls back to the built-in simulation. |
| `FIRMS_MAP_KEY` | NASA active fires. Unset leaves the layer empty. |
| `GEV_RATELIMIT_OPENAI_PER_MIN` / `GEV_RATELIMIT_GOOGLE_PER_MIN` | Per-IP throttles on the endpoints that cost money. Set in both configs. |

With no credentials at all the app still runs: keyless Esri World Imagery, OSM
in the map tray, anonymous OpenSky aircraft, and the keyless layers.

## Restrict the two browser-exposed keys

`GOOGLE_MAPS_API_KEY` and `CESIUM_ION_TOKEN` are injected into the client bundle
by design and **will** be visible in devtools. Before a hosted deploy:

- **Google Cloud Console** → restrict the key by *HTTP referrer* to your
  deployment's domain, and by API to only Map Tiles + Geocoding. Consider a
  separate `GOOGLE_MAPS_SERVER_API_KEY`, IP-restricted to Places + Street View
  Static, so the browser key stays narrow.
- **Cesium ion** → use a public `assets:read` token with URL restrictions.

## Spend protection

The `GEV_RATELIMIT_*` variables are per-IP, process-local, in-memory guards that
reset on restart. **They are not billing caps.** Set the real backstop where the
money is: OpenAI platform usage limits, Google Cloud budget alerts plus per-API
quotas, and the equivalent for any other keyed provider.

## Operational notes

- **Provider disk caches** (Overpass, military installations) live inside the
  container filesystem and are lost on redeploy or a machine stop. They rebuild
  on demand; nothing needs a volume.
- **Node version** is pinned by `engines` to `>=24.14.0 <25 || >=26 <27`. The
  image uses `node:24-bookworm-slim`.
- **Image size** is driven by Cesium and the bundled GeoJSON. The build stage
  removes Puppeteer and `sharp`, which are only used by `scripts/qa-*.mjs`.
- **Upstream terms still apply.** Bundled and live datasets carry their own
  licences — see [DATA_SOURCES.md](../DATA_SOURCES.md). Google 3D Tiles through
  a Cesium ion Community account is for eligible personal/non-commercial use;
  a hosted deployment may need the direct Google route.
