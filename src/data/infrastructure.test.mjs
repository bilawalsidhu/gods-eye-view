import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import { createInfrastructureLayers } from 'gods-eye-view/infrastructure';
import { createLocalGeoJsonLayer } from 'gods-eye-view/infrastructure/geojson';

function services() {
  const records = new Map();
  let selection;
  return {
    records,
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
    ['datacenters', 4351],
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

test('two viewers use their supplied contexts and dispose independently', async (t) => {
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
    const sources = new Cesium.DataSourceCollection();
    let click;
    const layer = createLocalGeoJsonLayer(
      {
        id: 'local-dams',
        name: 'Dams',
        color: '#0088ff',
        url: '/dams.geojsonl',
        screenSpaceEventHandlerFactory: () => ({
          setInputAction(fn) {
            click = fn;
          },
          destroy() {},
        }),
      },
      host,
    );
    const viewer = {
      dataSources: sources,
      scene: {
        canvas: {},
        preRender: new Cesium.Event(),
        requestRender() {},
        screenSpaceCameraController: { enableInputs: true },
        pick: () => ({ id: sources.get(0).entities.values[0] }),
      },
      camera: { moveEnd: new Cesium.Event(), flyTo() {} },
    };
    return { layer, viewer, click: () => click({ position: {} }) };
  });
  t.after(() =>
    instances.forEach(({ layer, viewer }) => layer.destroy(viewer)),
  );
  await Promise.all(instances.map(({ layer, viewer }) => layer.enable(viewer)));
  assert.equal(hosts[0].records.size, 1);
  assert.equal(hosts[1].records.size, 1);
  instances[0].click();
  assert.ok(hosts[0].selection());
  assert.equal(hosts[1].selection(), undefined);
  instances[0].layer.destroy(instances[0].viewer);
  assert.equal(hosts[0].records.size, 0);
  assert.equal(hosts[1].records.size, 1);
  assert.equal(instances[1].viewer.dataSources.length, 1);
});

test('consumer build includes only infrastructure code and resolves assets under a non-root base', async () => {
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
  const sources = Object.keys(entry.modules).filter((id) => id.endsWith('.js'));
  assert.deepEqual(sources.map((id) => id.split('/').at(-1)).sort(), [
    'infrastructure.js',
    'localGeojsonCore.js',
    'localGeojsonLod.js',
  ]);
  assert.deepEqual(
    entry.imports,
    ['cesium'],
    'the viewer supplies the same Cesium dependency',
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
