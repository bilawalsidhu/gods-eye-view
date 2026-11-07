import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCesiumMoversEngine } from '../../testSupport/cesiumMoversEngine.mjs';
import { createImageryShell } from './imageryShell.js';

const BOX = { west: -100, south: 30, east: -90, north: 40 };
const WINDOW = { west: 0.1, south: 0.2, east: 0.7, north: 0.8 };
const image = (width = 8, height = 4) => ({ width, height });
const items = (collection) =>
  Array.from({ length: collection.length }, (_, i) => collection.get(i));

function fixture(t) {
  const f = createCesiumMoversEngine();
  const scene = f.viewer.scene;
  const shells = [];
  let requests = 0;
  scene.requestRender = () => requests++;
  f.viewer.imageryLayers = new Cesium.ImageryLayerCollection();
  scene.globe.show = true;
  t.after(() => {
    for (const shell of shells) shell.destroy();
    f.engine.destroy();
  });
  return {
    ...f,
    scene,
    requests: () => requests,
    frames(count = 1) {
      for (let i = 0; i < count; i++) f.frame();
    },
    shell(options = {}) {
      const before = items(scene.primitives);
      let settled = 0;
      const shell = createImageryShell({
        scene,
        rectangle: BOX,
        height: 600,
        onSettled: () => settled++,
        ...options,
      });
      shells.push(shell);
      const primitive = items(scene.primitives).find(
        (item) => !before.includes(item),
      );
      return {
        shell,
        primitive,
        material: primitive.appearance.material,
        settled: () => settled,
      };
    },
  };
}

// The headless scene never uploads textures or builds asynchronous geometry.
// Supply only those GPU completion signals; materials and primitives are real.
function uploaded(primitive, name = 'image') {
  primitive._ready = true;
  const uniforms = primitive.appearance.material.uniforms;
  const value = uniforms[name];
  uniforms[`${name}Dimensions`] = new Cesium.Cartesian2(
    value.width,
    value.height,
  );
}

test('a raised shell keeps its rectangle, height and alpha without hiding or picking other content', (t) => {
  const f = fixture(t);
  const { shell, primitive, material } = f.shell();
  assert.ok(primitive instanceof Cesium.Primitive);
  assert.ok(material instanceof Cesium.Material);
  const geometry = primitive.geometryInstances.geometry;
  assert.ok(geometry instanceof Cesium.RectangleGeometry);
  assert.ok(
    Cesium.Rectangle.equalsEpsilon(
      geometry.rectangle,
      Cesium.Rectangle.fromDegrees(-100, 30, -90, 40),
      1e-12,
    ),
  );
  assert.equal(geometry._surfaceHeight, 600);
  assert.equal(primitive.allowPicking, false);
  assert.equal(primitive.asynchronous, true);
  assert.equal(primitive.appearance.flat, true);
  assert.equal(primitive.appearance.isTranslucent(), false);
  assert.deepEqual(primitive.appearance.getRenderState(), {
    depthTest: { enabled: true },
    depthMask: false,
    blending: Cesium.BlendingState.ALPHA_BLEND,
  });
  shell.setAlpha(0.35);
  assert.equal(material.uniforms.alpha, 0.35);
  const requests = f.requests();
  shell.setAlpha(0.35);
  assert.equal(f.requests(), requests, 'unchanged alpha needs no frame');
});

test('shell lift follows camera height uniformly and returns to the ellipsoid', (t) => {
  const f = fixture(t);
  const a = f.shell({ height: 600 });
  const b = f.shell({ height: 900 });
  for (const [height, lift] of [
    [10_000, 0],
    [1_000_000, 4000],
    [40_000_000, 60_000],
    [1000, 0],
  ]) {
    f.scene.camera.setView({
      destination: Cesium.Cartesian3.fromDegrees(-95, 35, height),
    });
    f.frames();
    const expected = Cesium.Matrix4.fromUniformScale(
      1 + lift / Cesium.Ellipsoid.WGS84.maximumRadius,
    );
    assert.ok(Cesium.Matrix4.equals(a.primitive.modelMatrix, expected));
    assert.ok(Cesium.Matrix4.equals(b.primitive.modelMatrix, expected));
  }
});

test('shell rank puts all shells before other primitives and preserves equal-rank order', (t) => {
  const f = fixture(t);
  const other = f.scene.primitives.add(new Cesium.PrimitiveCollection());
  t.after(() => f.scene.primitives.remove(other));
  const high = f.shell({ rank: 8 });
  const low = f.shell({ rank: -2 });
  const equal = f.shell({ rank: 8 });
  assert.deepEqual(items(f.scene.primitives), [
    low.primitive,
    high.primitive,
    equal.primitive,
    other,
  ]);
  high.shell.setRank(-3);
  assert.deepEqual(items(f.scene.primitives), [
    high.primitive,
    low.primitive,
    equal.primitive,
    other,
  ]);
  f.scene.primitives.raiseToTop(low.primitive);
  low.shell.setRank(-2);
  assert.equal(f.scene.primitives.get(1), low.primitive);
  assert.equal(f.scene.primitives.get(3), other);
});

test('a shell waits for geometry, texture dimensions and shown frames, then idles', (t) => {
  const f = fixture(t);
  const { shell, primitive, material, settled } = f.shell();
  const before = f.scene.postRender.numberOfListeners;
  shell.setImage(image());
  material.uniforms.imageDimensions = new Cesium.Cartesian2(1, 1);
  f.frames(4);
  assert.equal(shell.drawn(), false, 'geometry is not ready');
  assert.equal(settled(), 0);
  assert.equal(f.scene.postRender.numberOfListeners, before + 1);
  primitive._ready = true;
  f.frames(3);
  assert.equal(shell.drawn(), false, 'the placeholder texture is not ready');
  assert.equal(settled(), 0);
  uploaded(primitive);
  f.frames();
  assert.equal(shell.drawn(), true);
  assert.equal(settled(), 1);
  assert.equal(f.scene.postRender.numberOfListeners, before);
  const requests = f.requests();
  shell.setImage(shell.image());
  f.frames(3);
  assert.equal(f.requests(), requests, 'the settled image needs no frames');
  assert.equal(settled(), 1);

  shell.setImage(image());
  shell.setShow(false);
  f.frames(5);
  assert.equal(shell.drawn(), false, 'hidden frames do not upload');
  assert.equal(f.scene.postRender.numberOfListeners, before);
  shell.setShow(true);
  f.frames(2);
  assert.equal(shell.drawn(), false);
  f.frames();
  assert.equal(shell.drawn(), true);
  assert.equal(settled(), 2);
});

test('detail waits for its upload, keeps the same window and hides a moved window until ready', (t) => {
  const f = fixture(t);
  const { shell, primitive, material, settled } = f.shell();
  shell.setImage(image());
  uploaded(primitive);
  f.frames(3);
  shell.setDetail(image(16, 8), WINDOW);
  material.uniforms.detailDimensions = new Cesium.Cartesian2(1, 1);
  f.frames(3);
  assert.equal(shell.drawn(), false);
  assert.equal(shell.diagnostics().detail.window, null);
  assert.equal(settled(), 1);
  uploaded(primitive, 'detail');
  f.frames();
  assert.deepEqual(shell.diagnostics().detail.window, WINDOW);
  assert.equal(shell.drawn(), true);
  assert.equal(settled(), 2);

  shell.setDetail(image(16, 8), { ...WINDOW });
  assert.deepEqual(shell.diagnostics().detail.window, WINDOW);
  f.frames(2);
  assert.equal(shell.drawn(), false, 'same-sized uploads still need frames');
  f.frames();
  assert.equal(shell.drawn(), true);
  assert.equal(settled(), 3);

  const moved = { west: 0.2, south: 0.3, east: 0.6, north: 0.7 };
  shell.setDetail(image(32, 16), moved);
  assert.equal(shell.diagnostics().detail.window, null);
  uploaded(primitive, 'detail');
  f.frames(2);
  assert.equal(shell.diagnostics().detail.window, null);
  f.frames();
  assert.deepEqual(shell.diagnostics().detail.window, moved);
  assert.equal(settled(), 4);

  shell.setDetail(image(64, 32), WINDOW);
  shell.setDetail(null);
  assert.equal(shell.detail(), null);
  assert.equal(material.uniforms.detail, Cesium.Material.DefaultImageId);
  assert.equal(shell.diagnostics().detail.window, null);
  f.frames(4);
  assert.equal(shell.diagnostics().detail.window, null, 'no stale window');
  assert.equal(shell.drawn(), true);
});

test('destroy releases the primitive, material, images and frame listeners once', (t) => {
  const f = fixture(t);
  const before = [
    f.scene.preRender.numberOfListeners,
    f.scene.postRender.numberOfListeners,
  ];
  const { shell, primitive, material, settled } = f.shell();
  shell.setImage(image());
  shell.setDetail(image(16, 8), WINDOW);
  assert.equal(f.scene.preRender.numberOfListeners, before[0] + 1);
  assert.equal(f.scene.postRender.numberOfListeners, before[1] + 1);
  shell.destroy();
  assert.equal(f.scene.primitives.contains(primitive), false);
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(material.isDestroyed(), true);
  assert.equal(shell.image(), null);
  assert.equal(shell.detail(), null);
  assert.deepEqual(
    [f.scene.preRender.numberOfListeners, f.scene.postRender.numberOfListeners],
    before,
  );
  const requests = f.requests();
  shell.destroy();
  shell.setImage(image());
  shell.setDetail(image(), WINDOW);
  shell.setShow(true);
  shell.setAlpha(1);
  shell.setRank(4);
  f.frames(4);
  assert.equal(f.requests(), requests);
  assert.equal(settled(), 0);
});

test('destroy also releases the material when the scene already destroyed the primitive', (t) => {
  const f = fixture(t);
  const { shell, primitive, material } = f.shell();
  shell.setImage(image());
  f.scene.primitives.remove(primitive);
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(material.isDestroyed(), false);
  shell.destroy();
  assert.equal(material.isDestroyed(), true);
});

test('engine imagery mounts real shells, converts detail bounds and settles staged images', async (t) => {
  const f = fixture(t);
  const source = { kind: 'image', image: image(), rectangle: BOX };
  const layer = f.engine.imagery.createLayer({
    id: 'raised',
    source,
    raise: 600,
    alpha: 0.6,
  });
  const primitive = f.scene.primitives.get(0);
  assert.ok(primitive instanceof Cesium.Primitive);
  assert.equal(f.viewer.imageryLayers.length, 0, 'no draped imagery layer');
  assert.equal(primitive.appearance.material.uniforms.alpha, 0.6);
  uploaded(primitive);
  f.frames(3);
  assert.equal(layer.ready(), true);
  let detailed = false;
  const detail = layer.setDetail({
    image: image(16, 8),
    rectangle: { west: -99, south: 32, east: -93, north: 38 },
  });
  detail.then((value) => (detailed = value));
  uploaded(primitive, 'detail');
  f.frames(2);
  await Promise.resolve();
  assert.equal(detailed, false);
  f.frames();
  assert.equal(await detail, true);
  assert.deepEqual(
    primitive.appearance.material.uniforms.window,
    new Cesium.Cartesian4(0.1, 0.2, 0.7, 0.8),
  );
  await layer.setDetail(null);

  const next = { ...source, image: image(32, 16) };
  const staged = layer.setSource(next, { staged: true });
  assert.equal(layer.staging(), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    f.scene.primitives.get(0),
    primitive,
    'same rectangle reuses the shell',
  );
  uploaded(primitive);
  f.frames(2);
  assert.equal(layer.staging(), true);
  f.frames();
  assert.equal(await staged, true);
  assert.equal(layer.source().image, next.image);
  const material = primitive.appearance.material;
  layer.destroy();
  assert.equal(primitive.isDestroyed(), true);
  assert.equal(material.isDestroyed(), true);
  assert.deepEqual(f.engine.imagery.list(), []);
});
