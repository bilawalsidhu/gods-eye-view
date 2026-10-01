import { twoline2satrec } from 'satellite.js';
import { findNextSatellitePass } from '../../../src/data/satellitePass.js';

/**
 * Satellite pass planner for `overhead` rules.
 *
 * TLEs come from CelesTrak's GP endpoint by catalog number and are cached
 * for six hours per satellite (CelesTrak asks clients not to poll faster
 * than their update cadence). Fetches are capped in size and time.
 */

const TLE_TTL_MS = 6 * 3_600_000;
const TLE_MAX_BYTES = 16 * 1024;

export function parseTle(text) {
  const lines = String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trimEnd())
    .filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith('1 '));
  if (i < 0 || !lines[i + 1]?.startsWith('2 ')) return null;
  return {
    name: i > 0 ? lines[i - 1].trim() : null,
    line1: lines[i],
    line2: lines[i + 1],
  };
}

export function createTleCache({ fetchImpl = fetch, now = Date.now } = {}) {
  const cache = new Map();
  return async function getTle(norad) {
    const id = String(norad);
    if (!/^\d{1,9}$/.test(id)) return null;
    const hit = cache.get(id);
    if (hit && now() - hit.at < TLE_TTL_MS) return hit.tle;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl(
        `https://celestrak.org/NORAD/elements/gp.php?CATNR=${id}&FORMAT=TLE`,
        { signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'gods-eye-view-alerts/1.0' } },
      );
      if (!res.ok) throw new Error(`status ${res.status}`);
      const text = (await res.text()).slice(0, TLE_MAX_BYTES);
      const tle = parseTle(text);
      cache.set(id, { at: now(), tle });
      if (cache.size > 2000) cache.delete(cache.keys().next().value);
      return tle;
    } catch {
      return hit?.tle ?? null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/**
 * Next pass of a satellite over a point.
 * @returns {object|null} Pass with riseMs/setMs/maxElevDeg/visible.
 */
export function nextPass(tle, { lat, lon, fromMs, minElevDeg = 10, horizonHours = 24 }) {
  if (!tle) return null;
  let satrec;
  try {
    satrec = twoline2satrec(tle.line1, tle.line2);
  } catch {
    return null;
  }
  if (!satrec || satrec.error) return null;
  return findNextSatellitePass({
    satrec,
    latDeg: lat,
    lonDeg: lon,
    fromMs,
    minElevDeg,
    horizonHours,
  });
}
