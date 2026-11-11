// Pure parts of Navara movers: what the instanced meshes upload. Offsets are
// relative to an origin near the camera (the mesh sits at the origin, which
// three keeps in doubles), so float32 instance data keeps centimetres where
// it matters; the origin follows the camera past a distance that grows with
// height (no jitter close in, few rewrites from space).

const RADIANS = Math.PI / 180;

/** Metres one CSS pixel spans per metre of view depth. */
export function footprintPerDepth(verticalFovDeg, viewportHeightPx) {
  if (!(viewportHeightPx > 0)) return 0;
  return (2 * Math.tan((verticalFovDeg * RADIANS) / 2)) / viewportHeightPx;
}

/** Atlas cells [u0, v0, u1, v1] (v down from the image top) as three uvs (v up). */
export function atlasUvRects(cells, keys) {
  const rects = new Float32Array(keys.length * 4);
  keys.forEach((key, index) => {
    const [u0, v0, u1, v1] = cells[key];
    rects.set([u0, 1 - v1, u1, 1 - v0], index * 4);
  });
  return rects;
}

/** The camera distance from the origin past which the origin moves. */
const recentreDistance = (cameraHeight) =>
  Math.max(1_000, 0.1 * Math.abs(cameraHeight));

/**
 * The origin to draw from: the current one while the camera stays within
 * recentreDistance(height) of it, else the camera position.
 */
export function originFor(cameraPosition, origin, cameraHeight) {
  if (!origin) return cameraPosition;
  const dx = cameraPosition.x - origin.x;
  const dy = cameraPosition.y - origin.y;
  const dz = cameraPosition.z - origin.z;
  const limit = recentreDistance(cameraHeight);
  return dx * dx + dy * dy + dz * dz > limit * limit ? cameraPosition : origin;
}

/**
 * Writes instances [from, to) of a mover store into the upload arrays:
 * `matrices` (identity with the offset from `origin` as translation),
 * `style` (rotation, scale or 0 when hidden, and cached cosine/sine), `colors`
 * (rgba) and `uvs` (the instance's atlas rect, from `uvRects`).
 */
export function packInstances(store, from, to, origin, uvRects, out) {
  const { positions, rotations, scales, shows, colors, cells } = store;
  const { matrices, style, colors: colorOut, uvs } = out;
  for (let index = from; index < to; index++) {
    const m = index * 16;
    matrices[m + 12] = positions[index * 3] - origin.x;
    matrices[m + 13] = positions[index * 3 + 1] - origin.y;
    matrices[m + 14] = positions[index * 3 + 2] - origin.z;
    const s = index * 4;
    const rotation = rotations[index];
    style[s] = rotation;
    style[s + 1] = shows[index] === 1 ? scales[index] : 0;
    style[s + 2] = Math.cos(rotation);
    style[s + 3] = Math.sin(rotation);
    colorOut[s] = colors[s];
    colorOut[s + 1] = colors[s + 1];
    colorOut[s + 2] = colors[s + 2];
    colorOut[s + 3] = colors[s + 3];
    if (out.outlineColors && store.outlineColors)
      out.outlineColors.set(store.outlineColors.subarray(s, s + 4), s);
    if (uvs && uvRects) {
      const r = cells[index] * 4;
      uvs[s] = uvRects[r];
      uvs[s + 1] = uvRects[r + 1];
      uvs[s + 2] = uvRects[r + 2];
      uvs[s + 3] = uvRects[r + 3];
    }
  }
}
