// src/data/modelVisualAnchor.test.mjs
// Branch-floor pass (cycle 4) for the model-space anchor tables and the two
// transform helpers. modelScale.test.mjs locks the anchor VALUES against the
// shipped GLBs; what is pinned here is the fallback and coercion CONTRACT:
// unknown assets, malformed scales, and every quiet exit of trailHeadStart.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as Cesium from 'cesium';

import {
  MODEL_TRAIL_ANCHOR_NATIVE,
  MODEL_VISUAL_CENTER_NATIVE,
  modelAnchorWorld,
  modelVisualAnchor,
  trailAnchorForModel,
  trailHeadStart,
  visualCenterForModel,
} from './modelVisualAnchor.js';

const IDENTITY = Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY);
const vec = (x, y, z) => ({ x, y, z });

test('visual centre: approved assets resolve from the table, unknown assets are origin-centred', () => {
  assert.deepEqual(visualCenterForModel('/models/airplane.glb'), MODEL_VISUAL_CENTER_NATIVE['/models/airplane.glb']);
  assert.deepEqual(visualCenterForModel('/models/jet.glb'), [0, 0, 0]);
  assert.deepEqual(visualCenterForModel('/models/not-shipped.glb'), [0, 0, 0],
    'assets absent from the table were audited as origin-centred — the fallback IS the audit');
  assert.deepEqual(visualCenterForModel(undefined), [0, 0, 0]);
});

test('trail anchor: every shipped airframe resolves, unknown assets fall back to the centre', () => {
  assert.equal(trailAnchorForModel('/models/airplane.glb'), MODEL_TRAIL_ANCHOR_NATIVE['/models/airplane.glb']);
  assert.ok(trailAnchorForModel('/models/mq9.glb').every(Number.isFinite));
  assert.deepEqual(trailAnchorForModel('/models/not-shipped.glb'), [0, 0, 0],
    'an unmeasured future asset trails from its visual centre, not from a guessed hull point');
});

test('modelAnchorWorld: null guards return null, nothing throws', () => {
  const model = { modelMatrix: IDENTITY };
  assert.equal(modelAnchorWorld(null, [1, 2, 3], {}), null);
  assert.equal(modelAnchorWorld({}, [1, 2, 3], {}), null, 'no modelMatrix');
  assert.equal(modelAnchorWorld(model, null, {}), null);
  assert.equal(modelAnchorWorld(model, [1, 2, 3], null), null);
});

test('modelAnchorWorld: identity modelMatrix applies exactly Cesium’s full axis correction', () => {
  // The file's own doc: full correction maps raw glTF [x, y, z] -> [z, x, y].
  const out = modelAnchorWorld(
    { modelMatrix: IDENTITY, computedScale: 2 },
    [24.0879, -2.2163, 0],
    vec(0, 0, 0),
  );
  assert.equal(out.x, 0);
  assert.ok(Math.abs(out.y - 48.1758) < 1e-9);
  assert.ok(Math.abs(out.z - -4.4326) < 1e-9);
});

test('modelAnchorWorld: a non-finite computedScale behaves as 1 and a baked root transform rides along', () => {
  const withRoot = {
    modelMatrix: IDENTITY,
    computedScale: Number.NaN,
    sceneGraph: { components: { transform: Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(10, 0, 0)) } },
  };
  const out = modelAnchorWorld(withRoot, [1, 0, 0], vec(0, 0, 0));
  // glTF [1,0,0] → correction → [0,1,0]; root translation is in the corrected
  // chain, so it adds (10, 0, 0) — the doc's "carried too" contract.
  assert.ok(Math.abs(out.x - 10) < 1e-9);
  assert.ok(Math.abs(out.y - 1) < 1e-9);
  // Absent components coerce to 0 rather than poisoning the offset with NaN.
  const sparse = modelAnchorWorld(
    { modelMatrix: IDENTITY, computedScale: 3 },
    [undefined, 2, undefined],
    vec(0, 0, 0),
  );
  assert.deepEqual([sparse.x, sparse.y, sparse.z], [0, 0, 6],
    'scratch y=6 → the axis correction maps (0,6,0) to (0,0,6)');
});

test('modelVisualAnchor: guards, malformed centres, and non-finite scales', () => {
  assert.equal(modelVisualAnchor(null, [1, 2, 3], 1, {}), null);
  assert.equal(modelVisualAnchor(IDENTITY, [1, 2, 3], 1, null), null);
  const out = modelVisualAnchor(IDENTITY, undefined, Number.NaN, vec(9, 9, 9));
  assert.deepEqual([out.x, out.y, out.z], [0, 0, 0],
    'no centre and no scale → the model origin, exactly');
});

test('modelVisualAnchor: translation and scale land in the translation column', () => {
  const m = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(100, 200, 300));
  const out = modelVisualAnchor(m, [1, 2, 3], 2, vec(0, 0, 0));
  assert.deepEqual([out.x, out.y, out.z], [102, 204, 306]);
});

test('trailHeadStart: missing pieces never lose a real trail', () => {
  const start = vec(80, 0, 0);
  const anchor = vec(60, 0, 0);
  const center = vec(0, 0, 0);
  const result = vec(0, 0, 0);
  assert.equal(trailHeadStart(null, anchor, center, 100, result), null);
  assert.equal(trailHeadStart(start, null, center, 100, result), start, 'no anchor → draw it all');
  assert.equal(trailHeadStart(start, anchor, null, 100, result), start, 'no centre → draw it all');
  assert.equal(trailHeadStart(start, anchor, center, 100, null), start, 'nowhere to put the answer → draw it all');
  assert.equal(trailHeadStart(start, anchor, center, Number.NaN, result), start, 'an untrustable radius → draw it all');
  assert.equal(trailHeadStart(start, anchor, center, 0, result), start);
  assert.equal(trailHeadStart(start, anchor, center, -5, result), start);
});

test('trailHeadStart: outside the envelope the segment is bit-identical to containment', () => {
  const start = vec(100, 0, 0);
  const out = trailHeadStart(start, vec(60, 0, 0), vec(0, 0, 0), 100, vec(0, 0, 0));
  assert.equal(out, start, 'startD >= radiusM draws from the true start, unmodified');
});

test('trailHeadStart: the reveal ramps continuously through the shell', () => {
  const anchor = vec(60, 0, 0);
  const center = vec(0, 0, 0);
  // Exactly at the anchor station: nothing is drawn (a parked contact).
  assert.equal(trailHeadStart(vec(60, 0, 0), anchor, center, 100, vec(0, 0, 0)), null);
  // Below the anchor station: still nothing — that would draw into the fuselage.
  assert.equal(trailHeadStart(vec(30, 0, 0), anchor, center, 100, vec(0, 0, 0)), null);
  // Mid-shell: the drawn start slides halfway from the anchor to the true start.
  const mid = trailHeadStart(vec(80, 0, 0), anchor, center, 100, vec(0, 0, 0));
  assert.deepEqual([mid.x, mid.y, mid.z], [70, 0, 0]);
  // A degenerate shell (anchor at the envelope) refuses to divide by zero.
  assert.equal(trailHeadStart(vec(80, 0, 0), vec(100, 0, 0), center, 100, vec(0, 0, 0)), null,
    'no shipped asset has this, so the fallback is the containment verdict: nothing');
});
