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
    catalog: createLayerCatalog(layers, metadata(layers)),
    defer: (release) => releases.push(release),
    onData: (manager) => {
      observed = manager;
    },
  });
  assert.equal(observed, dataManager);
  assert.deepEqual(attached, [['one', 'two']]);
  assert.deepEqual([...dataManager.layers.keys()], ['one', 'two']);
  assert.throws(() => dataManager.register({ id: 'late' }), /finalized/);
  for (const release of releases.reverse()) await release();
  assert.equal(dataManager.layers.size, 0);
});

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
  ];
  const layers = ids.map((id) => ({ id }));
  const catalog = createLayerCatalog(layers, metadata(layers));
  const services = catalogControlServices(catalog);
  assert.equal(services.flightsLayer, layers[1]);
  assert.equal(services.transitLayer, layers[7]);
  assert.equal(services.aisLiveVesselsLayer, layers[8]);
  assert.equal(new Set(Object.values(services)).size, layers.length);
  assert.throws(
    () => catalogControlServices(createLayerCatalog([], [])),
    /Control layer missing/,
  );
});
