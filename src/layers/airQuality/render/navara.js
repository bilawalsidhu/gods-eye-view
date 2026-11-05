import { createNavaraPolygonDisplay } from '../../shared/render/navaraPolygons.js';
import * as geo from '../../../geo/index.js';

function stationFeature(reading, radius) {
  const origin = geo.cartesian3.fromDegrees(reading.lon, reading.lat);
  const frame = geo.transforms.eastNorthUpToFixedFrame(origin);
  const ring = [];
  for (let i = 0; i < 48; i++) {
    const angle = (i * 2 * Math.PI) / 48;
    const local = geo.cartesian3.create(
      radius * Math.cos(angle),
      radius * Math.sin(angle),
      0,
    );
    const world = geo.matrix4.multiplyByPoint(
      frame,
      local,
      geo.cartesian3.create(),
    );
    const point = geo.cartographic.fromCartesian(world);
    ring.push([
      geo.math.toDegrees(point.longitude),
      geo.math.toDegrees(point.latitude),
    ]);
  }
  ring.push(ring[0]);
  return {
    type: 'Feature',
    id: `air-quality:${reading.id}`,
    properties: { ...reading },
    geometry: { type: 'Polygon', coordinates: [ring] },
  };
}

/** One native GeoJSON layer per AQHI colour, independent of station count. */
export function createAirQualityNavaraRenderer(engine, { view }) {
  const display = createNavaraPolygonDisplay(engine, view, (color) => ({
    polygon: {
      color,
      transparent: true,
      opacity: 0.35,
      clampToGround: true,
      outline: true,
      outlineShow: true,
      outlineColor: color,
      outlineWidth: 2,
    },
  }));
  return {
    viewRectangle: () => engine.camera.viewRectangle(),
    setVisible: display.setVisible,
    destroy: display.destroy,
    replace(rows, radius) {
      const groups = new Map();
      for (const row of rows) {
        if (!groups.has(row.color)) groups.set(row.color, []);
        groups.get(row.color).push(stationFeature(row, radius));
      }
      display.replace(groups);
    },
  };
}
