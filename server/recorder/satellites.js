import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import { parseTleText, tleCatalogNumber } from '../../src/sources/tle.js';

/** Groups too large to record by default (Starlink alone is thousands of objects). */
export const DEFAULT_SAT_GROUPS = ['stations', 'visual', 'gps-ops', 'galileo'];

/**
 * Keeps the latest TLE sets seen on the CelesTrak proxy and turns them into
 * positions on demand. The browser computes satellite positions itself, so the
 * recorder works them out again here from the same orbital elements.
 */
export function createSatelliteSource({
  groups = DEFAULT_SAT_GROUPS,
  maxObjects = 3000,
} = {}) {
  const wanted = new Set(groups);
  const byGroup = new Map(); // group -> [{ id, satrec }]
  /** Elements from another source (N2YO) for single satellites. */
  const extra = new Map(); // id -> { id, name, satrec }
  const epochSec = (satrec) =>
    (satrec.jdsatepoch + (satrec.jdsatepochF || 0) - 2440587.5) * 86400;
  /** Every known satellite once, keeping the set with the newest epoch. */
  const candidates = () => {
    const best = new Map();
    for (const list of [...byGroup.values(), [...extra.values()]])
      for (const item of list) {
        const have = best.get(item.id);
        if (!have || epochSec(item.satrec) > epochSec(have.satrec))
          best.set(item.id, item);
      }
    return [...best.values()];
  };

  return {
    /** Takes the TLE text of one CelesTrak group; groups not asked for are ignored. */
    learn(group, text) {
      if (!wanted.has(group)) return 0;
      const sats = [];
      for (const { name, line1, line2 } of parseTleText(text)) {
        try {
          const satrec = twoline2satrec(line1, line2);
          if (!satrec || satrec.error) continue;
          // Decoded, so an Alpha-5 field such as A0057 becomes 100057, the
          // number NORAD and N2YO use.
          const norad = tleCatalogNumber(line1);
          if (norad === null) continue;
          sats.push({ id: `SAT-${norad}`, name, satrec });
        } catch {
          // A bad element set must not stop the rest.
        }
      }
      if (sats.length) byGroup.set(group, sats);
      return sats.length;
    },

    count() {
      return candidates().length;
    },

    /** Days since the element set for `id` (SAT-25544) was made, or null if unknown. */
    epochAgeDays(id, nowSec) {
      const item = candidates().find((c) => c.id === id);
      return item ? (nowSec - epochSec(item.satrec)) / 86400 : null;
    },

    /** Adds one element set from another source; true when it was usable. */
    addElements(name, line1, line2) {
      try {
        const satrec = twoline2satrec(line1, line2);
        const norad = tleCatalogNumber(line1);
        if (!satrec || satrec.error || norad === null) return false;
        extra.set(`SAT-${norad}`, { id: `SAT-${norad}`, name, satrec });
        return true;
      } catch {
        return false;
      }
    },

    /** How many satellites currently come from the extra source. */
    extraCount() {
      return extra.size;
    },

    /** Positions of every known satellite at `nowSec`, in the recorder's point shape. */
    points(nowSec) {
      const date = new Date(nowSec * 1000);
      const gmst = gstime(date);
      const out = [];
      for (const { id, name, satrec } of candidates()) {
        if (out.length >= maxObjects) break;
        const state = propagate(satrec, date);
        if (!state?.position || !state?.velocity) continue;
        const geo = eciToGeodetic(state.position, gmst);
        const lat = degreesLat(geo.latitude);
        const lon = degreesLong(geo.longitude);
        const { x, y, z } = state.velocity;
        if (![lat, lon, geo.height].every(Number.isFinite)) continue;
        out.push({
          id,
          name,
          layer: 'sat',
          lat,
          lon,
          alt: geo.height * 1000,
          heading: null,
          speed: Math.hypot(x, y, z) * 1000,
          ts: nowSec,
        });
      }
      return out;
    },
  };
}
