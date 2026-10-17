import { createLocalGeoJsonLayer } from '../../data/localGeojsonCore.js';

/** Render CABA inventory points using the shared infrastructure lifecycle. */
export function createCabaTrafficLayer({ source, services }) {
  if (typeof source?.getFeatures !== 'function') {
    throw new TypeError('A CABA inventory source is required');
  }
  return createLocalGeoJsonLayer(
    {
      id: 'caba-traffic-enforcement',
      name: 'CABA Traffic Enforcement',
      color: '#ffb347',
      icon: '◉',
      source: 'Buenos Aires Data · location inventory',
      loadFeatures: (options) => source.getFeatures(options),
      osmDerived: false,
      labels: true,
      labelMax: 300,
      labelGridPx: 138,
    },
    services,
  );
}
