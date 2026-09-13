import * as Cesium from 'cesium';

/**
 * Tectonic plate boundaries layer.
 *
 * First step: lifecycle only.
 * No network requests and no plate data yet.
 */
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