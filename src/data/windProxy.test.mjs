import test from 'node:test';
import assert from 'node:assert/strict';

import { windProxy } from '../../server/providers/wind.js';

/** Boot a mounted provider middleware without a real server. */
function install(plugin) {
  const routes = new Map();
  plugin.configureServer({
    middlewares: {
      use(route, handler) {
        routes.set(route, handler);
      },
    },
  });
  assert.equal(routes.size, 1);
  const handler = [...routes.values()][0];
  return async (url = '/', method = 'GET') => {
    const res = {
      statusCode: 200,
      headers: {},
      headersSent: false,
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [name, value] of Object.entries(headers || {}))
          this.headers[name.toLowerCase()] = value;
        this.headersSent = true;
      },
      end(body) {
        this.body = body;
        this.headersSent = true;
      },
    };
    await handler({ url, method }, res);
    return res;
  };
}

const IDX = [
  '1:0:d=2026091400:UGRD:10 m above ground:anl:',
  '2:5:d=2026091400:VGRD:10 m above ground:anl:',
  '3:10:d=2026091400:HGT:surface:anl:',
].join('\n');

const DECODED_U = {
  ni: 4,
  nj: 3,
  lo1: 0,
  la1: 90,
  di: 90,
  dj: 90,
  values: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
};
const DECODED_V = {
  ...DECODED_U,
  values: [21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32],
};

/** Resampled-grid metadata shared by the injected model fakes. */
const GRID = { nx: 4, ny: 3, lo1: 0, la1: 90, dx: 90, dy: 90 };

/** Fetch double: `.idx` text, and range bodies of the requested length. */
function makeFetch({ fail = false, counter } = {}) {
  return async (url, options = {}) => {
    if (counter) counter.calls += 1;
    if (fail) throw new Error('gfs upstream down');
    if (String(url).endsWith('.idx')) return new Response(IDX, { status: 200 });
    const match = /bytes=(\d+)-(\d+)/.exec(options.headers?.Range || '');
    const length = Number(match[2]) - Number(match[1]) + 1;
    return new Response(new Uint8Array(length), { status: 206 });
  };
}

function proxy(options = {}) {
  return windProxy({
    now: () => Date.UTC(2026, 8, 14, 12),
    targetDx: 90,
    fetchImpl: makeFetch(),
    decodeImpl: async (buffer) =>
      buffer[0] === undefined ? DECODED_U : DECODED_U,
    ...options,
  });
}

test('wind manifest describes the GFS cycle and resampled grid', async () => {
  const request = install(proxy());
  const res = await request('/');
  assert.equal(res.statusCode, 200);
  const body = JSON.parse(res.body);
  assert.equal(body.schemaVersion, 1);
  assert.equal(body.model, 'gfs');
  assert.equal(body.cycle.hour, 6);
  assert.equal(body.cycle.date, '20260914');
  assert.equal(body.units, 'm/s');
  assert.deepEqual(body.grid, {
    nx: 4,
    ny: 3,
    lo1: 0,
    la1: 90,
    dx: 90,
    dy: 90,
  });
  assert.match(
    body.gridUrl,
    /^\/api\/wind\/grid\/gfs-20260914-6-f6-90\.bin\?model=gfs$/,
  );
  assert.equal(body.stale, false);
});

test('wind grid route returns Float32 U then V', async () => {
  let u = 0;
  const request = install(
    proxy({
      decodeImpl: async () => {
        u += 1;
        return u === 1 ? DECODED_U : DECODED_V;
      },
    }),
  );
  const manifest = JSON.parse((await request('/')).body);
  const res = await request(manifest.gridUrl.replace('/api/wind', ''));
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'application/octet-stream');
  assert.equal(res.body.length, 4 * 3 * 4 * 2);
  const floats = new Float32Array(
    res.body.buffer,
    res.body.byteOffset,
    res.body.length / 4,
  );
  assert.deepEqual([...floats.slice(0, 12)], DECODED_U.values);
  assert.deepEqual([...floats.slice(12)], DECODED_V.values);
});

test('wind status omits the grid url', async () => {
  const request = install(proxy());
  await request('/');
  const body = JSON.parse((await request('/status')).body);
  assert.equal('gridUrl' in body, false);
  assert.equal(body.model, 'gfs');
});

test('wind refresh is cached within the TTL and refetches after it', async () => {
  const counter = { calls: 0 };
  let clock = Date.UTC(2026, 8, 14, 12);
  const request = install(
    proxy({ now: () => clock, fetchImpl: makeFetch({ counter }) }),
  );
  await request('/');
  const afterFirst = counter.calls;
  assert.equal(afterFirst, 3, 'one idx plus two range fetches');
  await request('/');
  assert.equal(
    counter.calls,
    afterFirst,
    'a second request inside the TTL must not refetch',
  );
  clock += 2 * 3600_000;
  await request('/');
  assert.equal(
    counter.calls,
    afterFirst + 3,
    'a request past the TTL refetches',
  );
});

test('wind serves last-good with stale on upstream failure', async () => {
  let failing = false;
  let clock = Date.UTC(2026, 8, 14, 12);
  const request = install(
    proxy({
      now: () => clock,
      fetchImpl: async (...args) => {
        if (failing) throw new Error('gfs upstream down');
        return makeFetch()(...args);
      },
    }),
  );
  const good = JSON.parse((await request('/')).body);
  failing = true;
  clock += 2 * 3600_000;
  const degraded = JSON.parse((await request('/')).body);
  assert.equal(degraded.stale, true);
  assert.equal(degraded.reason, 'Wind upstream unavailable');
  const frame = await request(good.gridUrl.replace('/api/wind', ''));
  assert.equal(frame.statusCode, 200, 'last-good grid stays addressable');
});

test('wind returns a JSON 404 for an unknown grid', async () => {
  const request = install(proxy());
  await request('/');
  const res = await request('/grid/nope.bin');
  assert.equal(res.statusCode, 404);
  assert.deepEqual(JSON.parse(res.body), { error: 'unknown_grid' });
});

test('wind grid ids and URLs are model-scoped', async () => {
  const request = install(
    proxy({
      models: {
        gfs: async () => ({
          cycle: { date: '20260914', hour: 6 },
          level: 'x',
          units: 'm/s',
          grid: { ...GRID, u: new Float32Array(12), v: new Float32Array(12) },
        }),
        ifs: async () => ({
          cycle: { date: '20260914', hour: 0 },
          level: 'x',
          units: 'm/s',
          grid: { ...GRID, u: new Float32Array(12), v: new Float32Array(12) },
        }),
      },
    }),
  );
  const gfs = JSON.parse((await request('/')).body);
  const ifs = JSON.parse((await request('/?model=ifs')).body);
  assert.match(gfs.gridUrl, /gfs-20260914-6-f0-90\.bin\?model=gfs$/);
  assert.match(ifs.gridUrl, /ifs-20260914-0-f0-90\.bin\?model=ifs$/);
  // Each model's grid resolves through its own model parameter.
  assert.equal(
    (await request(gfs.gridUrl.replace('/api/wind', ''))).statusCode,
    200,
  );
  assert.equal(
    (await request(ifs.gridUrl.replace('/api/wind', ''))).statusCode,
    200,
  );
});

test('wind rejects a non-finite grid instead of caching it', async () => {
  const bad = new Float32Array(12);
  bad[3] = Number.POSITIVE_INFINITY;
  const request = install(
    proxy({
      models: {
        gfs: async () => ({
          cycle: { date: '20260914', hour: 6 },
          level: 'x',
          units: 'm/s',
          grid: { ...GRID, u: bad, v: new Float32Array(12) },
        }),
      },
    }),
  );
  const body = JSON.parse((await request('/')).body);
  assert.equal(body.unavailable, true);
  assert.equal(body.reason, 'Wind upstream unavailable');
});

test('wind rejects unknown models, paths and methods before acquisition', async () => {
  let calls = 0;
  const request = install(
    proxy({
      models: {
        gfs: async () => {
          calls++;
          throw new Error();
        },
      },
    }),
  );
  assert.equal((await request('/?model=toString')).statusCode, 400);
  assert.equal((await request('/secret')).statusCode, 404);
  assert.equal((await request('/manifest', 'POST')).statusCode, 405);
  assert.equal((await request('/grid/unknown.bin')).statusCode, 404);
  assert.equal(calls, 0);
});

test('wind caches forecast steps separately and keeps a prior issued grid readable', async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  let step = 6;
  const request = install(
    proxy({
      now: () => clock,
      models: {
        gfs: async () => ({
          cycle: { date: '20260914', hour: 6, forecastHour: step },
          level: '10 m',
          units: 'm/s',
          grid: {
            ...GRID,
            u: new Float32Array(12).fill(step),
            v: new Float32Array(12),
          },
        }),
      },
    }),
  );
  const first = JSON.parse((await request('/')).body);
  clock += 3600_000;
  step = 7;
  const second = JSON.parse((await request('/')).body);
  assert.notEqual(first.gridUrl, second.gridUrl);
  assert.equal(
    (await request(first.gridUrl.replace('/api/wind', ''))).statusCode,
    200,
  );
});

test('wind failure backoff prevents unbounded repeated upstream acquisition', async () => {
  let calls = 0;
  const request = install(
    proxy({
      models: {
        gfs: async () => {
          calls++;
          throw new Error('private upstream detail');
        },
      },
    }),
  );
  const results = await Promise.all([request('/'), request('/')]);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(results[0].body).reason, 'Wind upstream unavailable');
  await request('/');
  assert.equal(calls, 1);
});

test('shared upstream work survives one disconnect and aborts when the final client leaves', async () => {
  const { EventEmitter } = await import('node:events');
  let handler;
  let signal;
  let loads = 0;
  const plugin = proxy({
    models: {
      gfs: ({ signal: next }) => {
        loads++;
        signal = next;
        return new Promise((resolve, reject) =>
          next.addEventListener('abort', () => reject(next.reason), {
            once: true,
          }),
        );
      },
    },
  });
  plugin.configureServer({
    middlewares: {
      use: (_path, value) => {
        handler = value;
      },
    },
  });
  const first = new EventEmitter();
  const second = new EventEmitter();
  const a = handler({ url: '/manifest', method: 'GET' }, first);
  const b = handler({ url: '/manifest', method: 'GET' }, second);
  assert.equal(loads, 1);
  first.emit('close');
  assert.equal(signal.aborted, false);
  second.emit('close');
  assert.equal(signal.aborted, true);
  await Promise.all([a, b]);
  assert.equal(first.listenerCount('close'), 0);
  assert.equal(second.listenerCount('close'), 0);
});

function weatherModel({ overlay = 'none', step = 6 } = {}) {
  const scalar =
    overlay === 'none'
      ? null
      : {
          kind: overlay,
          units: overlay === 'temperature' ? '°C' : 'hPa',
          level:
            overlay === 'temperature' ? '2 m above ground' : 'mean sea level',
        };
  return {
    cycle: { date: '20260914', hour: 6, forecastHour: step },
    level: '10 m above ground',
    units: 'm/s',
    grid: {
      ...GRID,
      u: new Float32Array(12).fill(1),
      v: new Float32Array(12).fill(2),
      ...(scalar
        ? {
            scalar: new Float32Array(12).fill(
              overlay === 'temperature' ? 20 : 1013.25,
            ),
          }
        : {}),
    },
    ...(scalar ? { scalar } : {}),
  };
}

test('weather variants cache independently, bind binary URLs, and retain two generations per slot', async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  let step = 6;
  const calls = [];
  const model =
    (name) =>
    async ({ overlay }) => {
      calls.push(`${name}:${overlay}`);
      return weatherModel({ overlay, step });
    };
  const request = install(
    proxy({
      now: () => clock,
      models: { gfs: model('gfs'), ifs: model('ifs') },
    }),
  );
  const slots = [];
  for (const name of ['gfs', 'ifs'])
    for (const overlay of ['none', 'temperature', 'pressure']) {
      const query = `?model=${name}&overlay=${overlay}`;
      const [a, b] = await Promise.all([
        request(`/manifest${query}`),
        request(`/manifest${query}`),
      ]);
      const manifest = JSON.parse(a.body);
      assert.deepEqual(JSON.parse(b.body), manifest);
      assert.equal(
        manifest.scalar?.kind,
        overlay === 'none' ? undefined : overlay,
      );
      const binary = await request(manifest.gridUrl.replace('/api/wind', ''));
      assert.equal(binary.body.length, 12 * (overlay === 'none' ? 8 : 12));
      const floats = new Float32Array(
        binary.body.buffer,
        binary.body.byteOffset,
        binary.body.length / 4,
      );
      assert.deepEqual(
        [...floats.slice(0, 24)],
        [...Array(12).fill(1), ...Array(12).fill(2)],
      );
      if (overlay !== 'none') {
        assert.deepEqual(
          [...floats.slice(24)],
          Array(12).fill(overlay === 'temperature' ? 20 : 1013.25),
        );
        assert.equal(
          (
            await request(
              manifest.gridUrl
                .replace('/api/wind', '')
                .replace(`&overlay=${overlay}`, ''),
            )
          ).statusCode,
          404,
        );
      }
      slots.push({ query, first: manifest.gridUrl });
    }
  assert.equal(
    calls.length,
    6,
    'one shared acquisition for each bounded variant',
  );
  for (const slot of slots) await request(`/manifest${slot.query}`);
  assert.equal(calls.length, 6);
  clock += 3600_000;
  step = 7;
  for (const slot of slots)
    slot.second = JSON.parse(
      (await request(`/manifest${slot.query}`)).body,
    ).gridUrl;
  for (const slot of slots)
    assert.equal(
      (await request(slot.first.replace('/api/wind', ''))).statusCode,
      200,
    );
  clock += 3600_000;
  step = 8;
  for (const slot of slots) {
    await request(`/manifest${slot.query}`);
    assert.equal(
      (await request(slot.first.replace('/api/wind', ''))).statusCode,
      404,
    );
    assert.equal(
      (await request(slot.second.replace('/api/wind', ''))).statusCode,
      200,
    );
  }
});

test('overlay failures retain only their own last-good scalar and unknown overlays never acquire', async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  let failing = false;
  let calls = 0;
  const request = install(
    proxy({
      now: () => clock,
      models: {
        gfs: async ({ overlay }) => {
          calls++;
          if (failing && overlay !== 'none') throw new Error('private detail');
          return weatherModel({ overlay });
        },
      },
    }),
  );
  const first = JSON.parse(
    (await request('/manifest?overlay=temperature')).body,
  );
  await request('/manifest');
  failing = true;
  clock += 3600_000;
  const stale = JSON.parse(
    (await request('/manifest?overlay=temperature')).body,
  );
  assert.equal(stale.stale, true);
  assert.equal(stale.gridUrl, first.gridUrl);
  assert.equal(stale.scalar.kind, 'temperature');
  assert.equal(
    JSON.parse((await request('/manifest?overlay=pressure')).body).unavailable,
    true,
  );
  assert.equal(JSON.parse((await request('/manifest')).body).stale, false);
  const before = calls;
  for (const overlay of ['toString', 'humidity', 'temperature,pressure']) {
    assert.equal(
      (await request(`/manifest?overlay=${overlay}`)).statusCode,
      400,
    );
  }
  assert.equal(calls, before);
});

test('weather provider rejects malformed scalar metadata, lengths and non-finite values', async () => {
  const mutations = [
    (value) => {
      value.scalar.units = 'K';
    },
    (value) => {
      value.grid.scalar = new Float32Array(11);
    },
    (value) => {
      value.grid.scalar[3] = Infinity;
    },
    (value) => {
      value.grid.v = new Float32Array(1);
    },
  ];
  for (const mutate of mutations) {
    const request = install(
      proxy({
        models: {
          gfs: async ({ overlay }) => {
            const value = weatherModel({ overlay });
            mutate(value);
            return value;
          },
        },
      }),
    );
    const manifest = JSON.parse(
      (await request('/manifest?overlay=temperature')).body,
    );
    assert.equal(manifest.unavailable, true);
    assert.equal(manifest.gridUrl, undefined);
  }
});

test('disconnecting an overlay request does not abort a different variant', async () => {
  const { EventEmitter } = await import('node:events');
  let handler;
  const pending = new Map();
  proxy({
    models: {
      gfs: ({ overlay, signal }) =>
        new Promise((resolve, reject) => {
          pending.set(overlay, { signal, resolve });
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          });
        }),
    },
  }).configureServer({
    middlewares: {
      use: (_path, fn) => {
        handler = fn;
      },
    },
  });
  const first = new EventEmitter();
  const second = new EventEmitter();
  second.writeHead = () => {};
  second.end = (body) => {
    second.body = body;
  };
  const a = handler(
    { url: '/manifest?overlay=temperature', method: 'GET' },
    first,
  );
  const b = handler(
    { url: '/manifest?overlay=pressure', method: 'GET' },
    second,
  );
  first.emit('close');
  assert.equal(pending.get('temperature').signal.aborted, true);
  assert.equal(pending.get('pressure').signal.aborted, false);
  pending.get('pressure').resolve(weatherModel({ overlay: 'pressure' }));
  await Promise.all([a, b]);
  assert.equal(JSON.parse(second.body).scalar.kind, 'pressure');
  assert.equal(first.listenerCount('close'), 0);
  assert.equal(second.listenerCount('close'), 0);
});

test('optional scalar failure serves wind and recovery has a distinct immutable grid URL', async () => {
  let clock = Date.UTC(2026, 8, 14, 12);
  let missing = true;
  const request = install(
    proxy({
      now: () => clock,
      models: {
        gfs: async ({ overlay }) => {
          if (!missing) return weatherModel({ overlay });
          return {
            ...weatherModel(),
            scalarError: 'Temperature field unavailable',
          };
        },
      },
    }),
  );
  const partial = JSON.parse(
    (await request('/manifest?overlay=temperature')).body,
  );
  assert.equal(partial.overlay, 'temperature');
  assert.equal(partial.unavailable, false);
  assert.equal(partial.stale, false);
  assert.equal(partial.scalar, undefined);
  assert.equal(partial.scalarError, 'Temperature field unavailable');
  assert.equal(
    (await request(partial.gridUrl.replace('/api/wind', ''))).body.length,
    12 * 8,
  );
  clock += 3600_000;
  missing = false;
  const complete = JSON.parse(
    (await request('/manifest?overlay=temperature')).body,
  );
  assert.deepEqual(
    complete.cycle,
    partial.cycle,
    'recovery is the same cycle without mixing components',
  );
  assert.equal(complete.scalar.kind, 'temperature');
  assert.equal(complete.scalarError, undefined);
  assert.notEqual(
    complete.gridUrl,
    partial.gridUrl,
    '8-byte and 12-byte payloads cannot reuse immutable URL',
  );
  assert.equal(
    (await request(complete.gridUrl.replace('/api/wind', ''))).body.length,
    12 * 12,
  );
  assert.equal(
    (await request(partial.gridUrl.replace('/api/wind', ''))).body.length,
    12 * 8,
  );
});
