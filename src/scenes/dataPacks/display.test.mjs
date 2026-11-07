import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../../globe/testing/fakeEngine.js';
import { createCesiumMoversEngine } from '../../testSupport/cesiumMoversEngine.mjs';
import { createPackRenderer } from './display.js';
import { createPackPresentations } from './presentation.js';

const features = [
  { id: 'point', type: 'Point', coordinates: [20, 10, 200] },
  {
    id: 'line',
    type: 'LineString',
    coordinates: [
      [20, 10, 200],
      [21, 11, 300],
    ],
  },
  {
    id: 'area',
    type: 'Polygon',
    coordinates: [
      [
        [20, 10, 200],
        [21, 10, 300],
        [21, 11, 400],
        [20, 11, 500],
        [20, 10, 200],
      ],
    ],
  },
];
const pack = {
  id: 'pack',
  attribution: { text: 'Fixture', license: 'CC0' },
  placement: { bounds: [20, 10, 21, 11], height: 200 },
};

function ownership() {
  const releases = [];
  const targets = new Map();
  return {
    own: (release) => releases.push(release),
    feature: (feature, id) => targets.set(feature.featureId, id),
    targets,
    destroy() {
      for (const release of releases.splice(0).reverse()) release();
    },
  };
}

for (const [name, make] of [
  ['fake', () => ({ engine: createFakeEngine() })],
  ['Cesium', createCesiumMoversEngine],
]) {
  test(`pack points, straight lines, raised polygon, image and ownership (${name})`, (t) => {
    const h = make();
    t.after(() => h.engine.destroy());
    const handle = ownership();
    t.after(() => handle.destroy());
    const display = createPackRenderer(h.engine);
    display.geometry(pack, features, handle);
    assert.equal(h.engine.movers.list().length, 1);
    assert.equal(h.engine.lines.list().length, 1);
    assert.equal(h.engine.meshes.list().length, 1);
    assert.equal(handle.targets.size, 3);
    const polygonId = 'scene-pack-mesh-' + handle.targets.get('area');
    const state = h.engine.fake?.mesh(polygonId);
    const primitive = h.primitive?.(polygonId);
    const positions =
      state?.positions ??
      primitive.geometryInstances.geometry.attributes.position.values;
    assert.equal(
      positions.length,
      12,
      'authored per-position heights keep four vertices',
    );
    assert.equal(
      state?.color[3] ?? primitive.appearance.material.uniforms.color.alpha,
      0.35,
    );
    const image = new HTMLCanvasElement();
    image.width = image.height = 8;
    display.image(pack, image, handle);
    const imageId = 'scene-pack-mesh-pack';
    assert.equal(
      h.engine.fake?.mesh(imageId).image ??
        h.primitive(imageId).appearance.material.uniforms.image,
      image,
    );
    handle.destroy();
    handle.destroy();
    assert.deepEqual(h.engine.meshes.list(), []);
    assert.deepEqual(h.engine.movers.list(), []);
    assert.deepEqual(h.engine.lines.list(), []);
  });

  test(`pack media caption keeps Cesium's font, offset and marker size (${name})`, (t) => {
    const h = make();
    t.after(() => h.engine.destroy());
    const previous = globalThis.document;
    const drawn = [];
    const ctx = {
      measureText: () => ({ width: 400 }),
      fillText: (...args) => drawn.push(['text', ...args]),
      beginPath() {},
      arc: (...args) => drawn.push(['arc', ...args]),
      fill() {},
    };
    globalThis.document = {
      createElement: () =>
        Object.assign(new HTMLCanvasElement(), { getContext: () => ctx }),
    };
    t.after(() => {
      if (previous === undefined) delete globalThis.document;
      else globalThis.document = previous;
    });
    const handle = ownership();
    createPackRenderer(h.engine).media(
      pack,
      { lon: 20, lat: 10, alt: 200 },
      handle,
    );
    assert.equal(ctx.font, '14px sans-serif');
    assert.equal(ctx.textAlign, 'center');
    assert.equal(ctx.textBaseline, 'middle');
    assert.deepEqual(drawn[0], ['text', pack.id, 206, 182]);
    assert.deepEqual(drawn[1], ['arc', 206, 206, 8, 0, Math.PI * 2]);
    assert.equal(h.engine.movers.list().length, 1);
    handle.destroy();
    assert.deepEqual(h.engine.movers.list(), []);
  });

  test(`pack detach and reattach retain decoded geometry and target identities (${name})`, async (t) => {
    const h = make();
    t.after(() => h.engine.destroy());
    const targets = new Map();
    const presentation = createPackPresentations(h.engine, targets, {
      store: { publish() {} },
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        features: features.map((f) => ({
          type: 'Feature',
          id: f.id,
          properties: {},
          geometry: { type: f.type, coordinates: f.coordinates },
        })),
      }),
    );
    const handle = await presentation.geojson({
      pack,
      asset: { bytes, mimeType: 'application/geo+json' },
      signal: new AbortController().signal,
    });
    const before = [...targets];
    assert.equal(before.length, 3);
    presentation.setScene(null);
    assert.equal(targets.size, 0);
    assert.deepEqual(h.engine.meshes.list(), []);
    presentation.setScene(h.engine);
    assert.deepEqual([...targets], before);
    assert.equal(h.engine.meshes.list().length, 1);
    handle.dispose();
    handle.dispose();
    assert.equal(targets.size, 0);
    assert.deepEqual(h.engine.meshes.list(), []);
  });

  test(`pack partial geometry failure releases prior resources (${name})`, async (t) => {
    const h = make();
    t.after(() => h.engine.destroy());
    const targets = new Map();
    h.engine.meshes.createMesh = () => {
      throw new Error('mesh failed');
    };
    const presentation = createPackPresentations(h.engine, targets, {
      store: { publish() {} },
    });
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        type: 'FeatureCollection',
        features: features.map((f) => ({
          type: 'Feature',
          id: f.id,
          properties: {},
          geometry: { type: f.type, coordinates: f.coordinates },
        })),
      }),
    );
    await assert.rejects(
      presentation.geojson({
        pack,
        asset: { bytes, mimeType: 'application/json' },
        signal: new AbortController().signal,
      }),
      /mesh failed/,
    );
    assert.equal(targets.size, 0);
    assert.deepEqual(h.engine.movers.list(), []);
    assert.deepEqual(h.engine.lines.list(), []);
  });
}
