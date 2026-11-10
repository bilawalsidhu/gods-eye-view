import test from 'node:test';
import assert from 'node:assert/strict';
import { BasicDepthPacking, Matrix4, RGBADepthPacking, Uniform } from 'three';
import {
  GROUND_SURFACE_GLSL,
  groundSurfaceUniforms,
  updateGroundSurface,
} from './surface.js';

// Execute the scalar shader decision with the same inputs as a depth texel.
const classify = new Function(
  'abs',
  `${GROUND_SURFACE_GLSL.replace('float groundSurfaceType', 'function groundSurfaceType').replaceAll(/float (\w+)/g, '$1')}
  return groundSurfaceType;`,
)(Math.abs);

for (const [name, depth, surface, globe, expected] of [
  ['only globe depth after the scene depth is cleared', 0.6, 1, 0.6, 1],
  ['only tile depth', 0.4, 0.4, 1, 2],
  ['tiles in front of the globe', 0.4, 0.4, 0.6, 2],
  ['globe in front of tiles', 0.4, 0.6, 0.4, 1],
  ['globe retained in the scene depth', 0.6, 0.6, 0.6, 1],
  ['visible globe with a different scene depth', 0.6, 0.4, 0.6, 1],
  [
    'globe with scene depth differing by one depth step',
    0.6,
    0.6 - 6e-8,
    0.6,
    1,
  ],
  ['forward mesh in front of the globe', 0.2, 0.6, 0.6, 0],
  ['forward mesh in front of tiles', 0.2, 0.4, 0.6, 0],
  ['no ground depth', 1, 1, 1, 0],
  ['forward mesh without ground', 0.2, 1, 1, 0],
]) {
  test(`ground classification: ${name}`, () => {
    assert.equal(classify(depth, surface, globe), expected);
  });
}

test('ground depth bindings refresh together and require the globe packing they decode', () => {
  const effect = {
    uniforms: new Map([
      ...groundSurfaceUniforms(),
      ['tGlobeDepth', new Uniform(null)],
    ]),
  };
  const camera = { projectionMatrixInverse: new Matrix4(), far: 1000 };
  const target = { depthTexture: {} };
  const context = { getRenderTarget: () => target };
  const mrt = {
    depthBuffer: {},
    depthBufferPacking: RGBADepthPacking,
    globeDepthBuffer: {},
    globeDepthBufferPacking: RGBADepthPacking,
  };
  for (let frame = 0; frame < 2; frame++) {
    mrt.depthBuffer = {};
    mrt.globeDepthBuffer = {};
    target.depthTexture = {};
    updateGroundSurface(effect, camera, context, mrt);
    assert.equal(effect.uniforms.get('tAllDepth').value, mrt.depthBuffer);
    assert.equal(
      effect.uniforms.get('tGlobeDepth').value,
      mrt.globeDepthBuffer,
    );
    assert.equal(
      effect.uniforms.get('tSurfaceDepth').value,
      target.depthTexture,
    );
  }
  mrt.globeDepthBufferPacking = BasicDepthPacking;
  assert.throws(
    () => updateGroundSurface(effect, camera, context, mrt),
    /packed globe depth/,
  );
});
