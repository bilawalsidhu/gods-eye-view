import { EARTH_RADIUS_KM, greatCircleKm } from '../geoDistance.js';
import {
  CONTEXT_AREA,
  CONTEXT_FEATURE,
  CONTEXT_LINES,
  footprintGroundDistance,
  unitVector,
} from '../data/contextGeometry.js';
import { preparedContextArea, recordPosition } from '../data/entityContext.js';
import { formatNumber, t } from '../i18n/index.js';

const RAD = Math.PI / 180;
const GLOBE_KM = 5000;
const CITY_KM = 50;
const HYSTERESIS = 0.15;

const longitude = (lon) => ((((lon + 180) % 360) + 360) % 360) - 180;
const longitudeSpan = ({ west, east }) =>
  east >= west ? east - west : 360 + east - west;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function inspectorScopeLabel(scope, radius, item) {
  if (item && scope === 'none') return t('None nearby');
  if (item && scope === 'closest') return t('Closest to {item}', { item });
  if (item && scope === 'nearby')
    return t('Within {n} km of {item}', { n: formatNumber(radius), item });
  if (scope === 'total') return t('Total', { context: 'Inspector scope' });
  if (scope === 'loaded') return t('Loaded', { context: 'Inspector scope' });
  if (scope === 'closest') return t('Closest to view');
  if (scope === 'none') return t('None in view');
  if (scope === 'nearest') return t('In view · nearest 3');
  if (scope === 'overhead')
    return t('Overhead within {n} km', { n: formatNumber(radius) });
  if (scope === 'nearby')
    return t('Within {n} km', { n: formatNumber(radius) });
  return scope === 'view' ? t('In view', { context: 'Inspector scope' }) : '';
}

function bandAbove(value, edge, previous) {
  if (previous == null) return value >= edge;
  return previous
    ? value >= edge * (1 - HYSTERESIS)
    : value >= edge * (1 + HYSTERESIS);
}

/** At a tilt, ground distance influences scale without turning a low view into a high one. */
export function inspectorViewScale(view) {
  const height = Math.max(0, (view.heightM || 0) / 1000);
  const ground = view.eye ? greatCircleKm(view.eye, view.center) : 0;
  return Math.sqrt(height * Math.hypot(height, ground));
}

export function inspectorViewTier(view, previous) {
  const scale = inspectorViewScale(view);
  return {
    globe: bandAbove((view.heightM || 0) / 1000, GLOBE_KM, previous?.globe),
    city: previous
      ? !bandAbove(scale, CITY_KM, !previous.city)
      : scale <= CITY_KM,
  };
}

export function inspectorFootprintSpan(rect) {
  if (!rect) return 0;
  const midLat = (rect.north + rect.south) / 2;
  return (
    RAD *
    EARTH_RADIUS_KM *
    Math.max(
      rect.north - rect.south,
      longitudeSpan(rect) * Math.cos(midLat * RAD),
    )
  );
}

/** Conservative geographic bounds for points within a spherical distance of a rectangle. */
export function expandInspectorBounds(rect, km) {
  const phi = km / EARTH_RADIUS_KM / RAD;
  const south = clamp(rect.south - phi, -90, 90);
  const north = clamp(rect.north + phi, -90, 90);
  const poleward = Math.max(Math.abs(south), Math.abs(north));
  const ratio = Math.sin(phi * RAD) / Math.cos(poleward * RAD);
  const delta = poleward >= 90 || ratio >= 1 ? 180 : Math.asin(ratio) / RAD;
  if (longitudeSpan(rect) + delta * 2 >= 360)
    return { west: -180, east: 180, south, north };
  return {
    west: longitude(rect.west - delta),
    east: longitude(rect.east + delta),
    south,
    north,
  };
}

export function inspectorPointBounds(at, km) {
  return expandInspectorBounds(
    { west: at.lon, east: at.lon, south: at.lat, north: at.lat },
    km,
  );
}

/** Shortest spherical distance to the footprint, including its wrapped meridians. */
export function distanceToInspectorBounds({ lat, lon }, rect) {
  const insideLon =
    (longitude(lon - rect.west) + 360) % 360 <= longitudeSpan(rect);
  if (insideLon)
    return greatCircleKm(
      { lat, lon },
      { lat: clamp(lat, rect.south, rect.north), lon },
    );

  const edge = (meridian) => {
    const delta = longitude(lon - meridian) * RAD;
    const nearest =
      Math.atan2(Math.sin(lat * RAD), Math.cos(lat * RAD) * Math.cos(delta)) /
      RAD;
    return greatCircleKm(
      { lat, lon },
      { lat: clamp(nearest, rect.south, rect.north), lon: meridian },
    );
  };
  return Math.min(edge(rect.west), edge(rect.east));
}

/** Choose the actual visible ground edge when the renderer supplies it. */
export function inspectorGroundDistance(view, rect, hemisphere) {
  const eye =
    Number.isFinite(view.eye?.lat) && Number.isFinite(view.eye?.lon)
      ? view.eye
      : view.center;
  if (hemisphere) {
    const horizon =
      Number.isFinite(view.heightM) && view.heightM > 0
        ? EARTH_RADIUS_KM / (EARTH_RADIUS_KM + view.heightM / 1000)
        : 0;
    const limbKm = EARTH_RADIUS_KM * Math.acos(horizon);
    return (at) => Math.max(0, greatCircleKm(eye, at) - limbKm);
  }
  return (
    footprintGroundDistance(view.corners, eye, view.heightM) ??
    ((at) => distanceToInspectorBounds(at, rect))
  );
}

const hasGeometry = (point) =>
  Boolean(
    point?.[CONTEXT_AREA] || point?.[CONTEXT_LINES] || point?.parts?.length,
  );

export function inspectorPointRecord(point) {
  const feature = point?.[CONTEXT_FEATURE];
  return !hasGeometry(point) && (!feature || feature.geometryType === 'Point');
}

const FINE = 10;
const cellScale = (bounds) =>
  bounds.every(
    (rect) => longitudeSpan(rect) <= 5 && rect.north - rect.south <= 5,
  )
    ? FINE
    : 1;
const cellKey = (x, y) => y * 360 * FINE + x;
const cellIndex = (value, offset, scale, max) =>
  clamp(Math.floor((value + offset) * scale), 0, max * scale - 1);

function addToCell(cells, key, point) {
  const cell = cells.get(key);
  if (cell) cell.push(point);
  else cells.set(key, [point]);
}

function* cellsInBounds(cells, rect, scale) {
  const minY = cellIndex(rect.south, 90, scale, 180);
  const maxY = cellIndex(rect.north, 90, scale, 180);
  const west = cellIndex(rect.west, 180, scale, 360);
  const east = cellIndex(rect.east, 180, scale, 360);
  const maxX = 360 * scale - 1;
  const ranges =
    rect.west <= rect.east
      ? [[west, east]]
      : [
          [west, maxX],
          // Both edges of a nearly global viewport can fall in the same cell.
          [0, Math.min(east, west - 1)],
        ];
  for (let y = minY; y <= maxY; y++)
    for (const [start, end] of ranges)
      for (let x = start; x <= end; x++) {
        const cell = cells.get(cellKey(x, y));
        if (cell) yield cell;
      }
}

// Include every position the exact reader can use: the record anchor, isolated
// parts, drawn paths and polygon interiors. Wrapped paths have conservative bounds.
function geometryBounds(point, anchor) {
  let west = Infinity,
    east = -Infinity,
    south = Infinity,
    north = -Infinity;
  function include(w, s, e, n) {
    if (!(w <= e && s <= n)) return;
    west = Math.min(west, w);
    east = Math.max(east, e);
    south = Math.min(south, s);
    north = Math.max(north, n);
  }
  if (anchor) include(anchor.lon, anchor.lat, anchor.lon, anchor.lat);
  for (const part of point.parts ?? []) {
    const at = recordPosition(part);
    if (at) include(at.lon, at.lat, at.lon, at.lat);
  }
  for (const path of point[CONTEXT_LINES] ?? []) {
    const b = path.bounds;
    include(b.west, b.south, b.east, b.north);
  }
  if (point[CONTEXT_AREA])
    for (const part of preparedContextArea(point[CONTEXT_AREA])?.parts ?? [])
      include(...part.bbox);
  if (west <= -180 || east >= 180) {
    west = -180;
    east = 180;
  }
  return { west, east, south, north };
}

function overlapsGeometry(box, rect) {
  return (
    box.south <= rect.north &&
    box.north >= rect.south &&
    (rect.west <= rect.east
      ? box.west <= rect.east && box.east >= rect.west
      : box.east >= rect.west || box.west <= rect.east)
  );
}

/** Built from a layer snapshot. Geometry is retained for the existing intersection reader. */
export function createInspectorSpatialIndex() {
  const coarse = new Map();
  const fine = new Map();
  const geometry = [];
  // Use larger cells for wide features so one long path cannot fill the fine grid.
  const geometryGrids = new Map();
  const positions = new WeakMap();
  let count = 0;
  function* positionCells(bounds) {
    const scale = cellScale(bounds);
    const cells = scale === FINE ? fine : coarse;
    const seen = bounds.length > 1 ? new Set() : null;
    for (const rect of bounds)
      for (const cell of cellsInBounds(cells, rect, scale)) {
        if (seen?.has(cell)) continue;
        seen?.add(cell);
        yield cell;
      }
  }

  return {
    positionOf(point) {
      return positions.get(point);
    },
    get pointOnly() {
      return geometry.length === 0;
    },
    get count() {
      return count;
    },
    add(point) {
      const at = recordPosition(point);
      if (hasGeometry(point)) {
        const box = geometryBounds(point, at);
        const entry = { point, box, order: geometry.length };
        geometry.push(entry);
        if (box.west <= box.east && box.south <= box.north) {
          const span = Math.max(box.east - box.west, box.north - box.south);
          const scale = span <= 1 ? 1 : span <= 10 ? 0.1 : 1 / 90;
          if (!geometryGrids.has(scale)) geometryGrids.set(scale, new Map());
          const grid = geometryGrids.get(scale);
          for (
            let y = cellIndex(box.south, 90, scale, 180);
            y <= cellIndex(box.north, 90, scale, 180);
            y++
          )
            for (
              let x = cellIndex(box.west, 180, scale, 360);
              x <= cellIndex(box.east, 180, scale, 360);
              x++
            )
              addToCell(grid, cellKey(x, y), entry);
        }
        count++;
        return;
      }
      if (!at) return;
      unitVector(at.lat, at.lon, at);
      at.point = point;
      positions.set(point, at);
      const lon = at.lon === 180 ? at.lon : longitude(at.lon);
      const x = cellIndex(lon, 180, FINE, 360);
      const y = cellIndex(at.lat, 90, FINE, 180);
      addToCell(fine, cellKey(x, y), at);
      addToCell(
        coarse,
        cellKey(Math.floor(x / FINE), Math.floor(y / FINE)),
        at,
      );
      count++;
    },
    positionCells,
    /** The equatorial diagonal bounds the distance between any two points in a cell. */
    *cellsByDistance(bounds, distance) {
      const cellKm =
        (Math.SQRT2 * Math.PI * EARTH_RADIUS_KM) / (180 * cellScale(bounds)) +
        0.01;
      const ordered = Array.from(positionCells(bounds), (cell) => ({
        cell,
        minKm: Math.max(0, distance(cell[0]) - cellKm),
      }));
      ordered.sort((a, b) => a.minKm - b.minKm);
      yield* ordered;
    },
    *points(bounds) {
      for (const cell of positionCells(bounds))
        for (const at of cell) yield at.point;
      if (!geometry.length) return;
      if (
        bounds.some(
          (r) =>
            r.west === -180 &&
            r.east === 180 &&
            r.south === -90 &&
            r.north === 90,
        )
      ) {
        for (const entry of geometry) yield entry.point;
        return;
      }
      const matches = new Set();
      for (const rect of bounds)
        for (const [scale, grid] of geometryGrids)
          for (const cell of cellsInBounds(grid, rect, scale))
            for (const entry of cell)
              if (overlapsGeometry(entry.box, rect)) matches.add(entry);
      // Preserve source order, including ties and features present in multiple cells.
      for (const entry of [...matches].sort((a, b) => a.order - b.order))
        yield entry.point;
    },
  };
}

/** Load each feed version outside UI reads, and give up promptly when its panel closes. */
export function createInspectorIndexCache({ shown, changed }) {
  const entries = new Map();
  function stop(entry) {
    clearTimeout(entry.timer);
    entry.timer = null;
  }

  function invalidate(id) {
    const entry = entries.get(id);
    if (entry) stop(entry);
    entries.delete(id);
  }

  function retain(ids) {
    for (const id of entries.keys()) if (!ids.has(id)) invalidate(id);
  }

  function indexFor(id, version, read) {
    const previous = entries.get(id);
    if (
      previous?.version === version &&
      (!previous.failed || Date.now() < previous.retryAt)
    )
      return previous;
    if (previous) stop(previous);
    const current = { version, timer: null, ready: false, failed: false };
    entries.set(id, current);
    const index = createInspectorSpatialIndex();
    let iterator;
    function build() {
      current.timer = null;
      if (!shown() || entries.get(id) !== current) {
        if (entries.get(id) === current) entries.delete(id);
        return;
      }
      try {
        if (!iterator) {
          const { points, source } = read();
          current.source = source;
          iterator = points[Symbol.iterator]();
        }
        const started = performance.now();
        for (let n = 0; n < 2048; n++) {
          const item = iterator.next();
          if (item.done) {
            current.index = index;
            current.ready = true;
            changed();
            return;
          }
          index.add(item.value);
          if ((n & 63) === 63 && performance.now() - started >= 2) break;
        }
        current.timer = setTimeout(build, 0);
      } catch {
        current.failed = true;
        current.retryAt = Date.now() + 4000;
        current.ready = true;
        changed();
      }
    }
    current.timer = setTimeout(build, 0);
    return current;
  }

  return {
    indexFor,
    invalidate,
    retain,
    suspend() {
      for (const [id, entry] of entries) {
        if (entry.ready) continue;
        stop(entry);
        entries.delete(id);
      }
    },
  };
}
