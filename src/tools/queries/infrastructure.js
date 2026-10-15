/** Bundled infrastructure: OpenStreetMap and IGN Argentina. */

import { suggestView } from '../views.js';
import { defineTool } from '../catalog.js';
import {
  AREA_SCHEMA,
  areaCenter,
  areaContains,
  distanceKm,
  resolveArea,
} from '../area.js';
import { LIMIT_SCHEMA, capRows, countNoun } from '../results.js';

const KINDS = {
  datacenters: { layerId: 'local-datacenters', noun: 'datacenter' },
  dams: { layerId: 'local-dams', noun: 'dam' },
};
const ATTRIBUTION = {
  datacenters: '© OpenStreetMap contributors (ODbL 1.0)',
  dams: '© OpenStreetMap contributors (ODbL 1.0), via Open Infrastructure Map; FUENTE: Instituto Geográfico Nacional de la República Argentina (Dique snapshot retrieved 2026-10-15; source update date not supplied; IGN reuse terms)',
};

const round = (value, digits) =>
  Number.isFinite(value) ? Number(value.toFixed(digits)) : null;

export const findInfrastructure = defineTool({
  name: 'find_infrastructure',
  title: 'Datacenters and dams',
  description:
    'Datacenters (with operator and capacity) or dams (with river and power ' +
    'output) from OpenStreetMap and IGN Argentina within an area, nearest the center first.',
  inputSchema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: Object.keys(KINDS) },
      area: AREA_SCHEMA,
      limit: LIMIT_SCHEMA,
    },
    required: ['kind', 'area'],
    additionalProperties: false,
  },
  requires: ['infrastructure'],
  async run(args, { services, signal }) {
    const area = await resolveArea(args.area, { services, signal });
    const center = areaCenter(area);
    const { layerId, noun } = KINDS[args.kind];
    const records = await services.infrastructure.getRecords(layerId, {
      signal,
    });
    const rows = records
      .filter((record) => areaContains(area, record))
      .map((record) => ({
        name: record.name,
        operator: record.operator,
        ...(args.kind === 'datacenters'
          ? { capacity: record.capacity }
          : { river: record.river, output: record.output }),
        lat: round(record.lat, 5),
        lon: round(record.lon, 5),
        distance_km: round(distanceKm(center, record), 1),
      }))
      .sort((a, b) => a.distance_km - b.distance_km);
    return {
      summary: `${countNoun(rows.length, `mapped ${noun}`)} in ${area.label}.`,
      data: {
        view: suggestView(services, { area, layers: [layerId] }),
        ...capRows(rows, args.limit),
        attribution: ATTRIBUTION[args.kind],
      },
    };
  },
});
