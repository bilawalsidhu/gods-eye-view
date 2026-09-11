// functions/api/adsblol.js
/**
 * `/api/adsblol` — Cloudflare Pages Function (exact route).
 *
 * The military flight layer (`src/data/militaryFlights.js`, `API_URL`) polls
 * the BARE path; `src/data/militaryRegistry.js` polls `/api/adsblol/mil`.
 * On the dev server both mounts call the same `serveMil` closure
 * (vite.config.js, adsbLolProxy) — one handler, one shared 12 s cache. This
 * Function is the same delegation: it forwards to the shared implementation
 * in `./adsblol/mil.js`, so the two Pages routes also share one per-isolate
 * cache and one contract (HIT/MISS/STALE/502, no method guard, no query
 * params).
 *
 * History: this route was previously `adsblol.ts`, an uncached pass-through
 * with a different User-Agent, a 20 s timeout and a 500 error shape — none of
 * which the dev middleware does. A flapping adsb.lol feed therefore took the
 * layer down on Pages but not in dev. Deleted; the tested dev-parity
 * implementation is the only one.
 *
 * CORS: deliberately unset, matching dev and `mil.js` — both clients are
 * same-origin.
 */

export {
  onRequest,
  resetMilCacheForTest,
} from './adsblol/mil.js';
