import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createOpenAqAcquisition,
  openAqProxy,
  AFRICA_SCOPE,
} from './openAq.js';
const start = Date.parse('2026-10-20T12:00:00Z');
const countries = [
  { id: 1, code: 'KE' },
  { id: 2, code: 'NG' },
  { id: 3, code: 'ZA' },
  { id: 4, code: 'FR' },
];
const locations = countries.map((country, i) => ({
  id: i + 1,
  name: country.code,
  country,
  datetimeLast: { utc: new Date(start).toISOString() },
  coordinates: { latitude: 0, longitude: 20 },
  sensors: [{ id: 100 + i, parameter: { name: 'pm25', units: 'µg/m³' } }],
}));
function fixture({
  now = () => start,
  getKey = () => 'test-private-key',
  batchSize = 24,
  fail = () => 0,
} = {}) {
  const calls = [];
  const source = createOpenAqAcquisition({
    scope: AFRICA_SCOPE,
    now,
    getKey,
    batchSize,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers['X-API-Key'], getKey());
      assert.equal(options.redirect, 'error');
      const status = fail(url);
      if (status)
        return new Response('', { status, headers: { 'Retry-After': '120' } });
      if (url.includes('/countries?'))
        return Response.json({ results: countries });
      if (url.includes('/locations?'))
        return Response.json({
          results: locations.filter((l) => l.country.code !== 'FR'),
        });
      const id = Number(url.match(/locations\/(\d+)/)[1]);
      return Response.json({
        results: [
          {
            locationsId: id,
            sensorsId: 99 + id,
            value: id,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  return { source, calls };
}
test('Africa includes all subregions and islands, not a list of station IDs', () => {
  for (const code of [
    'ZA',
    'NG',
    'KE',
    'EG',
    'MA',
    'CD',
    'MG',
    'MU',
    'SC',
    'CV',
    'RE',
    'YT',
    'SH',
  ])
    assert.ok(AFRICA_SCOPE.countries.includes(code));
  assert.ok(!AFRICA_SCOPE.countries.includes('FR'));
});
test('national discovery is coalesced, bounded and progressive across countries', async () => {
  let clock = start;
  const { source, calls } = fixture({ now: () => clock, batchSize: 1 });
  const [a, b] = await Promise.all([
    source.getSnapshot(),
    source.getSnapshot(),
  ]);
  assert.equal(a, b);
  assert.equal(calls.length, 3);
  assert.equal(a.stations.length, 3);
  assert.equal(a.checked, 1);
  assert.equal(a.partial, true);
  assert.match(calls[1].url, /countries_id=1,2,3&/);
  clock += 61_000;
  const next = await source.getSnapshot();
  assert.equal(next.checked, 2);
  clock += 61_000;
  const complete = await source.getSnapshot();
  assert.equal(complete.checked, 3);
  assert.equal(complete.countriesReporting, 3);
  assert.equal(complete.partial, false);
  assert.ok(!JSON.stringify(complete).includes('test-private-key'));
});
test('no key never fetches; removal cannot reveal old cached data', async () => {
  let key = '';
  const { source, calls } = fixture({ getKey: () => key });
  await assert.rejects(source.getSnapshot(), (e) => e.status === 428);
  assert.equal(calls.length, 0);
  key = 'private';
  await source.getSnapshot();
  key = '';
  await assert.rejects(source.getSnapshot(), (e) => e.status === 428);
});
test('rejected keys never fall back to cache and 429 respects retry window', async () => {
  let clock = start,
    status = 0;
  const { source, calls } = fixture({ now: () => clock, fail: () => status });
  await source.getSnapshot();
  clock += 21 * 60_000;
  status = 401;
  await assert.rejects(source.getSnapshot(), (e) => e.status === 401);
  status = 429;
  const cached = await source.getSnapshot();
  assert.equal(cached.stale, true);
  const count = calls.length;
  await source.getSnapshot();
  assert.equal(calls.length, count);
});
test('fixed routes reject arbitrary queries/methods in dev and preview', async () => {
  const plugin = openAqProxy({ getKey: () => '' });
  let handler;
  plugin.configureServer({
    middlewares: {
      use(path, h) {
        assert.equal(path, '/api/air-quality/openaq');
        handler = h;
      },
    },
  });
  for (const [method, url, status] of [
    ['GET', '/', 428],
    ['POST', '/', 405],
    ['GET', '/?url=https://other.invalid', 400],
  ]) {
    let code;
    await handler(
      { method, url },
      {
        writeHead(s) {
          code = s;
        },
        end() {},
      },
    );
    assert.equal(code, status);
  }
  let preview;
  plugin.configurePreviewServer({
    middlewares: {
      use(_p, h) {
        preview = h;
      },
    },
  });
  assert.equal(preview, handler);
});

test('Vite registration hooks do not return the Connect application as a post-hook', () => {
  const plugin = openAqProxy({ getKey: () => '' });
  const server = {
    middlewares: { use: () => function connectApplication() {} },
  };
  assert.equal(plugin.configureServer(server), undefined);
  assert.equal(plugin.configurePreviewServer(server), undefined);
});

test('global default resumes beyond ten catalog pages and uses bulk latest observations', async () => {
  let clock = start;
  const calls = [];
  const world = ['KE', 'FR', 'US', 'JP', 'AU', 'BR'].map((code, i) => ({
    ...locations[0],
    id: i + 1,
    country: { code },
    sensors: [{ id: 100 + i, parameter: { name: 'pm25', units: 'µg/m³' } }],
  }));
  const source = createOpenAqAcquisition({
    getKey: () => 'private',
    now: () => clock,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      calls.push(url);
      if (url.pathname === '/v3/locations') {
        const page = Number(url.searchParams.get('page'));
        return Response.json({
          results:
            page <= 11
              ? Array.from({ length: 1000 }, (_, i) => world[i % world.length])
              : world,
        });
      }
      if (url.pathname === '/v3/parameters')
        return Response.json({ results: [{ id: 2, name: 'pm25' }] });
      assert.equal(url.pathname, '/v3/parameters/2/latest');
      assert.ok(url.searchParams.get('datetime_min'));
      return Response.json({
        results: world.map((l, i) => ({
          locationsId: l.id,
          sensorsId: 100 + i,
          value: i + 1,
          datetime: { utc: new Date(start).toISOString() },
        })),
      });
    },
  });
  const first = await source.getSnapshot();
  assert.equal(first.scope, 'global');
  assert.equal(first.catalogComplete, false);
  assert.equal(first.partial, true);
  assert.equal(first.countriesReporting, 6);
  assert.equal(first.readings.length, 6);
  clock += 61_000;
  const second = await source.getSnapshot();
  assert.equal(second.catalogComplete, true);
  assert.equal(second.partial, false);
  assert.equal(second.readings.length, 6);
  assert.ok(calls.some((u) => u.searchParams.get('page') === '12'));
  assert.ok(calls.every((u) => !u.searchParams.has('countries_id')));
  assert.ok(!JSON.stringify(second).includes('private'));
});

test('global bulk latest pagination preserves progress, deduplicates and expires old readings', async () => {
  let clock = start;
  const pages = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'key',
    now: () => clock,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/v3/locations')
        return Response.json({ results: [locations[0]] });
      if (url.pathname === '/v3/parameters')
        return Response.json({ results: [{ id: 2, name: 'pm25' }] });
      const page = Number(url.searchParams.get('page'));
      pages.push(page);
      const row = {
        locationsId: 1,
        sensorsId: 100,
        value: 4,
        datetime: { utc: new Date(start).toISOString() },
      };
      return Response.json({
        results: page <= 17 ? Array(1000).fill(row) : [row],
      });
    },
  });
  const a = await source.getSnapshot();
  assert.equal(a.partial, true);
  assert.equal(a.readings.length, 1);
  clock += 61_000;
  const b = await source.getSnapshot();
  assert.equal(b.partial, false);
  assert.equal(b.readings.length, 1);
  assert.ok(pages.includes(18));
  clock += 7 * 3600_000;
  assert.equal((await source.getSnapshot()).readings.length, 0);
});

test('global discovery isolates missing pollutant feeds and preserves results on transient failures', async () => {
  let clock = start,
    status = 404,
    key = 'first';
  const source = createOpenAqAcquisition({
    now: () => clock,
    getKey: () => key,
    fetchImpl: async (raw) => {
      const path = new URL(raw).pathname;
      if (key === 'rejected') return new Response('', { status: 401 });
      if (path === '/v3/locations')
        return Response.json({ results: [locations[0]] });
      if (path === '/v3/parameters')
        return Response.json({
          results: [
            { id: 2, name: 'pm25' },
            { id: 21, name: 'h2s' },
          ],
        });
      if (path === '/v3/parameters/21/latest')
        return new Response('', { status });
      return Response.json({
        results: [
          {
            locationsId: 1,
            sensorsId: 100,
            value: 2,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  const a = await source.getSnapshot();
  assert.equal(a.readings.length, 1);
  assert.equal(a.stale, false);
  clock += 61_000;
  status = 503;
  const b = await source.getSnapshot();
  assert.equal(b.readings.length, 1);
  assert.equal(b.stale, true);
  assert.equal(b.partial, true);
  key = 'rejected';
  await assert.rejects(source.getSnapshot(), (e) => e.status === 401);
  key = '';
  await assert.rejects(source.getSnapshot(), (e) => e.status === 428);
});
