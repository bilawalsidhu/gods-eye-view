import test from 'node:test';
import assert from 'node:assert/strict';
import { createOpenAqAcquisition, openAqProxy } from './openAq.js';
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
  isMonitor: true,
  sensors: [{ id: 100 + i, parameter: { name: 'pm25', units: 'µg/m³' } }],
}));
/** OpenAQ hourly means of one pollutant ending at `end`, oldest first. */
const hourRows = (name, units, values, end = start) =>
  values.map((value, i) => ({
    value,
    parameter: { name, units },
    flagInfo: { hasFlags: false },
    coverage: { percentCoverage: 100 },
    period: {
      interval: '01:00:00',
      datetimeFrom: {
        utc: new Date(end - (values.length - i) * 3600_000).toISOString(),
      },
      datetimeTo: {
        utc: new Date(end - (values.length - 1 - i) * 3600_000).toISOString(),
      },
    },
  }));
function fixture({
  now = () => start,
  getKey = () => 'test-private-key',
  fail = () => 0,
} = {}) {
  const calls = [];
  const source = createOpenAqAcquisition({
    now,
    getKey,
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      assert.equal(options.headers['X-API-Key'], getKey());
      assert.equal(options.redirect, 'error');
      const status = fail(url);
      if (status)
        return new Response('', { status, headers: { 'Retry-After': '120' } });
      if (url.includes('/locations?'))
        return Response.json({
          results: locations.filter((l) => l.country.code !== 'FR'),
        });
      // The AQI view's hourly means: three hours of PM2.5, the sensor's
      // station id in µg/m³.
      const sensor = url.match(/sensors\/(\d+)\/hours/);
      if (sensor)
        return Response.json({
          results: hourRows('pm25', 'µg/m³', new Array(3).fill(sensor[1] - 99)),
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
test('no key never fetches; removal cannot reveal old cached data', async () => {
  let key = '';
  const { source, calls } = fixture({ getKey: () => key });
  await assert.rejects(
    source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] }),
    (e) => e.status === 428,
  );
  assert.equal(calls.length, 0);
  key = 'private';
  await source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] });
  key = '';
  await assert.rejects(
    source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] }),
    (e) => e.status === 428,
  );
});
test('rejected keys never fall back to cache and 429 respects retry window', async () => {
  let clock = start,
    status = 0;
  const { source, calls } = fixture({ now: () => clock, fail: () => status });
  await source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] });
  clock += 21 * 60_000;
  status = 401;
  await assert.rejects(
    source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] }),
    (e) => e.status === 401,
  );
  // The refused key is not sent again for ten minutes, and no cache stands in.
  const refused = calls.length;
  await assert.rejects(
    source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] }),
    (e) => e.status === 401,
  );
  assert.equal(calls.length, refused);
  clock += 10 * 60_000;
  status = 429;
  const cached = await source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] });
  assert.equal(cached.stale, true);
  const count = calls.length;
  await source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] });
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

test('viewport discovery prioritizes focus, coalesces, and checks observations before another catalog page', async () => {
  let clock = start;
  const { source, calls } = fixture({ now: () => clock });
  const view = [0, -40, 50, 10, 18, -34];
  const [a, b] = await Promise.all([
    source.getSnapshot({ view }),
    source.getSnapshot({ view }),
  ]);
  assert.equal(a, b);
  assert.equal(new URL(calls[0].url).searchParams.get('bbox'), '13,-39,23,-29');
  assert.match(calls[1].url, /\/latest\?/); // Observations before another catalog page.
  assert.equal(a.scope, 'viewport');
  assert.equal(a.checked, 3);
  assert.equal(a.partial, true);
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
  assert.deepEqual(ids, ['/v3/locations/2/latest', '/v3/locations/1/latest']);
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

test('the AQI view reads hourly means for PM, ozone and CO and latest values for NO2 and SO2', async () => {
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
                { id: 101, parameter: { name: 'no2', units: 'µg/m³' } },
                { id: 102, parameter: { name: 'co', units: 'ppm' } },
              ],
            },
            // No pollutant the index uses: never asked.
            {
              ...locations[1],
              coordinates: { latitude: 1, longitude: 20 },
              sensors: [{ id: 200, parameter: { name: 'co2', units: 'ppm' } }],
            },
          ],
        });
      if (url.pathname === '/v3/sensors/100/hours') {
        // Twelve hours ending at the current hour.
        const from = Date.parse(url.searchParams.get('datetime_from'));
        assert.ok(from <= start - 12 * 3600_000);
        return Response.json({
          results: hourRows(
            'pm25',
            'µg/m³',
            [50, 80, 75, 90, 82, 53, 64, 74, 21, 10, 16, 13],
          ),
        });
      }
      if (url.pathname === '/v3/sensors/102/hours')
        return Response.json({
          results: hourRows('co', 'ppm', new Array(8).fill(0.4)),
        });
      const at = { utc: new Date(start - 600_000).toISOString() };
      return Response.json({
        results: [
          { locationsId: 1, sensorsId: 100, value: 8, datetime: at },
          { locationsId: 1, sensorsId: 101, value: 20, datetime: at },
          { locationsId: 1, sensorsId: 102, value: 0.4, datetime: at },
        ],
      });
    },
  });
  const view = [10, -10, 30, 10, 20, 0];
  const snapshot = await source.getSnapshot({ view, mode: 'aqi' });
  assert.deepEqual(paths, [
    '/v3/locations',
    '/v3/sensors/100/hours',
    '/v3/sensors/102/hours',
    '/v3/locations/1/latest',
  ]);
  assert.equal(snapshot.readings.length, 1);
  const [station] = snapshot.readings;
  assert.equal(station.id, 'openaq:1:aqi');
  assert.equal(station.provider, 'openaq');
  // PM2.5 on its NowCast (17.4), CO on its 8-hour mean, NO2 on the latest
  // value; the latest PM2.5 and CO values are not used.
  assert.ok(Math.abs(station.values.pm25 - 17.4139) < 1e-3);
  assert.equal(station.valueMethods.pm25, 'nowcast');
  assert.equal(station.hourValues.pm25, 13);
  assert.ok(Math.abs(station.values.co - 0.4 * 1.1456) < 1e-9);
  assert.equal(station.valueAveraging.co, 480);
  assert.equal(station.values.no2, 20);
  assert.equal(station.observedMs, start);
  assert.equal(snapshot.eligible, 1);
  // The AQI view keeps its own cache beside the pollutant views.
  assert.equal(await source.getSnapshot({ view, mode: 'aqi' }), snapshot);
  await assert.rejects(
    source.getSnapshot({ view, mode: 'aqi', parameter: 'PM2.5' }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    source.getSnapshot({ view, mode: 'other' }),
    (e) => e.status === 400,
  );
});

test("a sensor's hourly means are asked at most once an hour, for the hours since its newest", async () => {
  let clock = start;
  const asked = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => clock,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/v3/locations')
        return Response.json({
          results: [
            {
              ...locations[0],
              datetimeLast: { utc: new Date(clock).toISOString() },
              sensors: [{ id: 300, parameter: { name: 'o3', units: 'ppm' } }],
            },
          ],
        });
      asked.push({
        from: Date.parse(url.searchParams.get('datetime_from')),
        at: clock,
      });
      return Response.json({
        results: hourRows('o3', 'ppm', [0.04, 0.05], clock),
      });
    },
  });
  const view = [10, -10, 30, 10, 20, 0];
  const first = await source.getSnapshot({ view, mode: 'aqi' });
  // Ozone's NowCast reads up to two weeks and two hours back.
  assert.equal(asked.length, 1);
  assert.ok(asked[0].from <= start - 338 * 3600_000);
  assert.equal(first.readings[0].valueMethods.o3, 'nowcast');
  assert.ok(Math.abs(first.readings[0].hourValues.o3 - 98.15) < 1e-9);
  // Within the hour nothing new is asked, even once the view's cache ends.
  clock += 30 * 60_000;
  await source.getSnapshot({ view: [10, -10, 30, 10, 20, 1], mode: 'aqi' });
  assert.equal(asked.length, 1);
  // An hour on, only the hours since the newest one held, three back.
  clock = start + 61 * 60_000;
  await source.getSnapshot({ view: [10, -10, 30, 10, 20, 2], mode: 'aqi' });
  assert.equal(asked.length, 2);
  assert.equal(asked[1].from, start - 3 * 3600_000);
});

test('the AQI view asks nothing of a low-cost sensor; a pollutant view keeps it', async () => {
  const paths = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      paths.push(url.pathname);
      if (url.pathname === '/v3/locations')
        return Response.json({
          results: [{ ...locations[0], isMonitor: false }],
        });
      return Response.json({
        results: hourRows('pm25', 'µg/m³', [12, 12, 12]),
      });
    },
  });
  const view = [10, -10, 30, 10, 20, 0];
  const aqi = await source.getSnapshot({ view, mode: 'aqi' });
  assert.deepEqual(paths, ['/v3/locations']);
  assert.deepEqual(aqi.readings, []);
  assert.equal(aqi.eligible, 0);
  const pm = await source.getSnapshot({ view, parameter: 'PM2.5' });
  assert.equal(pm.readings.length, 1);
  assert.equal(pm.readings[0].monitor, false);
});

test('the AQI mode travels through the fixed route', async () => {
  const seen = [];
  const plugin = openAqProxy({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (raw) => {
      seen.push(new URL(raw).pathname);
      return Response.json({ results: [] });
    },
  });
  let handler;
  plugin.configureServer({
    middlewares: { use: (_path, fn) => (handler = fn) },
  });
  const ask = (url) =>
    new Promise((resolve) => {
      const res = {
        writeHead: (status) => (res.status = status),
        end: () => resolve(res.status),
        once() {},
        removeListener() {},
      };
      handler({ method: 'GET', url }, res);
    });
  assert.equal(await ask('/?view=10,-10,30,10,20,0&mode=aqi'), 200);
  assert.equal(await ask('/?view=10,-10,30,10,20,0&mode=x'), 400);
  assert.equal(await ask('/?mode=aqi'), 400);
  assert.ok(seen.length > 0);
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

test('AQI-mode pans reuse catalog regions and hourly results within the per-pass cap', async () => {
  // Small pans: one catalog page and one hourly-means request per sensor,
  // then reuse.
  const { source, calls } = fixture();
  for (let i = 0; i < 10; i++) {
    const offset = i / 100;
    const result = await source.getSnapshot({
      view: [19.1 + offset, -0.9, 20.1 + offset, 0.9, 20, 0],
      mode: 'aqi',
    });
    assert.equal(result.readings.length, 3);
    assert.ok(result.readings.every((row) => row.id.endsWith(':aqi')));
  }
  assert.equal(calls.filter((c) => c.url.includes('/locations?')).length, 1);
  assert.equal(calls.filter((c) => c.url.includes('/hours?')).length, 3);
  assert.equal(calls.filter((c) => c.url.includes('/latest?')).length, 0);
  // Returning to a view within a minute answers from its cache.
  const view = [19.1, -0.9, 20.1, 0.9, 20, 0];
  const before = calls.length;
  await source.getSnapshot({ view, mode: 'aqi' });
  assert.equal(calls.length, before, 'cached view');

  // At most four stations are checked per pass, nearest first.
  const many = Array.from({ length: 6 }, (_, i) => ({
    ...locations[0],
    id: 10 + i,
    coordinates: { latitude: 0, longitude: 20 + i / 10 },
    sensors: [{ id: 200 + i, parameter: { name: 'pm25', units: 'µg/m³' } }],
  }));
  const latest = [];
  const capped = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === '/v3/locations')
        return Response.json({ results: many });
      latest.push(url.pathname);
      return Response.json({ results: [] });
    },
  });
  const first = await capped.getSnapshot({
    view: [19, -1, 21, 1, 20, 0],
    mode: 'aqi',
  });
  assert.equal(latest.length, 4);
  assert.ok(latest.every((path) => path.endsWith('/hours')));
  assert.equal(first.partial, true);
  assert.equal(first.eligible, 6);

  // An abandoned AQI view cancels its upstream work.
  let upstream;
  const abandoned = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        upstream = signal;
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        });
      }),
  });
  const controller = new AbortController();
  const pending = abandoned.getSnapshot({
    view: [19, -1, 21, 1, 20, 0],
    mode: 'aqi',
    signal: controller.signal,
  });
  const rejection = assert.rejects(pending, (e) => e.name === 'AbortError');
  controller.abort();
  await rejection;
  assert.equal(upstream.aborted, true);
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

test('a viewport answer carries counts, not the station catalogue', async () => {
  const { source } = fixture();
  const answer = await source.getSnapshot({ view: [0, -40, 50, 10, 18, -34] });
  assert.equal(answer.stations, undefined);
  assert.equal(answer.stationCount, 3);
  assert.equal(answer.eligible, 3);
  assert.equal(answer.checked, 3);
  assert.equal(answer.partial, true);
  assert.equal(answer.readings.length, 3);
});

test('a rejected key is not sent upstream again until it changes or ten minutes pass', async () => {
  let clock = start;
  let key = 'refused';
  const { source, calls } = fixture({
    now: () => clock,
    getKey: () => key,
    fail: () => (key === 'refused' ? 401 : 0),
  });
  const view = [0, -40, 50, 10, 18, -34];
  await assert.rejects(source.getSnapshot({ view }), (e) => e.status === 401);
  const sent = calls.length;
  assert.ok(sent > 0);
  // Asked again at once, by any view or the national route: refused here.
  await assert.rejects(source.getSnapshot({ view }), (e) => e.status === 401);
  await assert.rejects(
    source.getSnapshot({ view: [0, -10, 30, 10, 20, 0] }),
    (e) => e.status === 401,
  );
  assert.equal(calls.length, sent);
  // Ten minutes on, the same key is tried once more.
  clock += 10 * 60_000;
  await assert.rejects(source.getSnapshot({ view }), (e) => e.status === 401);
  assert.ok(calls.length > sent);
  // A new key is tried at once.
  const before = calls.length;
  key = 'accepted';
  const answer = await source.getSnapshot({ view });
  assert.ok(calls.length > before);
  assert.ok(answer.readings.length > 0);
});

test('the catalog asks for fixed stations only and a mobile location is never checked', async () => {
  const calls = [];
  const source = createOpenAqAcquisition({
    getKey: () => 'fixture',
    now: () => start,
    fetchImpl: async (url) => {
      calls.push(new URL(url));
      return Response.json({
        results: url.includes('/locations?')
          ? [locations[0], { ...locations[1], isMobile: true }]
          : [],
      });
    },
  });
  const snapshot = await source.getSnapshot({ view: [10, -10, 30, 10, 20, 0] });
  assert.equal(calls[0].searchParams.get('mobile'), 'false');
  assert.equal(snapshot.eligible, 1);
  assert.ok(
    calls.every((url) => !url.pathname.includes('/locations/2/latest')),
  );
});
