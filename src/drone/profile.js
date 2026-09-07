import { MissingTerrainSampleError } from './terrain.js';

function finiteAtLeast(value, minimum, label) {
  if (!Number.isFinite(value) || value < minimum) {
    throw new RangeError(`${label} must be a finite number greater than or equal to ${minimum}`);
  }
  return value;
}

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

function canonicalSamples(sampledTerrain) {
  const { plan, samples } = sampledTerrain ?? {};
  if (!plan?.segments || !Array.isArray(samples)) {
    throw new TypeError('sampled terrain from sampleTerrain() is required');
  }
  const byId = new Map(samples.map((sample) => [sample.id, sample]));
  const missing = [];
  const canonical = [];

  for (const segment of plan.segments) {
    for (let index = 0; index < segment.samples.length; index += 1) {
      const planned = segment.samples[index];
      const sampled = byId.get(planned.id);
      if (!Number.isFinite(sampled?.terrainHeightMsl)) {
        missing.push(planned.id);
        continue;
      }
      if (index === 0 && canonical.length) {
        const boundary = canonical[canonical.length - 1];
        if (Math.abs(boundary.cumulativeDistanceMeters - sampled.cumulativeDistanceMeters) < 1e-6) {
          boundary.terrainHeightMsl = Math.max(boundary.terrainHeightMsl, sampled.terrainHeightMsl);
          continue;
        }
      }
      canonical.push({
        ...sampled,
        routeSegmentIndex: segment.routeSegmentIndex,
      });
    }
  }
  if (missing.length) throw new MissingTerrainSampleError(missing);
  return canonical;
}

export function createTerrainAwareProfile(sampledTerrain, {
  minimumAglMeters = 60,
  maxClimbRateMps = 5,
  maxDescentRateMps = 4,
  groundSpeedMps = 15,
} = {}) {
  finiteAtLeast(minimumAglMeters, 0, 'minimumAglMeters');
  positiveFinite(maxClimbRateMps, 'maxClimbRateMps');
  positiveFinite(maxDescentRateMps, 'maxDescentRateMps');
  positiveFinite(groundSpeedMps, 'groundSpeedMps');

  const samples = canonicalSamples(sampledTerrain);
  if (samples.length < 2) throw new TypeError('the profile requires at least two terrain samples');
  const altitude = samples.map(({ terrainHeightMsl }) => terrainHeightMsl + minimumAglMeters);

  for (let index = altitude.length - 2; index >= 0; index -= 1) {
    const distance = samples[index + 1].cumulativeDistanceMeters
      - samples[index].cumulativeDistanceMeters;
    const maximumClimb = maxClimbRateMps * distance / groundSpeedMps;
    altitude[index] = Math.max(altitude[index], altitude[index + 1] - maximumClimb);
  }

  for (let index = 1; index < altitude.length; index += 1) {
    const distance = samples[index].cumulativeDistanceMeters
      - samples[index - 1].cumulativeDistanceMeters;
    const maximumDescent = maxDescentRateMps * distance / groundSpeedMps;
    altitude[index] = Math.max(altitude[index], altitude[index - 1] - maximumDescent);
  }

  const vertices = samples.map((sample, index) => Object.freeze({
    id: `profile-${index}`,
    latitude: sample.latitude,
    longitude: sample.longitude,
    altitudeMsl: altitude[index],
    terrainHeightMsl: sample.terrainHeightMsl,
    aglMeters: altitude[index] - sample.terrainHeightMsl,
    cumulativeDistanceMeters: sample.cumulativeDistanceMeters,
    routeSegmentIndex: sample.routeSegmentIndex,
  }));

  return Object.freeze({
    vertices: Object.freeze(vertices),
    totalLengthMeters: sampledTerrain.plan.totalLengthMeters,
    minimumAglMeters,
    maxClimbRateMps,
    maxDescentRateMps,
    groundSpeedMps,
  });
}
