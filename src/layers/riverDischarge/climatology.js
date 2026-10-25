// Pure helpers for the offline river-discharge climatology build
// (scripts/build-river-discharge-points.mjs). Nothing here touches the
// network, so the choices that decide which GloFAS cell a point reads and
// which thresholds it is compared with are unit-tested.

/** GloFAS v4 grid spacing in degrees (~5 km); cell centres sit at k·0.05 + 0.025. */
export const GLOFAS_CELL_DEG = 0.05;

const EARTH_RADIUS_KM = 6371.0088;

const round = (value, decimals) => {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
};

/** Centre of the 0.05° GloFAS cell that contains `degrees`. */
export function glofasCellCentre(degrees) {
  if (!Number.isFinite(degrees)) throw new RangeError('degrees must be finite');
  const index = Math.floor(round(degrees / GLOFAS_CELL_DEG, 9));
  return round(index * GLOFAS_CELL_DEG + GLOFAS_CELL_DEG / 2, 3);
}

/**
 * The (2·radius+1)² cell centres around the cell that holds the point,
 * centre first. Requesting cell centres exactly avoids the server's
 * tie-breaking on cell boundaries.
 */
export function glofasNeighbourhood(latitude, longitude, radius = 1) {
  if (!Number.isInteger(radius) || radius < 0 || radius > 3)
    throw new RangeError('radius must be an integer in 0..3');
  const lat0 = glofasCellCentre(latitude);
  const lon0 = glofasCellCentre(longitude);
  const cells = [{ latitude: lat0, longitude: lon0 }];
  for (let i = -radius; i <= radius; i++) {
    for (let j = -radius; j <= radius; j++) {
      if (i === 0 && j === 0) continue;
      const latitude = round(lat0 + i * GLOFAS_CELL_DEG, 3);
      if (latitude <= -90 || latitude >= 90) continue;
      let longitude = round(lon0 + j * GLOFAS_CELL_DEG, 3);
      if (longitude > 180) longitude = round(longitude - 360, 3);
      if (longitude < -180) longitude = round(longitude + 360, 3);
      cells.push({ latitude, longitude });
    }
  }
  return cells;
}

/** Arithmetic mean of the finite, non-negative values; null when there are none. */
export function meanDischarge(values) {
  let sum = 0;
  let count = 0;
  for (const value of values || []) {
    if (Number.isFinite(value) && value >= 0) {
      sum += value;
      count++;
    }
  }
  return count ? sum / count : null;
}

/**
 * Choose the river cell from a neighbourhood: the candidate with the highest
 * mean discharge over the probe window. The model's nearest cell is often a
 * minor tributary or a dry cell beside the main stem (5 of 6 hand-placed
 * probes on major rivers), so the largest flow nearby is the river the
 * centreline names. Candidates below `minMean` m³/s are not a river at this
 * grid scale; null means the point is dropped.
 */
export function pickRiverCell(candidates, { minMean = 10 } = {}) {
  let best = null;
  for (const candidate of candidates || []) {
    const mean = meanDischarge(candidate?.values);
    if (mean === null) continue;
    if (!best || mean > best.mean) best = { ...candidate, mean };
  }
  if (!best || best.mean < minMean) return null;
  const { values: _values, ...picked } = best;
  return picked;
}

/**
 * Linear-interpolation percentile (the "R-7" / NumPy default definition) of
 * an ascending array. `p` is 0..100.
 */
export function percentileSorted(sorted, p) {
  if (!sorted.length) return null;
  if (!(p >= 0 && p <= 100)) throw new RangeError('p must be in 0..100');
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  const weight = rank - lower;
  return sorted[lower] + (sorted[upper] - sorted[lower]) * weight;
}

/** Significant-figure rounding that keeps small flows readable. */
export function roundDischarge(value) {
  if (!Number.isFinite(value)) return null;
  if (value === 0) return 0;
  const magnitude = Math.floor(Math.log10(Math.abs(value)));
  const decimals = Math.max(0, 2 - magnitude);
  return round(value, decimals);
}

/**
 * Daily-discharge climatology for one point: p50/p90/p99 of every valid day
 * in the window, plus the mean and the record maximum. `minCoverage` is the
 * share of days that must be present; a thinner series is not a climatology.
 */
export function dischargeClimatology(values, { minCoverage = 0.9 } = {}) {
  const total = Array.isArray(values) ? values.length : 0;
  const valid = (values || [])
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b);
  if (!total || valid.length / total < minCoverage) return null;
  const mean = valid.reduce((sum, value) => sum + value, 0) / valid.length;
  return {
    days: valid.length,
    mean: roundDischarge(mean),
    p50: roundDischarge(percentileSorted(valid, 50)),
    p90: roundDischarge(percentileSorted(valid, 90)),
    p99: roundDischarge(percentileSorted(valid, 99)),
    max: roundDischarge(valid[valid.length - 1]),
  };
}

/**
 * Open-Meteo's published request weight (open-meteo/open-meteo,
 * ForecastApiResult.swift `calculateQueryWeight`): per location
 * max(1, max(v/10, v/10 · days/14)), summed over locations.
 */
export function openMeteoCallWeight({ locations, days, variables = 1 }) {
  if (![locations, days, variables].every((n) => Number.isFinite(n) && n > 0))
    throw new RangeError('locations, days and variables must be positive');
  const variablesFraction = variables / 10;
  const perLocation = Math.max(
    1,
    Math.max(variablesFraction, variablesFraction * (days / 14)),
  );
  return locations * perLocation;
}

/** Great-circle distance in kilometres between two [lon, lat] pairs. */
export function haversineKm([lon1, lat1], [lon2, lat2]) {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function featureLines(geometry) {
  if (geometry?.type === 'LineString') return [geometry.coordinates];
  if (geometry?.type === 'MultiLineString') return geometry.coordinates;
  return [];
}

function lineLengthKm(line) {
  let length = 0;
  for (let i = 1; i < line.length; i++)
    length += haversineKm(line[i - 1], line[i]);
  return length;
}

/** Points every `spacingKm` along a line, the first at half a spacing. */
function pointsAlong(line, spacingKm) {
  const length = lineLengthKm(line);
  if (!(length > 0)) return [];
  // A line shorter than one spacing still names a river: keep its midpoint.
  const targets = [];
  if (length < spacingKm) targets.push(length / 2);
  else for (let d = spacingKm / 2; d < length; d += spacingKm) targets.push(d);
  const points = [];
  let walked = 0;
  let target = 0;
  for (let i = 1; i < line.length && target < targets.length; i++) {
    const segment = haversineKm(line[i - 1], line[i]);
    while (target < targets.length && targets[target] <= walked + segment) {
      const t = segment ? (targets[target] - walked) / segment : 0;
      points.push([
        line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t,
        line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t,
      ]);
      target++;
    }
    walked += segment;
  }
  return points;
}

/**
 * Candidate sample points from Natural Earth `rivers_lake_centerlines`:
 * named `River` features (lake centrelines excluded) at or below
 * `maxScalerank`, spaced along each line and kept only when at least
 * `minSeparationKm` from every point already kept. More prominent rivers
 * (lower scalerank) claim their points first; `maxPoints` caps the set.
 */
export function sampleRiverPoints(
  features,
  {
    maxScalerank = 5,
    spacingKm = 500,
    minSeparationKm = 300,
    maxPoints = 200,
  } = {},
) {
  const rivers = (features || [])
    .filter((feature) => {
      const p = feature?.properties || {};
      return (
        p.featurecla === 'River' &&
        Number.isFinite(p.scalerank) &&
        p.scalerank <= maxScalerank &&
        typeof (p.name_en || p.name) === 'string' &&
        (p.name_en || p.name).trim()
      );
    })
    .map((feature, index) => ({ feature, index }))
    .sort(
      (a, b) =>
        a.feature.properties.scalerank - b.feature.properties.scalerank ||
        a.index - b.index,
    );
  const kept = [];
  for (const { feature } of rivers) {
    const name = (feature.properties.name_en || feature.properties.name).trim();
    for (const line of featureLines(feature.geometry)) {
      for (const point of pointsAlong(line, spacingKm)) {
        if (kept.length >= maxPoints) return kept;
        if (kept.some((q) => haversineKm(point, q.position) < minSeparationKm))
          continue;
        kept.push({
          name,
          scalerank: feature.properties.scalerank,
          position: [round(point[0], 4), round(point[1], 4)],
        });
      }
    }
  }
  return kept;
}
