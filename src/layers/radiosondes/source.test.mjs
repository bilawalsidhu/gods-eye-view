import test from 'node:test';
import assert from 'node:assert/strict';
import { createRadiosondeSource } from './source.js';
const now = 1_800_000_000_000;
const frame = {
  serial: 'TEST123',
  timeMs: now,
  receivedMs: now,
  lat: 50,
  lon: 10,
  altM: 10000,
  uploader_callsign: 'PRIVATE',
};
const snapshot = {
  frames: [frame],
  upstream: 'live',
  lastFrameMs: now,
  stale: false,
  fetchedAt: now,
};
test('202 building is a normal bounded response with Retry-After seconds, followed by a regular snapshot', async () => {
  let status = 202,
    answer = { status: 'building' },
    headers = { 'Retry-After': '2' };
  const source = createRadiosondeSource({
    now: () => now,
    fetchImpl: async () =>
      new Response(JSON.stringify(answer), { status, headers }),
  });
  assert.deepEqual(await source.getSnapshot(), {
    status: 'building',
    retryAfterSec: 2,
  });
  for (const retry of [undefined, 'soon', '0', '-1']) {
    headers = retry === undefined ? {} : { 'Retry-After': retry };
    assert.deepEqual(await source.getSnapshot(), {
      status: 'building',
      retryAfterSec: null,
    });
  }
  answer = {};
  await assert.rejects(
    source.getSnapshot(),
    /Malformed weather balloon snapshot/,
  );
  answer = { status: 'building' };
  headers = { 'content-length': String(3 * 1024 * 1024) };
  await assert.rejects(source.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
  headers = {};
  await assert.rejects(source.getTrack({ serial: 'TEST123' }), /Malformed/);
  status = 200;
  answer = snapshot;
  assert.equal((await source.getSnapshot()).frames.length, 1);
});
class Events {
  static last;
  readyState = 0;
  listeners = new Map();
  closed = false;
  constructor(url) {
    this.url = url;
    Events.last = this;
  }
  addEventListener(type, fn) {
    this.listeners.set(type, fn);
  }
  removeEventListener(type) {
    this.listeners.delete(type);
  }
  close() {
    this.closed = true;
  }
  emit(type, value) {
    this.listeners.get(type)?.({
      data: typeof value === 'string' ? value : JSON.stringify(value),
    });
  }
}
test('partial is validated and preserved through HTTP and SSE without receiver fields', async () => {
  let answer = { ...snapshot, partial: true };
  const seen = [];
  const source = createRadiosondeSource({
    now: () => now,
    EventSourceImpl: Events,
    fetchImpl: async () => new Response(JSON.stringify(answer)),
  });
  assert.equal((await source.getSnapshot()).partial, true);
  const close = source.subscribe((event) => seen.push(event));
  Events.last.emit('frames', answer);
  assert.equal(seen[0].partial, true);
  assert.doesNotMatch(JSON.stringify(seen), /uploader|PRIVATE/);
  answer = { ...snapshot, partial: 'true' };
  await assert.rejects(source.getSnapshot(), /Malformed/);
  Events.last.emit('snapshot', answer);
  assert.equal(seen.length, 1);
  answer = { ...snapshot, partial: false };
  assert.equal((await source.getSnapshot()).partial, false);
  close();
});
test('SSE states, validation and unsubscribe guard late frames', () => {
  const seen = [],
    states = [];
  const source = createRadiosondeSource({
    EventSourceImpl: Events,
    now: () => now,
  });
  const close = source.subscribe(
    (e) => seen.push(e),
    (s) => states.push(s),
  );
  const es = Events.last;
  assert.equal(es.url, '/api/radiosondes/stream');
  es.readyState = 1;
  es.onopen();
  es.emit('snapshot', snapshot);
  es.emit('frames', snapshot);
  es.emit('status', { upstream: 'live', lastFrameMs: now });
  for (const bad of ['not json', {}, { ...snapshot, frames: null }])
    es.emit('snapshot', bad);
  assert.equal(seen.length, 3);
  assert.doesNotMatch(JSON.stringify(seen), /uploader|PRIVATE/);
  es.readyState = 2;
  es.onerror();
  assert.deepEqual(states, ['connecting', 'open', 'closed']);
  const late = es.listeners.get('frames');
  close();
  late({ data: JSON.stringify(snapshot) });
  assert.equal(seen.length, 3);
  assert.equal(es.closed, true);
  assert.equal(es.listeners.size, 0);
  const missing = [];
  createRadiosondeSource({ EventSourceImpl: null }).subscribe(
    () => {},
    (s) => missing.push(s),
  );
  assert.deepEqual(missing, ['unavailable']);
});
test('bounded JSON reads throw on HTTP, malformed and oversized data; tracks validate and abort', async () => {
  const urls = [];
  let answer = snapshot,
    status = 200,
    headers = {};
  const source = createRadiosondeSource({
    now: () => now,
    fetchImpl: async (url) => {
      urls.push(url);
      return new Response(JSON.stringify(answer), { status, headers });
    },
  });
  assert.equal((await source.getSnapshot()).frames.length, 1);
  status = 502;
  await assert.rejects(source.getSnapshot(), /SondeHub HTTP 502/);
  status = 200;
  answer = {};
  await assert.rejects(
    source.getSnapshot(),
    /Malformed weather balloon snapshot/,
  );
  answer = snapshot;
  headers = { 'content-length': String(3 * 1024 * 1024) };
  await assert.rejects(source.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
  headers = {};
  answer = { serial: 'TEST123', track: [frame], stale: true, fetchedAt: now };
  assert.equal((await source.getTrack({ serial: 'TEST123' })).stale, true);
  assert.equal(urls.at(-1), '/api/radiosondes/track?serial=TEST123');
  await source.getHistory({ serial: 'TEST123' });
  assert.match(urls.at(-1), /\/history\?serial=/);
  answer.track = [{ ...frame, lat: 91 }];
  await assert.rejects(source.getTrack({ serial: 'TEST123' }), /Malformed/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(source.getSnapshot({ signal: controller.signal }), {
    name: 'AbortError',
  });
});

test('snapshot and selected-serial transports abort in flight and never fetch an already aborted request', async () => {
  const calls = [];
  const source = createRadiosondeSource({
    fetchImpl: (url, { signal }) => {
      calls.push({ url, signal });
      return new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), {
          once: true,
        }),
      );
    },
  });
  for (const method of ['getSnapshot', 'getTrack', 'getHistory']) {
    const controller = new AbortController();
    const pending = source[method]({
      serial: method === 'getSnapshot' ? undefined : 'TEST123',
      signal: controller.signal,
    });
    assert.equal(calls.at(-1).signal, controller.signal);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    const requests = calls.length;
    await assert.rejects(
      source[method]({ serial: 'TEST123', signal: controller.signal }),
      { name: 'AbortError' },
    );
    assert.equal(calls.length, requests);
  }
  assert.deepEqual(
    calls.map(({ url }) => url),
    [
      '/api/radiosondes/snapshot',
      '/api/radiosondes/track?serial=TEST123',
      '/api/radiosondes/history?serial=TEST123',
    ],
  );
});

test('an invalid nonempty snapshot cannot masquerade as healthy empty, and EventSource construction can fall back', async () => {
  const source = createRadiosondeSource({
    now: () => now,
    fetchImpl: async () =>
      new Response(
        JSON.stringify({ ...snapshot, frames: [{ ...frame, lat: 100 }] }),
      ),
  });
  await assert.rejects(
    source.getSnapshot(),
    /Malformed weather balloon snapshot/,
  );
  const states = [];
  createRadiosondeSource({
    EventSourceImpl: class {
      constructor() {
        throw Error('unavailable');
      }
    },
  }).subscribe(
    () => {},
    (value) => states.push(value),
  );
  assert.deepEqual(states, ['unavailable']);
});
