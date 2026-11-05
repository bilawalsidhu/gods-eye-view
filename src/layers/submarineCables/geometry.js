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

  // Longitudes are averaged around the first one, so a cable split at the
  // antimeridian (179.9 / -179.9) keeps its reference there, not at 0.
  const west = coords[0][0];
  let lonSum = 0;
  let latSum = 0;
  for (const [lon, lat] of coords) {
    lonSum += lon - 360 * Math.round((lon - west) / 360);
    latSum += lat;
  }
  const lon = lonSum / coords.length;
  return {
    lon: lon - 360 * Math.round(lon / 360),
    lat: latSum / coords.length,
  };
}

/**
 * Split a [lon, lat] path where a segment crosses the antimeridian, so no
 * drawn segment runs the long way across the whole map.
 */
function splitAtAntimeridian(path) {
  const parts = [];
  let current = [];
  for (let index = 0; index < path.length; index++) {
    const point = path[index];
    const previous = path[index - 1];
    if (previous && Math.abs(point[0] - previous[0]) > 180) {
      const edge = previous[0] > point[0] ? 180 : -180;
      const unwrapped = point[0] + 2 * edge;
      const t = (edge - previous[0]) / (unwrapped - previous[0]);
      const lat = previous[1] + t * (point[1] - previous[1]);
      current.push([edge, lat]);
      parts.push(current);
      current = [[-edge, lat]];
    }
    current.push(point);
  }
  parts.push(current);
  return parts.filter((part) => part.length > 1);
}

/** A line or multi-line feature whose paths are split at the antimeridian. */
export function splitFeatureAtAntimeridian(feature) {
  const geometry = feature?.geometry;
  if (geometry?.type !== 'LineString' && geometry?.type !== 'MultiLineString')
    return feature;
  const paths =
    geometry.type === 'LineString'
      ? [geometry.coordinates]
      : geometry.coordinates;
  return {
    ...feature,
    geometry: {
      type: 'MultiLineString',
      coordinates: paths.flatMap((path) => splitAtAntimeridian(path)),
    },
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
