import assert from 'node:assert/strict';
import test from 'node:test';
import {
  PanoramaxSourceError,
  createPanoramaxSource,
  retryAfterSeconds,
} from './source.js';
import {
  MAX_RESPONSE_BYTES,
  NEAREST_BOX_LIMIT,
  STREAM_IDLE_TIMEOUT_MS,
  TILE_TIMEOUT_MS,
} from './policy.js';

/** A fetch answering from `respond(url)`, recording every URL asked. */
function fakeFetch(respond) {
  const urls = [];
  const fetchImpl = async (url, { signal } = {}) => {
    urls.push(url);
    const answer = await respond(url, signal);
    if (answer instanceof Response) return answer;
    const { status = 200, body = '', headers = {} } = answer;
    return new Response(status === 204 ? null : body, { status, headers });
  };
  return { urls, fetchImpl };
}

const json = (value) => ({ body: JSON.stringify(value) });

test('a tile is the raw vector-tile bytes; 204 and 404 mean no coverage', async () => {
  const { urls, fetchImpl } = fakeFetch((url) =>
    url.includes('/14/')
      ? { body: new Uint8Array([1, 2, 3]) }
      : { status: 204 },
  );
  const source = createPanoramaxSource({ fetchImpl });
  assert.deepEqual(
    [...(await source.getTile({ x: 8299, y: 5634, z: 14 }))],
    [1, 2, 3],
  );
  assert.equal(urls[0], 'https://api.panoramax.xyz/api/map/14/8299/5634.mvt');
  assert.equal((await source.getTile({ x: 1, y: 1, z: 13 })).length, 0);
  const missing = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 404 })).fetchImpl,
  });
  assert.equal((await missing.getTile({ x: 1, y: 1, z: 13 })).length, 0);
});

test('a busy API says so and when to come back; other failures name the status', async () => {
  const busy = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({
      status: 429,
      headers: { 'retry-after': '12' },
    })).fetchImpl,
  });
  await assert.rejects(busy.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.ok(error instanceof PanoramaxSourceError);
    assert.equal(error.status, 429);
    assert.equal(error.retryAfterSec, 12);
    return true;
  });
  const down = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 503 })).fetchImpl,
  });
  await assert.rejects(down.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.equal(error.retryAfterSec, 5, 'a default wait without the header');
    return true;
  });
  const broken = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 500 })).fetchImpl,
  });
  await assert.rejects(broken.getItem('x'), /HTTP 500/);
});

test('an oversized answer is refused while it streams', async () => {
  let pulled = 0;
  const huge = new ReadableStream({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(4 * 1024 * 1024));
    },
  });
  const source = createPanoramaxSource({
    fetchImpl: async () => new Response(huge, { status: 200 }),
  });
  await assert.rejects(source.getTile({ x: 0, y: 0, z: 0 }), /too much data/);
  assert.ok(pulled * 4 * 1024 * 1024 <= MAX_RESPONSE_BYTES + 8 * 1024 * 1024);
  // A declared length over the cap is refused before reading.
  const declared = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({
      body: 'x',
      headers: { 'content-length': String(MAX_RESPONSE_BYTES + 1) },
    })).fetchImpl,
  });
  await assert.rejects(declared.getItem('a'), /too much data/);
});

test('a picture by id is a STAC search; another id in the answer is not taken for it', async () => {
  const { urls, fetchImpl } = fakeFetch((url) =>
    url.includes('ids=good')
      ? json({ features: [{ id: 'good' }] })
      : json({ features: [{ id: 'other' }] }),
  );
  const source = createPanoramaxSource({ fetchImpl });
  assert.deepEqual(await source.getItem('good'), { id: 'good' });
  assert.equal(await source.getItem('bad'), null);
  const asked = new URL(urls[0]);
  assert.equal(asked.pathname, '/api/search');
  assert.equal(asked.searchParams.get('ids'), 'good');
  assert.equal(asked.searchParams.get('limit'), '1');
});

test('nearest pictures: a place search and a box search side by side, both filtered as the imagery filter asks', async () => {
  const { urls, fetchImpl } = fakeFetch(() => json({ features: [] }));
  const source = createPanoramaxSource({ fetchImpl });
  await source.nearestItems({ lat: 48.85, lon: 2.35 });
  await source.nearestItems({
    lat: 48.85,
    lon: 2.35,
    collections: 'seq',
    pano: 'pano',
    sinceMs: Date.UTC(2025, 0, 1),
    radius: 5000,
    limit: 500,
  });
  await source.nearestItems({ lat: 48.85, lon: 2.35, pano: 'flat' });
  const asked = urls.map((u) => new URL(u).searchParams);
  assert.equal(asked.length, 6, 'two searches a lookup');
  const place = asked.filter((q) => q.has('place_position'));
  const box = asked.filter((q) => q.has('bbox'));
  assert.equal(place.length, 3);
  assert.equal(box.length, 3);
  const [plain, filtered, flat] = place;
  assert.equal(plain.get('place_position'), '2.3500000,48.8500000');
  assert.equal(plain.get('place_distance'), '0-50');
  assert.equal(plain.get('place_fov_tolerance'), '180');
  assert.equal(plain.get('collections'), null);
  assert.equal(plain.get('filter'), null);
  assert.equal(plain.get('datetime'), null);
  assert.equal(filtered.get('collections'), 'seq');
  assert.equal(filtered.get('filter'), 'field_of_view=360');
  assert.equal(filtered.get('datetime'), '2025-01-01T00:00:00.000Z/..');
  assert.equal(filtered.get('place_distance'), '0-1000', 'capped');
  assert.equal(filtered.get('limit'), '100', 'capped');
  assert.equal(flat.get('filter'), 'field_of_view<360');
  // The box spans the radius each way, and carries the same filters.
  const [w, s, e, n] = box[0].get('bbox').split(',').map(Number);
  assert.ok(Math.abs((n - s) * 111_320 - 100) < 1, `${n - s}°`);
  assert.ok(
    Math.abs((e - w) * 111_320 * Math.cos((48.85 * Math.PI) / 180) - 100) < 1,
  );
  assert.equal(box[1].get('collections'), 'seq');
  assert.equal(box[1].get('filter'), 'field_of_view=360');
  assert.equal(box[1].get('datetime'), '2025-01-01T00:00:00.000Z/..');
  assert.equal(box[2].get('filter'), 'field_of_view<360');
});

test('a picture both searches find is listed once', async () => {
  const source = createPanoramaxSource({
    fetchImpl: fakeFetch((url) =>
      url.includes('bbox')
        ? json({ features: [{ id: 'b' }, { id: 'a' }, { id: null }] })
        : json({ features: [{ id: 'a' }] }),
    ).fetchImpl,
  });
  const items = await source.nearestItems({ lat: 1, lon: 2 });
  assert.deepEqual(
    items.map((i) => i.id),
    ['a', 'b'],
  );
});

test('the newest search goes first when the API gate is full', async () => {
  const waiting = [];
  const order = [];
  const source = createPanoramaxSource({
    fetchImpl: async (url) => {
      order.push(new URL(url).searchParams.get('ids'));
      await new Promise((resolve) => waiting.push(resolve));
      return new Response(JSON.stringify({ features: [] }));
    },
  });
  const all = ['1', '2', '3', '4', '5', '6'].map((id) => source.getItem(id));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(order, ['1', '2'], 'two at once');
  waiting.shift()();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(order.at(-1), '6', 'the latest waiting one next');
  let done = false;
  Promise.allSettled(all).then(() => (done = true));
  while (!done) {
    waiting.splice(0).forEach((go) => go());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
});

test('an unreadable search answer, or one with no features, is handled', async () => {
  const garbled = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ body: '<html>' })).fetchImpl,
  });
  await assert.rejects(garbled.getItem('a'), /unreadable/);
  const empty = createPanoramaxSource({
    fetchImpl: fakeFetch(() => json({ type: 'FeatureCollection' })).fetchImpl,
  });
  assert.deepEqual(await empty.nearestItems({ lat: 0, lon: 0 }), []);
});

test('the caller’s abort wins; a silent API times out with a readable message', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const hang = (url, signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const source = createPanoramaxSource({
    fetchImpl: fakeFetch(hang).fetchImpl,
  });
  const controller = new AbortController();
  const asked = source.getItem('a', { signal: controller.signal });
  await Promise.resolve();
  controller.abort(new Error('overtaken'));
  await assert.rejects(asked, /overtaken/);
  const slow = source.getTile({ x: 0, y: 0, z: 0 });
  // Let the request start before the clock runs out.
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(60_000);
  await assert.rejects(slow, /did not answer in time/);
});

test('a network failure reads as unreachable, not as a stack trace', async () => {
  const source = createPanoramaxSource({
    fetchImpl: async () => {
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(source.getTile({ x: 0, y: 0, z: 0 }), (error) => {
    assert.ok(error instanceof PanoramaxSourceError);
    assert.match(error.message, /could not be reached/);
    return true;
  });
});

test('a search that timed out is asked once more; a second timeout is reported', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const hang = (signal) =>
    new Promise((_, reject) =>
      signal.addEventListener('abort', () => reject(signal.reason)),
    );
  const source = createPanoramaxSource({
    fetchImpl: async (url, { signal }) => {
      calls++;
      if (calls === 1) return hang(signal);
      return new Response(JSON.stringify({ features: [{ id: 'a' }] }));
    },
  });
  const asked = source.getItem('a');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  t.mock.timers.tick(60_000);
  assert.deepEqual(await asked, { id: 'a' });
  assert.equal(calls, 2);
  const stuck = createPanoramaxSource({
    fetchImpl: async (url, { signal }) => hang(signal),
  });
  const never = stuck.getItem('b');
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 10; i++) await Promise.resolve();
    t.mock.timers.tick(60_000);
  }
  await assert.rejects(never, /did not answer in time/);
});

test('the HTTP/1.1 API never gets more than five requests at once: three tiles, two searches', async () => {
  const { API_CONCURRENCY, TILE_CONCURRENCY } = await import('./policy.js');
  assert.ok(API_CONCURRENCY + TILE_CONCURRENCY <= 5);
  let open = 0;
  let most = 0;
  const waiting = [];
  const source = createPanoramaxSource({
    fetchImpl: async (url) => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => waiting.push(resolve));
      open--;
      return url.includes('/map/')
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ features: [] }));
    },
  });
  const all = [
    ...Array.from({ length: 8 }, (_, i) =>
      source.getTile({ x: i, y: 0, z: 14 }),
    ),
    ...Array.from({ length: 4 }, (_, i) => source.getItem(String(i))),
  ];
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(most, 5);
  let done = false;
  Promise.allSettled(all).then(() => (done = true));
  while (!done) {
    waiting.splice(0).forEach((go) => go());
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.equal(most, 5, 'never more');
});

test('one of the two nearest searches failing leaves the other’s pictures; both failing fails the lookup', async () => {
  const half = createPanoramaxSource({
    fetchImpl: fakeFetch((url) =>
      url.includes('bbox')
        ? { status: 503 }
        : json({ features: [{ id: 'facing' }] }),
    ).fetchImpl,
  });
  assert.deepEqual(
    (await half.nearestItems({ lat: 1, lon: 2 })).map((i) => i.id),
    ['facing'],
  );
  const none = createPanoramaxSource({
    fetchImpl: fakeFetch(() => ({ status: 503 })).fetchImpl,
  });
  await assert.rejects(none.nearestItems({ lat: 1, lon: 2 }), /busy/);
});

test('only a timeout is asked again: a busy or failing API is asked once, an unreachable one says so', async () => {
  for (const status of [429, 500, 503]) {
    const { urls, fetchImpl } = fakeFetch(() => ({ status }));
    const source = createPanoramaxSource({ fetchImpl });
    await assert.rejects(source.getItem('a'));
    assert.equal(urls.length, 1, `HTTP ${status}: one fetch`);
  }
  let calls = 0;
  const offline = createPanoramaxSource({
    fetchImpl: async () => {
      calls++;
      throw new TypeError('Failed to fetch');
    },
  });
  await assert.rejects(offline.getItem('a'), /could not be reached/);
  assert.equal(calls, 1, 'not retried');
});

test('a Retry-After is honoured up to five minutes', async () => {
  const wait = async (header) => {
    const source = createPanoramaxSource({
      fetchImpl: fakeFetch(() => ({
        status: 503,
        headers: { 'retry-after': header },
      })).fetchImpl,
    });
    return source
      .getTile({ x: 0, y: 0, z: 0 })
      .catch((error) => error.retryAfterSec);
  };
  assert.equal(await wait('3600'), 300);
  assert.equal(await wait('99999999999'), 300);
  assert.equal(await wait('0'), 1);
  assert.equal(await wait('12'), 12);
});

test('a Retry-After may be an HTTP date', () => {
  const now = Date.parse('2026-10-15T12:00:00Z');
  const response = (value) =>
    new Response(null, { status: 429, headers: { 'retry-after': value } });
  assert.equal(
    retryAfterSeconds(response('Thu, 15 Oct 2026 12:01:00 GMT'), now),
    60,
  );
  assert.equal(
    retryAfterSeconds(response('Thu, 15 Oct 2026 14:00:00 GMT'), now),
    300,
  );
  assert.equal(
    retryAfterSeconds(response('Thu, 15 Oct 2026 11:00:00 GMT'), now),
    null,
    'a date already past',
  );
  assert.equal(retryAfterSeconds(response('soon'), now), null);
  assert.equal(
    retryAfterSeconds(new Response(null, { status: 429 }), now),
    null,
  );
});

test('busy without a readable Retry-After (the browser hides it): the wait doubles, and resets once answered', async () => {
  let busy = true;
  const source = createPanoramaxSource({
    fetchImpl: fakeFetch(() =>
      busy ? { status: 429 } : { body: new Uint8Array([1]) },
    ).fetchImpl,
  });
  const wait = () =>
    source.getTile({ x: 0, y: 0, z: 0 }).then(
      () => 'ok',
      (error) => error.retryAfterSec,
    );
  const waits = [];
  for (let i = 0; i < 9; i++) waits.push(await wait());
  assert.deepEqual(waits, [5, 10, 20, 40, 80, 160, 300, 300, 300]);
  busy = false;
  assert.equal(await wait(), 'ok');
  busy = true;
  assert.equal(await wait(), 5, 'back to the first wait');
});

test(
  'a body that keeps arriving is not cut off by the request timeout; one that stalls is',
  { timeout: 10_000 },
  async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const settle = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };
    // Headers at once, then a chunk every 10 s for twice the tile timeout.
    const chunks = Math.ceil((2 * TILE_TIMEOUT_MS) / 10_000);
    let push;
    const slowBody = (signal) =>
      new Response(
        new ReadableStream({
          start(controller) {
            push = (last) => {
              controller.enqueue(new Uint8Array([7]));
              if (last) controller.close();
            };
            signal.addEventListener('abort', () =>
              controller.error(signal.reason),
            );
          },
        }),
        { status: 200 },
      );
    const source = createPanoramaxSource({
      fetchImpl: async (url, { signal }) => slowBody(signal),
    });
    const slow = source.getTile({ x: 0, y: 0, z: 0 });
    await settle();
    for (let i = 1; i <= chunks; i++) {
      t.mock.timers.tick(10_000);
      push(i === chunks);
      await settle();
    }
    assert.equal((await slow).length, chunks, 'every chunk read');
    const stalled = source.getTile({ x: 0, y: 0, z: 0 });
    await settle();
    push(false);
    await settle();
    t.mock.timers.tick(STREAM_IDLE_TIMEOUT_MS);
    await assert.rejects(stalled, /did not answer in time/);
  },
);

test('the box search asks for a few pictures: the API returns them nearest first', async () => {
  const { urls, fetchImpl } = fakeFetch(() => json({ features: [] }));
  const source = createPanoramaxSource({ fetchImpl });
  await source.nearestItems({ lon: 2.35, lat: 48.85 });
  const box = urls
    .map((url) => new URL(url))
    .find((url) => url.searchParams.has('bbox'));
  assert.ok(box, 'a box search');
  assert.equal(box.searchParams.get('limit'), String(NEAREST_BOX_LIMIT));
  assert.ok(NEAREST_BOX_LIMIT <= 20);
});

test('the cones’ tiles have their own connection: never behind coverage tiles, the newest first', async () => {
  const { PICTURE_TILE_CONCURRENCY, TILE_CONCURRENCY } =
    await import('./policy.js');
  assert.equal(PICTURE_TILE_CONCURRENCY, 1);
  const held = new Map();
  const asked = [];
  const source = createPanoramaxSource({
    fetchImpl: (url) => {
      asked.push(url.replace(/^.*\/map\//, ''));
      return new Promise((resolve) =>
        held.set(url.replace(/^.*\/map\//, ''), () =>
          resolve(new Response(null, { status: 204 })),
        ),
      );
    },
  });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  // Coverage fills its lane and queues.
  const coverage = Array.from({ length: TILE_CONCURRENCY + 2 }, (_, i) =>
    source.getTile({ x: i, y: 0, z: 10 }),
  );
  await settle();
  assert.equal(asked.length, TILE_CONCURRENCY);
  // A cone tile goes at once; two more wait, the newer first.
  const pictures = [1, 2, 3].map((x) =>
    source.getTile({ x, y: 9, z: 15 }, { lane: 'pictures' }),
  );
  await settle();
  assert.deepEqual(asked.slice(TILE_CONCURRENCY), ['15/1/9.mvt']);
  held.get('15/1/9.mvt')();
  await settle();
  assert.deepEqual(asked.slice(TILE_CONCURRENCY), ['15/1/9.mvt', '15/3/9.mvt']);
  for (let round = 0; round < 6; round++) {
    for (const go of held.values()) go();
    await settle();
  }
  await Promise.all([...coverage, ...pictures]);
});

test('a lookup near the antimeridian keeps its box on the map', async () => {
  const { urls, fetchImpl } = fakeFetch(() => json({ features: [] }));
  const source = createPanoramaxSource({ fetchImpl });
  await source.nearestItems({ lat: -16, lon: 179.9999 });
  const box = urls
    .map((u) => new URL(u).searchParams.get('bbox'))
    .find(Boolean)
    .split(',')
    .map(Number);
  assert.equal(box[2], 180);
  assert.ok(box[0] < 180);
});
