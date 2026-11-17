import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePort, filterPorts, createPortsSource } from './source.js';
import { createPortsLayer } from './index.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';

const feature = (id = 1, props = {}, xy = [55, 25]) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: xy },
  properties: {
    objectid: id,
    wpinumber: id,
    main_port_name: `Port ${id}`,
    wpi_cc: 'Example',
    fac_container: 'Yes',
    fac_lngterm: 'Unknown',
    fac_oilterm: 'No',
    ...props,
  },
});
const collection = (features, more = false) => ({
  type: 'FeatureCollection',
  features,
  properties: { exceededTransferLimit: more },
});
const metadata = {
  name: 'World Port Index',
  objectIdField: 'objectid',
  advancedQueryCapabilities: {
    supportsPagination: true,
    supportsOrderBy: true,
  },
  editingInfo: { lastEditDate: 42 },
};
const response = (value, status = 200) =>
  new Response(JSON.stringify(value), { status });

test('WPI identity, nullable capabilities, invalid coordinates and missing geometry', () => {
  const row = normalizePort(feature(48276, { unlocode: 'AE JEA' }));
  assert.equal(row.id, '48276');
  assert.equal(row.unlocode, 'AEJEA');
  assert.deepEqual(row.facilities, {
    container: true,
    bulk: null,
    oil: false,
    lng: null,
  });
  assert.equal(row.facts.throughput.period, '2024');
  assert.equal(row.facts.capacity.value, '19,400,000 TEU/year');
  assert.equal(row.facts.status, undefined);
  for (const invalid of [
    null,
    {},
    { properties: {} },
    feature(1, {}, [181, 0]),
    feature(1, {}, [0, 91]),
    feature(1, {}, ['55', 25]),
    feature(-1),
  ])
    assert.equal(normalizePort(invalid), null);
});

test('country and affirmative facility filters combine; unknown is never a negative claim', () => {
  const rows = [
    normalizePort(feature()),
    normalizePort(feature(2, { wpi_cc: 'Other', fac_container: 'Unknown' })),
  ];
  assert.equal(filterPorts(rows).length, 2);
  assert.equal(filterPorts(rows, { facility: 'lng' }).length, 0);
  assert.equal(
    filterPorts(rows, { country: 'Example', facility: 'container' }).length,
    1,
  );
});

test('paged acquisition, metadata date, bounds, complete cache and cancellation', async () => {
  const urls = [];
  let clock = 100;
  const source = createPortsSource({
    now: () => clock,
    fetchImpl: async (url) => {
      urls.push(String(url));
      if (!String(url).includes('/query')) return response(metadata);
      const offset = new URL(url).searchParams.get('resultOffset');
      return response(
        offset === '0'
          ? collection([feature()], true)
          : collection([feature(2)]),
      );
    },
  });
  const a = await source.getSnapshot();
  assert.equal(a.rows.length, 2);
  assert.equal(a.sourceUpdatedAt, 42);
  assert.equal(new URL(urls[2]).searchParams.get('resultOffset'), '1');
  assert.equal(await source.getSnapshot(), a);
  assert.equal(urls.length, 3);
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(source.getSnapshot({ signal: aborted.signal }), {
    name: 'AbortError',
  });
  clock += 86400001;
  await source.getSnapshot();
  assert.equal(urls.length, 6);
});

test('reject service errors, malformed/empty pages, oversized body and repeated pages', async () => {
  for (const value of [
    { error: { message: 'private upstream error' } },
    {},
    collection([]),
  ]) {
    const source = createPortsSource({
      fetchImpl: async (url) =>
        response(String(url).includes('/query') ? value : metadata),
    });
    await assert.rejects(source.getSnapshot());
  }
  const source = createPortsSource({
    fetchImpl: async () =>
      new Response('x', { headers: { 'Content-Length': 5000000 } }),
  });
  await assert.rejects(source.getSnapshot(), { code: 'RESPONSE_TOO_LARGE' });
  const repeated = createPortsSource({
    fetchImpl: async (url) =>
      response(
        String(url).includes('/query')
          ? collection([feature()], true)
          : metadata,
      ),
  });
  await assert.rejects(repeated.getSnapshot(), /did not advance/);
});

test('partial data is labelled and not cached as a complete snapshot', async () => {
  let calls = 0;
  const source = createPortsSource({
    fetchImpl: async (url) => {
      calls++;
      return response(
        String(url).includes('/query')
          ? collection([feature(), feature(-1, { objectid: 2 })])
          : metadata,
      );
    },
  });
  const a = await source.getSnapshot();
  assert.equal(a.partial, true);
  assert.equal(a.rejected, 1);
  await source.getSnapshot();
  assert.equal(calls, 4);
});

test('layer selection, filtering, retained-data errors and disable/destroy lifecycle', async () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  let click,
    view,
    fail = false,
    unsubscriptions = 0;
  const rows = [
    normalizePort(feature(48276)),
    normalizePort(feature(2, { wpi_cc: 'Other' })),
  ];
  const layer = createPortsLayer({
    source: {
      getSnapshot: async () => {
        if (fail) throw new Error('offline');
        return { rows, fetchedAt: Date.now() };
      },
    },
    publish: (next) => {
      view = next;
    },
    input: () => ({
      onClick: (fn) => {
        click = fn;
        return () => {
          unsubscriptions++;
        };
      },
    }),
  });
  layer.init(viewer);
  layer.enable();
  await layer.update();
  const set = draw.find('ports:');
  assert.equal(set.items.size, 2);
  click({ drawHit: { set: set.spec.id, id: 'port:48276' } });
  assert.equal(view.selected.id, '48276');
  layer.setParams({ country: 'Other' });
  assert.equal(set.items.size, 1);
  assert.equal(view.selected, null);
  assert.equal(layer.setParams({ facility: 'arbitrary' }), false);
  fail = true;
  await layer.update();
  assert.equal(layer.getStats().error, 'offline');
  assert.equal(set.items.size, 1);
  layer.disable();
  assert.equal(view, null);
  assert.equal(set.show, false);
  assert.equal(layer.getAnalystRecords().length, 0);
  assert.equal(unsubscriptions, 1);
  layer.destroy();
  assert.equal(set.disposed, true);
  unbind();
});

test('late source results after disable cannot redraw or publish', async () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  let resolve, view;
  const layer = createPortsLayer({
    source: {
      getSnapshot: () =>
        new Promise((r) => {
          resolve = r;
        }),
    },
    input: () => null,
    publish: (next) => {
      view = next;
    },
  });
  layer.init(viewer);
  layer.enable();
  const pending = layer.update();
  layer.disable();
  resolve({ rows: [normalizePort(feature())], fetchedAt: Date.now() });
  await pending;
  assert.equal(view, null);
  assert.equal(draw.find('ports:').items.size, 0);
  layer.destroy();
  unbind();
});

test('DOE-shaped 3,824 records yield 3,820 valid unique ports with explicit exclusions', async () => {
  const features = Array.from({ length: 3824 }, (_, i) => feature(i + 1));
  features[3111].properties.wpinumber = 49454.5;
  features[3727].properties.wpinumber = 9510.1;
  features[3114].properties.wpinumber = 101;
  features[3364].properties.wpinumber = 201;
  const requests = [];
  const source = createPortsSource({
    fetchImpl: async (input) => {
      const url = new URL(input);
      if (!url.pathname.endsWith('/query')) return response(metadata);
      requests.push(url);
      const offset = Number(url.searchParams.get('resultOffset'));
      return response(
        collection(features.slice(offset, offset + 1000), offset < 3000),
      );
    },
  });
  const snapshot = await source.getSnapshot();
  assert.equal(snapshot.rows.length, 3820);
  assert.equal(snapshot.received, 3824);
  assert.equal(snapshot.rejected, 2);
  assert.equal(snapshot.duplicates, 2);
  assert.equal(snapshot.partial, true);
  assert.deepEqual(
    requests.map((u) => u.searchParams.get('resultOffset')),
    ['0', '1000', '2000', '3000'],
  );
  assert.ok(
    requests.every((u) => u.searchParams.get('orderByFields') === 'objectid'),
  );
});

test('validate metadata, page size and page budget; never publish an incomplete global fetch', async () => {
  const invalidMetadata = [
    {},
    { ...metadata, name: 'Other layer' },
    { ...metadata, advancedQueryCapabilities: {} },
  ];
  for (const meta of invalidMetadata) {
    await assert.rejects(
      createPortsSource({
        fetchImpl: async () => response(meta),
      }).getSnapshot(),
      /metadata/,
    );
  }
  await assert.rejects(
    createPortsSource({
      fetchImpl: async () => response({}, 503),
    }).getSnapshot(),
    /HTTP 503/,
  );
  await assert.rejects(
    createPortsSource({
      fetchImpl: async (url) =>
        response(
          String(url).includes('/query')
            ? collection(Array.from({ length: 1001 }, (_, i) => feature(i + 1)))
            : metadata,
        ),
    }).getSnapshot(),
    /Invalid port reference response/,
  );
  let pages = 0;
  await assert.rejects(
    createPortsSource({
      fetchImpl: async (url) =>
        response(
          String(url).includes('/query')
            ? collection([feature(++pages)], true)
            : metadata,
        ),
    }).getSnapshot(),
    /record limit/,
  );
  assert.equal(pages, 6);
});

test('unknown facility variants and depth fields never become affirmative capabilities', () => {
  for (const value of [null, undefined, '', 'Unknown', 'U', 'Y', 1]) {
    const row = normalizePort(
      feature(1, { fac_container: value, lng_terminal_depth: 30 }),
    );
    assert.equal(row.facilities.container, null);
    assert.equal(filterPorts([row], { facility: 'container' }).length, 0);
    assert.equal(row.facilities.lng, null);
  }
  assert.equal(
    normalizePort(feature(1, { fac_container: ' YES ' })).facilities.container,
    true,
  );
});

test('late results after destroy and superseded requests cannot redraw or publish', async () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  const resolves = [];
  let view;
  const layer = createPortsLayer({
    source: {
      getSnapshot: () => new Promise((resolve) => resolves.push(resolve)),
    },
    input: () => null,
    publish: (next) => {
      view = next;
    },
  });
  layer.init(viewer);
  layer.enable();
  const older = layer.update();
  const newer = layer.update();
  resolves[0]({ rows: [normalizePort(feature(1))] });
  await older;
  assert.equal(draw.find('ports:').items.size, 0);
  const set = draw.find('ports:');
  layer.destroy();
  resolves[1]({ rows: [normalizePort(feature(2))] });
  await newer;
  assert.equal(view, null);
  assert.equal(set.disposed, true);
  unbind();
});
