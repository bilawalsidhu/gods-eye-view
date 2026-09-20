# 0007 — CSP is enforced with a maintenance contract

Status: accepted (enforced 2026-09-15; pilot evidence in `public/_headers`)

## Context

The Content-Security-Policy shipped as Report-Only "pending a quiet
report cycle" — an indefinitely deferred flip, since a keyless dev
machine never accumulates production-shaped report traffic. Waiting for
report silence meant shipping without the policy's protection.

## Decision

Enforce the CSP in `public/_headers`. The flip's evidence is stronger
than a report cycle: a local pilot injected the exact policy ENFORCING on
the document and drove boot + all 17 data layers + all 5 styles + all 4
basemap stacks. Pass 1 surfaced 7 connect-src gaps (USGS feed, Cesium's
Bing imagery path, OSM tiles loaded via `fetch`); pass 2 caught Bing's
`http://` tile URLs (closed with `upgrade-insecure-requests`, not
cleartext allowance); pass 3: zero violations.

## Consequences

- The maintenance contract lives in `public/_headers` and is binding: a
  new remote origin is added to the policy in the SAME change as the code
  that uses it, verified with the pilot pattern (enforcing header +
  affected layer + zero `securitypolicyviolation` events). A risky
  change deploys the new policy as an ADDITIONAL Report-Only line; the
  enforced policy is never silently weakened.
- Cloudflare applies `_headers` to static assets only — Pages Function
  responses carry their own security headers from
  `functions/_middleware.js` (single-sourced `API_SECURITY_HEADERS` in
  `functions/_lib.js`). New function response helpers must route through
  `jsonResponse`/`rateLimitedResponse` or stamp the constant themselves.
- HSTS ships (`max-age=31536000; includeSubDomains`); `preload` is
  deliberately omitted — an effectively irreversible registry commitment
  reserved for an explicit operator decision.
