import {
  degreesLat,
  degreesLong,
  eciToGeodetic,
  gstime,
  propagate,
  twoline2satrec,
} from 'satellite.js';
import { parseTleText } from '../../src/sources/tle.js';

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

  return {
    /** Takes the TLE text of one CelesTrak group; groups not asked for are ignored. */
    learn(group, text) {
      if (!wanted.has(group)) return 0;
      const sats = [];
      for (const { name, line1, line2 } of parseTleText(text)) {
        try {
          const satrec = twoline2satrec(line1, line2);
          if (!satrec || satrec.error) continue;
          sats.push({ id: `SAT-${line1.slice(2, 7).trim()}`, name, satrec });
        } catch {
          // A bad element set must not stop the rest.
        }
      }
      if (sats.length) byGroup.set(group, sats);
      return sats.length;
    },

    count() {
      return new Set([...byGroup.values()].flat().map((s) => s.id)).size;
    },

    /** Positions of every known satellite at `nowSec`, in the recorder's point shape. */
    points(nowSec) {
      const date = new Date(nowSec * 1000);
      const gmst = gstime(date);
      const seen = new Set();
      const out = [];
      for (const sats of byGroup.values())
        for (const { id, satrec } of sats) {
          if (seen.has(id) || out.length >= maxObjects) continue;
          seen.add(id);
          const state = propagate(satrec, date);
          if (!state?.position || !state?.velocity) continue;
          const geo = eciToGeodetic(state.position, gmst);
          const lat = degreesLat(geo.latitude);
          const lon = degreesLong(geo.longitude);
          const { x, y, z } = state.velocity;
          if (![lat, lon, geo.height].every(Number.isFinite)) continue;
          out.push({
            id,
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
