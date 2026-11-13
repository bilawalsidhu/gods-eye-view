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
  return resampleFields({
    fields: { u, v, ...(scalar === undefined ? {} : { scalar }) },
    ni,
    nj,
    lo1,
    la1,
    di,
    dj,
    dx,
    dy,
    scalarScale,
    scalarOffset,
  });
}

function resampleFields({
  fields,
  ni,
  nj,
  lo1,
  la1,
  di,
  dj,
  dx,
  dy,
  scalarScale = 1,
  scalarOffset = 0,
}) {
  if (
    !Number.isInteger(ni) ||
    !Number.isInteger(nj) ||
    ni < 1 ||
    nj < 1 ||
    ni * nj > 2_000_000 ||
    Object.values(fields).some((values) => values?.length !== ni * nj) ||
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
  for (const values of Object.values(fields)) {
    if (!Array.prototype.every.call(values, Number.isFinite))
      throw new Error('Invalid wind grid values');
  }
  const nx = Math.round(360 / dx);
  const ny = Math.round(180 / dy) + 1;
  if (nx * ny > 1_000_000)
    throw new Error('Resampled wind grid exceeds point budget');
  const keys = Object.keys(fields);
  const outputs = Object.fromEntries(
    keys.map((key) => [key, new Float32Array(nx * ny)]),
  );
  const sample = (source, lon, lat) => {
    const x = ((lon - lo1) / di + ni) % ni;
    const y = Math.max(0, Math.min(nj - 1, (la1 - lat) / dj));
    const x0 = Math.floor(x);
    const x1 = (x0 + 1) % ni;
    const y0 = Math.floor(y);
    const y1 = Math.min(nj - 1, y0 + 1);
    const fx = x - x0;
    const fy = y - y0;
    const top = source[y0 * ni + x0] * (1 - fx) + source[y0 * ni + x1] * fx;
    const bottom = source[y1 * ni + x0] * (1 - fx) + source[y1 * ni + x1] * fx;
    return top * (1 - fy) + bottom * fy;
  };
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const index = y * nx + x;
      const lon = x * dx;
      const lat = 90 - y * dy;
      for (const key of keys) {
        const value = sample(fields[key], lon, lat);
        outputs[key][index] =
          key === 'scalar' ? value * scalarScale + scalarOffset : value;
      }
    }
  }
  for (const values of Object.values(outputs)) {
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
    ...outputs,
  };
}

/** Resample a Kelvin field without allocating unused wind components. */
export function resampleTemperatureGrid({ field, targetDx = 1 }) {
  if (field.units !== 'K') throw new Error('Unexpected temperature units');
  const { ni, nj, lo1, la1, di, dj } = field;
  return resampleFields({
    fields: { scalar: field.values },
    ni,
    nj,
    lo1,
    la1,
    di,
    dj,
    dx: targetDx,
    dy: targetDx,
    scalarOffset: -273.15,
  });
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
  const grid = resampleWindGrid({
    u: u.values,
    v: v.values,
    ni: u.ni,
    nj: u.nj,
    lo1: u.lo1,
    la1: u.la1,
    di: u.di,
    dj: u.dj,
    dx: targetDx,
    dy: targetDx,
    ...(metadata
      ? {
          scalar: scalar.values,
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
