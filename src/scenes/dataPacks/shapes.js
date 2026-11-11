// Pack polygons and image rectangles as indexed world triangles.
import earcut from 'earcut';
import * as geo from '../../geo/index.js';

// Cesium's default granularity: no edge or cell spans more than one degree.
const GRANULARITY_DEGREES = 1;

function shape(positions, indices, st = null) {
  const values = new Float64Array(positions.length * 3);
  positions.forEach((p, i) => values.set([p.x, p.y, p.z], i * 3));
  return {
    attributes: {
      position: { values },
      ...(st ? { st: { values: st } } : {}),
    },
    indices: new Uint32Array(indices),
  };
}

/**
 * A filled polygon: `rings` are GeoJSON-style [lon, lat, height?] rings, the
 * first the outline and the rest holes, each vertex at its own height (as
 * Cesium's perPositionHeight). Triangulated in the plane tangent to the
 * Earth at the outline's centre; null when nothing is left to fill.
 */
export function polygonShape(rings) {
  const loops = rings
    .map((ring) => {
      const open =
        ring.length > 1 &&
        ring[0][0] === ring.at(-1)[0] &&
        ring[0][1] === ring.at(-1)[1]
          ? ring.slice(0, -1)
          : ring;
      return open;
    })
    .filter((ring) => ring.length >= 3);
  if (!loops.length) return null;
  const [outline, ...holes] = loops;
  const points = loops.flat();
  const world = points.map(([lon, lat, h]) =>
    geo.cartesian3.fromDegrees(lon, lat, h),
  );
  const middle = geo.cartesian3.create();
  for (const p of world.slice(0, outline.length))
    geo.cartesian3.add(middle, p, middle);
  geo.cartesian3.divideByScalar(middle, outline.length, middle);
  const frame = geo.transforms.eastNorthUpToFixedFrame(middle);
  const east = geo.cartesian3.create(frame[0], frame[1], frame[2]);
  const north = geo.cartesian3.create(frame[4], frame[5], frame[6]);
  const offset = geo.cartesian3.create();
  const plane = world.map((p) => {
    geo.cartesian3.subtract(p, middle, offset);
    return [
      geo.cartesian3.dot(offset, east),
      geo.cartesian3.dot(offset, north),
    ];
  });
  let start = outline.length;
  const holeIndices = holes.map((hole) => {
    const index = start;
    start += hole.length;
    return index;
  });
  const triangles = earcut(plane.flat(), holeIndices);
  if (!triangles.length) return null;
  return shape(world, triangles);
}

/**
 * An image's rectangle, [west, south, east, north] in degrees at `height`:
 * a grid of cells no larger than the granularity, texture coordinates from
 * (0, 0) at the south-west corner to (1, 1) at the north-east one.
 */
export function rectangleShape([west, south, east, north], height = 0) {
  const span = east >= west ? east - west : east + 360 - west;
  const columns = Math.max(1, Math.ceil(span / GRANULARITY_DEGREES));
  const rows = Math.max(
    1,
    Math.ceil(Math.abs(north - south) / GRANULARITY_DEGREES),
  );
  const positions = [];
  const st = new Float32Array((rows + 1) * (columns + 1) * 2);
  for (let row = 0; row <= rows; row++)
    for (let column = 0; column <= columns; column++) {
      const s = column / columns,
        t = row / rows;
      st.set([s, t], positions.length * 2);
      positions.push(
        geo.cartesian3.fromDegrees(
          west + span * s,
          south + (north - south) * t,
          height,
        ),
      );
    }
  const indices = [];
  for (let row = 0; row < rows; row++)
    for (let column = 0; column < columns; column++) {
      const a = row * (columns + 1) + column,
        b = a + 1,
        c = a + columns + 1,
        d = c + 1;
      indices.push(a, b, d, a, d, c);
    }
  return shape(positions, indices, st);
}
