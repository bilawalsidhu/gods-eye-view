import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import {
  createTrackedHologram,
  hologramSolidBlend,
} from './trackedHologram.js';

const AMBER = Cesium.Color.fromCssColorString('#FFB800');
const hologram = () =>
  createTrackedHologram({ civil: Cesium.Color.CYAN, military: AMBER });
const hue = (options) => options.customShader.uniforms.u_col.value;

test('a civil aircraft gets the cyan hologram and a military one the amber', () => {
  const h = hologram();
  assert.deepEqual(
    [hue(h.modelOptions(false)).x, hue(h.modelOptions(false)).y],
    [0, 1],
  );
  const amber = hue(h.modelOptions(true));
  assert.equal(amber.x, 1);
  assert.ok(Math.abs(amber.y - AMBER.green) < 1e-9);
  assert.equal(amber.z, 0);
});

test('the creation options leave the shader in charge of the hue', () => {
  const options = hologram().modelOptions(false);
  assert.equal(options.colorBlendAmount, 0);
  assert.ok(Cesium.Color.equals(options.color, Cesium.Color.WHITE));
  assert.equal(options.backFaceCulling, false);
  assert.ok(options.customShader instanceof Cesium.CustomShader);
});

test('a small model turns solid and a large one stays holographic', () => {
  assert.equal(hologramSolidBlend(40), 1);
  assert.equal(hologramSolidBlend(200), 0);
  const mid = hologramSolidBlend(105);
  assert.ok(mid > 0 && mid < 1);
});

test('tick advances the shader clock and solid blend', () => {
  const h = hologram();
  const { customShader } = h.modelOptions(true);
  h.tick(true, 40, 2500);
  assert.equal(customShader.uniforms.u_time.value, 2.5);
  assert.equal(customShader.uniforms.u_far.value, 1);
  h.tick(true, 400, 3000);
  assert.equal(customShader.uniforms.u_far.value, 0);
});

test('the clock wraps without leaving the float-safe range', () => {
  const h = hologram();
  const { customShader } = h.modelOptions(false);
  h.tick(false, 400, 5_000_000);
  assert.ok(customShader.uniforms.u_time.value < 1000);
});
