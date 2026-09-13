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

    if (feature?.geometry?.type !== 'LineString') {
      return null;
    }

    const coordinates = feature.geometry.coordinates;

    if (!Array.isArray(coordinates) || coordinates.length < 2) {
      return null;
    }

    const normalizedCoordinates = [];

    for (const coordinate of coordinates) {
      if (!Array.isArray(coordinate) || coordinate.length < 2) {
        return null;
      }

      const [lon, lat] = coordinate;

      if (
        !Number.isFinite(lon)
        || !Number.isFinite(lat)
        || Math.abs(lon) > 180
        || Math.abs(lat) > 90
      ) {
        return null;
      }

      normalizedCoordinates.push([lon, lat]);
    }

    const rawId = feature.id ?? feature.properties?.OBJECTID ?? `feature-${index + 1}`;
    const id = String(rawId);

    if (ids.has(id)) {
      return null;
    }

    ids.add(id);

    const rawName = feature.properties?.NAME;
    const rawLabel = feature.properties?.LABEL;

    rows.push({
      id,
      name: typeof rawName === 'string' && rawName.trim()
        ? rawName.trim()
        : null,
      boundaryType: normalizeBoundaryType(rawLabel),
      sourceLabel: typeof rawLabel === 'string' && rawLabel.trim()
        ? rawLabel.trim()
        : null,
      coordinates: normalizedCoordinates,
    });
  }

  return rows;
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