import test from 'node:test';
import assert from 'node:assert/strict';
import { selectExternalModel, T96_FITTED_RANGE } from './external.js';

const full = Object.freeze({
  unavailable: false,
  dynamicPressureNPa: 2.1,
  dst: -35,
  byNT: 3,
  bzNT: -4,
  kp: 3.33,
});

test('prefers T96 when the feed carries all four of its inputs', () => {
  const model = selectExternalModel(full);
  assert.equal(model.name, 't96');
  assert.deepEqual(model.parameters, {
    pdyn: 2.1,
    dst: -35,
    byimf: 3,
    bzimf: -4,
  });
  assert.equal(model.extrapolated, false);
});

test('falls back to T89 when any T96 input is missing', () => {
  for (const missing of ['dynamicPressureNPa', 'dst', 'byNT', 'bzNT']) {
    const state = { ...full, [missing]: null };
    const model = selectExternalModel(state);
    assert.equal(model.name, 't89', `dropping ${missing} should fall back`);
    // Kp 3.33 lands in band 4; the mapping itself is t89's own test.
    assert.equal(typeof model.parameters, 'number');
  }
});

test('returns null when neither model has its inputs', () => {
  assert.equal(selectExternalModel(null), null);
  assert.equal(selectExternalModel({ unavailable: true }), null);
  assert.equal(
    selectExternalModel({ ...full, dst: null, kp: null }),
    null,
    'no Kp and no IMF means no external field, not a guessed one',
  );
});

test('a non-positive dynamic pressure disqualifies T96 rather than dividing by it', () => {
  // T96 scales the whole magnetosphere by pdyn to the 0.14, so zero or negative
  // pressure is not a quiet solar wind, it is a broken feed.
  for (const pdyn of [0, -1]) {
    const model = selectExternalModel({ ...full, dynamicPressureNPa: pdyn });
    assert.equal(model.name, 't89');
  }
});

test('clamps to the fitted range and says when it had to', () => {
  const storm = selectExternalModel({
    ...full,
    dynamicPressureNPa: 40,
    dst: -250,
    byNT: 25,
    bzNT: -30,
  });
  assert.equal(storm.name, 't96');
  assert.equal(storm.extrapolated, true);
  assert.equal(storm.parameters.pdyn, T96_FITTED_RANGE.pdyn.max);
  assert.equal(storm.parameters.dst, T96_FITTED_RANGE.dst.min);
  assert.equal(storm.parameters.byimf, T96_FITTED_RANGE.byimf.max);
  assert.equal(storm.parameters.bzimf, T96_FITTED_RANGE.bzimf.min);
});

test('the retrace key changes with the field but not with noise', () => {
  const a = selectExternalModel(full).key;
  // A hundredth of a nanopascal moves no field line anyone can see.
  assert.equal(selectExternalModel({ ...full, dynamicPressureNPa: 2.14 }).key, a);
  // A nanopascal does.
  assert.notEqual(selectExternalModel({ ...full, dynamicPressureNPa: 3.1 }).key, a);
  assert.notEqual(selectExternalModel({ ...full, bzNT: -9 }).key, a);
  // And the two models never collide.
  assert.notEqual(selectExternalModel({ ...full, dst: null }).key, a);
});

test('the chosen model evaluates to a finite field', () => {
  // Guards against handing the tracer a model whose parameters it will choke
  // on: a shape mismatch between the selector and the model would show up as
  // NaN on the first step rather than at import time.
  for (const state of [full, { ...full, dst: null }]) {
    const model = selectExternalModel(state);
    const b = model.evaluate(model.parameters, 0.3, -8, 2, 1);
    assert.ok(
      Number.isFinite(b.x) && Number.isFinite(b.y) && Number.isFinite(b.z),
      `${model.name} returned ${JSON.stringify(b)}`,
    );
  }
});
