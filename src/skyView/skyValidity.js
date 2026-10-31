/**
 * Validity banners. Pure: Sky time + satellite element
 * age -> the banners the toolbar shows (most severe first).
 *
 *   ephemeris  Stars (proper motion + IAU 2006 precession) and the Sun, Moon
 *              and planets (astronomy-engine) were checked against references
 *              for 2026-2036; sets the honest range at
 *              +/-50 years: 1976..2076. Outside it a warning says positions
 *              are less certain (nutation/aberration are ignored, proper
 *              motion is linear), they are still drawn.
 *   satellites The element-age rule of 4.5 (satPanel.ageBanner): grey beyond
 *              7 days from the epoch, hidden beyond 30. A warning or error
 *              level is repeated here so a time jump never hides it in the
 *              folded satellite panel.
 */
import { ageBanner } from './satPanel.js';

export const CHECKED_FROM_MS = Date.UTC(1976, 0, 1);
export const CHECKED_TO_MS = Date.UTC(2077, 0, 1);

const LEVEL_ORDER = { error: 0, warn: 1, info: 2 };
const year = (ms) => new Date(ms).getUTCFullYear();

/** Star/planet range banner, or null inside the checked range. */
export function ephemerisValidity(timeMs) {
  if (!Number.isFinite(timeMs)) return null;
  if (timeMs >= CHECKED_FROM_MS && timeMs < CHECKED_TO_MS) return null;
  return {
    id: 'ephemeris',
    level: 'warn',
    text: `Star and planet positions are checked for 1976-2076; in ${year(timeMs)} they are less certain.`,
  };
}

/** Satellite element-age banner (warn/error only), or null. */
export function satelliteValidity(age, timeMs) {
  const banner = ageBanner(age, timeMs);
  if (!banner || banner.level === 'ok') return null;
  return {
    id: 'satellites',
    level: banner.level,
    text:
      banner.level === 'error'
        ? `Satellites hidden: their elements are more than 30 days from Sky time. ${banner.text}`
        : `Satellite positions less certain: ${banner.text}`,
  };
}

/**
 * All banners for a Sky time.
 * @param {object} state  { timeMs, satAge? }
 * @returns {Array<{id, level, text}>}
 */
export function validityBanners({ timeMs, satAge = null } = {}) {
  const out = [];
  const eph = ephemerisValidity(timeMs);
  if (eph) out.push(eph);
  const sat = satelliteValidity(satAge, timeMs);
  if (sat) out.push(sat);
  return out.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
