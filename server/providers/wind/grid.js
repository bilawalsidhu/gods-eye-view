function displayShape(dx, dy) {
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dy) + 1;
  if (nx * ny > 1_000_000)
    throw new Error('Resampled wind grid exceeds point budget');
  return { nx, ny };
}

/**
 * Returns doubles: scaling before narrowing to Float32 keeps output identical
 * to sampling, scaling and storing in one step.
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
 * Validate a decoded GRIB field and sample it to the display grid. A field
 * already sampled for `targetDx` passes through unchecked (worker output,
 * retained wind).
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
  // Worker output and retained wind are already sampled.
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
