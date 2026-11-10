import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecentImagerySource } from './source.js';
import { createThumbnailLoader } from './thumbnails.js';
import { createRecentImageryRenderer } from './rendering.js';
import { createRecentImageryLayer } from './index.js';
import { nonCrossingBoxes } from './model.js';

/** Wait, briefly, for an async chain (search → probe → drape) to land. */
async function until(condition, tries = 200, gapMs = 5) {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return true;
    await new Promise((resolve) => setTimeout(resolve, gapMs));
  }
  return false;
}
/**
 * PR #1540 review, P1 + P2: a dateline box is probed as its two halves, and
 * per-half availability must survive the whole walk to the map —
 * `getThumbnail` (early settle on the first present half, per-half deadline,
 * caller cancellation) → the loader's day state → `showSlot`, which drapes
 * only the halves the probe proved present. VIIRS is a JPEG product with no
 * alpha, so a draped confirmed-empty half is a black rectangle on the map.
 */

test('synchronous abort inside an abort-ignoring fetch settles immediately', async () => {
  const controller = new AbortController();
  const source = createRecentImagerySource({
    thumbnailUrl: () => 'https://example.invalid/',
    halfDeadlineMs: 10000,
    fetchImpl: () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  const outcome = await Promise.race([
    source
      .getThumbnail(FIJI_CANDIDATE, FIJI_BOX, { signal: controller.signal })
      .then(
        () => 'resolved',
        (error) => error.name,
      ),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 50)),
  ]);
  assert.equal(outcome, 'AbortError');
});

// Fiji across the antimeridian: east side (-180 … -177) is the wider half.
const FIJI_BOX = { west: 179, south: -18, east: -177, north: -17 };
const FIJI_DAY = '2026-11-04';
const FIJI_CANDIDATE = {
  key: `VIIRS:${FIJI_DAY}`,
  product: 'VIIRS',
  day: FIJI_DAY,
  granules: [],
  cloud: null,
  timeRange: null,
  availability: 'unknown',
  coverage: 'full',
};
const HALVES = nonCrossingBoxes(FIJI_BOX); // [west(179…180), east(-180…-177)]
const WEST_HALF = HALVES[0]; // narrow, empty
const EAST_HALF = HALVES[1]; // wider, has data
const bbox = (box) => [box.south, box.west, box.north, box.east].join(',');
const halfOf = (url) =>
  nonCrossingBoxes({
    west: Number(new URL(url).searchParams.get('BBOX').split(',')[1]),
    south: Number(new URL(url).searchParams.get('BBOX').split(',')[0]),
    east: Number(new URL(url).searchParams.get('BBOX').split(',')[3]),
    north: Number(new URL(url).searchParams.get('BBOX').split(',')[2]),
  })[0];
const sameBox = (a, b) =>
  a.west === b.west &&
  a.south === b.south &&
  a.east === b.east &&
  a.north === b.north;

function snapshot({
  present,
  acquisitionTime = null,
  delay = 0,
  hangsForever = false,
  reject = null,
} = {}) {
  /** A Worldview snapshot shaped like fetch's: it honours the caller's signal. */
  return (signal) =>
    new Promise((resolve, rejectPromise) => {
      const stop = (why) =>
        rejectPromise(
          why ?? signal?.reason ?? new DOMException('Aborted', 'AbortError'),
        );
      if (reject !== null) {
        const timer = setTimeout(() => rejectPromise(reject), delay);
        signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            stop(signal.reason);
          },
          { once: true },
        );
        return;
      }
      if (signal?.aborted) {
        stop();
        return;
      }
      if (signal)
        signal.addEventListener('abort', () => stop(signal.reason), {
          once: true,
        });
      if (hangsForever) return; // never settles unless aborted
      const timer = setTimeout(() => {
        resolve({
          ok: true,
          headers: {
            get: (name) =>
              name === 'Data-Present'
                ? String(present)
                : name === 'Acquisition-Time'
                  ? acquisitionTime
                  : null,
          },
          blob: async () => new Blob([present ? 'viirs' : 'empty']),
        });
      }, delay);
      if (signal)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            stop(signal.reason);
          },
          { once: true },
        );
    });
}

function timedFetch(answers) {
  const calls = [];
  const stopped = new Set();
  const fetchImpl = (url, { signal } = {}) => {
    calls.push(String(url));
    const half = halfOf(url);
    const side = sameBox(half, EAST_HALF) ? 'east' : 'west';
    signal?.addEventListener('abort', () => stopped.add(side), { once: true });
    return answers[side](signal);
  };
  return { calls, fetchImpl, stopped };
}

const answer = (options) => snapshot(options);

const neverSettles = () => new Promise(() => {}); // ignores abort entirely

// ---- source level ------------------------------------------------------

test('a dateline day with a stalled half settles bounded: the present half survives, the stall is bounded by the deadline', async () => {
  const fetch = timedFetch({
    east: answer({ present: true, acquisitionTime: `${FIJI_DAY}T22:10:00Z` }),
    west: answer({ hangsForever: true }),
  });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    halfDeadlineMs: 30,
  });
  const started = Date.now();
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  const elapsed = Date.now() - started;

  assert.ok(
    elapsed >= 25,
    `the stalled half was bounded, not dropped (${elapsed} ms)`,
  );
  assert.ok(elapsed < 2000, `bounded by the deadline (${elapsed} ms)`);
  assert.equal(response.headers.get('Data-Present'), 'true');
  assert.equal(
    response.headers.get('Acquisition-Time'),
    `${FIJI_DAY}T22:10:00Z`,
  );
  assert.equal([...fetch.calls].length, 2, 'both halves were requested');
});

test('a half whose transport ignores AbortSignal is still bounded by its deadline', async () => {
  const calls = [];
  const source = createRecentImagerySource({
    thumbnailUrl: ({ box }) => {
      calls.push(box);
      return 'https://imagery.example/thumbnail';
    },
    fetchImpl: neverSettles,
    halfDeadlineMs: 10,
  });
  const started = Date.now();
  await assert.rejects(
    source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX),
    (error) => error?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 1000, 'the deadline fired without abort');
  assert.equal(calls.length, 2, 'both halves were requested');
});

test("the caller's cancellation rejects even when a transport ignores AbortSignal", async () => {
  const source = createRecentImagerySource({
    fetchImpl: neverSettles,
    halfDeadlineMs: 60_000,
  });
  const controller = new AbortController();
  const settled = source
    .getThumbnail(FIJI_CANDIDATE, FIJI_BOX, { signal: controller.signal })
    .then(
      () => 'resolved',
      (error) => error,
    );
  controller.abort(new DOMException('stopped', 'AbortError'));
  const outcome = await settled;
  assert.equal(outcome?.name, 'AbortError', 'the day rejected with the stop');
});

test('both present halves are preserved: presentBoxes carries every data half and the blob stays readable', async () => {
  const fetch = timedFetch({
    east: answer({ present: true, acquisitionTime: `${FIJI_DAY}T21:00:00Z` }),
    west: answer({ present: true, acquisitionTime: `${FIJI_DAY}T20:00:00Z` }),
  });
  const source = createRecentImagerySource({ fetchImpl: fetch.fetchImpl });
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);

  assert.equal(response.presentBoxes.length, 2, 'every present half survives');
  const drapes = response.presentBoxes.map((half) =>
    [EAST_HALF, WEST_HALF].find((h) => sameBox(h, half)),
  );
  assert.deepEqual(
    new Set(drapes),
    new Set([EAST_HALF, WEST_HALF]),
    'each present half maps to a distinct probe half',
  );
  assert.ok(response.blob, 'the answer stays a readable response');
  const blob = await response.blob();
  assert.ok(blob.size > 0, 'the blob reads after presentBoxes is attached');
});

test('a successful probe leaves no deadline timer behind', async () => {
  const timers = new Set();
  let cleared = [];
  const fetch = timedFetch({
    east: answer({ present: true }),
    west: answer({ present: false }),
  });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    setTimeoutImpl: (fn, ms) => {
      const id = timers.size + 1;
      timers.add(id);
      return id;
    },
    clearTimeoutImpl: (id) => {
      cleared.push(id);
      timers.delete(id);
    },
  });
  await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  assert.notEqual(fetch, undefined);
  assert.equal(timers.size, 0, 'every live deadline timer was cleared');
  assert.ok(cleared.length > 0, 'clearTimeout ran at least once');
});

test('a hung half is bounded by the per-half deadline: the day errors instead of holding a loader slot forever', async () => {
  const fetch = timedFetch({
    east: answer({ hangsForever: true }),
    west: answer({ hangsForever: true }),
  });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    halfDeadlineMs: 20,
  });
  const started = Date.now();
  await assert.rejects(
    source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX),
    (error) => error?.name === 'TimeoutError',
  );
  assert.ok(Date.now() - started < 500, 'the deadline fired promptly');
});

test('per-half availability is carried on the response: one present half, one confirmed empty', async () => {
  const fetch = timedFetch({
    east: answer({ present: true, acquisitionTime: `${FIJI_DAY}T22:10:00Z` }),
    west: answer({ present: false }),
  });
  const source = createRecentImagerySource({ fetchImpl: fetch.fetchImpl });
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  // P1: which half has data survives past combineHalves.
  assert.deepEqual(response.presentBoxes, [EAST_HALF]);
  assert.notEqual(response.blob, undefined);
});

test('both halves confirmed empty keep the day empty; a single non-crossing half reports its own box', async () => {
  const fetch = timedFetch({
    east: answer({ present: false }),
    west: answer({ present: false }),
  });
  const source = createRecentImagerySource({ fetchImpl: fetch.fetchImpl });
  const empty = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  assert.equal(empty.headers.get('Data-Present'), 'false', 'the day is empty');
  assert.deepEqual(empty.presentBoxes, []);

  const plainBox = nonCrossingBoxes({
    west: -97.8,
    south: 30.2,
    east: -97.7,
    north: 30.3,
  })[0];
  const plainSource = createRecentImagerySource({
    fetchImpl: (url, { signal } = {}) =>
      answer({ present: true, acquisitionTime: `${FIJI_DAY}T22:10:00Z` })(
        signal,
      ),
  });
  const plainResponse = await plainSource.getThumbnail(
    FIJI_CANDIDATE,
    plainBox,
  );
  assert.equal(
    plainResponse.presentBoxes.length,
    1,
    'the plain box proves itself',
  );
  assert.ok(sameBox(plainResponse.presentBoxes[0], plainBox));
});

test('a half that fails or stalls after the other half proved data does not unseat the day; a failed half never reads as empty', async () => {
  const fetch = timedFetch({
    east: answer({ hangsForever: true }),
    west: answer({ present: true, acquisitionTime: `${FIJI_DAY}T20:00:00Z` }),
  });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    halfDeadlineMs: 30,
  });
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  assert.equal(response.headers.get('Data-Present'), 'true');
  assert.deepEqual(
    response.presentBoxes,
    [EAST_HALF, WEST_HALF],
    'the unproven half is not called empty',
  );

  const failing = timedFetch({
    east: answer({ present: false }),
    west: answer({ reject: new Error('snapshot failed'), delay: 5 }),
  });
  const strict = createRecentImagerySource({ fetchImpl: failing.fetchImpl });
  await assert.rejects(
    strict.getThumbnail(FIJI_CANDIDATE, FIJI_BOX),
    /snapshot failed/,
    'a failed half is an error, never an empty day',
  );
});

test("the caller's cancellation rejects promptly and touches every half", async () => {
  const fetch = timedFetch({
    east: answer({ hangsForever: true }),
    west: answer({ hangsForever: true }),
  });
  const source = createRecentImagerySource({ fetchImpl: fetch.fetchImpl });
  const controller = new AbortController();
  const settled = source
    .getThumbnail(FIJI_CANDIDATE, FIJI_BOX, { signal: controller.signal })
    .then(
      () => 'resolved',
      (error) => error,
    );
  controller.abort(new DOMException('stopped', 'AbortError'));
  const outcome = await settled;
  assert.equal(outcome?.name, 'AbortError', 'the day rejected with the stop');
  assert.ok(
    fetch.stopped.has('east') && fetch.stopped.has('west'),
    'each half was cancelled',
  );
});

// ---- loader level (real loader over the real source) -------------------

test('the loader proves a dateline day present from one half and hands the present half onward', async () => {
  const fetch = timedFetch({
    east: answer({ present: true, acquisitionTime: `${FIJI_DAY}T22:10:00Z` }),
    west: answer({ present: false }),
  });
  const loader = createThumbnailLoader({
    fetchImpl: fetch.fetchImpl,
    size: 256,
  });
  const notified = new Promise((resolve) => {
    const off = loader.subscribe((key) => {
      if (key === FIJI_CANDIDATE.key) {
        off();
        resolve();
      }
    });
  });
  loader.request(FIJI_CANDIDATE, FIJI_BOX);
  await notified;
  const day = loader.get(FIJI_CANDIDATE.key);
  assert.equal(day.status, 'present', 'one half with data proves the day');
  assert.equal(
    day.acquisitionTime,
    `${FIJI_DAY}T22:10:00Z`,
    'the present half’s sensing time',
  );
  assert.ok(day.objectUrl);
  assert.deepEqual(
    day.availableBoxes,
    [EAST_HALF],
    'per-half availability rides along',
  );
  loader.destroy();
});

test('a hung half does not strand the loader day at "checking" when the deadline bounds it', async () => {
  const fetch = timedFetch({
    east: answer({ hangsForever: true }),
    west: answer({ hangsForever: true }),
  });
  const loader = createThumbnailLoader({ fetchImpl: fetch.fetchImpl });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    halfDeadlineMs: 20,
  });
  const hungLoader = createThumbnailLoader({
    requestThumbnail: source.getThumbnail,
  });
  const notified = new Promise((resolve) =>
    hungLoader.subscribe(() => resolve()),
  );
  hungLoader.request(FIJI_CANDIDATE, FIJI_BOX);
  await notified;
  assert.equal(
    hungLoader.get(FIJI_CANDIDATE.key).status,
    'error',
    'a deadline is an error, not "checking" forever',
  );
  hungLoader.destroy();
  loader.destroy();
});

// ---- renderer level ----------------------------------------------------

function fakeCesium() {
  class Provider {
    constructor(options) {
      this.options = options;
    }
    requestImage() {
      return new Promise(() => {});
    }
  }
  return {
    UrlTemplateImageryProvider: Provider,
    WebMercatorTilingScheme: class {},
    Rectangle: {
      fromDegrees: (west, south, east, north) => ({ west, south, east, north }),
    },
    SplitDirection: { LEFT: -1, NONE: 0, RIGHT: 1 },
  };
}

function fakeCollection() {
  const layers = [];
  return {
    layers,
    addImageryProvider(provider) {
      const layer = { provider, alpha: 1, splitDirection: 0 };
      layers.push(layer);
      return layer;
    },
    remove(layer, destroy) {
      layers.splice(layers.indexOf(layer), 1);
      layer.destroyed = destroy;
    },
  };
}

const rectangles = (collection) =>
  collection.layers.map((layer) => layer.provider.options.rectangle);

test('the renderer drapes only the halves the probe proved present, and rebind keeps that choice', () => {
  const renderer = createRecentImageryRenderer({ cesium: fakeCesium() });
  const globe = fakeCollection();
  renderer.rebind({ collection: globe, kind: 'globe' });

  assert.equal(
    renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX, {
      availableBoxes: [EAST_HALF],
    }),
    true,
  );
  const draped = rectangles(globe);
  assert.equal(draped.length, 1, 'only the data-present half is draped');
  assert.ok(sameBox(draped[0], EAST_HALF));
  for (const rect of draped)
    assert.ok(rect.west <= rect.east, 'every draped rectangle is plain');

  // A dateline day that both halves proved present drapes both halves.
  renderer.showSlot('b', FIJI_CANDIDATE, FIJI_BOX, {
    availableBoxes: [EAST_HALF, WEST_HALF],
  });
  assert.equal(
    globe.layers.length,
    3,
    'a day proven on both halves drapes both halves (plus slot a)',
  );

  // A host switch rebuilds on the same evidence.
  const globe2 = fakeCollection();
  renderer.rebind({ collection: globe2, kind: 'globe' });
  assert.ok(
    sameBox(rectangles(globe2)[0], EAST_HALF),
    'rebind re-mounts the present half',
  );

  // Without availability the whole box is still draped (any proven day, HLS).
  renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX);
  assert.equal(
    globe2.layers.length,
    4,
    'unlimited by evidence, both halves drape (slot b keeps its both-half evidence)',
  );
  renderer.destroy();
  assert.equal(globe2.layers.length, 0, 'destroy tears the layers down');
});

test('an empty day with no proven half drapes nothing; a stale half never drapes either', () => {
  const renderer = createRecentImageryRenderer({ cesium: fakeCesium() });
  const globe = fakeCollection();
  renderer.rebind({ collection: globe, kind: 'globe' });
  assert.equal(
    renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX, { availableBoxes: [] }),
    false,
    'no proven half, no drape',
  );
  assert.equal(globe.layers.length, 0);
  const elsewhere = nonCrossingBoxes({
    west: -97.8,
    south: 30.2,
    east: -97.7,
    north: 30.3,
  })[0];
  assert.equal(
    renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX, {
      availableBoxes: [elsewhere],
    }),
    false,
    'proven halves of another box do not drape this one',
  );
  assert.equal(globe.layers.length, 0);
});

// ---- the whole layer (real source → loader → renderer) ------------------

test('a VIIRS dateline day with data on one half drapes only that half through the real layer', async () => {
  const fetch = timedFetch({
    east: answer({ present: true, acquisitionTime: `${FIJI_DAY}T22:10:00Z` }),
    west: answer({ present: false }),
  });
  const loader = createThumbnailLoader({ fetchImpl: fetch.fetchImpl });
  const renderer = createRecentImageryRenderer({ cesium: fakeCesium() });
  const globe = fakeCollection();
  const catalog = {
    searchHls: async () => ({
      candidates: [FIJI_CANDIDATE],
      truncated: false,
      errors: [],
    }),
  };
  const layer = createRecentImageryLayer({
    catalog,
    renderer,
    thumbnails: loader,
    host: () => ({ collection: globe, kind: 'globe' }),
    now: () => new Date(`${FIJI_DAY}T15:00:00Z`),
  });
  layer.init({ camera: {} });
  layer.setSources({ viirs: true });
  layer.enable();
  assert.equal(layer.setBox(FIJI_BOX), true, 'the dateline box validates');

  // The probe fetched both halves, wider first, and the layer draped the
  // winner on its own notify.
  await until(() => rectangles(globe).length > 0);
  const snapshot = layer.getSnapshot();
  const draped = rectangles(globe);
  assert.equal(fetch.calls.length, 2, 'one probe per half');
  const probed = fetch.calls.map((url) => halfOf(url));
  assert.ok(sameBox(probed[0], EAST_HALF), 'the wider half is probed first');
  assert.ok(sameBox(probed[1], WEST_HALF));

  assert.equal(draped.length, 1, 'only the data-present half hit the map');
  assert.ok(sameBox(draped[0], EAST_HALF));

  // The day stays present and listed after draping.
  assert.equal(loader.get(FIJI_CANDIDATE.key).status, 'present');
  assert.equal(snapshot.candidates[0].thumbnail.status, 'present');
  assert.equal(snapshot.candidates[0].drapable, true);
  assert.equal(
    snapshot.auto?.key,
    FIJI_CANDIDATE.key,
    'START HERE keeps the day',
  );

  layer.destroy();
  loader.destroy();
  assert.equal(
    globe.layers.length,
    0,
    'tearing the layer down takes the imagery with it',
  );
});

test('a dateline day both halves confirm empty never drapes and leaves the strip when hidden', async () => {
  const fetch = timedFetch({
    east: answer({ present: false }),
    west: answer({ present: false }),
  });
  const loader = createThumbnailLoader({ fetchImpl: fetch.fetchImpl });
  const renderer = createRecentImageryRenderer({ cesium: fakeCesium() });
  const globe = fakeCollection();
  const catalog = {
    searchHls: async () => ({
      candidates: [FIJI_CANDIDATE],
      truncated: false,
      errors: [],
    }),
  };
  const layer = createRecentImageryLayer({
    catalog,
    renderer,
    thumbnails: loader,
    host: () => ({ collection: globe, kind: 'globe' }),
    now: () => new Date(`${FIJI_DAY}T15:00:00Z`),
  });
  layer.init({ camera: {} });
  layer.setSources({ viirs: true });
  layer.enable();
  layer.setBox(FIJI_BOX);
  await new Promise((resolve) => {
    const off = loader.subscribe(() => {
      off();
      resolve();
    });
    layer.subscribe(() => {
      /* the layer is the one that reacts */
    });
  });
  await until(() => loader.get(FIJI_CANDIDATE.key).status === 'empty');
  assert.equal(globe.layers.length, 0, 'a confirmed-empty day never drapes');
  layer.destroy();
  loader.destroy();
});

test('a failed half is not mistaken for confirmed empty when the other is present', async () => {
  const fetch = timedFetch({
    east: answer({ present: true }),
    west: answer({ reject: new Error('offline') }),
  });
  const source = createRecentImagerySource({
    fetchImpl: fetch.fetchImpl,
    halfDeadlineMs: 20,
  });
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  assert.deepEqual(
    new Set(response.presentBoxes.map(bbox)),
    new Set([bbox(EAST_HALF), bbox(WEST_HALF)]),
  );
});

test('frozen responses retain availability', async () => {
  const fetch = timedFetch({
    east: (s) => answer({ present: true })(s).then(Object.freeze),
    west: answer({ present: false }),
  });
  const source = createRecentImagerySource({ fetchImpl: fetch.fetchImpl });
  const response = await source.getThumbnail(FIJI_CANDIDATE, FIJI_BOX);
  assert.deepEqual(response.presentBoxes, [EAST_HALF]);
  assert.ok((await response.blob()).size);
});

test('frozen native Response retains status and text methods', async () => {
  const source = createRecentImagerySource({
    thumbnailUrl: () => 'https://example.invalid/',
    fetchImpl: async () =>
      Object.freeze(
        new Response('image', {
          status: 200,
          headers: { 'Data-Present': 'true' },
        }),
      ),
  });
  const response = await source.getThumbnail(FIJI_CANDIDATE, EAST_HALF);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'image');
  assert.deepEqual(response.presentBoxes, [EAST_HALF]);
});

test('removes previous drape when evidence changes from unknown to empty', () => {
  const renderer = createRecentImageryRenderer({ cesium: fakeCesium() });
  const globe = fakeCollection();
  renderer.rebind({ collection: globe, kind: 'globe' });
  renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX);
  assert.equal(globe.layers.length, 2);
  assert.equal(
    renderer.showSlot('a', FIJI_CANDIDATE, FIJI_BOX, { availableBoxes: [] }),
    false,
  );
  assert.equal(globe.layers.length, 0);
  renderer.destroy();
});
