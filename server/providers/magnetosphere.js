/**
 * Solar wind state for the magnetosphere layer.
 *
 * Serves the few numbers that decide where the magnetopause sits. The field
 * itself is not here: IGRF coefficients ship with the app and the client
 * traces its own field lines, so only the part that actually moves crosses the
 * network. That keeps this response in the hundreds of bytes rather than the
 * hundreds of kilobytes a polyline payload would cost.
 *
 * Upstream is NOAA SWPC's propagated solar wind — already time-shifted from
 * the L1 spacecraft to Earth, which is what a magnetopause model wants. U.S.
 * federal data, public domain. Wildcard CORS means a browser could fetch it
 * directly; the proxy exists to validate the shape, bound the body and share
 * one cached generation across tabs.
 *
 * @module server/providers/magnetosphere
 */
import { readCappedResponseText } from './common/http.js';
import { describeMagnetopause } from '../../src/layers/magnetosphere/magnetopause.js';

const SOLAR_WIND_URL =
  'https://services.swpc.noaa.gov/products/geospace/propagated-solar-wind-1-hour.json';
const KP_URL = 'https://services.swpc.noaa.gov/json/planetary_k_index_1m.json';
const DST_URL = 'https://services.swpc.noaa.gov/products/kyoto-dst.json';
const MAX_BYTES = 512 * 1024;
const CACHE_MS = 60_000;
const STALE_LIMIT_MS = 6 * 3600_000;

function invalid(reason) {
  const error = new Error(`invalid_solar_wind_data:${reason}`);
  error.reason = reason;
  return error;
}

/**
 * Number() coerces null, '' and false to 0, which for a geomagnetic index means
 * a missing reading becomes a perfectly quiet one. Every index here goes
 * through this instead.
 *
 * @param {*} value Raw cell from the upstream feed.
 * @returns {number} The number, or NaN if there was not one.
 */
function indexValue(value) {
  if (value === null || value === undefined || value === '') return Number.NaN;
  return Number(value);
}

function finite(value, reason) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw invalid(reason);
  return number;
}

/**
 * Pull the newest usable sample out of SWPC's header-plus-rows table.
 *
 * Rows arrive oldest first and the tail is sometimes incomplete — a row can
 * carry a timestamp with nulls for the plasma values. Scanning backwards for
 * the newest complete row is the difference between "quiet solar wind" and
 * "no data at all", and those must not look alike.
 */
export function latestSolarWind(payload) {
  if (!Array.isArray(payload) || payload.length < 2) throw invalid('shape');
  const [header, ...rows] = payload;
  if (!Array.isArray(header)) throw invalid('header');
  const column = (name) => {
    const index = header.indexOf(name);
    if (index < 0) throw invalid(`column:${name}`);
    return index;
  };
  const iTime = column('time_tag');
  const iSpeed = column('speed');
  const iDensity = column('density');
  const iBz = column('bz');
  const iBt = column('bt');
  // By is only needed by T96, so a feed without it still serves T89 and the
  // boundary. Looked up rather than required for that reason.
  const iBy = header.indexOf('by');
  const iPropagated = header.indexOf('propagated_time_tag');

  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i];
    if (!Array.isArray(row)) continue;
    if ([iSpeed, iDensity, iBz].some((index) => row[index] === null)) continue;
    const observedAt = Date.parse(row[iTime]);
    if (!Number.isFinite(observedAt)) continue;
    const speed = finite(row[iSpeed], 'speed');
    const density = finite(row[iDensity], 'density');
    const bz = finite(row[iBz], 'bz');
    // Physically impossible values mean a broken feed, not a wild solar wind.
    if (speed <= 0 || speed > 5000) throw invalid('speed_range');
    if (density <= 0 || density > 500) throw invalid('density_range');
    if (Math.abs(bz) > 500) throw invalid('bz_range');
    // GSM, as the propagated geospace product documents, which is the frame
    // both the Shue boundary and T96 want.
    let by = null;
    if (iBy >= 0 && row[iBy] !== null) {
      by = finite(row[iBy], 'by');
      if (Math.abs(by) > 500) throw invalid('by_range');
    }
    const propagatedAt =
      iPropagated >= 0 ? Date.parse(row[iPropagated]) : Number.NaN;
    return {
      observedAt: new Date(observedAt).toISOString(),
      arrivesAt: Number.isFinite(propagatedAt)
        ? new Date(propagatedAt).toISOString()
        : null,
      speedKmPerS: speed,
      densityPerCm3: density,
      byNT: by,
      bzNT: bz,
      btNT: row[iBt] === null ? null : finite(row[iBt], 'bt'),
    };
  }
  throw invalid('no_complete_row');
}

/**
 * Newest estimated Kp.
 *
 * T89 is parameterised by ground disturbance alone, so this is the only input
 * its field needs. Returned as null rather than a guess when the feed is
 * unusable: the layer treats a missing Kp as quiet and says so, which is very
 * different from silently modelling a storm as calm.
 */
export function latestKp(payload) {
  if (!Array.isArray(payload)) return null;
  for (let i = payload.length - 1; i >= 0; i--) {
    const row = payload[i];
    const raw = row?.estimated_kp ?? row?.kp_index;
    const value = indexValue(raw);
    if (!Number.isFinite(value) || value < 0 || value > 9) continue;
    return {
      kp: value,
      observedAt: row.time_tag ? `${row.time_tag}Z`.replace('ZZ', 'Z') : null,
    };
  }
  return null;
}

/**
 * Newest hourly Dst.
 *
 * T96 is keyed to Dst for its ring current amplitude, so without this the
 * client drops to T89. Kyoto's provisional index, relayed by SWPC as a flat
 * list of objects, newest last - no header row, unlike the solar wind product.
 *
 * Timestamps arrive without a zone designator but are UTC, so one is added
 * rather than letting the client parse them as local time.
 *
 * @param {*} payload Parsed upstream JSON.
 * @returns {?{dst: number, observedAt: ?string}} Newest usable value, or null.
 */
export function latestDst(payload) {
  if (!Array.isArray(payload)) return null;
  for (let i = payload.length - 1; i >= 0; i--) {
    const row = payload[i];
    const value = indexValue(row?.dst);
    // The record minimum is about -589 nT; anything beyond this is a bad feed,
    // and a positive Dst of a few tens of nT is ordinary quiet-time behaviour.
    if (!Number.isFinite(value) || value < -1000 || value > 200) continue;
    const stamp = row.time_tag ? String(row.time_tag) : null;
    return {
      dst: value,
      observedAt: stamp ? `${stamp.replace(/Z$/, '')}Z` : null,
    };
  }
  return null;
}

/** Shape the client consumes. Keep it small and explicit. */
export function describeState(
  sample,
  { stale = false, kp = null, dst = null } = {},
) {
  const magnetopause = describeMagnetopause(
    sample.densityPerCm3,
    sample.speedKmPerS,
    sample.bzNT,
  );
  if (!magnetopause) throw invalid('unmodellable');
  return {
    schemaVersion: 1,
    product: 'swpc-propagated-solar-wind',
    solarWind: sample,
    kp,
    dst,
    magnetopause,
    stale,
    unavailable: false,
  };
}

export function magnetosphereProxy({
  fetchImpl = (...args) => globalThis.fetch(...args),
  now = () => Date.now(),
} = {}) {
  let cache = null;
  let inFlight = null;
  let kpCache = null;
  let dstCache = null;

  async function loadKp(signal) {
    if (kpCache && now() - kpCache.fetchedAt < CACHE_MS) return kpCache.value;
    try {
      const response = await fetchImpl(KP_URL, { signal });
      if (!response.ok) throw new Error(`kp_http_${response.status}`);
      const { tooLarge, text } = await readCappedResponseText(
        response,
        MAX_BYTES,
      );
      if (tooLarge) throw invalid('kp_too_large');
      const value = latestKp(JSON.parse(text));
      kpCache = { value, fetchedAt: now() };
      return value;
    } catch {
      // Kp is a refinement, not a prerequisite: the boundary and the field
      // both stand without it. Keep the last good value if there is one.
      return kpCache?.value ?? null;
    }
  }

  async function loadDst(signal) {
    if (dstCache && now() - dstCache.fetchedAt < CACHE_MS)
      return dstCache.value;
    try {
      const response = await fetchImpl(DST_URL, { signal });
      if (!response.ok) throw new Error(`dst_http_${response.status}`);
      const { tooLarge, text } = await readCappedResponseText(
        response,
        MAX_BYTES,
      );
      if (tooLarge) throw invalid('dst_too_large');
      const value = latestDst(JSON.parse(text));
      dstCache = { value, fetchedAt: now() };
      return value;
    } catch {
      // Losing Dst costs T96 and nothing else: the client drops to T89 and the
      // boundary is untouched. Keep the last good value if there is one.
      return dstCache?.value ?? null;
    }
  }

  async function load(signal) {
    const response = await fetchImpl(SOLAR_WIND_URL, { signal });
    if (!response.ok) {
      const error = new Error(`solar_wind_http_${response.status}`);
      error.status = response.status;
      throw error;
    }
    // readCappedResponseText reports the cap rather than throwing, so an
    // oversized body must be checked for; destructuring it as a string would
    // have parsed "[object Object]" and failed much later, as "bad JSON".
    const { tooLarge, text } = await readCappedResponseText(
      response,
      MAX_BYTES,
    );
    if (tooLarge) throw invalid('too_large');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid('json');
    }
    const sample = latestSolarWind(parsed);
    cache = { sample, fetchedAt: now() };
    return sample;
  }

  function acquire(signal) {
    if (cache && now() - cache.fetchedAt < CACHE_MS)
      return Promise.resolve(cache.sample);
    // Coalesce: one upstream request per generation however many tabs ask.
    if (!inFlight) {
      inFlight = load(signal).finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  }

  async function handler(req, res) {
    const controller = new AbortController();
    const close = () => controller.abort();
    res.on?.('close', close);
    const json = (status, body) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method !== 'GET')
        return json(405, { error: 'method_not_allowed' });
      if (req.url !== '/' && req.url !== '')
        return json(400, { error: 'invalid_magnetosphere_query' });
      try {
        const [sample, kp, dst] = await Promise.all([
          acquire(controller.signal),
          loadKp(controller.signal),
          loadDst(controller.signal),
        ]);
        json(200, describeState(sample, { kp, dst }));
      } catch (error) {
        // A bounded last-good answer beats a blank boundary, but it is only
        // offered while it is still plausibly the current state, and it is
        // always labelled.
        const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
        if (usable)
          return json(
            200,
            describeState(cache.sample, {
              stale: true,
              kp: kpCache?.value ?? null,
              dst: dstCache?.value ?? null,
            }),
          );
        json(200, {
          schemaVersion: 1,
          product: 'swpc-propagated-solar-wind',
          stale: false,
          unavailable: true,
          reason: error.reason || error.message || 'unavailable',
        });
      }
    } finally {
      res.removeListener?.('close', close);
    }
  }

  return {
    name: 'magnetosphere',
    configureServer({ middlewares }) {
      middlewares.use('/api/magnetosphere', handler);
    },
    configurePreviewServer({ middlewares }) {
      middlewares.use('/api/magnetosphere', handler);
    },
  };
}
