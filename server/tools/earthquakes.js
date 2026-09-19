/**
 * server/tools/earthquakes.js — the OnDemand-callable `earthquake_search`
 * tool, served as `GET /api/tools/earthquake_search` by
 * server/serverless/tools-route.js from the existing catch-all function.
 *
 * It is a thin envelope over the Gate 3 row 1 route: the handler runs
 * `/api/sources/earthquakes?<same query>` IN-PROCESS (server/tools/_invoke.js
 * over server/serverless/sources-mounts.js → earthquakes-route.js →
 * server/sources/usgs-earthquakes.js), passes the adapter's `data` and
 * `provenance` through unchanged and maps its structured failures 1:1
 * (same HTTP status, same error code). The parameter whitelist is the
 * adapter's own `ALLOWED_PARAMS` (+ the local `mode` switch) — an unknown
 * name is a 400 `unknown_param` before anything is forwarded, exactly like
 * the source route. `/api/sources/earthquakes` stays the Gate 3 route; this
 * tool only adds the `{ ok, tool, data, provenance }` envelope the OnDemand
 * REST-API agent is registered against (docs/plugins/earthquakes/openapi.json).
 */
import { sourceMounts } from '../serverless/sources-mounts.js';
import { ALLOWED_PARAMS } from '../sources/usgs-earthquakes.js';
import { createPluginInvoker } from './_invoke.js';

const SOURCE_ROUTE = '/api/sources/earthquakes';
const USGS_PROVIDER = 'USGS FDSN Event Web Service';
/** The adapter's own accepted time formats (normalizeIsoTimestamp): date or date-time, UTC. */
const USGS_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z?)?$/;

/** Module-level singleton: every Gate 3 source mount, run in-process. */
const invokeSources = createPluginInvoker(() => ({
  configureServer(server) {
    for (const [mount, handler] of sourceMounts())
      server.middlewares.use(mount, handler);
  },
}));

export const plugin = Object.freeze({
  id: 'earthquakes',
  name: 'OnDemand Spatial Earthquake Search (USGS)',
  description:
    'Search recent or historical earthquakes from the USGS FDSN Event Web ' +
    'Service by time window (UTC), magnitude range and geographic area — a ' +
    'circle (latitude + longitude + maxradiuskm) or a bounding box ' +
    '(minlatitude/maxlatitude/minlongitude/maxlongitude), never both. Returns ' +
    'observed events (id, UTC origin time, magnitude and type, depth km, ' +
    'lat/lon, place, tsunami flag, PAGER alert, USGS URL) plus a provenance ' +
    'block with the exact upstream request URL and the public-domain licence ' +
    'note; `mode=count` returns only the number of matching events. This is ' +
    'the OnDemand tool envelope over the Gate 3 route /api/sources/earthquakes ' +
    '(same adapter, same validation, same structured failures: invalid_query ' +
    '400, usgs_rejected 400/404, usgs_unavailable 502/5xx, usgs_timeout 504). ' +
    'No authentication; USGS data are in the public domain. Results are ' +
    'capped at 200 events per call.',
  category: 'Research',
  conversationStarters: [
    'List earthquakes above magnitude 4.5 in the last 24 hours',
    'Any earthquakes within 500 km of Abu Dhabi (lat 24.45, lon 54.65) this month?',
    'Count M6+ events worldwide since 2026-01-01',
    'Show the strongest earthquakes in the Gulf of Mexico box 18..31 N, -98..-80 E since 2025-01-01, largest first',
  ],
});

// ---------------------------------------------------------------------------
// Parameter whitelist — derived from the adapter's ALLOWED_PARAMS so the two
// cannot drift (a name the adapter drops disappears here at import time).
// ---------------------------------------------------------------------------

const PARAM_RULES = {
  starttime: {
    type: 'string',
    pattern: USGS_TIME_PATTERN,
    maxLength: 32,
    description:
      'Limit to events on or after this time (UTC). `YYYY-MM-DD` (midnight UTC) or `YYYY-MM-DDTHH:MM:SS(Z)`.',
  },
  endtime: {
    type: 'string',
    pattern: USGS_TIME_PATTERN,
    maxLength: 32,
    description:
      'Limit to events on or before this time (UTC). Same formats as starttime.',
  },
  minmagnitude: {
    type: 'number',
    min: -2,
    max: 10,
    description: 'Minimum event magnitude, inclusive.',
  },
  maxmagnitude: {
    type: 'number',
    min: -2,
    max: 10,
    description: 'Maximum event magnitude, inclusive.',
  },
  latitude: {
    type: 'number',
    min: -90,
    max: 90,
    description:
      'Circle-search centre latitude (degrees). Requires longitude and maxradiuskm together; exclusive with the bounding-box keys.',
  },
  longitude: {
    type: 'number',
    min: -180,
    max: 180,
    description:
      'Circle-search centre longitude (degrees). Requires latitude and maxradiuskm together.',
  },
  maxradiuskm: {
    type: 'number',
    min: 0,
    max: 20001.6,
    description:
      'Circle-search radius in kilometres (> 0, at most 20001.6 — half the Earth’s circumference). Requires latitude and longitude together.',
  },
  minlatitude: {
    type: 'number',
    min: -90,
    max: 90,
    description: 'Bounding-box south edge (degrees). Must be <= maxlatitude.',
  },
  maxlatitude: {
    type: 'number',
    min: -90,
    max: 90,
    description: 'Bounding-box north edge (degrees). Must be >= minlatitude.',
  },
  minlongitude: {
    type: 'number',
    min: -180,
    max: 180,
    description: 'Bounding-box west edge (degrees). Must be <= maxlongitude.',
  },
  maxlongitude: {
    type: 'number',
    min: -180,
    max: 180,
    description: 'Bounding-box east edge (degrees). Must be >= minlongitude.',
  },
  limit: {
    type: 'integer',
    min: 1,
    default: 100,
    description:
      'Maximum number of events to return (default 100; the adapter caps any larger value at 200).',
  },
  orderby: {
    type: 'enum',
    values: ['time', 'time-asc', 'magnitude', 'magnitude-asc'],
    default: 'time',
    description:
      'Sort order of the returned events (default time = newest first).',
  },
  mode: {
    type: 'enum',
    values: ['query', 'count'],
    default: 'query',
    description:
      'Local switch, not forwarded to USGS: "query" returns matching events, "count" returns only the number of matching events (FDSN count endpoint).',
  },
};

/** The tool spec: the adapter's ALLOWED_PARAMS in the adapter's order, plus `mode`. */
export function earthquakeParamSpec() {
  const spec = {};
  for (const name of [...ALLOWED_PARAMS, 'mode']) {
    if (!PARAM_RULES[name]) {
      throw new Error(
        `server/tools/earthquakes.js: no rule for adapter parameter "${name}" — keep PARAM_RULES in step with usgs-earthquakes.js ALLOWED_PARAMS`,
      );
    }
    spec[name] = PARAM_RULES[name];
  }
  return spec;
}

/** Validated params → the exact query string forwarded to the Gate 3 route. */
export function sourceQuery(params) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    search.set(key, String(value));
  }
  return search.toString();
}

/**
 * Map the source route's failure body to the tool failure envelope 1:1:
 *   { error:'invalid_query', message, unknown[] }  → status as-is, code
 *       unknown_param (unknown names) | invalid_query
 *   { error:'usgs_rejected'|'usgs_unavailable'|'usgs_timeout', detail }
 *                                                  → status as-is, code = error
 *   { error:'sources_error' }                      → 502 sources_error
 */
export function mapSourceFailure(status, body) {
  const httpStatus = Number(status) >= 400 ? Number(status) : 502;
  const error = typeof body?.error === 'string' ? body.error : 'upstream_error';
  if (error === 'invalid_query') {
    const unknown = Array.isArray(body.unknown) ? body.unknown : [];
    const failure = {
      code: unknown.length ? 'unknown_param' : 'invalid_query',
      message: String(body.message || 'invalid query'),
    };
    if (unknown.length) failure.param = unknown[0];
    return { ok: false, status: httpStatus, error: failure };
  }
  return {
    ok: false,
    status: httpStatus,
    error: {
      code: error,
      message: String(
        body?.detail ||
          body?.message ||
          `earthquake source answered HTTP ${httpStatus}`,
      ).slice(0, 400),
    },
  };
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

export const tools = [
  {
    name: 'earthquake_search',
    summary:
      'Search USGS earthquakes by time window, magnitude and area (circle or bbox)',
    description:
      'All parameters are optional. A circle search (latitude + longitude + ' +
      'maxradiuskm, all three) and a bounding-box search (minlatitude/' +
      'maxlatitude/minlongitude/maxlongitude) are mutually exclusive; mixing ' +
      'them, a partial circle or an inverted box is a 400 `invalid_query`. ' +
      'Times are UTC. `mode=count` returns `count` only (no events). The ' +
      'answer carries `data.events` (normalised USGS features: id, time_utc, ' +
      'magnitude, mag_type, depth_km, lat, lon, place, tsunami 0|1, alert, ' +
      'url) and `provenance` (source, exact upstream URL, USGS generated ' +
      'time, retrieved_at_utc, public-domain licence). Failures keep the ' +
      "Gate 3 route's status and code: 400 usgs_rejected/invalid_query, 404 " +
      'usgs_rejected, 502 usgs_unavailable, 504 usgs_timeout. Unknown ' +
      'parameters are a 400 `unknown_param`.',
    params: earthquakeParamSpec(),
    cacheSeconds: 60,
    async handler(params, ctx) {
      const query = sourceQuery(params);
      let result;
      try {
        result = await invokeSources(`${SOURCE_ROUTE}?${query}`, {
          signal: ctx?.signal,
        });
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'sources_error',
            message: `earthquake source route failed: ${String(error?.message || 'error').slice(0, 160)}`,
          },
        };
      }
      const body = result.json;
      if (result.status !== 200 || !body || typeof body !== 'object') {
        return mapSourceFailure(result.status, body);
      }
      const events = Array.isArray(body.events) ? body.events : [];
      const count = Number.isFinite(Number(body.count))
        ? Number(body.count)
        : events.length;
      const fetchedAt = body.provenance?.retrieved_at_utc ?? null;
      return {
        ok: true,
        data: {
          source: body.source ?? 'USGS',
          coverage: body.coverage ?? 'observed',
          mode: params.mode,
          count,
          events,
          query: body.query ?? params,
        },
        provider: {
          status: 'live',
          source: USGS_PROVIDER,
          fetchedAt,
          ageSec: 0,
          error: null,
          count,
        },
        ...(body.provenance ? { provenance: body.provenance } : {}),
      };
    },
  },
];
