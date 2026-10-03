/**
 * Bundled OpenStreetMap infrastructure layers (datacenters and dams): their
 * data files, line-delimited GeoJSON parsing and analyst records.
 */

// Resolved by Vite in builds and relative to this module in other consumers.
export const INFRASTRUCTURE_DATA_URLS = Object.freeze({
  'local-datacenters': new URL(
    '../data/local_data/datacenters/datacenters.geojsonl',
    import.meta.url,
  ).href,
  'local-dams': new URL(
    '../data/local_data/dams/dams.geojsonl',
    import.meta.url,
  ).href,
});

/** Parse GeoJSON Lines: one Feature per non-empty line. */
export function parseGeojsonLines(text) {
  return String(text)
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

/** The singular label for a local infrastructure layer. */
export function layerTitle(layerId) {
  if (layerId === 'local-datacenters') return 'Datacenter';
  if (layerId === 'local-dams') return 'Dam';
  return 'Feature';
}

/**
 * Map one local infrastructure feature to a JSON-safe analyst record
 * (analyst query engine seam). Pure — no Cesium types. Missing/unknown
 * fields are null, never NaN/undefined. Layer-specific fields that do not
 * apply (river/output on datacenters, capacity on dams) stay null so a
 * shared compact payload can copy them without inventing values.
 * Names are unclamped — overlay cards shorten for paint; queries need the
 * full source string ("Usina Hidrelétrica de Itaipu").
 * @param {Object|null|undefined} raw - {id, lat, lon, properties}.
 * @param {string} [layerId] Local layer id (`local-datacenters` / `local-dams`).
 * @returns {{id: string, name: string|null, lat: number|null, lon: number|null,
 *   operator: string|null, capacity: string|null, river: string|null,
 *   output: string|null}}
 */
export function mapAnalystRecord(raw, layerId = '') {
  const num = (v) => (Number.isFinite(v) ? v : null);
  const text = (v) => {
    const t = String(v ?? '').trim();
    return t && t !== 'undefined' && t !== 'null' ? t : null;
  };
  const props =
    raw?.properties &&
    typeof raw.properties === 'object' &&
    !Array.isArray(raw.properties)
      ? raw.properties
      : {};
  const tags =
    props.tags && typeof props.tags === 'object' && !Array.isArray(props.tags)
      ? props.tags
      : {};
  const name =
    text(props.name) ||
    text(tags.name) ||
    text(tags['name:en']) ||
    text(tags.official_name) ||
    null;
  const operator =
    text(tags.operator) ||
    text(props.operator) ||
    text(tags['operator:short']) ||
    null;
  const capacity =
    layerId === 'local-datacenters'
      ? text(tags['capacity:it_load']) ||
        text(tags.it_load) ||
        text(tags.capacity) ||
        text(props.capacity)
      : null;
  const river =
    layerId === 'local-dams'
      ? text(tags.associated_river) ||
        text(props.associated_river) ||
        text(tags.river) ||
        text(props.river) ||
        text(tags['river:name'])
      : null;
  const output =
    layerId === 'local-dams'
      ? text(props.output) || text(tags['plant:output:electricity'])
      : null;
  return {
    id: name || text(raw?.id) || layerTitle(layerId),
    name,
    lat: num(raw?.lat),
    lon: num(raw?.lon),
    operator,
    capacity,
    river,
    output,
  };
}

/** A representative point for a feature: its point, or its outline's average vertex. */
export function featurePoint(feature) {
  const geometry = feature?.geometry;
  const outline =
    geometry?.type === 'Point'
      ? [geometry.coordinates]
      : geometry?.type === 'LineString'
        ? geometry.coordinates
        : geometry?.type === 'Polygon'
          ? geometry.coordinates?.[0]
          : geometry?.type === 'MultiPolygon'
            ? geometry.coordinates?.[0]?.[0]
            : null;
  const points = (outline || []).filter(
    (point) => Number.isFinite(point?.[0]) && Number.isFinite(point?.[1]),
  );
  if (!points.length) return null;
  return {
    lon: points.reduce((sum, point) => sum + point[0], 0) / points.length,
    lat: points.reduce((sum, point) => sum + point[1], 0) / points.length,
  };
}

/** Read the bundled layers' analyst records through a supplied transport. */
export function createInfrastructureSource({
  fetchImpl = (...args) => globalThis.fetch(...args),
} = {}) {
  const cache = new Map();
  return {
    async getRecords(layerId, { signal } = {}) {
      const url = INFRASTRUCTURE_DATA_URLS[layerId];
      if (!url) throw new TypeError(`Unknown infrastructure layer: ${layerId}`);
      if (!cache.has(layerId)) {
        signal?.throwIfAborted();
        const response = await fetchImpl(url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const records = parseGeojsonLines(await response.text()).flatMap(
          (feature) => {
            const point = featurePoint(feature);
            return point
              ? [
                  mapAnalystRecord(
                    {
                      id: feature.properties?.osm_id ?? feature.id,
                      ...point,
                      properties: feature.properties,
                    },
                    layerId,
                  ),
                ]
              : [];
          },
        );
        cache.set(layerId, records);
      }
      return cache.get(layerId);
    },
  };
}
