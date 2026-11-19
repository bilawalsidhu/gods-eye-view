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

test('viewport discovery prioritizes focus, coalesces, and resumes unchecked stations', async () => {
  let clock = start;
  const { source, calls } = fixture({ now: () => clock, batchSize: 1 });
  const view = [0, -40, 50, 10, 18, -34];
  const [a, b] = await Promise.all([
    source.getSnapshot({ view }),
    source.getSnapshot({ view }),
  ]);
  assert.equal(a, b);
  assert.equal(new URL(calls[0].url).searchParams.get('bbox'), '13,-39,23,-29');
  assert.match(calls[1].url, /\/latest\?/); // Observations before another catalog page.
  assert.equal(a.scope, 'viewport');
  assert.equal(a.checked, 1);
  assert.equal(a.partial, true);
  clock += 61_000;
  assert.equal((await source.getSnapshot({ view })).checked, 2);
  clock += 61_000;
  assert.equal((await source.getSnapshot({ view })).partial, false);
  assert.ok(calls.every((c) => !c.url.includes('/countries?')));
});

test('viewport antimeridian queries split; empty coverage is complete only after all pages', async () => {
  let clock = start;
  const boxes = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl: async (url) => {
      boxes.push(new URL(url).searchParams.get('bbox').split(',').map(Number));
      return Response.json({ results: [] });
    },
  });
  const view = [170, -30, -170, 30, 179, 0];
  const first = await source.getSnapshot({ view });
  assert.equal(first.partial, true);
  clock += 61_000;
  let next;
  for (let i = 0; i < 4; i++) {
    next = await source.getSnapshot({ view });
    if (!next.partial) break;
    clock += 8001;
  }
  assert.equal(next.partial, false);
  assert.equal(next.readings.length, 0);
  assert.ok(
    boxes.every(([w, s, e, n]) => w < e && s < n && w >= -180 && e <= 180),
  );
  assert.ok(boxes.some((b) => b[0] === -180));
  assert.ok(boxes.some((b) => b[2] === 180));
});

test('viewport cache is scoped and invalidated when credentials change', async () => {
  let key = 'one';
  const { source, calls } = fixture({ getKey: () => key });
  const a = [0, -10, 30, 10, 20, 0],
    b = [40, -10, 70, 10, 50, 0];
  const first = await source.getSnapshot({ view: a });
  assert.equal(await source.getSnapshot({ view: a }), first);
  const previousCalls = calls.length;
  assert.notEqual(await source.getSnapshot({ view: b }), first);
  assert.ok(calls.length > previousCalls);
  key = 'two';
  assert.notEqual(await source.getSnapshot({ view: a }), first);
  assert.equal(calls.at(-1).options.headers['X-API-Key'], 'two');
});

test('invalid geographic queries fail before upstream requests', async () => {
  const { parseOpenAqView } = await import('./openAq.js');
  for (const input of [
    '',
    '1,2,3,4',
    '1,2,3,4,5,Infinity',
    '181,0,5,10,0,0',
    '0,20,10,0,5,5',
    '0,0,0,10,0,5',
    '0,,10,10,5,5',
  ]) {
    assert.throws(
      () => parseOpenAqView(input),
      (e) => e.status === 400,
    );
  }
  assert.deepEqual(
    parseOpenAqView('-180,-90,180,90,0,0'),
    [-180, -90, 180, 90, 0, 0],
  );
});

test('viewport latest acquisition chooses nearest stations before catalog ID order', async () => {
  const ids = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    batchSize: 1,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/v3/locations')
        return Response.json({
          results: locations.slice(0, 2).map((s, i) => ({
            ...s,
            coordinates: { latitude: 0, longitude: i ? 20 : 40 },
          })),
        });
      ids.push(url.pathname);
      return Response.json({ results: [] });
    },
  });
  await source.getSnapshot({ view: [0, -10, 50, 10, 20, 0] });
  assert.deepEqual(ids, ['/v3/locations/2/latest']);
});

test('catalog reuse survives view eviction and navigation cannot bypass one shared budget', async () => {
  let count = 0;
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async () => {
      count++;
      return Response.json({ results: [] });
    },
  });
  const view = (i) => [i, -1, i + 1, 1, i + 0.5, 0];
  await source.getSnapshot({ view: view(0) });
  for (let i = 1; i <= 8; i++) await source.getSnapshot({ view: view(i) });
  const before = count;
  await source.getSnapshot({ view: view(0) });
  assert.equal(count, before, 'catalog reused after exact-view LRU eviction');
  for (let i = 9; i < 50; i++) await source.getSnapshot({ view: view(i) });
  assert.equal(count, 45, 'navigation cannot bypass per-minute budget');
  const limited = await source.getSnapshot({ view: view(51) });
  assert.equal(limited.partial, true);
  assert.equal(limited.stale, true);
  assert.equal(limited.failureStatus, 429);
  assert.equal(limited.retryAt, start + 60_000);
});

test('overlapping views reuse recent station checks and refresh them after expiry', async () => {
  let clock = start;
  const { source, calls } = fixture({ now: () => clock });
  await source.getSnapshot({ view: [0, -10, 40, 10, 20, 0] });
  const latestCount = () =>
    calls.filter((c) => /\/latest\?/.test(c.url)).length;
  assert.equal(latestCount(), 3);
  const next = await source.getSnapshot({ view: [1, -10, 39, 10, 21, 0] });
  assert.equal(latestCount(), 3);
  assert.equal(next.checked, 3);
  assert.equal(next.stale, false);
  clock += 21 * 60_000;
  await source.getSnapshot({ view: [1, -10, 39, 10, 21, 0] });
  assert.equal(latestCount(), 6);
});

test('eight new globe regions can discover observations within one minute', async () => {
  let calls = 0;
  let region = 0;
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (raw) => {
      calls++;
      const url = new URL(raw);
      if (url.pathname === '/v3/locations') {
        return Response.json({
          results: Array.from({ length: 30 }, (_, i) => ({
            ...locations[0],
            id: region * 100 + i + 1,
            coordinates: { latitude: 0, longitude: region * 40 - 140 },
            sensors: [
              {
                id: region * 100 + i + 1,
                parameter: { name: 'pm25', units: 'µg/m³' },
              },
            ],
          })),
        });
      }
      const id = Number(url.pathname.split('/')[3]);
      return Response.json({
        results: [
          {
            locationsId: id,
            sensorsId: id,
            value: 10,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  for (region = 0; region < 8; region++) {
    const snapshot = await source.getSnapshot({
      view: [region * 40 - 145, -5, region * 40 - 135, 5, region * 40 - 140, 0],
    });
    assert.equal(snapshot.readings.length, 4);
    assert.equal(snapshot.stale, false);
    assert.equal(snapshot.partial, true);
  }
  assert.equal(calls, 40);
});

test('a failed wider catalog page does not suppress available focus observations', async () => {
  let catalogs = 0;
  let clock = start;
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl: async (raw) => {
      if (new URL(raw).pathname === '/v3/locations') {
        if (++catalogs === 2) return new Response('', { status: 503 });
        return Response.json({ results: [locations[0]] });
      }
      return Response.json({
        results: [
          {
            locationsId: 1,
            sensorsId: 100,
            value: 10,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  const request = { view: [-180, -90, 180, 90, 20, 0] };
  assert.equal((await source.getSnapshot(request)).readings.length, 1);
  clock += 8001;
  const result = await source.getSnapshot(request);
  assert.equal(result.readings.length, 1);
  assert.equal(result.stale, true);
  assert.equal(result.failureStatus, 503);
});

test('parameter-scoped views acquire hourly means with independent caches and no extra latest call', async () => {
  const paths = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      paths.push(url.pathname);
      if (url.pathname === '/v3/locations')
        return Response.json({
          results: [
            {
              ...locations[0],
              sensors: [
                { id: 100, parameter: { name: 'pm25', units: 'µg/m³' } },
                { id: 200, parameter: { name: 'pm10', units: 'µg/m³' } },
              ],
            },
          ],
        });
      assert.ok(url.searchParams.get('datetime_from'));
      const name = url.pathname.includes('/100/') ? 'pm25' : 'pm10';
      return Response.json({
        results: [
          {
            value: 12,
            parameter: { name, units: 'µg/m³' },
            flagInfo: { hasFlags: false },
            coverage: { percentCoverage: 100 },
            period: {
              interval: '01:00:00',
              datetimeFrom: { utc: new Date(start - 3600000).toISOString() },
              datetimeTo: { utc: new Date(start).toISOString() },
            },
          },
        ],
      });
    },
  });
  const view = [10, -10, 30, 10, 20, 0];
  const a = await source.getSnapshot({ view, parameter: 'PM2.5' });
  assert.equal(a.readings[0].assessment.label, 'Fair');
  const b = await source.getSnapshot({ view, parameter: 'PM10' });
  assert.equal(b.readings[0].assessment.label, 'Good');
  assert.equal(await source.getSnapshot({ view, parameter: 'PM2.5' }), a);
  assert.equal(paths.filter((p) => p.endsWith('/hours')).length, 2);
  assert.ok(!paths.some((p) => p.endsWith('/latest')));
  await assert.rejects(
    source.getSnapshot({ view, parameter: 'invalid' }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    source.getSnapshot({ parameter: 'PM10' }),
    (e) => e.status === 400,
  );
});

test('small pans reuse rounded catalog regions and hourly results', async () => {
  const { source, calls } = fixture();
  for (let i = 0; i < 10; i++) {
    const offset = i / 100;
    const result = await source.getSnapshot({
      view: [19.1 + offset, -0.9, 20.1 + offset, 0.9, 20, 0],
    });
    assert.equal(result.readings.length, 3);
  }
  assert.equal(calls.filter((c) => c.url.includes('/locations?')).length, 1);
  assert.equal(calls.length, 4);
});

test('returning to an evicted view during provider cooldown retains cached readings and retries at reset', async () => {
  let clock = start,
    limited = false;
  const { source, calls } = fixture({
    now: () => clock,
    fail: () => (limited ? 429 : 0),
  });
  const firstView = [19, -1, 21, 1, 20, 0];
  assert.equal(
    (await source.getSnapshot({ view: firstView })).readings.length,
    3,
  );
  limited = true;
  for (let i = 0; i < 9; i++)
    await source.getSnapshot({ view: [i, -1, i + 1, 1, i + 0.5, 0] });
  const before = calls.length;
  const cached = await source.getSnapshot({ view: [18, -2, 22, 2, 20, 0] });
  assert.equal(cached.readings.length, 3);
  assert.equal(cached.failureStatus, 429);
  assert.equal(cached.retryAt, start + 120_000);
  assert.equal(calls.length, before, 'no upstream retry while blocked');
  clock += 120_001;
  limited = false;
  const recovered = await source.getSnapshot({ view: [18, -2, 22, 2, 20, 0] });
  assert.equal(recovered.readings.length, 3);
  assert.equal(recovered.stale, false);
  assert.ok(calls.length > before);
});

test('abandoned views cancel upstream work; a coalesced active consumer is preserved', async () => {
  for (const shared of [false, true]) {
    let release,
      upstreamSignal,
      observations = 0;
    const source = createOpenAqAcquisition({
      getKey: () => 'fixture',
      now: () => start,
      fetchImpl: async (url, { signal }) => {
        if (url.includes('/locations?')) {
          upstreamSignal = signal;
          return new Promise((resolve, reject) => {
            release = () =>
              resolve(Response.json({ results: locations.slice(0, 1) }));
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            });
          });
        }
        observations++;
        return Response.json({ results: [] });
      },
    });
    const controller = new AbortController();
    const view = [19, -1, 21, 1, 20, 0];
    const abandoned = source.getSnapshot({ view, signal: controller.signal });
    const rejection = assert.rejects(abandoned, (e) => e.name === 'AbortError');
    const active = shared ? source.getSnapshot({ view }) : null;
    controller.abort();
    await rejection;
    assert.equal(upstreamSignal.aborted, !shared);
    if (shared) {
      release();
      await active;
    }
    assert.equal(observations, shared ? 1 : 0);
  }
});

test('background enrichment yields budget to a new region', async () => {
  let clock = start,
    count = 0;
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl: async (raw) => {
      count++;
      const url = new URL(raw);
      if (url.pathname === '/v3/locations') {
        const west = Number(url.searchParams.get('bbox').split(',')[0]);
        const offset = west > 40 ? 100 : 0;
        return Response.json({
          results: Array.from({ length: 40 }, (_, i) => ({
            ...locations[0],
            id: offset + i + 1,
            coordinates: { latitude: 0, longitude: offset ? 50 : 20 },
            sensors: [
              {
                id: offset + i + 1,
                parameter: { name: 'pm25', units: 'µg/m³' },
              },
            ],
          })),
        });
      }
      const id = Number(url.pathname.split('/')[3]);
      return Response.json({
        results: [
          {
            locationsId: id,
            sensorsId: id,
            value: 10,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  const view = [19, -1, 21, 1, 20, 0];
  let snapshot;
  for (let i = 0; i < 8; i++) {
    snapshot = await source.getSnapshot({ view });
    clock += 8001; // Stay long enough for progressive batches, without panning.
  }
  assert.ok(snapshot.readings.length >= 24);
  assert.ok(count <= 33);
  const next = await source.getSnapshot({ view: [49, -1, 51, 1, 50, 0] });
  assert.equal(next.readings.length, 4);
  assert.equal(next.stale, false);
});

test('observations remain available beyond check TTL during cooldown, but expire after six hours', async () => {
  let clock = start,
    limited = false;
  const { source } = fixture({
    now: () => clock,
    fail: () => (limited ? 429 : 0),
  });
  await source.getSnapshot({ view: [19, -1, 21, 1, 20, 0] });
  clock += 21 * 60_000;
  limited = true;
  const cached = await source.getSnapshot({ view: [18, -2, 22, 2, 20, 0] });
  assert.equal(cached.readings.length, 3);
  assert.equal(cached.stale, true);
  clock += 6 * 3600_000;
  const expired = await source.getSnapshot({ view: [17, -3, 23, 3, 20, 0] });
  assert.equal(expired.readings.length, 0);
});

test('browser disconnect propagates through the proxy to the upstream request', async () => {
  const { EventEmitter } = await import('node:events');
  let handler, upstreamSignal;
  openAqProxy({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (_, { signal }) => {
      upstreamSignal = signal;
      return new Promise((_, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  }).configureServer({
    middlewares: {
      use(_, fn) {
        handler = fn;
      },
    },
  });
  const response = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead() {
      assert.fail('Disconnected responses must not be written');
    },
    end() {
      assert.fail('Disconnected responses must not be written');
    },
  });
  const pending = handler(
    { method: 'GET', url: '/?view=19,-1,21,1,20,0&parameter=PM2.5' },
    response,
  );
  response.destroyed = true;
  response.emit('close');
  assert.equal(upstreamSignal.aborted, true);
  await pending;
  assert.equal(response.listenerCount('close'), 0);
});

test('cancellation before consumer registration is handled without abandoning the job rejection', async () => {
  const controller = new AbortController();
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (_, { signal }) => {
      controller.abort();
      signal.throwIfAborted();
      return Response.json({ results: [] });
    },
  });
  await assert.rejects(
    source.getSnapshot({
      view: [19, -1, 21, 1, 20, 0],
      signal: controller.signal,
    }),
    (e) => e.name === 'AbortError',
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test('provider cooldown takes precedence over the nearby progressive refresh deadline', async () => {
  let limited = false;
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    batchSize: 1,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (limited)
        return new Response('', {
          status: 429,
          headers: { 'Retry-After': '120' },
        });
      if (url.pathname === '/v3/locations')
        return Response.json({ results: locations });
      return Response.json({
        results: [
          {
            locationsId: 1,
            sensorsId: 100,
            value: 10,
            datetime: { utc: new Date(start).toISOString() },
          },
        ],
      });
    },
  });
  await source.getSnapshot({ view: [0, -10, 40, 10, 20, 0] });
  limited = true;
  const next = await source.getSnapshot({ view: [1, -10, 39, 10, 20, 0] });
  assert.equal(next.readings.length, 1);
  assert.equal(next.retryAt, start + 120_000);
});
