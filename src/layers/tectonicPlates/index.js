import * as Cesium from 'cesium';

/**
 * Visual style for each tectonic boundary type.
 */
const BOUNDARY_STYLES = Object.freeze({
  convergent: Object.freeze({
    color: Cesium.Color.fromCssColorString('#ff5a5f'),
    width: 3,
  }),
  divergent: Object.freeze({
    color: Cesium.Color.fromCssColorString('#4dd0e1'),
    width: 3,
  }),
  transform: Object.freeze({
    color: Cesium.Color.fromCssColorString('#ffd166'),
    width: 3,
  }),
  other: Object.freeze({
    color: Cesium.Color.fromCssColorString('#b0bec5'),
    width: 2,
  }),
});

function styleForBoundaryType(type) {
  return BOUNDARY_STYLES[type] || BOUNDARY_STYLES.other;
}

/**
 * Own the tectonic-plate boundary display and its lifecycle.
 *
 * The source owns networking + normalization.
 * This module only owns Cesium rendering and layer state.
 */
export function createTectonicPlatesLayer({ source } = {}) {
  if (typeof source?.getSnapshot !== 'function') {
    throw new TypeError('Tectonic plates require a snapshot source');
  }

  let _viewer = null;
  let _dataSource = null;
  let _request = null;
  let _enabled = false;
  let _count = 0;
  let _lastUpdate = null;
  let _lastError = null;

  return {
    id: 'tectonic-plates',
    name: 'Tectonic Plate Boundaries',
    icon: '◫',
    source: 'USGS',
    showInTogglePanel: true,
    updateInterval: 0,

    init(viewer) {
      if (_viewer) {
        throw new Error('Tectonic plates layer is already initialized');
      }

      _viewer = viewer;

      _dataSource = new Cesium.CustomDataSource('tectonic-plates');
      _dataSource.show = false;

      viewer.dataSources.add(_dataSource);

      _enabled = false;
      _count = 0;
      _lastUpdate = null;
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
      _request?.abort();
      _request = null;

      _enabled = false;

      if (_dataSource) {
        _dataSource.show = false;
      }
    },

    async update() {
      if (!_enabled || !_dataSource) {
        return false;
      }

      _request?.abort();

      const request = new AbortController();
      _request = request;

      try {
        const rows = await source.getSnapshot({
          signal: request.signal,
        });

        if (
          request.signal.aborted
          || _request !== request
          || !_enabled
        ) {
          return false;
        }

        const nextEntities = [];

        for (const row of rows) {
          const style = styleForBoundaryType(row.boundaryType);

          const positions = Cesium.Cartesian3.fromDegreesArray(
            row.coordinates.flatMap(([lon, lat]) => [lon, lat]),
          );

          nextEntities.push(
            new Cesium.Entity({
              id: `tectonic-plate:${row.id}`,

              polyline: {
                positions,
                width: style.width,
                material: style.color,
                clampToGround: true,
              },

              properties: {
                name: row.name,
                boundaryType: row.boundaryType,
                sourceLabel: row.sourceLabel,
              },
            }),
          );
        }

        _dataSource.entities.removeAll();

        for (const entity of nextEntities) {
          _dataSource.entities.add(entity);
        }

        _count = nextEntities.length;
        _lastUpdate = Date.now();
        _lastError = null;

        console.log(
          `[Data:TectonicPlates] Updated: ${_count} boundary segments`,
        );

        return true;
      } catch (error) {
        if (
          request.signal.aborted
          || _request !== request
          || !_enabled
        ) {
          return false;
        }

        console.warn(
          '[Data:TectonicPlates] Fetch error:',
          error,
        );

        _lastError =
          error?.message || 'Tectonic plate source unavailable';

        return false;
      } finally {
        if (_request === request) {
          _request = null;
        }
      }
    },

    destroy(viewer = _viewer) {
      _request?.abort();
      _request = null;

      _enabled = false;

      if (_dataSource && viewer) {
        viewer.dataSources.remove(_dataSource, true);
      }

      _dataSource = null;
      _viewer = null;
      _count = 0;
      _lastUpdate = null;
      _lastError = null;
    },

    getStats() {
      return {
        count: _count,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
}