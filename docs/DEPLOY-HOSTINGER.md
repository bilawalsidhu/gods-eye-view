# Deploying GEV to Hostinger (Business plan, Node.js web app)

This guide deploys **this personal fork** (`joefel1661/gods-eye-view`) as a
password-protected Node.js web app on Hostinger, on Hostinger's free temporary
domain.

> **SaugOps separation, read this first.** The same Hostinger account hosts, or
> used to host, SaugOps. Create a **new, separate website/app** for GEV. Do
> **not** open, edit, redeploy, or reuse any existing SaugOps website, its
> environment variables, its domain or its GitHub connection settings. Use
> **GEV-only** environment variables, and preferably **separate API keys**
> (separate Google Cloud project/key, Cesium token, OpenAI key) so quota,
> billing and key rotation in one app can never affect the other.

## 1. What runs on Hostinger

| Item             | Value                                                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Plan             | Business Web Hosting (Node.js web apps are included)                                                                      |
| Node.js version  | **24** (`package.json` requires `>=24.14.0 <25 \|\| >=26 <27`)                                                            |
| Framework preset | **Other** (or Express) — not "Vite": a static Vite deploy would skip the server, the password gate and every `/api` route |
| Root directory   | `/`                                                                                                                       |
| Build script     | `build` (runs `vite build` → `dist/`)                                                                                     |
| Output directory | leave empty (ignored when an entry file is set)                                                                           |
| Entry file       | `server.js`                                                                                                               |
| Package manager  | npm (from `package-lock.json`)                                                                                            |

`server.js` serves the built app plus the same `/api/*` provider routes the
local dev server has, binds `0.0.0.0` and the `PORT` Hostinger provides, and
puts a password gate in front of **everything** (pages, JS bundles, `/api`).
If `GEV_ACCESS_PASSWORD` or `GEV_SESSION_SECRET` is missing or weak it fails
closed: every request answers `503` and nothing is served.

Hostinger facts this relies on (official docs, checked 2026-10-12):

- Supported runtimes are Node.js 18, 20, 22 (default) and **24**:
  [Creating a Node.js App](https://docs.hostinger.com/node.js/creating-an-app),
  [Build Settings](https://docs.hostinger.com/node.js/build-settings),
  [Node.js Hosting Overview](https://docs.hostinger.com/node.js/overview).
- Business Web Hosting supports Node.js apps in hPanel; deploy from GitHub via
  the Hostinger GitHub App; each push to the branch redeploys (install → build
  → start): [GitHub](https://docs.hostinger.com/node.js/github).
- Environment variables are set in hPanel, are injected into **both the build
  and the running app**, and are stored encrypted:
  [Environment Variables](https://docs.hostinger.com/node.js/environment-variables).
- Apps listen on `0.0.0.0` and `process.env.PORT`:
  [Fastify on Hostinger](https://docs.hostinger.com/node.js/overview-1/fastify).
- Idle apps are stopped and restarted on the next request (expect a slower
  first load after idle): [Overview](https://docs.hostinger.com/node.js/overview).
- Not confirmed by the docs: which exact 24.x minor Hostinger ships. The
  `engines` range needs ≥ 24.14.0; if the build log shows an older 24.x and
  fails on `engines`, report it — do not pick Node 22 (the app needs 24).

## 2. Step by step

1. **GitHub:** merge the deployment PR into `main` of the personal fork (or pick
   the branch you want Hostinger to track).
2. **hPanel → Websites → Add Website → Node.js web app** (a _new_ website — do
   not choose any existing SaugOps site).
3. Choose **Import Git repository → Connect with GitHub**. In the GitHub popup,
   install/authorize the Hostinger GitHub App with **"Only select
   repositories" → `joefel1661/gods-eye-view`**. If the app is already
   installed for SaugOps, _add_ this repo to its access list — do not remove
   `Saugops`. (Only one GitHub account can be connected at a time.)
4. Select `joefel1661/gods-eye-view`, branch `main`.
5. Set the build settings from the table in §1 (Framework **Other**, Node
   **24**, build `build`, entry `server.js`).
6. Under **Set environment variables**, add the variables in §3. At minimum:
   `GEV_ACCESS_PASSWORD`, `GEV_SESSION_SECRET`, `GEV_ALLOWED_HOSTS`.
   **Do not set `NODE_ENV=production`**: the build and `server.js` need Vite
   from `devDependencies`, which `npm install` skips under that setting.
7. Choose the **free temporary domain** and click **Deploy**. Watch
   **Deployments → build log**.
8. Copy the temporary hostname (for example `something.hostingersite.com`),
   set `GEV_ALLOWED_HOSTS` to exactly that hostname, and **Save and
   redeploy**. Requests for any other `Host` get `403 Blocked request`.
9. Restrict the browser-exposed keys to that hostname (see §4), then run the
   checklist in §6.

## 3. Environment variables (set in hPanel, never in git)

`.env` and `.env.*` are git-ignored; `.env.example` holds names only.

### Required for the hosted server

| Name                  | What                                                                            | How to get it                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `GEV_ACCESS_PASSWORD` | Login password (12+ chars)                                                      | Pick a long passphrase; store it in your password manager                                                     |
| `GEV_SESSION_SECRET`  | HMAC key for the 30-day session cookie (32+ chars, different from the password) | `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` or `openssl rand -base64 48` |
| `GEV_ALLOWED_HOSTS`   | The public hostname(s), comma-separated, no wildcards                           | The Hostinger temporary domain                                                                                |

Optional: `GEV_TRUST_PROXY=0` only if the app is **not** behind Hostinger's
reverse proxy (it is, so leave unset). Rotating `GEV_SESSION_SECRET` signs out
every device.

### Data providers (all optional; GEV degrades to keyless sources)

**Browser-exposed** (compiled into the JS bundle at build time; anyone who
logs in can read them in devtools; restrict them — §4). Changing them needs a
redeploy (rebuild):

| Name                                                                              | Where to get it                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_MAPS_API_KEY`                                                             | Google Cloud Console → APIs & Services → Credentials (Map Tiles API + Geocoding). Use a **GEV-only** project/key |
| `CESIUM_ION_TOKEN`                                                                | ion.cesium.com → Access Tokens (public `assets:read` token)                                                      |
| `MAPILLARY_CLIENT_TOKEN`                                                          | mapillary.com/dashboard/developers (client token, public by design)                                              |
| `VITE_AIS_LIVE_API_URL`, `VITE_AIS_LIVE_MAX_ROWS`, `VITE_AIS_LIVE_LABEL_MAX_ROWS` | Not secrets; defaults are fine                                                                                   |

**Server-side only** (never reach the browser):

| Name                                                                          | Where to get it                                       |
| ----------------------------------------------------------------------------- | ----------------------------------------------------- |
| `GOOGLE_MAPS_SERVER_API_KEY`                                                  | Separate Google key for Places + Street View Static   |
| `OPENAI_API_KEY` (+ optional `OPENAI_REALTIME_*`, `OPENAI_HUD_SUMMARY_MODEL`) | platform.openai.com → API keys (set a monthly budget) |
| `AISSTREAM_API_KEY`                                                           | aisstream.io                                          |
| `FIRMS_MAP_KEY`                                                               | firms.modaps.eosdis.nasa.gov/api/map_key              |
| `TOMTOM_API_KEY` (+ `TOMTOM_DAILY_TILE_BUDGET`)                               | developer.tomtom.com                                  |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET`                                  | opensky-network.org account → API client              |
| `LL2_API_TOKEN`                                                               | thespacedevs.com (optional)                           |
| `GEV_RATELIMIT_GOOGLE_PER_MIN`, `GEV_RATELIMIT_OPENAI_PER_MIN`                | Per-IP spend throttles; keep set on a public host     |
| `CCTV_*`, `OVERPASS_UPSTREAMS`, `AISSTREAM_*` tuning                          | See `.env.example`; defaults are fine                 |

The in-app **Provider Settings** panel cannot write keys on Hostinger (it
only accepts loopback requests); set keys in hPanel and redeploy.

## 4. Restrict browser-exposed keys to the Hostinger domain

- **Google (`GOOGLE_MAPS_API_KEY`)**: Application restrictions → _Websites_ →
  add `https://<your-temp-domain>/*` (plus `http://localhost:*/*` only if you
  also use this key locally). API restrictions → only Map Tiles API and
  Geocoding API. Add a budget alert.
- **Google server key (`GOOGLE_MAPS_SERVER_API_KEY`)**: API restrictions →
  Places API (New) + Street View Static API. (An IP restriction is only useful
  if Hostinger gives you a stable outbound IP — not verified.)
- **Cesium ion token**: restrict _Allowed URLs_ to `https://<your-temp-domain>`.
- **OpenAI**: project-scoped key with a monthly budget.

When you later move to a real domain, add it to `GEV_ALLOWED_HOSTS` and to
every referrer restriction, then redeploy.

## 5. Security notes

- **A private GitHub repository is not a private website.** Anyone with the
  URL can reach the deployment; the password gate is what keeps it private.
  The repo here is public anyway.
- Everything except `/login`, `/logout`, the web-app manifest and its icons
  requires a valid session; `/api/*` answers `401` JSON, pages show the login
  form.
- Cookie: `gev_session`, HMAC-SHA256 signed, `HttpOnly; Secure; SameSite=Lax`,
  30 days. Password check is constant-time. Five wrong passwords from one IP
  (or 50 overall) within 15 minutes lock login for 15 minutes; every failure
  is delayed ~0.75 s. The limiter is in memory and resets when Hostinger
  restarts an idle app.
- Upstream's CSP, framing headers and cross-site gates still apply. Behind
  Hostinger's proxy, `server.js` trusts `X-Forwarded-Proto/Host/For` _only
  after_ the password gate is active, so `/api` same-site checks keep working.
- `/logout` clears the cookie and sends `Clear-Site-Data` so the cached app
  shell and service worker are removed from that device.

## 6. Verification checklist

On a phone or desktop browser, in a private window:

- [ ] `https://<temp-domain>/` shows the GEV sign-in page (not the app).
- [ ] `https://<temp-domain>/api/vessels` returns `401 {"error":"Authentication required"}`.
- [ ] A wrong password shows "Incorrect password."
- [ ] The correct password opens the globe; Cesium/Esri attribution is visible
      bottom-left above the mobile nav.
- [ ] Layers you configured keys for load (check **Runtime Logs** in hPanel
      for provider errors).
- [ ] Android Chrome: menu → _Install app_ / _Add to Home screen_ shows
      "God's Eye View" with the GEV eye icon (no SaugOps branding).
- [ ] _Logout_: visit `https://<temp-domain>/logout` → back at sign-in, app no longer opens.
- [ ] Temporarily remove `GEV_ACCESS_PASSWORD` in a test redeploy → the site
      shows `503 GEV is not configured for hosted use` (fail closed). Restore it.
- [ ] SaugOps site(s) in the same hPanel account are unchanged.

## 7. Local production smoke test

```bash
npm ci && npm run build
GEV_ACCESS_PASSWORD='choose-a-test-pass' \
GEV_SESSION_SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))")" \
PORT=4310 npm start
# open http://localhost:4310
```

## 8. Licensing

GEV is MIT-licensed (© Bilawal Sidhu). Keep `LICENSE`,
`THIRD_PARTY_NOTICES.md` and the on-map data/imagery attribution intact in any
deployment.
