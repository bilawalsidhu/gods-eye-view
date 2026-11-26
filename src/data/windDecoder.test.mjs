import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

import { windProxy } from '../../server/providers/wind.js';
import { createWindDecoder } from '../../server/providers/wind/decoder.js';
import { decodeWindGribMessage } from '../../server/providers/wind/decode.js';
import { installWindProxy as install } from '../testSupport/windProxyHarness.mjs';

const require = createRequire(import.meta.url);
/** Whether this thread has loaded ecCodes (a CommonJS package). */
const ecCodesLoadedHere = () =>
  Object.keys(require.cache).some((file) => file.includes('eccodes-wasm'));

const DECODE_MODULE = new URL(
  '../../server/providers/wind/decode.js',
  import.meta.url,
).href;

/**
 * A worker that runs the provider's real serving loop over a stand-in for
 * ecCodes. The first byte selects the behaviour, the second a synchronous busy
 * time in tens of milliseconds, which is what a WASM decode looks like to the
 * thread that runs it.
 */
const FAKE_WORKER = new URL(
  `data:text/javascript,${encodeURIComponent(`
  import { parentPort } from 'node:worker_threads';
  import { serveWindDecodes } from ${JSON.stringify(DECODE_MODULE)};
  serveWindDecodes(parentPort, (bytes) => {
    if (bytes[0] === 1) throw new Error('bad message');
    if (bytes[0] === 2) {
      setTimeout(() => { throw new Error('crash'); });
      return new Promise(() => {});
    }
    if (bytes[0] === 3) process.exit(1);
    if (bytes[0] === 4) for (;;);
    const until = Date.now() + (bytes[1] || 0) * 10;
    while (Date.now() < until);
    return {
      ni: 4, nj: 3, lo1: 0, la1: 90, di: 90, dj: 90,
      values: Float64Array.from({ length: 12 }, (_, i) => bytes[0] + i / 8),
      units: 'm/s',
    };
  });
`)}`,
);

/** Run `work` while a 5 ms heartbeat records the longest main-thread stall. */
async function longestStall(work) {
  let last = performance.now();
  let gap = 0;
  const beat = setInterval(() => {
    const t = performance.now();
    gap = Math.max(gap, t - last);
    last = t;
  }, 5);
  try {
    const started = performance.now();
    const value = await work();
    gap = Math.max(gap, performance.now() - last);
    return { value, gap, elapsed: performance.now() - started };
  } finally {
    clearInterval(beat);
  }
}

/** Manifest (minus fetchedAt) and grid bytes exactly as a client receives them. */
async function served(request, url) {
  const { fetchedAt, ...manifest } = JSON.parse((await request(url)).body);
  const grid = manifest.gridUrl
    ? (await request(manifest.gridUrl.replace('/api/wind', ''))).body
    : null;
  return { manifest, grid };
}

/** One GRIB2 message on a regular lat/lon grid with 16-bit simple packing. */
function syntheticGrib({ category, number, surface, level, values }) {
  const [ni, nj] = [8, 5];
  const u8 = (...bytes) => Buffer.from(bytes);
  const u16 = (value) => {
    const out = Buffer.alloc(2);
    out.writeUInt16BE(value);
    return out;
  };
  const u32 = (value) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(value >>> 0);
    return out;
  };
  const section = (id, ...parts) => {
    const body = Buffer.concat(parts);
    return Buffer.concat([u32(body.length + 5), u8(id), body]);
  };
  const reference = Buffer.alloc(4);
  reference.writeFloatBE(Math.min(...values) * 10);
  const packed = Buffer.alloc(values.length * 2);
  values.forEach((value, index) =>
    packed.writeUInt16BE(
      Math.round(value * 10 - reference.readFloatBE()),
      index * 2,
    ),
  );
  const rest = Buffer.concat([
    section(1, u16(7), u16(0), u8(2, 1, 1), u16(2026), u8(9, 14, 6, 0, 0, 0, 1)),
    section(
      3,
      u8(0),
      u32(ni * nj),
      u8(0, 0),
      u16(0), // template 3.0, regular lat/lon
      u8(6, 0),
      u32(0),
      u8(0),
      u32(0),
      u8(0),
      u32(0),
      u32(ni),
      u32(nj),
      u32(0),
      u32(0xffffffff),
      u32(90e6), // first point 90N 0E, last point 90S 315E, 45 degree steps
      u32(0),
      u8(48),
      u32(90e6 | 0x80000000),
      u32(315e6),
      u32(45e6),
      u32(45e6),
      u8(0),
    ),
    section(
      4,
      u16(0),
      u16(0), // template 4.0
      u8(category, number, 2, 0, 0),
      u16(0),
      u8(0, 1),
      u32(0),
      u8(surface, 0),
      u32(level),
      u8(255, 255),
      u32(0xffffffff),
    ),
    // Template 5.0: value = (reference + packed) / 10.
    section(5, u32(ni * nj), u16(0), reference, u16(0), u16(1), u8(16, 0)),
    section(6, u8(255)),
    section(7, packed),
    Buffer.from('7777'),
  ]);
  return Buffer.concat([
    Buffer.from('GRIB'),
    u8(0, 0, 0, 2),
    u32(0),
    u32(16 + rest.length),
    rest,
  ]);
}

const field = (seed, scale) =>
  Array.from({ length: 40 }, (_, i) => seed + Math.sin(i * 1.7) * scale);
const MESSAGES = {
  u: syntheticGrib({
    category: 2,
    number: 2,
    surface: 103,
    level: 10,
    values: field(3, 14),
  }),
  v: syntheticGrib({
    category: 2,
    number: 3,
    surface: 103,
    level: 10,
    values: field(-2, 9),
  }),
  tmp: syntheticGrib({
    category: 0,
    number: 0,
    surface: 103,
    level: 2,
    values: field(281, 25),
  }),
  prmsl: syntheticGrib({
    category: 3,
    number: 1,
    surface: 101,
    level: 0,
    values: field(101300, 2400),
  }),
};

/** A GFS object holding the four synthetic messages, plus its `.idx`. */
function syntheticUpstream({ log = [], corrupt = () => false } = {}) {
  const order = ['u', 'v', 'tmp', 'prmsl'];
  const offsets = [0];
  for (const name of order) offsets.push(offsets.at(-1) + MESSAGES[name].length);
  const file = Buffer.concat(order.map((name) => MESSAGES[name]));
  const idx = [
    `1:${offsets[0]}:d=2026091406:UGRD:10 m above ground:6 hour fcst:`,
    `2:${offsets[1]}:d=2026091406:VGRD:10 m above ground:6 hour fcst:`,
    `3:${offsets[2]}:d=2026091406:TMP:2 m above ground:6 hour fcst:`,
    `4:${offsets[3]}:d=2026091406:PRMSL:mean sea level:6 hour fcst:`,
    `5:${offsets[4]}:d=2026091406:HGT:surface:6 hour fcst:`,
  ].join('\n');
  const ranges = Object.fromEntries(
    order.map((name, i) => [name, `bytes=${offsets[i]}-${offsets[i + 1] - 1}`]),
  );
  const fetchImpl = async (url, options = {}) => {
    const range = options.headers?.Range;
    log.push(range ?? 'idx');
    if (!range) return new Response(idx, { status: 200 });
    const [, start, end] = /bytes=(\d+)-(\d+)/.exec(range);
    const name = order.find((key) => ranges[key] === range);
    const body = Buffer.from(file.subarray(Number(start), Number(end) + 1));
    if (corrupt(name)) body.fill(0);
    return new Response(body, { status: 206 });
  };
  return { fetchImpl, ranges, log };
}

const NOON = Date.UTC(2026, 8, 14, 12);
const KEYS = ['/', '/?overlay=temperature', '/?overlay=pressure'];

test('a blocking decode runs off the server thread', async (t) => {
  const decoder = createWindDecoder({ workerUrl: FAKE_WORKER });
  t.after(() => decoder.close());
  // Warm the worker so its start-up is not counted, then block it for 300 ms.
  await decoder.decode(Uint8Array.of(5, 0));
  const { value, gap, elapsed } = await longestStall(() =>
    decoder.decode(Uint8Array.of(7, 30), { targetDx: 90 }),
  );
  assert.ok(elapsed >= 280, `decode took ${elapsed} ms`);
  assert.ok(gap < 150, `server thread stalled for ${gap} ms`);
  // The worker validated and sampled the field; only the samples came back.
  assert.equal(value.values, undefined);
  assert.equal(value.dx, 90);
  assert.ok(value.samples instanceof Float64Array);
  assert.equal(value.samples.length, 4 * 3);
  assert.equal(value.samples[0], 7);
});

test("a caller's Buffer view reaches the worker intact and stays usable", async (t) => {
  const decoder = createWindDecoder({ workerUrl: FAKE_WORKER });
  t.after(() => decoder.close());
  const backing = Buffer.alloc(16);
  backing[4] = 9;
  const view = backing.subarray(4, 6);
  const value = await decoder.decode(view, { targetDx: 90 });
  assert.equal(value.samples[0], 9);
  assert.equal(backing.buffer.byteLength, 16);
  assert.equal(view.byteLength, 2);
  assert.equal(view[0], 9);
});

// sha256 of the grid bytes the provider served for KEYS before decoding
// moved to a worker (same synthetic upstream, targetDx 30).
const PRE_WORKER_GRID_SHA256 = [
  '644ee6921d593c9c29da2d26479008bd37307e813b354ae152c68177a9258a20',
  '0f82d58af9332ce6760c80e9a7a2b6182686650ea41389ec5a0aae09a4113e55',
  '5d1a12d1bee11740c0a552527c47bb9838e893ddf222c18bada7c5436c5c81dc',
];

test('the default wind provider decodes in the worker and matches the synchronous path byte for byte', async () => {
  const outputs = [];
  const loadedBefore = ecCodesLoadedHere();
  for (const options of [
    {}, // default: ecCodes in the worker
    { decodeImpl: (bytes) => decodeWindGribMessage(bytes) }, // on this thread
  ]) {
    const request = install(
      windProxy({
        now: () => NOON,
        targetDx: 30,
        fetchImpl: syntheticUpstream().fetchImpl,
        ...options,
      }),
    );
    const out = [];
    for (const key of KEYS) out.push(await served(request, key));
    // The default path brings no ecCodes into this thread; the injected
    // synchronous decoder does, which also proves the probe can see it.
    assert.equal(ecCodesLoadedHere(), outputs.length === 1 || loadedBefore);
    outputs.push(out);
  }
  const [worker, sync] = outputs;
  for (let i = 0; i < KEYS.length; i += 1) {
    assert.equal(worker[i].manifest.unavailable, false, KEYS[i]);
    assert.equal(
      createHash('sha256').update(worker[i].grid).digest('hex'),
      PRE_WORKER_GRID_SHA256[i],
      `${KEYS[i]} matches the pre-worker bytes`,
    );
    assert.deepEqual(worker[i].manifest, sync[i].manifest, KEYS[i]);
    assert.ok(worker[i].grid.equals(sync[i].grid), `${KEYS[i]} grid bytes`);
  }
  assert.equal(worker[0].grid.length, 12 * 7 * 4 * 2);
  assert.equal(worker[1].grid.length, 12 * 7 * 4 * 3);
  assert.equal(worker[1].manifest.scalar.kind, 'temperature');
  assert.equal(worker[2].manifest.scalar.kind, 'pressure');
});

test('partial and failed refreshes match the synchronous path through the worker', async () => {
  for (const [bad, expected] of [
    ['tmp', { scalarError: 'Temperature field unavailable' }],
    ['u', { unavailable: true }],
  ]) {
    const outputs = [];
    for (const options of [
      {},
      { decodeImpl: (bytes) => decodeWindGribMessage(bytes) },
    ]) {
      const request = install(
        windProxy({
          now: () => NOON,
          targetDx: 30,
          fetchImpl: syntheticUpstream({ corrupt: (name) => name === bad })
            .fetchImpl,
          ...options,
        }),
      );
      outputs.push(await served(request, '/?overlay=temperature'));
    }
    const [worker, sync] = outputs;
    assert.deepEqual(worker.manifest, sync.manifest);
    for (const [name, value] of Object.entries(expected))
      assert.equal(worker.manifest[name], value);
    if (sync.grid) assert.ok(worker.grid.equals(sync.grid));
    else assert.equal(worker.grid, null);
  }
});

test('an overlay change within the same forecast object fetches and decodes only the scalar', async () => {
  let clock = NOON;
  let decodes = 0;
  const upstream = syntheticUpstream();
  const decodeImpl = (bytes) => {
    decodes += 1;
    return decodeWindGribMessage(bytes);
  };
  const request = install(
    windProxy({
      now: () => clock,
      targetDx: 30,
      fetchImpl: upstream.fetchImpl,
      decodeImpl,
    }),
  );
  const none = await served(request, '/');
  assert.deepEqual(upstream.log, ['idx', upstream.ranges.u, upstream.ranges.v]);
  assert.equal(decodes, 2);

  upstream.log.length = 0;
  const temperature = await served(request, '/?overlay=temperature');
  assert.deepEqual(upstream.log, ['idx', upstream.ranges.tmp]);
  assert.equal(decodes, 3);
  upstream.log.length = 0;
  const pressure = await served(request, '/?overlay=pressure');
  assert.deepEqual(upstream.log, ['idx', upstream.ranges.prmsl]);
  assert.equal(decodes, 4);

  // Reused wind gives exactly what a server that fetched everything gives.
  for (const [url, reused] of [
    ['/?overlay=temperature', temperature],
    ['/?overlay=pressure', pressure],
  ]) {
    const fresh = install(
      windProxy({
        now: () => NOON,
        targetDx: 30,
        fetchImpl: syntheticUpstream().fetchImpl,
        decodeImpl: (bytes) => decodeWindGribMessage(bytes),
      }),
    );
    const full = await served(fresh, url);
    assert.deepEqual(reused.manifest, full.manifest);
    assert.ok(reused.grid.equals(full.grid));
  }
  assert.ok(
    temperature.grid.subarray(0, none.grid.length).equals(none.grid),
    'the overlay grid starts with the same U and V',
  );

  // The next forecast step is a different object: wind is fetched again.
  clock += 3600_000;
  upstream.log.length = 0;
  await served(request, '/?overlay=temperature');
  assert.deepEqual(upstream.log, [
    'idx',
    upstream.ranges.u,
    upstream.ranges.v,
    upstream.ranges.tmp,
  ]);
});

test('an hourly IFS refresh within one forecast step fetches only the index', async () => {
  let clock = Date.UTC(2026, 8, 15, 14);
  const log = [];
  const entries = ['10u', '10v', '2t', 'msl'].map((param, i) => ({
    param,
    _offset: i * 2,
    _length: 2,
  }));
  const request = install(
    windProxy({
      now: () => clock,
      targetDx: 90,
      fetchImpl: async (url, options = {}) => {
        const range = options.headers?.Range;
        log.push(range ?? 'index');
        if (!range)
          return new Response(entries.map((e) => JSON.stringify(e)).join('\n'));
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        return new Response(Uint8Array.of(start, 0), { status: 206 });
      },
      decodeImpl: async (bytes) => ({
        ni: 4,
        nj: 3,
        lo1: 0,
        la1: 90,
        di: 90,
        dj: 90,
        values: new Float64Array(12).fill(bytes[0] + 1),
        units: 'm/s',
      }),
    }),
  );
  const first = await served(request, '/?model=ifs');
  assert.equal(first.manifest.unavailable, false);
  assert.deepEqual(log, ['index', 'bytes=0-1', 'bytes=2-3']);
  log.length = 0;
  clock += 3600_000; // past the TTL, same 9 h step
  const second = await served(request, '/?model=ifs');
  assert.deepEqual(log, ['index']);
  assert.ok(second.grid.equals(first.grid));
  log.length = 0;
  clock += 2 * 3600_000; // the 12 h step is a different object
  await served(request, '/?model=ifs');
  assert.deepEqual(log, ['index', 'bytes=0-1', 'bytes=2-3']);
});

test('wind that failed its checks is never retained for a later overlay', async () => {
  const upstream = syntheticUpstream();
  const request = install(
    windProxy({
      now: () => NOON,
      targetDx: 30,
      fetchImpl: upstream.fetchImpl,
      decodeImpl: async (bytes) => {
        const decoded = await decodeWindGribMessage(bytes);
        // Decodes cleanly, but does not share U's grid.
        return bytes.equals(MESSAGES.v)
          ? { ...decoded, la1: decoded.la1 - 45 }
          : decoded;
      },
    }),
  );
  assert.equal((await served(request, '/')).manifest.unavailable, true);
  upstream.log.length = 0;
  const overlay = await served(request, '/?overlay=temperature');
  assert.equal(overlay.manifest.unavailable, true);
  assert.ok(upstream.log.includes(upstream.ranges.u), 'U is fetched again');
});

test('a throwing, crashing or exiting decode rejects its job and the next decode recovers', async (t) => {
  const decoder = createWindDecoder({ workerUrl: FAKE_WORKER });
  t.after(() => decoder.close());
  const ok = async () => {
    const value = await decoder.decode(Uint8Array.of(9, 0), { targetDx: 90 });
    assert.equal(value.samples[0], 9);
  };
  await ok();
  // A decode error is reported for that job only; the worker stays up.
  const [thrown, sibling] = await Promise.allSettled([
    decoder.decode(Uint8Array.of(1, 0)),
    decoder.decode(Uint8Array.of(9, 0), { targetDx: 90 }),
  ]);
  assert.match(thrown.reason.message, /bad message/);
  assert.equal(sibling.value.samples[0], 9);
  // An uncaught error or an exit retires the worker; the next decode restarts it.
  for (const [mode, pattern] of [
    [2, /worker failed/],
    [3, /worker exited/],
  ]) {
    const results = await Promise.allSettled([
      decoder.decode(Uint8Array.of(mode, 0)),
      decoder.decode(Uint8Array.of(9, 0)),
    ]);
    assert.match(results[0].reason.message, pattern);
    // A job queued behind an exit dies with the worker; one queued behind an
    // asynchronous crash may still finish first. Either way it settles.
    if (mode === 3) assert.equal(results[1].status, 'rejected');
    await ok();
  }
  // Cancelling stops the wait at once.
  const controller = new AbortController();
  const slow = decoder.decode(Uint8Array.of(9, 20), {
    signal: controller.signal,
  });
  controller.abort(new Error('cancelled'));
  await assert.rejects(slow, /cancelled/);
  await ok();
});

test('a decode that never returns is cut off at its deadline', async (t) => {
  // The hung job is the decoder's first, so a slow worker start only counts
  // against a job that would never answer anyway.
  const decoder = createWindDecoder({
    workerUrl: FAKE_WORKER,
    jobTimeoutMs: 400,
  });
  t.after(() => decoder.close());
  await assert.rejects(decoder.decode(Uint8Array.of(4, 0)), /timed out/);
});

test('a cancelled hung decode is still retired at its own deadline', async (t) => {
  const jobTimeoutMs = 300;
  const decoder = createWindDecoder({ workerUrl: FAKE_WORKER, jobTimeoutMs });
  t.after(() => decoder.close());
  const created = new Promise((resolve) => process.once('worker', resolve));
  const controller = new AbortController();
  const hung = decoder.decode(Uint8Array.of(4, 0), { signal: controller.signal });
  const worker = await created;
  const exited = new Promise((resolve) =>
    worker.once('exit', () => resolve('exited')),
  );
  controller.abort(new Error('refresh cancelled'));
  await assert.rejects(hung, /refresh cancelled/);
  // Nothing else is queued: only the job's own deadline can stop the worker.
  const outcome = await Promise.race([
    exited,
    delay(jobTimeoutMs * 10, 'still running', { ref: false }),
  ]);
  assert.equal(outcome, 'exited');
});

test('a worker crash during a refresh answers the request and the next refresh recovers', async (t) => {
  const decoder = createWindDecoder({ workerUrl: FAKE_WORKER });
  t.after(() => decoder.close());
  let clock = NOON;
  let crash = true;
  const request = install(
    windProxy({
      now: () => clock,
      targetDx: 90,
      decodeImpl: decoder.decode,
      fetchImpl: async (url, options = {}) => {
        if (!options.headers?.Range)
          return new Response(
            [
              '1:0:d=2026091406:UGRD:10 m above ground:anl:',
              '2:2:d=2026091406:VGRD:10 m above ground:anl:',
              '3:4:d=2026091406:HGT:surface:anl:',
            ].join('\n'),
          );
        return new Response(Uint8Array.of(crash ? 3 : 6, 0), { status: 206 });
      },
    }),
  );
  const failed = await served(request, '/');
  assert.equal(failed.manifest.unavailable, true);
  crash = false;
  clock += 60_000; // past the failure backoff
  const recovered = await served(request, '/');
  assert.equal(recovered.manifest.unavailable, false);
  assert.equal(recovered.grid.length, 4 * 3 * 4 * 2);
});

test('closing one decoder rejects its jobs and leaves another working', async (t) => {
  const a = createWindDecoder({ workerUrl: FAKE_WORKER });
  const b = createWindDecoder({ workerUrl: FAKE_WORKER });
  t.after(() => b.close());
  const pending = a.decode(Uint8Array.of(9, 10));
  a.close();
  await assert.rejects(pending, /closed/);
  assert.equal((await b.decode(Uint8Array.of(9, 0))).samples[0], 9);
});

test('closing the server that mounts the wind proxy, or its bundle, stops its decode worker', async () => {
  for (const closer of ['httpServer', 'closeBundle']) {
    const httpServer = new EventEmitter();
    let handler;
    const plugin = windProxy({
      now: () => NOON,
      targetDx: 30,
      fetchImpl: syntheticUpstream().fetchImpl,
    });
    plugin.configureServer({
      middlewares: { use: (_route, fn) => (handler = fn) },
      ...(closer === 'httpServer' ? { httpServer } : {}),
    });
    const created = new Promise((resolve) => process.once('worker', resolve));
    const res = {
      writeHead() {},
      end(body) {
        this.body = body;
      },
    };
    await handler({ url: '/', method: 'GET' }, res);
    assert.equal(JSON.parse(res.body).unavailable, false);
    const timeout = new AbortController();
    const within = (promise) =>
      Promise.race([
        promise,
        delay(5000, 'timed out', { signal: timeout.signal }).catch(() => {}),
      ]);
    try {
      const worker = await within(created);
      assert.notEqual(worker, 'timed out', 'the proxy started its own worker');
      const exited = new Promise((resolve) =>
        worker.once('exit', () => resolve('exited')),
      );
      if (closer === 'httpServer') httpServer.emit('close');
      else plugin.closeBundle();
      assert.equal(await within(exited), 'exited', closer);
    } finally {
      timeout.abort();
    }
  }
});

test('an idle decode worker does not keep the process alive', () => {
  const decoderUrl = new URL(
    '../../server/providers/wind/decoder.js',
    import.meta.url,
  ).href;
  const script = `
    import(${JSON.stringify(decoderUrl)}).then(async ({ createWindDecoder }) => {
      const decoder = createWindDecoder({ workerUrl: new URL(${JSON.stringify(FAKE_WORKER.href)}) });
      const field = await decoder.decode(Uint8Array.of(9, 0));
      console.log('decoded', field.samples.length);
    });
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 20_000,
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(child.stdout.trim(), 'decoded 65160');
});
