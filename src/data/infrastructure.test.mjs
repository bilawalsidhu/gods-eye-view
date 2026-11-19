import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInfrastructureLayers } from 'gods-eye-view/infrastructure';
import { createLocalGeoJsonLayer } from 'gods-eye-view/infrastructure/geojson';
import { fakeInput } from '../input/testDoubles.mjs';
import { bindFakeGroundRenderer } from '../testSupport/fakeGroundRenderer.mjs';
import { parseGeojsonLines } from '../sources/infrastructureData.js';

function services() {
  const records = new Map();
  const credited = [];
  let selection;
  return {
    records,
    credited,
    showOsmCredit: (viewer) => credited.push(viewer),
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

// Added from the OSM API, not the OpenInfraMap extract: [id, name, OSM
// object, version]. Both must stay polygons: the Dams layer skips
// LineStrings.
const OSM_API_DAMS = [
  [262532166, 'Acaray', 'way/262532166', 7],
  [-5671745, 'Represa Yacyretá-Apipé', 'relation/5671745', 2],
];
const DAMS = parseGeojsonLines(
  readFileSync(
    new URL('./local_data/dams/dams.geojsonl', import.meta.url),
    'utf8',
  ),
);

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
      {
        id: 'local-dams',
        name: 'Dams',
        source: 'OpenStreetMap / OpenInfraMap',
      },
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
    ['dams', 706],
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

test('Acaray and Yacyretá appear once each with OSM provenance', () => {
  for (const [id, name, object, version] of OSM_API_DAMS) {
    const matches = DAMS.filter((feature) => feature.id === id);
    assert.equal(matches.length, 1);
    const { properties } = matches[0];
    assert.equal(properties.name, name);
    assert.equal(properties.osm_id, id);
    assert.equal(properties.source_version, version);
    assert.equal(
      properties.source_url,
      `https://www.openstreetmap.org/${object}`,
    );
    assert.equal(properties.retrieved_at, '2026-10-15');
  }
});

test('Acaray and Yacyretá each get a stem, a selection context and an analyst record', async (t) => {
  const added = DAMS.filter((feature) =>
    OSM_API_DAMS.some(([id]) => id === feature.id),
  );
  t.mock.method(globalThis, 'fetch', async () => ({
    ok: true,
    text: async () =>
      added.map((feature) => JSON.stringify(feature)).join('\n'),
  }));
  const host = services();
  const layer = createLocalGeoJsonLayer(
    {
      id: 'local-dams',
      name: 'Dams',
      osmDerived: true,
      color: '#0088ff',
      url: '/dams.geojsonl',
    },
    host,
  );
  const viewer = {
    scene: { screenSpaceCameraController: { enableInputs: true } },
  };
  const fake = bindFakeGroundRenderer(viewer);
  fakeInput(viewer);
  t.after(() => layer.destroy(viewer));
  await layer.enable(viewer);
  const names = OSM_API_DAMS.map(([, name]) => name).sort();
  assert.equal(fake.set('stems').items.size, 2, 'both dams get a stem');
  assert.deepEqual(
    [...host.records.values()].map((record) => record.label).sort(),
    names,
  );
  assert.deepEqual(
    layer
      .getAnalystRecords()
      .map((record) => record.name)
      .sort(),
    names,
  );
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
    const layer = createLocalGeoJsonLayer(
      {
        id: 'local-dams',
        name: 'Dams',
        osmDerived: true,
        color: '#0088ff',
        url: '/dams.geojsonl',
      },
      host,
    );
    // A click picks the feature's stem, as the renderer's pick names it.
    const viewer = {
      scene: { screenSpaceCameraController: { enableInputs: true } },
    };
    const fake = bindFakeGroundRenderer(viewer);
    fake.setPick(() => {
      const [stem] = fake.set('stems').items.values();
      return {
        set: fake.set('stems').spec.id,
        id: stem.id,
        meta: stem.meta,
        surface: false,
      };
    });
    const input = fakeInput(viewer);
    return { layer, viewer, fake, click: () => input.click({ x: 0, y: 0 }) };
  });
  t.after(() =>
    instances.forEach(({ layer, viewer }) => layer.destroy(viewer)),
  );
  await Promise.all(instances.map(({ layer, viewer }) => layer.enable(viewer)));
  assert.equal(hosts[0].records.size, 1);
  assert.deepEqual(
    hosts.map((host) => host.credited),
    instances.map(({ viewer }) => [viewer]),
  );
  assert.equal(hosts[1].records.size, 1);
  instances[0].click();
  assert.ok(hosts[0].selection());
  assert.equal(hosts[1].selection(), undefined);
  assert.deepEqual(
    instances[0].fake.flights.map(({ destination }) => destination.height),
    [5000],
    'the click flies to the feature',
  );
  instances[0].layer.destroy(instances[0].viewer);
  assert.equal(hosts[0].records.size, 0);
  assert.equal(hosts[1].records.size, 1);
  assert.equal(instances[0].fake.liveSets().length, 0);
  assert.equal(instances[1].fake.liveSets().length, 6);
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
  // It draws and takes clicks through the renderer's ports: a viewer with no
  // renderer bound draws once the caller has loaded
  // `./render/cesium/unbound`.
  assert.deepEqual(sources.map((id) => id.split('/').at(-1)).sort(), [
    'color.js',
    'dispatcher.js',
    'ellipsoid.js',
    'frustum.js',
    'geojsonPins.js',
    'heights.js',
    'horizon.js',
    'infrastructure.js',
    'infrastructureData.js',
    'infrastructureOverlayEntry.js',
    'inputOwnership.js',
    'localGeojsonCore.js',
    'localGeojsonLod.js',
    'pickRegistry.js',
    'rendererOf.js',
    'rhumb.js',
    'scenePick.js',
    'sensorPick.js',
    'sphere.js',
    'styleStages.js',
    'vector.js',
  ]);
  assert.deepEqual(entry.imports, [], 'it reaches no Cesium of its own');
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
