import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STYLE_ANIM_FRAME_INTERVAL_MS,
  STYLE_ANIM_FPS_OVERRIDE_CAP,
  resolveStyleAnimFrameIntervalMs,
  styleAnimShouldAdvance,
} from './styleAnimationCadence.js';

test('default cadence is 30 Hz (~33 ms), the shared low-demand rate', () => {
  assert.equal(STYLE_ANIM_FRAME_INTERVAL_MS, 33);
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '' }), 33);
});

test('?styleAnimFps=N overrides the cadence, clamped to a sane range', () => {
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '?styleAnimFps=60' }), 17);
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '?styleAnimFps=1' }), 1000);
  // Above the cap (120) → clamped to the cap's interval.
  assert.equal(
    resolveStyleAnimFrameIntervalMs({ search: `?styleAnimFps=${STYLE_ANIM_FPS_OVERRIDE_CAP * 10}` }),
    Math.max(1, Math.round(1000 / STYLE_ANIM_FPS_OVERRIDE_CAP)),
  );
  // Garbage and sub-1 values fall back to the default.
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '?styleAnimFps=zero' }), 33);
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '?styleAnimFps=0' }), 33);
  assert.equal(resolveStyleAnimFrameIntervalMs({ search: '?styleAnimFps=-30' }), 33);
});

test('styleAnimShouldAdvance spaces advances by at least the interval', () => {
  // Fresh arm (-Infinity) always advances immediately.
  assert.equal(styleAnimShouldAdvance(Number.NEGATIVE_INFINITY, 0), true);
  assert.equal(styleAnimShouldAdvance(Number.NEGATIVE_INFINITY, 5), true);
  // Inside the window → skip.
  assert.equal(styleAnimShouldAdvance(0, 16), false);
  assert.equal(styleAnimShouldAdvance(0, 32), false);
  // At/after the interval → advance.
  assert.equal(styleAnimShouldAdvance(0, 33), true);
  assert.equal(styleAnimShouldAdvance(0, 100), true);
});

test('styleAnimShouldAdvance honors a custom interval and non-finite guards', () => {
  assert.equal(styleAnimShouldAdvance(0, 100, 100), true);
  assert.equal(styleAnimShouldAdvance(0, 99, 100), false);
  // Non-finite or non-positive interval disables throttling entirely.
  assert.equal(styleAnimShouldAdvance(0, 0, Number.NaN), true);
  assert.equal(styleAnimShouldAdvance(0, 0, 0), true);
  assert.equal(styleAnimShouldAdvance(0, 0, -5), true);
});
