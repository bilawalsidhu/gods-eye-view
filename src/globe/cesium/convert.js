// The geo ↔ Cesium boundary of the Cesium engine: Cesium values in, fresh
// src/geo values out, so no Cesium instance reaches the shell.

import * as Cesium from 'cesium';
import * as geo from '../../geo/index.js';

/** A fresh geo Cartesian3 from any {x, y, z}, or undefined. */
export const toGeo3 = (value) =>
  value ? geo.cartesian3.create(value.x, value.y, value.z) : undefined;

/** A fresh geo Cartesian2 from any {x, y}, or undefined. */
export const toGeo2 = (value) =>
  value ? geo.cartesian2.create(value.x, value.y) : undefined;

/** A new Cesium.Cartesian3 for a Cesium call. */
export const toCesium3 = (value) =>
  new Cesium.Cartesian3(value.x, value.y, value.z);

/**
 * A new Cesium.Cartesian2 for a window position. Always a new instance: Cesium
 * caches pickPosition by windowPosition.toString().
 */
export const toCesium2 = (value) => new Cesium.Cartesian2(value.x, value.y);
