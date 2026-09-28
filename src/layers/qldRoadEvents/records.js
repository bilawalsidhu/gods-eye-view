/**
 * Normalize the QLDTraffic v2 events feed into compact, render-ready records.
 *
 * Pure and shared by the Node proxy (which normalizes before caching) and the
 * tests. Individually invalid features are skipped: one degenerate event must
 * never blank the layer. Only a payload that is not a feature collection at all
 * rejects the whole snapshot.
 *
 * Coordinates arrive in EPSG:7844 (GDA2020), which is within about 1.5 m of
 * WGS84 and is used as-is. Line work is simplified and capped so a handful of
 * long highway closures cannot dominate the payload or the renderer.
 */

export const QLD_ROAD_EVENT_CATEGORIES = Object.freeze([
  'crash',
  'flooding',
  'hazard',
  'congestion',
  'special-event',
  'roadworks',
  'other',
]);

/** Upper bounds that keep one snapshot small enough to refresh continuously. */
export const QLD_ROAD_EVENT_LIMITS = Object.freeze({
  events: 3000,
  linesPerEvent: 64,
  pointsPerEvent: 16,
  verticesPerLine: 200,
  verticesPerEvent: 600,
  totalVertices: 60_000,
  geometryDepth: 2,
});

// ~11 m at Queensland latitudes: invisible at road-network zoom, and it cuts
// the feed's densely digitized curves by an order of magnitude.
const SIMPLIFY_TOLERANCE_DEG = 0.0001;
const COORDINATE_DECIMALS = 1e5;
const TEXT_LIMIT = 600;
const LABEL_LIMIT = 160;

const CATEGORY_BY_TYPE = new Map([
  ['crash', 'crash'],
  ['flooding', 'flooding'],
  ['hazard', 'hazard'],
  ['congestion', 'congestion'],
  ['special event', 'special-event'],
  ['roadworks', 'roadworks'],
]);

/** Map a QLDTraffic `event_type` to one of QLD_ROAD_EVENT_CATEGORIES. */
export function qldRoadEventCategory(eventType) {
  if (typeof eventType !== 'string') return 'other';
  return (
    CATEGORY_BY_TYPE.get(eventType.trim().toLowerCase().replace(/\s+/g, ' ')) ||
    'other'
  );
}

/** Trimmed display text with control characters removed; null when empty or N/A. */
function text(value, limit = TEXT_LIMIT) {
  if (typeof value !== 'string') return null;
  const clean = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean || /^n\/?a$/i.test(clean)) return null;
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function timeMs(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

function position(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const [lon, lat] = value;
  if (
    typeof lon !== 'number' ||
    typeof lat !== 'number' ||
    !Number.isFinite(lon) ||
    !Number.isFinite(lat) ||
    Math.abs(lon) > 180 ||
    Math.abs(lat) > 90
  )
    return null;
  return [
    Math.round(lon * COORDINATE_DECIMALS) / COORDINATE_DECIMALS,
    Math.round(lat * COORDINATE_DECIMALS) / COORDINATE_DECIMALS,
  ];
}

/** Valid, rounded positions with consecutive duplicates removed. */
function cleanLine(value) {
  if (!Array.isArray(value)) return [];
  const line = [];
  for (const raw of value) {
    const next = position(raw);
    if (!next) continue;
    const last = line.at(-1);
    if (last && last[0] === next[0] && last[1] === next[1]) continue;
    line.push(next);
  }
  return line;
}

function segmentDistanceSq(point, start, end) {
  const dx = end[0] - start[0];
  const dy = end[1] - start[1];
  const lengthSq = dx * dx + dy * dy;
  let t = 0;
  if (lengthSq > 0)
    t = Math.max(
      0,
      Math.min(
        1,
        ((point[0] - start[0]) * dx + (point[1] - start[1]) * dy) / lengthSq,
      ),
    );
  const x = start[0] + t * dx - point[0];
  const y = start[1] + t * dy - point[1];
  return x * x + y * y;
}

/**
 * Douglas–Peucker simplification (iterative, so a long line cannot overflow
 * the stack), then an even decimation down to `maxVertices` that always keeps
 * both endpoints.
 * @param {Array<[number, number]>} line - Cleaned positions.
 * @param {number} [tolerance] - Planar tolerance in degrees.
 * @param {number} [maxVertices] - Hard vertex cap (at least 2).
 * @returns {Array<[number, number]>}
 */
export function simplifyQldRoadEventLine(
  line,
  tolerance = SIMPLIFY_TOLERANCE_DEG,
  maxVertices = QLD_ROAD_EVENT_LIMITS.verticesPerLine,
) {
  if (!Array.isArray(line) || line.length <= 2) return line ? [...line] : [];
  const keep = new Uint8Array(line.length);
  keep[0] = 1;
  keep[line.length - 1] = 1;
  const toleranceSq = tolerance * tolerance;
  const stack = [[0, line.length - 1]];
  while (stack.length) {
    const [first, last] = stack.pop();
    let farthest = -1;
    let farthestSq = toleranceSq;
    for (let i = first + 1; i < last; i++) {
      const distanceSq = segmentDistanceSq(line[i], line[first], line[last]);
      if (distanceSq > farthestSq) {
        farthestSq = distanceSq;
        farthest = i;
      }
    }
    if (farthest !== -1) {
      keep[farthest] = 1;
      stack.push([first, farthest], [farthest, last]);
    }
  }
  const simplified = line.filter((_, index) => keep[index]);
  const cap = Math.max(2, Math.floor(maxVertices));
  if (simplified.length <= cap) return simplified;
  const step = (simplified.length - 1) / (cap - 1);
  return Array.from(
    { length: cap },
    (_, index) => simplified[Math.round(index * step)],
  );
}

/**
 * Flatten any GeoJSON geometry into marker points and polylines. Polygon rings
 * become outlines. Returns null when nothing drawable survives.
 * @param {object} geometry - GeoJSON geometry (EPSG:7844 or WGS84 degrees).
 * @returns {{points: Array<[number, number]>, lines: Array<Array<[number, number]>>}|null}
 */
export function normalizeQldRoadEventGeometry(geometry) {
  const points = [];
  const rawLines = [];
  const visit = (value, depth) => {
    if (!value || typeof value !== 'object') return;
    const { type, coordinates } = value;
    switch (type) {
      case 'Point': {
        const point = position(coordinates);
        if (point) points.push(point);
        return;
      }
      case 'MultiPoint':
        if (Array.isArray(coordinates))
          for (const raw of coordinates) {
            const point = position(raw);
            if (point) points.push(point);
          }
        return;
      case 'LineString':
        rawLines.push(coordinates);
        return;
      case 'MultiLineString':
      case 'Polygon':
        if (Array.isArray(coordinates)) rawLines.push(...coordinates);
        return;
      case 'MultiPolygon':
        if (Array.isArray(coordinates))
          for (const polygon of coordinates)
            if (Array.isArray(polygon)) rawLines.push(...polygon);
        return;
      case 'GeometryCollection':
        if (
          depth < QLD_ROAD_EVENT_LIMITS.geometryDepth &&
          Array.isArray(value.geometries)
        )
          for (const child of value.geometries) visit(child, depth + 1);
        return;
      default:
    }
  };
  visit(geometry, 0);

  const lines = [];
  let vertices = 0;
  for (const raw of rawLines) {
    if (lines.length >= QLD_ROAD_EVENT_LIMITS.linesPerEvent) break;
    const cleaned = cleanLine(raw);
    if (cleaned.length < 2) {
      // A one-vertex "line" is still a location worth marking.
      if (cleaned.length === 1) points.push(cleaned[0]);
      continue;
    }
    const remaining = QLD_ROAD_EVENT_LIMITS.verticesPerEvent - vertices;
    if (remaining < 2) break;
    const line = simplifyQldRoadEventLine(
      cleaned,
      SIMPLIFY_TOLERANCE_DEG,
      Math.min(QLD_ROAD_EVENT_LIMITS.verticesPerLine, remaining),
    );
    vertices += line.length;
    lines.push(line);
  }
  const markers = points.slice(0, QLD_ROAD_EVENT_LIMITS.pointsPerEvent);
  if (!markers.length && !lines.length) return null;
  return { points: markers, lines };
}

/**
 * Card and marker anchor: the first reported point, else the half-length point
 * of the longest line (planar degrees are fine at event scale).
 * @param {{points: Array<[number, number]>, lines: Array<Array<[number, number]>>}} geometry
 * @returns {[number, number]}
 */
export function qldRoadEventAnchor({ points, lines }) {
  if (points.length) return points[0];
  let best = null;
  let bestLength = -1;
  let bestSegments = null;
  for (const line of lines) {
    const segments = [];
    let length = 0;
    for (let i = 1; i < line.length; i++) {
      const segment = Math.hypot(
        line[i][0] - line[i - 1][0],
        line[i][1] - line[i - 1][1],
      );
      segments.push(segment);
      length += segment;
    }
    if (length > bestLength) {
      bestLength = length;
      best = line;
      bestSegments = segments;
    }
  }
  let remaining = bestLength / 2;
  for (let i = 0; i < bestSegments.length; i++) {
    const segment = bestSegments[i];
    if (remaining <= segment && segment > 0) {
      const t = remaining / segment;
      const [x1, y1] = best[i];
      const [x2, y2] = best[i + 1];
      return [
        Math.round((x1 + (x2 - x1) * t) * COORDINATE_DECIMALS) /
          COORDINATE_DECIMALS,
        Math.round((y1 + (y2 - y1) * t) * COORDINATE_DECIMALS) /
          COORDINATE_DECIMALS,
      ];
    }
    remaining -= segment;
  }
  return best[0];
}

function stableId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
    return String(value);
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value))
    return value;
  return null;
}

/**
 * Normalize one QLDTraffic FeatureCollection. Returns null only when the
 * payload is not a feature collection; otherwise the valid events in feed
 * order, capped by QLD_ROAD_EVENT_LIMITS.
 * @param {object} geojson - Raw `/v2/events` payload.
 * @returns {Array<object>|null} Compact event records (see DATA_SOURCES.md).
 */
export function normalizeQldRoadEventSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const events = [];
  const ids = new Set();
  let totalVertices = 0;
  for (const feature of geojson.features) {
    if (events.length >= QLD_ROAD_EVENT_LIMITS.events) break;
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const id = stableId(properties.id ?? feature.id);
    if (!id || ids.has(id)) continue;
    const geometry = normalizeQldRoadEventGeometry(feature.geometry);
    if (!geometry) continue;
    const vertices = geometry.lines.reduce((sum, line) => sum + line.length, 0);
    // Past the global vertex budget an event keeps its marker but not its lines.
    if (totalVertices + vertices > QLD_ROAD_EVENT_LIMITS.totalVertices) {
      if (!geometry.points.length)
        geometry.points.push(qldRoadEventAnchor(geometry));
      geometry.lines = [];
    } else totalVertices += vertices;
    ids.add(id);
    const impact = record(properties.impact);
    const road = record(properties.road_summary);
    const duration = record(properties.duration);
    const source = record(properties.source);
    const priority = text(properties.event_priority, 16);
    events.push({
      id,
      category: qldRoadEventCategory(properties.event_type),
      type: text(properties.event_type, LABEL_LIMIT),
      subtype: text(properties.event_subtype, LABEL_LIMIT),
      dueTo: text(properties.event_due_to, LABEL_LIMIT),
      priority: ['Low', 'Medium', 'High'].includes(priority) ? priority : null,
      description: text(properties.description),
      advice: text(properties.advice),
      information: text(properties.information),
      road: text(road.road_name, LABEL_LIMIT),
      locality: text(road.locality, LABEL_LIMIT),
      localGovernmentArea: text(road.local_government_area, LABEL_LIMIT),
      district: text(road.district, LABEL_LIMIT),
      direction: text(impact.direction, LABEL_LIMIT),
      towards: text(impact.towards, LABEL_LIMIT),
      impactType: text(impact.impact_type, LABEL_LIMIT),
      impactSubtype: text(impact.impact_subtype, LABEL_LIMIT),
      delay: text(impact.delay, LABEL_LIMIT),
      startMs: timeMs(duration.start),
      endMs: timeMs(duration.end),
      lastUpdatedMs: timeMs(properties.last_updated),
      providedBy: text(source.provided_by, LABEL_LIMIT),
      anchor: qldRoadEventAnchor(geometry),
      points: geometry.points,
      lines: geometry.lines,
    });
  }
  return events;
}
