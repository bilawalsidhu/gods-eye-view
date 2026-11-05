import * as Cesium from 'cesium';
import {
  COLOR_NEUTRAL,
  POINT_HEIGHT_OFFSET_M,
  COLOR_OUTLINE,
} from '../../policy.js';
import { createStationPoints } from '../../stationPoints.js';

export function createRendering(context) {
  const { state: layerState } = context;

  /**
   * Create a Cartesian3 position for a station, terrain-clamped when possible.
   * Falls back to a fixed small height offset if terrain sampling is unsupported.
   * @param {Object} station - Station info object with lat/lon.
   * @returns {Cesium.Cartesian3|null} World position, or null if coordinates are invalid.
   */

  function createStationPosition(station) {
    const lon = Number(station?.lon);
    const lat = Number(station?.lat);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

    let height = POINT_HEIGHT_OFFSET_M;
    // Sample terrain height so points sit on ground rather than at ellipsoid level
    if (layerState._viewer?.scene?.sampleHeightSupported) {
      const carto = Cesium.Cartographic.fromDegrees(lon, lat);
      const sampled = layerState._viewer.scene.sampleHeight(carto);
      if (Number.isFinite(sampled)) {
        height = sampled + POINT_HEIGHT_OFFSET_M;
      }
    }

    return Cesium.Cartesian3.fromDegrees(lon, lat, height);
  }

  return createStationPoints(context, {
    position: createStationPosition,
    // A point primitive with distance-based scale and translucency falloff
    create: (record, { position, pixelSize }) =>
      layerState._pointCollection.add({
        position,
        pixelSize,
        color: COLOR_NEUTRAL,
        outlineColor: COLOR_OUTLINE,
        outlineWidth: 1,
        scaleByDistance: new Cesium.NearFarScalar(200, 1.35, 130000, 0.4),
        translucencyByDistance: new Cesium.NearFarScalar(
          200,
          1.0,
          180000,
          0.15,
        ),
        disableDepthTestDistance: 2500,
        id: record.key,
      }),
    remove: (record) => layerState._pointCollection.remove(record.point),
  });
}
