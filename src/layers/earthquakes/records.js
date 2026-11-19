/** Validate a complete feed before replacing the last good earthquake snapshot. */
export function normalizeEarthquakeSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) return null;
  const rows = [];
  const ids = new Set();
  for (const [index, feature] of geojson.features.entries()) {
    const coordinates = feature?.geometry?.coordinates;
    const properties = feature?.properties;
    if (
      !Array.isArray(coordinates) ||
      coordinates.length < 2 ||
      !properties ||
      typeof properties !== 'object' ||
      Array.isArray(properties) ||
      (feature.geometry.type != null && feature.geometry.type !== 'Point')
    )
      return null;
    const [lon, lat, depthKm] = coordinates;
    const mag = properties.mag;
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      (depthKm != null && !Number.isFinite(depthKm)) ||
      (mag != null && (!Number.isFinite(mag) || mag > 10))
    )
      return null;
    // A missing magnitude cannot establish that this event meets M2.5+.
    if (mag == null || mag < 2.5) continue;
    // An id-less event is named by what it is (time, position, depth and
    // magnitude), not by its row, so a refresh that inserts a row keeps the
    // selection on the same quake; a revision to any of those names a new
    // one. Two id-less events that match exactly fall back to the row.
    const idless = feature.id == null || feature.id === '';
    let stableId = idless
      ? `event-${[properties.time ?? 'na', lon, lat, depthKm ?? 'na', mag].join(':')}`
      : String(feature.id);
    if (idless && ids.has(stableId)) stableId = `${stableId}:${index + 1}`;
    if (ids.has(stableId)) return null;
    ids.add(stableId);
    rows.push({
      stableId,
      usgsId: feature.id ?? null,
      lon,
      lat,
      depthKm: depthKm ?? null,
      mag,
      place: typeof properties.place === 'string' ? properties.place : null,
      time: Number.isFinite(properties.time) ? properties.time : null,
    });
  }
  return rows;
}
