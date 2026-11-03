/**
 * @module alpr/markerState
 * @description The ALPR layer's own per-marker state, held in Core rather than on the
 * Cesium entities it draws:
 * - `record`: the camera record the marker shows.
 * - `clamped`: whether the marker sits on the surface rather than at its height.
 * - `canvasPosition`, `displayPosition`: the canvas anchor and the position the card reads.
 * - `wedge`: the direction wedge's positions.
 * - `nativeAppearance`, `pickPosition`: the native look saved while the canvas draws it.
 * - `shown`, `surfaceCheckedFor`: the last visibility applied and the anchor last checked.
 */
import { createEntityStore } from '../../data/entityRecords.js';

export const alprMarkers = createEntityStore();
