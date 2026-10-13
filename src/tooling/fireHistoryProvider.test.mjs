import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fireHistoryProxy } from '../../server/providers/fireHistory.js';
import { localProviderPlugins } from '../../server/providers/local.js';

const EVENTS = {
  events: [
    {
      id: 'test-fire-2018',
      name: 'Test Fire',
      region: 'Nowhere',
      startDate: '2018-11-08',
      endDate: '2018-11-12',
      bbox: [-121.75, 39.65, -121.3, 39.95],
      sources: ['VIIRS_SNPP_SP', 'MODIS_SP'],
      perimeter: {
        service: 'wfigs',
        incident: "O'Test",
        state: 'US-CA',
        discoveredAfter: '2018-11-01',
      },
    },
    { id: 'BROKEN', name: 'x' },
  ],
};

const CSV =
  'latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight\n' +
  '39.80,-121.50,330,0.4,0.4,2018-11-08,2012,N,VIIRS,n,2,290,12.5,N\n' +
  '41.00,-121.51,331,0.4,0.4,2018-11-09,2012,N,VIIRS,n,2,290,3.0,N\n';

function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.ok(routes.has('/api/fire-history'));
  return async (url = '/', method = 'GET') => {
    const res = {
      headersSent: false,
      writeHead(status, headers) {
        Object.assign(this, { status, headers, headersSent: true });
      },
      end(body) {
        this.body = body;
      },
    };
    await routes.get('/api/fire-history')({ url, method }, res);
    return res;
  };
}

const json = (res) => JSON.parse(res.body);

async function fixture(t, { key = '', fetchImpl, events = EVENTS } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'gev-fire-history-'));
  const eventsPath = path.join(dir, 'events.json');
  const cacheDir = path.join(dir, 'cache');
  await fsp.writeFile(eventsPath, JSON.stringify(events));
  const previous = process.env.FIRMS_MAP_KEY;
  process.env.FIRMS_MAP_KEY = key;
  let clock = Date.UTC(2026, 9, 5, 12);
  t.mock.method(console, 'warn', () => {});
  t.after(async () => {
    if (previous === undefined) delete process.env.FIRMS_MAP_KEY;
    else process.env.FIRMS_MAP_KEY = previous;
    await fsp.rm(dir, { recursive: true, force: true });
  });
  const calls = [];
  const proxy = fireHistoryProxy({
    eventsPath,
    cacheDir,
    now: () => clock,
    fetchImpl: async (url, init) => {
      calls.push(String(url));
      return fetchImpl(new URL(String(url)), init);
    },
  });
  return {
    request: install(proxy),
    calls,
    cacheDir,
    advance(ms) {
      clock += ms;
    },
  };
}

test('the standalone provider list mounts the fire-history proxy once', () => {
  const plugins = localProviderPlugins();
  assert.equal(
    plugins.filter((plugin) => plugin.name === 'fire-history-proxy').length,
    1,
  );
});

test('keyless registry is public and perimeter fetching is not duplicated here', async (t) => {
  const { request, calls } = await fixture(t, {
    fetchImpl: () => {
      throw new Error('must not fetch');
    },
  });
  const list = json(await request('/'));
  assert.equal(list.hasKey, false);
  assert.deepEqual(list.events.map((event) => event.id), ['test-fire-2018']);
  assert.equal(list.events[0].startMs, undefined);
  assert.equal((await request('/test-fire-2018')).status, 503);
  assert.equal((await request('/test-fire-2018/perimeter')).status, 404);
  assert.equal(calls.length, 0);
});

test('failed archive windows cool down and the cache stores only merged fires', async (t) => {
  let modisDown = true;
  const { request, calls, cacheDir, advance } = await fixture(t, {
    key: 'fixture-key',
    fetchImpl: (url) => {
      if (url.pathname.includes('MODIS') && modisDown)
        return new Response('offline', { status: 503 });
      return new Response(CSV);
    },
  });

  const partial = json(await request('/test-fire-2018'));
  assert.equal(partial.complete, false);
  assert.equal(partial.count, 1);
  assert.equal(calls.length, 2);

  const cooled = json(await request('/test-fire-2018'));
  assert.equal(cooled.complete, false);
  assert.equal(calls.length, 2, 'failed window is not retried during cooldown');

  advance(15 * 60_000);
  modisDown = false;
  const complete = json(await request('/test-fire-2018'));
  assert.equal(complete.complete, true);
  assert.equal(complete.count, 2);
  assert.equal(calls.length, 3, 'only the failed window is retried');

  const [cacheFile] = (await fsp.readdir(cacheDir)).filter((name) =>
    name.endsWith('.json'),
  );
  const disk = JSON.parse(await fsp.readFile(path.join(cacheDir, cacheFile), 'utf8'));
  assert.ok(disk.definitionHash);
  assert.equal('firesByWindow' in disk, false);
});

test('editing an event definition changes the disk-cache identity', async (t) => {
  const first = await fixture(t, {
    key: 'fixture-key',
    fetchImpl: () => new Response(CSV),
  });
  await first.request('/test-fire-2018');
  const before = await fsp.readdir(first.cacheDir);
  assert.equal(before.length, 1);

  const changed = {
    events: [
      {
        ...EVENTS.events[0],
        bbox: [-121.8, 39.6, -121.2, 40.0],
        sources: ['VIIRS_SNPP_SP'],
      },
    ],
  };
  const eventsPath = path.join(path.dirname(first.cacheDir), 'events.json');
  await fsp.writeFile(eventsPath, JSON.stringify(changed));

  const calls = [];
  const proxy = fireHistoryProxy({
    eventsPath,
    cacheDir: first.cacheDir,
    fetchImpl: async (url) => {
      calls.push(String(url));
      return new Response(CSV);
    },
  });
  await install(proxy)('/test-fire-2018');
  assert.equal(calls.length, 1, 'changed definition cannot reuse the old cache');
  assert.equal((await fsp.readdir(first.cacheDir)).length, 2);
});
