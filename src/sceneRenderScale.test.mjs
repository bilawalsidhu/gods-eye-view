// src/sceneRenderScale.test.mjs — render-resolution scale policy.
//
// Pins the three policy branches (low-dpr / high-dpr / override), the override
// clamp, and the idempotent apply. The single biggest GPU win on HiDPI: at
// 2560×1440 @ DPR 2, scaling to 0.75 cuts color+depth backing-store memory
// from ~106 MiB to ~60 MiB and fragment bandwidth ~44%, with negligible
// visible loss (MSAA 2× hides the upscale).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_RENDER_SCALE_HIGH_DPR,
  DEFAULT_RENDER_SCALE_LOW_DPR,
  resolveSceneRenderScale,
  applySceneRenderScale,
} from './sceneRenderScale.js';

const HIGH_DPR_THRESHOLD = 1.5;

test('resolveSceneRenderScale: low-DPR returns native scale', () => {
  const result = resolveSceneRenderScale({ search: '', devicePixelRatio: 1 });
  assert.equal(result.scale, DEFAULT_RENDER_SCALE_LOW_DPR);
  assert.equal(result.source, 'low-dpr');
});

test('resolveSceneRenderScale: at the high-DPR threshold returns native', () => {
  // The boundary is exclusive on the high side, so 1.5 still gets native.
  const result = resolveSceneRenderScale({ search: '', devicePixelRatio: HIGH_DPR_THRESHOLD });
  assert.equal(result.scale, DEFAULT_RENDER_SCALE_LOW_DPR);
  assert.equal(result.source, 'low-dpr');
});

test('resolveSceneRenderScale: high-DPR returns the high-DPR scale', () => {
  const result = resolveSceneRenderScale({ search: '', devicePixelRatio: 2 });
  assert.equal(result.scale, DEFAULT_RENDER_SCALE_HIGH_DPR);
  assert.equal(result.source, 'high-dpr');
  assert.ok(result.scale < 1, 'the high-DPR scale must be below native');
});

test('resolveSceneRenderScale: ?renderScale=N overrides any DPR-based default', () => {
  const result = resolveSceneRenderScale({ search: '?renderScale=1.5', devicePixelRatio: 1 });
  assert.equal(result.scale, 1.5);
  assert.equal(result.source, 'override');
});

test('resolveSceneRenderScale: override clamps below MAX_RENDER_SCALE', () => {
  const result = resolveSceneRenderScale({ search: '?renderScale=999', devicePixelRatio: 1 });
  assert.equal(result.scale, 2.0, 'must clamp to the documented ceiling');
  assert.equal(result.source, 'override');
});

test('resolveSceneRenderScale: override clamps above MIN_RENDER_SCALE', () => {
  const result = resolveSceneRenderScale({ search: '?renderScale=0.1', devicePixelRatio: 1 });
  assert.equal(result.scale, 0.5, 'must clamp to the documented floor');
  assert.equal(result.source, 'override');
});

test('resolveSceneRenderScale: non-numeric override falls through to DPR branch', () => {
  const result = resolveSceneRenderScale({ search: '?renderScale=banana', devicePixelRatio: 2 });
  assert.equal(result.scale, DEFAULT_RENDER_SCALE_HIGH_DPR);
  assert.equal(result.source, 'high-dpr');
});

test('applySceneRenderScale: writes sceneResolutionScale and returns policy', () => {
  const scene = { sceneResolutionScale: 1 };
  const viewer = { scene };
  const result = applySceneRenderScale(viewer, { scale: 0.75, source: 'high-dpr' });
  assert.deepEqual(result, { scale: 0.75, source: 'high-dpr' });
  assert.equal(scene.sceneResolutionScale, 0.75);
});

test('applySceneRenderScale: null viewer is a safe no-op', () => {
  assert.equal(applySceneRenderScale(null), null);
});
