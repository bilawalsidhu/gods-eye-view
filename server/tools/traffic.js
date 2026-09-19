/**
 * server/tools/traffic.js — OnDemand-callable Street Traffic tools, served as
 * `GET /api/tools/traffic_flow_at_point` and `GET /api/tools/road_network_status`
 * by server/serverless/tools-route.js from the existing catch-all function.
 *
 * `traffic_flow_at_point` runs the TomTom proxy IN-PROCESS (server/tools/
 * _invoke.js → server/providers/traffic.js `/api/tomtom/flow-segment`), so
 * the 60 s per-point cache, the daily request budget governor, the
 * last-good/stale ladder and the X-Provider-* status all apply unchanged.
 *
 *   keyless  → 503 { ok:false, error:{ code:'not_configured', … }, provider }
 *              (a DEGRADED reason with a fix, never a 502)
 *   200      → data { point, currentSpeed, freeFlowSpeed, currentTravelTime,
 *              freeFlowTravelTime, confidence, roadClosure, frc,
 *              coordinatesCount, unit, roadNetwork }
 *   other    → the route's own HTTP status with a structured code
 *
 * `road_network_status` reports the road-network configuration point
 * (server/providers/overpass/constants.js `roadNetworkConfig()`): which
 * source is selected (`ROAD_NETWORK_SOURCE`, 'overpass' | 'off'), which
 * Overpass mirrors are in force (`OVERPASS_UPSTREAMS` csv override or the
 * default list) and the fixed blocker text explaining why public mirrors are
 * not dependable from cloud egress. Env values are never echoed — only
 * whether each variable is set, and the parsed mirror URLs.
 */
import { tomtomProxy } from '../providers/traffic.js';
import { roadNetworkConfig } from '../providers/overpass/constants.js';
import { createPluginInvoker, providerFromHeaders } from './_invoke.js';

const TOMTOM_ROUTE = '/api/tomtom';
export const TOMTOM_NOT_CONFIGURED_MESSAGE =
  'TOMTOM_API_KEY not set — set it in Vercel to enable live traffic';

/** Module-level singleton so the proxy's 60 s segment cache survives across calls. */
const invokeTomTom = createPluginInvoker(() => tomtomProxy());

export const plugin = Object.freeze({
  id: 'traffic',
  name: 'OnDemand Spatial Street Traffic (TomTom Flow Segment Data)',
  description:
    'Live street-traffic speed at a point from TomTom Flow Segment Data — ' +
    'current speed vs free-flow speed, travel times, confidence and road ' +
    'closure for the road segment nearest to lat/lon — through the OnDemand ' +
    'Spatial TomTom proxy (60 s per-point cache, daily request budget ' +
    'governor, last-good served as "stale" when TomTom rate-limits or times ' +
    'out). Requires the deployment to have TOMTOM_API_KEY; without it the ' +
    'tool answers 503 `not_configured` with the exact fix ("set it in Vercel ' +
    'to enable live traffic") instead of guessing. The companion ' +
    '`road_network_status` tool reports the OSM road-network configuration ' +
    '(ROAD_NETWORK_SOURCE overpass|off, the Overpass mirror list in force, ' +
    'and the known blocker: public Overpass mirrors refuse or time out for ' +
    'cloud egress — set OVERPASS_UPSTREAMS to a private mirror).',
  category: 'Research',
  conversationStarters: [
    'How congested is traffic right now near the Texas State Capitol in Austin (lat 30.2747, lon -97.7404)?',
    'Compare the current speed with the free-flow speed on the road nearest to lat 25.2048, lon 55.2708 in mph',
    'Is live street traffic configured on this deployment, and which road-network source is in use?',
    'Is there a road closure near lat 40.7580, lon -73.9855?',
  ],
});

// ---------------------------------------------------------------------------
// Helpers (exported for tests)
// ---------------------------------------------------------------------------

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

/** Provider block: the route's headers first, its body.provider as fallback. */
function providerOf(result) {
  return providerFromHeaders(result.headers) || result.json?.provider || null;
}

/**
 * Classify a non-200 answer of `/api/tomtom/flow-segment` into the tool's
 * structured failure. The keyless case is the documented DEGRADED reason
 * (503 `not_configured`, never 502); every other failure keeps the route's
 * own HTTP status and gets a stable code derived from its reason text.
 */
export function classifyTomTomFailure(status, body, provider) {
  const reason = textOrNull(body?.error);
  const detail = textOrNull(provider?.error) || reason || '';
  const text = `${reason || ''} ${detail}`;
  const httpStatus = status >= 400 ? status : 502;
  if (/TOMTOM_API_KEY not set/i.test(text) || reason === 'no_key') {
    return {
      ok: false,
      status: 503,
      error: { code: 'not_configured', message: TOMTOM_NOT_CONFIGURED_MESSAGE },
      ...(provider ? { provider } : {}),
    };
  }
  let code = 'upstream_unavailable';
  if (/rejected TOMTOM_API_KEY/i.test(text) || reason === 'bad_key')
    code = 'upstream_auth';
  else if (/rate limited/i.test(text)) code = 'rate_limited';
  else if (/timed out/i.test(text)) code = 'upstream_timeout';
  else if (/budget/i.test(text)) code = 'budget_exhausted';
  else if (/rejected the flow segment request/i.test(text))
    code = 'no_road_segment';
  else if (/malformed|too large/i.test(text)) code = 'malformed_upstream';
  else if (
    reason === 'invalid_point' ||
    reason === 'invalid_zoom' ||
    reason === 'invalid_unit'
  )
    code = 'invalid_param';
  return {
    ok: false,
    status: httpStatus,
    error: {
      code,
      message: detail || reason || `TomTom route answered HTTP ${status}`,
    },
    ...(provider ? { provider } : {}),
  };
}

/** TomTom `flowSegmentData` → the documented flat shape. */
export function normaliseFlowSegment(segment, { point, unit, roadNetwork }) {
  const coordinates = segment?.coordinates?.coordinate;
  return {
    point,
    currentSpeed: finiteOrNull(segment?.currentSpeed),
    freeFlowSpeed: finiteOrNull(segment?.freeFlowSpeed),
    currentTravelTime: finiteOrNull(segment?.currentTravelTime),
    freeFlowTravelTime: finiteOrNull(segment?.freeFlowTravelTime),
    confidence: finiteOrNull(segment?.confidence),
    roadClosure: segment?.roadClosure === true,
    frc: textOrNull(segment?.frc),
    coordinatesCount: Array.isArray(coordinates) ? coordinates.length : 0,
    unit,
    roadNetwork,
  };
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const tools = [
  {
    name: 'traffic_flow_at_point',
    summary:
      'Current vs free-flow traffic speed on the road nearest a point (TomTom)',
    description:
      'TomTom Flow Segment Data for the road segment closest to lat/lon: ' +
      'currentSpeed and freeFlowSpeed (in `unit`), current and free-flow ' +
      'travel times in seconds over the segment, confidence (0–1), roadClosure ' +
      'and the functional road class (frc, FRC0 motorway … FRC6 local). ' +
      'Served through the OnDemand Spatial proxy: 60 s cache per point ' +
      '(rounded to 0.01°), daily budget governor, last-good answers marked ' +
      '`provider.status: "stale"`. Without TOMTOM_API_KEY on the deployment ' +
      'the tool returns HTTP 503 with error code `not_configured` and the fix ' +
      '— it never fabricates a speed. A point with no mapped road nearby is a ' +
      '400 `no_road_segment`. `data.roadNetwork` echoes the road-network ' +
      'configuration (see road_network_status).',
    params: {
      lat: {
        type: 'number',
        required: true,
        min: -90,
        max: 90,
        description: 'Latitude of the probe point in decimal degrees (WGS84).',
      },
      lon: {
        type: 'number',
        required: true,
        min: -180,
        max: 180,
        description: 'Longitude of the probe point in decimal degrees (WGS84).',
      },
      zoom: {
        type: 'integer',
        default: 10,
        min: 0,
        max: 22,
        description:
          'TomTom zoom level used to pick the segment (0–22; higher = finer road network). Default 10.',
      },
      unit: {
        type: 'enum',
        values: ['KMPH', 'MPH'],
        default: 'KMPH',
        description: 'Speed unit for currentSpeed/freeFlowSpeed. Default KMPH.',
      },
    },
    cacheSeconds: 60,
    async handler(params, ctx) {
      const point = { lat: params.lat, lon: params.lon };
      const query = new URLSearchParams({
        point: `${params.lat},${params.lon}`,
        zoom: String(params.zoom),
        unit: params.unit,
      });
      let result;
      try {
        result = await invokeTomTom(`${TOMTOM_ROUTE}/flow-segment?${query}`, {
          signal: ctx?.signal,
        });
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'upstream_unavailable',
            message: `TomTom route failed: ${String(error?.message || 'error').slice(0, 160)}`,
          },
        };
      }
      const provider = providerOf(result);
      const body = result.json;
      if (result.status !== 200 || !body?.flowSegmentData) {
        return classifyTomTomFailure(result.status, body, provider);
      }
      const roadNetwork = roadNetworkConfig(ctx?.env || process.env);
      return {
        ok: true,
        data: {
          ...normaliseFlowSegment(body.flowSegmentData, {
            point,
            unit: params.unit,
            roadNetwork,
          }),
          zoom: params.zoom,
          stale: provider?.status === 'stale',
          cache: textOrNull(result.headers?.['x-tomtom-cache']),
          fetchedAt: provider?.fetchedAt ?? null,
        },
        ...(provider ? { provider } : {}),
        provenance: {
          provider: 'TomTom Flow Segment Data',
          route: `${TOMTOM_ROUTE}/flow-segment`,
          license: {
            name: 'TomTom Developer Terms',
            url: 'https://developer.tomtom.com/terms-and-conditions',
            attribution: '© TomTom',
          },
          completeness: {
            status: 'sampled',
            note: 'one road segment nearest the point; not a network-wide picture',
          },
        },
      };
    },
  },
  {
    name: 'road_network_status',
    summary:
      'Road-network configuration: source, Overpass mirrors in force, known blocker',
    description:
      'Reports the road-network configuration point of this deployment ' +
      '(server/providers/overpass/constants.js roadNetworkConfig()): ' +
      '`source` is ROAD_NETWORK_SOURCE — "overpass" (default: OSM roads via ' +
      'the Overpass mirrors) or "off" (the OSM road fetch is disabled); ' +
      '`upstreams` is the ordered Overpass mirror list actually in force ' +
      '(the OVERPASS_ENDPOINTS csv override — alias OVERPASS_UPSTREAMS — when ' +
      'set, else the default public mirrors; `endpointsSource` names which); ' +
      '`blocker` is the fixed operator note explaining why public ' +
      'mirrors are not dependable from cloud egress; `fromEnv` says whether ' +
      'each variable is set (never its value). `tomtom.configured` says ' +
      'whether live TomTom traffic is enabled (TOMTOM_API_KEY present). No ' +
      'parameters.',
    params: {},
    cacheSeconds: 300,
    async handler(params, ctx) {
      const roadNetwork = roadNetworkConfig(ctx?.env || process.env);
      const mirrorsOverridden =
        roadNetwork.fromEnv.OVERPASS_ENDPOINTS ||
        roadNetwork.fromEnv.OVERPASS_UPSTREAMS;
      let tomtom = { configured: null, provider: null };
      try {
        const status = await invokeTomTom(`${TOMTOM_ROUTE}/status`, {
          signal: ctx?.signal,
        });
        if (status.status === 200 && status.json) {
          tomtom = {
            configured: status.json.hasKey === true,
            provider: providerOf(status),
          };
        }
      } catch {
        /* status probe is advisory — the config point is the answer */
      }
      return {
        ok: true,
        data: { ...roadNetwork, tomtom },
        // Honest status for the configuration itself: 'off' is unavailable by
        // choice, the default public mirrors are degraded (blocker above), a
        // private mirror override is what makes the road network live.
        provider: {
          status:
            roadNetwork.source === 'off'
              ? 'unavailable'
              : mirrorsOverridden
                ? 'live'
                : 'degraded',
          source: `road-network:${roadNetwork.source}`,
          fetchedAt: (ctx?.now ? ctx.now() : new Date()).toISOString(),
          ageSec: 0,
          error: mirrorsOverridden ? null : roadNetwork.blocker,
          count: roadNetwork.upstreams.length,
        },
      };
    },
  },
];
