import * as Cesium from 'cesium';
import { msg, t } from '../../i18n/index.js';
import { translateFeedError } from '../../ui/statusText.js';
import { IGN_DESCRIPTION, IGN_RASTER_LAYERS } from './model.js';
export * from './model.js';
export { createIgnGeoplateformeSource } from './source.js';

/**
 * Own one topographic imagery overlay and its refresh lifecycle.
 *
 * This layer contributes a tile template rather than entities: the globe asks
 * the LOCAL proxy for each tile, and the proxy resolves the upstream IGN URL
 * from its own allow-list. The browser never names an upstream URL.
 *
 * The VECTOR cadastre is deliberately not offered: the Géoplateforme serves
 * it over WMS GetMap, which answers 500 for many requests. The layer says so
 * in its row instead of offering a link that fails.
 */
export function createIgnGeoplateformeLayer({ source } = {}) {
  if (typeof source?.getDescriptor !== 'function')
    throw new TypeError('IGN Geoplateforme requires a descriptor source');
  let _viewer = null;
  let _imagery = null;
  let _imageryLayer = null;
  let _rasterLayer = IGN_RASTER_LAYERS[0].id;
  let _enabled = false;
  let _lastUpdate = null;
  let _lastError = null;
  let rowControlsListener = null;

  const notify = () => rowControlsListener?.();

  const layer = {
    id: 'ign-geoplateforme',
    name: 'IGN Plan IGN',
    icon: '🗺️',
    // The DATASET name only. The operator (IGN Géoplateforme) and the
    // licence live in DATA_SOURCES.md and the in-app credits.
    source: 'IGN',
    updateInterval: 0,

    init(viewer) {
      if (_viewer) throw new Error('IGN layer is already initialized');
      _viewer = viewer;
      _enabled = false;
      _lastUpdate = null;
      _lastError = null;
    },

    enable(viewer = _viewer) {
      if (!viewer) throw new Error('IGN layer is not initialized');
      _enabled = true;
      try {
        this._applyImagery(viewer);
        _lastError = null;
        _lastUpdate = Date.now();
      } catch (error) {
        console.warn('[Data:IGN] Enable error:', error);
        _lastError = error?.message || msg('IGN imagery unavailable');
      }
      notify();
    },

    /**
     * Put the chosen raster layer on the globe.
     *
     * The provider is rebuilt when the layer changes: a tile template names
     * its raster layer in the URL, so a different layer is a different
     * template and not a different setting on the same one.
     *
     * @param {Cesium.Viewer} viewer The globe.
     */
    _applyImagery(viewer) {
      const descriptor = source.getDescriptor(_rasterLayer);
      if (_imagery && _imageryLayer === _rasterLayer) {
        _imagery.show = true;
        return;
      }
      if (_imagery) {
        viewer.imageryLayers.remove(_imagery);
        _imagery = null;
      }
      _imagery = new Cesium.UrlTemplateImageryProvider({
        url: descriptor.url,
        maximumLevel: descriptor.maximumLevel ?? 19,
        credit: descriptor.credit ?? msg('IGN Géoplateforme'),
      });
      _imageryLayer = _rasterLayer;
      viewer.imageryLayers.addImageryProvider(_imagery);
      _imagery.show = true;
    },

    disable(viewer = _viewer) {
      _enabled = false;
      if (_imagery) _imagery.show = false;
      notify();
    },

    async update() {
      // The imagery provider fetches tiles on its own; there is nothing to
      // poll. The layer is a pure overlay.
      if (!_enabled) return false;
      return true;
    },

    destroy(viewer = _viewer) {
      _enabled = false;
      if (_imagery && viewer) {
        try {
          viewer.imageryLayers.remove(_imagery);
        } catch {
          // The layer may already be gone with the viewer.
        }
      }
      _imagery = null;
      _viewer = null;
      _lastUpdate = null;
      _lastError = null;
      rowControlsListener = null;
    },

    /**
     * Switch the raster layer the basemap draws.
     *
     * @param {{raster?: string}} params Layer parameters.
     * @returns {boolean} True when the parameters were accepted.
     */
    setParams(params = {}) {
      if (!params || typeof params !== 'object') return false;
      const raster = String(params.raster ?? '').trim();
      if (!raster) return false;
      if (!IGN_RASTER_LAYERS.some((entry) => entry.id === raster)) return false;
      if (raster === _rasterLayer) return true;
      _rasterLayer = raster;
      if (_enabled && _viewer) {
        try {
          this._applyImagery(_viewer);
          _lastError = null;
          _lastUpdate = Date.now();
        } catch (error) {
          console.warn('[Data:IGN] Layer switch error:', error);
          _lastError = error?.message || msg('IGN imagery unavailable');
        }
      }
      notify();
      return true;
    },

    /**
     * The row's chips: the raster layers the Géoplateforme publishes.
     *
     * The layer stays in the Layers panel as a row of its own; the chips
     * pick WHICH raster basemap that row draws, which is the choice a
     * raster overlay actually offers.
     */
    getRowControls() {
      return {
        chips: IGN_RASTER_LAYERS.map((entry) => ({
          id: entry.id,
          label: t(entry.label),
          active: _rasterLayer === entry.id,
          title: t(
            'The Géoplateforme raster basemap. The vector cadastre is not offered: it is served over WMS GetMap, which answers 500 for many requests.',
          ),
          params: { raster: entry.id },
        })),
        info: _lastError
          ? translateFeedError(_lastError)
          : _enabled
            ? t('Raster tiles · vector cadastre unavailable')
            : t('Off'),
        infoTitle: t(IGN_DESCRIPTION),
      };
    },

    setRowControlsListener(listener) {
      rowControlsListener = typeof listener === 'function' ? listener : null;
    },

    getStats() {
      return {
        // An imagery overlay has no countable entities; the count is the
        // number of tile layers the globe is showing.
        count: _imagery && _imagery.show ? 1 : 0,
        lastUpdate: _lastUpdate,
        error: _lastError,
      };
    },
  };
  return layer;
}
