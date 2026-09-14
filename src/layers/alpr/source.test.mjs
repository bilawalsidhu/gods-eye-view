import test from 'node:test';
import assert from 'node:assert/strict';
import { createOverpassAlprSource } from './source.js';
import { validateAlprSnapshot, alprCreditMarkup } from './model.js';
const box = { south: 30, west: -98, north: 30.1, east: -97.9 };
test('the source rejects invalid and unbounded queries before fetching', async () => {
  let calls = 0;
  const source = createOverpassAlprSource({
    fetchImpl() {
      calls++;
    },
  });
  for (const bad of [
    null,
    { ...box, west: '0);out;' },
    { ...box, north: 90 },
    { ...box, east: -99 },
    { ...box, south: NaN },
  ]) {
    await assert.rejects(source.fetch(bad), /bounded city viewport/);
  }
  assert.equal(calls, 0);
});
test('cancellation during body parsing rejects even when the transport ignores it', async () => {
  const abort = new AbortController();
  const source = createOverpassAlprSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      json: async () => {
        abort.abort();
        return { elements: [] };
      },
    }),
  });
  await assert.rejects(source.fetch(box, abort.signal), { name: 'AbortError' });
});

test('Overpass normalization returns camera records and preserves limited/stale coverage', async () => {
  const source = createOverpassAlprSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers({ 'x-overpass-cache': 'STALE' }),
      json: async () => ({
        elements: [
          {
            type: 'node',
            id: 12,
            lat: 30,
            lon: -98,
            tags: {
              'surveillance:type': 'camera;ALPR',
              'camera:direction': '90',
            },
          },
        ],
      }),
    }),
  });
  const snapshot = await source.fetch(box);
  assert.equal(snapshot.records[0].id, 'alpr:12');
  assert.equal(snapshot.records[0].latitude, 30);
  assert.equal(snapshot.records[0].directionDeg, 90);
  assert.equal(snapshot.stale, true);
  assert.equal(snapshot.saturated, false);
  assert.equal('elements' in snapshot, false);
});

test('an unsuccessful source response releases its body before reporting an error', async () => {
  let cancelled = 0;
  const source = createOverpassAlprSource({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      body: {
        async cancel() {
          cancelled++;
        },
      },
    }),
  });
  await assert.rejects(source.fetch(box), /rate-limited/);
  assert.equal(cancelled, 1);
});

test('source snapshots reject malformed coordinates and duplicate identities', () => {
  const record = { id: 'camera:1', latitude: 30, longitude: -98 };
  for (const records of [
    [{ ...record, latitude: NaN }],
    [record, record],
    [{ ...record, id: '' }],
  ]) {
    assert.throws(
      () => validateAlprSnapshot({ records, stale: false, saturated: false }),
      /invalid record/,
    );
  }
  assert.throws(
    () => validateAlprSnapshot({ elements: [] }),
    /invalid snapshot/,
  );
});

test('provider attribution escapes markup and rejects executable links', () => {
  assert.equal(alprCreditMarkup(null), null);
  assert.throws(
    () => alprCreditMarkup({ text: 'test', href: 'javascript:alert(1)' }),
    /HTTPS/,
  );
  const html = alprCreditMarkup({
    text: '<img onerror=alert(1)>',
    href: 'https://example.org/?a=1&b=2',
  });
  assert.ok(html.includes('&lt;img onerror=alert(1)&gt;'));
  assert.ok(html.includes('?a=1&amp;b=2'));
  assert.ok(!html.includes('<img'));
});
