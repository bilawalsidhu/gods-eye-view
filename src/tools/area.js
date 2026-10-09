/**
 * The `area` argument shared by location-scoped tools: a bounding box, a
 * center point with radius, or a place name resolved through the `places`
 * service.
 */

import { ToolError } from './catalog.js';

const EARTH_RADIUS_KM = 6371.0088;
const MAX_RADIUS_KM = 2000;

/** JSON Schema for the `area` argument. */
export const AREA_SCHEMA = Object.freeze({
  type: 'object',
  description:
    'Where to look. Give exactly one of: place (a name such as "Taiwan" or ' +
    '"San Francisco Bay"), bbox ([west, south, east, north] in degrees), or ' +
    'lat and lon with radius_km.',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    bbox: {
      type: 'array',
      items: { type: 'number' },
      minItems: 4,
      maxItems: 4,
    },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
    radius_km: { type: 'number', minimum: 0.1, maximum: MAX_RADIUS_KM },
  },
  additionalProperties: false,
});

/**
 * Resolve an `area` argument to `{ label, west, south, east, north, center? }`.
 * A box whose west edge exceeds its east edge crosses the antimeridian.
 */
export async function resolveArea(area, { services, signal } = {}) {
  const given = ['place', 'bbox', 'lat'].filter((key) => area?.[key] != null);
  if (given.length !== 1)
    throw new ToolError(
      'invalid_arguments',
      'area needs exactly one of place, bbox, or lat/lon with radius_km',
    );
  if (area.bbox) {
    const [west, south, east, north] = area.bbox;
    if (
      [west, east].some((value) => Math.abs(value) > 180) ||
      [south, north].some((value) => Math.abs(value) > 90) ||
      south >= north
    )
      throw new ToolError(
        'invalid_arguments',
        'area.bbox must be [west, south, east, north] with south below north',
      );
    return { label: 'the requested box', west, south, east, north };
  }
  if (area.lat != null) {
    if (area.lon == null || area.radius_km == null)
      throw new ToolError(
        'invalid_arguments',
        'area with lat also needs lon and radius_km',
      );
    return circleArea(area.lat, area.lon, area.radius_km);
  }
  const places = services?.places;
  if (!places)
    throw new ToolError(
      'unsupported',
      'Place names cannot be resolved here; give a bbox or lat/lon instead',
    );
  const place = await places.resolve(area.place, { signal });
  if (!place)
    throw new ToolError(
      'invalid_arguments',
      `No place matched "${area.place}"; try a more specific name or a bbox`,
    );
  return {
    label: place.name || area.place,
    ...place.bounds,
    ...(place.point ? { point: place.point } : {}),
  };
}

/**
 * The bounding box of a spherical cap. When the cap reaches a pole it spans
 * every longitude; otherwise the longitude span is the exact tangent bound,
 * asin(sin(d) / cos(lat)) for angular radius d.
 */
function circleArea(lat, lon, radiusKm) {
  const angular = radiusKm / EARTH_RADIUS_KM;
  const latSpan = angular * (180 / Math.PI);
  const reachesPole = lat + latSpan >= 90 || lat - latSpan <= -90;
  const ratio = Math.sin(angular) / Math.cos((lat * Math.PI) / 180);
  const lonSpan =
    reachesPole || ratio >= 1 ? 180 : Math.asin(ratio) * (180 / Math.PI);
  const wrap = (value) => ((((value + 180) % 360) + 360) % 360) - 180;
  return {
    label: `${radiusKm} km around ${lat.toFixed(3)}, ${lon.toFixed(3)}`,
    west: lonSpan >= 180 ? -180 : wrap(lon - lonSpan),
    east: lonSpan >= 180 ? 180 : wrap(lon + lonSpan),
    south: Math.max(-90, lat - latSpan),
    north: Math.min(90, lat + latSpan),
    center: { lat, lon, radiusKm },
  };
}

/** JSON Schema for a single location: a place name, or lat and lon. */
export const POINT_SCHEMA = Object.freeze({
  type: 'object',
  description: 'A place name, or lat and lon.',
  properties: {
    place: { type: 'string', minLength: 1, maxLength: 200 },
    lat: { type: 'number', minimum: -90, maximum: 90 },
    lon: { type: 'number', minimum: -180, maximum: 180 },
  },
  additionalProperties: false,
});

/** Resolve a point argument to `{ label, lat, lon }`. */
export async function resolvePoint(point, { services, signal } = {}) {
  if (point?.place != null && point.lat == null && point.lon == null) {
    const area = await resolveArea(
      { place: point.place },
      { services, signal },
    );
    return { label: area.label, ...areaCenter(area) };
  }
  if (point?.place == null && point?.lat != null && point?.lon != null)
    return {
      label: `${point.lat.toFixed(4)}, ${point.lon.toFixed(4)}`,
      lat: point.lat,
      lon: point.lon,
    };
  throw new ToolError(
    'invalid_arguments',
    'A location needs either place, or lat and lon',
  );
}

/** Distance in kilometers from an area's center to its farthest edge point. */
export function areaRadiusKm(area) {
  if (area.center) return area.center.radiusKm;
  const center = areaCenter(area);
  // A box holding the point opposite its center reaches half the globe.
  const antipode = {
    lat: -center.lat,
    lon: center.lon > 0 ? center.lon - 180 : center.lon + 180,
  };
  if (areaContains(area, antipode)) return Math.PI * EARTH_RADIUS_KM;
  // Otherwise the farthest point is on the boundary: sample each edge, and
  // include where each parallel edge comes nearest the antipode's longitude.
  const width =
    area.west <= area.east
      ? area.east - area.west
      : 360 - (area.west - area.east);
  const lonAt = (t) => area.west + width * t;
  const steps = 64;
  const points = [];
  for (let step = 0; step <= steps; step += 1) {
    const t = step / steps;
    const lat = area.south + (area.north - area.south) * t;
    points.push(
      { lat, lon: area.west },
      { lat, lon: area.east },
      { lat: area.north, lon: lonAt(t) },
      { lat: area.south, lon: lonAt(t) },
    );
  }
  const offset = (((antipode.lon - area.west) % 360) + 360) % 360;
  if (offset <= width)
    points.push(
      { lat: area.north, lon: antipode.lon },
      { lat: area.south, lon: antipode.lon },
    );
  return Math.max(...points.map((point) => distanceKm(center, point)));
}

/** Great-circle distance in kilometers. */
export function distanceKm(a, b) {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * The center of a resolved area: a radius area's center, a named place's own
 * point, or the middle of a box (handling boxes across the antimeridian).
 */
export function areaCenter(area) {
  if (area.center) return { lat: area.center.lat, lon: area.center.lon };
  if (area.point) return { lat: area.point.lat, lon: area.point.lon };
  const width =
    area.west <= area.east
      ? area.east - area.west
      : area.east + 360 - area.west;
  const lon = area.west + width / 2;
  return {
    lat: (area.south + area.north) / 2,
    lon: lon > 180 ? lon - 360 : lon,
  };
}

/** Whether a point lies inside a resolved area, including radius areas. */
export function areaContains(area, point) {
  if (!Number.isFinite(point?.lat) || !Number.isFinite(point?.lon))
    return false;
  if (point.lat < area.south || point.lat > area.north) return false;
  const inLongitude =
    area.west <= area.east
      ? point.lon >= area.west && point.lon <= area.east
      : point.lon >= area.west || point.lon <= area.east;
  if (!inLongitude) return false;
  return area.center
    ? distanceKm(area.center, point) <= area.center.radiusKm
    : true;
}

/** Whether a straight lon/lat segment meets a plain box (Liang–Barsky). */
function segmentMeetsBox(a, b, west, south, east, north) {
  const dx = b.lon - a.lon;
  const dy = b.lat - a.lat;
  let low = 0;
  let high = 1;
  for (const [p, q] of [
    [-dx, a.lon - west],
    [dx, east - a.lon],
    [-dy, a.lat - south],
    [dy, north - a.lat],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else {
      const t = q / p;
      if (p < 0) low = Math.max(low, t);
      else high = Math.min(high, t);
      if (low > high) return false;
    }
  }
  return true;
}

/** Whether a segment meets an area's bounding box, across the antimeridian too. */
function segmentMeetsBounds(a, b, area) {
  // A segment longer than half the globe in longitude crosses the antimeridian.
  const end =
    Math.abs(b.lon - a.lon) > 180
      ? { lat: b.lat, lon: b.lon + (b.lon < a.lon ? 360 : -360) }
      : b;
  const boxes =
    area.west <= area.east
      ? [[area.west, area.east]]
      : [
          [area.west, 180],
          [-180, area.east],
        ];
  return boxes.some(([west, east]) =>
    [-360, 0, 360].some((shift) =>
      segmentMeetsBox(
        a,
        end,
        west + shift,
        area.south,
        east + shift,
        area.north,
      ),
    ),
  );
}

/** Closest great-circle distance in km from `point` to the segment a–b. */
function segmentDistanceKm(point, a, b) {
  const toRad = Math.PI / 180;
  const bearing = (from, to) => {
    const lat1 = from.lat * toRad;
    const lat2 = to.lat * toRad;
    const dLon = (to.lon - from.lon) * toRad;
    return Math.atan2(
      Math.sin(dLon) * Math.cos(lat2),
      Math.cos(lat1) * Math.sin(lat2) -
        Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLon),
    );
  };
  const toPoint = distanceKm(a, point) / EARTH_RADIUS_KM;
  const length = distanceKm(a, b) / EARTH_RADIUS_KM;
  const angle = bearing(a, point) - bearing(a, b);
  if (length === 0 || Math.cos(angle) <= 0) return distanceKm(a, point);
  const cross = Math.asin(Math.sin(toPoint) * Math.sin(angle));
  const along = Math.acos(
    Math.min(1, Math.cos(toPoint) / Math.max(1e-12, Math.cos(cross))),
  );
  if (along >= length) return distanceKm(b, point);
  return Math.abs(cross) * EARTH_RADIUS_KM;
}

/**
 * Whether a line of `[lon, lat]` vertices passes through an area, including
 * segments that cross it with no vertex inside.
 */
export function lineTouchesArea(coords, area) {
  const points = coords
    .map(([lon, lat]) => ({ lat, lon }))
    .filter(
      (point) => Number.isFinite(point.lat) && Number.isFinite(point.lon),
    );
  if (points.some((point) => areaContains(area, point))) return true;
  for (let index = 1; index < points.length; index += 1) {
    const a = points[index - 1];
    const b = points[index];
    if (!segmentMeetsBounds(a, b, area)) continue;
    if (
      !area.center ||
      segmentDistanceKm(area.center, a, b) <= area.center.radiusKm
    )
      return true;
  }
  return false;
}

/** Whether a point lies inside a ring of `[lon, lat]` vertices (ray casting). */
function ringContains(ring, point) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (
      yi > point.lat !== yj > point.lat &&
      point.lon < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi
    )
      inside = !inside;
  }
  return inside;
}

/**
 * Whether polygons (each a list of `[lon, lat]` rings, outer ring first)
 * overlap an area: a vertex inside it, an edge crossing it, or the area's
 * center inside a polygon and outside its holes.
 */
export function polygonsTouchArea(polygons, area) {
  const center = areaCenter(area);
  return (polygons || []).some((rings) => {
    if (!Array.isArray(rings) || !rings.length) return false;
    const closed = rings.map((ring) =>
      ring.length && ring[0] !== ring.at(-1) ? [...ring, ring[0]] : ring,
    );
    if (closed.some((ring) => lineTouchesArea(ring, area))) return true;
    return (
      ringContains(rings[0], center) &&
      !rings.slice(1).some((hole) => ringContains(hole, center))
    );
  });
}
