/** Camera-relative transforms in JS float64; only nearby metres enter GLSL. */
export function viewFrame(frame, matrix, out) {
  const m = matrix.elements;
  const transform = (p, offset, translate) => {
    out[offset] =
      m[0] * p.x + m[4] * p.y + m[8] * p.z + (translate ? m[12] : 0);
    out[offset + 1] =
      m[1] * p.x + m[5] * p.y + m[9] * p.z + (translate ? m[13] : 0);
    out[offset + 2] =
      m[2] * p.x + m[6] * p.y + m[10] * p.z + (translate ? m[14] : 0);
  };
  transform(frame.center, 0, true);
  transform(frame.east, 3, false);
  transform(frame.north, 6, false);
  transform(frame.up, 9, false);
  return out;
}

/** Conservative clip bounds, including a camera inside/crossing the volume. */
export function groundClipBounds(frame, view, projection, out) {
  const p = projection.elements;
  let x0 = Infinity,
    y0 = Infinity,
    x1 = -Infinity,
    y1 = -Infinity,
    front = 0,
    behind = 0;
  for (let i = 0; i < 8; i++) {
    const x = (i & 1 ? 1 : -1) * frame.radius;
    const y = (i & 2 ? 1 : -1) * frame.radius;
    const z = i & 4 ? frame.ceiling : frame.floor;
    const vx = view[0] + view[3] * x + view[6] * y + view[9] * z;
    const vy = view[1] + view[4] * x + view[7] * y + view[10] * z;
    const vz = view[2] + view[5] * x + view[8] * y + view[11] * z;
    const w = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
    if (w <= 0) {
      behind++;
      continue;
    }
    front++;
    const cx = (p[0] * vx + p[4] * vy + p[8] * vz + p[12]) / w;
    const cy = (p[1] * vx + p[5] * vy + p[9] * vz + p[13]) / w;
    x0 = Math.min(x0, cx);
    y0 = Math.min(y0, cy);
    x1 = Math.max(x1, cx);
    y1 = Math.max(y1, cy);
  }
  if (front && behind) {
    x0 = -1;
    y0 = -1;
    x1 = 1;
    y1 = 1;
  }
  if (!front || x1 < -1 || y1 < -1 || x0 > 1 || y0 > 1) out.fill(2);
  else {
    out[0] = Math.max(-1, x0);
    out[1] = Math.max(-1, y0);
    out[2] = Math.min(1, x1);
    out[3] = Math.min(1, y1);
  }
  return out;
}
