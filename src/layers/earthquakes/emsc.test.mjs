import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEarthquakeSnapshots, normalizeEmscSnapshot } from './records.js';
import {
  createEarthquakeSource,
  createEmscEarthquakeSource,
  emscQueryUrl,
} from './source.js';

function emscFeature(overrides = {}) {
  return {
    type: 'Feature',
    id: '20261002_0000123',
    geometry: { type: 'Point', coordinates: [16.5, 69.1, -10] },
    properties: {
      time: '2026-10-02T12:00:00.0Z',
      flynn_region: 'NORTHERN NORWAY',
      lat: 69.1,
      lon: 16.5,
      depth: 10,
      evtype: 'ke',
      auth: 'BER',
      mag: 3,
      magtype: 'ml',
      unid: '20261002_0000123',
      ...overrides,
    },
  };
}

test('EMSC features normalize to the USGS row shape', () => {
  const [row] = normalizeEmscSnapshot({ features: [emscFeature()] });
  assert.deepEqual(row, {
    stableId: 'emsc:20261002_0000123',
    usgsId: null,
    emscId: '20261002_0000123',
    lon: 16.5,
    lat: 69.1,
    depthKm: 10,
    mag: 3,
    place: 'Northern Norway',
    time: Date.parse('2026-10-02T12:00:00Z'),
  });
});

test('EMSC keeps M2.5+ earthquakes and drops blasts and small events', () => {
  const rows = normalizeEmscSnapshot({
    features: [
      emscFeature(),
      emscFeature({ unid: 'blast', evtype: 'qb' }),
      emscFeature({ unid: 'explosion', evtype: 'ex' }),
      emscFeature({ unid: 'small', mag: 2.4 }),
      emscFeature({ unid: 'untyped', evtype: '' }),
      emscFeature({ unid: 'induced', evtype: 'ki' }),
    ],
  });
  assert.deepEqual(
    rows.map((row) => row.emscId),
    ['20261002_0000123', 'untyped', 'induced'],
  );
  assert.equal(
    normalizeEmscSnapshot({
      features: [emscFeature({ flynn_region: 'Svalbard Region' })],
    })[0].place,
    'Svalbard Region',
    'mixed-case region names are kept',
  );
});

test('a malformed EMSC feed is rejected as a whole', () => {
  assert.equal(normalizeEmscSnapshot({}), null);
  assert.equal(
    normalizeEmscSnapshot({ features: [emscFeature({ lat: 'north' })] }),
    null,
  );
  assert.equal(
    normalizeEmscSnapshot({ features: [emscFeature(), emscFeature()] }),
    null,
    'duplicate ids',
  );
});

test('EMSC events USGS already reports are dropped as duplicates', () => {
  const usgs = {
    stableId: 'us7000abcd',
    usgsId: 'us7000abcd',
    lon: 22.3,
    lat: 40.06,
    mag: 4.6,
    time: Date.parse('2026-10-11T17:30:03Z'),
  };
  const [sameEvent] = normalizeEmscSnapshot({
    features: [
      emscFeature({
        unid: 'same',
        lon: 22.45,
        lat: 40.1,
        mag: 4.5,
        time: '2026-10-11T17:30:30Z',
      }),
    ],
  });
  const [otherEvent] = normalizeEmscSnapshot({
    features: [emscFeature({ unid: 'other' })],
  });
  // Nearly the same epicentre with a minutes-late origin time (seen live in
  // West Texas: 2 km and 235 s apart) is still the same event.
  const [lateTime] = normalizeEmscSnapshot({
    features: [
      emscFeature({
        unid: 'late-time',
        lon: 22.32,
        lat: 40.07,
        time: new Date(usgs.time + 235_000).toISOString(),
      }),
    ],
  });
  const [laterEvent] = normalizeEmscSnapshot({
    features: [
      emscFeature({
        unid: 'later',
        lon: 22.3,
        lat: 40.06,
        time: new Date(usgs.time + 301_000).toISOString(),
      }),
    ],
  });
  const [fartherLate] = normalizeEmscSnapshot({
    features: [
      emscFeature({
        unid: 'farther-late',
        lon: 22.8,
        lat: 40.06,
        time: new Date(usgs.time + 120_000).toISOString(),
      }),
    ],
  });
  assert.deepEqual(
    mergeEarthquakeSnapshots(
      [usgs],
      [sameEvent, lateTime, otherEvent, laterEvent, fartherLate],
    ).map((row) => row.stableId),
    ['us7000abcd', 'emsc:other', 'emsc:later', 'emsc:farther-late'],
  );
});

test('the EMSC query asks for M2.5+ over the previous 24 hours', () => {
  const url = new URL(emscQueryUrl(Date.parse('2026-10-11T12:00:00Z')));
  assert.equal(url.origin, 'https://www.seismicportal.eu');
  assert.equal(url.searchParams.get('format'), 'json');
  assert.equal(url.searchParams.get('minmag'), '2.5');
  assert.equal(url.searchParams.get('starttime'), '2026-10-10T12:00:00');
});

test('the EMSC source reads and validates its feed', async () => {
  const source = createEmscEarthquakeSource({
    now: () => Date.parse('2026-10-11T12:00:00Z'),
    fetchImpl: async () => Response.json({ features: [emscFeature()] }),
  });
  assert.equal((await source.getSnapshot()).length, 1);
  const broken = createEmscEarthquakeSource({
    fetchImpl: async () => new Response('down', { status: 503 }),
  });
  await assert.rejects(broken.getSnapshot(), /EMSC HTTP 503/);
});

test('either catalog alone still yields a snapshot; both failing is an error', async () => {
  const ok = (rows) => ({ getSnapshot: async () => rows });
  const fail = (message) => ({
    getSnapshot: async () => {
      throw new Error(message);
    },
  });
  const usgsRow = { stableId: 'us1', lon: 0, lat: 0, mag: 3, time: 0 };
  const emscRow = { stableId: 'emsc:1', lon: 50, lat: 50, mag: 3, time: 0 };
  const both = createEarthquakeSource({
    usgs: ok([usgsRow]),
    emsc: ok([emscRow]),
  });
  assert.equal((await both.getSnapshot()).length, 2);
  const usgsOnly = createEarthquakeSource({
    usgs: ok([usgsRow]),
    emsc: fail('EMSC HTTP 503'),
  });
  assert.deepEqual(await usgsOnly.getSnapshot(), [usgsRow]);
  const emscOnly = createEarthquakeSource({
    usgs: fail('USGS HTTP 503'),
    emsc: ok([emscRow]),
  });
  assert.deepEqual(await emscOnly.getSnapshot(), [emscRow]);
  const neither = createEarthquakeSource({
    usgs: fail('USGS HTTP 503'),
    emsc: fail('EMSC HTTP 503'),
  });
  await assert.rejects(neither.getSnapshot(), /USGS HTTP 503/);
});
