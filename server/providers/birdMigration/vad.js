export const VAD_POLICY = Object.freeze({
  annulusKm: Object.freeze([5, 60]),
  biologicalMaxCc: 0.95,
  // More than this share of annulus echo at or above biologicalMaxCc is rain.
  precipitationFraction: 0.5,
  minGates: 300,
  maxAzimuthGapDeg: 60,
  maxResidualMs: 4,
  maxSpeedMs: 60,
});

const EFFECTIVE_EARTH_RADIUS_M = (4 / 3) * 6_371_000;
const toRad = (deg) => (deg * Math.PI) / 180;

function beamHeightM(rangeKm, elevationDeg) {
  const r = rangeKm * 1000;
  return (
    r * Math.sin(toRad(elevationDeg)) + (r * r) / (2 * EFFECTIVE_EARTH_RADIUS_M)
  );
}

function largestGapDeg(azimuths) {
  if (!azimuths.length) return 360;
  const sorted = [...new Set(azimuths.map((a) => Math.floor(a)))].sort(
    (a, b) => a - b,
  );
  let gap = sorted[0] + 360 - sorted.at(-1);
  for (let i = 1; i < sorted.length; i++)
    gap = Math.max(gap, sorted[i] - sorted[i - 1]);
  return gap - 1;
}

/** Solve the 3x3 normal equations of v = c0 + c1 cos(az) + c2 sin(az). */
function fitSinusoid(samples) {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  const y = [0, 0, 0];
  for (const { az, v } of samples) {
    const row = [1, Math.cos(az), Math.sin(az)];
    for (let i = 0; i < 3; i++) {
      y[i] += row[i] * v;
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j];
    }
  }
  for (let col = 0; col < 3; col++) {
    let pivot = col;
    for (let r = col + 1; r < 3; r++)
      if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-9) return null;
    [m[col], m[pivot]] = [m[pivot], m[col]];
    [y[col], y[pivot]] = [y[pivot], y[col]];
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = m[r][col] / m[col][col];
      for (let c = col; c < 3; c++) m[r][c] -= f * m[col][c];
      y[r] -= f * y[col];
    }
  }
  const coefficients = y.map((value, i) => value / m[i][i]);
  let squares = 0;
  for (const { az, v } of samples) {
    const fitted =
      coefficients[0] +
      coefficients[1] * Math.cos(az) +
      coefficients[2] * Math.sin(az);
    squares += (v - fitted) ** 2;
  }
  return { coefficients, residual: Math.sqrt(squares / samples.length) };
}

/**
 * One radar, one volume: N0U velocity masked by N0C correlation. Never
 * returns a track without the fit that produced it.
 * @param {string} site
 * @param {{ velocity: object, correlation: object }} volumes decoded by level3.js, same volume
 * @returns {Exclude<import('../../../src/layers/birdMigration/model.js').StationOutcome, { kind: 'no-scan' }>}
 */
export function reduceStation(
  site,
  { velocity, correlation },
  policy = VAD_POLICY,
) {
  const base = {
    site,
    position: velocity.position,
    scanTime: velocity.scanTime,
  };
  const [inner, outer] = policy.annulusKm;
  const ccByAzimuth = new Map(
    correlation.radials.map((radial) => [
      Math.floor(radial.azimuthDeg) % 360,
      radial,
    ]),
  );
  const samples = [];
  let kept = 0;
  let meteorological = 0;
  for (const radial of velocity.radials) {
    const cc = ccByAzimuth.get(Math.floor(radial.azimuthDeg) % 360);
    if (!cc) continue;
    const az = toRad(radial.azimuthDeg + radial.widthDeg / 2);
    for (let i = 0; i < radial.values.length; i++) {
      const rangeKm = velocity.firstGateKm + (i + 0.5) * velocity.gateKm;
      if (rangeKm < inner) continue;
      if (rangeKm > outer) break;
      const v = radial.values[i];
      const j = Math.floor(
        (rangeKm - correlation.firstGateKm) / correlation.gateKm,
      );
      const rho = cc.values[j];
      if (!Number.isFinite(v) || !Number.isFinite(rho)) continue;
      kept++;
      if (rho >= policy.biologicalMaxCc) meteorological++;
      else samples.push({ az, azimuthDeg: radial.azimuthDeg, v });
    }
  }
  if (kept && meteorological / kept > policy.precipitationFraction)
    return {
      kind: 'precipitation',
      ...base,
      rainFraction: meteorological / kept,
    };
  if (samples.length < policy.minGates) return { kind: 'quiet', ...base };
  const gap = largestGapDeg(samples.map(({ azimuthDeg }) => azimuthDeg));
  if (gap > policy.maxAzimuthGapDeg)
    return { kind: 'unfit', ...base, reason: 'azimuth-gap' };
  const solved = fitSinusoid(samples);
  if (!solved || solved.residual > policy.maxResidualMs)
    return { kind: 'unfit', ...base, reason: 'residual' };
  const cosElevation = Math.cos(toRad(velocity.elevationDeg));
  const northward = solved.coefficients[1] / cosElevation;
  const eastward = solved.coefficients[2] / cosElevation;
  const speedMs = Math.hypot(eastward, northward);
  if (speedMs > policy.maxSpeedMs)
    return { kind: 'unfit', ...base, reason: 'implausible-speed' };
  const towardDeg =
    ((Math.atan2(eastward, northward) * 180) / Math.PI + 360) % 360;
  return {
    kind: 'tracked',
    ...base,
    track: { towardDeg, speedMs },
    fit: {
      velocityProduct: 'N0U',
      maskProduct: 'N0C',
      gateCount: samples.length,
      azimuthCoverageDeg: 360 - gap,
      residualMs: solved.residual,
      annulusKm: [inner, outer],
      beamHeightM: [
        beamHeightM(inner, velocity.elevationDeg),
        beamHeightM(outer, velocity.elevationDeg),
      ],
    },
  };
}
