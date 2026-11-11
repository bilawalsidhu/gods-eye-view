import { createInfrastructureSessionLayer } from '../layers/infrastructure/index.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create fresh datacenter and dam layers without starting or loading them.
 * @param {object} services Caller-owned context, overlay and credit operations.
 * @param {(config: object, services: object) => object} [createLayer] One
 *   layer from its descriptor; by default a session layer that draws through
 *   the globe contract (src/layers/infrastructure).
 * @returns {object[]} Datacenters then dams, with stable standalone identities.
 */
export function createInfrastructureLayers(
  services,
  createLayer = createInfrastructureSessionLayer,
) {
  const datacentersUrl = INFRASTRUCTURE_DATA_URLS['local-datacenters'];
  const damsUrl = INFRASTRUCTURE_DATA_URLS['local-dams'];
  const datacenters = createLayer(
    {
      id: 'local-datacenters',
      url: datacentersUrl,
      name: 'Datacenters',
      color: '#00ffff', // Cyan
      icon: '▣',
      source: 'Local',
      osmDerived: true,
      labels: true,
      labelMax: 700,
      labelGridPx: 138,
    },
    services,
  );

  const dams = createLayer(
    {
      id: 'local-dams',
      url: damsUrl,
      name: 'Dams',
      color: '#0088ff', // Blue
      icon: '▰',
      source: 'USACE',
      osmDerived: true,
      labels: true,
      labelMax: 900,
      labelGridPx: 132,
    },
    services,
  );

  return [datacenters, dams];
}
