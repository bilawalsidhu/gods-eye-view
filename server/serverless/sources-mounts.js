/**
 * server/serverless/sources-mounts.js — mounts every Gate 3 `/api/sources/*`
 * adapter on the shared Connect-style router (server/serverless/app.js), so
 * all of them are served by the existing catch-all Vercel function
 * (api/[...route].js). Function count stays at 9 no matter how many rows
 * land here. One entry per family; keep server/sources/index.js (the
 * capability-loop adapters map) in step.
 */

import { createSourceHandler } from './sources-route.js';
import { createEarthquakesHandler } from './earthquakes-route.js';
import { fetchTimezone } from '../sources/demo-timezone.js';
import { fetchFires } from '../sources/nasa-firms.js';

/** [mount, handler factory] in mount order (longest prefixes first is not
 * required — the router matches on path-segment boundaries). */
export function sourceMounts() {
  return [
    // Gate 3 row 1 — earthquake.search (USGS FDSN); keeps its original route
    ['/api/sources/earthquakes', createEarthquakesHandler()],
    // Gate 3 row 2 — fires.search (NASA FIRMS area CSV API, key from
    // NASA_FIRMS_MAP_KEY at runtime; 503 not_configured without it)
    [
      '/api/sources/fires',
      createSourceHandler((q, ctx) => fetchFires(q, ctx), {
        cacheSeconds: 120,
      }),
    ],
    // dynamic-capability probe (capability-loop verification)
    [
      '/api/sources/demo/timezone',
      createSourceHandler((q, ctx) => fetchTimezone(q, ctx), {
        cacheSeconds: 0,
      }),
    ],
  ];
}

export function mountSourceRoutes(router) {
  for (const [mount, handler] of sourceMounts()) router.use(mount, handler);
}
