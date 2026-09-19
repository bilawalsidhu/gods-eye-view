/**
 * server/tools/flights.js — OnDemand-callable live-flight tools.
 *
 *   flights_in_bbox   aircraft around a scene point (or inside an explicit
 *                     bounding box) from the existing OpenSky proxy
 *                     (server/providers/aircraft/opensky.js) run IN-PROCESS
 *                     through server/tools/_invoke.js — so the per-scene
 *                     cache, the credit governor, the circuit breaker and the
 *                     adsb.lol → adsb.fi regional fallback are shared with the
 *                     browser layer and the answer carries the same provider
 *                     status (live / stale / degraded / unavailable).
 *   flight_by_icao24  one aircraft by ICAO 24-bit address from adsb.lol
 *                     /v2/hex, falling back to adsb.fi /api/v2/hex (both
 *                     readsb-shaped), via server/providers/common/upstream.js.
 *
 * Every handler returns `{ ok:true, data, provider, provenance }` or
 * `{ ok:false, status, error:{ code, message }, provider? }` — it never throws
 * for an upstream problem and never echoes an environment value.
 *
 * `normalizeReadsbAircraft` and `worstStatus` are shared with
 * server/tools/military.js.
 */
import { openSkyProxy } from '../providers/aircraft/opensky.js';
import { distanceNm, fetchUpstreamJson } from '../providers/common/upstream.js';
import { createPluginInvoker, providerFromHeaders } from './_invoke.js';

const STATUS_RANK = { live: 0, stale: 1, degraded: 2, unavailable: 3 };
const ADSBLOL_HEX_URL = (hex) => `https://api.adsb.lol/v2/hex/${hex}`;
const ADSBFI_HEX_URL = (hex) => `https://opendata.adsb.fi/api/v2/hex/${hex}`;
const HEX_PATTERN = /^[0-9a-f]{6}$/i;

const defaultInvoke = createPluginInvoker(() => openSkyProxy());

const isoUtc = (ms) => new Date(ms).toISOString();
const round = (value, digits = 1) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

function finite(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Worst of several provider statuses (live < stale < degraded < unavailable). */
export function worstStatus(...statuses) {
  return statuses
    .filter(Boolean)
    .reduce(
      (worst, s) =>
        (STATUS_RANK[s] ?? 3) > (STATUS_RANK[worst] ?? 3) ? s : worst,
      'live',
    );
}

/**
 * Bounding-box filter from the optional lamin/lomin/lamax/lomax params —
 * only when all four are present and ordered; null otherwise.
 */
export function bboxFrom(params) {
  const { lamin, lomin, lamax, lomax } = params || {};
  const values = [lamin, lomin, lamax, lomax];
  if (values.some((v) => v === undefined || v === null)) return null;
  if (!values.every(Number.isFinite)) return null;
  if (lamin > lamax || lomin > lomax) return null;
  return { lamin, lomin, lamax, lomax };
}

const inBbox = (lat, lon, bbox) =>
  lat >= bbox.lamin &&
  lat <= bbox.lamax &&
  lon >= bbox.lomin &&
  lon <= bbox.lomax;

/**
 * One OpenSky state vector (index order: icao24, callsign, origin_country,
 * time_position, last_contact, longitude, latitude, baro_altitude,
 * on_ground, velocity, true_track, vertical_rate, sensors, geo_altitude,
 * squawk, spi, position_source[, category]) → a named row. Null without a
 * position.
 */
export function normalizeOpenSkyState(state, scene) {
  if (!Array.isArray(state)) return null;
  const lon = finite(state[5]);
  const lat = finite(state[6]);
  if (lat === null || lon === null) return null;
  const lastContact = finite(state[4]);
  const timePosition = finite(state[3]);
  const callsign = String(state[1] ?? '').trim();
  return {
    icao24: String(state[0] ?? '')
      .trim()
      .toLowerCase(),
    callsign: callsign || null,
    originCountry: state[2] == null ? null : String(state[2]),
    lat,
    lon,
    baroAltM: round(finite(state[7]), 0),
    geoAltM: round(finite(state[13]), 0),
    velocityMs: round(finite(state[9]), 1),
    headingDeg: round(finite(state[10]), 1),
    verticalRateMs: round(finite(state[11]), 2),
    onGround: state[8] === true,
    squawk: state[14] == null ? null : String(state[14]),
    positionUtc: timePosition === null ? null : isoUtc(timePosition * 1000),
    lastContactUtc: lastContact === null ? null : isoUtc(lastContact * 1000),
    distanceNm: scene
      ? round(distanceNm(scene.lat, scene.lon, lat, lon), 1)
      : null,
  };
}

/**
 * One readsb aircraft row (adsb.lol / adsb.fi / airplanes.live shape) → a
 * named row. Rows without a position are kept (an aircraft can be heard
 * without a decoded position) unless `requirePosition` is set.
 */
export function normalizeReadsbAircraft(
  row,
  { scene = null, nowMs = Date.now(), requirePosition = false } = {},
) {
  if (!row || typeof row !== 'object') return null;
  const hex = String(row.hex ?? '')
    .trim()
    .toLowerCase();
  if (!hex) return null;
  const lat = finite(row.lat);
  const lon = finite(row.lon);
  if (requirePosition && (lat === null || lon === null)) return null;
  const onGround = row.alt_baro === 'ground';
  const seen = finite(row.seen);
  const seenPos = finite(row.seen_pos);
  const dbFlags = Number(row.dbFlags) || 0;
  const callsign = String(row.flight ?? '').trim();
  return {
    icao24: hex,
    callsign: callsign || null,
    registration: row.r ? String(row.r).trim() : null,
    type: row.t ? String(row.t).trim() : null,
    description: row.desc ? String(row.desc).trim() : null,
    operator: row.ownOp ? String(row.ownOp).trim() : null,
    category: row.category ? String(row.category) : null,
    lat,
    lon,
    onGround,
    baroAltFt: onGround ? 0 : round(finite(row.alt_baro), 0),
    geoAltFt: round(finite(row.alt_geom), 0),
    groundSpeedKt: round(finite(row.gs), 1),
    trackDeg: round(finite(row.track), 1),
    verticalRateFpm: round(finite(row.baro_rate) ?? finite(row.geom_rate), 0),
    squawk: row.squawk == null ? null : String(row.squawk),
    emergency:
      row.emergency && row.emergency !== 'none' ? String(row.emergency) : null,
    seenSec: round(seen, 1),
    seenPosSec: round(seenPos, 1),
    lastSeenUtc: seen === null ? null : isoUtc(nowMs - seen * 1000),
    military: Boolean(dbFlags & 1),
    interesting: Boolean(dbFlags & 2),
    pia: Boolean(dbFlags & 4),
    ladd: Boolean(dbFlags & 8),
    distanceNm:
      scene && lat !== null && lon !== null
        ? round(distanceNm(scene.lat, scene.lon, lat, lon), 1)
        : null,
  };
}

/** readsb `now` is epoch milliseconds (adsb.lol) or seconds (some mirrors). */
export function readsbNowMs(value, fallbackMs = Date.now()) {
  const n = finite(value);
  if (n === null || n <= 0) return fallbackMs;
  return n > 10_000_000_000 ? n : n * 1000;
}

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

/**
 * Build the tool list. `invoke` (OpenSky proxy) and `fetchJson`
 * (fetchUpstreamJson) are injectable so tests stay offline.
 */
export function createFlightTools({
  invoke = defaultInvoke,
  fetchJson = fetchUpstreamJson,
} = {}) {
  const flightsInBbox = {
    name: 'flights_in_bbox',
    summary: 'Live aircraft around a point or inside a bounding box',
    description:
      'Returns the aircraft currently tracked around a scene point — within radiusNm of lat/lon, or inside the lamin/lomin/lamax/lomax bounding box when all four are supplied — nearest first. Data comes from the OpenSky Network scene snapshot (a ~3°×3° box around the point) with automatic fall-back to the adsb.lol and adsb.fi regional feeds (~250 nm) when OpenSky is unreachable or rate-limited; `sourceFeed`, `coverage` and `provider.status` (live / stale / degraded) say which feed answered and how fresh it is. Each row carries callsign, origin country, position, barometric and geometric altitude (m), ground speed (m/s), heading, vertical rate, squawk and last-contact time. Aircraft on the ground are excluded unless onGround=true.',
    cacheSeconds: 10,
    params: {
      lat: LAT,
      lon: LON,
      radiusNm: {
        type: 'number',
        default: 150,
        min: 5,
        max: 250,
        description:
          'Search radius in nautical miles around lat/lon (ignored when a full bounding box is given). Default 150.',
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
      onGround: {
        type: 'boolean',
        default: false,
        description:
          'Include aircraft reported on the ground. Default false (airborne only).',
      },
    },
    async handler(params, ctx = {}) {
      const nowMs = (
        typeof ctx.now === 'function' ? ctx.now() : new Date()
      ).getTime();
      const scene = { lat: params.lat, lon: params.lon };
      const bbox = bboxFrom(params);
      try {
        const query = new URLSearchParams({
          lat: String(params.lat),
          lon: String(params.lon),
        });
        const answer = await invoke(`/api/opensky?${query}`, {
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
                `flight proxy answered HTTP ${answer.status}`,
            },
            ...(provider ? { provider } : {}),
          };
        }
        const states = Array.isArray(answer.json.states)
          ? answer.json.states
          : [];
        const rows = [];
        for (const state of states) {
          const row = normalizeOpenSkyState(state, scene);
          if (!row) continue;
          if (row.onGround && !params.onGround) continue;
          if (bbox) {
            if (!inBbox(row.lat, row.lon, bbox)) continue;
          } else if (row.distanceNm > params.radiusNm) continue;
          rows.push(row);
        }
        rows.sort((a, b) => a.distanceNm - b.distanceNm);
        const flights = rows.slice(0, params.limit);
        const snapshotSec = finite(answer.json.time);
        const sourceFeed =
          answer.headers?.['x-flight-source'] || provider?.source || null;
        return {
          ok: true,
          data: {
            scene: {
              lat: params.lat,
              lon: params.lon,
              ...(bbox ? { bbox } : { radiusNm: params.radiusNm }),
              onGround: params.onGround,
            },
            sourceFeed,
            coverage: answer.headers?.['x-flight-coverage'] || null,
            snapshotUtc:
              snapshotSec === null ? isoUtc(nowMs) : isoUtc(snapshotSec * 1000),
            count: flights.length,
            total: rows.length,
            upstreamStates: states.length,
            flights,
          },
          ...(provider ? { provider } : {}),
          provenance: {
            source:
              'OpenSky Network state vectors via /api/opensky (adsb.lol / adsb.fi regional fall-back)',
            upstream: sourceFeed,
            fetchedAtUtc: provider?.fetchedAt || isoUtc(nowMs),
            completeness: 'partial',
            note: 'Coverage is the feed scene box or regional radius named in `coverage`; ADS-B receivers do not see every aircraft everywhere.',
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'tool_failed',
            message: `flights_in_bbox failed: ${String(error?.message || error).slice(0, 160)}`,
          },
        };
      }
    },
  };

  const flightByIcao24 = {
    name: 'flight_by_icao24',
    summary: 'One aircraft by ICAO 24-bit hex address (adsb.lol → adsb.fi)',
    description:
      'Looks up a single aircraft by its ICAO 24-bit transponder address (6 hex characters, e.g. "a835af" or "ae1460") in the adsb.lol live feed, falling back to adsb.fi when adsb.lol is unavailable or has not heard it. Returns registration, type, description, position, altitudes (ft), ground speed (kt), track, vertical rate (fpm), squawk, how many seconds ago it was heard and whether the address is flagged military. Answers 404 not_found when neither feed currently tracks the address.',
    cacheSeconds: 10,
    params: {
      icao24: {
        type: 'string',
        required: true,
        maxLength: 6,
        pattern: HEX_PATTERN,
        description:
          'ICAO 24-bit address as six hexadecimal characters (case-insensitive), e.g. a835af.',
      },
    },
    async handler(params, ctx = {}) {
      const nowMs = (
        typeof ctx.now === 'function' ? ctx.now() : new Date()
      ).getTime();
      const hex = String(params.icao24).trim().toLowerCase();
      if (!HEX_PATTERN.test(hex)) {
        return {
          ok: false,
          status: 400,
          error: {
            code: 'invalid_param',
            message: 'icao24 must be six hexadecimal characters',
            param: 'icao24',
          },
        };
      }
      const feeds = [
        { source: 'adsb.lol', url: ADSBLOL_HEX_URL(hex) },
        { source: 'adsb.fi', url: ADSBFI_HEX_URL(hex) },
      ];
      const failures = [];
      const emptyFrom = [];
      try {
        for (const feed of feeds) {
          const result = await fetchJson(feed.url, {
            timeoutMs: 10_000,
            retries: 1,
            label: feed.source,
            signal: ctx.signal,
          });
          if (!result.ok || !result.json || typeof result.json !== 'object') {
            failures.push({
              source: feed.source,
              message:
                result.error?.message ||
                `${feed.source} answered HTTP ${result.status || 0}`,
            });
            if (result.error?.code === 'cancelled') break;
            continue;
          }
          const ac = Array.isArray(result.json.ac)
            ? result.json.ac
            : Array.isArray(result.json.aircraft)
              ? result.json.aircraft
              : [];
          const snapshotMs = readsbNowMs(result.json.now, nowMs);
          const match = ac.find(
            (row) =>
              String(row?.hex || '')
                .trim()
                .toLowerCase() === hex,
          );
          if (!match) {
            emptyFrom.push(feed.source);
            continue;
          }
          const aircraft = normalizeReadsbAircraft(match, {
            nowMs: snapshotMs,
          });
          const degraded = failures.length > 0;
          const provider = {
            status: degraded ? 'degraded' : 'live',
            source: feed.source,
            fetchedAt: isoUtc(snapshotMs),
            ageSec: Math.max(0, Math.round((nowMs - snapshotMs) / 1000)),
            error: degraded
              ? failures
                  .map((f) => f.message)
                  .join('; ')
                  .slice(0, 200)
              : null,
            count: 1,
          };
          return {
            ok: true,
            data: {
              icao24: hex,
              sourceFeed: feed.source,
              snapshotUtc: isoUtc(snapshotMs),
              aircraft,
            },
            provider,
            provenance: {
              source: `${feed.source} readsb aircraft record (/v2/hex)`,
              upstream: feed.source,
              fetchedAtUtc: isoUtc(snapshotMs),
              completeness: 'partial',
              ...(emptyFrom.length ? { notTrackedBy: emptyFrom } : {}),
              ...(failures.length ? { failedFeeds: failures } : {}),
            },
          };
        }
        if (emptyFrom.length) {
          return {
            ok: false,
            status: 404,
            error: {
              code: 'not_found',
              message: `no aircraft with ICAO address ${hex} is currently tracked by ${emptyFrom.join(' or ')}`,
              param: 'icao24',
            },
            provider: {
              status: failures.length ? 'degraded' : 'live',
              source: emptyFrom.join(' + '),
              fetchedAt: isoUtc(nowMs),
              ageSec: 0,
              error: failures.length
                ? failures
                    .map((f) => f.message)
                    .join('; ')
                    .slice(0, 200)
                : null,
              count: 0,
            },
          };
        }
        return {
          ok: false,
          status: 503,
          error: {
            code: 'upstream_unavailable',
            message:
              failures.map((f) => `${f.source}: ${f.message}`).join('; ') ||
              'no aircraft feed answered',
          },
          provider: {
            status: 'unavailable',
            source: 'adsb.lol',
            fetchedAt: null,
            ageSec: null,
            error: failures
              .map((f) => f.message)
              .join('; ')
              .slice(0, 200),
            count: null,
          },
        };
      } catch (error) {
        return {
          ok: false,
          status: 502,
          error: {
            code: 'tool_failed',
            message: `flight_by_icao24 failed: ${String(error?.message || error).slice(0, 160)}`,
          },
        };
      }
    },
  };

  return [flightsInBbox, flightByIcao24];
}

export const plugin = Object.freeze({
  id: 'flights',
  name: 'OnDemand Spatial Live Flights (OpenSky → adsb.lol → adsb.fi)',
  description:
    'Live air traffic for any place on Earth: the aircraft currently around a point or inside a bounding box (callsign, country, position, altitude, speed, heading, vertical rate, squawk, last contact) from the OpenSky Network with automatic fall-back to the adsb.lol and adsb.fi community ADS-B feeds, plus a single-aircraft lookup by ICAO 24-bit address with registration, type and military flag. Backed by the same cached, breaker-protected proxy the OnDemand Spatial flights layer uses; every answer names the feed that answered and its freshness (live / stale / degraded).',
  category: 'Research',
  conversationStarters: [
    'What aircraft are flying within 100 nautical miles of Austin, Texas right now?',
    'List the flights inside the box 51.2,-0.8 to 51.8,0.4 (London) and which feed the data came from.',
    'Look up the aircraft with ICAO address a835af — what is it and where is it?',
    'How many airborne aircraft are around Dubai (25.25, 55.36) and which is closest?',
    'Is ICAO hex ae1460 a military aircraft, and is it currently being tracked?',
  ],
});

export const tools = createFlightTools();
