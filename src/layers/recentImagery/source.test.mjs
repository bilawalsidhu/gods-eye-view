import test from 'node:test';
import assert from 'node:assert/strict';
import { manualTimers } from './testDoubles.mjs';
import { createRecentImagerySource } from './source.js';

test('imagery source routes catalog, thumbnails and tiles through supplied adapters', async () => {
  const controller = new AbortController();
  const query = {
    box: { west: 0, east: 1, south: 0, north: 1 },
    signal: controller.signal,
  };
  const candidate = { product: 'S30', day: '2026-10-01' };
  const calls = [];
  const fetchImpl = async (...args) => {
    calls.push(args);
    return new Response('image');
  };
  const source = createRecentImagerySource({
    fetchImpl,
    search: async (request) => {
      assert.equal(request.fetchImpl, fetchImpl);
      assert.equal(request.signal, controller.signal);
      assert.equal(request.box, query.box);
      return [candidate];
    },
    thumbnailUrl: ({ product, day, width }) =>
      `https://imagery.example/${product}/${day}/${width}`,
    tileTemplate: (product, day) =>
      `https://tiles.example/${product}/${day}/{z}/{x}/{y}`,
    credit: 'Example imagery',
  });
  assert.deepEqual(await source.searchHls(query), [candidate]);
  assert.equal(
    await (
      await source.getThumbnail(candidate, query.box, {
        signal: controller.signal,
      })
    ).text(),
    'image',
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://imagery.example/S30/2026-10-01/256');
  // The fetch gets a private signal chained to the caller's.
  const halfSignal = calls[0][1].signal;
  assert.notEqual(halfSignal, controller.signal);
  assert.equal(halfSignal.aborted, false);
  controller.abort();
  assert.equal(halfSignal.aborted, true);
  assert.equal(
    source.getTileTemplate(candidate.product, candidate.day),
    'https://tiles.example/S30/2026-10-01/{z}/{x}/{y}',
  );
  assert.equal(source.credit, 'Example imagery');
});

test('cancelled thumbnail acquisition does not return stale responses or retry', async () => {
  const controller = new AbortController();
  const box = { west: 0, south: 0, east: 1, north: 1 };
  let calls = 0;
  const source = createRecentImagerySource({
    thumbnailUrl: () => 'https://imagery.example/thumbnail',
    fetchImpl: async () => {
      calls++;
      controller.abort();
      return new Response('image');
    },
  });
  await assert.rejects(
    source.getThumbnail({}, box, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    source.getThumbnail({}, box, { signal: controller.signal }),
    { name: 'AbortError' },
  );
  assert.equal(calls, 1);
});

test('a dateline thumbnail is requested as two non-crossing halves, never as a crossing BBOX', async () => {
  const requested = [];
  const source = createRecentImagerySource({
    thumbnailUrl: ({ box }) => {
      requested.push(box);
      return 'https://imagery.example/thumbnail';
    },
    fetchImpl: async () => new Response('image'),
  });
  const candidate = { product: 'S30', day: '2026-10-01' };
  await source.getThumbnail(candidate, {
    west: 179.9,
    south: 0,
    east: -179,
    north: 1,
  });
  assert.deepEqual(requested, [
    { west: -180, south: 0, east: -179, north: 1 },
    { west: 179.9, south: 0, east: 180, north: 1 },
  ]);
  requested.length = 0;
  await source.getThumbnail(candidate, {
    west: 179,
    south: 0,
    east: -179.9,
    north: 1,
  });
  assert.deepEqual(requested[0], { west: 179, south: 0, east: 180, north: 1 });
  assert.equal(requested.length, 2);
  assert.ok(requested.every((box) => box.west <= box.east));
});

const NARROW_WEST = { west: 179.9, south: 0, east: -179, north: 1 };
// VIIRS is a JPEG without alpha. S30 (candidate) is a PNG.
const JPEG_CANDIDATE = { product: 'VIIRS', day: '2026-10-01' };
const WIDE_BOX = { west: -180, south: 0, east: -179, north: 1 };
const NARROW_BOX = { west: 179.9, south: 0, east: 180, north: 1 };

const dated = (present, body = 'image') =>
  new Response(body, { headers: { 'Data-Present': present } });
function halvesSource(answers, options = {}) {
  const requested = [];
  const source = createRecentImagerySource({
    ...options,
    thumbnailUrl: ({ box }) =>
      `https://imagery.example/${box.west}/${box.east}`,
    fetchImpl: async (url) => {
      requested.push(url);
      const answer = answers[url.split('imagery.example/')[1]];
      if (answer instanceof Error) throw answer;
      return answer.clone ? answer : answer();
    },
  });
  return { source, requested };
}
const candidate = { product: 'S30', day: '2026-10-01' };

test('a crossing box probes both halves and is present when only the narrow half has data', async () => {
  const { source, requested } = halvesSource({
    '-180/-179': dated('false'),
    '179.9/180': dated('true', 'narrow'),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(requested.length, 2);
  assert.equal(response.headers.get('Data-Present'), 'true');
  assert.equal(await response.text(), 'narrow');
  assert.deepEqual(response.presentBoxes, [NARROW_BOX]);
  assert.deepEqual(response.emptyBoxes, [WIDE_BOX]);
});

test('a crossing box with data only on the wider half is present and shows the wider side', async () => {
  const { source } = halvesSource({
    '-180/-179': dated('true', 'wide'),
    '179.9/180': dated('false'),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(await response.text(), 'wide');
});

test('a crossing box is empty only when both halves are confirmed empty', async () => {
  const { source } = halvesSource({
    '-180/-179': dated('false'),
    '179.9/180': dated('false'),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(response.headers.get('Data-Present'), 'false');
  assert.deepEqual(response.presentBoxes, []);
  assert.deepEqual(response.emptyBoxes, [WIDE_BOX, NARROW_BOX]);
});

test('a crossing box is not called empty when the other half failed', async () => {
  const { source } = halvesSource({
    '-180/-179': dated('false'),
    '179.9/180': () => new Response('x', { status: 503 }),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(response.ok, false);
});

test('a crossing box with both halves present shows the wider half and keeps both presentBoxes', async () => {
  const { source } = halvesSource({
    '-180/-179': dated('true', 'wide'),
    '179.9/180': dated('true', 'narrow'),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(await response.text(), 'wide');
  assert.deepEqual(response.presentBoxes, [WIDE_BOX, NARROW_BOX]);
});

test('a rejected half does not hide data on the other half, and never reads as empty', async () => {
  const { source } = halvesSource({
    '-180/-179': new Error('network'),
    '179.9/180': dated('true', 'narrow'),
  });
  const response = await source.getThumbnail(candidate, NARROW_WEST);
  assert.equal(await response.text(), 'narrow');
  const failing = halvesSource({
    '-180/-179': new Error('network'),
    '179.9/180': dated('false'),
  });
  await assert.rejects(
    failing.source.getThumbnail(candidate, NARROW_WEST),
    /network/,
  );
});

for (const [label, answer] of [
  ['rejected', new Error('network')],
  ['hung', () => new Promise(() => {})],
  ['answered without a presence', () => dated('unknown', 'maybe')],
]) {
  for (const product of [JPEG_CANDIDATE, candidate]) {
    test(`a ${product.product} half that ${label} is neither present nor empty`, async () => {
      const { source } = halvesSource(
        { '-180/-179': answer, '179.9/180': () => dated('true', 'narrow') },
        { halfDeadlineMs: 20 },
      );
      const response = await source.getThumbnail(product, NARROW_WEST);
      assert.equal(response.headers.get('Data-Present'), 'true');
      assert.deepEqual(response.presentBoxes, [NARROW_BOX]);
      assert.deepEqual(response.emptyBoxes, []);
    });
  }
}

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
      .getThumbnail(JPEG_CANDIDATE, NARROW_WEST, { signal: controller.signal })
      .then(
        () => 'resolved',
        (error) => error.name,
      ),
    new Promise((resolve) => setTimeout(() => resolve('stalled'), 50)),
  ]);
  assert.equal(outcome, 'AbortError');
});

test('a half whose transport ignores AbortSignal is still bounded by its deadline', async () => {
  const hang = () => new Promise(() => {});
  const { source, requested } = halvesSource(
    { '-180/-179': hang, '179.9/180': hang },
    { halfDeadlineMs: 10 },
  );
  await assert.rejects(source.getThumbnail(JPEG_CANDIDATE, NARROW_WEST), {
    name: 'TimeoutError',
  });
  assert.equal(requested.length, 2);
});

test("the caller's cancellation rejects at once and stops every half", async () => {
  const aborted = [];
  const source = createRecentImagerySource({
    thumbnailUrl: ({ box }) => String(box.west),
    fetchImpl: (url, { signal }) => {
      signal.addEventListener('abort', () => aborted.push(url), { once: true });
      return new Promise(() => {});
    },
  });
  const controller = new AbortController();
  const result = source.getThumbnail(JPEG_CANDIDATE, NARROW_WEST, {
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(result, { name: 'AbortError' });
  assert.deepEqual(aborted, ['-180', '179.9']);
});

test('a successful probe leaves no deadline timer behind', async () => {
  const timers = manualTimers();
  const { source } = halvesSource(
    { '-180/-179': dated('true'), '179.9/180': dated('false') },
    timers,
  );
  await source.getThumbnail(JPEG_CANDIDATE, NARROW_WEST);
  assert.equal(timers.armed(), 0);
  assert.equal(timers.cleared.length, 2);
});
