import test from 'node:test';
import assert from 'node:assert/strict';
import { LayerLifecycle } from '../data/lifecycle.js';
import { createDataLibrary } from './controller.js';
import { LIBRARY_ENTRIES, LIBRARY_LEDGER } from './catalog.js';
import { validateLibraryCatalog } from './manifest.js';
import { LIBRARY_STORAGE_KEY } from './selection.js';

const base = {
  family: 'imagery',
  provider: 'Fixture',
  description: 'Fixture entry.',
  maintainer: 'test',
  coverage: { global: true },
  licence: { name: 'Public domain', url: 'https://example.org/licence' },
  attribution: { text: 'Fixture' },
  status: 'community',
};
const tiles = (id) => ({
  ...base,
  id,
  kind: 'tiles',
  title: id,
  source: {
    format: 'xyz',
    url: 'https://tiles.example.org/{z}/{x}/{y}.png',
    fetch: 'browser-direct',
  },
});
const { entries } = validateLibraryCatalog([
  tiles('night-lights'),
  tiles('sea-marks'),
  {
    ...base,
    id: 'fixture-pack',
    kind: 'pack',
    family: 'cameras',
    title: 'Pack',
    source: { format: 'host', url: 'https://cams.example.org/' },
    pack: { host: 'cctv', env: 'CCTV_FIXTURE_ENABLED' },
    licence: { ...base.licence, operatorOptIn: true },
  },
]);
const ledger = [
  ['night-lights', '00'],
  ['sea-marks', '01'],
];

function sealedManager(t) {
  const manager = new LayerLifecycle({});
  manager.finalizeRegistrations([]);
  // Enabled layers arm refresh timers; release them with the test.
  t.after(() => manager.destroyAll());
  return manager;
}

function memoryStorage(initial) {
  const store = new Map(initial ? [[LIBRARY_STORAGE_KEY, initial]] : []);
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => store.set(key, value),
  };
}

const source = (availability) => ({
  async getAvailability() {
    return {
      server: true,
      availability: new Map(
        entries.map(({ id }) => [
          id,
          availability[id] ?? { available: true, reason: null },
        ]),
      ),
    };
  },
  async loadDataset() {
    return { features: [], truncated: false };
  },
  tileTemplate: (entry) => entry.source.url,
});

function shareLinkDouble() {
  return {
    encoder: null,
    changes: 0,
    setLibraryParamsEncoder(encoder) {
      this.encoder = encoder;
    },
    onLibraryStateChange() {
      this.changes += 1;
    },
    encode() {
      const params = new URLSearchParams();
      this.encoder?.(params);
      return params.get('lib');
    },
  };
}

test('nothing registers until a viewer adds an entry; add turns it on and persists', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage();
  const shareLink = shareLinkDouble();
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink,
    initialHash: '',
    source: source({}),
  });
  await library.start();
  assert.equal(manager.layers.size, 0);
  assert.equal(await library.add('night-lights'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), true);
  assert.equal(manager.getAll()[0].libraryEntryId, 'night-lights');
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)), {
    added: ['night-lights'],
    on: ['night-lights'],
  });
  assert.equal(shareLink.encode(), '00');
  await manager.setEnabled('lib-night-lights', false, { origin: 'user' });
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).on, []);
  assert.equal(shareLink.encode(), null);
  assert.equal(await library.remove('night-lights'), true);
  assert.equal(manager.layers.has('lib-night-lights'), false);
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)), {
    added: [],
    on: [],
  });
});

test('packs and unavailable entries cannot be added', async (t) => {
  const manager = sealedManager(t);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    initialHash: '',
    source: source({
      'sea-marks': { available: false, reason: 'operator-opt-in' },
    }),
  });
  await library.start();
  assert.equal(await library.add('fixture-pack'), false);
  assert.equal(await library.add('sea-marks'), false);
  assert.equal(manager.layers.size, 0);
  const row = library.list().find(({ entry }) => entry.id === 'sea-marks');
  assert.deepEqual(
    { available: row.available, reason: row.reason, added: row.added },
    { available: false, reason: 'operator-opt-in', added: false },
  );
});

test('a stored selection restores; a non-explicit change is not remembered', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage(
    JSON.stringify({ added: ['night-lights', 'sea-marks'], on: ['sea-marks'] }),
  );
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    initialHash: '',
    source: source({}),
  });
  await library.start();
  await manager.waitForLayerSettled?.('lib-sea-marks');
  assert.equal(manager.layers.has('lib-night-lights'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  await manager.setEnabled('lib-sea-marks', false, { origin: 'context' });
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).on, [
    'sea-marks',
  ]);
});

test('a link decides what is on and adds its entries to the library', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage(
    JSON.stringify({ added: ['night-lights'], on: ['night-lights'] }),
  );
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    initialHash: '#lat=1&lon=2&lib=01.zz',
    source: source({}),
  });
  await library.start();
  await manager.waitForLayerSettled?.('lib-sea-marks');
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  // The link's entry joins the library; what is remembered as on stays
  // the viewer's own.
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)), {
    added: ['night-lights', 'sea-marks'],
    on: ['night-lights'],
  });
});

test('a share never rewrites what this browser remembers as on', async (t) => {
  const saved = JSON.stringify({
    added: ['night-lights', 'sea-marks'],
    on: ['night-lights'],
  });
  const storage = memoryStorage(saved);
  const manager = sealedManager(t);
  const shareLink = fakeShareLink([]);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink,
    source: source({}),
  });
  await library.start();
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  shareLink.listener(['01']);
  await manager.waitForLayerSettled?.('lib-sea-marks');
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)), {
    added: ['night-lights', 'sea-marks'],
    on: ['night-lights'],
  });
  // An explicit choice is remembered, and only that one.
  await manager.setEnabled('lib-sea-marks', false, { origin: 'user' });
  await manager.setEnabled('lib-night-lights', true, { origin: 'user' });
  await manager.setEnabled('lib-night-lights', false, { origin: 'user' });
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).on, []);
  library.destroy();
});

/** A ShareLinkManager stand-in: the opening share and in-tab navigation. */
function fakeShareLink(initialLibraryTokens) {
  const link = {
    initialLibraryTokens,
    listener: null,
    setLibraryShareListener(listener) {
      link.listener = listener;
    },
    setLibraryParamsEncoder() {},
    onLibraryStateChange() {},
  };
  return link;
}

test('a share with every library entry off keeps the stored ones off', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage(
    JSON.stringify({
      added: ['night-lights', 'sea-marks'],
      on: ['night-lights', 'sea-marks'],
    }),
  );
  // A compact /share/<code> link with no library field, and a long-form link
  // with no lib=: both are shares that switch no library entry on.
  for (const options of [
    { shareLink: fakeShareLink([]) },
    { initialHash: '#lat=1&lon=2&l=' },
  ]) {
    const library = createDataLibrary({
      entries,
      ledger,
      dataManager: manager,
      services: {},
      storage,
      source: source({}),
      ...options,
    });
    await library.start();
    assert.equal(manager.isEnabled('lib-night-lights'), false);
    assert.equal(manager.isEnabled('lib-sea-marks'), false);
    // The recipient's entries stay in their panel, off.
    assert.deepEqual(
      library
        .list()
        .filter((row) => row.added)
        .map((row) => row.entry.id),
      ['night-lights', 'sea-marks'],
    );
    library.destroy();
  }
});

test('the opening share link restores its library tokens', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage(
    JSON.stringify({ added: ['night-lights'], on: ['night-lights'] }),
  );
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink: fakeShareLink(['01']),
    source: source({}),
  });
  await library.start();
  await manager.waitForLayerSettled?.('lib-sea-marks');
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), false);
});

test('navigating between shares switches library entries on and off', async (t) => {
  const manager = sealedManager(t);
  const shareLink = fakeShareLink(['00']);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    shareLink,
    source: source({}),
  });
  // A share navigated to before availability loads waits for it and wins.
  const started = library.start();
  shareLink.listener(['01']);
  await started;
  const settle = () =>
    Promise.all(
      ['lib-night-lights', 'lib-sea-marks'].map((id) =>
        manager.waitForLayerSettled?.(id),
      ),
    );
  await settle();
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  shareLink.listener(['00']);
  await settle();
  assert.equal(manager.isEnabled('lib-night-lights'), true);
  assert.equal(manager.isEnabled('lib-sea-marks'), false);
  shareLink.listener([]);
  await settle();
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  assert.equal(manager.isEnabled('lib-sea-marks'), false);
  library.destroy();
  assert.equal(shareLink.listener, null);
});

test('a share opened while an earlier one is still switching on wins', async (t) => {
  const manager = sealedManager(t);
  const shareLink = fakeShareLink(null);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    shareLink,
    source: source({}),
  });
  await library.start();
  const settle = () =>
    Promise.all(
      ['lib-night-lights', 'lib-sea-marks'].map((id) =>
        manager.waitForLayerSettled?.(id),
      ),
    );
  // Neither share waits for the one before it to settle.
  shareLink.listener(['00']);
  assert.equal(manager.isEnabled('lib-night-lights'), false, 'still enabling');
  shareLink.listener(['01']);
  await settle();
  assert.equal(manager.isEnabled('lib-night-lights'), false);
  assert.equal(manager.isEnabled('lib-sea-marks'), true);
  library.destroy();
});

test('a full library refuses another entry before its layer exists', async (t) => {
  const many = validateLibraryCatalog(
    Array.from({ length: 66 }, (_, index) => tiles(`entry-${index}`)),
  ).entries;
  const manyLedger = many.map(({ id }, index) => [
    id,
    index.toString(36).padStart(2, '0'),
  ]);
  const availability = {
    async getAvailability() {
      return {
        server: true,
        availability: new Map(
          many.map(({ id }) => [id, { available: true, reason: null }]),
        ),
      };
    },
    tileTemplate: (entry) => entry.source.url,
  };
  const full = JSON.stringify({
    added: many.slice(0, 64).map(({ id }) => id),
    on: [],
  });
  const manager = sealedManager(t);
  const library = createDataLibrary({
    entries: many,
    ledger: manyLedger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(full),
    shareLink: fakeShareLink(null),
    source: availability,
  });
  await library.start();
  assert.equal(manager.layers.size, 64);
  assert.equal(await library.add('entry-64'), false);
  assert.equal(manager.layers.size, 64, 'no layer outside the selection');
  library.destroy();
});

test('a share opened into a full library still shows what it shares', async (t) => {
  const many = validateLibraryCatalog(
    Array.from({ length: 67 }, (_, index) => tiles(`entry-${index}`)),
  ).entries;
  const manyLedger = many.map(({ id }, index) => [
    id,
    index.toString(36).padStart(2, '0'),
  ]);
  const availability = {
    async getAvailability() {
      return {
        server: true,
        availability: new Map(
          many.map(({ id }) => [id, { available: true, reason: null }]),
        ),
      };
    },
    tileTemplate: (entry) => entry.source.url,
  };
  const full = JSON.stringify({
    added: many.slice(0, 64).map(({ id }) => id),
    on: ['entry-0'],
  });
  const manager = sealedManager(t);
  const shareLink = {
    ...shareLinkDouble(),
    initialLibraryTokens: [manyLedger[64][1]],
    listener: null,
    setLibraryShareListener(listener) {
      this.listener = listener;
    },
  };
  const library = createDataLibrary({
    entries: many,
    ledger: manyLedger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(full),
    shareLink,
    source: availability,
  });
  await library.start();
  await manager.waitForLayerSettled?.('lib-entry-64');
  assert.equal(manager.isEnabled('lib-entry-64'), true);
  // The oldest entry the share leaves off made room.
  assert.equal(manager.layers.has('lib-entry-0'), false);
  assert.equal(manager.layers.size, 64);
  assert.equal(shareLink.encode(), manyLedger[64][1]);
  // A share navigated to in this tab makes room the same way, and the
  // entry it evicts leaves with its layer.
  shareLink.listener([manyLedger[65][1]]);
  await manager.waitForLayerSettled?.('lib-entry-65');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manager.isEnabled('lib-entry-65'), true);
  assert.equal(manager.layers.has('lib-entry-1'), false);
  assert.equal(manager.layers.size, 64);
  library.destroy();
});

test('entries this instance cannot serve still show as added and can be removed', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage(
    JSON.stringify({ added: ['night-lights'], on: ['night-lights'] }),
  );
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink: fakeShareLink(null),
    source: source({
      'night-lights': { available: false, reason: 'disabled' },
    }),
  });
  await library.start();
  assert.equal(manager.layers.size, 0);
  const row = library.list().find(({ entry }) => entry.id === 'night-lights');
  assert.equal(row.added, true);
  assert.equal(library.summary().added, 1);
  assert.equal(await library.remove('night-lights'), true);
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).added, []);
  library.destroy();
});

test('a layer that fails to tear down stays in the library', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage();
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink: fakeShareLink(null),
    source: source({}),
  });
  await library.start();
  await library.add('night-lights');
  const { module } = manager.layers.get('lib-night-lights');
  const disable = module.disable;
  module.disable = async () => {
    throw new Error('stuck');
  };
  t.mock.method(console, 'warn', () => {});
  try {
    assert.equal(await library.remove('night-lights'), false);
    assert.equal(await library.reset(), 0);
    assert.equal(manager.layers.has('lib-night-lights'), true);
    assert.deepEqual(
      JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).added,
      ['night-lights'],
    );
    assert.equal(
      library.list().find((row) => row.entry.id === 'night-lights').added,
      true,
    );
  } finally {
    // Once it tears down, Remove works (and the manager can shut down).
    module.disable = disable;
  }
  assert.equal(await library.remove('night-lights'), true);
  assert.equal(manager.layers.has('lib-night-lights'), false);
  library.destroy();
});

test('the URL keeps the opening lib= before availability loads and for entries it cannot serve', async (t) => {
  const manager = sealedManager(t);
  const shareLink = shareLinkDouble();
  let answer;
  const pending = new Promise((resolve) => {
    answer = resolve;
  });
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    shareLink,
    initialHash: '#lat=1&lon=2&lib=00.01',
    source: { ...source({}), getAvailability: () => pending },
  });
  const started = library.start();
  // A camera move rewrites the hash before the catalog answers.
  assert.equal(shareLink.encode(), '00.01');
  answer({
    server: false,
    availability: new Map([
      ['night-lights', { available: false, reason: 'server-unavailable' }],
      ['sea-marks', { available: true, reason: null }],
    ]),
  });
  await started;
  await manager.waitForLayerSettled?.('lib-sea-marks');
  assert.equal(manager.layers.has('lib-night-lights'), false);
  assert.equal(shareLink.encode(), '00.01');
  library.destroy();
});

test('a layer switched off before its teardown failed is no longer shared as on', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage();
  const shareLink = shareLinkDouble();
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    shareLink,
    initialHash: '',
    source: source({}),
  });
  await library.start();
  await library.add('night-lights');
  assert.equal(shareLink.encode(), '00');
  const { module } = manager.layers.get('lib-night-lights');
  const destroy = module.destroy;
  module.destroy = async () => {
    throw new Error('stuck');
  };
  t.mock.method(console, 'warn', () => {});
  try {
    assert.equal(await library.remove('night-lights'), false);
    assert.equal(manager.isEnabled('lib-night-lights'), false);
    assert.equal(shareLink.encode(), null);
    const saved = JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY));
    assert.deepEqual(saved, { added: ['night-lights'], on: [] });
  } finally {
    module.destroy = destroy;
  }
  library.destroy();
});

test('zoom flies to an added layer through the caller, reset removes everything', async (t) => {
  const manager = sealedManager(t);
  const storage = memoryStorage();
  const flights = [];
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage,
    initialHash: '',
    source: source({}),
    zoomTo: (extent) => {
      flights.push(extent);
      return true;
    },
  });
  await library.start();
  assert.equal(await library.zoom('night-lights'), false, 'not added yet');
  await library.add('night-lights');
  await library.add('sea-marks');
  const row = library.list().find(({ entry }) => entry.id === 'night-lights');
  assert.equal(row.canZoom, true);
  // Off: zoom switches the layer on, then flies.
  await manager.setEnabled('lib-night-lights', false, { origin: 'user' });
  assert.equal(await library.zoom('night-lights'), true);
  assert.equal(manager.isEnabled('lib-night-lights'), true);
  assert.deepEqual(flights[0], {
    west: -180,
    south: -85,
    east: 180,
    north: 85,
  });
  const chips = manager.layers
    .get('lib-night-lights')
    .module.getRowControls().chips;
  assert.equal(chips[0].id, 'zoom');
  chips[0].onClick();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(flights.length, 2);
  assert.deepEqual(
    chips.map(({ id, icon, action, whileOff }) => [id, icon, action, whileOff]),
    [
      ['zoom', 'zoom_in_map', true, true],
      ['remove', 'delete', true, true],
    ],
  );
  // The row's delete icon removes that entry from the library.
  chips[1].onClick();
  await manager.waitForLayerSettled?.('lib-night-lights');
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (
    let tries = 0;
    manager.layers.has('lib-night-lights') && tries < 50;
    tries++
  )
    await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(manager.layers.has('lib-night-lights'), false);
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)).added, [
    'sea-marks',
  ]);
  assert.equal(await library.reset(), 1);
  assert.equal(manager.layers.size, 0);
  assert.deepEqual(JSON.parse(storage.store.get(LIBRARY_STORAGE_KEY)), {
    added: [],
    on: [],
  });
});

test('without a navigation owner the zoom control is disabled', async (t) => {
  const manager = sealedManager(t);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    initialHash: '',
    source: source({}),
  });
  await library.start();
  await library.add('night-lights');
  assert.equal(await library.zoom('night-lights'), false);
  assert.deepEqual(
    manager.layers
      .get('lib-night-lights')
      .module.getRowControls()
      .chips.map(({ id }) => id),
    ['remove'],
  );
});

test('the summary counts entries by kind, availability and what is added and on', async (t) => {
  const manager = sealedManager(t);
  const library = createDataLibrary({
    entries,
    ledger,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    initialHash: '',
    source: source({
      'sea-marks': { available: false, reason: 'operator-opt-in' },
    }),
  });
  await library.start();
  await library.add('night-lights');
  assert.deepEqual(library.summary(), {
    entries: 3,
    kinds: { dataset: 0, tiles: 2, pack: 1 },
    themes: ['cameras', 'imagery'],
    // The pack is available because the fixture source says so.
    available: 2,
    unavailable: 1,
    added: 1,
    on: 1,
    // Tiles are drapes: no feature count.
    features: 0,
    featureLayers: 0,
  });
});

test('every shipped entry kind registers, view-bounded datasets included', async (t) => {
  const manager = sealedManager(t);
  const library = createDataLibrary({
    entries: LIBRARY_ENTRIES,
    ledger: LIBRARY_LEDGER,
    dataManager: manager,
    services: {},
    storage: memoryStorage(),
    initialHash: '',
    source: {
      async getAvailability() {
        return {
          server: true,
          availability: new Map(
            LIBRARY_ENTRIES.map(({ id }) => [
              id,
              { available: true, reason: null },
            ]),
          ),
        };
      },
      async loadDataset() {
        return { features: [], truncated: false };
      },
      tileTemplate: (entry) => entry.source.url,
    },
  });
  await library.start();
  assert.equal(await library.add('fema-usa-structures'), true);
  const module = manager.layers.get('lib-fema-usa-structures').module;
  // No camera to read: the layer waits for one rather than loading.
  assert.equal(module.getDiagnostics().tooHigh, true);
  assert.equal(await library.add('nasa-black-marble'), true);
});
