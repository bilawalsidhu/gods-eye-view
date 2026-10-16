import assert from 'node:assert/strict';
import test from 'node:test';
import { composeCatalog, coreTools } from './index.js';
import { viewFromParams } from '../view/index.js';
import { cameraForArea, cameraLookingAt, suggestView } from './views.js';
import { resolveArea } from './area.js';

const app = { baseUrl: 'https://maps.example/' };
const snapshot = (records, extra = {}) => ({
  records,
  complete: true,
  source: 'Test feed',
  observedAtMs: Date.UTC(2026, 0, 1),
  freshness: 'current',
  ...extra,
});
const aircraft = (id, latitude, longitude, extra = {}) => ({
  id,
  latitude,
  longitude,
  callsign: 'UAL1',
  baroAltitudeM: 10000,
  onGround: false,
  positionTimeMs: Date.UTC(2026, 0, 1),
  ...extra,
});
const feed = (records) => ({ getSnapshot: async () => snapshot(records) });

test('suggested views frame an area or point and link to the app', async () => {
  const area = await resolveArea({ lat: 30, lon: -97, radius_km: 10 });
  const view = suggestView({ app }, { area, layers: ['flights'] });
  assert.deepEqual(view.camera, {
    ...cameraForArea(area),
    altitude_m: Math.round(cameraForArea(area).altitude_m),
    heading_deg: 0,
    pitch_deg: -90,
  });
  assert.deepEqual(view.layers, ['flights']);
  const params = new URLSearchParams(new URL(view.url).hash.slice(1));
  const { url, ...rest } = view;
  assert.deepEqual(viewFromParams(params), rest);
  assert.equal(suggestView({}, { area, layers: [] }).url, null);
  assert.equal(
    suggestView({ app: { baseUrl: 'not a url' } }, { area }).url,
    null,
  );
  const point = suggestView({ app }, { point: { lat: 1, lon: 2 } });
  assert.equal(point.camera.altitude_m, 50000);
});

test('answers carry the view that shows them', async () => {
  const catalog = composeCatalog({
    tools: coreTools,
    services: {
      app,
      aircraft: feed([aircraft('abc123', 37.62, -122.38)]),
      military: feed([]),
    },
  });
  const area = await catalog.call('aircraft_in_area', {
    area: { lat: 37.62, lon: -122.38, radius_km: 20 },
  });
  assert.deepEqual(area.data.view.layers, ['flights']);
  assert.match(area.data.view.url, /^https:\/\/maps\.example\/#v=2&/);
  const found = await catalog.call('find_aircraft', { callsign: 'UAL1' });
  assert.deepEqual(found.data.view.follow, { kind: 'aircraft', id: 'abc123' });
  assert.deepEqual(found.data.view.layers, ['flights']);
});

test('the flood and the brief frame what they describe', async () => {
  const { readFile } = await import('node:fs/promises');
  const bundled = JSON.parse(
    await readFile(
      new URL(
        '../../public/events/bhote-koshi-2026/event.json',
        import.meta.url,
      ),
      'utf8',
    ),
  );
  const flood = await composeCatalog({
    tools: coreTools,
    services: { app, events: { getEvent: async () => bundled } },
  }).call('get_bhote_koshi_flood', {});
  assert.deepEqual(flood.data.view.layers, ['bhote-koshi-2026']);
  assert.ok(Math.abs(flood.data.view.camera.lat - 28.13) < 0.2);
  assert.ok(Math.abs(flood.data.view.camera.lon - 85.32) < 0.2);
  const brief = await composeCatalog({
    tools: coreTools,
    services: {
      app,
      weather: {
        getConditions: async () => ({ status: 'ready', weather: {} }),
      },
      aircraft: feed([]),
      earthquakes: { getSnapshot: async () => [] },
    },
  }).call('situation_brief', {
    area: { lat: 30, lon: -97, radius_km: 50 },
  });
  assert.deepEqual(brief.data.view.layers, ['earthquakes', 'flights']);
});

test('a tilted camera sits behind the point it looks at', () => {
  const target = { lat: 25, lon: 121 };
  assert.deepEqual(cameraLookingAt(target, { altitudeM: 1000 }), {
    lat: 25,
    lon: 121,
    altitude_m: 1000,
    heading_deg: 0,
    pitch_deg: -90,
  });
  // Looking north at 45 degrees from 10 km up: about 10 km south.
  const north = cameraLookingAt(target, {
    altitudeM: 10000,
    headingDeg: 0,
    pitchDeg: -45,
  });
  assert.ok(Math.abs(north.lat - (25 - 10000 / 111195)) < 1e-3);
  assert.ok(Math.abs(north.lon - 121) < 1e-9);
  // Looking east: the camera is to the west.
  const east = cameraLookingAt(target, {
    altitudeM: 10000,
    headingDeg: 90,
    pitchDeg: -45,
  });
  assert.ok(east.lon < 121 && Math.abs(east.lat - 25) < 1e-9);
});
