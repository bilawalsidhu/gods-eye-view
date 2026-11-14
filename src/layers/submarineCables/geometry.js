export function featureReference(feature) {
  const geometry = feature?.geometry;
  if (!geometry) return null;

  const props = feature?.properties || {};
  const propertyCoords = coordsFromProperty(props.coordinates);
  if (propertyCoords) {
    return {
      lon: propertyCoords[0],
      lat: propertyCoords[1],
    };
  }

  if (geometry.type === 'Point') {
    const coords = coordsFromPoint(geometry.coordinates);
    if (!coords) return null;
    return { lon: coords[0], lat: coords[1] };
  }

  const coords = [];
  collectLonLat(geometry.coordinates, coords);
  if (!coords.length) return null;

  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of coords) {
    lonSum += lon;
    latSum += lat;
  }
  return {
    lon: lonSum / coords.length,
    lat: latSum / coords.length,
  };
}

function coordsFromProperty(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function coordsFromPoint(value) {
  if (!Array.isArray(value) || value.length < 2) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  return [lon, lat];
}

function collectLonLat(value, out) {
  if (!Array.isArray(value)) return;
  if (typeof value[0] === 'number' && typeof value[1] === 'number') {
    const lon = Number(value[0]);
    const lat = Number(value[1]);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      out.push([lon, lat]);
    }
    return;
  }
  for (const child of value) collectLonLat(child, out);
}

export function featureLabel(feature) {
  const props = feature?.properties || {};
  return String(props.name || props.id || feature?.id || '').trim();
}

export function normalizeFeatures(json, kind) {
  const features = Array.isArray(json?.features) ? json.features : [];
  return features.map((feature, index) => {
    const id = feature?.properties?.id || feature?.id || `${kind}-${index}`;
    return {
      ...feature,
      id: String(id),
    };
  });
}

function partPosition(value) {
  if (!Array.isArray(value)) return null;
  const lon = Number(value[0]);
  const lat = Number(value[1]);
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) return null;
  const height = Number(value[2]);
  return Number.isFinite(height) ? [lon, lat, height] : [lon, lat];
}

function collectParts(geometry, out) {
  const coordinates = geometry?.coordinates;
  switch (geometry?.type) {
    case 'Point': {
      const point = partPosition(coordinates);
      if (point) out.points.push(point);
      break;
    }
    case 'MultiPoint':
      for (const value of coordinates || []) {
        const point = partPosition(value);
        if (point) out.points.push(point);
      }
      break;
    case 'LineString': {
      const line = (coordinates || []).map(partPosition).filter(Boolean);
      if (line.length >= 2) out.lines.push(line);
      break;
    }
    case 'MultiLineString':
      for (const part of coordinates || []) {
        const line = (part || []).map(partPosition).filter(Boolean);
        if (line.length >= 2) out.lines.push(line);
      }
      break;
    case 'GeometryCollection':
      for (const child of geometry.geometries || []) collectParts(child, out);
      break;
    default:
      break;
  }
}

/**
 * The parts of a feature the layer draws: every line of a LineString or
 * MultiLineString and every point of a Point or MultiPoint, also inside a
 * GeometryCollection. Each is [lon, lat] or [lon, lat, height] in degrees
 * and metres. Polygons are not drawn.
 * @returns {{lines:number[][][],points:number[][]}}
 */
export function featureParts(feature) {
  const out = { lines: [], points: [] };
  collectParts(feature?.geometry, out);
  return out;
}
