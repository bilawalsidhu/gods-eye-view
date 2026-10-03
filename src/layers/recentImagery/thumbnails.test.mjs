import test from 'node:test';
import assert from 'node:assert/strict';
import { createThumbnailLoader } from './thumbnails.js';
import { BOX, response, settle } from './testDoubles.mjs';

const candidate = (product, day) => ({
  key: `${product}:${day}`,
  product,
  day,
});

/** A fetch whose responses the test releases, in any order. */
function fakeFetch() {
  const calls = [];
  const impl = (url, { signal } = {}) =>
    new Promise((resolve, reject) => {
      signal?.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
      calls.push({ url, signal, resolve });
    });
  const respond = (index, { ok = true, present = 'true' } = {}) =>
    calls[index].resolve(
      response({
        ok,
        headers: {
          'Data-Present': present,
          'Acquisition-Time': '2026-09-18T17:12:00Z',
        },
      }),
    );
  return { impl, calls, respond };
}

function fixture(options = {}) {
  const fetch = fakeFetch();
  const created = [];
  const revoked = [];
  const loader = createThumbnailLoader({
    fetchImpl: fetch.impl,
    createObjectUrl: () => {
      created.push(`blob:${created.length + 1}`);
      return created.at(-1);
    },
    revokeObjectUrl: (url) => revoked.push(url),
    ...options,
  });
  return { loader, fetch, created, revoked };
}

test('Data-Present decides the day: present with an object URL and sensing time, empty, or error', async () => {
  const { loader, fetch, created } = fixture();
  const changes = [];
  loader.subscribe((key) => changes.push(key));
  loader.request(candidate('S30', '2026-09-18'), BOX, 0);
  loader.request(candidate('L30', '2026-09-16'), BOX, 1);
  loader.request(candidate('VIIRS', '2026-09-15'), BOX, 2);
  assert.equal(loader.get('S30:2026-09-18').loading, true);
  assert.match(
    fetch.calls[0].url,
    /wvs\.earthdata\.nasa\.gov.*HLS_S30.*TIME=2026-09-18.*WIDTH=256&HEIGHT=256/,
  );
  fetch.respond(0);
  fetch.respond(1, { present: 'false' });
  fetch.respond(2, { ok: false });
  await settle();
  assert.deepEqual(loader.get('S30:2026-09-18'), {
    status: 'present',
    objectUrl: 'blob:1',
    acquisitionTime: '2026-09-18T17:12:00Z',
    loading: false,
  });
  assert.equal(loader.get('L30:2026-09-16').status, 'empty');
  assert.equal(loader.get('VIIRS:2026-09-15').status, 'error');
  assert.deepEqual(created, ['blob:1']);
  assert.deepEqual(changes.sort(), [
    'L30:2026-09-16',
    'S30:2026-09-18',
    'VIIRS:2026-09-15',
  ]);
  assert.equal(loader.get('nope').status, 'unknown');
});

test('at most maxInFlight fetches run and the queue drains by priority', async () => {
  const { loader, fetch } = fixture({ maxInFlight: 2 });
  loader.request(candidate('S30', '2026-09-10'), BOX, 5);
  loader.request(candidate('S30', '2026-09-11'), BOX, 1);
  loader.request(candidate('S30', '2026-09-12'), BOX, 0);
  loader.request(candidate('S30', '2026-09-13'), BOX, 3);
  // The pump is eager: the first two arrivals start at once, the rest queue.
  assert.equal(fetch.calls.length, 2);
  assert.match(fetch.calls[0].url, /TIME=2026-09-10/);
  assert.match(fetch.calls[1].url, /TIME=2026-09-11/);
  assert.deepEqual(loader.stats(), {
    inFlight: 2,
    queued: 2,
    decoded: 0,
    tracked: 4,
  });
  fetch.respond(0);
  await settle();
  assert.equal(fetch.calls.length, 3);
  assert.match(fetch.calls[2].url, /TIME=2026-09-12/, 'priority 0 before 3');
  // A repeat request for a queued key just re-prioritises it.
  loader.request(candidate('S30', '2026-09-13'), BOX, 0);
  assert.equal(loader.stats().tracked, 4);
  fetch.respond(1);
  await settle();
  assert.equal(fetch.calls.length, 4);
  assert.match(fetch.calls[3].url, /TIME=2026-09-13/);
});

test('requestOrdered loads the focused card first, then outward, then the margins', () => {
  const { loader, fetch } = fixture({ maxInFlight: 10 });
  const candidates = Array.from({ length: 8 }, (_, i) =>
    candidate('S30', `2026-09-${String(10 + i).padStart(2, '0')}`),
  );
  loader.requestOrdered(candidates, BOX, {
    focusIndex: 3,
    firstVisible: 2,
    lastVisible: 5,
    extra: 1,
  });
  const days = fetch.calls.map(
    (call) => /TIME=2026-09-(\d\d)/.exec(call.url)[1],
  );
  assert.deepEqual(days, ['13', '14', '12', '15', '16', '11']);
});

test('decoded thumbnails are evicted least-recently-used and revoked; a read is not a use and an evicted day keeps what it learned', async () => {
  const { loader, fetch, revoked } = fixture({
    maxInFlight: 10,
    maxDecoded: 2,
  });
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  loader.request(candidate('S30', '2026-09-11'), BOX, 1);
  loader.request(candidate('S30', '2026-09-12'), BOX, 2);
  fetch.respond(0);
  fetch.respond(1);
  await settle();
  assert.equal(loader.stats().decoded, 2);
  loader.get('S30:2026-09-10'); // reading the oldest does not make it recent
  fetch.respond(2);
  await settle();
  assert.equal(loader.stats().decoded, 2);
  assert.deepEqual(revoked, ['blob:1']);
  const evicted = loader.get('S30:2026-09-10');
  assert.equal(evicted.status, 'present', 'availability survives eviction');
  assert.equal(evicted.objectUrl, null);
  assert.equal(evicted.acquisitionTime, '2026-09-18T17:12:00Z');
  assert.equal(loader.stats().tracked, 3, 'the entry is kept');
  assert.equal(loader.get('S30:2026-09-11').objectUrl, 'blob:2');
  assert.equal(loader.get('S30:2026-09-12').objectUrl, 'blob:3');
  // A repeat request IS a use, and re-fetches an evicted day without ever
  // reporting it unknown; 11 is now the LRU and goes when 10 comes back.
  loader.request(candidate('S30', '2026-09-12'), BOX, 0);
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  assert.equal(fetch.calls.length, 4, 'an evicted day is fetched again');
  assert.equal(loader.get('S30:2026-09-10').status, 'present');
  assert.equal(loader.get('S30:2026-09-10').loading, true);
  fetch.respond(3);
  await settle();
  assert.equal(loader.get('S30:2026-09-10').objectUrl, 'blob:4');
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
  assert.equal(loader.get('S30:2026-09-11').status, 'present');
  assert.equal(loader.get('S30:2026-09-12').objectUrl, 'blob:3');
  // A day that already holds an image is not fetched twice.
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  assert.equal(fetch.calls.length, 4);
});

test('reading every card in strip order (a snapshot) never decides who is evicted; evicted days stay known and come back on request', async () => {
  const { loader, fetch, revoked } = fixture({
    maxInFlight: 20,
    maxDecoded: 9,
  });
  const candidates = Array.from({ length: 20 }, (_, i) =>
    candidate('S30', `2026-09-${String(i + 1).padStart(2, '0')}`),
  );
  candidates.forEach((c, i) => loader.request(c, BOX, i));
  assert.equal(fetch.calls.length, 20);
  // Decode the strip back to front, leaving the newest card in flight.
  for (let i = 19; i >= 1; i -= 1) fetch.respond(i);
  await settle();
  const holders = () =>
    candidates.filter((c) => loader.get(c.key).objectUrl).map((c) => c.key);
  assert.equal(loader.stats().decoded, 9);
  assert.equal(loader.stats().tracked, 20);
  assert.deepEqual(
    holders(),
    candidates.slice(1, 10).map((c) => c.key),
    'the nine most recently decoded',
  );
  // Sweep every card in strip order, several times, as getSnapshot does.
  for (let pass = 0; pass < 3; pass += 1)
    for (const c of candidates) loader.get(c.key);
  assert.deepEqual(
    holders(),
    candidates.slice(1, 10).map((c) => c.key),
  );
  // The last decode evicts the least recently DECODED card, not the first
  // card the sweep happened to read.
  fetch.respond(0);
  await settle();
  assert.deepEqual(
    holders(),
    candidates.slice(0, 9).map((c) => c.key),
  );
  assert.equal(revoked.length, 11);
  for (const c of candidates) {
    const entry = loader.get(c.key);
    assert.equal(entry.status, 'present', `${c.key} stays present`);
    assert.equal(entry.acquisitionTime, '2026-09-18T17:12:00Z');
    assert.equal(entry.loading, false);
  }
  // Re-requesting an evicted day fetches it again and it holds an image.
  const evictedKey = candidates[15].key;
  assert.equal(loader.get(evictedKey).objectUrl, null);
  loader.request(candidates[15], BOX, 0);
  assert.equal(fetch.calls.length, 21);
  assert.equal(loader.get(evictedKey).status, 'present');
  fetch.respond(20);
  await settle();
  assert.ok(loader.get(evictedKey).objectUrl);
  assert.equal(loader.stats().decoded, 9);
  assert.equal(loader.stats().tracked, 20);
});

test('cancelAll aborts in-flight fetches and a late settle never leaks an object URL', async () => {
  const { loader, fetch, created, revoked } = fixture({ maxInFlight: 1 });
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  loader.request(candidate('S30', '2026-09-11'), BOX, 1);
  const signal = fetch.calls[0].signal;
  loader.cancelAll();
  assert.equal(signal.aborted, true);
  assert.deepEqual(loader.stats(), {
    inFlight: 1,
    queued: 0,
    decoded: 0,
    tracked: 0,
  });
  await settle();
  assert.equal(loader.stats().inFlight, 0);
  assert.deepEqual(created, []);
  assert.deepEqual(revoked, []);
  assert.equal(loader.get('S30:2026-09-10').status, 'unknown');
});

test('clear and destroy revoke every resident thumbnail', async () => {
  const { loader, fetch, revoked } = fixture({ maxInFlight: 10 });
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  loader.request(candidate('S30', '2026-09-11'), BOX, 1);
  fetch.respond(0);
  fetch.respond(1);
  await settle();
  loader.clear();
  assert.deepEqual(revoked.sort(), ['blob:1', 'blob:2']);
  assert.equal(loader.stats().tracked, 0);
  loader.request(candidate('S30', '2026-09-12'), BOX, 0);
  fetch.respond(2);
  await settle();
  loader.destroy();
  assert.equal(revoked.length, 3);
  loader.request(candidate('S30', '2026-09-13'), BOX, 0);
  assert.equal(fetch.calls.length, 3, 'a destroyed loader fetches nothing');
});

test('a request queued behind an aborted fetch still starts once the abort settles', async () => {
  // A response that arrives after the abort (the fetch ignored the signal).
  const calls = [];
  const fetchImpl = (url, { signal } = {}) =>
    new Promise((resolve) => calls.push({ url, signal, resolve }));
  const loader = createThumbnailLoader({
    fetchImpl,
    maxInFlight: 1,
    createObjectUrl: () => 'blob:x',
    revokeObjectUrl: () => {},
  });
  loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  loader.clear();
  loader.request(candidate('S30', '2026-09-11'), BOX, 0);
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(loader.stats(), {
    inFlight: 1,
    queued: 1,
    decoded: 0,
    tracked: 1,
  });
  calls[0].resolve({
    ok: true,
    headers: { get: () => null },
    blob: async () => ({}),
  });
  await settle();
  assert.equal(calls.length, 2, 'the replacement request was pumped');
  assert.match(calls[1].url, /TIME=2026-09-11/);
  assert.deepEqual(loader.stats(), {
    inFlight: 1,
    queued: 0,
    decoded: 0,
    tracked: 1,
  });

  // The same sequence when the fetch rejects with AbortError instead.
  const rejecting = fixture({ maxInFlight: 1 });
  rejecting.loader.request(candidate('S30', '2026-09-10'), BOX, 0);
  rejecting.loader.clear();
  rejecting.loader.request(candidate('S30', '2026-09-11'), BOX, 0);
  await settle();
  assert.equal(rejecting.fetch.calls.length, 2);
  assert.deepEqual(rejecting.loader.stats(), {
    inFlight: 1,
    queued: 0,
    decoded: 0,
    tracked: 1,
  });
});
