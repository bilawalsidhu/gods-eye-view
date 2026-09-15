import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createContactTrailRenderer,
  trailAlpha,
} from './contactTrailRenderer.js';

function fixture(t) {
  for (const key of [
    'HTMLCanvasElement',
    'HTMLImageElement',
    'ImageBitmap',
    'OffscreenCanvas',
  ]) {
    const prior = globalThis[key];
    globalThis[key] = class {};
    t.after(() => {
      if (prior === undefined) delete globalThis[key];
      else globalThis[key] = prior;
    });
  }
  const primitives = new Cesium.PrimitiveCollection();
  t.after(() => primitives.destroy());
  return { primitives };
}
test('body clips future subdivisions, head ends at exact marker, and frames retain geometry', (t) => {
  const scene = fixture(t),
    renderer = createContactTrailRenderer(scene);
  const positions = [0, 1, 2].map((i) =>
    Cesium.Cartesian3.fromDegrees(-71, 42 + i * 0.001, 11.5),
  );
  renderer.replaceHistory({
    revision: 1,
    segments: [
      {
        fromSeq: 0,
        toSeq: 1,
        fromT: 0,
        toT: 10000,
        positions: positions.slice(0, 2),
      },
      {
        fromSeq: 0,
        toSeq: 1,
        fromT: 10000,
        toT: 20000,
        positions: positions.slice(1, 3),
      },
    ],
  });
  const { body } = renderer.diagnostics();
  assert.equal(body.allowPicking, false);
  // The constructor defers this check until shader preparation. Run the real
  // Cesium validator without WebGL, including a missing-attribute control.
  const source = body.depthFailAppearance.vertexShaderSource;
  body._batchTableAttributeIndices = { color: 0 };
  assert.throws(
    () => Cesium.Primitive._updateColorAttribute(body, source, true),
    /depthFailColor/,
  );
  for (const instance of body.geometryInstances) {
    assert.deepEqual(
      instance.attributes.depthFailColor.value,
      instance.attributes.color.value,
    );
  }
  body._batchTableAttributeIndices = { color: 0, depthFailColor: 1 };
  assert.doesNotThrow(() =>
    Cesium.Primitive._updateColorAttribute(body, source, true),
  );
  const attributes = new Map(
    body.geometryInstances.map((instance) => [
      instance.id,
      {
        show: new Uint8Array([0]),
        color: new Uint8Array(4),
        depthFailColor: new Uint8Array(4),
      },
    ]),
  );
  // Simulate Cesium's completed upload; exercise public attribute writes.
  body._ready = true;
  body.getGeometryInstanceAttributes = (id) => attributes.get(id);
  const marker = Cesium.Cartesian3.lerp(
    positions[1],
    positions[2],
    0.5,
    new Cesium.Cartesian3(),
  );
  const sample = { displayT: 15000, fromSeq: 0, toSeq: 1, fraction: 0.75 };
  for (let i = 0; i < 120; i++) renderer.setDisplaySample(sample, marker);
  assert.deepEqual(
    [...attributes.values()].map((a) => a.show[0]),
    [1, 1, 0, 0],
  );
  for (const a of attributes.values())
    assert.deepEqual(a.depthFailColor, a.color);
  const result = renderer.diagnostics();
  assert.equal(result.body, body);
  assert.equal(result.rebuilds, 1);
  assert.ok(Cesium.Cartesian3.equals(result.head.positions.at(-1), marker));
  assert.equal(result.head.positions.length, 2);
  renderer.setDisplaySample(
    { ...sample, displayT: 5000, fraction: 0.25 },
    positions[0],
  );
  assert.ok(
    [...attributes.values()].every((a) => a.show[0] === 0),
    'rewind hides future geometry again',
  );
  renderer.destroy();
  assert.equal(scene.primitives.length, 0);
});
test('trail age curve uses the specified four alpha anchors', () => {
  assert.equal(trailAlpha(0), 0.8);
  assert.equal(trailAlpha(120000), 0.45);
  assert.equal(trailAlpha(600000), 0.2);
  assert.equal(trailAlpha(900000), 0.08);
  assert.ok(Math.abs(trailAlpha(60000) - 0.625) < 1e-10);
});

test('the maximum prepared body stays below the 2 MiB geometry budget', () => {
  const geometry = Cesium.PolylineGeometry.createGeometry(
    new Cesium.PolylineGeometry({
      positions: [
        Cesium.Cartesian3.fromDegrees(-71, 42, 11.5),
        Cesium.Cartesian3.fromDegrees(-71, 42.0002, 11.5),
      ],
      width: 2,
      arcType: Cesium.ArcType.NONE,
      vertexFormat: Cesium.PolylineColorAppearance.VERTEX_FORMAT,
    }),
  );
  const bytes =
    Object.values(geometry.attributes).reduce(
      (total, attribute) => total + (attribute?.values?.byteLength || 0),
      0,
    ) + geometry.indices.byteLength;
  assert.ok(bytes * 2 * 2047 < 2 * 1024 * 1024);
});

test('subdivision crossings only write the changed show range and age colors once per second', (t) => {
  const renderer = createContactTrailRenderer(fixture(t));
  const positions = [
    Cesium.Cartesian3.fromDegrees(-71, 42),
    Cesium.Cartesian3.fromDegrees(-71, 42.001),
  ];
  renderer.replaceHistory({
    revision: 1,
    segments: Array.from({ length: 100 }, (_, i) => ({
      fromSeq: 0,
      toSeq: 1,
      fromT: i * 500,
      toT: (i + 1) * 500,
      positions,
    })),
  });
  const { body } = renderer.diagnostics();
  const counts = { show: 0, color: 0, depthFailColor: 0 };
  const attributes = new Map(
    body.geometryInstances.map((instance) => {
      const result = {};
      for (const name of Object.keys(counts)) {
        let value = instance.attributes[name].value;
        Object.defineProperty(result, name, {
          get: () => value,
          set(next) {
            value = next;
            counts[name]++;
          },
        });
      }
      return [instance.id, result];
    }),
  );
  body._ready = true;
  body.getGeometryInstanceAttributes = (id) => attributes.get(id);
  const display = (displayT) =>
    renderer.setDisplaySample(
      { displayT, fromSeq: 0, toSeq: 1, fraction: 0.1 },
      positions[0],
    );
  const reset = () => {
    for (const name of Object.keys(counts)) counts[name] = 0;
  };
  display(100);
  assert.deepEqual(counts, { show: 0, color: 200, depthFailColor: 200 });
  reset();
  display(600);
  assert.deepEqual(counts, { show: 2, color: 0, depthFailColor: 0 });
  reset();
  display(100);
  assert.deepEqual(counts, { show: 2, color: 0, depthFailColor: 0 });
  assert.ok(
    [...attributes.values()].every((a) => a.show[0] === 0),
    'backward seek hides the completed range',
  );
  reset();
  display(1100);
  assert.deepEqual(counts, { show: 4, color: 200, depthFailColor: 200 });
  reset();
  display(1200);
  assert.deepEqual(counts, { show: 0, color: 0, depthFailColor: 0 });
  renderer.setStyle('#FF4538');
  display(1200);
  assert.deepEqual(counts, { show: 0, color: 200, depthFailColor: 200 });
  for (const a of attributes.values())
    assert.deepEqual(a.color, a.depthFailColor);
});
