import * as Cesium from 'cesium';

/**
 * Tectonic plate boundaries layer.
 *
 * First step: lifecycle only.
 * No network requests and no plate data yet.
 */
const BOUNDARY_TYPES = Object.freeze({
  'Convergent Boundary': 'convergent',
  'Divergent Boundary': 'divergent',
  'Transform Boundary': 'transform',
});

/**
 * Convert the USGS boundary label into a stable internal value.
 * Unknown labels stay usable as "other" instead of crashing the layer.
 *
 * @param {unknown} label
 * @returns {'convergent'|'divergent'|'transform'|'other'}
 */
export function normalizeBoundaryType(label) {
  return BOUNDARY_TYPES[String(label || '').trim()] || 'other';
}

/**
 * Validate and normalize a USGS tectonic-plate GeoJSON snapshot.
 *
 * The returned records contain only plain JS values.
 * No Cesium objects are created here.
 *
 * @param {unknown} geojson
 * @returns {Array<{
 *   id: string,
 *   name: string|null,
 *   boundaryType: 'convergent'|'divergent'|'transform'|'other',
 *   sourceLabel: string|null,
 *   coordinates: Array<[number, number]>
 * }> | null}
 */
export function normalizeTectonicPlateSnapshot(geojson) {
  if (!Array.isArray(geojson?.features)) {
    return null;
  }

  const rows = [];
  const ids = new Set();

  for (const [index, feature] of geojson.features.entries()) {
    if (feature?.type !== 'Feature') {
      return null;
    }

    const geometryType = feature?.geometry?.type;

    if (geometryType !== 'LineString' && geometryType !== 'MultiLineString') {
      return null;
    }

    const rawPaths = geometryType === 'LineString'
      ? [feature.geometry.coordinates]
      : feature.geometry.coordinates;

    if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
      return null;
    }

    const normalizedPaths = [];

    for (const path of rawPaths) {
      if (!Array.isArray(path) || path.length < 2) {
        return null;
      }

      const normalizedCoordinates = [];

      for (const coordinate of path) {
        if (!Array.isArray(coordinate) || coordinate.length < 2) {
          return null;
        }

       const [lon, lat] = coordinate;

      const COORD_EPSILON = 1e-6;

        if (
          !Number.isFinite(lon)
  ||      !Number.isFinite(lat)
  ||      Math.abs(lon) > 180 + COORD_EPSILON
  ||      Math.abs(lat) > 90 + COORD_EPSILON
) {
  return null;
}

    const normalizedLon = Math.max(-180, Math.min(180, lon));
    const normalizedLat = Math.max(-90, Math.min(90, lat));

      normalizedCoordinates.push([normalizedLon, normalizedLat]);
      }

      normalizedPaths.push(normalizedCoordinates);
    }

    const rawId =
      feature.id
      ?? feature.properties?.OBJECTID
      ?? `feature-${index + 1}`;

    const id = String(rawId);

    if (ids.has(id)) {
      return null;
    }

    ids.add(id);

    const rawName = feature.properties?.NAME;
    const rawLabel = feature.properties?.LABEL;

    for (const [pathIndex, coordinates] of normalizedPaths.entries()) {
      const rowId = normalizedPaths.length === 1
        ? id
        : `${id}:${pathIndex + 1}`;

      rows.push({
        id: rowId,
        name: typeof rawName === 'string' && rawName.trim()
          ? rawName.trim()
          : null,
        boundaryType: normalizeBoundaryType(rawLabel),
        sourceLabel: typeof rawLabel === 'string' && rawLabel.trim()
          ? rawLabel.trim()
          : null,
        coordinates,
      });
    }
  }

  return rows;
}
const USGS_PLATES_QUERY_URL =
  'https://earthquake.usgs.gov/arcgis/rest/services/eq/map_plateboundaries/MapServer/1/query';

const PAGE_SIZE = 1000;

/**
 * Fetch all tectonic plate boundary features from USGS with pagination.
 *
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<object>}
 */
export async function fetchAllTectonicPlateGeoJson(fetchImpl = fetch) {
  const features = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      where: '1=1',
      outFields: '*',
      returnGeometry: 'true',
      outSR: '4326',
      orderByFields: 'OBJECTID ASC',
      resultOffset: String(offset),
      resultRecordCount: String(PAGE_SIZE),
      f: 'geojson',
    });

    const response = await fetchImpl(`${USGS_PLATES_QUERY_URL}?${params}`);

    if (!response.ok) {
      throw new Error(`USGS HTTP ${response.status}`);
    }

    const page = await response.json();

    if (!Array.isArray(page?.features)) {
      throw new Error('Malformed USGS tectonic-plates response');
    }

    features.push(...page.features);

    if (page.features.length < PAGE_SIZE) {
      break;
    }

    offset += PAGE_SIZE;
  }

  return {
    type: 'FeatureCollection',
    features,
  };
}
export function createTectonicPlatesLayer() {
  let _dataSource = null;
  let _enabled = false;
  let _count = 0;
  let _lastError = null;

  return {
    id: 'tectonic-plates',
    name: 'Tectonic Plates',
    icon: '◫',
    source: 'USGS',
    updateInterval: 0,

    init(viewer) {
      _dataSource = new Cesium.CustomDataSource('tectonic-plates');
      _dataSource.show = false;
      viewer.dataSources.add(_dataSource);

      _enabled = false;
      _count = 0;
      _lastError = null;

      console.log('[Data:TectonicPlates] Initialized');
    },

    enable() {
      _enabled = true;

      if (_dataSource) {
        _dataSource.show = true;
      }
    },

    disable() {
      _enabled = false;

      if (_dataSource) {
        _dataSource.show = false;
      }
    },

    update() {
      return true;
    },

    destroy(viewer) {
      if (_dataSource) {
        viewer.dataSources.remove(_dataSource, true);
        _dataSource = null;
      }

      _enabled = false;
      _count = 0;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        enabled: _enabled,
        source: 'USGS',
        error: _lastError,
      };
    },
  };
}

export default createTectonicPlatesLayer();