import * as geo from '../../../geo/index.js';
import { createNavaraPolygonDisplay } from '../../shared/render/navaraPolygons.js';
import { containmentAccent } from '../cards.js';

// A fire ring is local, including across 180°. Put the click and ring in
// the same longitude interval before casting the ray.
function contains(ring, lon, lat) {
  const origin = ring[0][0];
  const local = (x) => x - origin - 360 * Math.round((x - origin) / 360);
  const x = local(lon);
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [ax, ay] = ring[j],
      [bx, by] = ring[i];
    if (ay > lat === by > lat) continue;
    const a = local(ax),
      b = local(bx);
    if (x < a + ((b - a) * (lat - ay)) / (by - ay)) inside = !inside;
  }
  return inside;
}

export function createPerimetersNavaraRenderer(engine, { view }) {
  let polygons = [];
  const display = createNavaraPolygonDisplay(engine, view, (color, show) => ({
    polygon: {
      color,
      show,
      clampToGround: true,
      transparent: true,
      opacity: 0.25,
    },
    polyline: {
      color,
      show,
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
        const color = containmentAccent(row.containedPct);
        if (!groups.has(color)) groups.set(color, []);
        for (const [index, rings] of row.polygons.entries()) {
          const id = `fire-perimeter:${row.stableId}:${index}`;
          const properties = { incident: row.stableId };
          const group = groups.get(color);
          group.push(
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
      // Perimeters never claim a sibling pick. The input port shares the
      // native click result with other consumers of the same gesture.
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
          contains(rings[0], lon, lat) &&
          !rings.slice(1).some((ring) => contains(ring, lon, lat))
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
