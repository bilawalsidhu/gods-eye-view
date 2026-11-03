import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';
import { createLocalMcpServer } from '../../../server/mcp/server.js';

const observedAt = Date.now();
const mapped = {
  id: 'ems:F26000001',
  incidentNumber: 'F26000001',
  category: 'ems',
  type: 'SYNTHETIC EMS TEST',
  location: 'EXAMPLE RD & TEST ST',
  municipality: 'Example Township',
  dispatched: '11-03-2026 10:00:00',
  dispatchedAt: observedAt - 60000,
  station: '01',
  mapPosition: { lat: 40, lon: -75.7, kind: 'intersection', approximate: true },
  locationStatus: 'matched',
  detailUrl:
    'https://webcad.chesco.org/WebCad/livecadcomments-ems.asp?eid=123&incidentno=F26000001',
};
const unresolved = {
  ...mapped,
  id: 'fire:F26000002',
  incidentNumber: 'F26000002',
  category: 'fire',
  type: 'SYNTHETIC FIRE TEST',
  location: 'UNMATCHED PLACE',
  mapPosition: null,
  locationStatus: 'unmatched',
  dispatchedAt: observedAt - 120000,
  detailUrl: null,
};
const traffic = {
  ...mapped,
  id: 'traffic:P26000003',
  incidentNumber: 'P26000003',
  category: 'traffic',
  type: 'SYNTHETIC TRAFFIC TEST',
  station: '01PD',
  municipality: 'Other Borough',
  mapPosition: null,
  locationStatus: 'unavailable',
  detailUrl: null,
};
const snapshot = {
  rows: [mapped, unresolved, traffic],
  observedAt,
  fetchedAt: observedAt,
  stale: false,
};
const details = {
  incidentNumber: mapped.incidentNumber,
  observedAt,
  fetchedAt: observedAt,
  stale: false,
  units: [
    {
      unit: 'MEDIC01',
      status: 'On Scene',
      entered: '11-03-2026 10:05:00',
      enteredAt: observedAt - 1000,
    },
    {
      unit: 'AMB02',
      status: 'Enroute',
      entered: '11-03-2026 10:04:00',
      enteredAt: observedAt - 2000,
    },
  ],
};
function catalog(service = {}) {
  return composeCatalog({
    tools: coreTools,
    services: {
      app: { baseUrl: 'http://localhost:4173' },
      chesterCounty: {
        getSnapshot: async () => snapshot,
        getIncidentDetails: async () => details,
        ...service,
      },
    },
  });
}

test('MCP and voice discover both incident tools without fetching or enabling a layer', () => {
  for (const surface of ['mcp', 'voice'])
    for (const name of [
      'get_chester_county_incidents',
      'get_chester_county_incident_details',
    ])
      assert.ok(
        toolsForSurface(coreTools, surface).some((tool) => tool.name === name),
      );
  assert.equal(
    composeCatalog({ tools: coreTools }).get('get_chester_county_incidents'),
    undefined,
  );
});
test('list preserves unmapped reports, exact station strings, feed times, limits and honest GIS coverage', async () => {
  const result = await catalog().call('get_chester_county_incidents', {
    limit: 2,
  });
  assert.equal(result.data.total, 3);
  assert.equal(result.data.feed_total, 3);
  assert.equal(result.data.returned, 2);
  assert.equal(result.data.truncated, true);
  assert.deepEqual(result.data.location_coverage, {
    mapped: 1,
    unresolved: 1,
    lookup_errors: 1,
  });
  const all = await catalog().call('get_chester_county_incidents', {});
  assert.equal(all.data.rows.find((r) => r.id === mapped.id).station, '01');
  assert.equal(
    all.data.rows.find((r) => r.id === unresolved.id).position,
    null,
  );
  assert.equal(all.data.rows.find((r) => r.id === traffic.id).agency, '01PD');
  assert.equal(all.data.rows[0].dispatched_at.endsWith('Z'), true);
  assert.match(all.data.caveat, /approximate/);
  assert.deepEqual(all.data.view.layers, ['chester-county-ems']);
  assert.equal(
    (
      await catalog().call('get_chester_county_incidents', {
        category: 'fire',
        municipality: 'EXAMPLE',
        search: 'unmatched',
      })
    ).data.rows[0].id,
    unresolved.id,
  );
  assert.equal(
    (
      await catalog().call('get_chester_county_incidents', {
        search: 'no such report',
      })
    ).data.total,
    0,
  );
});
test('stale or malformed incident sources cannot claim fresh empty coverage', async () => {
  const stale = await catalog({
    getSnapshot: async () => ({ ...snapshot, stale: true }),
  }).call('get_chester_county_incidents', {});
  assert.equal(stale.data.stale, true);
  assert.match(stale.summary, /stale feed/);
  const old = await catalog({
    getSnapshot: async () => ({ ...snapshot, observedAt: Date.now() - 200000 }),
  }).call('get_chester_county_incidents', {});
  assert.equal(old.data.stale, true);
  await assert.rejects(
    catalog({ getSnapshot: async () => ({}) }).call(
      'get_chester_county_incidents',
      {},
    ),
    (e) => e.code === 'malformed',
  );
  await assert.rejects(
    catalog({
      getSnapshot: async () => {
        throw new Error('network');
      },
    }).call('get_chester_county_incidents', {}),
    (e) => e.code === 'unavailable',
  );
});
test('details cap public unit updates, keep source times and distinguish unit failures from a missing report', async () => {
  const result = await catalog().call('get_chester_county_incident_details', {
    id: mapped.id,
    limit: 1,
  });
  assert.equal(result.data.details_available, true);
  assert.equal(result.data.unit_status.unit_count, 2);
  assert.equal(result.data.unit_status.truncated, true);
  assert.equal(result.data.unit_status.rows[0].unit, 'MEDIC01');
  assert.equal(result.data.unit_status.rows[0].status, 'On Scene');
  assert.equal(result.data.unit_status.rows[0].entered_at.endsWith('Z'), true);
  const failed = await catalog({
    getIncidentDetails: async () => {
      throw new Error('offline');
    },
  }).call('get_chester_county_incident_details', { id: mapped.id });
  assert.equal(failed.data.incident.id, mapped.id);
  assert.equal(failed.data.details_available, false);
  assert.equal(failed.data.unit_status, null);
  assert.equal(failed.data.stale, false);
  const empty = await catalog({
    getIncidentDetails: async () => ({ ...details, units: [], stale: true }),
  }).call('get_chester_county_incident_details', { id: mapped.id });
  assert.equal(empty.data.unit_status.unit_count, 0);
  assert.equal(empty.data.unit_status.stale, true);
  await assert.rejects(
    catalog().call('get_chester_county_incident_details', {
      id: 'ems:F26999999',
    }),
    (e) => e.code === 'unavailable',
  );
  await assert.rejects(
    catalog().call('get_chester_county_incident_details', {
      id: 'https://example.com',
    }),
    (e) => e.code === 'invalid_arguments',
  );
});
test('detail identity mismatch fails closed and cancellation reaches both source methods', async () => {
  await assert.rejects(
    catalog({
      getIncidentDetails: async () => ({
        ...details,
        incidentNumber: 'F26000099',
      }),
    }).call('get_chester_county_incident_details', { id: mapped.id }),
    (e) => e.code === 'malformed',
  );
  const controller = new AbortController();
  const seen = [];
  await catalog({
    getSnapshot: async ({ signal }) => {
      seen.push(signal);
      return snapshot;
    },
    getIncidentDetails: async (id, { signal }) => {
      assert.equal(id, mapped.id);
      seen.push(signal);
      return details;
    },
  }).call(
    'get_chester_county_incident_details',
    { id: mapped.id },
    { signal: controller.signal },
  );
  assert.deepEqual(seen, [controller.signal, controller.signal]);
  controller.abort();
  await assert.rejects(
    catalog().call(
      'get_chester_county_incidents',
      {},
      { signal: controller.signal },
    ),
  );
});
test('the real local MCP adapter lists and calls county tools through only the local proxy endpoints', async () => {
  const contacted = [];
  const server = createLocalMcpServer({
    apiBase: 'http://127.0.0.1:5000',
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      contacted.push(parsed.href);
      return Response.json(
        parsed.pathname.endsWith('/details') ? details : snapshot,
      );
    },
  });
  const send = (method, params) =>
    server.handle({ jsonrpc: '2.0', id: 1, method, params });
  await send('initialize', { protocolVersion: '2025-06-18' });
  const list = await send('tools/list');
  assert.ok(
    list.result.tools.some(
      (tool) => tool.name === 'get_chester_county_incidents',
    ),
  );
  assert.ok(
    list.result.tools.some(
      (tool) => tool.name === 'get_chester_county_incident_details',
    ),
  );
  assert.deepEqual(contacted, []);
  const result = await send('tools/call', {
    name: 'get_chester_county_incident_details',
    arguments: { id: mapped.id },
  });
  assert.equal(result.result.isError, false);
  assert.equal(
    result.result.structuredContent.unit_status.rows[0].unit,
    'MEDIC01',
  );
  assert.deepEqual(contacted, [
    'http://127.0.0.1:5000/api/chester-county-ems',
    'http://127.0.0.1:5000/api/chester-county-ems/details?incident=ems%3AF26000001',
  ]);
});
