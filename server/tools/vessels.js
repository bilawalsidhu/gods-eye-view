/**
 * server/tools/vessels.js — OnDemand-callable Live Vessels (AIS) tools,
 * served as `GET /api/tools/vessels_in_bbox` and `GET /api/tools/vessel_by_mmsi`
 * by server/serverless/tools-route.js from the existing catch-all function.
 *
 * Both tools run the serverless AIS route IN-PROCESS (server/tools/_invoke.js
 * → server/providers/vessels/ais-serverless.js): the same bounded collector,
 * snapshot cache, demo replay and status ladder the browser's DATA LAYERS
 * panel already exercises — no second upstream client, no loopback HTTP.
 *
 *   /api/ais-live?bbox=lamin,lomin,lamax,lomax&maxRows=N
 *     → { rows, status, statusMessage, error, source, collector:{mode…}, provider }
 *   /api/ais-live/track?mmsi=
 *     → { mmsi, samples:[{lat,lon,t}], source, retainedSec }
 *
 * Nothing here reads or echoes an env value: the provider status that comes
 * back from the route (X-Provider-* headers / body.provider) is the only
 * signal of whether AISSTREAM_API_KEY is configured, and its text never
 * carries the key.
 */
import { aisServerlessProxy } from '../providers/vessels/ais-serverless.js';
import { DEMO_REPLAY_AREA } from '../providers/vessels/ais-demo-replay.js';
import { createPluginInvoker, providerFromHeaders } from './_invoke.js';

const AIS_ROUTE = '/api/ais-live';
const KM_PER_DEG_LAT = 111.32;
const DEFAULT_SNAPSHOT_MAX_ROWS = 2000;
const MMSI_PATTERN = /^\d{5,10}$/;

/** Module-level singleton so the route's in-memory snapshot cache survives across calls. */
const invokeAis = createPluginInvoker(() => aisServerlessProxy());

export const plugin = Object.freeze({
  id: 'vessels',
  name: 'OnDemand Spatial Live Vessels (AIS)',
  description:
    'Live ship positions (AIS) around a point or inside a bounding box, ' +
    'served by the OnDemand Spatial serverless AIS collector. The collector ' +
    'is BOUNDED: per scene box it opens one AISStream WebSocket, ingests for ' +
    'at most 8 s (AISSTREAM_COLLECT_MS; stops earlier after 2.5 s of silence ' +
    'or 2 000 rows), closes, and answers from a per-box snapshot cache ' +
    '(25 s TTL, shared through KV when configured) — so a call returns within ' +
    'a few seconds and never holds a socket open between requests. When ' +
    'AISSTREAM_API_KEY is missing the route serves a clearly labelled DEMO ' +
    'REPLAY (twelve synthetic vessels, MMSI 9990000NN, names "DEMO REPLAY N", ' +
    'Texas Gulf coast only) with status "degraded" and source "Demo replay" — ' +
    'never presented as live. Fallbacks (demo replay, AISHub delayed ' +
    'positions, last-good snapshots) stay in place because of the AISStream ' +
    'incident of 13 March 2026, when subscriptions were accepted but zero ' +
    'messages arrived (github.com/aisstream/aisstream/issues/15): a silent ' +
    'feed is reported as "degraded"/"empty" with a statusMessage instead of ' +
    'an empty "live" answer. Every response carries `data.status`, ' +
    '`data.collectorMode` and a `provider` block (live | stale | degraded | ' +
    'unavailable) — read them before trusting the vessel list.',
  category: 'Research',
  conversationStarters: [
    'Which vessels are currently in Galveston Bay (lat 29.45, lon -94.85)?',
    'List the ships within 100 km of Rotterdam heading to Antwerp',
    'Where is the vessel with MMSI 999000001 right now and what is its recent track?',
    'How many tankers are anchored off Fujairah (lat 25.15, lon 56.45) in a 60 km radius?',
  ],
});

// ---------------------------------------------------------------------------
// Geometry helpers (exported for tests)
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const round = (value, digits) => Number(Number(value).toFixed(digits));

/** Great-circle distance in kilometres (haversine). */
export function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371.0088;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

/**
 * Scene box around a point: `radiusKm` converted to degrees (latitude at
 * 111.32 km/°, longitude scaled by cos(lat)), clamped to the globe. Always
 * a non-degenerate box (lamin < lamax, lomin < lomax).
 */
export function bboxFromPointRadius(lat, lon, radiusKm) {
  const dLat = radiusKm / KM_PER_DEG_LAT;
  const cosLat = Math.max(0.01, Math.cos((lat * Math.PI) / 180));
  const dLon = Math.min(180, radiusKm / (KM_PER_DEG_LAT * cosLat));
  return {
    lamin: round(clamp(lat - dLat, -90, 90), 4),
    lomin: round(clamp(lon - dLon, -180, 180), 4),
    lamax: round(clamp(lat + dLat, -90, 90), 4),
    lomax: round(clamp(lon + dLon, -180, 180), 4),
  };
}

/**
 * The scene box for a validated param set: the four explicit corners when
 * ALL of lamin/lomin/lamax/lomax are present (and well-formed), else the
 * point ± radius. Returns `{ bbox, explicit }` or `{ error }`.
 */
export function resolveSceneBbox(params) {
  const corners = ['lamin', 'lomin', 'lamax', 'lomax'];
  const given = corners.filter((key) => params[key] !== undefined);
  if (given.length === 4) {
    const bbox = {
      lamin: params.lamin,
      lomin: params.lomin,
      lamax: params.lamax,
      lomax: params.lomax,
    };
    if (bbox.lamin >= bbox.lamax || bbox.lomin >= bbox.lomax) {
      return {
        error: {
          code: 'invalid_param',
          message:
            'lamin/lomin must be strictly less than lamax/lomax (a non-empty box)',
          param: 'lamin',
        },
      };
    }
    return { bbox, explicit: true };
  }
  if (given.length > 0) {
    return {
      error: {
        code: 'invalid_param',
        message: `an explicit box needs all four of ${corners.join(', ')} (got ${given.join(', ')})`,
        param: given[0],
      },
    };
  }
  return {
    bbox: bboxFromPointRadius(params.lat, params.lon, params.radiusKm),
    explicit: false,
  };
}

const bboxQuery = (bbox) =>
  [bbox.lamin, bbox.lomin, bbox.lamax, bbox.lomax].join(',');

const finiteOrNull = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const textOrNull = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

function lastPositionUtc(row) {
  const epoch = finiteOrNull(row.last_position_epoch);
  if (epoch != null && epoch > 0) return new Date(epoch * 1000).toISOString();
  const iso = textOrNull(row.last_position_UTC ?? row.last_position_utc);
  if (iso) {
    const parsed = Date.parse(iso);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return null;
}

/** One AIS row (ais-store / demo replay shape) → the documented vessel shape. */
export function normaliseVesselRow(row, origin) {
  const lat = finiteOrNull(row.lat);
  const lon = finiteOrNull(row.lon);
  return {
    mmsi: textOrNull(row.mmsi),
    name: textOrNull(row.name),
    imo: textOrNull(row.imo),
    type: textOrNull(row.type),
    destination: textOrNull(row.destination),
    lat,
    lon,
    speedKt: finiteOrNull(row.speed),
    courseDeg: finiteOrNull(row.course),
    headingDeg: finiteOrNull(row.heading),
    lastPositionUtc: lastPositionUtc(row),
    distanceKm:
      lat != null && lon != null && origin
        ? round(distanceKm(origin.lat, origin.lon, lat, lon), 2)
        : null,
  };
}

/** Provider block: the route's headers first, its body.provider as fallback. */
function providerOf(result) {
  return providerFromHeaders(result.headers) || result.json?.provider || null;
}

function snapshotUtc(payload) {
  const candidates = [
    payload?.provider?.fetchedAt,
    payload?.lastMessageAt,
    payload?.newestPositionAt,
  ];
  for (const candidate of candidates) {
    if (candidate == null || candidate === '') continue;
    const ms =
      typeof candidate === 'number'
        ? candidate > 1e12
          ? candidate
          : candidate * 1000
        : Date.parse(String(candidate));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

/**
 * Run the snapshot route for a box. Resolves to `{ ok:true, payload, provider,
 * rows }` or the tool failure envelope for a non-200 answer (503 auth-failed /
 * error, 502 route error) — never throws for an upstream problem.
 */
async function fetchScene(bbox, maxRows, ctx) {
  const query = new URLSearchParams({
    bbox: bboxQuery(bbox),
    maxRows: String(maxRows),
  });
  let result;
  try {
    result = await invokeAis(`${AIS_ROUTE}?${query}`, { signal: ctx?.signal });
  } catch (error) {
    return {
      ok: false,
      status: 502,
      error: {
        code: 'upstream_unavailable',
        message: `AIS route failed: ${String(error?.message || 'error').slice(0, 160)}`,
      },
    };
  }
  const provider = providerOf(result);
  const payload = result.json;
  if (result.status !== 200 || !payload || typeof payload !== 'object') {
    const status = result.status >= 400 ? result.status : 502;
    const reason =
      textOrNull(payload?.error) ||
      textOrNull(provider?.error) ||
      `AIS route answered HTTP ${result.status}`;
    return {
      ok: false,
      status,
      error: {
        code:
          payload?.status === 'auth-failed'
            ? 'upstream_auth'
            : status === 503
              ? 'upstream_unavailable'
              : 'upstream_error',
        message: reason,
      },
      ...(provider ? { provider } : {}),
    };
  }
  const rows = Array.isArray(payload.rows) ? payload.rows : [];
  return { ok: true, payload, provider, rows };
}

const SCENE_PARAM_DESCRIPTIONS = {
  lat: 'Scene centre latitude in decimal degrees (WGS84). Distances are measured from this point.',
  lon: 'Scene centre longitude in decimal degrees (WGS84).',
  radiusKm:
    'Half-width of the scene box around lat/lon in kilometres (ignored when all four of lamin/lomin/lamax/lomax are given).',
  lamin:
    'Optional explicit box: south edge (degrees). Supply all four corners or none.',
  lomin:
    'Optional explicit box: west edge (degrees). Supply all four corners or none.',
  lamax:
    'Optional explicit box: north edge (degrees). Supply all four corners or none.',
  lomax:
    'Optional explicit box: east edge (degrees). Supply all four corners or none.',
};

const cornerRule = (key, min, max) => ({
  type: 'number',
  min,
  max,
  description: SCENE_PARAM_DESCRIPTIONS[key],
});

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const tools = [
  {
    name: 'vessels_in_bbox',
    summary:
      'Live AIS vessels in a scene box (point ± radius, or explicit corners)',
    description:
      'Returns the vessels currently in the scene box, nearest first, from ' +
      'the bounded serverless AIS collector (≤ 8 s AISStream window per box, ' +
      'then a 25 s snapshot cache). The box is lat/lon ± radiusKm unless all ' +
      'four of lamin/lomin/lamax/lomax are given. `data.status` is the ' +
      "route's own state — live | degraded | stale | empty; `data.collectorMode` " +
      'is aisstream | cache | aishub | demo; when AISSTREAM_API_KEY is not ' +
      'configured the answer is the labelled demo replay (status degraded, ' +
      'source "Demo replay", Texas Gulf coast only) and any other box is ' +
      '`status: "empty"` with a statusMessage. `count` is the number ' +
      'returned (≤ limit), `total` the number in the box. A rejected key or a ' +
      'failed collection is a 503 with a structured reason, never a raw ' +
      'upstream error.',
    params: {
      lat: {
        type: 'number',
        required: true,
        min: -90,
        max: 90,
        description: SCENE_PARAM_DESCRIPTIONS.lat,
      },
      lon: {
        type: 'number',
        required: true,
        min: -180,
        max: 180,
        description: SCENE_PARAM_DESCRIPTIONS.lon,
      },
      lamin: cornerRule('lamin', -90, 90),
      lomin: cornerRule('lomin', -180, 180),
      lamax: cornerRule('lamax', -90, 90),
      lomax: cornerRule('lomax', -180, 180),
      radiusKm: {
        type: 'number',
        default: 60,
        min: 5,
        max: 300,
        description: SCENE_PARAM_DESCRIPTIONS.radiusKm,
      },
      limit: {
        type: 'integer',
        default: 200,
        min: 1,
        max: 2000,
        description:
          'Maximum number of vessels returned (nearest first). Default 200.',
      },
      maxRows: {
        type: 'integer',
        default: DEFAULT_SNAPSHOT_MAX_ROWS,
        min: 1,
        max: 12000,
        description:
          'Row cap requested from the AIS snapshot route before distance sorting. Default 2000.',
      },
    },
    cacheSeconds: 20,
    async handler(params, ctx) {
      const scene = resolveSceneBbox(params);
      if (scene.error) return { ok: false, status: 400, error: scene.error };
      const origin = { lat: params.lat, lon: params.lon };
      const result = await fetchScene(scene.bbox, params.maxRows, ctx);
      if (!result.ok) return result;
      const { payload, provider, rows } = result;
      const vessels = rows
        .map((row) => normaliseVesselRow(row, origin))
        .filter((vessel) => vessel.lat != null && vessel.lon != null)
        .sort(
          (a, b) =>
            (a.distanceKm ?? Number.POSITIVE_INFINITY) -
            (b.distanceKm ?? Number.POSITIVE_INFINITY),
        );
      const limited = vessels.slice(0, params.limit);
      return {
        ok: true,
        data: {
          scene: {
            lat: origin.lat,
            lon: origin.lon,
            radiusKm: scene.explicit ? null : params.radiusKm,
            explicitBox: scene.explicit,
          },
          bbox: scene.bbox,
          collectorMode: textOrNull(payload.collector?.mode) || 'unknown',
          status: textOrNull(payload.status) || 'unknown',
          statusMessage:
            textOrNull(payload.statusMessage) ||
            (vessels.length === 0 ? 'No vessels in scene' : null),
          source: textOrNull(payload.source),
          snapshotUtc: snapshotUtc(payload),
          count: limited.length,
          total: vessels.length,
          vessels: limited,
        },
        ...(provider ? { provider } : {}),
        provenance: {
          provider: textOrNull(payload.source) || 'AISStream',
          route: AIS_ROUTE,
          collector: payload.collector || null,
          completeness: {
            status: 'bounded',
            note: 'one bounded AISStream collection window per scene box (≤ 8 s), snapshot cached 25 s',
          },
        },
      };
    },
  },
  {
    name: 'vessel_by_mmsi',
    summary:
      'One vessel by MMSI from the current scene snapshot, with its recent track',
    description:
      'Looks a vessel up by its 9-digit MMSI in the scene snapshot (the box ' +
      'around lat/lon ± radiusKm, default 150 km; when lat/lon are omitted ' +
      'the Texas Gulf coast demo area 28.85..29.85 / -95.35..-94.00 is used) ' +
      'and attaches the recent path from /api/ais-live/track (positions ' +
      'collected by this function instance, or the synthetic path of a demo ' +
      'replay vessel). AIS is scene-scoped: the tool only sees vessels inside ' +
      'the box it collected, so an MMSI outside it (or not transmitting during ' +
      'the ≤ 8 s window) is a 404 `not_found`, not proof the ship does not ' +
      'exist. Demo replay MMSIs are 999000001…999000012 when no ' +
      'AISSTREAM_API_KEY is configured (status degraded).',
    params: {
      mmsi: {
        type: 'string',
        required: true,
        pattern: MMSI_PATTERN,
        maxLength: 10,
        description:
          'Maritime Mobile Service Identity, 5–10 digits (9 for ships).',
      },
      lat: {
        type: 'number',
        min: -90,
        max: 90,
        description:
          'Optional scene centre latitude; defaults (with lon) to the Texas Gulf coast demo area.',
      },
      lon: {
        type: 'number',
        min: -180,
        max: 180,
        description:
          'Optional scene centre longitude (required together with lat).',
      },
      radiusKm: {
        type: 'number',
        default: 150,
        min: 5,
        max: 300,
        description:
          'Half-width of the scene box around lat/lon in kilometres. Default 150.',
      },
    },
    cacheSeconds: 20,
    async handler(params, ctx) {
      const hasLat = params.lat !== undefined;
      const hasLon = params.lon !== undefined;
      if (hasLat !== hasLon) {
        return {
          ok: false,
          status: 400,
          error: {
            code: 'missing_param',
            message: 'lat and lon must be given together',
            param: hasLat ? 'lon' : 'lat',
          },
        };
      }
      const bbox = hasLat
        ? bboxFromPointRadius(params.lat, params.lon, params.radiusKm)
        : { ...DEMO_REPLAY_AREA };
      const origin = hasLat
        ? { lat: params.lat, lon: params.lon }
        : {
            lat: round((bbox.lamin + bbox.lamax) / 2, 4),
            lon: round((bbox.lomin + bbox.lomax) / 2, 4),
          };
      const result = await fetchScene(bbox, DEFAULT_SNAPSHOT_MAX_ROWS, ctx);
      if (!result.ok) return result;
      const { payload, provider, rows } = result;
      const row = rows.find(
        (r) => String(r?.mmsi ?? '').trim() === params.mmsi,
      );
      if (!row) {
        return {
          ok: false,
          status: 404,
          error: {
            code: 'not_found',
            message: `MMSI ${params.mmsi} not in the current scene snapshot (box ${bboxQuery(bbox)}, status ${textOrNull(payload.status) || 'unknown'}${payload.statusMessage ? `: ${payload.statusMessage}` : ''})`,
          },
          ...(provider ? { provider } : {}),
        };
      }
      let track = { samples: [], source: null, retainedSec: null };
      try {
        const trackResult = await invokeAis(
          `${AIS_ROUTE}/track?${new URLSearchParams({ mmsi: params.mmsi })}`,
          { signal: ctx?.signal },
        );
        if (trackResult.status === 200 && trackResult.json) {
          track = {
            samples: Array.isArray(trackResult.json.samples)
              ? trackResult.json.samples.map((sample) => ({
                  lat: finiteOrNull(sample.lat),
                  lon: finiteOrNull(sample.lon),
                  timeUtc:
                    finiteOrNull(sample.t) != null
                      ? new Date(sample.t * 1000).toISOString()
                      : null,
                }))
              : [],
            source: textOrNull(trackResult.json.source),
            retainedSec: finiteOrNull(trackResult.json.retainedSec),
          };
        }
      } catch {
        /* a track failure never fails the lookup — the position is the answer */
      }
      return {
        ok: true,
        data: {
          scene: {
            lat: origin.lat,
            lon: origin.lon,
            radiusKm: hasLat ? params.radiusKm : null,
            defaultDemoArea: !hasLat,
          },
          bbox,
          collectorMode: textOrNull(payload.collector?.mode) || 'unknown',
          status: textOrNull(payload.status) || 'unknown',
          statusMessage: textOrNull(payload.statusMessage),
          source: textOrNull(payload.source),
          snapshotUtc: snapshotUtc(payload),
          vessel: normaliseVesselRow(row, origin),
          track,
        },
        ...(provider ? { provider } : {}),
        provenance: {
          provider: textOrNull(payload.source) || 'AISStream',
          route: AIS_ROUTE,
          collector: payload.collector || null,
          completeness: {
            status: 'bounded',
            note: 'scene-scoped snapshot (≤ 8 s AISStream window); track = positions retained by this function instance or the demo replay path',
          },
        },
      };
    },
  },
];
