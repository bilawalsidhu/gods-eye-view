/**
 * A synthetic peak-day Fire Perimeters snapshot (the
 * `createFirePerimetersLayer` contract), for timing the layer's redraws.
 *
 * Shaped like a busy day in the western US: about 1000 pieces of 160 fires,
 * each piece the next growth ring of its fire cut into 47 sectors of 17
 * vertices (about 0.8 million vertices in all), its fire line along the
 * ring's outer edge. Pieces are born over the 3 days before `start` and on
 * at the same rate after it. A snapshot at `at` lists every piece born by
 * then.
 */

import { rng } from '../../src/testSupport/rng.mjs';

const HOUR_MS = 3600000;

/** `[lon, lat]` at `km` from a centre, toward `angle` (radians from east). */
function offset(lon, lat, km, angle) {
  const dLat = (km / 111.2) * Math.sin(angle);
  const dLon =
    ((km / 111.2) * Math.cos(angle)) / Math.cos((lat * Math.PI) / 180);
  return [lon + dLon, lat + dLat];
}

/**
 * One growth ring of a fire, between `inner` and `outer` km from its
 * centre, as `sectors` polygons of `2 * (arc + 1) + 1` vertices each, and
 * the fire line along its outer edge.
 */
function growthRing(next, fire, inner, outer, sectors, arc) {
  const polygons = [];
  const outline = [];
  const wobble = () => 0.9 + 0.2 * next();
  for (let k = 0; k < sectors; k++) {
    const from = (2 * Math.PI * k) / sectors;
    const to = (2 * Math.PI * (k + 1)) / sectors;
    const outerArc = [];
    const innerArc = [];
    for (let i = 0; i <= arc; i++) {
      const angle = from + ((to - from) * i) / arc;
      outerArc.push(offset(fire.lon, fire.lat, outer * wobble(), angle));
      innerArc.push(offset(fire.lon, fire.lat, inner, angle));
    }
    const ring = [...innerArc, ...outerArc.toReversed()];
    ring.push(ring[0]);
    polygons.push([ring]);
    outline.push(outerArc);
  }
  return { polygons, outline };
}

/**
 * The peak day's fires and every piece they grow: `pieces` of them born in
 * the `spanHours` before `start`, and at the same hourly rate for
 * `afterHours` after it.
 */
export function perimeterPeak({
  seed = 1,
  start = Date.UTC(2026, 7, 20, 18),
  fires: fireCount = 160,
  pieces: pieceCount = 1000,
  spanHours = 72,
  afterHours = 12,
  sectorsPerPiece = 47,
  arcVertices = 7,
} = {}) {
  const next = rng(seed);
  const fires = [];
  for (let i = 0; i < fireCount; i++) {
    const lon = -124 + 20 * next();
    const lat = 32 + 16 * next();
    fires.push({
      id: `PEAK-${String(i).padStart(4, '0')}`,
      name: `Peak Fire ${i}`,
      acres: Math.round(100 + 50000 * next()),
      containedPct: Math.round(100 * next()),
      state: 'US-CA',
      discoveredTime: start - spanHours * HOUR_MS,
      updatedTime: start,
      anchor: { lon, lat },
    });
  }
  const total = Math.round(pieceCount * (1 + afterHours / spanHours));
  const pieces = [];
  // Each fire's area so far, km from its centre: a piece is its next ring.
  const reach = new Map();
  for (let i = 0; i < total; i++) {
    const fire = fires[Math.floor(next() * fires.length)];
    const born = Math.round(
      start -
        spanHours * HOUR_MS +
        ((i + next()) / pieceCount) * spanHours * HOUR_MS,
    );
    const inner = reach.get(fire.id) ?? 0.5;
    const outer = inner + 0.5 + 1.5 * next();
    reach.set(fire.id, outer);
    const { polygons, outline } = growthRing(
      next,
      fire.anchor,
      inner,
      outer,
      sectorsPerPiece,
      arcVertices,
    );
    pieces.push({
      id: `${fire.id}|${born}`,
      fireId: fire.id,
      born,
      polygons,
      outline,
    });
  }
  pieces.sort((a, b) => a.born - b.born);
  return { start, fires, pieces };
}

/**
 * The snapshot at `at`: every piece born by then. `ids: false` leaves out
 * `pieces[].id`, as a source that has none.
 */
export function peakSnapshot(peak, at, { ids = true } = {}) {
  const pieces = [];
  const grown = new Map();
  for (const piece of peak.pieces) {
    if (piece.born > at) break;
    grown.set(piece.fireId, piece.born);
    if (ids) pieces.push(piece);
    else {
      const { id, ...rest } = piece;
      pieces.push(rest);
    }
  }
  return {
    at,
    fetchedAt: at,
    stale: false,
    revision: `peak:${pieces.length}`,
    note: null,
    fires: peak.fires.map((fire) => ({
      ...fire,
      lastGrowthTime: grown.get(fire.id) ?? null,
    })),
    pieces,
  };
}

/** Vertices in a snapshot's fills and in its outlines. */
export function peakVertices(snapshot) {
  let fills = 0;
  let lines = 0;
  let polygons = 0;
  for (const piece of snapshot.pieces) {
    for (const rings of piece.polygons) {
      polygons += 1;
      for (const r of rings) fills += r.length;
    }
    for (const line of piece.outline) lines += line.length;
  }
  return { pieces: snapshot.pieces.length, polygons, fills, lines };
}
