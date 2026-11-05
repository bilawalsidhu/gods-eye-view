import * as geo from '../../../geo/index.js';
import { createNavaraPolygonDisplay } from './navaraPolygons.js';
import { containsGroundPoint } from './groundRing.js';

/**
 * Ground zones on Navara, as cesiumZones.js draws them on Cesium: each row's
 * polygons as a translucent fill under a ground-clamped outline in the row's
 * CSS colour (`colorOf(row)`), picked by a ground point inside the outline
 * and outside its holes (`{ id: '${idPrefix}:${stableId}:${index}' }`).
 */
export function createZonesNavaraRenderer(
  engine,
  { view },
  { idPrefix, colorOf },
) {
  let polygons = [];
  const display = createNavaraPolygonDisplay(engine, view, (color) => ({
    polygon: {
      color,
      clampToGround: true,
      transparent: true,
      opacity: 0.25,
    },
    polyline: {
      color,
      clampToGround: true,
      width: 2,
      transparent: true,
      opacity: 0.9,
    },
  }));
  return {
    setVisible: display.setVisible,
    replace(rows) {
      const groups = new Map(),
        next = [];
      for (const row of rows) {
        const color = colorOf(row);
        if (!groups.has(color)) groups.set(color, []);
        for (const [index, rings] of row.polygons.entries()) {
          const id = `${idPrefix}:${row.stableId}:${index}`;
          const properties = { zone: row.stableId };
          groups.get(color).push(
            {
              type: 'Feature',
              id,
              properties,
              geometry: { type: 'Polygon', coordinates: rings },
            },
            {
              type: 'Feature',
              id: id + '-outline',
              properties,
              geometry: { type: 'LineString', coordinates: rings[0] },
            },
          );
          next.push({ id, rings });
        }
      }
      display.replace(groups);
      polygons = next;
    },
    onClick(callback) {
      // Zones never claim a sibling pick. The input port shares the native
      // click result with other consumers of the same gesture.
      return engine.input.on('click', callback, { pick: true });
    },
    pick(event) {
      if (event.picked) return event.picked;
      const point = engine.picker.pickGlobe(event.position);
      if (!point) return null;
      const pos = geo.cartographic.fromCartesian(point);
      const lon = geo.math.toDegrees(pos.longitude),
        lat = geo.math.toDegrees(pos.latitude);
      for (let i = polygons.length - 1; i >= 0; i--) {
        const { id, rings } = polygons[i];
        if (
          containsGroundPoint(rings[0], lon, lat) &&
          !rings.slice(1).some((ring) => containsGroundPoint(ring, lon, lat))
        )
          return { id };
      }
      return null;
    },
    destroy() {
      polygons = [];
      display.destroy();
    },
  };
}
