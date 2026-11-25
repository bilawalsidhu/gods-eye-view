/**
 * Cesium rendering logic for ABYSS bathymetry imagery and deep-sea features.
 */

import * as Cesium from 'cesium';
import { BATHYMETRY_PRODUCTS, ventColor, ABYSS_COLORS } from './model.js';

export function createAbyssRenderer({ viewer } = {}) {
  let _imageryLayer = null;
  let _dataSource = null;
  let _trackDataSource = null;
  let _currentProduct = BATHYMETRY_PRODUCTS.COLOUR_SHADED;
  let _bathymetryVisible = true;
  let _subseaVisible = true;

  function init(targetViewer) {
    const v = targetViewer || viewer;
    if (!v) return;

    if (!_dataSource) {
      _dataSource = new Cesium.CustomDataSource('abyss-features');
      _dataSource.show = false;
      v.dataSources.add(_dataSource);
    }

    if (!_trackDataSource) {
      _trackDataSource = new Cesium.CustomDataSource('abyss-dive-tracks');
      _trackDataSource.show = false;
      v.dataSources.add(_trackDataSource);
    }
  }

  function setBathymetryVisible(visible, bathymetryConfig) {
    _bathymetryVisible = Boolean(visible);
    if (!viewer?.imageryLayers) return;

    if (!_bathymetryVisible) {
      if (_imageryLayer) {
        viewer.imageryLayers.remove(_imageryLayer, true);
        _imageryLayer = null;
      }
      return;
    }

    if (!_imageryLayer && bathymetryConfig) {
      updateBathymetryLayer(bathymetryConfig, _currentProduct);
    } else if (_imageryLayer) {
      _imageryLayer.show = true;
    }
  }

  function updateBathymetryLayer(
    config,
    productName = BATHYMETRY_PRODUCTS.COLOUR_SHADED,
  ) {
    if (!viewer?.imageryLayers) return;
    _currentProduct = productName;

    if (_imageryLayer) {
      viewer.imageryLayers.remove(_imageryLayer, true);
      _imageryLayer = null;
    }

    if (!_bathymetryVisible) return;

    try {
      const provider = new Cesium.WebMapServiceImageryProvider({
        url: config.url || 'https://wms.gebco.net/mapserv?',
        layers: productName,
        parameters: {
          service: 'WMS',
          version: config.version || '1.3.0',
          request: 'GetMap',
          format: config.format || 'image/jpeg',
          transparent: false,
        },
        credit: new Cesium.Credit(
          'Bathymetry: <a href="https://www.gebco.net" target="_blank" rel="noopener">GEBCO</a>',
          false,
        ),
      });

      _imageryLayer = viewer.imageryLayers.addImageryProvider(provider);
      _imageryLayer.alpha = 0.85;
      _imageryLayer.show = true;
    } catch (err) {
      console.warn(
        '[ABYSS:Renderer] Failed to initialize GEBCO WMS layer:',
        err,
      );
    }
  }

  function renderFeatures({ vents = [], dives = [] } = {}) {
    if (!_dataSource) return;
    _dataSource.entities.removeAll();

    // Render Hydrothermal Vents
    for (const vent of vents) {
      const colorHex = ventColor(vent.activity);
      const position = Cesium.Cartesian3.fromDegrees(vent.lon, vent.lat);
      const entity = _dataSource.entities.add({
        id: vent.id,
        name: vent.name,
        position,
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString(colorHex),
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 1.5,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            20_000_000,
          ),
        },
      });
      entity.__gevAbyssRecord = vent;
    }

    // Render NOAA Ocean Exploration ROV Dives
    for (const dive of dives) {
      const position = Cesium.Cartesian3.fromDegrees(dive.lon, dive.lat);
      const entity = _dataSource.entities.add({
        id: dive.id,
        name: dive.name,
        position,
        point: {
          pixelSize: 8,
          color: Cesium.Color.fromCssColorString(ABYSS_COLORS.DIVE_MARKER),
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1.5,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(
            0,
            20_000_000,
          ),
        },
      });
      entity.__gevAbyssRecord = dive;
    }
  }

  function renderSelectedTrack(trackRecord) {
    if (!_trackDataSource) return;
    _trackDataSource.entities.removeAll();
    if (!trackRecord?.paths || trackRecord.paths.length === 0) return;

    for (let i = 0; i < trackRecord.paths.length; i++) {
      const pathCoords = trackRecord.paths[i];
      if (!Array.isArray(pathCoords) || pathCoords.length < 2) continue;

      const flatCoords = pathCoords.flat();
      const positions = Cesium.Cartesian3.fromDegreesArray(flatCoords);

      const entity = _trackDataSource.entities.add({
        id: `${trackRecord.id}-path-${i}`,
        polyline: {
          positions,
          width: 3.5,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.fromCssColorString(ABYSS_COLORS.DIVE_TRACK),
          }),
          clampToGround: false,
        },
      });
      entity.__gevAbyssRecord = trackRecord;
    }
  }

  function clearSelectedTrack() {
    _trackDataSource?.entities.removeAll();
  }

  function setVisibility(enabled) {
    if (_dataSource) _dataSource.show = enabled && _subseaVisible;
    if (_trackDataSource) _trackDataSource.show = enabled && _subseaVisible;
    if (_imageryLayer) _imageryLayer.show = enabled && _bathymetryVisible;
  }

  function setSubseaFeaturesVisible(visible) {
    _subseaVisible = Boolean(visible);
    if (_dataSource) _dataSource.show = _subseaVisible;
    if (_trackDataSource) _trackDataSource.show = _subseaVisible;
  }

  function destroy() {
    if (_imageryLayer && viewer?.imageryLayers) {
      viewer.imageryLayers.remove(_imageryLayer, true);
      _imageryLayer = null;
    }
    if (_dataSource && viewer?.dataSources) {
      viewer.dataSources.remove(_dataSource, true);
      _dataSource = null;
    }
    if (_trackDataSource && viewer?.dataSources) {
      viewer.dataSources.remove(_trackDataSource, true);
      _trackDataSource = null;
    }
  }

  return Object.freeze({
    init,
    setBathymetryVisible,
    updateBathymetryLayer,
    renderFeatures,
    renderSelectedTrack,
    clearSelectedTrack,
    setVisibility,
    setSubseaFeaturesVisible,
    destroy,
    getImageryLayer: () => _imageryLayer,
    getDataSource: () => _dataSource,
    getTrackDataSource: () => _trackDataSource,
    getCurrentProduct: () => _currentProduct,
  });
}
