/**
 * A fire's outer edge, from its pieces' lines. Where newer growth is cut
 * from the area around an older piece, the new piece's ring runs along the
 * older piece's line, through the same points (to `STEP`): that line now runs inside
 * the fire. It is left out, so a fire reads as one area with one edge.
 */

/** Points closer than this, degrees (about 10 cm), are one point. */
const STEP = 1e-6;

/**
 * The segments of `pieces`' rings, by their ends: `owner(a, b)` is the piece
 * whose ring runs from `a` to `b` or back, -1 where two pieces' do, or
 * undefined. A point is keyed by its place on a grid of `STEP` from the
 * pieces' south-west corner.
 */
function ringSegments(pieces) {
  let west = Infinity;
  let south = Infinity;
  for (const { polygons, outline } of pieces) {
    for (const rings of polygons)
      for (const ring of rings)
        for (const point of ring) {
          if (point[0] < west) west = point[0];
          if (point[1] < south) south = point[1];
        }
    for (const line of outline)
      for (const point of line) {
        if (point[0] < west) west = point[0];
        if (point[1] < south) south = point[1];
      }
  }
  const keyOf = (point) =>
    Math.round((point[0] - west) / STEP) * 2 ** 26 +
    Math.round((point[1] - south) / STEP);
  // Each segment under its lower end's key: its other end's, and its owner.
  const ends = new Map();
  for (let index = 0; index < pieces.length; index++)
    for (const rings of pieces[index].polygons)
      for (const ring of rings) {
        let a = keyOf(ring[0]);
        for (let i = 1; i < ring.length; i++) {
          const b = keyOf(ring[i]);
          const p = a < b ? a : b;
          const q = a < b ? b : a;
          a = b;
          if (p === q) continue;
          const list = ends.get(p);
          if (!list) {
            ends.set(p, [q, index]);
            continue;
          }
          let k = 0;
          while (k < list.length && list[k] !== q) k += 2;
          if (k === list.length) list.push(q, index);
          else if (list[k + 1] !== index) list[k + 1] = -1;
        }
      }
  return (from, to) => {
    const a = keyOf(from);
    const b = keyOf(to);
    const list = ends.get(a < b ? a : b);
    if (!list) return undefined;
    const q = a < b ? b : a;
    for (let k = 0; k < list.length; k += 2)
      if (list[k] === q) return list[k + 1];
    return undefined;
  };
}

/**
 * Each piece's lines cut to the fire's outer edge: for each of one fire's
 * `pieces` (`{polygons, outline}`, rings and lines of `[lon, lat]`), the
 * runs of its lines (two points or more each) along no other piece's ring.
 * A segment along another piece's ring has burned ground on both sides.
 */
export function outerEdges(pieces) {
  if (pieces.length < 2) return pieces.map(({ outline }) => outline);
  const ownerOf = ringSegments(pieces);
  return pieces.map(({ outline }, index) =>
    outline.flatMap((line) => {
      const runs = [];
      let run = null;
      let inside = false;
      for (let i = 1; i < line.length; i++) {
        const [a, b] = [line[i - 1], line[i]];
        // A segment of no length goes as the one before it.
        if (a[0] !== b[0] || a[1] !== b[1]) {
          const owner = ownerOf(a, b);
          inside = owner !== undefined && owner !== index;
        }
        if (inside) {
          if (run) runs.push(run);
          run = null;
        } else if (run) run.push(b);
        else run = [a, b];
      }
      if (run) runs.push(run);
      return runs;
    }),
  );
}
