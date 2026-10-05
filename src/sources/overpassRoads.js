/** Decode OSM ways into portable road coordinates, classes and travel direction. */
export function normalizeOverpassRoads(payload) {
  const roads = [];
  for (const element of payload?.elements || []) {
    if (
      element.type !== 'way' ||
      !element.geometry ||
      element.geometry.length < 2
    )
      continue;
    const oneway = element.tags?.oneway;
    roads.push({
      coordinates: element.geometry.map((point) => [point.lon, point.lat]),
      type: element.tags?.highway || 'unclassified',
      oneway:
        oneway === 'yes' ||
        oneway === '1' ||
        oneway === 'true' ||
        element.tags?.junction === 'roundabout'
          ? 1
          : oneway === '-1'
            ? -1
            : 0,
    });
  }
  return roads;
}
