import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from '../index.js';

const earthquakes = {
  getSnapshot: async () => [
    {
      stableId: 'a',
      usgsId: 'us1',
      lon: 121.5,
      lat: 24,
      depthKm: 10,
      mag: 5.1,
      place: 'near Hualien',
      time: Date.UTC(2026, 0, 1, 1),
    },
    {
      stableId: 'b',
      usgsId: 'us2',
      lon: -120,
      lat: 36,
      depthKm: 5,
      mag: 3.2,
      place: 'Central California',
      time: Date.UTC(2026, 0, 1, 2),
    },
    {
      stableId: 'c',
      usgsId: null,
      lon: 122,
      lat: 23.5,
      depthKm: null,
      mag: 2.6,
      place: null,
      time: null,
    },
  ],
};
const fires = (snapshot) => ({ getSnapshot: async () => snapshot });
const launches = (payload) => ({ getLaunches: async () => payload });
const taiwan = {
  resolve: async () => ({
    name: 'Taiwan',
    bounds: { west: 119, south: 21, east: 123, north: 26 },
  }),
};

test('earthquakes are filtered, ordered strongest first and capped', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: { earthquakes, places: taiwan },
  });
  const all = await catalog.call('get_earthquakes', {});
  assert.equal(
    all.summary,
    '3 earthquakes of M2.5+ in the last 24 hours worldwide; strongest M5.1 near Hualien.',
  );
  assert.deepEqual(
    all.data.rows.map((row) => row.id),
    ['us1', 'us2', 'c'],
  );
  assert.deepEqual(all.data.rows[0], {
    id: 'us1',
    magnitude: 5.1,
    place: 'near Hualien',
    time: '2026-01-01T01:00:00.000Z',
    lat: 24,
    lon: 121.5,
    depth_km: 10,
  });

  const local = await catalog.call('get_earthquakes', {
    area: { place: 'Taiwan' },
    min_magnitude: 3,
    limit: 1,
  });
  assert.equal(
    local.summary,
    '1 earthquake of M3+ in the last 24 hours in Taiwan; strongest M5.1 near Hualien.',
  );
  assert.deepEqual(
    {
      total: local.data.total,
      returned: local.data.returned,
      truncated: local.data.truncated,
    },
    { total: 1, returned: 1, truncated: false },
  );

  const capped = await catalog.call('get_earthquakes', { limit: 2 });
  assert.equal(capped.data.truncated, true);
  assert.equal(capped.data.total, 3);
});

test('fires need an area and report a missing key as unavailable', async () => {
  const snapshot = {
    fires: [
      {
        lat: 24,
        lon: 121,
        frp: 12,
        confidence: 'h',
        acqDate: '2026-01-01',
        acqTime: '0130',
        satellite: 'N',
        daynight: 'N',
      },
      { lat: 25, lon: 122, frp: 40 },
      { lat: -33, lon: 151, frp: 99 },
    ],
  };
  const catalog = composeCatalog({
    tools: coreTools,
    services: { fires: fires(snapshot), places: taiwan },
  });
  await assert.rejects(catalog.call('get_active_fires', {}), /missing area/);
  const result = await catalog.call('get_active_fires', {
    area: { place: 'Taiwan' },
  });
  assert.equal(
    result.summary,
    '2 fire detections in Taiwan in the last 24 hours.',
  );
  assert.deepEqual(
    result.data.rows.map((row) => row.frp_mw),
    [40, 12],
  );
  assert.equal(result.data.rows[1].acquired, '2026-01-01 0130');

  const keyless = composeCatalog({
    tools: coreTools,
    services: { fires: fires({ keyRequired: true }) },
  });
  await assert.rejects(
    keyless.call('get_active_fires', { area: { bbox: [0, 0, 1, 1] } }),
    (error) =>
      error.code === 'unavailable' && /NASA FIRMS key/.test(error.message),
  );
});

test('recent launches are newest first with missing fields as null', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      launches: launches({
        results: [
          {
            id: 'old',
            name: 'Falcon 9 | Starlink',
            net: '2026-01-01T00:00:00Z',
            status: { name: 'Launch Successful' },
          },
          {
            id: 'new',
            name: 'Electron | Mission',
            net: '2026-01-05T00:00:00Z',
            launch_service_provider: { name: 'Rocket Lab' },
            rocket: { configuration: { full_name: 'Electron' } },
            pad: { name: 'LC-1A', location: { name: 'Mahia' } },
            mission: { name: 'Mission', orbit: { name: 'Low Earth Orbit' } },
          },
          { id: 'unnamed' },
        ],
      }),
    },
  });
  const result = await catalog.call('get_recent_launches', {});
  assert.equal(
    result.summary,
    '2 launches in the last 30 days; latest Electron | Mission.',
  );
  assert.deepEqual(result.data.rows[0], {
    id: 'new',
    name: 'Electron | Mission',
    time: '2026-01-05T00:00:00Z',
    status: null,
    provider: 'Rocket Lab',
    rocket: 'Electron',
    pad: 'LC-1A',
    location: 'Mahia',
    mission: 'Mission',
    orbit: 'Low Earth Orbit',
  });
  const broken = composeCatalog({
    tools: coreTools,
    services: { launches: launches({}) },
  });
  await assert.rejects(
    broken.call('get_recent_launches', {}),
    (error) => error.code === 'malformed',
  );
});

test('every core tool is a read-only query with a unique name', () => {
  const names = coreTools.map((tool) => tool.name);
  assert.equal(new Set(names).size, names.length);
  for (const tool of coreTools) {
    assert.equal(tool.kind, 'query', tool.name);
    assert.equal(tool.annotations.readOnlyHint, true, tool.name);
    assert.ok(tool.requires.length > 0, tool.name);
  }
});
