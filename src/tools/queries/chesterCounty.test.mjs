import test from 'node:test';
import assert from 'node:assert/strict';
import { composeCatalog, coreTools, toolsForSurface } from '../index.js';
import { createLocalMcpServer } from '../../../server/mcp/server.js';

const observedAt = Date.now();
test('expanded county tools preserve completed, reported and unknown-active semantics', async () => {
  const pike = { id: 'pike-pa:fire:2611000001', countyId: 'pike-pa', incidentNumber: '2611000001', category: 'fire', type: 'TEST', reportKind: 'completed', official: true, timeBasis: 'received', receivedAt: observedAt, dispatchedAt: null, dispatched: '11/3/2026 23:00:00', mapPosition: null, locationStatus: 'not-published' };
  const dauphin = { ...pike, id: 'dauphin-pa:fire:'+'a'.repeat(24), countyId: 'dauphin-pa', incidentNumber: null, reportKind: undefined, timeBasis: 'reported', receivedAt: undefined, reportedAt: observedAt, crossStreets: 'ONE ST / TWO ST' };
  const lebanon = { ...pike, id: 'lebanon-pa:fire:'+'b'.repeat(24), countyId: 'lebanon-pa', incidentNumber: null, reportKind: 'dispatch', official: false, timezoneAssumed: true };
  const tools = composeCatalog({ tools: coreTools, services: { countyIncidents: { getSnapshot: async () => ({ rows: [pike,dauphin,lebanon], observedAt, fetchedAt: observedAt, stale: false, countyFeeds: [] }) } } });
  const completed = (await tools.call('get_county_incidents',{county:'pike-pa'})).data.rows[0];
  assert.equal(completed.active_status,'completed'); assert.equal(completed.report_kind,'completed-report');
  assert.equal(completed.source_official,true); assert.equal(completed.dispatched_at,null); assert.equal(completed.dispatch_time_local,null);
  const reported = (await tools.call('get_county_incidents',{county:'dauphin-pa'})).data.rows[0];
  assert.ok(reported.reported_at); assert.equal(reported.dispatched_at,null); assert.equal(reported.cross_streets,'ONE ST / TWO ST');
  const recent = (await tools.call('get_county_incidents',{county:'lebanon-pa'})).data.rows[0];
  assert.equal(recent.active_status,'unknown'); assert.equal(recent.source_official,false); assert.equal(recent.incident_number,null);
});
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

test('generic County EMS tools expose both counties and undated Montgomery units while legacy tools stay Chester-scoped', async () => {
  const montgomery = {
    ...mapped,
    id: 'montgomery-pa:ems:E2600001',
    incidentNumber: 'E2600001',
    countyId: 'montgomery-pa',
    county: 'Montgomery County, PA',
    detailUrl:
      'https://webapp07.montcopa.org/eoc/cadinfo/livecad-incidents.asp?incident=E2600001',
  };
  const combined = {
    ...snapshot,
    rows: [mapped, montgomery],
    countyFeeds: [
      { id: 'chester-pa', count: 1, stale: false },
      { id: 'montgomery-pa', count: 1, stale: false },
    ],
  };
  const services = {
    app: { baseUrl: 'http://localhost:4173' },
    chesterCounty: {
      getSnapshot: async () => ({ ...snapshot, rows: [mapped] }),
    },
    countyIncidents: {
      getSnapshot: async () => combined,
      getIncidentDetails: async () => ({
        ...details,
        incidentNumber: montgomery.incidentNumber,
        timestampBasis: 'retrieved',
        units: [
          {
            unit: '001-1',
            status: 'Enroute',
            entered: '10:05 AM',
            enteredAt: null,
          },
        ],
      }),
    },
  };
  const tools = composeCatalog({ tools: coreTools, services });
  for (const surface of ['mcp', 'voice']) {
    const names = toolsForSurface(coreTools, surface).map((tool) => tool.name);
    assert.ok(names.includes('get_county_incidents'));
    assert.ok(names.includes('get_county_incident_details'));
  }
  const all = await tools.call('get_county_incidents', {});
  assert.equal(all.data.rows.length, 2);
  const county = await tools.call('get_county_incidents', {
    county: 'montgomery-pa',
  });
  assert.equal(county.data.rows.length, 1);
  assert.equal(county.data.rows[0].county_id, 'montgomery-pa');
  assert.equal(
    (await tools.call('get_chester_county_incidents', {})).data.rows.length,
    1,
  );
  const unit = await tools.call('get_county_incident_details', {
    id: montgomery.id,
  });
  assert.equal(unit.data.unit_status.timestamp_basis, 'retrieved');
  assert.equal(unit.data.unit_status.rows[0].entered_at, null);
  assert.equal(unit.data.incident.county, 'Montgomery County, PA');
  await assert.rejects(
    tools.call('get_county_incidents', { county: 'unknown' }),
  );
});

test('Lancaster assignments and community Delco pages keep distinct status, time and provenance in AI results', async () => {
  const lancaster = {
    ...mapped,
    id: 'lancaster-pa:ems:' + 'a'.repeat(24),
    countyId: 'lancaster-pa',
    incidentNumber: null,
    timePrecision: 'minute',
    detailUrl: 'https://www.lcwc911.us/live-incident-list',
  };
  const delco = {
    ...mapped,
    id: 'delaware-pa:ems:F26000001',
    countyId: 'delaware-pa',
    incidentNumber: 'F26000001',
    reportKind: 'dispatch',
    official: false,
    timeBasis: 'received',
    receivedAt: observedAt - 60000,
    dispatchedAt: null,
    timezoneAssumed: true,
    detailUrl: 'https://delcodispat.ch/d/pa/delco',
  };
  const sources = [
    { id: 'lancaster-pa', official: true, count: 1, stale: false },
    {
      id: 'delaware-pa',
      official: false,
      coverageKind: 'recent-dispatches',
      limited: true,
      sourceLimit: 20,
      recentWindowMinutes: 120,
      count: 1,
      stale: false,
      timestampBasis: 'retrieved',
    },
  ];
  const tool = composeCatalog({
    tools: coreTools,
    services: {
      app: { baseUrl: 'http://localhost:4173' },
      countyIncidents: {
        getSnapshot: async () => ({
          ...snapshot,
          rows: [lancaster, delco],
          countyFeeds: sources,
        }),
        getIncidentDetails: async (id) => ({
          id,
          incidentNumber: null,
          observedAt,
          fetchedAt: observedAt,
          assignmentOnly: true,
          timestampBasis: 'retrieved',
          units: [
            { unit: 'AMB01', status: 'Assigned', entered: '', enteredAt: null },
          ],
        }),
      },
    },
  });
  const dispatch = await tool.call('get_county_incidents', {
    county: 'delaware-pa',
  });
  assert.equal(dispatch.data.rows.length, 1);
  assert.equal(dispatch.data.rows[0].active_status, 'unknown');
  assert.equal(dispatch.data.rows[0].source_official, false);
  assert.equal(dispatch.data.rows[0].dispatched_at, null);
  assert.equal(dispatch.data.rows[0].dispatch_time_local, null);
  assert.ok(dispatch.data.rows[0].received_at);
  assert.equal(dispatch.data.rows[0].timezone_assumed, true);
  assert.equal(
    dispatch.data.sources.find((s) => s.county_id === 'delaware-pa').limited,
    true,
  );
  const assigned = await tool.call('get_county_incident_details', {
    id: lancaster.id,
  });
  assert.equal(assigned.data.unit_status.assignment_only, true);
  assert.equal(assigned.data.unit_status.status_times_available, false);
  assert.equal(assigned.data.unit_status.rows[0].entered_at, null);
  assert.equal(assigned.data.incident.time_precision, 'minute');
  assert.match(assigned.summary, /Public report/);
});
