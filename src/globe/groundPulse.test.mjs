import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import { createFakeEngine } from './testing/fakeEngine.js';
import { createCesiumMoversEngine } from '../testSupport/cesiumMoversEngine.mjs';

const options = () => ({
  id: 'field',
  center: geo.cartesian3.fromDegrees(3, 27),
  radiusM: 250000,
  heightM: 2500,
  color: [0, 1, 1, 0.25],
  lineColor: [0, 1, 1, 1],
  haloColor: [0, 0, 0, 0.8],
  depth: 0.35,
  lineWidth: 3,
  haloWidth: 1,
});

for (const [name, make] of [
  ['fake', () => ({ engine: createFakeEngine() })],
  ['Cesium', createCesiumMoversEngine],
]) {
  test(`pulse field validation, snapshots and disposal (${name})`, () => {
    const { engine, viewer } = make();
    const input = options();
    for (const patch of [
      { center: { x: 0, y: 0, z: 0 } },
      { radiusM: 0 },
      { heightM: -1 },
      { depth: 0 },
      { depth: 2 },
      { haloWidth: 4 },
      { lineColor: [1, 0, 0, 2] },
    ])
      assert.throws(
        () => engine.ground.createPulseField({ ...input, ...patch }),
        TypeError,
      );
    assert.deepEqual(engine.ground.list(), []);
    const field = engine.ground.createPulseField(input);
    const listed = () => engine.ground.list().find(({ id }) => id === field.id);
    const native = () =>
      viewer &&
      Array.from({ length: viewer.scene.primitives.length }, (_, i) =>
        viewer.scene.primitives.get(i),
      ).find((p) => p.appearance);
    const first = native();
    assert.equal(listed().shown, false);
    assert.equal(listed().animated, false);
    assert.throws(
      () => engine.ground.createPulseField(input),
      /already exists/,
    );
    assert.throws(
      () => engine.ground.createSet({ id: field.id, kind: 'disc' }),
      /already exists/,
    );
    const radii = [0.2, 0.6];
    const alphas = [0.5, 0.25];
    field.draw({ radii, alphas, level: 1 });
    radii[0] = 0.9;
    alphas[0] = 0;
    input.lineColor[0] = 1;
    assert.equal(listed().shown, true);
    if (first) {
      assert.equal(first.appearance.material.uniforms.radii.x, 0.2);
      assert.equal(first.appearance.material.uniforms.alphas.x, 0.5);
      assert.equal(first.appearance.material.uniforms.lineColor.red, 0);
      assert.equal(first.geometryInstances.geometry._height, 2500);
      assert.equal(first.allowPicking, false);
    } else {
      const state = engine.fake.groundPulse(field.id);
      assert.deepEqual(state.radii, [0.2, 0.6, 0, 0]);
      assert.deepEqual(state.alphas, [0.5, 0.25, 0, 0]);
      assert.equal(state.options.lineColor[0], 0);
    }
    for (const patch of [{ radii: [NaN] }, { alphas: [2] }, { level: -1 }])
      assert.throws(
        () => field.draw({ radii: [0.5], alphas: [1], level: 0, ...patch }),
        TypeError,
      );
    assert.equal(listed().shown, true, 'invalid updates are atomic');
    field.move(geo.cartesian3.fromDegrees(3.01, 27));
    assert.equal(
      native(),
      first,
      'small movement does not rebuild the material disc',
    );
    field.draw({ radii: [], alphas: [], level: 0 });
    assert.equal(listed().shown, false);
    field.destroy();
    field.destroy();
    field.move({ x: NaN });
    field.draw({});
    assert.equal(field.isDestroyed(), true);
    assert.equal(listed(), undefined);
    if (first) assert.ok(first.isDestroyed());
    engine.ground.createPulseField(input);
    engine.destroy();
    assert.deepEqual(engine.ground.list(), []);
  });
}
