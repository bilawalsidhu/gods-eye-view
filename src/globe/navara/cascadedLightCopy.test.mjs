import assert from 'node:assert/strict';
import test from 'node:test';
import csm from '@navaramap/three-csm';
import { patchCascadedLightCopy } from './cascadedLightCopy.js';

const { CascadedDirectionalLights } = csm;

function sun(count = 3) {
  const light = new CascadedDirectionalLights(0xffffff, 2);
  light.setCount(count);
  light.cascadedLights.forEach((cascade, index) => {
    cascade.position.set(index, 2, 3);
    cascade.target.position.set(index, 0, 0);
    cascade.updateMatrixWorld(true);
    cascade.target.updateMatrixWorld(true);
    cascade.shadow.bias = -0.001 * (index + 1);
  });
  return light;
}

test("Navara 0.2.1's copy clones new lights every call (the leak)", () => {
  const source = sun();
  const copy = new CascadedDirectionalLights();
  copy.copy(source, true);
  const ids = copy.cascadedLights.map((light) => light.id);
  copy.copy(source, true);
  assert.notDeepEqual(
    copy.cascadedLights.map((light) => light.id),
    ids,
  );
});

test('patched, a copy keeps its lights and takes the values', () => {
  const restore = patchCascadedLightCopy(CascadedDirectionalLights.prototype);
  try {
    const source = sun();
    const copy = new CascadedDirectionalLights();
    copy.copy(source, true); // first copy: builds the lights
    const lights = [...copy.cascadedLights];
    const targets = lights.map((light) => light.target);
    source.cascadedLights[1].intensity = 5;
    source.cascadedLights[1].color.set(0xff0000);
    source.cascadedLights[2].position.set(9, 9, 9);
    source.cascadedLights[2].target.position.set(7, 0, 0);
    source.cascadedLights[2].updateMatrixWorld(true);
    source.cascadedLights[2].target.updateMatrixWorld(true);
    source.cascadedLights[0].shadow.camera.left = -77;
    copy.copy(source, true);
    assert.deepEqual(copy.cascadedLights, lights, 'the same light objects');
    assert.deepEqual(
      copy.cascadedLights.map((light) => light.target),
      targets,
    );
    assert.equal(copy.cascadedLights[1].intensity, 5);
    assert.equal(copy.cascadedLights[1].color.getHex(), 0xff0000);
    assert.deepEqual(copy.cascadedLights[2].position.toArray(), [9, 9, 9]);
    assert.equal(copy.cascadedLights[2].target.matrixWorld.elements[12], 7);
    assert.equal(copy.cascadedLights[0].shadow.camera.left, -77);
    assert.equal(copy.cascadedLights[2].shadow.bias, -0.003);
    // A different cascade count rebuilds, as before.
    source.setCount(4);
    copy.copy(source, true);
    assert.equal(copy.cascadedLights.length, 4);
    assert.equal(
      patchCascadedLightCopy(CascadedDirectionalLights.prototype),
      restore,
      'idempotent',
    );
  } finally {
    restore();
  }
  assert.equal(CascadedDirectionalLights.prototype.copy.gevInPlace, undefined);
});
