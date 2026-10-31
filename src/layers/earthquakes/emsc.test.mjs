import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeEarthquakeSnapshots, normalizeEmscSnapshot } from './records.js';
import {
  EMSC_PAGE_SIZE,
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
        mag: 4.4,
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

test('an EMSC event of a clearly different magnitude is its own event', () => {
  const time = Date.parse('2026-10-11T17:30:00Z');
  const usgs = { stableId: 'us1', lon: -98, lat: 36, mag: 5, time };
  const near = (unid, mag, km) =>
    normalizeEmscSnapshot({
      features: [
        emscFeature({
          unid,
          mag,
          lon: -98,
          lat: 36 + km / 111.2,
          time: new Date(time + 60_000).toISOString(),
        }),
      ],
    })[0];
  assert.deepEqual(
    mergeEarthquakeSnapshots(
      [usgs],
      [
        near('aftershock', 3, 50),
        near('larger', 6.5, 100),
        near('same', 4.6, 50),
      ],
    ).map((row) => row.stableId),
    ['us1', 'emsc:aftershock', 'emsc:larger'],
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

test('the EMSC source reads further pages while a page is full', async () => {
  const offsets = [];
  const page = (count, from) =>
    Array.from({ length: count }, (_, index) =>
      emscFeature({ unid: `e${from + index}` }),
    );
  const source = createEmscEarthquakeSource({
    now: () => Date.parse('2026-10-11T12:00:00Z'),
    fetchImpl: async (url) => {
      const offset = new URL(url).searchParams.get('offset');
      offsets.push(offset);
      // A new event arrived between the pages: e1999 repeats on page two.
      return Response.json({
        features: offset
          ? page(3, EMSC_PAGE_SIZE - 1)
          : page(EMSC_PAGE_SIZE, 0),
      });
    },
  });
  const rows = await source.getSnapshot();
  assert.deepEqual(offsets, [null, String(EMSC_PAGE_SIZE + 1)]);
  assert.equal(rows.length, EMSC_PAGE_SIZE + 2);
});

test('an empty page (204) ends the EMSC paging without losing rows', async () => {
  const page = (count) =>
    Array.from({ length: count }, (_, index) =>
      emscFeature({ unid: `e${index}` }),
    );
  const source = createEmscEarthquakeSource({
    now: () => Date.parse('2026-10-11T12:00:00Z'),
    // Exactly one full page, then nothing: FDSN's 204 with no body.
    fetchImpl: async (url) =>
      new URL(url).searchParams.get('offset')
        ? new Response(null, { status: 204 })
        : Response.json({ features: page(EMSC_PAGE_SIZE) }),
  });
  assert.equal((await source.getSnapshot()).length, EMSC_PAGE_SIZE);
  const none = createEmscEarthquakeSource({
    fetchImpl: async () => new Response(null, { status: 204 }),
  });
  assert.deepEqual(await none.getSnapshot(), []);
});

test('a stalled EMSC gives up and leaves the USGS snapshot', async () => {
  const usgsRow = { stableId: 'us1', lon: 0, lat: 0, mag: 3, time: 0 };
  const stalled = createEmscEarthquakeSource({
    timeoutMs: 20,
    fetchImpl: (url, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason)),
      ),
  });
  await assert.rejects(stalled.getSnapshot(), /EMSC request timed out/);
  const source = createEarthquakeSource({
    usgs: { getSnapshot: async () => [usgsRow] },
    emsc: stalled,
  });
  assert.deepEqual(await source.getSnapshot(), [usgsRow]);
  // The caller's own abort still wins over the timeout.
  const controller = new AbortController();
  controller.abort(new Error('replaced'));
  await assert.rejects(
    stalled.getSnapshot({ signal: controller.signal }),
    /replaced/,
  );
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
