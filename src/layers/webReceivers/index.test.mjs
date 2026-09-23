import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as picking from '../../data/pickRegistry.js';
import { createWebReceiversLayer } from './index.js';

const KIWI = {
  id: 'aaaaaaaaaaaa',
  type: 'kiwisdr',
  name: 'Kiwi Arvika',
  site: 'Arvika',
  url: 'http://sa4bna.hopto.org:8073/',
  lat: 59.546,
  lon: 12.526,
  bands: [{ lowHz: 0, highHz: 30_000_000, label: '0–30 MHz' }],
  users: 3,
  usersMax: 8,
  online: true,
  antenna: 'beverage',
  sources: ['kiwisdr'],
};
const OWRX = {
  id: 'cccccccccccc',
  type: 'openwebrx',
  name: 'OWRX Berlin 2m/70cm',
  site: 'Berlin',
  url: 'http://thomas0177.ddns.net:8073/',
  lat: 52.41876,
  lon: 13.30633,
  bands: [{ lowHz: 144e6, highHz: 148e6, label: '2 m' }],
  users: null,
  usersMax: null,
  online: null,
  antenna: '',
  sources: ['receiverbook'],
};
const BAD = { id: 'nope', type: 'kiwisdr', name: 'x', url: 'http://x/' };

function catalog(rows, extra = {}) {
  return {
    receivers: rows,
    updatedAt: '2026-09-23T10:00:00.000Z',
    stale: false,
    degraded: false,
    sources: { receiverbook: { ok: true }, kiwisdr: { ok: true } },
    ...extra,
  };
}

function viewerDouble() {
  const flights = [];
  return {
    flights,
    entities: new Cesium.EntityCollection(),
    dataSources: new Cesium.DataSourceCollection(),
    scene: {
      canvas: {
        addEventListener() {},
        removeEventListener() {},
        disableRootEvents: true,
      },
      pick: () => undefined,
    },
    camera: {
      flyTo: (options) => flights.push({ kind: 'flyTo', ...options }),
      flyToBoundingSphere: (sphere, options) =>
        flights.push({ kind: 'frame', sphere, ...options }),
    },
  };
}

/** Cesium's data-source collection settles its add() on a later tick. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * The pick handler wants a document and a window even with root events
 * disabled; give it inert ones for the duration of a test.
 */
function withBrowserGlobals(t) {
  const prior = { document: globalThis.document, window: globalThis.window };
  const inert = { addEventListener() {}, removeEventListener() {} };
  globalThis.document = prior.document || inert;
  globalThis.window = prior.window || inert;
  t.after(() => {
    globalThis.document = prior.document;
    globalThis.window = prior.window;
  });
}

function build({ rows = [KIWI, OWRX, BAD] } = {}) {
  const renders = [];
  const source = {
    async getCatalog() {
      return catalog(rows);
    },
  };
  const layer = createWebReceiversLayer({
    source,
    services: {
      picking,
      render: { governorRequestRender: (reason) => renders.push(reason) },
      ground: { cachedGroundFloor: () => 0 },
    },
  });
  return { layer, source, renders };
}

test('construction validates its services and source', () => {
  assert.throws(
    () => createWebReceiversLayer({ services: {}, source: {} }),
    TypeError,
  );
  assert.throws(
    () =>
      createWebReceiversLayer({
        services: { picking, render: {}, ground: {} },
        source: {},
      }),
    /catalog operation/,
  );
});

test('the layer accepts a catalog, filters, finds, tunes and tears down', async (t) => {
  withBrowserGlobals(t);
  const { layer, renders } = build();
  const viewer = viewerDouble();
  const states = [];
  const unsubscribe = layer.subscribe((state) => states.push(state));
  assert.equal(layer.id, 'web-receivers');
  layer.init(viewer);
  await settle();
  assert.equal(viewer.dataSources.length, 1);
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().count, 2, 'the malformed row is dropped');
  assert.equal(viewer.dataSources.get(0).entities.values.length, 2);
  const state = layer.getUIState();
  assert.equal(state.receiverCount, 2);
  assert.equal(state.filteredCount, 2);
  assert.equal(state.updatedAt, '2026-09-23T10:00:00.000Z');
  assert.equal(state.presentationActive, true);
  assert.deepEqual(
    state.filters.bands.map((entry) => entry.id),
    ['all', 'lf-mw', 'hf', 'vhf', 'uhf'],
  );

  layer.setFilter({ band: 'vhf' });
  assert.equal(layer.getUIState().filteredCount, 1);
  layer.setFilter({ band: 'all', type: 'bogus' });
  assert.deepEqual(layer.getUIState().filter, { type: 'all', band: 'all' });

  const rows = layer.find({ lat: 52.52, lon: 13.4, hz: 14_233_000 });
  assert.deepEqual(
    rows.map((row) => row.receiver.id),
    ['aaaaaaaaaaaa', 'cccccccccccc'],
    'the covering receiver ranks first even though it is farther',
  );
  assert.deepEqual(layer.getUIState().highlightedIds, [
    'aaaaaaaaaaaa',
    'cccccccccccc',
  ]);
  assert.equal(layer.getUIState().lastSearch.hz, 14_233_000);

  const tuned = layer.tune({
    receiverId: 'AAAAAAAAAAAA',
    hz: 14_233_000,
    mode: 'usb',
  });
  assert.equal(tuned.url, 'http://sa4bna.hopto.org:8073/?f=14233usbz10');
  assert.equal(tuned.covers, true);
  assert.equal(layer.getUIState().selected.id, 'aaaaaaaaaaaa');
  assert.equal(layer.getUIState().lastTune.kind, 'tune');
  assert.equal(layer.getUIState().selectedBands, '0–30 MHz');
  assert.equal(layer.tune({ receiverId: 'missing', hz: 1e6 }).ok, false);
  assert.equal(layer.tune({ receiverId: 'aaaaaaaaaaaa', hz: 0 }).ok, false);

  const spectrum = layer.showSpectrum({
    receiverId: 'aaaaaaaaaaaa',
    lowHz: 10_000_000,
    highHz: 15_000_000,
  });
  assert.equal(spectrum.muted, true);
  assert.equal(layer.getUIState().lastTune.kind, 'spectrum');
  assert.equal(
    layer.showSpectrum({ receiverId: 'aaaaaaaaaaaa', lowHz: 2, highHz: 1 }).ok,
    false,
  );

  assert.equal(layer.resolveReceiver('berlin owrx').id, 'cccccccccccc');
  assert.equal(layer.resolveReceiver('nothing here'), null);
  assert.equal(
    layer.selectReceiver('cccccccccccc', { flyTo: true }).id,
    'cccccccccccc',
  );
  assert.equal(viewer.flights.at(-1).kind, 'flyTo');
  assert.equal(viewer.entities.values.length, 1, 'one selection entity');
  assert.equal(layer.frame(['aaaaaaaaaaaa', 'cccccccccccc']), true);
  assert.equal(viewer.flights.at(-1).kind, 'frame');
  assert.equal(layer.frame(['missing']), false);

  layer.disable();
  assert.equal(viewer.dataSources.get(0).show, false);
  assert.equal(viewer.entities.values.length, 0);
  assert.equal(
    layer.getUIState().selected.id,
    'cccccccccccc',
    'the selection survives disable',
  );
  layer.destroy();
  assert.equal(viewer.dataSources.length, 0);
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getUIState().selected, null);
  unsubscribe();
  assert.ok(states.length > 3);
  assert.ok(renders.includes('web-receivers-reconcile'));
});

test('the manager lifecycle gate hides markers until the layer is settled enabled', async (t) => {
  withBrowserGlobals(t);
  const { layer } = build();
  const viewer = viewerDouble();
  layer.init(viewer);
  await settle();
  layer.setLifecyclePresentation({
    lifecycleState: 'enabling',
    enabled: false,
  });
  layer.enable();
  await layer.update();
  assert.equal(viewer.dataSources.get(0).show, false);
  assert.equal(layer.getUIState().presentationActive, false);
  layer.setLifecyclePresentation({ lifecycleState: 'enabled', enabled: true });
  assert.equal(viewer.dataSources.get(0).show, true);
  assert.equal(layer.getUIState().presentationActive, true);
  layer.setLifecyclePresentation({
    lifecycleState: 'enabled',
    enabled: true,
    uncertain: true,
  });
  assert.equal(viewer.dataSources.get(0).show, false);
  layer.destroy();
});

test('a failed refresh keeps the previous catalog and reports the outage', async (t) => {
  withBrowserGlobals(t);
  const { layer, source } = build();
  layer.init(viewerDouble());
  layer.enable();
  await layer.update();
  assert.equal(layer.getStats().count, 2);
  source.getCatalog = async () => {
    throw new Error('directory down');
  };
  await layer.update();
  const stats = layer.getStats();
  assert.equal(stats.count, 2);
  assert.equal(stats.error, 'directory down');
  assert.equal(stats.degraded, true);
  assert.equal(stats.loading, false);
  layer.destroy();
});

test('a cold failure reports without receivers and ensureLoaded retries later', async (t) => {
  withBrowserGlobals(t);
  const { layer, source } = build();
  let attempts = 0;
  source.getCatalog = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error('cold');
    return catalog([KIWI]);
  };
  layer.init(viewerDouble());
  layer.enable();
  assert.deepEqual(await layer.ensureLoaded(), []);
  assert.equal(layer.getStats().error, 'cold');
  assert.equal(layer.getStats().degraded, false);
  assert.equal((await layer.ensureLoaded()).length, 1);
  assert.equal(attempts, 2);
  assert.equal(layer.getStats().error, null);
  layer.destroy();
});

test('disabling while a request is in flight discards its result', async (t) => {
  withBrowserGlobals(t);
  const { layer, source } = build();
  let resolveCatalog;
  source.getCatalog = () =>
    new Promise((resolve) => {
      resolveCatalog = resolve;
    });
  layer.init(viewerDouble());
  layer.enable();
  const pending = layer.update();
  assert.equal(layer.getStats().loading, true);
  layer.disable();
  resolveCatalog(catalog([KIWI, OWRX]));
  await pending;
  assert.equal(layer.getStats().count, 0);
  assert.equal(layer.getStats().loading, false);
  layer.destroy();
});
