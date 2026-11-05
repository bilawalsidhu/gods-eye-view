import * as Cesium from 'cesium';
import { containmentAccent } from '../cards.js';
import { createZonesCesiumRenderer } from '../../shared/render/cesiumZones.js';
/** Fill/line color for a perimeter by containment progress (same ramp as the card accent). */
export function containmentColor(containedPct) {
  return Cesium.Color.fromCssColorString(containmentAccent(containedPct));
}

export function createPerimetersCesiumRenderer({
  viewer,
  screenSpaceEventHandlerFactory,
}) {
  return createZonesCesiumRenderer({
    viewer,
    screenSpaceEventHandlerFactory,
    name: 'fire-perimeters',
    idPrefix: 'fire-perimeter',
    colorOf: (row) => containmentAccent(row.containedPct),
  });
}
