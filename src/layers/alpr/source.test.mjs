import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
const fixture = readFileSync(
  new URL(
    '../../data/fixtures/osm-alpr-austin-11-467-843.pbf',
    import.meta.url,
  ),
);
const metadata = (country) => ({
  tiles: [
    `https://tiles.dontgetflocked.com/cameras-${country}-hourly/{z}/{x}/{y}.mvt`,
  ],
  bounds: country === 'ca' ? [-124, 42, -63, 54] : [-160, 17, -64, 59],
});
const austin = { south: 30.2, north: 30.35, west: -97.85, east: -97.65 };

test('cancellation while reading TileJSON is preserved even if fetch ignores it', async () => {
  const abort = new AbortController();
  const source = createOverpassAlprSource({
    fetchImpl: async () => ({
      ok: true,
      headers: new Headers(),
      async text() {
        abort.abort();
        return JSON.stringify(metadata('us'));
      },
    }),
  });
  await assert.rejects(source.fetch(austin, abort.signal), {
    name: 'AbortError',
  });
});

test('extract detail tiles map OSM records and repeated pans reuse decoded tiles', async () => {
  const calls = [];
  const source = createOverpassAlprSource({
    fetchImpl: async (url) => {
      calls.push(url);
      return url.endsWith('.json')
        ? Response.json(metadata(url.includes('-ca-') ? 'ca' : 'us'))
        : new Response(fixture);
    },
  });
  const snapshot = await source.fetch(austin);
  assert.ok(snapshot.records.length > 0);
  const record = snapshot.records[0];
  assert.match(record.id, /^alpr:/);
  assert.equal(record.manufacturer, 'Flock Safety');
  assert.equal(record.lastVerified, null);
  assert.ok(record.osmTimestamp);
  assert.equal(snapshot.stale, false);
  assert.equal('elements' in snapshot, false);
  const fetched = calls.length;
  await source.fetch(austin);
  assert.equal(calls.length, fetched);
  assert.ok(calls.every((url) => !url.includes('overpass')));
  assert.doesNotMatch(JSON.stringify(source.attribution), /flock/i);
});

test('outside extract coverage is an explicit no-data state without Overpass', async () => {
  const source = createOverpassAlprSource({
    fetchImpl: () => assert.fail('no network expected in Europe'),
  });
  assert.deepEqual(
    await source.fetch({ south: 51, north: 51.1, west: 0, east: 0.1 }),
    { records: [], stale: false, saturated: false, noCoverage: true },
  );
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
  await assert.rejects(source.fetch(box), /unavailable/);
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

test('wide detail view returns zoom guidance before any fetch and can retry a smaller view', async () => {
  let calls = 0;
  const source = createOverpassAlprSource({
    fetchImpl: async () => {
      calls++;
      return Response.json({
        tiles: ['https://tiles.dontgetflocked.com/{z}/{x}/{y}.pbf'],
        bounds: [-180, 17, -50, 84],
      });
    },
  });
  const wide = await source.fetch({
    south: 30,
    north: 31,
    west: -98,
    east: -97,
  });
  assert.equal(wide.zoomIn, true);
  assert.equal(calls, 0);
  await source
    .fetch({ south: 30.267, north: 30.268, west: -97.744, east: -97.743 })
    .catch(() => {});
  assert.ok(calls > 0);
});
