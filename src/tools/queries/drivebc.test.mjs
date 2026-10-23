import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

const fixture = {
  getSnapshot: async () => ({
    partial: false,
    events: [
      {
        id: 'drivebc.ca/closure-1', headline: 'ROAD CLOSURE', status: 'ACTIVE',
        eventType: 'INCIDENT', subtypes: ['ROAD_CONDITION'], severity: 'MAJOR',
        description: 'Highway 1 closed near Hope.', updated: '2026-10-11T09:00:00-07:00',
        geometry: { type: 'Point', coordinates: [-121.44, 49.38] },
      },
      {
        id: 'drivebc.ca/elsewhere', headline: 'CONSTRUCTION', status: 'ACTIVE',
        eventType: 'CONSTRUCTION', subtypes: [], severity: 'MINOR',
        description: 'Road work elsewhere.', updated: null,
        geometry: { type: 'Point', coordinates: [-127, 54] },
      },
    ],
  }),
};

test('BC road conditions are scoped to the requested area and identify DriveBC provenance', async () => {
  const result = await composeCatalog({ tools: coreTools, services: { drivebc: fixture } })
    .call('get_bc_road_conditions', { area: { bbox: [-122, 49, -121, 50] } });
  assert.equal(result.data.source, 'DriveBC Open511 (British Columbia)');
  assert.equal(result.data.total, 1);
  assert.equal(result.data.rows[0].id, 'drivebc.ca/closure-1');
  assert.equal(result.data.rows[0].severity, 'MAJOR');
  assert.match(result.summary, /1 active BC road event/);
});

test('BC road conditions disclose capped source results and no-match coverage', async () => {
  const limited = {
    getSnapshot: async () => ({ ...await fixture.getSnapshot(), partial: true }),
  };
  const result = await composeCatalog({ tools: coreTools, services: { drivebc: limited } })
    .call('get_bc_road_conditions', { area: { bbox: [-100, 30, -99, 31] } });
  assert.equal(result.data.total, 0);
  assert.equal(result.data.partial, true);
  assert.match(result.summary, /No active BC road events/);
  assert.match(result.summary, /page limit/);
});
