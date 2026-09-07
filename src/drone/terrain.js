import { distanceMeters, interpolateGeodesic } from './geodesy.js';
import { getRoutePoints } from './route.js';

export const MAX_TERRAIN_SAMPLES = 10_000;

export class MissingTerrainSampleError extends Error {
  constructor(sampleIds) {
    super(`Terrain samples unavailable: ${sampleIds.join(', ')}`);
    this.name = 'MissingTerrainSampleError';
    this.sampleIds = Object.freeze([...sampleIds]);
  }
}

function positiveFinite(value, label) {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be greater than zero`);
  return value;
}

export function createTerrainSamplingPlan(
  route,
  { maxSpacingMeters = 100, maxSamples = MAX_TERRAIN_SAMPLES } = {},
) {
  positiveFinite(maxSpacingMeters, 'maxSpacingMeters');
  positiveFinite(maxSamples, 'maxSamples');
  const points = getRoutePoints(route);
  const segments = [];
  const samples = [];
  let routeOffsetMeters = 0;

  for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
    const start = points[segmentIndex];
    const end = points[segmentIndex + 1];
    const lengthMeters = distanceMeters(start, end);
    const intervalCount = Math.max(1, Math.ceil(lengthMeters / maxSpacingMeters));
    if (samples.length + intervalCount + 1 > maxSamples) {
      throw new RangeError(`Terrain route exceeds the ${maxSamples}-sample planning limit`);
    }
    const segmentSamples = [];
    for (let sampleIndex = 0; sampleIndex <= intervalCount; sampleIndex += 1) {
      const fraction = sampleIndex / intervalCount;
      const position = interpolateGeodesic(start, end, fraction);
      const sample = Object.freeze({
        id: `terrain-${segmentIndex}-${sampleIndex}`,
        routeSegmentIndex: segmentIndex,
        segmentSampleIndex: sampleIndex,
        fraction,
        latitude: position.latitude,
        longitude: position.longitude,
        distanceFromSegmentStartMeters: lengthMeters * fraction,
        cumulativeDistanceMeters: routeOffsetMeters + lengthMeters * fraction,
      });
      segmentSamples.push(sample);
      samples.push(sample);
    }
    segments.push(Object.freeze({
      routeSegmentIndex: segmentIndex,
      lengthMeters,
      samples: Object.freeze(segmentSamples),
    }));
    routeOffsetMeters += lengthMeters;
  }

  return Object.freeze({
    maxSpacingMeters,
    totalLengthMeters: routeOffsetMeters,
    segments: Object.freeze(segments),
    samples: Object.freeze(samples),
  });
}

function terrainHeight(result) {
  if (Number.isFinite(result)) return result;
  if (!result || typeof result !== 'object') return null;
  const value = result.terrainHeightMsl ?? result.heightMsl ?? result.heightMeters;
  return Number.isFinite(value) ? value : null;
}

function resultForSample(results, sample, index) {
  if (Array.isArray(results)) return results[index];
  if (results instanceof Map) return results.get(sample.id);
  if (results && typeof results === 'object') return results[sample.id];
  return undefined;
}

export async function sampleTerrain(plan, sampler) {
  if (!plan?.samples || !Array.isArray(plan.samples)) {
    throw new TypeError('a terrain sampling plan is required');
  }
  if (typeof sampler !== 'function') throw new TypeError('sampler must be a function');

  const requests = Object.freeze(plan.samples.map((sample) => Object.freeze({
    id: sample.id,
    latitude: sample.latitude,
    longitude: sample.longitude,
  })));
  const results = await sampler(requests);
  const missing = [];
  const samples = plan.samples.map((sample, index) => {
    const height = terrainHeight(resultForSample(results, sample, index));
    if (height == null) missing.push(sample.id);
    return Object.freeze({ ...sample, terrainHeightMsl: height });
  });
  if (missing.length) throw new MissingTerrainSampleError(missing);

  return Object.freeze({ plan, samples: Object.freeze(samples) });
}
