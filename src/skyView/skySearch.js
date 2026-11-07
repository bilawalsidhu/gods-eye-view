/**
 * Sky search: type "Orion", "Jupiter", "Vega"
 * or a satellite name; the best match is looked at with an animation and a
 * marker. Pure index + ranking; positions are resolved by the caller from
 * the same sources the overlay draws (so the marker sits on the object).
 */
import { PLANETS } from './ephemeris.js';
import { azElFromEnu, makeView, normalizeAz } from './skyMath.js';

export const BODY_NAMES = Object.freeze(['Sun', 'Moon', ...PLANETS]);
const KIND_ORDER = { body: 0, constellation: 1, star: 2, satellite: 3 };
export const MAX_RESULTS = 8;
/** Duration of the animated look-at (instant with reduced motion). */
export const LOOK_AT_MS = 900;

const fold = (text) =>
  String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

/** 0 exact, 1 prefix, 2 word prefix, 3 substring, null no match. */
export function matchScore(key, query) {
  return foldedScore(fold(key), fold(query));
}

/** matchScore on already folded strings (hot loop over 16k satellites). */
function foldedScore(k, q) {
  if (!q || !k) return null;
  if (k === q) return 0;
  if (k.startsWith(q)) return 1;
  if (k.split(/[\s\-()/]+/).some((word) => word && word.startsWith(q)))
    return 2;
  if (k.includes(q)) return 3;
  return null;
}

/** Search entries for the catalogue and the solar-system bodies. */
export function buildSearchIndex({ constellations = [], stars = null } = {}) {
  const entries = [];
  for (const name of BODY_NAMES)
    entries.push({
      kind: 'body',
      label: name,
      detail: name === 'Sun' || name === 'Moon' ? '' : 'planet',
      keys: [name],
      target: { type: 'body', name },
      mag: 0,
    });
  constellations.forEach((c, k) =>
    entries.push({
      kind: 'constellation',
      label: c.native || c.name,
      detail: `constellation${c.name ? `, ${c.name}` : ''}`,
      keys: [c.native, c.name, c.iau].filter(Boolean),
      target: { type: 'constellation', index: k, iau: c.iau },
      mag: 0,
    }),
  );
  if (stars?.names)
    for (const [index, name] of stars.names)
      entries.push({
        kind: 'star',
        label: name,
        detail: `star, mag ${Number(stars.mag[index]).toFixed(1)}`,
        keys: [name],
        target: { type: 'star', index },
        mag: stars.mag[index],
      });
  return entries;
}

/**
 * Ranked matches. `satellites(query)` (optional, from the satellite layer)
 * returns [{id, name}] and adds satellite results.
 */
export function searchSky(
  query,
  index,
  { satellites, limit = MAX_RESULTS } = {},
) {
  const q = fold(query);
  if (!q) return [];
  const hits = [];
  for (const entry of index) {
    let best = null;
    for (const key of entry.keys) {
      const score = matchScore(key, q);
      if (score != null && (best == null || score < best)) best = score;
    }
    if (best != null) hits.push({ ...entry, score: best });
  }
  if (typeof satellites === 'function') {
    let rank = 0;
    for (const sat of satellites(q) || []) {
      const score = matchScore(sat.name, q);
      if (score == null) continue;
      hits.push({
        kind: 'satellite',
        label: sat.name,
        detail: 'satellite',
        keys: [sat.name],
        target: { type: 'satellite', id: sat.id },
        mag: 0,
        score,
        // the provider's own order (catalogue order: ISS (ZARYA) first)
        rank: rank++,
      });
    }
  }
  hits.sort(
    (a, b) =>
      a.score - b.score ||
      KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
      a.mag - b.mag ||
      (a.rank ?? 0) - (b.rank ?? 0) ||
      (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
  );
  return hits.slice(0, limit);
}

/**
 * Current apparent az/el of a search target, or null when unknown.
 * sources: { field (starLayer), positioned (constellationLayer),
 *   ephemeris (ephemeris.skyEphemeris), satellite(id) -> {azDeg, elDeg} }
 */
export function resolveTarget(target, sources = {}) {
  if (!target) return null;
  switch (target.type) {
    case 'star': {
      const pos = sources.field?.pos;
      if (!pos) return null;
      const i = target.index;
      return azElFromEnu([pos.e[i], pos.n[i], pos.u[i]]);
    }
    case 'constellation': {
      const c = sources.positioned?.centroids;
      if (!c) return null;
      const i = target.index;
      return azElFromEnu([c.e[i], c.n[i], c.u[i]]);
    }
    case 'body': {
      const eph = sources.ephemeris;
      if (!eph) return null;
      const body =
        target.name === 'Sun'
          ? eph.sun
          : target.name === 'Moon'
            ? eph.moon
            : eph.planets.find((p) => p.name === target.name);
      return body ? { azDeg: body.azDeg, elDeg: body.elDeg } : null;
    }
    case 'satellite': {
      const hit = sources.satellite?.(target.id);
      return hit && Number.isFinite(hit.azDeg) && Number.isFinite(hit.elDeg)
        ? { azDeg: hit.azDeg, elDeg: hit.elDeg }
        : null;
    }
    default:
      return null;
  }
}

/**
 * Search provider over the satellite engine (satSky.createSatSky):
 * names from satSky.meta (every loaded object, also those below the
 * horizon), positions from satSky.lookup (the newest worker row; null when
 * the object is below -2 deg or not computed yet). Ties keep catalogue
 * order, so the core groups (stations first: ISS) win over ACTIVE/STARLINK.
 * positionOf(id) (optional) overrides the position, e.g. with the same
 * extrapolated az/el the satellite overlay draws, so the marker sits on it.
 */
export function satelliteSearchProvider(
  satSky,
  { limit = MAX_RESULTS, positionOf = null } = {},
) {
  let foldedFor = null;
  let folded = [];
  const keys = () => {
    const meta = satSky?.meta || [];
    if (foldedFor !== meta) {
      folded = meta.map((m) => fold(m?.name));
      foldedFor = meta;
    }
    return folded;
  };
  return {
    get status() {
      return satSky?.status ?? 'unavailable';
    },
    search(query) {
      const q = fold(query);
      if (!q) return [];
      const meta = satSky?.meta || [];
      const names = keys();
      const hits = [];
      for (let i = 0; i < names.length; i++) {
        const score = foldedScore(names[i], q);
        if (score == null) continue;
        hits.push({ id: i, name: meta[i].name, score });
      }
      hits.sort((a, b) => a.score - b.score || a.id - b.id);
      return hits.slice(0, limit).map(({ id, name }) => ({ id, name }));
    },
    position(id) {
      if (typeof positionOf === 'function') return positionOf(id);
      const row = satSky?.lookup?.(id)?.row;
      return row && Number.isFinite(row.azDeg) && Number.isFinite(row.elDeg)
        ? { azDeg: row.azDeg, elDeg: row.elDeg }
        : null;
    },
  };
}

/** Eased view between two views (az the short way round), f in 0..1. */
export function lookAtView(from, to, f) {
  const t = Math.min(1, Math.max(0, f));
  const e = t * t * (3 - 2 * t);
  let dAz = normalizeAz(to.azDeg) - normalizeAz(from.azDeg);
  if (dAz > 180) dAz -= 360;
  if (dAz < -180) dAz += 360;
  return makeView({
    ...from,
    azDeg: from.azDeg + dAz * e,
    elDeg: from.elDeg + (to.elDeg - from.elDeg) * e,
    fovDeg: to.fovDeg ?? from.fovDeg,
  });
}
