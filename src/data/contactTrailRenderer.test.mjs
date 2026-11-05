import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { readFileSync } from 'node:fs';
import { TRAIL_VERTEX_LIMIT } from '../layers/transit/trails.js';
import {
  createContactTrailRenderer,
  trailAlpha,
} from './contactTrailRenderer.js';

function fixture(t, ground = false) {
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
  const width = Cesium.ContextLimits._maximumAliasedLineWidth;
  Cesium.ContextLimits._maximumAliasedLineWidth = 1;
  t.after(() => {
    Cesium.ContextLimits._maximumAliasedLineWidth = width;
  });
  const primitives = new Cesium.PrimitiveCollection();
  t.after(() => primitives.destroy());
  const groundPrimitives = new Cesium.PrimitiveCollection();
  t.after(() => groundPrimitives.destroy());
  return {
    primitives,
    groundPrimitives,
    frameState: { context: { depthTexture: ground } },
    globe: { show: false },
  };
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
      Cesium.ColorGeometryInstanceAttribute.toValue(
        Cesium.Color.fromCssColorString('#5EF08A').withAlpha(0.55),
      ),
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
  body.getGeometryInstanceAttributes = (id) => {
    const stored = attributes.get(id),
      accessor = {};
    for (const name of ['show', 'color', 'depthFailColor'])
      Object.defineProperty(accessor, name, {
        get: () => stored[name].slice(),
        set: (value) => {
          stored[name] = value.slice();
        },
      });
    return accessor;
  };
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
    assert.deepEqual(
      a.depthFailColor,
      Cesium.ColorGeometryInstanceAttribute.toValue(
        Cesium.Color.fromCssColorString('#5EF08A').withAlpha(0.55),
      ),
    );
  const result = renderer.diagnostics();
  assert.equal(result.body, body);
  assert.equal(result.rebuilds, 1);
  assert.equal(result.headRebuilds, 1, '120 frames retain head geometry');
  assert.equal(result.head.material.uniforms.fraction, 0.5);
  assert.equal(result.head.width, 3);
  assert.equal(result.backing.width, 5);
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

test('ground body and clipped head stay inside rebuild and frame geometry budgets', async () => {
  Cesium.ApproximateTerrainHeights._terrainHeights = JSON.parse(
    readFileSync(
      new URL(
        import.meta
          .resolve('@cesium/engine/Source/Assets/approximateTerrainHeights.json'),
      ),
    ),
  );
  const positions = [
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.267),
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672),
  ];
  const start = performance.now();
  const instances = async (count) =>
    Promise.all(
      Array.from(
        { length: count },
        async (_, i) =>
          new Cesium.GeometryInstance({
            id: i,
            geometry: await Cesium.GroundPolylineGeometry.createGeometry(
              new Cesium.GroundPolylineGeometry({
                positions,
                width: i % 2 ? 3 : 5,
                granularity: 0,
              }),
            ),
          }),
      ),
    );
  const pipelineBytes = async (count) => {
    // Match GroundPolylinePrimitive's internal Primitive options and the
    // application's morph-capable scene, including batch IDs and encoding.
    const result = Cesium.PrimitivePipeline.combineGeometry({
      instances: await instances(count),
      projection: new Cesium.GeographicProjection(),
      ellipsoid: Cesium.Ellipsoid.WGS84,
      modelMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      elementIndexUintSupported: true,
      scene3DOnly: false,
      vertexCacheOptimize: false,
      compressVertices: false,
      createPickOffsets: false,
    });
    return result.geometries.reduce(
      (sum, geometry) =>
        sum +
        Object.values(geometry.attributes).reduce(
          (n, a) => n + (a?.values?.byteLength || 0),
          0,
        ) +
        geometry.indices.byteLength,
      0,
    );
  };
  const bytes = await pipelineBytes(1);
  const bodyInstances = 2 * (TRAIL_VERTEX_LIMIT - 1);
  const bodyBytes = await pipelineBytes(bodyInstances);
  assert.equal(bytes, 1576, 'measure final encoded and batched geometry');
  assert.equal(bodyBytes, 2014128);
  const instanceReserve = 64 * bodyInstances;
  assert.ok(bodyBytes + instanceReserve <= 2 * 1024 * 1024);
  assert.ok(
    bytes <= 2048,
    'subdivision crossings stay below 2 KiB of head geometry',
  );
  console.log(
    `trail final pipeline: ${bytes} bytes/head crossing, 0 bytes/ordinary head frame, ${bodyBytes} bytes/body (${bodyInstances} instances), ${instanceReserve} bytes instance reserve; geometry CPU ${(performance.now() - start).toFixed(3)} ms`,
  );
});

test('supported scenes drape body and clipped head on 3D tiles and retain head geometry', (t) => {
  const scene = fixture(t, true),
    renderer = createContactTrailRenderer(scene);
  const positions = [
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.267),
    Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672),
  ];
  renderer.replaceHistory({
    revision: 1,
    segments: [{ fromSeq: 0, toSeq: 1, fromT: 0, toT: 20000, positions }],
  });
  const first = renderer.diagnostics();
  assert.ok(first.body instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(first.body.classificationType, Cesium.ClassificationType.BOTH);
  assert.ok(scene.groundPrimitives.contains(first.body));
  for (const instance of first.body.geometryInstances)
    assert.ok(instance.geometry instanceof Cesium.GroundPolylineGeometry);
  for (let i = 1; i <= 120; i++)
    renderer.setDisplaySample(
      { displayT: i * 100, fromSeq: 0, toSeq: 1, fraction: i / 200 },
      positions[1],
    );
  const result = renderer.diagnostics();
  assert.equal(result.body, first.body);
  assert.equal(result.headRebuilds, 1);
  assert.ok(result.headPrimitive instanceof Cesium.GroundPolylinePrimitive);
  assert.equal(result.head.material.uniforms.fraction, 0.6);
  assert.match(result.head.material.shaderSource, /discard/);
  for (const stack of ['Google', 'OSM', 'Bing', 'Google']) {
    scene.globe.show = stack !== 'Google';
    renderer.setDisplaySample(
      { displayT: 12000, fromSeq: 0, toSeq: 1, fraction: 0.6 },
      positions[1],
    );
    const retained = renderer.diagnostics();
    assert.equal(retained.body, result.body, `${stack}: retained history`);
    assert.equal(retained.headPrimitive, result.headPrimitive);
    for (const primitive of [retained.body, retained.headPrimitive]) {
      assert.equal(
        primitive.classificationType,
        Cesium.ClassificationType.BOTH,
        stack,
      );
      assert.equal(primitive.show, true, stack);
    }
  }
  renderer.setVisible(false);
  assert.equal(result.body.show, false);
  assert.equal(result.headPrimitive.show, false);
  renderer.destroy();
  assert.equal(scene.groundPrimitives.length, 0);
  assert.equal(scene.primitives.length, 0);
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
    assert.deepEqual(
      a.depthFailColor,
      Cesium.ColorGeometryInstanceAttribute.toValue(
        Cesium.Color.fromCssColorString('#FF4538').withAlpha(0.55),
      ),
    );
});

test('non-fading altitude paths use a full-strength outlined material without competing translucent lanes or draping', (t) => {
  const scene = fixture(t, true);
  const renderer = createContactTrailRenderer(scene, {
    fade: false,
    drape: false,
  });
  renderer.setStyle('#ff8fb1');
  const positions = [10000, 20000].map((height, i) =>
    Cesium.Cartesian3.fromDegrees(10 + i, 50, height),
  );
  renderer.replaceHistory({
    revision: 1,
    segments: [{ fromSeq: 0, toSeq: 1, fromT: 0, toT: 1000, positions }],
  });
  const { body, ground } = renderer.diagnostics();
  assert.equal(ground, false);
  assert.ok(scene.primitives.contains(body));
  assert.equal(scene.groundPrimitives.length, 0);
  assert.ok(body.appearance instanceof Cesium.PolylineMaterialAppearance);
  assert.equal(body.appearance.material.type, 'PolylineOutline');
  assert.equal(
    body.geometryInstances.length,
    1,
    'one outlined lane prevents the dark backing overpainting the rose',
  );
  const uniforms = body.appearance.material.uniforms;
  assert.deepEqual(uniforms.color, Cesium.Color.fromCssColorString('#ff8fb1'));
  assert.equal(uniforms.color.alpha, 1);
  assert.ok(uniforms.outlineWidth >= 1);
  assert.ok(
    uniforms.outlineColor.red * 0.299 +
      uniforms.outlineColor.green * 0.587 +
      uniforms.outlineColor.blue * 0.114 <
      0.1,
  );
  assert.ok(uniforms.outlineColor.alpha >= 0.8);
  assert.equal(
    body.depthFailAppearance.material,
    body.appearance.material,
    'terrain occlusion keeps the same hue and dark outline',
  );
  const attributes = new Map(
    body.geometryInstances.map((instance) => [
      instance.id,
      Object.fromEntries(
        Object.entries(instance.attributes).map(([key, value]) => [
          key,
          value.value,
        ]),
      ),
    ]),
  );
  body._ready = true;
  body.getGeometryInstanceAttributes = (id) => attributes.get(id);
  renderer.setDisplaySample(
    { displayT: 900001, fromSeq: 0, toSeq: 1, fraction: 1 },
    positions[1],
  );
  for (const a of attributes.values()) {
    assert.equal(a.show[0], 1);
  }
  for (const instance of body.geometryInstances) {
    assert.ok(instance.geometry instanceof Cesium.PolylineGeometry);
    const built = Cesium.PolylineGeometry.createGeometry(instance.geometry);
    const values = built.attributes.position.values;
    const heights = [];
    for (let i = 0; i < values.length; i += 3)
      heights.push(
        Cesium.Cartographic.fromCartesian(Cesium.Cartesian3.unpack(values, i))
          .height,
      );
    assert.deepEqual(
      [...new Set(heights.map(Math.round))].sort((a, b) => a - b),
      [10000, 20000],
    );
    assert.ok(
      heights.every(
        (height) =>
          Math.min(Math.abs(height - 10000), Math.abs(height - 20000)) < 0.01,
      ),
    );
  }
  assert.deepEqual(
    uniforms.color,
    Cesium.Color.fromCssColorString('#ff8fb1'),
    'old segments retain full rose',
  );
  renderer.setDisplaySample(
    { displayT: 500, fromSeq: 0, toSeq: 1, fraction: 0.5 },
    positions[0],
  );
  const head = renderer.diagnostics();
  assert.equal(head.head.material.uniforms.color.alpha, 1);
  assert.equal(
    head.headPrimitive.depthFailAppearance.material.uniforms.color.alpha,
    1,
  );
  assert.equal(
    head.headPrimitive.depthFailAppearance.material.uniforms.backing,
    true,
  );
  renderer.setStyle('#FFFFFF');
  renderer.setDisplaySample(
    { displayT: 600, fromSeq: 0, toSeq: 1, fraction: 0.6 },
    positions[0],
  );
  assert.deepEqual(uniforms.color, Cesium.Color.WHITE);
  assert.ok(
    Cesium.Color.equals(
      renderer.diagnostics().head.material.uniforms.color,
      Cesium.Color.WHITE,
    ),
  );
  renderer.destroy();
});

test('fade false can retain default draping, and drape false retains default age fading', (t) => {
  for (const options of [{ fade: false }, { drape: false }]) {
    const scene = fixture(t, true);
    const renderer = createContactTrailRenderer(scene, options);
    const positions = [10000, 20000].map((height, i) =>
      Cesium.Cartesian3.fromDegrees(10 + i, 50, height),
    );
    renderer.replaceHistory({
      revision: 1,
      segments: [{ fromSeq: 0, toSeq: 1, fromT: 0, toT: 1000, positions }],
    });
    const { body, ground } = renderer.diagnostics();
    const draped = options.drape !== false;
    assert.equal(ground, draped);
    assert.equal(scene.groundPrimitives.contains(body), draped);
    assert.equal(scene.primitives.contains(body), !draped);
    const attributes = new Map(
      body.geometryInstances.map((instance) => [
        instance.id,
        Object.fromEntries(
          Object.entries(instance.attributes).map(([key, value]) => [
            key,
            value.value.slice(),
          ]),
        ),
      ]),
    );
    body._ready = true;
    body.getGeometryInstanceAttributes = (id) => attributes.get(id);
    const alphas = [];
    for (const displayT of [1000, 901000]) {
      renderer.setDisplaySample(
        { displayT, fromSeq: 0, toSeq: 1, fraction: 1 },
        positions[1],
      );
      assert.ok([...attributes.values()].every((a) => a.show[0] === 1));
      alphas.push(
        options.fade === false
          ? body.appearance.material.uniforms.color.alpha
          : attributes.get('0:1').color[3],
      );
    }
    assert.deepEqual(alphas, options.fade === false ? [1, 1] : [204, 20]);
    for (const instance of body.geometryInstances) {
      if (draped)
        assert.ok(instance.geometry instanceof Cesium.GroundPolylineGeometry);
      else {
        const values = Cesium.PolylineGeometry.createGeometry(instance.geometry)
          .attributes.position.values;
        const heights = [];
        for (let i = 0; i < values.length; i += 3)
          heights.push(
            Math.round(
              Cesium.Cartographic.fromCartesian(
                Cesium.Cartesian3.unpack(values, i),
              ).height,
            ),
          );
        assert.deepEqual(
          [...new Set(heights)].sort((a, b) => a - b),
          [10000, 20000],
        );
      }
    }
    renderer.setDisplaySample(
      { displayT: 500, fromSeq: 0, toSeq: 1, fraction: 0.5 },
      positions[0],
    );
    const { head, headPrimitive } = renderer.diagnostics();
    assert.equal(head.show, true);
    assert.equal(head.material.uniforms.fraction, 0.5);
    assert.equal(
      head.material.uniforms.color.alpha,
      options.fade === false ? 1 : 0.8,
    );
    assert.equal(
      headPrimitive instanceof Cesium.GroundPolylinePrimitive,
      draped,
    );
    renderer.destroy();
  }
});
