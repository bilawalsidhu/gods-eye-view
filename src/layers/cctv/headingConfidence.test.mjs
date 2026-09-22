import test from 'node:test';
import assert from 'node:assert/strict';
import { createCctvSource, createCctvLayer } from './index.js';
import {
  PLANE_ALPHA_SURVEYED_BEARING,
  PLANE_ALPHA_ESTIMATED_BEARING,
} from './policy.js';

function buildLayer(t) {
  const original = globalThis.document;
  globalThis.document = {
    addEventListener() {},
    removeEventListener() {},
  };
  t.after(() => {
    globalThis.document = original;
  });
  const noop = () => {};
  const services = {
    overlays: {
      clearOverlaySource: noop,
      hitTestWorldOverlay: noop,
      setOverlayEntries: noop,
      setOverlaySourceVisible: noop,
    },
    sprites: { registerSpriteCollection: noop },
    activation: {},
    locations: {},
    picking: { unregisterPickOwner: noop },
    terrain: {},
    ground: {},
    mesh: {},
    focus: {},
    render: { releaseContinuousRender: noop },
  };
  return createCctvLayer({ services, source: createCctvSource() });
}

test('only an explicit low-confidence heading counts as estimated', (t) => {
  const layer = buildLayer(t);
  assert.equal(layer.headingIsEstimated({ headingConfidence: 'low' }), true);
  assert.equal(layer.headingIsEstimated({ headingConfidence: 'LOW' }), true);
  assert.equal(layer.headingIsEstimated({ headingConfidence: 'high' }), false);
  assert.equal(
    layer.headingIsEstimated({ headingConfidence: 'medium' }),
    false,
  );
  // Absent provenance never overclaims estimation.
  assert.equal(layer.headingIsEstimated({}), false);
  assert.equal(layer.headingIsEstimated(null), false);
});

test('a manual calibration save clears the estimated-bearing state', (t) => {
  const layer = buildLayer(t);
  assert.equal(
    layer.headingIsEstimated({
      headingConfidence: 'low',
      calSource: 'manual',
    }),
    false,
  );
  // Curated pose alone does not vouch for the facing — only a manual save does.
  assert.equal(
    layer.headingIsEstimated({
      headingConfidence: 'low',
      poseSource: 'curated',
    }),
    true,
  );
});

test('the monitor-plane label marks a synthesized bearing', (t) => {
  const layer = buildLayer(t);
  const estimated = layer.createCctvProjectionOverlayEntry({
    cameraId: 'calgary-142',
    name: 'Camera 142',
    position: null,
    headingEstimated: true,
  });
  assert.deepEqual(estimated.details, ['BEARING ESTIMATED']);
  const surveyed = layer.createCctvProjectionOverlayEntry({
    cameraId: 'auckland-1',
    name: 'Camera 1',
    position: null,
    headingEstimated: false,
  });
  assert.deepEqual(surveyed.details, []);
  // Omitting the flag keeps the shipped (unmarked) presentation.
  const legacy = layer.createCctvProjectionOverlayEntry({
    cameraId: 'auckland-2',
    name: 'Camera 2',
    position: null,
  });
  assert.deepEqual(legacy.details, []);
});

test('an estimated bearing draws the plane visibly more translucent', () => {
  assert.ok(PLANE_ALPHA_ESTIMATED_BEARING < PLANE_ALPHA_SURVEYED_BEARING);
  // "Visibly" — the gap must not erode into a subtlety nobody can see.
  assert.ok(
    PLANE_ALPHA_SURVEYED_BEARING - PLANE_ALPHA_ESTIMATED_BEARING >= 0.25,
  );
});
