import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createNwsZoneResolver,
  createWeatherAlertsSource,
  normalizeCapSnapshot,
} from './source.js';

const nws = 'https://api.weather.gov/alerts/active.atom';
const area = (geocode = '', geometry = null) => ({
  description: 'County and forecast zone',
  geocode,
  geometry,
});
const alert = (overrides = {}) => ({
  identifier: 'urn:oid:1.2.3',
  sender: 'w-nws.webmaster@noaa.gov',
  sent: '2026-01-01T00:00:00Z',
  msgType: 'Alert',
  status: 'Actual',
  scope: 'Public',
  source: nws,
  region: 'US',
  info: [
    {
      language: 'en-US',
      event: 'Tornado Warning',
      severity: 'Extreme',
      urgency: 'Immediate',
      certainty: 'Observed',
      headline: 'Tornado Warning issued',
      description: 'Take shelter now.',
      onset: '2026-01-01T00:00:00Z',
      expires: '2030-01-01T00:00:00Z',
      areas: [area()],
    },
  ],
  ...overrides,
});
const payload = (alerts) => ({
  source: 'cap',
  generatedAt: '2026-01-01T00:00:00Z',
  alerts,
});
const featureResponse = (geometry) =>
  new Response(JSON.stringify({ type: 'Feature', geometry }), {
    status: 200,
    headers: { 'content-type': 'application/geo+json' },
  });

test('projects current NWS alerts, including CAP polygon coordinate order', () => {
  const polygonAlert = alert();
  polygonAlert.info[0].areas = [
    area('', {
      type: 'polygon',
      coordinates: [
        [37, -122],
        [37, -121],
        [38, -121],
        [37, -122],
      ],
    }),
  ];
  const snapshot = normalizeCapSnapshot(
    payload([
      polygonAlert,
      alert({ identifier: 'cancelled', msgType: 'Cancel' }),
      alert({ identifier: 'foreign', region: 'Canada' }),
      alert({ identifier: 'expired', info: [{ ...alert().info[0], expires: '2020-01-01T00:00:00Z' }] }),
    ]),
    { now: Date.parse('2026-01-01T00:00:00Z') },
  );
  assert.equal(snapshot.alerts.length, 1);
  assert.equal(snapshot.alerts[0].severity, 'Extreme');
  assert.deepEqual(snapshot.alerts[0].geometries[0].coordinates[0][0], [-122, 37]);
});

test('drops update lifecycle messages instead of inferring CAP state locally', () => {
  const snapshot = normalizeCapSnapshot(
    payload([
      alert({ identifier: 'live', msgType: 'Alert' }),
      alert({ identifier: 'update', msgType: 'Update' }),
      alert({ identifier: 'cancelled', msgType: 'Cancel' }),
    ]),
    { now: Date.parse('2026-01-01T00:00:00Z') },
  );
  assert.deepEqual(snapshot.alerts.map((item) => item.id), ['live']);
});

test('resolves forecast, county and fire zones with bounded concurrency and caches results', async () => {
  let active = 0;
  let maximum = 0;
  const requests = [];
  const resolver = createNwsZoneResolver({
    concurrency: 5,
    fetchImpl: async (url) => {
      active++;
      requests.push(url);
      maximum = Math.max(maximum, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      const id = new URL(url, 'http://localhost').pathname.split('/').at(-1);
      const offset = Number(id.slice(-3));
      return featureResponse({
        type: 'Polygon',
        coordinates: [[
          [-123 + offset / 1000, 37],
          [-122 + offset / 1000, 37],
          [-122 + offset / 1000, 38],
          [-123 + offset / 1000, 37],
        ]],
      });
    },
  });
  const records = Array.from({ length: 12 }, (_, index) => ({
    ...normalizeCapSnapshot(
      payload([
        alert({
          identifier: `alert-${index}`,
          info: [
            {
              ...alert().info[0],
              event: index === 11 ? 'Fire Weather Warning' : 'Flood Warning',
              areas: [area(`CAZ${String(index + 1).padStart(3, '0')}`)],
            },
          ],
        }),
      ]),
    ).alerts[0],
  }));
  records[0].areas[0].geocode = 'CAC001';
  records[11].areas[0].geocode = 'CAZ012';
  const resolved = await resolver.resolve(records);
  assert.equal(maximum, 5);
  assert.equal(resolved.filter((item) => item.geometries.length).length, 12);
  assert.equal(requests.length, 12);
  assert.ok(requests.some((url) => url.includes('/api/weather-zones/county/CAC001')));
  assert.ok(requests.some((url) => url.includes('/api/weather-zones/forecast/CAZ002')));
  assert.ok(requests.some((url) => url.includes('/api/weather-zones/fire/CAZ012')));
  const before = requests.length;
  await resolver.resolve(records.slice(0, 5));
  assert.equal(requests.length, before);
  assert.equal(resolver.getCacheSize(), 12);
});

test('source requests the same-origin CAP endpoint and returns an empty valid snapshot', async () => {
  const urls = [];
  const source = createWeatherAlertsSource({
    fetchImpl: async (url, options) => {
      urls.push([url, options]);
      return new Response(JSON.stringify(payload([])), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(urls[0][0], '/api/cap');
  assert.equal(urls[0][1].redirect, 'error');
  assert.deepEqual(snapshot.alerts, []);
});

test('rejects malformed CAP envelope', () => {
  assert.throws(() => normalizeCapSnapshot({ source: 'other', alerts: [] }));
});