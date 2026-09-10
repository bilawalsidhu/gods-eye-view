# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (Vite middleware in `vite.config.js`) brokers every request that needs a private credential, so the browser never receives one.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads Photorealistic 3D Tiles directly and powers GEV place search. **Restrict it** (HTTP referrer + API restriction to the required Google APIs) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — for ion-hosted Google Photorealistic 3D Tiles, Bing world imagery, and world terrain) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment. The Community plan has eligibility and usage limits; a public token is not a secret, but it can still consume the account's quota.

> The Vite `define` block in `vite.config.js` controls exactly what reaches the client: only these two keys. Everything else stays server-side.

Never commit real keys. `.env` is gitignored; only `.env.example` (placeholder names) is tracked. On macOS `dev-fresh.sh` can read keys from the Keychain; plain Vite uses env vars or a local `.env`, and Pinokio uses its ignored app `ENVIRONMENT` file.

The official Pinokio launcher stores optional values in its ignored local
`pinokio/ENVIRONMENT` file and Vite explicitly denies that filename. Add,
replace, or remove those values through the in-app **POWER UP → Provider
Settings** panel; the server restricts the file before writing and restarts the
local app after a save. Do not submit credentials through Pinokio 8.0.40's
native Configure form: that release targets the wrong file for this nested
launcher layout and logs the submitted values. The ignored file is local
plaintext, not encrypted storage. The macOS Keychain remains the stronger local
option when launching through `./scripts/dev-fresh.sh`.

## Server-side proxy hardening

The data proxies in `vite.config.js` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV frame proxy fetches only server-registered camera/frame URLs — clients cannot pass an upstream URL to fetch (SSRF mitigation). Other proxies target fixed upstream hosts.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **Response-size caps and timeouts.** GBFS parses at most 5 MiB of JSON and keeps its 12-second deadline active through the body. CCTV snapshots accept JPEG, PNG, WebP, or GIF up to 8 MiB; media streams enforce a 64 MiB cap and 60-second connection lifetime with backpressure. Disconnects cancel those upstream reads. Long-running media clients must reconnect. GBFS and CCTV reject redirects; configured source URLs must point to the final resource.
- **Data-only proxy responses.** GBFS always returns validated JSON. CCTV rejects upstream HTML, SVG, and other unsupported media types. API responses carry `nosniff` and a restrictive sandbox CSP; the app-generated, escaped CCTV fallback SVG remains supported.
- **Sanitized errors** — internal error details are not echoed back to clients.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Opt-in debug logging.** `GEV_DEBUG_LOG=1` enables voice logs, which can contain conversation text. The server redacts structured credentials, recognizable keys, bearer tokens, and image data URLs. It writes asynchronously to a permission-restricted `gev-debug-*` directory under the system temporary directory, outside the checkout; the console prints its location. Requests are capped at 64 KiB, the queue at eight records, the rate at 120 requests/minute, and storage at 8 MiB per process (further records are refused). Remove retained logs when finished. Legacy `.gev-logs/` files are denied by Vite; delete any old logs you no longer need.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Direct loopback access only.** A middleware installed before every application route checks the socket address and Host, rejects forwarding headers and foreign Origins, and runs for both development and preview. LAN access and reverse proxies are refused even with `--host 0.0.0.0`; remote access requires a separately designed authentication mode.
- **Browser request checks.** API requests reject cross-site fetch metadata and document navigation. POST requests require an exact matching Origin; Realtime, HUD, and setup POSTs also require JSON Content-Type. Token minting is POST-only. Command-line clients must explicitly send those headers. These checks prevent browser-driven cross-origin abuse; they do not authenticate other processes running as your local user.
- **Bounded concurrency.** At most 64 API requests can be active per server instance; excess requests receive `429`.
- **App-level throttles (opt-in):** `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). They are **per-IP, process-local, in-memory guards** — they reset on restart and are **not billing caps**.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider.
- **Pinokio LAN and Cloudflare sharing are refused.** The current supported
  Pinokio release re-reads sharing state when an app registers its Open URL and
  logs a successful tunnel-login passcode in its own notification and terminal
  stream. Before preflight, the launcher rewrites its app-scoped sharing controls
  to disabled values, clears any Pinokio-global passcode from the child, and
  pins the platform share trigger to a disabled sentinel. A stale or requested
  sharing value is therefore discarded rather than honored, and GEV starts on
  loopback only. Keep provider-side quotas as the spend backstop; remote access is not supported.

## Optional development tools

`scripts/dev-fresh.sh` refuses an occupied port and uses Vite's `--strictPort`.
Stop an existing server explicitly before restarting it; the launcher does not
terminate processes based on their listening port.

QA scripts and `tools/cesium-render.mjs` keep Chromium's sandbox and browser
same-origin checks enabled. Run them as an ordinary user in an environment that
supports Chromium's sandbox. Provider CORS failures should be fixed at the
provider or through an appropriate application proxy.

`node scripts/shot-sink.mjs` starts an optional screenshot receiver on
`127.0.0.1:4399`. It accepts the exact origin `http://localhost:4173`; set
`GEV_SHOT_ORIGIN` to another loopback origin if needed. The terminal prints a
random bearer token valid for that run. From the application's browser console:

```js
await fetch('http://127.0.0.1:4399/save?name=shot1', {
  method: 'POST',
  headers: { Authorization: 'Bearer <token printed by the sink>' },
  body: document.querySelector('canvas').toDataURL('image/png'),
});
```

The sink accepts PNG/JPEG data URLs, caps each request at 12 MiB and 15 seconds,
and allows at most four active uploads. Its `qa-shots/height-datum` directory is
limited to 128 files and 256 MiB, including files retained across restarts.
Existing files are never overwritten. Remove screenshots when no longer needed
and stop the receiver when finished.

## Scope & expectations

- The Vite server is a **local development/preview** server without remote authentication. Keep it on loopback.
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
