# 0003 — Dev/prod parity is enforced, not aspirational

Status: accepted (2026-09-14, enforced from 2026-09-16)

## Context

Every keyless data endpoint exists twice by design — as a Vite dev
middleware (`vite/proxies/*`, Node) and as a Cloudflare Pages Function
(`functions/api/**`, workerd). Twice-written logic drifted once already
(an endpoint existed in dev but 404'd on production), and nothing would
have caught the next drift until a production deploy broke a layer.

workerd has no `node:*`, `fs`, `Buffer`, or `process`, so "share code by
importing freely" is not available; shared code must stick to web
primitives (`Uint8Array`, `Request`/`Response`, `URLSearchParams`).

## Decision

Three enforcement legs, all tested:

1. **One builder inventory.** Client code composes `/api/...` URLs only
   through `src/config/apiEndpoints.js` (`import { api } from ...`) — no
   inline literals.
2. **A parity test that walks the world.**
   `src/config/apiEndpoints.test.mjs` reads the Vite plugins and the
   `functions/api/` tree and FAILS if any inventory route lacks a dev
   middleware or a Pages Function, if any mount/route is undeclared, or
   if any builder stops emitting its historical byte-exact URL.
3. **Worker-safe shared policy modules.** Cross-runtime logic (request
   gating, keyless payloads, query sanitization, response shaping) lives
   in `src/data/*Policy.js` / `functions/_lib.js`-style modules imported
   by BOTH runtimes, kept to web primitives.

## Consequences

- Adding an endpoint without its twin is a red suite, not a production
  surprise.
- Shared modules cannot reach for Node conveniences; the price is paid
  once, in the shared module, where both runtimes benefit.
- The FIRMS upstream URL is never logged (it embeds the MAP_KEY) — a
  standing rule for any new key-bearing proxy.
