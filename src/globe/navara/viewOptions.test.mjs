import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NAVARA_CONTEXT_ATTRIBUTES,
  navaraScenePlan,
  navaraViewOptions,
} from './viewOptions.js';

test('the product view renders on demand with MSAA 4 at the native pixel ratio', () => {
  const container = { id: 'globe' };
  const canvas = { id: 'canvas' };
  assert.deepEqual(navaraViewOptions({ container, canvas }), {
    container,
    canvas,
    animation: false,
    multisampling: 4,
  });
  assert.equal(
    navaraViewOptions({ container, pixelRatio: 1 }).pixelRatio,
    1,
    'measurements pin the pixel ratio',
  );
});

test('the canvas context keeps its drawing buffer, with the attributes Navara asks for', () => {
  assert.deepEqual(NAVARA_CONTEXT_ATTRIBUTES, {
    alpha: true,
    antialias: true,
    depth: true,
    stencil: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,
    powerPreference: 'default',
  });
});

test('effects=minimal is the default look: sky, stars and sun light, no post effects (S5)', () => {
  assert.deepEqual(navaraScenePlan(), {
    pluginDefault: false,
    meshes: ['sky', 'stars'],
    lights: ['skyLightProbe', 'sun'],
    effects: [],
  });
  assert.equal(navaraScenePlan('photoreal').pluginDefault, true);
  assert.throws(() => navaraScenePlan('cinematic'), RangeError);
});
