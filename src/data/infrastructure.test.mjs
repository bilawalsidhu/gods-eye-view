import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInfrastructureLayers } from 'gods-eye-view/infrastructure';
import { createFakeEngine } from '../globe/testing/fakeEngine.js';

function services() {
  const records = new Map();
  const credited = [];
  let selection;
  return {
    records,
    credited,
    showOsmCredit: (engine) => credited.push(engine),
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
    registerEntityContext(entity, metadata) {
      records.set(metadata.id, { entity, ...metadata });
    },
    selectEntityContext(entity) {
      selection = entity;
    },
    clearSelectedEntityContextForLayer() {
      selection = undefined;
    },
    removeEntityContextsForLayer(id) {
      for (const [key, record] of records)
        if (record.layerId === id) records.delete(key);
    },
    governorRequestRender() {},
    selection: () => selection,
  };
}

test('package exports import without an application, DOM, fetch, or timers', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('unexpected fetch'); };
    globalThis.setTimeout = () => { throw new Error('unexpected timer'); };
    for (const key of ['window', 'document']) {
      delete globalThis[key];
    }
    await import('gods-eye-view/infrastructure');
    await import('gods-eye-view/infrastructure/geojson');
    await import('gods-eye-view/infrastructure/lod');
  `,
    ],
    { cwd: new URL('../..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('infrastructure factory preserves identity and creates independent state without loading', (t) => {
  t.mock.method(globalThis, 'fetch', () => {
    throw new Error('factory must not fetch');
  });
  const first = createInfrastructureLayers(services());
  const second = createInfrastructureLayers(services());
  assert.deepEqual(
    first.map(({ id, name, source }) => ({ id, name, source })),
    [
      { id: 'local-datacenters', name: 'Datacenters', source: 'Local' },
      { id: 'local-dams', name: 'Dams', source: 'USACE' },
    ],
  );
  first.forEach((layer, index) => {
    assert.notEqual(layer, second[index]);
    layer.destroy();
    assert.deepEqual(second[index].getStats(), {
      count: 0,
      lastUpdate: null,
      error: null,
    });
    second[index].destroy();
  });
});

test('dataset URLs still name the complete bundled sources', () => {
  for (const [file, count] of [
    ['datacenters', 4352],
    ['dams', 704],
  ]) {
    const lines = readFileSync(
      new URL(`./local_data/${file}/${file}.geojsonl`, import.meta.url),
      'utf8',
    )
      .split('\n')
      .filter((line) => line.trim());
    assert.equal(lines.length, count);
  }
});

test('two engines use their supplied contexts and dispose independently', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: async () =>
      JSON.stringify({
        type: 'Feature',
        id: 'same-id',
        properties: { name: 'Dam' },
        geometry: {
          type: 'Polygon',
          coordinates: [
            [
              [0, 0],
              [0.01, 0],
              [0, 0.01],
              [0, 0],
            ],
          ],
        },
      }),
  }));
  const hosts = [services(), services()];
  const instances = hosts.map((host) => {
    const engine = createFakeEngine();
    const [, layer] = createInfrastructureLayers(host);
    layer.init(null, { engine });
    return { layer, engine };
  });
  t.after(() =>
    instances.forEach(({ layer, engine }) => {
      layer.destroy();
      engine.destroy();
    }),
  );
  await Promise.all(instances.map(({ layer }) => layer.enable()));
  assert.equal(hosts[0].records.size, 1);
  assert.deepEqual(
    hosts.map((host) => host.credited),
    instances.map(({ engine }) => [engine]),
  );
  assert.equal(hosts[1].records.size, 1);
  // A click on the first engine's footprint selects only its own record.
  const { engine } = instances[0];
  engine.camera.flyTo = () => {};
  engine.fake.script('pick', {
    id: 'local-dams:same-id',
    owner: 'local-dams-footprints',
    instance: 0,
  });
  engine.fake.input('click', { position: { x: 1, y: 1 } });
  assert.ok(hosts[0].selection());
  assert.equal(hosts[1].selection(), undefined);
  instances[0].layer.destroy();
  assert.equal(hosts[0].records.size, 0);
  assert.equal(hosts[1].records.size, 1);
  assert.equal(instances[1].engine.ground.list().length, 2);
});

test('consumer build includes only infrastructure code and engine-free geometry, and resolves assets under a non-root base', async () => {
  const { build } = await import('vite');
  const { fileURLToPath } = await import('node:url');
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    base: '/example/',
    build: {
      write: false,
      assetsInlineLimit: 0,
      rollupOptions: {
        input: fileURLToPath(
          import.meta.resolve('gods-eye-view/infrastructure'),
        ),
        external: ['cesium'],
        preserveEntrySignatures: 'strict',
      },
    },
  });
  const output = result.output;
  const entry = output.find((item) => item.type === 'chunk' && item.isEntry);
  const sources = Object.keys(entry.modules)
    .filter((id) => id.endsWith('.js'))
    .map((id) => id.slice(id.lastIndexOf('/src/') + 1));
  assert.deepEqual(sources.sort(), [
    'src/data/infrastructure.js',
    'src/data/infrastructureOverlayEntry.js',
    'src/data/localGeojsonCore.js',
    'src/data/localGeojsonLod.js',
    ...[
      'boundingSphere',
      'cartesian2',
      'cartesian3',
      'cartographic',
      'ellipsoid',
      'ellipsoidGeodesic',
      'julianDate',
      'math',
      'matrix4',
      'quaternion',
      'scaleToGeodeticSurface',
      'simon1994',
    ].map((name) => `src/geo/${name}.js`),
    'src/globe/surfaceDetail.js',
    'src/globe/surfacePlacement.js',
    'src/layers/infrastructure/index.js',
    'src/layers/infrastructure/render/display.js',
    'src/layers/shared/color.js',
    'src/overlays/bindOverlayHost.js',
    'src/sources/infrastructureData.js',
    'src/sources/requestDeadline.js',
  ]);
  assert.deepEqual(
    entry.imports,
    [],
    'the layers draw through the engine they are given',
  );
  for (const name of ['datacenters', 'dams']) {
    const asset = output.find(
      (item) => item.type === 'asset' && item.fileName.includes(name),
    );
    assert.ok(asset, `${name} must be emitted`);
    assert.ok(
      entry.code.includes(`/example/${asset.fileName}`),
      `${name} must retain the consumer base path`,
    );
  }
});
