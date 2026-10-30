## Summary

Adds the `admitSameSite` cross-site gate to `/api/military-installations`, as offered in the [#975 merge comment](https://github.com/bilawalsidhu/gods-eye-view/pull/975#issuecomment-6357981946).

This was the last keyless proxy endpoint without the gate. After this change, every proxy that sends queries upstream now refuses cross-site browser requests before doing any work.

| Endpoint | Gate before this PR | Gate after |
|----------|-------------------|------------|
| `/api/terrain/heights` | ✅ admitSameSite (#975) | ✅ |
| `/api/cctv/frame/:id` | ✅ admitSameSite (#922) | ✅ |
| `/api/traffic/*` | ✅ admitSameSite | ✅ |
| `/api/google/*` | ✅ admitSameSite | ✅ |
| `/api/gemini/*` | ✅ admitSameSite | ✅ |
| `/api/space/satellites` | ✅ admitSameSite | ✅ |
| `/api/overpass` | ✅ admitSameSite | ✅ |
| `/api/military-installations` | ❌ **none** | ✅ admitSameSite |

## The problem

A cross-site page (or an `<img>` tag from any website) can query `/api/military-installations` and trigger upstream Overpass requests on the user's behalf. The endpoint has a rate limiter (90/min), but no cross-site gate — so a hostile page can burn through the user's Overpass quota and exfiltrate the response data.

Every other proxy in the codebase already refuses these shapes. Military-installations was the gap.

## The fix

Two lines in `server/providers/military-installations.js`:

```diff
 import { makeRateLimiter, clientKey } from './common/rate-limit.js';
+import { admitSameSite } from './common/same-site.js';
```

```diff
       if (req.method !== 'GET') {
         res.writeHead(405, { 'Content-Type': 'application/json' });
         res.end(JSON.stringify({ error: 'Method Not Allowed' }));
         return;
       }
+      if (admitSameSite(req, res)) return;
       const url = new URL(req.url, 'http://localhost');
```

Same pattern as terrain.js, cctv.js, traffic.js, google.js, etc. Gate runs before the rate limiter, so refused requests never consume quota.

`scripts/package-boundaries.json` updated to declare `server/providers/common/same-site.js` and `src/localRequestGate.mjs` as owned modules of `military-installations-provider`.

## Tests

New file: `src/militaryInstallationsGate.test.mjs` — 4 integration tests following the `terrainHeightsBounds.test.mjs` pattern:

```
✔ cross-site browser requests are refused with 403 (2.4ms)
✔ same-origin browser request is admitted (not 403) (5.3ms)
✔ bare tool request (no Origin, no Sec-Fetch) is admitted (0.9ms)
✔ proxied same-origin requests are refused (proxy headers present) (0.5ms)
```

Tested shapes:
- `Sec-Fetch-Site: cross-site` (the `<img>` case) → 403
- `Sec-Fetch-Site: same-site` (cross-origin sibling) → 403
- `Origin: https://evil.example` (fetch from hostile page) → 403
- `Origin: null` (sandboxed iframe) → 403
- `X-Forwarded-For` + `Sec-Fetch-Site: cross-site` (proxied cross-site) → 403
- Same-origin with matching `Origin` → admitted
- No `Origin`, no `Sec-Fetch` (curl / Node) → admitted
- Proxy headers with `same-origin` → 403

All 4 tests fail on `main` and pass with the fix.

## Validation

- `node --test src/localRequestGate.test.mjs src/militaryInstallationsGate.test.mjs`: **18 tests, 18 pass, 0 fail**
- `npm run check:boundaries`: **pass** (military-installations-provider: 15 owned modules)
- `npm run check:import-directions`: pass
- Changelog fragment in `changelog.d/military-installations-cross-site-gate.md`
