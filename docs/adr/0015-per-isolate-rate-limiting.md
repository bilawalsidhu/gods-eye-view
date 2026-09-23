# 0015 — Rate limits are per-isolate burst protection, not accounting

Status: accepted (keep-as-is, 2026-09-23; formalizes the note accepted
during the Functions port so it is never re-litigated without new facts)

## Context

The shared limiter (`vite/proxies/_shared.js` for dev, the worker-safe
equivalents in `functions/_lib.js`) is a fixed-window counter in module
memory. Cloudflare runs request handlers in isolates distributed across
colos, each with its own memory, so "N requests per minute" is really
"N requests per minute per isolate." A global limit would need Durable
Objects (centralized counter, added latency + paid plan) or Workers KV
(eventually-consistent, per-write cost).

What the limiter is FOR: stopping a runaway client or retry storm from
hammering an upstream through us within one warm isolate — burst
protection. Upstreams impose their own global quotas regardless; our
limiter is a courtesy floor, not the quota authority.

## Decision

Keep the per-isolate limiter. Do not add a global distributed limiter.
The number in the limit config is understood as per-isolate and is
documented as such wherever the limit is set.

Revisit trigger: the first feature that needs ACCOUNTING (per-client
quota measurement with billing or hard guarantee attached). Then the
choice is Durable Objects (strong consistency, same paid-plan dependency
as ADR 0013 — bundle the decisions) or Cloudflare WAF rate-limiting
rules (free-tier viable, coarser). Decide at that point with real
traffic numbers; neither is implementable meaningfully in advance.

## Consequences

- Do not promise rate-limit numbers externally; the effective global
  ceiling is N × (active isolates) and is intentionally unbounded
  upward.
- The limiter's failure mode stays fail-open (memory reset on isolate
  recycle) — acceptable because its job is burst smoothing, and a
  fail-closed limiter would turn an isolate recycle into an outage.
- Any new keyed Function copies the same limiter idiom; per-isolate
  semantics are part of the idiom, not a defect to fix per-endpoint.
