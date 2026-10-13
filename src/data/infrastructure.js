import { createLocalGeoJsonLayer } from './localGeojsonCore.js';
import { INFRASTRUCTURE_DATA_URLS } from '../sources/infrastructureData.js';

/**
 * Create fresh datacenter, dam, and power plant layers without starting or loading them.
 * @param {object} services Caller-owned context, overlay and render operations.
 * @returns {object[]} Datacenters, dams, then power plants, with stable standalone identities.
 */
export function createInfrastructureLayers(services) {
  const datacentersUrl = INFRASTRUCTURE_DATA_URLS['local-datacenters'];
  const damsUrl = INFRASTRUCTURE_DATA_URLS['local-dams'];
  const powerPlantsUrl = INFRASTRUCTURE_DATA_URLS['local-power-plants'];
  const datacenters = createLocalGeoJsonLayer(
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

  const dams = createLocalGeoJsonLayer(
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

  const powerPlants = createLocalGeoJsonLayer(
    {
      id: 'local-power-plants',
      url: powerPlantsUrl,
      name: 'Power Plants',
      color: '#ffaa00', // Amber
      icon: '⚡',
      source: 'WRI / OSM',
      osmDerived: true,
      labels: true,
      labelMax: 800,
      labelGridPx: 135,
    },
    services,
  );

  return [datacenters, dams, powerPlants];
}
