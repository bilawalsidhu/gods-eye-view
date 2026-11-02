import * as geo from '../../../geo/index.js';
import { distanceToSegment } from '../../../globe/cpuPicks.js';
import { containsGroundPoint } from './groundRing.js';

function groundScreen(engine, [lon, lat]) {
  const point = geo.cartographic.fromDegrees(lon, lat);
  const height = engine.surface.terrainHeight(point) ?? 0;
  const position = geo.cartesian3.fromDegrees(lon, lat, height);
  return (
    engine.projector.horizonVisible(position) &&
    engine.projector.worldToWindow(position, {})
  );
}

// The GPU may return the preceding gesture's vector feature. Resolve against
// the current gesture and let the engine arbitrate the result with sibling layers.
export function bindGroundShapePicks(engine, owner, shapes) {
  const regions = [];
  for (const { id, geometry, style } of shapes) {
    const coords =
      geometry.type === 'point'
        ? [geometry.position]
        : geometry.type === 'line'
          ? geometry.positions
          : geometry.outer;
    const west = coords[0][0];
    const local = (lon) => lon - west - 360 * Math.round((lon - west) / 360);
    let south = 90,
      north = -90,
      min = Infinity,
      max = -Infinity;
    for (const [lon, lat] of coords) {
      south = Math.min(south, lat);
      north = Math.max(north, lat);
      min = Math.min(min, local(lon));
      max = Math.max(max, local(lon));
    }
    regions.push({
      geometry,
      style,
      coords,
      south,
      north,
      min,
      max,
      local,
      id,
    });
  }
  const pick = (at) => {
    const world = engine.picker.pickGlobe(at);
    if (!world) return [];
    const carto = geo.cartographic.fromCartesian(world);
    const lon = geo.math.toDegrees(carto.longitude),
      lat = geo.math.toDegrees(carto.latitude);
    const depth = geo.cartesian3.distance(world, engine.camera.livePosition);
    const pose = engine.camera.pose();
    // Conservative geographic margin for a displaced terrain pixel/marker at this zoom.
    const margin =
      (2 * Math.tan(pose.fovy / 2) * depth * 32) /
      Math.max(1, engine.host.size().height) /
      110000;
    const lonMargin = margin / Math.max(0.00001, Math.cos(carto.latitude));
    const hits = [];
    for (const region of regions) {
      const x = region.local(lon);
      if (
        lat < region.south - margin ||
        lat > region.north + margin ||
        (region.max - region.min < 180 &&
          (x < region.min - lonMargin || x > region.max + lonMargin))
      )
        continue;
      const { geometry, style, coords } = region;
      let hit = false;
      if (geometry.type === 'point') {
        const screen = groundScreen(engine, geometry.position);
        const size = style.pointRadius ?? 7;
        hit =
          screen &&
          Math.abs(at.x - screen.x) <= size &&
          Math.abs(at.y - screen.y) <= size;
      } else {
        if (geometry.type === 'polygon' && style.fill !== false)
          hit =
            containsGroundPoint(coords, lon, lat) &&
            !geometry.holes.some((ring) => containsGroundPoint(ring, lon, lat));
        if (!hit && (geometry.type === 'line' || style.outline !== false)) {
          let last =
            geometry.type === 'polygon'
              ? groundScreen(engine, coords.at(-1))
              : null;
          for (const coord of coords) {
            const next = groundScreen(engine, coord);
            if (
              last &&
              next &&
              distanceToSegment(at, last, next) <=
                Math.max(2, Math.min(8, style.lineWidth ?? 2) / 2)
            ) {
              hit = true;
              break;
            }
            last = next;
          }
        }
      }
      if (hit)
        hits.push({
          onTop: 0,
          order: geometry.type === 'point' ? 1 : 0,
          depth,
          result: { id: region.id, owner },
        });
    }
    return hits;
  };
  return engine.picker.registerMeshPicker(pick);
}
