/**
 * @file Cordon analysis — pure logic.
 *
 * A town's administrative boundary induces a cut of the OSM road graph: every
 * drivable way that crosses the boundary is an entry gate. This module finds
 * those gates, merges split carriageways, and marks each gate covered when a
 * mapped ALPR camera sits within {@link CORDON_COVERAGE_M} of that road's
 * polyline. The result is a coverage share ("7 of 12 entries pass a reader")
 * with the uncovered gates called out as gaps.
 *
 * Honest limits, stated wherever the numbers surface:
 *  - Mapped cameras are a floor (a volunteer found them), never a registry —
 *    an "uncovered" gate may still carry an unmapped reader.
 *  - Coverage is per entry road near the boundary; a reader deep inside town
 *    past the first junction does not monitor that entry and is not counted.
 *  - Geometry is planar-approximate (equirectangular), which is exact enough
 *    at the town scale the bbox cap enforces.
 *
 * Pure and Cesium-free so every rule is pinnable in Node tests.
 */

import {
  CORDON_COVERAGE_M,
  CORDON_MERGE_M,
  CORDON_ROADS_LIMIT,
} from './policy.js';

/** Drivable entry classes; service/track/path traffic is not a town entry. */
export const CORDON_ROAD_CLASS_RE =
  /^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$/;

/** Classes reported separately as "majors" — the entries most traffic uses. */
const MAJOR_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary']);

const M_PER_DEG_LAT = 111320;

/** Overpass QL for candidate entry roads in the padded boundary bbox. */
export function buildCordonRoadsQuery(box) {
  return (
    `[out:json][timeout:25];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)(_link)?$"]` +
    `(${box.south},${box.west},${box.north},${box.east});out geom ${CORDON_ROADS_LIMIT};`
  );
}

/** Map an Overpass `out geom` payload to plain road records; null for junk. */
export function normalizeCordonRoads(payload) {
  const roads = [];
  for (const element of payload?.elements || []) {
    if (element?.type !== 'way' || !Array.isArray(element.geometry)) continue;
    const cls = String(element.tags?.highway || '');
    const match = CORDON_ROAD_CLASS_RE.exec(cls);
    if (!match) continue;
    const points = element.geometry.filter(
      (p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon),
    );
    if (points.length < 2) continue;
    roads.push({
      id: element.id,
      name: element.tags?.name?.trim() || null,
      ref: element.tags?.ref?.trim() || null,
      cls,
      baseCls: match[1],
      points,
    });
  }
  return roads;
}

/**
 * Order the `is_in` admin areas by cordon suitability: a municipality
 * (admin_level 8) first, then more local (9), then broader (7), county (6)
 * last. Ids break ties so every Overpass mirror yields the same choice.
 */
export function pickCordonBoundary(elements) {
  const LEVEL_PREFERENCE = [8, 9, 7, 6];
  const candidates = (elements || []).filter(
    (el) =>
      el?.type === 'area' &&
      el.tags?.boundary === 'administrative' &&
      el.tags?.name &&
      LEVEL_PREFERENCE.includes(Number(el.tags.admin_level)) &&
      Number.isSafeInteger(el.id),
  );
  return candidates
    .sort(
      (a, b) =>
        LEVEL_PREFERENCE.indexOf(Number(a.tags.admin_level)) -
          LEVEL_PREFERENCE.indexOf(Number(b.tags.admin_level)) || a.id - b.id,
    )
    .map((el) => ({
      id: el.id,
      name: el.tags.name,
      level: Number(el.tags.admin_level),
    }));
}

/**
 * Chain a boundary relation's outer ways into one [lon, lat] ring by matching
 * endpoints (admin boundaries split their outline across many ways). A
 * disjoint remainder (islands, exclaves) is dropped — the main ring wins.
 */
export function stitchOuterRing(relationElement) {
  const ways = (relationElement?.members || [])
    .filter((m) => (m.role === 'outer' || !m.role) && Array.isArray(m.geometry))
    .map((m) =>
      m.geometry
        .filter((p) => Number.isFinite(p?.lat) && Number.isFinite(p?.lon))
        .map((p) => [p.lon, p.lat]),
    )
    .filter((way) => way.length >= 2);
  if (!ways.length) return [];
  const key = (p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`;
  const ring = ways.shift();
  let guard = ways.length + 1;
  while (ways.length && guard-- > 0) {
    const tail = key(ring[ring.length - 1]);
    const index = ways.findIndex(
      (way) => key(way[0]) === tail || key(way[way.length - 1]) === tail,
    );
    if (index === -1) break;
    const way = ways.splice(index, 1)[0];
    const segment = key(way[0]) === tail ? way : [...way].reverse();
    ring.push(...segment.slice(1));
  }
  return ring;
}

/** Bounding box of a [lon, lat] ring. */
export function ringBox(ring) {
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const [lon, lat] of ring) {
    if (lat < south) south = lat;
    if (lat > north) north = lat;
    if (lon < west) west = lon;
    if (lon > east) east = lon;
  }
  return { south, west, north, east };
}

/** Ray-cast containment; ring is [lon, lat] pairs, open or closed. */
export function cordonPointInRing(ring, lat, lon) {
  if (!Array.isArray(ring) || ring.length < 3) return false;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects =
      yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

/** Planar segment intersection in degree space; points are [lon, lat]. */
function segmentIntersection(a, b, c, d) {
  const r = [b[0] - a[0], b[1] - a[1]];
  const s = [d[0] - c[0], d[1] - c[1]];
  const denominator = r[0] * s[1] - r[1] * s[0];
  if (!denominator) return null;
  const t = ((c[0] - a[0]) * s[1] - (c[1] - a[1]) * s[0]) / denominator;
  const u = ((c[0] - a[0]) * r[1] - (c[1] - a[1]) * r[0]) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, point: [a[0] + t * r[0], a[1] + t * r[1]] };
}

/**
 * Where a road's polyline crosses the ring: every segment×boundary
 * intersection, in order along the road. Intersecting each segment directly
 * (rather than watching inside/outside transitions between nodes) also
 * catches a long sparse segment that passes clear THROUGH a small town —
 * both of its nodes are outside, yet it enters and leaves. A boundary vertex
 * shared by two ring edges counts once; a transition segment whose planar
 * intersection degenerates (collinear overlap) falls back to its midpoint.
 */
export function ringCrossings(ring, points) {
  const crossings = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = [points[i - 1].lon, points[i - 1].lat];
    const b = [points[i].lon, points[i].lat];
    const hits = [];
    for (let j = 0; j < ring.length; j += 1) {
      const hit = segmentIntersection(
        a,
        b,
        ring[j],
        ring[(j + 1) % ring.length],
      );
      if (hit) hits.push(hit);
    }
    hits.sort((first, second) => first.t - second.t);
    let lastT = -Infinity;
    for (const hit of hits) {
      if (hit.t - lastT < 1e-9) continue;
      lastT = hit.t;
      crossings.push({ lat: hit.point[1], lon: hit.point[0] });
    }
    if (!hits.length) {
      const insideA = cordonPointInRing(ring, a[1], a[0]);
      const insideB = cordonPointInRing(ring, b[1], b[0]);
      if (insideA !== insideB)
        crossings.push({ lat: (a[1] + b[1]) / 2, lon: (a[0] + b[0]) / 2 });
    }
  }
  return crossings;
}

function distanceM(aLat, aLon, bLat, bLon) {
  const kx = Math.cos(((aLat + bLat) / 2) * (Math.PI / 180)) * M_PER_DEG_LAT;
  const dx = (bLon - aLon) * kx;
  const dy = (bLat - aLat) * M_PER_DEG_LAT;
  return Math.hypot(dx, dy);
}

function pointToSegmentM(pLat, pLon, aLat, aLon, bLat, bLon) {
  const kx = Math.cos(aLat * (Math.PI / 180)) * M_PER_DEG_LAT;
  const px = (pLon - aLon) * kx;
  const py = (pLat - aLat) * M_PER_DEG_LAT;
  const bx = (bLon - aLon) * kx;
  const by = (bLat - aLat) * M_PER_DEG_LAT;
  const lengthSq = bx * bx + by * by;
  const t = lengthSq
    ? Math.max(0, Math.min(1, (px * bx + py * by) / lengthSq))
    : 0;
  return Math.hypot(px - t * bx, py - t * by);
}

/** Nearest camera-to-polyline distance in meters (Infinity when none near). */
export function nearestCameraToRoadM(cameras, points) {
  // Bbox prefilter: ~1.1 km pad comfortably exceeds any sane coverage radius,
  // so the per-segment loop only ever sees the handful of nearby cameras.
  const PAD_DEG = 0.01;
  let south = 90;
  let north = -90;
  let west = 180;
  let east = -180;
  for (const p of points) {
    if (p.lat < south) south = p.lat;
    if (p.lat > north) north = p.lat;
    if (p.lon < west) west = p.lon;
    if (p.lon > east) east = p.lon;
  }
  let best = Infinity;
  for (const camera of cameras) {
    if (
      camera.latitude < south - PAD_DEG ||
      camera.latitude > north + PAD_DEG ||
      camera.longitude < west - PAD_DEG ||
      camera.longitude > east + PAD_DEG
    )
      continue;
    for (let i = 1; i < points.length; i += 1) {
      const d = pointToSegmentM(
        camera.latitude,
        camera.longitude,
        points[i - 1].lat,
        points[i - 1].lon,
        points[i].lat,
        points[i].lon,
      );
      if (d < best) best = d;
    }
  }
  return best;
}

/**
 * Merge same-road crossings closer than mergeRadiusM (dual carriageways,
 * split junctions). Roads with different names never merge; unnamed
 * crossings merge only within the same base class. A merged gate is covered
 * when ANY of its parts is.
 */
export function dedupeCrossings(crossings, mergeRadiusM = CORDON_MERGE_M) {
  const merged = [];
  for (const crossing of crossings) {
    const identity = (crossing.name || crossing.ref || '').toLowerCase();
    const near = merged.find(
      (gate) =>
        (gate.name || gate.ref || '').toLowerCase() === identity &&
        gate.baseCls === crossing.baseCls &&
        distanceM(gate.lat, gate.lon, crossing.lat, crossing.lon) <=
          mergeRadiusM,
    );
    if (near) {
      near.covered = near.covered || crossing.covered;
      near.nearestCameraM = Math.min(
        near.nearestCameraM,
        crossing.nearestCameraM,
      );
    } else {
      merged.push({ ...crossing });
    }
  }
  return merged;
}

/**
 * The cordon: every gate where a drivable road crosses the boundary ring,
 * with per-gate coverage and honest totals.
 *
 * @param {object} input
 * @param {Array<[number,number]>} input.ring - boundary as [lon, lat] pairs
 * @param {Array<object>} input.roads - normalizeCordonRoads() output
 * @param {Array<object>} input.cameras - ALPR records (latitude/longitude)
 * @returns {{gates: Array<object>, stats: object}}
 */
export function computeCordon({
  ring,
  roads,
  cameras,
  coverageRadiusM = CORDON_COVERAGE_M,
  mergeRadiusM = CORDON_MERGE_M,
}) {
  const raw = [];
  for (const road of roads) {
    const crossings = ringCrossings(ring, road.points);
    if (!crossings.length) continue;
    const nearestCameraM = nearestCameraToRoadM(cameras, road.points);
    const covered = nearestCameraM <= coverageRadiusM;
    for (const point of crossings) {
      raw.push({
        lat: point.lat,
        lon: point.lon,
        name: road.name,
        ref: road.ref,
        baseCls: road.baseCls,
        covered,
        nearestCameraM,
      });
    }
  }
  const gates = dedupeCrossings(raw, mergeRadiusM);
  const covered = gates.filter((gate) => gate.covered).length;
  const majors = gates.filter((gate) => MAJOR_CLASSES.has(gate.baseCls));
  const byClass = {};
  for (const gate of gates) {
    byClass[gate.baseCls] ??= { total: 0, covered: 0 };
    byClass[gate.baseCls].total += 1;
    if (gate.covered) byClass[gate.baseCls].covered += 1;
  }
  return {
    gates,
    stats: {
      total: gates.length,
      covered,
      share: gates.length ? covered / gates.length : 0,
      majors: {
        total: majors.length,
        covered: majors.filter((gate) => gate.covered).length,
      },
      byClass,
    },
  };
}
