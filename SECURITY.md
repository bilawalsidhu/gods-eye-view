# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (Vite middleware in `vite.config.js`) brokers requests that need private credentials, so the browser never receives those long-lived secrets. Google Maps and Cesium ion are the two deliberate client-side exceptions described below.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads the Photorealistic 3D Tiles in the browser. **Restrict it** (HTTP referrer + API restriction to the Map Tiles API) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — only for the Bing world-imagery map stacks) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment.

> The Vite `define` block in `vite.config.js` controls exactly what reaches the client: only these two keys plus two non-secret CCTV feature flags. Everything else stays server-side.

Never commit real keys. `.env` is gitignored; only `.env.example` (placeholder names) is tracked. On macOS the launcher reads keys from the Keychain; on other platforms use env vars or a local `.env`.

## Server-side proxy hardening

The data proxies in `vite.config.js` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV frame proxy fetches only server-registered camera/frame URLs — clients cannot pass an upstream URL to fetch (SSRF mitigation). Other proxies target fixed upstream hosts.
- **No planet-scale queries through Overpass.** `/api/overpass` validates and clamps every query before it touches a public mirror: exactly one `data` query, every element selector individually spatially bounded (with set-provenance tracking so an unbounded statement can't launder its bound through a `->.set` assignment), radius/bbox span caps, a `[timeout:]` clamp, comment/quoted-literal stripping so bounds can't be faked inside strings, and body + response byte caps. The mapped-installations endpoint accepts only a validated ≤10° bbox — no raw QL at all. Both runtimes share one policy module (`src/data/overpassPolicy.js`), so dev and Pages cannot drift.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, and (on every runtime) enforces response schema validation and a hard byte cap; click pings (`/api/radio/click/:uuid`) apply the same destination policy and accept only station IDs from the current bounded catalog. The whole subsystem lives in one shared worker-safe broker (`functions/api/radio/_broker.js`) used by both the dev middleware and the Pages Function, so the runtimes cannot drift. One honest runtime difference: the dev server additionally rejects any hostname resolving to a loopback/private/link-local/metadata/non-public A or AAAA result and pins each TLS connection to a validated address — workerd exposes no DNS/pinning primitives, so Pages bounds its SSRF surface with the host allowlist (Radio Browser's own `*.api.radio-browser.info`), the fixed path allowlist, redirect refusal and the caps instead. Both runtimes return normalized public HTTPS stream URLs. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **Bounded high-risk paths.** Request bodies and high-volume or attacker-influenced upstream responses are capped where that boundary matters; network paths use explicit timeouts or other bounded lifecycles appropriate to the feed.
- **Sanitized public failures.** Proxy handlers return controlled error messages instead of credentials or raw internal details.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Redacted debug logging.** The voice debug log (`.gev-logs/`, gitignored) strips API keys, bearer tokens, client secrets, and image data URLs before writing.
- **Same-site gates on cost-bearing endpoints.** `/api/realtime/token`, `/api/openai/hud-summary`, `/api/realtime/debug-log`, and `/api/google/*` reject cross-origin/cross-site browser requests with a sanitized `403` before any quota is spent: POST endpoints compare the `Origin` host (browsers always attach it to POSTs), GET endpoints read `Sec-Fetch-Site`. Absent headers mean a non-browser client (curl, scripts) — allowed but throttled, never blocked, so agents and command-line use keep working. The gate is one shared implementation (`sameSiteViolation` in `functions/_lib.js`) used by every key-spending handler on both runtimes.
- **A Content-Security-Policy is piloting in report-only mode.** `public/_headers` ships `Content-Security-Policy-Report-Only` covering scripts, styles, tiles/fonts/imagery origins, direct fetch targets, workers, and media. Violations are console-visible while the pilot runs; once reports are quiet the same policy flips to enforcing `Content-Security-Policy` (the header file documents why each directive is listed). Two pragmatic allowances are documented there rather than hidden: `'unsafe-eval'` (Knockout inside `@cesium/widgets` and the Maps JS API) and `'wasm-unsafe-eval'` (Cesium decoders + the FIRMS WASM renderer).

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server — and only local names are accepted (`allowedHosts` stays restricted, which also blunts DNS-rebinding tricks).
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS quota** for as long as the server runs. Do this only on networks you trust.
- **App-level throttles: opt-in in dev, default-on in production.** `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). On the **dev server** they are opt-in — unset means unlimited, which is acceptable because the server is localhost-bound. On **Cloudflare Pages they are default-on** (30/min OpenAI, 60/min Google): a public deployment with no env configured must not run key-spending endpoints wide open. Setting a positive integer overrides the default; setting `0` explicitly disables the throttle. These are **per-IP, isolate-local, in-memory guards** — they reset on deploy and are **not billing caps**.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider.

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
