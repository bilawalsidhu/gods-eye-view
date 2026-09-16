// src/ui/styleTransitionLoop.test.mjs
// Pure core of the StyleManager style-animation loop (Batch G carve-out).
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STYLE_TRANSITION_DURATION_MS,
  ANIMATED_STAGE_VISIBLE_EPSILON,
  easeInOutQuad,
  sampleStyleTransition,
  advanceStageClocks,
  styleLoopNeedsWork,
} from './styleTransitionLoop.js';

test('easeInOutQuad hits the canonical quadratic in-out shape', () => {
  assert.equal(easeInOutQuad(0), 0);
  assert.equal(easeInOutQuad(0.5), 0.5);
  assert.equal(easeInOutQuad(1), 1);
  // Accelerating first half, decelerating second half.
  assert.ok(easeInOutQuad(0.25) < 0.25, 'slow start');
  assert.ok(easeInOutQuad(0.75) > 0.75, 'fast middle');
  assert.equal(easeInOutQuad(0.25), 1 - easeInOutQuad(0.75), 'point symmetry');
});

test('sampleStyleTransition interpolates the crossfade and reports completion', () => {
  const t = { start: 1000, from: 0, to: 1 };
  const start = sampleStyleTransition(t, 1000);
  assert.equal(start.value, 0);
  assert.equal(start.done, false);

  const mid = sampleStyleTransition(t, 1000 + STYLE_TRANSITION_DURATION_MS / 2);
  assert.equal(mid.value, 0.5);
  assert.equal(mid.done, false);

  const quarter = sampleStyleTransition(t, 1000 + STYLE_TRANSITION_DURATION_MS / 4);
  assert.ok(quarter.value > 0 && quarter.value < 0.5, 'eased quarter is below linear half');
  assert.equal(quarter.done, false);

  const end = sampleStyleTransition(t, 1000 + STYLE_TRANSITION_DURATION_MS);
  assert.equal(end.value, 1);
  assert.equal(end.done, true);

  const past = sampleStyleTransition(t, 1000 + STYLE_TRANSITION_DURATION_MS * 3);
  assert.equal(past.value, 1, 'clamps at the target');
  assert.equal(past.done, true);
});

test('sampleStyleTransition handles fade-out and clamps a negative elapsed', () => {
  const out = sampleStyleTransition({ start: 0, from: 0.8, to: 0.2 }, STYLE_TRANSITION_DURATION_MS);
  assert.ok(Math.abs(out.value - 0.2) < 1e-12);
  assert.equal(out.done, true);

  const early = sampleStyleTransition({ start: 500, from: 0, to: 1 }, 400);
  assert.equal(early.value, 0, 'never samples before the start');
  assert.equal(early.done, false);
});

test('advanceStageClocks ticks only enabled time-uniform stages', () => {
  const stages = new Map([
    ['retro', { enabled: true, uniforms: { time: 0, intensity: 0.7 } }],
    ['noir', { enabled: true, uniforms: { intensity: 0.5 } }], // static: no time uniform
    ['snow', { enabled: false, uniforms: { time: 0, intensity: 0.9 } }], // disabled
  ]);

  const visible = advanceStageClocks(stages, 12.5);
  assert.equal(stages.get('retro').uniforms.time, 12.5, 'enabled animated stage ticks');
  assert.equal(stages.get('snow').uniforms.time, 0, 'disabled stage does not tick');
  assert.equal(visible, true, 'a visible animated stage keeps the loop alive');
});

test('advanceStageClocks: a zero-intensity (chain-mode) stage never holds the loop', () => {
  const stages = new Map([
    ['crt', { enabled: true, uniforms: { time: 0, intensity: ANIMATED_STAGE_VISIBLE_EPSILON / 2 } }],
    ['snow', { enabled: true, uniforms: { time: 0, intensity: 0 } }],
  ]);
  stages.get('snow').uniforms.time = 5; // proves the guard is on intensity, not presence

  const visible = advanceStageClocks(stages, 6);
  assert.equal(stages.get('crt').uniforms.time, 6, 'time still advances (pass parity)');
  assert.equal(visible, false, 'invisible stages release the loop');
});

test('styleLoopNeedsWork: transitions or a visible stage keep it alive', () => {
  assert.equal(styleLoopNeedsWork(1, false), true);
  assert.equal(styleLoopNeedsWork(0, true), true);
  assert.equal(styleLoopNeedsWork(0, false), false, 'settled');
  assert.equal(styleLoopNeedsWork(2, true), true);
});
