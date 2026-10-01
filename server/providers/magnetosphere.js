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
const MAX_BYTES = 512 * 1024;
const CACHE_MS = 60_000;
const STALE_LIMIT_MS = 6 * 3600_000;

function invalid(reason) {
  const error = new Error(`invalid_solar_wind_data:${reason}`);
  error.reason = reason;
  return error;
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
    const propagatedAt =
      iPropagated >= 0 ? Date.parse(row[iPropagated]) : Number.NaN;
    return {
      observedAt: new Date(observedAt).toISOString(),
      arrivesAt: Number.isFinite(propagatedAt)
        ? new Date(propagatedAt).toISOString()
        : null,
      speedKmPerS: speed,
      densityPerCm3: density,
      bzNT: bz,
      btNT: row[iBt] === null ? null : finite(row[iBt], 'bt'),
    };
  }
  throw invalid('no_complete_row');
}

/** Shape the client consumes. Keep it small and explicit. */
export function describeState(sample, { stale = false } = {}) {
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
        json(200, describeState(await acquire(controller.signal)));
      } catch (error) {
        // A bounded last-good answer beats a blank boundary, but it is only
        // offered while it is still plausibly the current state, and it is
        // always labelled.
        const usable = cache && now() - cache.fetchedAt <= STALE_LIMIT_MS;
        if (usable)
          return json(200, describeState(cache.sample, { stale: true }));
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
