/**
 * Resample a GRIB wind grid into a compact equirectangular grid.
 *
 * Source grids are north-to-south (`la1` at the top, `dj` increasing toward the
 * south) and start at `lo1`. Longitude wraps across the seam; latitude clamps.
 *
 * @param {{u: ArrayLike<number>, v: ArrayLike<number>, ni: number, nj: number,
 *   lo1: number, la1: number, di: number, dj: number, dx?: number, dy?: number}} input
 * @returns {{nx: number, ny: number, lo1: number, la1: number, dx: number,
 *   dy: number, u: Float32Array, v: Float32Array}}
 */
export function resampleWindGrid({
  u,
  v,
  scalar,
  scalarScale = 1,
  scalarOffset = 0,
  ni,
  nj,
  lo1,
  la1,
  di,
  dj,
  dx = 1,
  dy = 1,
}) {
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 1 ||
    nj < 1 ||
    ni * nj > 2_000_000 ||
    u?.length !== ni * nj ||
    v?.length !== ni * nj ||
    (scalar !== undefined && scalar?.length !== ni * nj) ||
    ![lo1, la1, di, dj, dx, dy, scalarScale, scalarOffset].every(
      Number.isFinite,
    ) ||
    di <= 0 ||
    dj <= 0 ||
    dx < 0.25 ||
    dy < 0.25 ||
    dx > 180 ||
    dy > 180
  )
    throw new Error('Invalid wind grid geometry');
  for (const values of [u, v, ...(scalar === undefined ? [] : [scalar])]) {
    if (!Array.prototype.every.call(values, Number.isFinite))
      throw new Error('Invalid wind grid values');
  }
  const geometry = { ni, nj, lo1, la1, di, dj };
  const sampled = (values) => ({
    ...geometry,
    dx,
    dy,
    samples: sampleValues(values, geometry, dx, dy),
  });
  return composeWindGrid({
    u: sampled(u),
    v: sampled(v),
    ...(scalar === undefined ? {} : { scalar: sampled(scalar) }),
    scalarScale,
    scalarOffset,
  });
}

/** Display-grid shape for a target spacing, under the point budget. */
function displayShape(dx, dy) {
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dy) + 1;
  if (nx * ny > 1_000_000)
    throw new Error('Resampled wind grid exceeds point budget');
  return { nx, ny };
}

/**
 * Bilinearly sample one validated source field onto the display grid. The
 * result stays in doubles so a caller can scale it before narrowing to
 * Float32, exactly as if it had sampled, scaled and stored in one step.
 */
function sampleValues(source, { ni, nj, lo1, la1, di, dj }, dx, dy) {
  const { nx, ny } = displayShape(dx, dy);
  const samples = new Float64Array(nx * ny);
  for (let y = 0; y < ny; y += 1) {
    const lat = 90 - y * dy;
    const sy = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const y0 = Math.floor(sy);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fy = sy - y0;
    for (let x = 0; x < nx; x += 1) {
      const lon = x * dx;
      const sx = ((lon - lo1) / di + ni) % ni;
      const x0 = Math.floor(sx);
      const x1 = (x0 + 1) % ni;
      const fx = sx - x0;
      const top = source[y0 * ni + x0] * (1 - fx) + source[y0 * ni + x1] * fx;
      const bottom =
        source[y1 * ni + x0] * (1 - fx) + source[y1 * ni + x1] * fx;
      samples[y * nx + x] = top * (1 - fy) + bottom * fy;
    }
  }
  return samples;
}

/**
 * Validate one decoded GRIB field and reduce it to display-grid samples.
 *
 * This is the expensive per-message step after the decode (a 0.25° message is
 * ~1.04 M doubles to check), so the decode worker runs it and transfers only
 * the result. A field that already carries samples for `targetDx` passes
 * through, which lets the same call normalise worker output, injected decoders
 * and the retained wind of the current cycle.
 *
 * @param {object} field - `decodeWindGribMessage` output, or a sampled field.
 * @param {number} [targetDx] - Display-grid spacing in degrees.
 * @returns {{ni: number, nj: number, lo1: number, la1: number, di: number,
 *   dj: number, units: (string|undefined), dx: number, dy: number,
 *   samples: Float64Array}}
 */
export function sampleWindField(field, targetDx = 1) {
  if (!field) throw new Error('Mismatched weather grid geometry');
  if (
    field.samples instanceof Float64Array &&
    field.dx === targetDx &&
    field.dy === targetDx
  )
    return field;
  const { ni, nj, lo1, la1, di, dj, values, units } = field;
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 1 ||
    nj < 1 ||
    ni * nj > 2_000_000 ||
    values?.length !== ni * nj ||
    ![lo1, la1, di, dj, targetDx].every(Number.isFinite) ||
    di <= 0 ||
    dj <= 0 ||
    targetDx < 0.25 ||
    targetDx > 180
  )
    throw new Error('Invalid wind grid geometry');
  if (!Array.prototype.every.call(values, Number.isFinite))
    throw new Error('Invalid wind grid values');
  const geometry = { ni, nj, lo1, la1, di, dj };
  return {
    ...geometry,
    units,
    dx: targetDx,
    dy: targetDx,
    samples: sampleValues(values, geometry, targetDx, targetDx),
  };
}

/** Narrow sampled components that share one display grid to Float32. */
function composeWindGrid({ u, v, scalar, scalarScale = 1, scalarOffset = 0 }) {
  const { dx, dy } = u;
  const { nx, ny } = displayShape(dx, dy);
  const components = [u, v, ...(scalar ? [scalar] : [])];
  if (
    components.some(
      (field) =>
        field.dx !== dx ||
        field.dy !== dy ||
        !(field.samples instanceof Float64Array) ||
        field.samples.length !== nx * ny,
    )
  )
    throw new Error('Invalid wind grid geometry');
  const outU = new Float32Array(u.samples);
  const outV = new Float32Array(v.samples);
  let outScalar = null;
  if (scalar) {
    outScalar = new Float32Array(nx * ny);
    for (let index = 0; index < outScalar.length; index += 1)
      outScalar[index] = scalar.samples[index] * scalarScale + scalarOffset;
  }
  for (const values of [outU, outV, ...(outScalar ? [outScalar] : [])]) {
    if (!values.every(Number.isFinite))
      throw new Error('Invalid resampled wind values');
  }
  return {
    nx,
    ny,
    lo1: 0,
    la1: 90,
    dx,
    dy,
    u: outU,
    v: outV,
    ...(outScalar ? { scalar: outScalar } : {}),
  };
}

/** Metadata for the two optional same-cycle weather fields. */
export function weatherScalarMetadata(overlay = 'none') {
  if (overlay === 'none') return null;
  if (overlay === 'temperature')
    return { kind: overlay, units: '°C', level: '2 m above ground' };
  if (overlay === 'pressure')
    return { kind: overlay, units: 'hPa', level: 'mean sea level' };
  throw new Error('Unknown weather overlay');
}

/** Reject shifted/mismatched components before sharing U's grid geometry. */
export function resampleWeatherFields({
  u,
  v,
  scalar,
  overlay = 'none',
  targetDx = 1,
}) {
  const metadata = weatherScalarMetadata(overlay);
  const fields = [u, v, ...(metadata ? [scalar] : [])];
  if (
    !u ||
    fields.some(
      (field) =>
        !field ||
        ['ni', 'nj', 'lo1', 'la1', 'di', 'dj'].some(
          (key) => field[key] !== u[key],
        ),
    )
  )
    throw new Error('Mismatched weather grid geometry');
  if (metadata && scalar.units !== (overlay === 'temperature' ? 'K' : 'Pa'))
    throw new Error('Unexpected weather scalar units');
  // Raw fields are validated and sampled here; worker output and the retained
  // wind of this cycle already are, so only the cheap narrowing is left.
  const [sampledU, sampledV, sampledScalar] = fields.map((field) =>
    sampleWindField(field, targetDx),
  );
  const grid = composeWindGrid({
    u: sampledU,
    v: sampledV,
    ...(metadata
      ? {
          scalar: sampledScalar,
          scalarScale: overlay === 'pressure' ? 0.01 : 1,
          scalarOffset: overlay === 'temperature' ? -273.15 : 0,
        }
      : {}),
  });
  return { grid, ...(metadata ? { scalar: metadata } : {}) };
}

/** Preserve usable same-cycle wind when only its optional companion fails. */
export function resampleWeatherSnapshot(options) {
  try {
    return resampleWeatherFields(options);
  } catch (error) {
    if ((options.overlay ?? 'none') === 'none') throw error;
    // Revalidate wind alone: a wind defect must never become a partial success.
    const wind = resampleWeatherFields({ ...options, overlay: 'none' });
    return { ...wind, scalarError: weatherScalarError(options.overlay) };
  }
}

export function weatherScalarError(overlay) {
  weatherScalarMetadata(overlay);
  return overlay === 'temperature'
    ? 'Temperature field unavailable'
    : 'Mean sea level pressure field unavailable';
}
