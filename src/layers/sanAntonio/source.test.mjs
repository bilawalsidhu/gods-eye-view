import test from 'node:test';
import assert from 'node:assert/strict';
import { createSanAntonioSource, SAN_ANTONIO_SOURCE_LIMITS } from './source.js';
import { SAN_ANTONIO_DATASETS, SAN_ANTONIO_CACHE_TTL_MS } from './config.js';
import { normalizeSanAntonioSnapshot } from './records.js';

const parks = SAN_ANTONIO_DATASETS[0];
const updated = Date.parse('2025-01-23T16:50:08.029Z');
const fetched = Date.parse('2026-10-11T12:00:00Z');
const ring = [
  [-98.5, 29.4],
  [-98.49, 29.4],
  [-98.49, 29.41],
  [-98.5, 29.4],
];

function layerMetadata(dataset = parks, overrides = {}) {
  return {
    objectIdField: 'OBJECTID',
    geometryType: dataset.geometryType,
    maxRecordCount: 2,
    advancedQueryCapabilities: {
      supportsPagination: true,
      supportsOrderBy: true,
    },
    fields: dataset.fields.map((name) => ({
      name,
      type: name === 'OBJECTID' ? 'esriFieldTypeOID' : 'esriFieldTypeString',
    })),
    editingInfo: {
      dataLastEditDate: updated,
      schemaLastEditDate: fetched,
      lastEditDate: fetched,
    },
    ...overrides,
  };
}

function rawFeature(id, dataset = parks) {
  const type = dataset.geometryTypes[0];
  return {
    type: 'Feature',
    id,
    properties: {
      OBJECTID: id,
      ...(dataset === parks
        ? { ParkName: `Park ${id}` }
        : { Name: `Site ${id}` }),
      unwanted: 'must not leave acquisition',
    },
    geometry: {
      type,
      coordinates:
        type === 'Polygon' ? [ring] : type === 'LineString' ? ring : ring[0],
    },
  };
}

function collection(features, more) {
  return {
    type: 'FeatureCollection',
    features,
    ...(more === undefined
      ? {}
      : { properties: { exceededTransferLimit: more } }),
  };
}

function harness({ ids = [1, 3, 7], onRequest, ...sourceOptions } = {}) {
  const calls = [];
  const fetchImpl = async (input, options) => {
    const url = new URL(input);
    const dataset = SAN_ANTONIO_DATASETS.find((entry) =>
      url.href.startsWith(entry.serviceUrl),
    );
    assert.ok(dataset, 'only the three configured services may be requested');
    const kind = !url.pathname.endsWith('/query')
      ? 'metadata'
      : url.searchParams.get('returnCountOnly') === 'true'
        ? 'count'
        : 'page';
    const call = { url, options, dataset, kind };
    calls.push(call);
    const override = await onRequest?.(call, calls);
    if (override !== undefined) return override;
    if (kind === 'metadata') return Response.json(layerMetadata(dataset));
    if (kind === 'count') return Response.json({ count: ids.length });
    const offset = Number(url.searchParams.get('resultOffset'));
    const size = Number(url.searchParams.get('resultRecordCount'));
    return Response.json(
      collection(
        ids.slice(offset, offset + size).map((id) => rawFeature(id, dataset)),
        offset + size < ids.length,
      ),
    );
  };
  return {
    source: createSanAntonioSource({
      fetchImpl,
      now: () => fetched,
      ...sourceOptions,
    }),
    calls,
    fetchImpl,
  };
}

test('source is lazy, fixed to City endpoints, and pages by declared OBJECTID order', async () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  const result = await h.source.getSnapshot({ datasetId: parks.id });
  assert.deepEqual(
    result.features.map((f) => f.properties.OBJECTID),
    [1, 3, 7],
  );
  assert.equal(result.sourceCount, 3);
  assert.equal(result.sourceUpdatedAt, updated);
  assert.equal(result.fetchedAt, fetched);
  assert.equal(result.features[0].properties.unwanted, undefined);
  const pages = h.calls.filter((call) => call.kind === 'page');
  assert.deepEqual(
    pages.map((call) => call.url.searchParams.get('resultOffset')),
    ['0', '2'],
  );
  for (const { url, options } of pages) {
    assert.equal(url.searchParams.get('outFields'), parks.fields.join(','));
    assert.equal(url.searchParams.get('outSR'), '4326');
    assert.equal(url.searchParams.get('returnGeometry'), 'true');
    assert.equal(url.searchParams.get('returnM'), 'false');
    assert.equal(url.searchParams.get('returnZ'), 'false');
    assert.equal(url.searchParams.get('orderByFields'), 'OBJECTID ASC');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
  }
  assert.equal(h.calls.filter((call) => call.kind === 'count').length, 2);
  assert.equal(h.calls.filter((call) => call.kind === 'metadata').length, 2);
});

test('each dataset requests its own safe fields and accepts its geometry family', async () => {
  const h = harness({ ids: [1] });
  for (const dataset of SAN_ANTONIO_DATASETS) {
    const result = await h.source.getSnapshot({ datasetId: dataset.id });
    assert.equal(result.features[0].geometry.type, dataset.geometryTypes[0]);
    assert.ok(
      Object.keys(result.features[0].properties).every((key) =>
        dataset.fields.includes(key),
      ),
    );
    const call = h.calls.find(
      (call) => call.kind === 'page' && call.dataset === dataset,
    );
    assert.equal(
      call.url.searchParams.get('outFields'),
      dataset.fields.join(','),
    );
  }
});

test('cache is isolated per factory and dataset, expires at six hours, and resists caller mutation', async () => {
  let time = fetched;
  const h = harness({ now: () => time });
  const first = await h.source.getSnapshot({ datasetId: parks.id });
  first.features[0].properties.ParkName = 'changed by consumer';
  first.features[0].geometry.coordinates[0][0][0] = 0;
  const second = await h.source.getSnapshot({ datasetId: parks.id });
  assert.equal(h.calls.length, 6);
  assert.equal(second.features[0].properties.ParkName, 'Park 1');
  assert.equal(second.features[0].geometry.coordinates[0][0][0], -98.5);
  for (const dataset of SAN_ANTONIO_DATASETS.slice(1))
    await h.source.getSnapshot({ datasetId: dataset.id });
  const allLoaded = h.calls.length;
  for (const dataset of SAN_ANTONIO_DATASETS)
    await h.source.getSnapshot({ datasetId: dataset.id });
  assert.equal(h.calls.length, allLoaded);
  time += SAN_ANTONIO_CACHE_TTL_MS - 1;
  await h.source.getSnapshot({ datasetId: parks.id });
  assert.equal(h.calls.length, allLoaded);
  time++;
  await h.source.getSnapshot({ datasetId: parks.id });
  assert.equal(h.calls.length, allLoaded + 6);
  const separate = createSanAntonioSource({
    fetchImpl: h.fetchImpl,
    now: () => time,
  });
  await separate.getSnapshot({ datasetId: parks.id });
  assert.equal(h.calls.length, allLoaded + 12);
});

test('a verified zero count is empty success and missing data date stays unknown', async () => {
  const h = harness({
    ids: [],
    onRequest: ({ kind, dataset }) =>
      kind === 'metadata'
        ? Response.json(
            layerMetadata(dataset, {
              editingInfo: {
                lastEditDate: fetched,
                schemaLastEditDate: fetched,
              },
            }),
          )
        : undefined,
  });
  const result = await h.source.getSnapshot({ datasetId: parks.id });
  assert.deepEqual(result.features, []);
  assert.equal(result.sourceCount, 0);
  assert.equal(result.sourceUpdatedAt, null);
  assert.equal(h.calls.filter((call) => call.kind === 'page').length, 0);
});

test('missing, malformed and excessive live counts cannot become empty/complete snapshots', async () => {
  for (const payload of [
    {},
    { count: null },
    { count: -1 },
    { count: 1.5 },
    { count: '3' },
    { count: 10_001 },
  ]) {
    const h = harness({
      onRequest: ({ kind }) =>
        kind === 'count' ? Response.json(payload) : undefined,
    });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      /count|record limit/i,
    );
    assert.equal(h.calls.filter((call) => call.kind === 'page').length, 0);
  }
});

test('schema drift is rejected before feature acquisition', async () => {
  for (const overrides of [
    { objectIdField: 'FID' },
    { geometryType: 'esriGeometryPoint' },
    { maxRecordCount: 0 },
    { fields: [{ name: 'OBJECTID', type: 'esriFieldTypeOID' }] },
    {
      advancedQueryCapabilities: {
        supportsPagination: false,
        supportsOrderBy: true,
      },
    },
    {
      advancedQueryCapabilities: {
        supportsPagination: true,
        supportsOrderBy: false,
      },
    },
    { editingInfo: { dataLastEditDate: '2026-01-01' } },
  ]) {
    const h = harness({
      onRequest: ({ kind }) =>
        kind === 'metadata'
          ? Response.json(layerMetadata(parks, overrides))
          : undefined,
    });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      /Invalid San Antonio/,
    );
    assert.equal(h.calls.length, 1);
  }
});

test('malformed pages and features fail without poisoning the cache', async () => {
  const badPages = [
    {},
    { features: [] },
    { type: 'FeatureCollection', features: {} },
    collection([rawFeature(1), rawFeature(2), rawFeature(3)]),
    collection([{ ...rawFeature(1), type: 'Point' }]),
    collection([{ ...rawFeature(1), properties: null }]),
    collection([{ ...rawFeature(1), properties: { OBJECTID: '1' } }]),
    collection([{ ...rawFeature(1), geometry: undefined }]),
    collection([
      {
        ...rawFeature(1),
        geometry: { type: 'Point', coordinates: [-98.5, 29.4] },
      },
    ]),
    collection([rawFeature(1)], 'true'),
  ];
  for (const page of badPages) {
    let fail = true;
    const h = harness({
      onRequest: ({ kind }) =>
        fail && kind === 'page' ? Response.json(page) : undefined,
    });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      /Invalid San Antonio/,
    );
    fail = false;
    const result = await h.source.getSnapshot({ datasetId: parks.id });
    assert.equal(result.sourceCount, 3);
    assert.equal(result.features.length, 3);
  }
});

test('valid null geometry survives acquisition and is counted as skipped by the normalizer', async () => {
  const h = harness({
    onRequest: ({ kind, url }) => {
      if (kind !== 'page' || url.searchParams.get('resultOffset') !== '0')
        return;
      return Response.json(
        collection([{ ...rawFeature(1), geometry: null }, rawFeature(3)], true),
      );
    },
  });
  const snapshot = await h.source.getSnapshot({ datasetId: parks.id });
  assert.equal(snapshot.sourceCount, 3);
  assert.equal(snapshot.features.length, 3);
  assert.equal(snapshot.features[0].geometry, null);
  assert.deepEqual(
    snapshot.features.map((feature) => feature.properties.OBJECTID),
    [1, 3, 7],
  );
  const normalized = normalizeSanAntonioSnapshot(snapshot, parks);
  assert.equal(normalized.sourceCount, 3);
  assert.equal(normalized.skippedCount, 1);
  assert.deepEqual(
    normalized.records.map((record) => record.objectId),
    [3, 7],
  );
  assert.equal(normalized.sourceUpdatedAt, updated);
  const requests = h.calls.length;
  const cached = await h.source.getSnapshot({ datasetId: parks.id });
  assert.equal(cached.features[0].geometry, null);
  assert.equal(h.calls.length, requests);
});

test('duplicate, out-of-order, stalled and prematurely ended pages are rejected', async () => {
  const cases = [
    { ids: [1, 3, 3], error: /duplicate OBJECTID/ },
    { ids: [3, 1, 7], error: /ordering/ },
    { page: collection([]), error: /stalled/ },
    { page: collection([rawFeature(1)], false), error: /contradicts/ },
    { ids: [1], page: collection([rawFeature(1)], true), error: /contradicts/ },
  ];
  for (const entry of cases) {
    const h = harness({
      ids: entry.ids,
      onRequest: ({ kind }) =>
        kind === 'page' && entry.page ? Response.json(entry.page) : undefined,
    });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      entry.error,
    );
  }
});

test('short pages without flags keep paging to the count, within the page budget', async () => {
  const shortPage = ({ kind, url }) => {
    if (kind !== 'page') return;
    return Response.json(
      collection([
        rawFeature(Number(url.searchParams.get('resultOffset')) + 1),
      ]),
    );
  };
  const h = harness({ onRequest: shortPage });
  assert.equal(
    (await h.source.getSnapshot({ datasetId: parks.id })).features.length,
    3,
  );
  assert.deepEqual(
    h.calls
      .filter((call) => call.kind === 'page')
      .map((call) => call.url.searchParams.get('resultOffset')),
    ['0', '1', '2'],
  );
  const bounded = harness({ onRequest: shortPage, maxPages: 2 });
  await assert.rejects(
    bounded.source.getSnapshot({ datasetId: parks.id }),
    /page limit/,
  );
  assert.equal(bounded.calls.filter((call) => call.kind === 'page').length, 2);
});

test('a changing count or data timestamp rejects the whole acquisition', async () => {
  for (const kind of ['count', 'metadata']) {
    let occurrences = 0;
    let fail = true;
    const h = harness({
      onRequest: (call) => {
        if (call.kind !== kind || !fail) return;
        if (++occurrences !== 2) return;
        return Response.json(
          kind === 'count'
            ? { count: 4 }
            : layerMetadata(parks, {
                editingInfo: { dataLastEditDate: updated + 1 },
              }),
        );
      },
    });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      /changed during acquisition/,
    );
    fail = false;
    assert.equal(
      (await h.source.getSnapshot({ datasetId: parks.id })).features.length,
      3,
    );
  }
});

test('HTTP failures, HTTP-200 ArcGIS errors and invalid JSON surface instead of empty data', async () => {
  for (const [response, message] of [
    [new Response('down', { status: 503 }), /HTTP 503/],
    [
      Response.json({ error: { code: 499, message: 'Token Required' } }),
      /ArcGIS error 499/,
    ],
    [new Response('<html>service error</html>'), /malformed JSON/],
  ]) {
    const h = harness({ onRequest: () => response });
    await assert.rejects(
      h.source.getSnapshot({ datasetId: parks.id }),
      message,
    );
  }
});

test('per-response declared/streamed byte caps and aggregate byte caps apply before caching', async () => {
  for (const declared of [true, false]) {
    let cancelled = false;
    const h = harness({
      maxResponseBytes: 1_024,
      onRequest: ({ kind }) => {
        if (kind !== 'page') return;
        const body = new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(2_048));
          },
          cancel() {
            cancelled = true;
          },
        });
        return new Response(body, {
          headers: declared ? { 'content-length': '2048' } : {},
        });
      },
    });
    await assert.rejects(h.source.getSnapshot({ datasetId: parks.id }), {
      code: 'RESPONSE_TOO_LARGE',
    });
    assert.equal(cancelled, true);
  }
  const size = (value) =>
    new TextEncoder().encode(JSON.stringify(value)).length;
  const budget =
    size(layerMetadata()) +
    size({ count: 1 }) +
    size(collection([rawFeature(1)], false)) +
    5;
  const total = harness({ ids: [1], maxTotalBytes: budget });
  await assert.rejects(total.source.getSnapshot({ datasetId: parks.id }), {
    code: 'RESPONSE_TOO_LARGE',
  });
});

test('expired successful data are not served after a failed refresh', async () => {
  let time = fetched;
  let fail = false;
  const h = harness({
    now: () => time,
    onRequest: () => (fail ? new Response('down', { status: 503 }) : undefined),
  });
  await h.source.getSnapshot({ datasetId: parks.id });
  time += SAN_ANTONIO_CACHE_TTL_MS;
  fail = true;
  await assert.rejects(
    h.source.getSnapshot({ datasetId: parks.id }),
    /HTTP 503/,
  );
  const calls = h.calls.length;
  await assert.rejects(
    h.source.getSnapshot({ datasetId: parks.id }),
    /HTTP 503/,
  );
  assert.equal(h.calls.length, calls + 1);
  fail = false;
  assert.equal(
    (await h.source.getSnapshot({ datasetId: parks.id })).fetchedAt,
    time,
  );
});

test('pre-abort takes precedence even over a cached result; unknown datasets never fetch', async () => {
  const h = harness();
  await assert.rejects(
    h.source.getSnapshot({ datasetId: parks.id, signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  await assert.rejects(
    h.source.getSnapshot({ datasetId: 'https://example.invalid' }),
    /Unknown San Antonio dataset/,
  );
  assert.equal(h.calls.length, 0);
  await h.source.getSnapshot({ datasetId: parks.id });
  const calls = h.calls.length;
  await assert.rejects(
    h.source.getSnapshot({ datasetId: parks.id, signal: AbortSignal.abort() }),
    { name: 'AbortError' },
  );
  assert.equal(h.calls.length, calls);
});

test('caller cancellation settles even an uncooperative fetch and does not cache failure', async () => {
  const abort = new AbortController();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let fail = true;
  const h = harness({
    onRequest: () => {
      if (!fail) return;
      entered();
      return new Promise(() => {});
    },
  });
  const pending = h.source.getSnapshot({
    datasetId: parks.id,
    signal: abort.signal,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  abort.abort();
  await rejected;
  fail = false;
  assert.equal(
    (await h.source.getSnapshot({ datasetId: parks.id })).features.length,
    3,
  );
});

test('body cancellation stops a streamed page and retains no partial snapshot', async () => {
  const abort = new AbortController();
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  let cancelled = false;
  let fail = true;
  const h = harness({
    onRequest: ({ kind }) => {
      if (kind !== 'page' || !fail) return;
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{'));
            entered();
          },
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const pending = h.source.getSnapshot({
    datasetId: parks.id,
    signal: abort.signal,
  });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready;
  // Let acquisition take ownership of the response reader before cancelling.
  await new Promise((resolve) => setImmediate(resolve));
  abort.abort();
  await rejected;
  assert.equal(cancelled, true);
  fail = false;
  assert.equal(
    (await h.source.getSnapshot({ datasetId: parks.id })).features.length,
    3,
  );
});

test('whole-acquisition deadline is a failure distinct from caller cancellation', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const source = createSanAntonioSource({
    timeoutMs: 10,
    fetchImpl: async () => {
      entered();
      return new Promise(() => {});
    },
  });
  const pending = source.getSnapshot({ datasetId: parks.id });
  const rejected = assert.rejects(pending, {
    name: 'TimeoutError',
    message: 'San Antonio request timed out',
  });
  await ready;
  t.mock.timers.tick(11);
  await rejected;
  const h = harness({ timeoutMs: 10 });
  await h.source.getSnapshot({ datasetId: parks.id });
  t.mock.timers.tick(11);
  assert.ok(
    h.calls.every((call) => !call.options.signal.aborted),
    'successful requests dispose their deadline',
  );
});

test('record/page ceilings and invalid limit overrides are enforced', async () => {
  for (const [name, maximum] of Object.entries(SAN_ANTONIO_SOURCE_LIMITS)) {
    assert.throws(
      () => createSanAntonioSource({ [name]: maximum + 1 }),
      /Invalid San Antonio source limit/,
    );
    assert.throws(
      () => createSanAntonioSource({ [name]: 0 }),
      /Invalid San Antonio source limit/,
    );
  }
  const h = harness({ maxPages: 1 });
  await assert.rejects(
    h.source.getSnapshot({ datasetId: parks.id }),
    /page limit/,
  );
  assert.equal(h.calls.filter((call) => call.kind === 'page').length, 0);
});
