// USGS-shaped fixed observations; source parsers remain the production ones.
export const W2_EPOCH_MS = 1792152000000;
export function earthquakeFixture() {
  const features = [];
  for (const [region, lon, lat] of [
    ['sf', -122.42, 37.77],
    ['austin', -97.74, 30.27],
    ['alaska', -150.4, 61.0],
  ]) {
    for (let i = 0; i < 5; i++) {
      features.push({
        type: 'Feature',
        id: `qa-${region}-${i}`,
        geometry: {
          type: 'Point',
          coordinates: [
            lon + (i - 2) * 0.24,
            lat + (i % 2) * 0.3,
            [8, 70, 300, 301, 45][i],
          ],
        },
        properties: {
          mag: [2.5, 3, 4, 5, 5.5][i],
          place: `W2 ${region} event ${i}`,
          time: W2_EPOCH_MS - i * 60000,
        },
      });
    }
  }
  features.push({
    type: 'Feature',
    id: 'qa-below',
    geometry: { type: 'Point', coordinates: [-122.42, 37.77, 5] },
    properties: { mag: 2.4 },
  });
  features.push({
    type: 'Feature',
    id: 'qa-missing-mag',
    geometry: { type: 'Point', coordinates: [-122.4, 37.7, 5] },
    properties: { mag: null },
  });
  return {
    type: 'FeatureCollection',
    metadata: { generated: W2_EPOCH_MS },
    features,
  };
}

/** Dense regional and worldwide USGS-shaped load, separate from the oracle. */
export function earthquakePerformanceFixture(count = 500) {
  let seed = 17;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  return {
    type: 'FeatureCollection',
    features: Array.from({ length: count }, (_, i) => ({
      type: 'Feature',
      id: `perf-quake-${i}`,
      properties: {
        mag: 2.5 + (i % 7) * 0.5,
        place: `Recorded performance event ${i}`,
        time: W2_EPOCH_MS - i * 1000,
      },
      geometry: {
        type: 'Point',
        coordinates:
          i < Math.min(100, count)
            ? [
                -122.42 + (random() - 0.5),
                37.77 + (random() - 0.5),
                [8, 70, 301][i % 3],
              ]
            : [
                -180 + random() * 360,
                -70 + random() * 140,
                [8, 70, 301][i % 3],
              ],
      },
    })),
  };
}
