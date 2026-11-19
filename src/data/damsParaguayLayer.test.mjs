// Regression: both dams added by #1152 must reach the Dams layer itself —
// a stem/label (selection context) and a voice analyst record — not only
// the find_infrastructure query source.
// Place at src/data/damsParaguayLayer.test.mjs and run:
//   node --test src/data/damsParaguayLayer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { localGeoJsonServices } from '../app/localGeojsonServices.js';
import { createLocalGeoJsonLayer } from './localGeojsonCore.js';

const ADDED = new Map([
  [262532166, 'Acaray'],
  [-5671745, 'Represa Yacyretá-Apipé'],
]);

const features = readFileSync(
  new URL('./local_data/dams/dams.geojsonl', import.meta.url),
  'utf8',
)
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
  .filter((feature) => ADDED.has(feature.id));

const quietEvent = () => ({ addEventListener: () => () => {} });

test('Acaray and Yacyretá each get a layer stem, selection context and analyst record', async () => {
  assert.equal(features.length, 2, 'both added features are bundled');
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  globalThis.window = { dispatchEvent() {} };
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => features.map((f) => JSON.stringify(f)).join('\n'),
  });
  const contexts = [];
  const overlayHost = { setVisible() {}, setEntries() {}, clearSource() {} };
  const viewer = {
    selectedEntity: undefined,
    dataSources: { add: (dataSource) => dataSource, remove: () => true },
    camera: {
      positionWC: Cesium.Cartesian3.fromDegrees(-55.5, -26.5, 900_000),
      frustum: { fov: Math.PI / 3 },
      moveEnd: quietEvent(),
      flyTo() {},
    },
    scene: {
      canvas: { clientWidth: 800, clientHeight: 600 },
      preRender: quietEvent(),
      sampleHeightSupported: false,
      sampleHeight: () => undefined,
      screenSpaceCameraController: { enableInputs: true },
      pick: () => null,
      requestRender() {},
    },
  };
  const layer = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      url: '/dams.geojsonl',
      name: 'Dams',
      color: '#0088ff',
      projectToWindow: () => ({ x: 400, y: 300 }),
      screenSpaceEventHandlerFactory: () => ({
        setInputAction() {},
        destroy() {},
      }),
    },
    {
      ...localGeoJsonServices,
      overlayHost,
      registerEntityContext: (entity, context) => contexts.push(context),
    },
  );
  try {
    await layer.enable(viewer);
    assert.equal(layer.getStats().count, 2);
    const expected = [...ADDED.values()].sort();
    assert.deepEqual(
      contexts.map((context) => context.label).sort(),
      expected,
      'each added dam registers a selection context (stem, label, card)',
    );
    const rows = layer.getAnalystRecords();
    assert.deepEqual(
      rows.map((row) => row.name).sort(),
      expected,
      'each added dam is visible to voice analyst_query',
    );
    for (const row of rows)
      assert.ok(Number.isFinite(row.lat) && Number.isFinite(row.lon));
  } finally {
    layer.destroy(viewer);
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
