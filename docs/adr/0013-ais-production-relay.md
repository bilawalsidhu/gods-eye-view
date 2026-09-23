# 0013 — AIS vessels stay dev-only until a Durable Objects relay is justified

Status: accepted (keep-as-is decision, 2026-09-23; supersedes the open
"HTTP fallback or stays dev-only" question in DATA_SERVICES_CATALOG §4.2)

## Context

Live vessel positions come from AISStream over a persistent upstream
WebSocket (`wss://stream.aisstream.io/v0/stream`, `AISSTREAM_API_KEY`
brokered server-side by `vite/proxies/ais-live.js`). The dev middleware
holds that socket, normalizes rows into a bounded session cache
(50k-row cap, 30-min staleness, recycle ratio 2.5), and serves snapshots
over HTTP to the browser layer.

Cloudflare Pages Functions are stateless request/response workers: they
cannot hold a persistent upstream WebSocket. Durable Objects can — a DO
would hold one upstream socket and fan out to clients — but DOs are a
paid Workers-plan dependency, a new stateful component to operate, and a
new failure domain (socket lifecycle, drain, colo placement). The
production Function (`functions/api/ais-live.js`) therefore returns
`{ sources: [], status: 'unavailable_in_pages' }` and the layer reports
unavailable — an honest degradation, not a fake feed.

## Decision

Keep vessels dev-only. Do not build the DO relay now. The production
surface keeps the explicit `unavailable_in_pages` contract and its test
(`ais-live.test.mjs`).

Revisit (any one trigger):

1. Production usage data shows operators actually need vessels outside
   dev (the layer is 1 of 17; no production user has reported it).
2. The project adopts a paid Workers plan for another feature that
   already requires DOs — the marginal cost of the relay drops to code
   only.
3. AISStream (or an equivalent provider) offers an HTTP snapshot API
   compatible with the session cache — then a plain Function port beats
   a DO relay and this ADR is superseded.

## Consequences

- The vessels row in the map-source tray reads "unavailable on this
  deployment" in production — intended, documented behavior.
- Any HTTP-fallback layer added later must reuse the dev session cache
  semantics (cap/staleness/recycle) so dev and prod stay behaviorally
  comparable; a relay port would consume the same normalization path
  (`normalizeVessel`), which is benchmarked in docs/PERFORMANCE.md
  (WASM-candidate verdicts, 2026-09-23).
- The per-client cost ceiling stays zero in production; no paid-plan
  surprise is possible from this layer.
