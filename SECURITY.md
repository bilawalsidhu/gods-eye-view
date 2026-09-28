# Security

God's Eye View is a local-first client for **public** data. It is built for exploration, demos, and learning — not as a hardened production service. This document explains the security model so you can run it safely and report issues responsibly.

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for anything exploitable.

- Use GitHub's [private vulnerability reporting](https://github.com/bilawalsidhu/gods-eye-view/security/advisories/new) (Security tab → "Report a vulnerability"), or
- Reach the maintainer directly via the contact on the GitHub profile.

Include repro steps and impact. We'll acknowledge, investigate, and credit you (if you'd like) once a fix ships.

## How secrets are handled

The golden rule: **secret-bearing API keys stay on the server side.** The dev/preview server (middleware under `server/providers/`) brokers every request that needs a private credential, so the browser never receives one.

| Key | Where it lives | How the browser uses it |
|-----|----------------|--------------------------|
| `OPENAI_API_KEY` | Server only | Browser fetches a short-lived **ephemeral** Realtime session token from `/api/realtime/token`; the real key never ships |
| `AISSTREAM_API_KEY` | Server only | Server holds the AISStream websocket; browser polls the same-origin `/api/ais-live` cache |
| OpenSky OAuth (`OPENSKY_CLIENT_ID/SECRET`) | Server only | Server mints + refreshes the token behind `/api/opensky` |
| `GOOGLE_MAPS_SERVER_API_KEY` (optional, #33) | Server only | Server calls Places (`/api/google/nearby-places`, `/api/google/text-search`) and the Street View fallback with this key; falls back to `GOOGLE_MAPS_API_KEY` when unset |
| Xweather (`XWEATHER_CLIENT_ID/SECRET`, optional) | Server only | Server fetches tiles behind `/api/xweather`; the credentials sit in the upstream URL path, so URLs are never logged, both values are redacted, errors are bare codes, and redirect `Location` headers never reach the browser |

### Two deliberately client-side keys — restrict them

These are designed to be used directly in the browser (like a Mapbox public token). They are injected into the client bundle via Vite's `define`, so they **will** be visible in browser devtools. Scope and restrict them rather than trying to hide them:

1. **Google Maps API key** — loads Photorealistic 3D Tiles directly and powers GEV place search. **Restrict it** (HTTP referrer + API restriction to the required Google APIs) in the Google Cloud Console. An unrestricted key in a public deployment can be abused and billed to you.
2. **Cesium ion token** (`CESIUM_ION_TOKEN`, optional — for ion-hosted Google Photorealistic 3D Tiles, Bing world imagery, and world terrain) — used as `Cesium.Ion.defaultAccessToken` client-side. Use a public **`assets:read`** token with **URL restrictions** for any hosted deployment. The Community plan has eligibility and usage limits; a public token is not a secret, but it can still consume the account's quota.

> The explicit browser `define` block in `build/vite.js` controls exactly what reaches the client: only these two keys. Everything else stays server-side.

**Places and Street View never needed to be on that list** (#33): they're called from the server-side proxies in the table above, which use `GOOGLE_MAPS_SERVER_API_KEY` when it's set. Splitting it from the browser-exposed key lets each key's Google Cloud restriction actually match what it does — the browser key referrer-restricted to the APIs the client loads, the server key IP-restricted (never a referrer, since it never leaves your server) to Places + Street View Static — instead of one key that has to be either over-permissioned or broken for one of its two jobs. A single shared `GOOGLE_MAPS_API_KEY` still works if you don't split them; it just has to cover every API both sides use.

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

### Configuring separate Google keys locally

Terminal development uses one ignored repository-root `.env` for both
`GOOGLE_MAPS_API_KEY` (browser) and `GOOGLE_MAPS_SERVER_API_KEY` (server).
The tracked `.env.example` documents both without credentials. Vite injects
only the browser key; sharing an environment file does not expose the server
key. Provider Settings presents only the browser key as Google Maps; configure
the optional server key manually in the environment file. Pinokio uses
its ignored `pinokio/ENVIRONMENT` instead, with app values and blanks taking
precedence over inherited global values. An absent server key retains the
browser-key fallback for existing single-key setups.

## Server-side proxy hardening

The data proxies under `server/providers/` are written so the browser cannot turn the server into an open relay:

- **No arbitrary-URL fetching.** The CCTV frame proxy fetches only server-registered camera/frame URLs — clients cannot pass an upstream URL to fetch (SSRF mitigation). Other proxies target fixed upstream hosts.
- **Live HLS is bounded and origin-pinned.** Registered HTTP(S) HLS sources use a Node puller that rejects redirects and off-origin playlist references, bounds playlists and segment bodies while streaming, and aborts timed-out or released sessions. At most two sessions retain 12 segments/24 MiB each, plus bounded download buffers. Stores are memory-only and idle sessions expire after 15 seconds. RTMP/ffmpeg execution is not enabled. Locally configured source URLs remain an operator trust boundary.
- **Radio is not an audio relay.** `/api/radio/stations` contacts only allowlisted Radio Browser HTTPS hosts and paths, rejects redirects, rejects any hostname with a loopback/private/link-local/metadata/non-public A or AAAA result, and pins each TLS connection to a validated address. It returns normalized public HTTPS stream URLs; `/api/radio/click/:uuid` applies the same destination policy and accepts only station IDs from the current bounded catalog. The browser then connects directly to the broadcaster after an explicit playback action, so the broadcaster sees the listener's IP address. GEV never proxies, caches, records, or redistributes audio.
- **No verbatim client headers upstream.** The CCTV media route is the one route that relays a request header (`Range`, for video seeking). It is parsed and canonicalized before it is forwarded: one `bytes=` range only, with every accepted form — explicit span, open-ended and suffix — bounded to the same 64 MiB ceiling the relay applies to a declared response body. Multi-range, malformed, inverted and non-`bytes` values are dropped and the request proceeds without a `Range`, as RFC 7233 §3.1 prescribes. Bounding the request bounds what is asked for: a response that declares no length — live streamed media, or a chunked body from an upstream that ignores the `Range` — has no ceiling. An upstream request the browser has stopped waiting for is cancelled rather than left running, whether the viewer leaves before the headers arrive or during the body.
- **Transit fetches registered feeds only.** `/api/transit/vehicles/<id>` resolves the id against `src/data/transitFeeds.js`; the browser never supplies a URL, and a feed that is registered but disabled does not resolve at all. Redirects are followed manually and each hop is validated against the feed's own https origin before it is requested, so an off-origin or downgraded hop is refused rather than contacted. Bodies are capped at 8 MB, the protobuf is decoded server-side under entity-count and string-length ceilings, a differential feed is refused, and snapshots live 15 s in memory with no disk cache. A per-feed admission limiter and a failure cooldown ladder bound what this process can ask of any operator.
- **Local receiver feeds are operator-configured and local-only.** `/api/local-receivers/aircraft` reads only the `aircraft.json` URLs in the server's `LOCAL_RECEIVER_FEEDS`; the browser never supplies an address. Each host must pass the shared tap address rule (`src/data/tapAddress.js`: loopback, RFC1918, `localhost`, `*.local`; no link-local, IPv6 or other names), the scheme must be http(s), the path must end in `aircraft.json`, and credentials, queries and fragments are refused. Invalid entries are logged at startup and never fetched. Reads use a 2 s timeout, refuse redirects, cap bodies at 2 MB and share one read per second; responses name each feed by band only and never carry upstream error text.
- **Response-size caps and timeouts** on proxied responses.
- **Sanitized errors** — internal error details are not echoed back to clients.
- **Coalesced OAuth refresh** and cached successful responses only (OpenSky).
- **Redacted debug logging.** The voice debug log (`.gev-logs/`, gitignored) strips API keys, bearer tokens, client secrets, and image data URLs before writing.

## Network exposure — the operator threat model

The dev server is a **key broker**: every server-side key above is spendable by anyone who can send HTTP requests to it. That shapes the defaults:

- **Local-only by default.** `./scripts/dev-fresh.sh` (and the Vite config itself) bind to `localhost`, so only your machine can reach the server — and only local names are accepted (`allowedHosts` stays restricted, which also blunts DNS-rebinding tricks).
- **LAN exposure is an explicit opt-in**: `HOST=0.0.0.0 ./scripts/dev-fresh.sh`. The launcher prints a prominent warning plus your LAN URL. Understand what opting in means: **every device on that network can drive the proxies and spend your OpenAI / Google / OpenSky / AISStream / TomTom / FIRMS / Xweather quota** for as long as the server runs. Do this only on networks you trust.
- **App-level throttles (opt-in):** `GEV_RATELIMIT_OPENAI_PER_MIN` and `GEV_RATELIMIT_GOOGLE_PER_MIN` cap the cost-bearing endpoints per client IP per minute (over-limit requests receive a sanitized `429`). They are **per-IP, process-local, in-memory guards** — they reset on restart and are **not billing caps**.
- **Provider-side budgets are the real backstop.** For hard spend protection, configure limits where the money is: OpenAI platform usage limits, Google Cloud budget alerts + per-API quotas, and equivalent controls for any other keyed provider. Xweather publishes no spending cap; its in-app counter warns but does not block, so a paid Xweather plan keeps working past the free 15,000 — `XWEATHER_MONTHLY_FREE_UNITS` only moves where that warning fires, and you should still watch the account's usage page. The proxy bounds the rate instead: each client may spend at most 600 source tiles (map units) a minute, and all clients together 3,000. Access is not unlimited either: a free-plan account that exhausts its shared allowance for the billing period gets refused (a 403 that reads "Maximum number of daily accesses reached") until the allowance resets.
- **Pinokio LAN and Cloudflare sharing are refused.** The current supported
  Pinokio release re-reads sharing state when an app registers its Open URL and
  logs a successful tunnel-login passcode in its own notification and terminal
  stream. Before preflight, the launcher rewrites its app-scoped sharing controls
  to disabled values, clears any Pinokio-global passcode from the child, and
  pins the platform share trigger to a disabled sentinel. A stale or requested
  sharing value is therefore discarded rather than honored, and GEV starts on
  loopback only. Use a separately reviewed authentication proxy for remote
  access and keep provider-side quotas as the spend backstop.

## Scope & expectations

- The Vite server is a **development/preview** server. If you expose it beyond localhost, put it behind your own auth/proxy and review the bindings (see the threat model above).
- All data shown is from **public** sources. See [DATA_SOURCES.md](DATA_SOURCES.md). Respect each provider's terms and rate limits.
- The voice agent receives feed-sourced text (place names, callsigns) as scene context. It is instructed to act only via a fixed set of app-control tools and not to execute arbitrary instructions found in data, but treat model output as untrusted and keep the tool surface limited.

## Responsible use

This is an interface for signals that are **already public**. Use it accordingly: respect privacy, follow data providers' terms, and don't represent public-data inference as authoritative intelligence.
