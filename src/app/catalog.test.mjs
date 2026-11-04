import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayerCatalog, catalogControlServices } from './catalog.js';
import { createApplicationData } from './data.js';

const metadata = (layers) =>
  layers.map(({ id }) => ({ id, disposition: 'enabled-only' }));

test('catalog captures membership and metadata while preserving the supplied instances', () => {
  const first = { id: 'first' };
  const layers = [first];
  const schema = metadata(layers);
  const catalog = createLayerCatalog(layers, schema);
  layers.push({ id: 'later' });
  schema[0].disposition = 'invalid';
  assert.deepEqual(catalog.layers, [first]);
  assert.equal(catalog.get('first'), first);
  assert.equal(catalog.get('later'), undefined);
  assert.equal(catalog.metadata[0].disposition, 'enabled-only');
  assert.throws(() => catalog.layers.push({ id: 'later' }), TypeError);
});

test('duplicate, missing and extra metadata fail before application registration', () => {
  const layers = [{ id: 'first' }];
  assert.throws(
    () => createLayerCatalog([...layers, ...layers], metadata(layers)),
    /duplicate/,
  );
  assert.throws(() => createLayerCatalog(layers, []), /incomplete/);
  assert.throws(
    () => createLayerCatalog(layers, metadata([{ id: 'other' }])),
    /Unmatched/,
  );
  assert.throws(
    () =>
      createLayerCatalog(layers, [...metadata(layers), ...metadata(layers)]),
    /duplicate/,
  );
});

test('data setup seals the caller catalog before controls can restore and drains its exact instances', async (t) => {
  const previous = globalThis.document;
  globalThis.document = { getElementById: () => null };
  t.after(() => {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const attached = [];
  const layers = [
    {
      id: 'one',
      attachDataManager: (manager) => attached.push([...manager.layers.keys()]),
    },
    { id: 'two' },
  ];
  const releases = [];
  let observed;
  const { dataManager } = createApplicationData({
    scene: { viewer: {} },
    controls: {
      styleManager: {
        attachDataManager(manager) {
          assert.equal(manager.registrationsFinalized, true);
          assert.equal(manager.layers.get('one').module, layers[0]);
        },
      },
    },
    catalog: {
      ...createLayerCatalog(layers, metadata(layers)),
      getSourceAvailability: (id) =>
        id === 'one'
          ? {
              available: false,
              reason: 'One: data source not configured',
            }
          : undefined,
    },
    defer: (release) => releases.push(release),
    onData: (manager) => {
      observed = manager;
    },
  });
  assert.equal(observed, dataManager);
  assert.equal(await dataManager.setEnabled('one', true), false);
  assert.equal(dataManager.layers.get('one').initialized, false);
  assert.equal(
    dataManager.getAll().find(({ id }) => id === 'one').stats.error,
    'One: data source not configured',
  );
  assert.deepEqual(attached, [['one', 'two']]);
  assert.deepEqual([...dataManager.layers.keys()], ['one', 'two']);
  assert.throws(() => dataManager.register({ id: 'late' }), /finalized/);
  for (const release of releases.reverse()) await release();
  assert.equal(dataManager.layers.size, 0);
});

test('data setup keeps layers polling in an inline panel its host reports hidden', async (t) => {
  const previous = globalThis.document;
  globalThis.document = {
    hidden: true,
    visibilityState: 'hidden',
    getElementById: () => null,
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    delete globalThis.GEV_EMBED_INLINE;
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  });
  const releases = [];
  const { dataManager } = createApplicationData({
    scene: { viewer: {} },
    controls: { styleManager: { attachDataManager() {} } },
    catalog: createLayerCatalog([], []),
    defer: (release) => releases.push(release),
  });
  const visibility = dataManager._visibilityTarget;
  assert.equal(visibility.hidden, true, 'a hidden page pauses outside a panel');
  globalThis.GEV_EMBED_INLINE = true;
  assert.equal(visibility.hidden, false);
  assert.equal(visibility.visibilityState, 'visible');
  for (const release of releases.reverse()) await release();
});

for (const inline of [false, true]) {
  test(`layer opacity is restored from the address and ${inline ? 'never written to an inline host' : 'kept in the address'}`, async (t) => {
    const saved = {
      document: globalThis.document,
      location: globalThis.location,
      history: globalThis.history,
    };
    const location = {
      href: 'https://gev.example/app/?lop=dimmable:40,plain:20',
    };
    const writes = [];
    globalThis.document = { getElementById: () => null };
    globalThis.location = location;
    globalThis.history = {
      state: null,
      replaceState(_state, _title, url) {
        writes.push(url);
        location.href = url;
      },
    };
    if (inline) globalThis.GEV_EMBED_INLINE = true;
    t.after(() => {
      delete globalThis.GEV_EMBED_INLINE;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    });
    const told = [];
    const layers = [
      { id: 'dimmable', setOpacity: (value) => told.push(value) },
      { id: 'plain' },
    ];
    const releases = [];
    const { opacity } = createApplicationData({
      scene: { viewer: {} },
      controls: { styleManager: { attachDataManager() {} } },
      catalog: createLayerCatalog(layers, metadata(layers)),
      defer: (release) => releases.push(release),
    });
    // The address is read once the registry is sealed; a layer without the
    // hook is ignored.
    assert.deepEqual(told, [0.4]);
    assert.equal(opacity.get('plain'), 1);
    opacity.set('dimmable', 0.7);
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (inline) assert.deepEqual(writes, []);
    else assert.deepEqual(writes, ['https://gev.example/app/?lop=dimmable:70']);
    for (const release of releases.reverse()) await release();
    assert.equal(opacity.supports('dimmable'), false, 'released with the app');
  });
}

test('controls bind catalog instances rather than similarly named defaults', () => {
  const ids = [
    'traffic',
    'flights',
    'military',
    'satellites',
    'cctv',
    'radio',
    'bikeshare',
    'transit',
    'ais-live-vessels',
    'military-awareness',
    'military-installations',
    'rocket-launches',
    'street-level',
    'local-adsb',
    'wildlife-sightings',
  ];
  const layers = ids.map((id) => ({ id }));
  const catalog = createLayerCatalog(layers, metadata(layers));
  const services = catalogControlServices(catalog);
  assert.equal(services.flightsLayer, layers[1]);
  assert.equal(services.transitLayer, layers[7]);
  assert.equal(services.aisLiveVesselsLayer, layers[8]);
  assert.equal(services.localAdsbLayer, layers[13]);
  assert.equal(services.wildlifeSightingsLayer, layers[14]);
  assert.equal(new Set(Object.values(services)).size, layers.length);
  assert.throws(
    () => catalogControlServices(createLayerCatalog([], [])),
    /Control layer missing/,
  );
});
