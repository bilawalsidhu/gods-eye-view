/**
 * server/tools/military.js — OnDemand-callable military-flight tool backed by
 * the existing adsb.lol /v2/mil proxy (server/providers/aircraft/adsb-lol.js)
 * run IN-PROCESS through server/tools/_invoke.js, so the 12 s list cache, the
 * adsb.fi / airplanes.live fall-backs, the per-feed cooldowns and the
 * structured provider status are shared with the browser layer.
 *
 *   military_flights_in_bbox  military-flagged aircraft (readsb dbFlags & 1)
 *                             within radiusNm of a point, or inside an
 *                             explicit bounding box, nearest first.
 *
 * Returns `{ ok:true, data, provider, provenance }` or `{ ok:false, status,
 * error:{ code, message }, provider? }` — never throws for an upstream
 * problem and never echoes an environment value.
 */
import { adsbLolProxy } from '../providers/aircraft/adsb-lol.js';
import { distanceNm } from '../providers/common/upstream.js';
import { createPluginInvoker, providerFromHeaders } from './_invoke.js';
import { bboxFrom, normalizeReadsbAircraft, readsbNowMs } from './flights.js';

const defaultInvoke = createPluginInvoker(() => adsbLolProxy());
const isoUtc = (ms) => new Date(ms).toISOString();
/** The proxy's own scene-filter ceiling (server/providers/aircraft/adsb-lol.js). */
const PROXY_MAX_RADIUS_NM = 5000;

/**
 * Radius (nm) from the scene point that covers every corner of a bounding
 * box, so the proxy's radius filter never clips a box the caller asked for.
 */
export function radiusCoveringBbox(lat, lon, bbox) {
  const corners = [
    [bbox.lamin, bbox.lomin],
    [bbox.lamin, bbox.lomax],
    [bbox.lamax, bbox.lomin],
    [bbox.lamax, bbox.lomax],
  ];
  const farthest = Math.max(
    ...corners.map(([la, lo]) => distanceNm(lat, lon, la, lo)),
  );
  return Math.min(PROXY_MAX_RADIUS_NM, Math.ceil(farthest) + 1);
}

const inBbox = (lat, lon, bbox) =>
  lat >= bbox.lamin &&
  lat <= bbox.lamax &&
  lon >= bbox.lomin &&
  lon <= bbox.lomax;

const LAT = {
  type: 'number',
  required: true,
  min: -90,
  max: 90,
  description:
    'Scene centre latitude in decimal degrees (WGS84); distances are measured from this point.',
};
const LON = {
  type: 'number',
  required: true,
  min: -180,
  max: 180,
  description:
    'Scene centre longitude in decimal degrees (WGS84); distances are measured from this point.',
};
const bboxParam = (edge, description) => ({
  type: 'number',
  min: edge === 'la' ? -90 : -180,
  max: edge === 'la' ? 90 : 180,
  description,
});

/** Build the tool list; `invoke` is injectable so tests stay offline. */
export function createMilitaryTools({ invoke = defaultInvoke } = {}) {
  const militaryFlightsInBbox = {
    name: 'military_flights_in_bbox',
    summary: 'Military aircraft around a point or inside a bounding box',
    description:
      'Returns the military-flagged aircraft (readsb dbFlags & 1: air forces, navies, coast guards and government fleets that broadcast ADS-B/MLAT) currently tracked within radiusNm of lat/lon — or inside the lamin/lomin/lamax/lomax bounding box when all four are supplied — nearest first. The worldwide list comes from adsb.lol /v2/mil, with adsb.fi (and airplanes.live when enabled) as fall-backs; `provider.status` (live / stale / degraded) and `sourceFeed` say which feed answered and how fresh it is. Each row carries callsign, registration, type, description, position, altitudes (ft), ground speed (kt), track, vertical rate (fpm), squawk, seconds since last heard and the military / interesting / PIA / LADD flags. Coverage depends on community receivers: aircraft with transponders off or outside receiver range are not present.',
    cacheSeconds: 12,
    params: {
      lat: LAT,
      lon: LON,
      radiusNm: {
        type: 'number',
        default: 600,
        min: 10,
        max: 1500,
        description:
          'Search radius in nautical miles around lat/lon (ignored when a full bounding box is given). Default 600.',
      },
      lamin: bboxParam(
        'la',
        'Bounding-box south edge (latitude). Optional; all four edges must be given to use a box.',
      ),
      lomin: bboxParam('lo', 'Bounding-box west edge (longitude). Optional.'),
      lamax: bboxParam('la', 'Bounding-box north edge (latitude). Optional.'),
      lomax: bboxParam('lo', 'Bounding-box east edge (longitude). Optional.'),
      limit: {
        type: 'integer',
        default: 200,
        min: 1,
        max: 1000,
        description:
          'Maximum number of aircraft returned (nearest first). Default 200.',
      },
    },
    async handler(params, ctx = {}) {
      const nowMs = (
        typeof ctx.now === 'function' ? ctx.now() : new Date()
      ).getTime();
      const scene = { lat: params.lat, lon: params.lon };
      const bbox = bboxFrom(params);
      const radiusNm = bbox
        ? radiusCoveringBbox(params.lat, params.lon, bbox)
        : params.radiusNm;
      try {
        const query = new URLSearchParams({
          lat: String(params.lat),
          lon: String(params.lon),
          radiusNm: String(radiusNm),
        });
        const answer = await invoke(`/api/adsblol/mil?${query}`, {
          signal: ctx.signal,
        });
        const provider =
          providerFromHeaders(answer.headers) ||
          (answer.json?.provider && typeof answer.json.provider === 'object'
            ? answer.json.provider
            : null);
        if (answer.status !== 200 || !answer.json) {
          return {
            ok: false,
            status: answer.status === 503 ? 503 : 502,
            error: {
              code:
                answer.status === 503
                  ? 'upstream_unavailable'
                  : 'malformed_upstream',
              message:
                answer.json?.error ||
                provider?.error ||
                `military proxy answered HTTP ${answer.status}`,
            },
            ...(provider ? { provider } : {}),
          };
        }
        const ac = Array.isArray(answer.json.ac) ? answer.json.ac : [];
        const snapshotMs = readsbNowMs(answer.json.now, nowMs);
        const rows = [];
        for (const raw of ac) {
          const row = normalizeReadsbAircraft(raw, {
            scene,
            nowMs: snapshotMs,
            requirePosition: true,
          });
          if (!row) continue;
          if (bbox) {
            if (!inBbox(row.lat, row.lon, bbox)) continue;
          } else if (row.distanceNm > params.radiusNm) continue;
          rows.push(row);
        }
        rows.sort((a, b) => a.distanceNm - b.distanceNm);
        const aircraft = rows.slice(0, params.limit);
        const sourceFeed = provider?.source || 'adsb.lol';
        return {
          ok: true,
          data: {
            scene: {
              lat: params.lat,
              lon: params.lon,
              ...(bbox ? { bbox } : { radiusNm: params.radiusNm }),
            },
            sourceFeed,
            coverage:
              answer.headers?.['x-flight-coverage'] ||
              `${radiusNm}nm around ${params.lat},${params.lon}`,
            snapshotUtc: isoUtc(snapshotMs),
            count: aircraft.length,
            total: rows.length,
            aircraft,
          },
          ...(provider ? { provider } : {}),
          provenance: {
            source:
              'readsb military list via /api/adsblol/mil (adsb.lol /v2/mil; adsb.fi fall-back)',
            upstream: sourceFeed,
            fetchedAtUtc: provider?.fetchedAt || isoUtc(snapshotMs),
            completeness: 'partial',
            cache: answer.headers?.['x-ads-b-cache'] || null,
            note: 'Community ADS-B/MLAT coverage only; aircraft without a decoded position are omitted.',
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'tool_failed',
            message: `military_flights_in_bbox failed: ${String(error?.message || error).slice(0, 160)}`,
          },
        };
      }
    },
  };

  return [militaryFlightsInBbox];
}

export const plugin = Object.freeze({
  id: 'military',
  name: 'OnDemand Spatial Military Flights (adsb.lol /v2/mil)',
  description:
    'Military aircraft currently broadcasting ADS-B/MLAT anywhere in the world — tankers, transports, patrol aircraft, trainers, helicopters and government fleets flagged military in the readsb database — around a point or inside a bounding box, with callsign, registration, type, position, altitude, speed, track, squawk and freshness. Sourced from adsb.lol /v2/mil with adsb.fi as fall-back through the same cached, cooldown-protected proxy the OnDemand Spatial military layer uses; every answer names the feed that answered and its status (live / stale / degraded).',
  category: 'Research',
  conversationStarters: [
    'Which military aircraft are flying within 600 nautical miles of Austin, Texas right now?',
    'Are there any military tankers or transports over the Baltic Sea (box 54,10 to 60,30)?',
    'List the military aircraft closest to Ramstein (49.44, 7.60) and what types they are.',
    'How many military flights are currently tracked around the eastern Mediterranean (34, 33)?',
  ],
});

export const tools = createMilitaryTools();
