/**
 * server/sources/index.js — the adapters map the capability loop executes
 * (server/ondemand/capability-loop.js) keyed by registry capability id
 * (src/registry/capabilities.json). One line per capability; every adapter
 * follows the server/sources/_shared.js contract:
 *   (params, { signal, now, fetchImpl }) → { ok, status, data, provenance }
 *
 * HTTP mounts for the same adapters live in
 * server/serverless/sources-mounts.js. Keep both in step when a Gate 3 row
 * lands. `demo.timezone` is the zero-frontend-change dynamic-capability
 * probe (docs/audit/capability-loop-verification.md) — a pure adapter that
 * exists only to prove OnDemand selects a newly registered capability.
 */

import { fetchEarthquakes } from './usgs-earthquakes.js';
import { fetchTimezone } from './demo-timezone.js';
import { fetchFires } from './nasa-firms.js';

/** Row 1 (USGS) predates the shared contract — adapt its result shape. */
async function earthquakeSearch(params, ctx = {}) {
  const r = await fetchEarthquakes(params, {
    fetchImpl: ctx.fetchImpl,
    now: ctx.now,
  });
  if (!r.ok) {
    const isValidation = Object.prototype.hasOwnProperty.call(r, 'unknown');
    return {
      ok: false,
      status: r.status,
      error: {
        code: isValidation ? 'invalid_param' : r.error,
        message: r.detail || r.error,
        ...(isValidation && r.unknown?.length ? { param: r.unknown[0] } : {}),
      },
    };
  }
  return {
    ok: true,
    status: 200,
    data: {
      source: 'USGS',
      coverage: 'observed',
      count: r.count,
      events: r.events,
    },
    provenance: r.provenance,
  };
}

export const SOURCE_ADAPTERS = Object.freeze({
  'earthquake.search': earthquakeSearch,
  'demo.timezone': (params, ctx) => fetchTimezone(params, ctx),
  // Gate 3 row 2 — env is process.env here (the adapter reads only
  // NASA_FIRMS_MAP_KEY from it and never echoes it).
  'fires.search': (params, ctx) =>
    fetchFires(params, { ...ctx, env: process.env }),
});
