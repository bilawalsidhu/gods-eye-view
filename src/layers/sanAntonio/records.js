/** Limits reject complete records; geometry is never simplified or truncated. */
export const SAN_ANTONIO_GEOMETRY_LIMITS = Object.freeze({
  maxFeatures: 10000,
  maxPositionsPerFeature: 50000,
  maxPositionsPerSnapshot: 1000000,
  maxParts: 1024,
  maxRings: 256,
  // Deliberately wider than Bexar County, without accepting another continent
  // or an accidentally unprojected StatePlane coordinate as a City feature.
  west: -99.5,
  south: 28.5,
  east: -97.5,
  north: 30.5,
});

const LIMITS = SAN_ANTONIO_GEOMETRY_LIMITS;
const text = (value, limit = 140) =>
  typeof value === 'string'
    ? value
        .slice(0, 2048)
        .replace(/<[^>]*>/g, '')
        .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, limit)
    : '';
const timestamp = (value) =>
  Number.isFinite(value) && value >= 0 && value <= 8640000000000000
    ? value
    : null;

function objectId(value) {
  if (typeof value === 'string' && /^\d{1,16}$/.test(value))
    value = Number(value);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function ringArea(ring) {
  const [x0, y0] = ring[0];
  let area = 0;
  for (let i = 1; i < ring.length; i++)
    area +=
      (ring[i - 1][0] - x0) * (ring[i][1] - y0) -
      (ring[i][0] - x0) * (ring[i - 1][1] - y0);
  return area / 2;
}

function copyGeometry(geometry, allowedTypes, budget) {
  if (!geometry || !allowedTypes.has(geometry.type)) return null;
  let positionCount = 0;
  const position = (value) => {
    positionCount++;
    budget.positions++;
    if (budget.positions > LIMITS.maxPositionsPerSnapshot)
      budget.exhausted = true;
    if (
      positionCount > LIMITS.maxPositionsPerFeature ||
      budget.exhausted ||
      !Array.isArray(value) ||
      value.length < 2 ||
      value.length > 3 ||
      !value.every(Number.isFinite)
    )
      return null;
    const [lon, lat] = value;
    if (
      lon < LIMITS.west ||
      lon > LIMITS.east ||
      lat < LIMITS.south ||
      lat > LIMITS.north
    )
      return null;
    return value.slice();
  };
  const path = (value, closed = false) => {
    if (
      !Array.isArray(value) ||
      value.length < (closed ? 4 : 2) ||
      value.length > LIMITS.maxPositionsPerFeature
    )
      return null;
    const result = [];
    for (const coordinate of value) {
      const next = position(coordinate);
      if (!next) return null;
      result.push(next);
    }
    const first = result[0];
    if (closed) {
      const last = result[result.length - 1];
      if (
        first[0] !== last[0] ||
        first[1] !== last[1] ||
        Math.abs(ringArea(result)) < 1e-14
      )
        return null;
    } else if (
      !result.some(([lon, lat]) => lon !== first[0] || lat !== first[1])
    )
      return null;
    return result;
  };
  const polygon = (value) => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > LIMITS.maxRings
    )
      return null;
    const rings = [];
    for (const ring of value) {
      const next = path(ring, true);
      if (!next) return null;
      rings.push(next);
    }
    return rings;
  };
  const parts = (value, read) => {
    if (
      !Array.isArray(value) ||
      !value.length ||
      value.length > LIMITS.maxParts
    )
      return null;
    const result = [];
    for (const part of value) {
      const next = read(part);
      if (!next) return null;
      result.push(next);
    }
    return result;
  };
  let coordinates = null;
  switch (geometry.type) {
    case 'Point':
      coordinates = position(geometry.coordinates);
      break;
    case 'LineString':
      coordinates = path(geometry.coordinates);
      break;
    case 'MultiLineString':
      coordinates = parts(geometry.coordinates, (part) => path(part));
      break;
    case 'Polygon':
      coordinates = polygon(geometry.coordinates);
      break;
    case 'MultiPolygon':
      coordinates = parts(geometry.coordinates, polygon);
      break;
  }
  return coordinates ? { type: geometry.type, coordinates } : null;
}

function inRing([lon, lat], ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a[1] > lat !== b[1] > lat &&
      lon < ((b[0] - a[0]) * (lat - a[1])) / (b[1] - a[1]) + a[0]
    )
      inside = !inside;
  }
  return inside;
}

function polygonAnchor(polygons) {
  const rings = polygons.reduce((best, candidate) =>
    Math.abs(ringArea(candidate[0])) > Math.abs(ringArea(best[0]))
      ? candidate
      : best,
  );
  const ring = rings[0];
  const [x0, y0] = ring[0];
  let x = 0;
  let y = 0;
  let crossSum = 0;
  for (let i = 1; i < ring.length; i++) {
    const ax = ring[i - 1][0] - x0;
    const ay = ring[i - 1][1] - y0;
    const bx = ring[i][0] - x0;
    const by = ring[i][1] - y0;
    const cross = ax * by - bx * ay;
    x += (ax + bx) * cross;
    y += (ay + by) * cross;
    crossSum += cross;
  }
  const center = [x0 + x / (3 * crossSum), y0 + y / (3 * crossSum)];
  // A concave polygon's centroid can be outside, or in a hole. In that case
  // use a point on its actual outer boundary, never an invented filled area.
  const anchor =
    inRing(center, ring) && !rings.slice(1).some((hole) => inRing(center, hole))
      ? center
      : ring[0];
  return { lon: anchor[0], lat: anchor[1] };
}

function lineAnchor(lines) {
  const length = (a, b) =>
    Math.hypot(
      (b[0] - a[0]) * Math.cos(((a[1] + b[1]) * Math.PI) / 360),
      b[1] - a[1],
    );
  const measured = lines.map((line) => {
    const lengths = line.slice(1).map((point, i) => length(line[i], point));
    return { line, lengths, total: lengths.reduce((a, b) => a + b, 0) };
  });
  const longest = measured.reduce((best, next) =>
    next.total > best.total ? next : best,
  );
  let remaining = longest.total / 2;
  for (let i = 0; i < longest.lengths.length; i++) {
    const span = longest.lengths[i];
    if (span > 0 && remaining <= span) {
      const a = longest.line[i];
      const b = longest.line[i + 1];
      const fraction = remaining / span;
      return {
        lon: a[0] + (b[0] - a[0]) * fraction,
        lat: a[1] + (b[1] - a[1]) * fraction,
      };
    }
    remaining -= span;
  }
  const last = longest.line[longest.line.length - 1];
  return { lon: last[0], lat: last[1] };
}

function anchorFor(geometry) {
  const coordinates = geometry.coordinates;
  if (geometry.type === 'Point')
    return { lon: coordinates[0], lat: coordinates[1] };
  if (geometry.type === 'Polygon') return polygonAnchor([coordinates]);
  if (geometry.type === 'MultiPolygon') return polygonAnchor(coordinates);
  return lineAnchor(
    geometry.type === 'LineString' ? [coordinates] : coordinates,
  );
}

/** Normalize only approved public fields; preserve all accepted geometry parts. */
export function normalizeSanAntonioSnapshot(snapshot, dataset) {
  if (!Array.isArray(snapshot?.features))
    throw new TypeError('Malformed San Antonio feature snapshot');
  if (
    !dataset?.id ||
    !Array.isArray(dataset.fields) ||
    !dataset.fields.includes('OBJECTID') ||
    !Array.isArray(dataset.geometryTypes)
  )
    throw new TypeError('Invalid San Antonio dataset configuration');
  const fields = new Set(dataset.fields);
  const geometryTypes = new Set(dataset.geometryTypes);
  const records = [];
  const ids = new Set();
  const budget = { positions: 0, exhausted: false };
  const features = snapshot.features;
  for (let i = 0; i < Math.min(features.length, LIMITS.maxFeatures); i++) {
    if (budget.exhausted) break;
    const feature = features[i];
    const properties = feature?.properties;
    if (
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties)
    )
      continue;
    const get = (field) =>
      fields.has(field) && Object.hasOwn(properties, field)
        ? properties[field]
        : undefined;
    const oid = objectId(get('OBJECTID'));
    if (oid === null || ids.has(oid)) continue;
    const geometry = copyGeometry(feature.geometry, geometryTypes, budget);
    if (!geometry) continue;
    const name =
      ['ParkName', 'AltParkName', 'TrailName', 'Name']
        .map((field) => text(get(field)))
        .find(Boolean) || dataset.name + ' feature ' + oid;
    const details = [];
    for (const [field, label] of [
      ['ParkType', 'Type'],
      ['TrailType', 'Type'],
      ['TrailSubtype', 'Subtype'],
      ['TrailSource', 'Mapping source'],
    ]) {
      const value = text(get(field), 100);
      if (value) details.push(label + ': ' + value);
    }
    const alternate = text(get('AltParkName'), 100);
    if (alternate && alternate !== name)
      details.push('Also named: ' + alternate);
    const miles = get('TrailMiles');
    if (Number.isFinite(miles) && miles >= 0)
      details.push('Reported segment miles: ' + miles);
    records.push({
      id: dataset.id + ':' + oid,
      objectId: oid,
      name,
      geometry,
      anchor: anchorFor(geometry),
      details,
    });
    ids.add(oid);
  }
  return {
    records,
    sourceUpdatedAt: timestamp(snapshot.sourceUpdatedAt),
    fetchedAt: timestamp(snapshot.fetchedAt),
    sourceCount:
      Number.isSafeInteger(snapshot.sourceCount) && snapshot.sourceCount >= 0
        ? snapshot.sourceCount
        : features.length,
    skippedCount: features.length - records.length,
  };
}
