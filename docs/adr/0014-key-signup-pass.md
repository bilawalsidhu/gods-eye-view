# 0014 — Key signup is operator configuration, not code: every keyed path
already reads `env.*` in production

Status: accepted (2026-09-23; closes the "keyed heavy proxies not yet
ported" gap in DATA_SERVICES_CATALOG §4.3, which had gone stale)

## Context

Several live sources require API keys (TomTom, NASA FIRMS, Launch Library
2, OpenAI, OpenSky, Google Places, AISStream). The R7 plan carried a
"key-signup pass" as if it were a work item: port the keyed dev-only
middlewares to Pages Functions and register their keys.

Audit at decision time: the porting half is ALREADY DONE. Every keyed
path has a Pages Function that reads its key from `env` at request time
and degrades to documented keyless behavior when absent —
`tomtom/[[path]].js` (`TOMTOM_API_KEY`, keyless → 503 JSON),
`firms.js` (`FIRMS_MAP_KEY`/`NASA_FIRMS_API_KEY`, keyless → public
24h SNPP CSV), `launches.js` (`LL2_API_TOKEN`, anonymous → 429
passthrough), `realtime/token.js` + `openai/hud-summary.js`
(`OPENAI_API_KEY`), `opensky.js`/`opensky-track.js`, `google/`,
`military-installations.js`, `gbfs/`, `regional-brief/`,
`weather-effects.js`. Parity is enforced, not aspirational:
`src/config/apiEndpoints.test.mjs` fails the build if an inventory route
lacks a dev middleware or a Pages Function.

## Decision

1. There is no remaining code work in the key-signup pass. Keys are
   operator configuration: register them as Cloudflare Pages environment
   variables (dashboard → project → Settings → Environment variables, per
   RUNBOOK) or in `.env` for dev. Never in repo files, docs, or logs —
   the FIRMS upstream URL embeds the MAP_KEY and is never logged, by
   contract.
2. Each keyed Function's keyless behavior is its documented contract and
   is covered by its `*.test.mjs` — an absent key must degrade honestly
   (never fake data), so key registration is optional per deployment.
3. DATA_SERVICES_CATALOG §4 is corrected: the CCTV and keyed-proxy gaps
   it lists were closed by the parity campaign; the only true remaining
   production gap is the AIS relay (ADR 0013).

## Consequences

- Adding a NEW keyed source still means BOTH runtimes: dev middleware
  under `vite/proxies/` AND a Pages Function sharing the worker-safe
  policy module, or the apiEndpoints parity test fails CI.
- Operator checklist for enabling keyed layers in production:
  obtain key → set Pages env var → redeploy (Functions read `env` per
  request; no code change). A red or empty layer in production is
  diagnosed first as "is the env var set?" — the Functions answer that
  in-band (`hasKey: false`-style fields) where the protocol allows.
- Key rotation is a Pages env change, not a deploy; document rotation in
  the RUNBOOK when the first key actually rotates.
