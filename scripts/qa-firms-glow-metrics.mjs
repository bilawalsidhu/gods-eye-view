// Source-coordinate comparison for the controlled single-glow fixture.
// Native billboard UVs are quantized to 12 bits. Infer their subpixel map
// only from red (constant255 in every FIRMS color stop), independently of
// the color result; position/size retain the existing2px/5% limits.
const SIDE = 61,
  CHANNELS = SIDE * SIDE * 3,
  BACKGROUND = [16, 32, 48];
function at(data, x, y, c) {
  if (x < 0 || y < 0 || x >= SIDE || y >= SIDE) return BACKGROUND[c];
  return data[(y * SIDE + x) * 3 + c];
}
function moments(data) {
  let mass = 0,
    x = 0,
    y = 0;
  for (let j = 0; j < SIDE; j++)
    for (let i = 0; i < SIDE; i++) {
      const w = Math.max(0, at(data, i, j, 0) - BACKGROUND[0]);
      mass += w;
      x += w * i;
      y += w * j;
    }
  if (!(mass > 16)) throw new Error('A nonempty alpha profile is required');
  x /= mass;
  y /= mass;
  let xx = 0,
    yy = 0;
  for (let j = 0; j < SIDE; j++)
    for (let i = 0; i < SIDE; i++) {
      const w = Math.max(0, at(data, i, j, 0) - BACKGROUND[0]);
      xx += w * (i - x) ** 2;
      yy += w * (j - y) ** 2;
    }
  return { x, y, sx: Math.sqrt(xx / mass), sy: Math.sqrt(yy / mass), mass };
}
function sample(data, x, y, c) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    fx = x - ix,
    fy = y - iy;
  return (
    at(data, ix, iy, c) * (1 - fx) * (1 - fy) +
    at(data, ix + 1, iy, c) * fx * (1 - fy) +
    at(data, ix, iy + 1, c) * (1 - fx) * fy +
    at(data, ix + 1, iy + 1, c) * fx * fy
  );
}
function compare(a, b, fit) {
  let directMax = 0,
    sourceAlignedMax = 0,
    alphaRedMax = 0;
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++)
      for (let c = 0; c < 3; c++) {
        const i = (y * SIDE + x) * 3 + c,
          d = Math.abs(a[i] - b[i]);
        directMax = Math.max(directMax, d);
        if (c === 0) alphaRedMax = Math.max(alphaRedMax, d);
        sourceAlignedMax = Math.max(
          sourceAlignedMax,
          Math.abs(
            a[i] -
              sample(
                b,
                fit.right.x + (x - fit.left.x) / fit.sx,
                fit.right.y + (y - fit.left.y) / fit.sy,
                c,
              ),
          ),
        );
      }
  return { channels: CHANNELS, directMax, sourceAlignedMax, alphaRedMax };
}
function kernelError(raw, filtered, amount) {
  let max = 0;
  for (let y = 0; y < SIDE; y++)
    for (let x = 0; x < SIDE; x++)
      for (let c = 0; c < 3; c++) {
        let blur = 0;
        for (let dy = -1; dy <= 1; dy++)
          for (let dx = -1; dx <= 1; dx++)
            blur += at(raw, x + dx, y + dy, c) / 9;
        const v = at(raw, x, y, c),
          expected = Math.round(
            Math.max(0, Math.min(255, v + (v - blur) * amount)),
          );
        max = Math.max(max, Math.abs(expected - at(filtered, x, y, c)));
      }
  return max;
}
export function analyzeFirmsGlow(frames) {
  for (const engine of ['cesium', 'navara'])
    for (const mode of ['raw', 'matched-sharpen', 'default-sharpen'])
      if (frames[engine]?.[mode]?.length !== CHANNELS)
        throw new Error('All real61x61 RGB captures are required');
  const left = moments(frames.cesium.raw),
    right = moments(frames.navara.raw),
    sx = left.sx / right.sx,
    sy = left.sy / right.sy;
  const fit = { left, right, sx, sy },
    geometry = {
      shift: [left.x - right.x, left.y - right.y],
      scale: [sx, sy],
      alphaMassRatio: right.mass / left.mass,
    };
  const raw = compare(frames.cesium.raw, frames.navara.raw, fit),
    sharpen = compare(
      frames.cesium['matched-sharpen'],
      frames.navara['matched-sharpen'],
      fit,
    );
  const kernels = {};
  for (const engine of ['cesium', 'navara'])
    kernels[engine] = {
      matched: kernelError(
        frames[engine].raw,
        frames[engine]['matched-sharpen'],
        1.08,
      ),
      default: kernelError(
        frames[engine].raw,
        frames[engine]['default-sharpen'],
        engine === 'cesium' ? 1.08 : 1.7,
      ),
    };
  return {
    geometry,
    raw,
    sharpen,
    kernels,
    checks: {
      geometry:
        geometry.shift.every((v) => Math.abs(v) <= 2) &&
        geometry.scale.every(
          (v) => Number.isFinite(v) && Math.abs(v - 1) <= 0.05,
        ),
      unalignedAlpha: raw.alphaRedMax <= 3,
      rawColor: raw.sourceAlignedMax <= 3,
      sharpenColor: sharpen.sourceAlignedMax <= 3,
      nativeKernel: Object.values(kernels.cesium).every((v) => v <= 1),
      navaraKernel: Object.values(kernels.navara).every((v) => v <= 1),
    },
  };
}
