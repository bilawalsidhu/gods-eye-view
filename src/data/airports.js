import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create the bundled Norwegian airports layer without starting or loading it.
 * Aerodromes carry the stem and card; their runways (and new Bodø Airport's
 * terminal) are drawn surfaces with a `role` and no card of their own.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @param {object} [options] Factory overrides (e.g. the click-handler factory).
 * @returns {object} The `local-airports` layer.
 */
export function createAirportsLayer(services, options = {}) {
  return createLocalGeoJsonLayer(
    {
      id: 'local-airports',
      url: INFRASTRUCTURE_DATA_URLS['local-airports'],
      name: 'Airports',
      color: '#7fd1ff', // Sky blue
      icon: '✈',
      source: 'OpenStreetMap · Norway',
      osmDerived: true,
      labels: true,
      labelMax: 120,
      labelGridPx: 132,
      ...options,
    },
    services,
  );
}
