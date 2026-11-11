import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KartaViewSourceError,
  createKartaViewSource,
  createLimiter,
} from './source.js';
import {
  MASK_ATTEMPTS,
  MASK_SLOW_MESSAGE,
  NEAREST_LIMIT,
  NEAREST_SEARCH_ZOOM,
  PHOTO_API_CONCURRENCY,
  PHOTO_API_RETRIES,
  PHOTO_API_FIRST_TIMEOUT_MS,
  PHOTO_API_TIMEOUT_MS,
  PAGE_TIMEOUT_MS,
  TILE_CONCURRENCY,
} from './policy.js';

/** A body streamed as browsers do, in `size`-byte chunks. */
function streamed(text, size = 16_384) {
  const bytes = new TextEncoder().encode(text);
  let at = 0;
  return {
    getReader: () => ({
      read: async () => {
        if (at >= bytes.length) return { done: true };
        const value = bytes.slice(at, at + size);
        at += size;
        return { done: false, value };
      },
      cancel: async () => {},
    }),
  };
}

// A 200 as browsers deliver it: streamed, so the code under test reads it
// the way it does in production (`json` is there only to fail loudly).
const ok = (body) => ({
  ok: true,
  status: 200,
  headers: new Map(),
  body: streamed(JSON.stringify(body)),
  json: async () => {
    throw new Error('a browser answer is read from its stream');
  },
});
const status = (code, headers = new Map()) => ({
  ok: false,
  status: code,
  headers,
  json: async () => ({}),
});
const photoPayload = (data) => ({
  status: { apiCode: 600, httpCode: 200 },
  result: { data, hasMoreData: false },
});

test('coverage tiles come from api.kartaview.org as JSON', async () => {
  const urls = [];
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      urls.push(url);
      return ok({ lines: [] });
    },
  });
  assert.deepEqual(await source.getTile({ x: 4412, y: 6061, z: 14 }), {
    lines: [],
  });
  assert.deepEqual(urls, [
    'https://api.kartaview.org/2.0/sequence/tiles/4412/6061/14.json',
  ]);
});

test('photo lookups run at most two at a time', async () => {
  let running = 0;
  let peak = 0;
  const source = createKartaViewSource({
    fetchImpl: async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running--;
      return ok(photoPayload({ id: '1' }));
    },
  });
  await Promise.all(
    Array.from({ length: 7 }, (_, i) => source.getPhoto(String(i))),
  );
  assert.equal(peak, PHOTO_API_CONCURRENCY);
});

test('a 429 is retried after a wait, then answered', async () => {
  let calls = 0;
  const source = createKartaViewSource({
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      return calls < 3
        ? status(429, new Map([['retry-after', '0']]))
        : ok(photoPayload([{ id: '9' }]));
    },
  });
  const records = await source.nearestPhotos({ lat: 42.3, lon: -83.04 });
  assert.deepEqual(records, [{ id: '9' }]);
  assert.equal(calls, 3);
});

test('rate-limiting that outlasts the retries is reported with a wait', async () => {
  let calls = 0;
  const source = createKartaViewSource({
    retryBaseMs: 1,
    fetchImpl: async () => {
      calls++;
      return status(429, new Map([['retry-after', '0.001']]));
    },
  });
  await assert.rejects(source.getPhoto('1'), (error) => {
    assert.ok(error instanceof KartaViewSourceError);
    assert.equal(error.status, 429);
    assert.ok(error.retryAfterSec > 0);
    assert.match(error.message, /try again in a moment/);
    return true;
  });
  assert.equal(calls, PHOTO_API_RETRIES + 1);
});

test('an API refusal inside a 200 is a readable error with its code; 601 is just empty', async () => {
  const refusing = createKartaViewSource({
    fetchImpl: async () =>
      ok({
        status: { apiCode: 612, apiMessage: ' out of range ', httpCode: 400 },
        result: {},
      }),
  });
  await assert.rejects(
    refusing.getPhoto('1'),
    /KartaView refused the request \(code 612\)/,
  );
  const empty = createKartaViewSource({
    fetchImpl: async () =>
      ok({ status: { apiCode: 601 }, result: { data: [] } }),
  });
  assert.deepEqual(await empty.nearestPhotos({ lat: 0, lon: 0 }), []);
  const page = await empty.getSequencePhotos('2008', {
    page: 2,
    itemsPerPage: 1000,
  });
  assert.deepEqual(page, { photos: [], hasMore: false });
});

test('HTTP errors, network failures and non-JSON become readable errors', async () => {
  const http = createKartaViewSource({ fetchImpl: async () => status(500) });
  await assert.rejects(http.getTile({ x: 0, y: 0, z: 14 }), /HTTP 500/);
  let asked = 0;
  const offline = createKartaViewSource({
    fetchImpl: async () => {
      asked++;
      throw new TypeError('Failed to fetch');
    },
  });
  // Not a timeout: no network is said as much, and not asked again at once.
  await assert.rejects(
    offline.getPhoto('1'),
    /could not be reached — check the network/,
  );
  assert.equal(asked, 1);
  const garbled = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      json: async () => {
        throw new SyntaxError('Unexpected token <');
      },
    }),
  });
  await assert.rejects(
    garbled.getTile({ x: 0, y: 0, z: 14 }),
    /could not be read/,
  );
  const torn = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: streamed('{"lines": [', 4),
    }),
  });
  await assert.rejects(
    torn.getTile({ x: 0, y: 0, z: 14 }),
    /could not be read/,
  );
});

test('an abort stops a queued lookup without fetching, and wins over a retry wait', async () => {
  let calls = 0;
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const source = createKartaViewSource({
    retryBaseMs: 10_000,
    fetchImpl: async (url) => {
      calls++;
      if (url.includes('/slow')) await gate;
      return status(429);
    },
  });
  // Two slow lookups fill the queue; the third waits for a slot.
  const first = new AbortController();
  const slow = [
    source.getPhoto('slow', { signal: first.signal }),
    source.getPhoto('slow', { signal: first.signal }),
  ];
  const controller = new AbortController();
  const queued = source.getPhoto('queued', { signal: controller.signal });
  controller.abort(new Error('overtaken'));
  await assert.rejects(queued, /overtaken/);
  assert.equal(calls, 2, 'the queued lookup never fetched');
  release();
  // Each slow one is now waiting 10 s to retry; nothing else is asked.
  const retrying = new AbortController();
  const waiting = source.getPhoto('slow', { signal: retrying.signal });
  await new Promise((resolve) => setTimeout(resolve, 20));
  retrying.abort(new Error('closed'));
  await assert.rejects(waiting, /closed/);
  // The two first lookups are still waiting out their backoff: drop them.
  first.abort(new Error('done'));
  for (const promise of slow) await assert.rejects(promise, /done/);
});

test('the limiter runs tasks in order and keeps going after a failure', async () => {
  const limiter = createLimiter(1);
  const order = [];
  const failing = limiter.run(async () => {
    order.push('a');
    throw new Error('a failed');
  });
  const second = limiter.run(async () => {
    order.push('b');
    return 'b';
  });
  await assert.rejects(failing, /a failed/);
  assert.equal(await second, 'b');
  assert.deepEqual(order, ['a', 'b']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(limiter.pending, 0);
});

test('tiles, lookups and sequence pages queue separately, so a lookup never waits behind them', async () => {
  const running = { tile: 0, photo: 0, page: 0 };
  const peak = { tile: 0, photo: 0, page: 0 };
  const release = [];
  const kind = (url) =>
    url.includes('/tiles/')
      ? 'tile'
      : url.includes('/photos')
        ? 'page'
        : 'photo';
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      const k = kind(url);
      running[k]++;
      peak[k] = Math.max(peak[k], running[k]);
      if (k !== 'photo') await new Promise((resolve) => release.push(resolve));
      running[k]--;
      return k === 'tile' ? ok({ lines: [] }) : ok(photoPayload([]));
    },
  });
  const tiles = Array.from({ length: 9 }, (_, i) =>
    source.getTile({ x: i, y: 0, z: 14 }),
  );
  const pages = [1, 2].map((page) =>
    source.getSequencePhotos('1', { page, itemsPerPage: 500 }),
  );
  // Every slow tile and page is in flight or queued; a lookup still answers.
  assert.deepEqual(await source.nearestPhotos({ lat: 1, lon: 1 }), []);
  assert.equal(peak.tile, TILE_CONCURRENCY);
  assert.equal(peak.page, 1);
  while (release.length) {
    release.shift()();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  await Promise.all([...tiles, ...pages]);
  assert.equal(peak.tile, TILE_CONCURRENCY);
  assert.equal(peak.page, 1);
});

test('a lookup that times out is asked once more, then reported as no answer in time', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const outcome = await onMockClock(t, () =>
    createKartaViewSource({
      fetchImpl: (url, { signal }) => {
        calls++;
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      },
    }).getPhoto('1'),
  );
  assert.match(
    String(outcome?.error?.message),
    /did not answer in time — try again/,
  );
  assert.equal(outcome.error.timedOut, true);
  assert.equal(calls, 2);
});

test('an image probe reads only the status: an archived photo (409) is not showable', async () => {
  const seen = [];
  const source = createKartaViewSource({
    fetchImpl: async (url, { signal }) => {
      seen.push(signal);
      return {
        ok: !url.includes('archived'),
        status: url.includes('archived') ? 409 : 200,
      };
    },
  });
  assert.equal(
    await source.probeImage('https://storage13.openstreetcam.org/ok.jpg'),
    true,
  );
  assert.equal(
    await source.probeImage('https://storage13.openstreetcam.org/archived.jpg'),
    false,
  );
  assert.equal(await source.probeImage(null), false);
  assert.ok(
    seen.every((signal) => signal.aborted),
    'the body is dropped',
  );
  const offline = createKartaViewSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  // No answer is not an answer: the caller may try again later.
  assert.equal(
    await offline.probeImage('https://x.openstreetcam.org/a.jpg'),
    null,
  );
  const busy = createKartaViewSource({
    fetchImpl: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(
    await busy.probeImage('https://x.openstreetcam.org/a.jpg'),
    null,
  );
});

test('a cold tile that times out is asked once more; an unreachable one is not', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const outcome = await onMockClock(t, () =>
    createKartaViewSource({
      fetchImpl: (url, { signal }) => {
        calls++;
        if (calls === 1)
          return new Promise((resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          );
        return Promise.resolve(ok({ lines: [] }));
      },
    }).getTile({ x: 1, y: 2, z: 13 }),
  );
  assert.deepEqual(outcome.value, { lines: [] });
  assert.equal(calls, 2);
  let asked = 0;
  const offline = createKartaViewSource({
    fetchImpl: async () => {
      asked++;
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(
    offline.getTile({ x: 1, y: 2, z: 13 }),
    /could not be reached/,
  );
  assert.equal(asked, 1);
});

test('an absurdly large answer is refused before it is parsed', async () => {
  let parsed = false;
  const source = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map([['content-length', String(64 * 1024 * 1024)]]),
      json: async () => {
        parsed = true;
        return { lines: [] };
      },
    }),
  });
  await assert.rejects(source.getTile({ x: 1, y: 2, z: 13 }), /too much data/);
  assert.equal(parsed, false);
});

test('sequence pages run one at a time, the newest first', async () => {
  const order = [];
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      const page = new URL(url).searchParams.get('page');
      order.push(page);
      if (page === '1') await gate;
      return ok(photoPayload([]));
    },
  });
  const pages = ['1', '2', '3'].map((page) =>
    source.getSequencePhotos('9', { page, itemsPerPage: 250 }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all(pages);
  assert.deepEqual(order, ['1', '3', '2']);
});

/** Every pending promise callback, without moving the mocked clock. */
const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Run `call` on the mocked clock in 100 ms steps until it settles (60 s at
 * most). `stamp()` reads the clock, for a fetch to record when it was asked.
 */
async function onMockClock(t, call, { until = 60_000 } = {}) {
  let now = 0;
  const stamp = () => now;
  let outcome = null;
  const promise = call(stamp);
  promise.then(
    (value) => (outcome = { value, at: now }),
    (error) => (outcome = { error, at: now }),
  );
  while (!outcome && now < until) {
    await flush();
    if (outcome) break;
    t.mock.timers.tick(100);
    now += 100;
  }
  await flush();
  return outcome;
}

test('429 waits double from 0.8 s, wait out a longer Retry-After up to 10 s, and 2 s without one', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  async function waits(retryAfter) {
    const asked = [];
    const headers = new Map(
      retryAfter === undefined ? [] : [['retry-after', retryAfter]],
    );
    const outcome = await onMockClock(t, (stamp) =>
      createKartaViewSource({
        fetchImpl: async () => {
          asked.push(stamp());
          return asked.length <= PHOTO_API_RETRIES
            ? status(429, headers)
            : ok(photoPayload({ id: '1' }));
        },
      }).getPhoto('1'),
    );
    assert.deepEqual(outcome?.value, { id: '1' }, `answered (${retryAfter})`);
    return asked.slice(1).map((at, i) => at - asked[i]);
  }
  assert.deepEqual(await waits('0'), [800, 1600, 3200], 'doubling backoff');
  assert.deepEqual(await waits('5'), [5000, 5000, 5000], 'Retry-After wins');
  assert.deepEqual(await waits('30'), [10_000, 10_000, 10_000], 'capped');
  assert.deepEqual(await waits(undefined), [2000, 2000, 3200], 'assumed 2 s');
});

test('a lookup that hangs is given up after a short first try, then the full timeout, then reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const outcome = await onMockClock(t, (stamp) =>
    createKartaViewSource({
      fetchImpl: (url, { signal }) => {
        asked.push(stamp());
        return new Promise((resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason)),
        );
      },
    }).getPhoto('1'),
  );
  assert.deepEqual(asked, [0, PHOTO_API_FIRST_TIMEOUT_MS]);
  assert.match(String(outcome?.error?.message), /did not answer in time/);
  assert.equal(outcome.at, PHOTO_API_FIRST_TIMEOUT_MS + PHOTO_API_TIMEOUT_MS);
});

test('the nearest lookup asks for the few photos around the point at the search zoom', async () => {
  const urls = [];
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return ok(photoPayload([]));
    },
  });
  await source.nearestPhotos({ lat: 42.33, lon: -83.04 });
  assert.equal(urls[0].pathname, '/2.0/photo/');
  assert.deepEqual(Object.fromEntries(urls[0].searchParams), {
    lat: '42.3300000',
    lng: '-83.0400000',
    zoomLevel: String(NEAREST_SEARCH_ZOOM),
    itemsPerPage: String(NEAREST_LIMIT),
  });
  assert.equal(NEAREST_SEARCH_ZOOM, 18);
  assert.equal(NEAREST_LIMIT, 10);
});

test('a chunked answer with no length is cut off once it grows past the cap', async () => {
  let reads = 0;
  let cancelled = false;
  const chunk = new Uint8Array(6 * 1024 * 1024);
  const source = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      body: {
        getReader: () => ({
          read: async () =>
            ++reads > 10 ? { done: true } : { done: false, value: chunk },
          cancel: async () => {
            cancelled = true;
          },
        }),
      },
    }),
  });
  await assert.rejects(source.getTile({ x: 1, y: 2, z: 13 }), /too much data/);
  assert.equal(reads, 3, 'stopped at the third 6 MB chunk');
  assert.equal(cancelled, true);
  const small = createKartaViewSource({
    fetchImpl: async () => {
      const bytes = new TextEncoder().encode('{"lines":[]}');
      let given = false;
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        body: {
          getReader: () => ({
            read: async () =>
              given
                ? { done: true }
                : ((given = true), { done: false, value: bytes }),
            cancel: async () => {},
          }),
        },
      };
    },
  });
  assert.deepEqual(await small.getTile({ x: 1, y: 2, z: 13 }), { lines: [] });
});

test('a chunked answer split mid-character is reassembled in order', async () => {
  const payload = {
    lines: [
      {
        track: [{ lat: '1', lng: '2' }],
        name: 'Strada Memorandumului — Cluj-Napoca 😀',
      },
    ],
    note: 'ăîşţ'.repeat(200),
  };
  const source = createKartaViewSource({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      // 3-byte chunks cut multi-byte characters in two.
      body: streamed(JSON.stringify(payload), 3),
    }),
  });
  assert.deepEqual(await source.getTile({ x: 1, y: 2, z: 13 }), payload);
});

test('a sequence page gets the full 30 s on its first try, then 30 s once more', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const asked = [];
  const outcome = await onMockClock(
    t,
    (stamp) =>
      createKartaViewSource({
        fetchImpl: (url, { signal }) => {
          asked.push(stamp());
          return new Promise((resolve, reject) =>
            signal.addEventListener('abort', () => reject(signal.reason)),
          );
        },
      }).getSequencePhotos('9', { page: 1, itemsPerPage: 250 }),
    { until: 120_000 },
  );
  assert.deepEqual(asked, [0, PAGE_TIMEOUT_MS]);
  assert.match(String(outcome?.error?.message), /did not answer in time/);
  assert.equal(outcome.at, 2 * PAGE_TIMEOUT_MS);
});

test('an answer turned away unread (an error, a 429, a length past the cap) lets its connection go', async () => {
  /** A response whose body is never read: records its cancel and the abort. */
  const unread = (answer) => {
    const seen = { cancelled: false, signal: null };
    const fetchImpl = async (url, { signal }) => {
      seen.signal = signal;
      return {
        ...answer,
        body: {
          locked: false,
          getReader: () => {
            throw new Error('not read');
          },
          cancel: async () => {
            seen.cancelled = true;
          },
        },
      };
    };
    return { seen, fetchImpl };
  };
  const cases = [
    [{ ok: false, status: 503, headers: new Map() }, /HTTP 503/],
    [
      {
        ok: true,
        status: 200,
        headers: new Map([['content-length', String(64 * 1024 * 1024)]]),
      },
      /too much data/,
    ],
  ];
  for (const [answer, message] of cases) {
    const { seen, fetchImpl } = unread(answer);
    const source = createKartaViewSource({ fetchImpl });
    await assert.rejects(source.getTile({ x: 1, y: 2, z: 13 }), message);
    assert.equal(seen.signal.aborted, true, `${message}: request aborted`);
    assert.equal(seen.cancelled, true, `${message}: body cancelled`);
  }
  // A 429 is let go before its retry is asked.
  const { seen, fetchImpl } = unread({
    ok: false,
    status: 429,
    headers: new Map([['retry-after', '0']]),
  });
  const signals = [];
  const source = createKartaViewSource({
    fetchImpl: async (url, init) => {
      signals.push(init.signal);
      if (signals.length === 1) return fetchImpl(url, init);
      return ok(photoPayload([]));
    },
  });
  await source.getPhoto('1');
  assert.equal(signals[0].aborted, true);
  assert.equal(seen.cancelled, true);
  assert.equal(signals[1].aborted, false, 'a read answer is left alone');
});

test('a filtered tile comes as PNG bytes; KartaView still drawing it (504) is asked again, then given up', async () => {
  const png = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
  const bytesOf = () => ({
    ok: true,
    status: 200,
    headers: new Map(),
    body: {
      getReader: () => {
        let given = false;
        return {
          read: async () =>
            given
              ? { done: true }
              : ((given = true), { done: false, value: png }),
          cancel: async () => {},
        };
      },
    },
  });
  const urls = [];
  let answers = [status(504), status(503), bytesOf()];
  const source = createKartaViewSource({
    maskRetryMs: 0,
    fetchImpl: async (url) => {
      urls.push(url);
      return answers.shift();
    },
  });
  const tile = { x: 13054, y: 8474, z: 14 };
  assert.deepEqual(await source.getTileMask(tile, 'fieldOfView=360'), png);
  assert.deepEqual(urls, [
    'https://api.kartaview.org/2.0/sequence/tiles/13054/8474/14.png?fieldOfView=360',
    'https://api.kartaview.org/2.0/sequence/tiles/13054/8474/14.png?fieldOfView=360',
    'https://api.kartaview.org/2.0/sequence/tiles/13054/8474/14.png?fieldOfView=360',
  ]);
  // Still drawing after every try: given up, saying so.
  urls.length = 0;
  answers = Array.from({ length: 10 }, () => status(504));
  await assert.rejects(source.getTileMask(tile, 'fieldOfView=360'), {
    message: MASK_SLOW_MESSAGE,
    timedOut: true,
  });
  assert.equal(urls.length, MASK_ATTEMPTS);
  // A refusal is not asked again.
  urls.length = 0;
  answers = [status(400)];
  await assert.rejects(source.getTileMask(tile, 'fieldOfView=360'), /HTTP 400/);
  assert.equal(urls.length, 1);
});

test('a filtered nearest search asks KartaView for the projection and upload date', async () => {
  const urls = [];
  const source = createKartaViewSource({
    fetchImpl: async (url) => {
      urls.push(new URL(url));
      return ok(photoPayload([]));
    },
  });
  await source.nearestPhotos({
    lat: 42.3314,
    lon: -83.0458,
    filter: { pano: 'pano', sinceMs: Date.UTC(2026, 0, 2, 12) },
  });
  await source.nearestPhotos({ lat: 42.3314, lon: -83.0458 });
  assert.equal(urls[0].searchParams.get('projection'), 'SPHERE');
  assert.equal(urls[0].searchParams.get('startDate'), '2026-01-02');
  assert.equal(urls[1].searchParams.has('projection'), false);
  assert.equal(urls[1].searchParams.has('startDate'), false);
});
