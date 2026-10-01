/** Validate a complete /api/effis/burnt-areas payload before it replaces the displayed set. */
export function normalizeBurntAreasSnapshot(payload) {
  if (!Array.isArray(payload?.areas)) return null;
  const rows = [];
  const ids = new Set();
  for (const [index, area] of payload.areas.entries()) {
    const { lon, lat, polygon } = area || {};
    if (
      !Number.isFinite(lon) ||
      Math.abs(lon) > 180 ||
      !Number.isFinite(lat) ||
      Math.abs(lat) > 90 ||
      !Array.isArray(polygon) ||
      polygon.length < 4
    )
      continue;
    const validPolygon = polygon.every(
      (pt) =>
        Array.isArray(pt) &&
        Number.isFinite(pt[0]) &&
        Math.abs(pt[0]) <= 180 &&
        Number.isFinite(pt[1]) &&
        Math.abs(pt[1]) <= 90,
    );
    if (!validPolygon) continue;
    const stableId =
      area.id != null && area.id !== '' ? String(area.id) : `area-${index + 1}`;
    if (ids.has(stableId)) continue;
    ids.add(stableId);
    rows.push({
      stableId,
      lon,
      lat,
      polygon,
      areaHa: Number.isFinite(area.areaHa) ? area.areaHa : null,
      fireDate: typeof area.fireDate === 'string' ? area.fireDate : null,
    });
  }
  return rows;
}
