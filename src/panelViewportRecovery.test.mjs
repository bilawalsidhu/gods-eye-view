import test from 'node:test';
import assert from 'node:assert/strict';
import { clampPanelToViewport } from './panelStackLayout.js';

test('clampPanelToViewport: preserves valid in-bounds positions', () => {
  const result = clampPanelToViewport({
    left: 100,
    top: 150,
    width: 300,
    height: 200,
    viewportWidth: 1920,
    viewportHeight: 1080,
    inset: 6,
  });
  assert.equal(result.left, 100);
  assert.equal(result.top, 150);
});

test('clampPanelToViewport: recovers negative coordinates to safe inset (e.g. x: -192)', () => {
  const result = clampPanelToViewport({
    left: -192,
    top: -50,
    width: 320,
    height: 240,
    viewportWidth: 1920,
    viewportHeight: 1080,
    inset: 6,
  });
  assert.equal(result.left, 6);
  assert.equal(result.top, 6);
});

test('clampPanelToViewport: prevents panel from overflowing right or bottom edge', () => {
  const result = clampPanelToViewport({
    left: 2000,
    top: 1200,
    width: 320,
    height: 200,
    viewportWidth: 1920,
    viewportHeight: 1080,
    inset: 6,
  });
  // maxLeft = 1920 - 320 - 6 = 1594
  // maxTop = 1080 - 200 - 6 = 874
  assert.equal(result.left, 1594);
  assert.equal(result.top, 874);
});

test('clampPanelToViewport: applies fallback dimensions when width or height evaluates to 0', () => {
  // Pre-layout / display:none / unrendered panel returns 0x0
  const result = clampPanelToViewport({
    left: 1800,
    top: 1000,
    width: 0,
    height: 0,
    viewportWidth: 1920,
    viewportHeight: 1080,
    inset: 6,
    fallbackWidth: 320,
    fallbackHeight: 200,
  });
  // Should use fallback width 320 and height 200 rather than assuming 0x0
  assert.equal(result.left, 1594);
  assert.equal(result.top, 874);
});

test('clampPanelToViewport: gracefully handles narrow viewports smaller than panel', () => {
  const result = clampPanelToViewport({
    left: 50,
    top: 50,
    width: 500,
    height: 400,
    viewportWidth: 360,
    viewportHeight: 300,
    inset: 6,
  });
  assert.ok(result.left >= 6, 'left must be at least safe inset');
  assert.ok(result.top >= 6, 'top must be at least safe inset');
});

test('clampPanelToViewport: handles missing, NaN, or non-finite inputs safely', () => {
  const result = clampPanelToViewport({
    left: NaN,
    top: null,
    width: undefined,
    height: 'garbage',
    viewportWidth: 1920,
    viewportHeight: 1080,
  });
  assert.equal(result.left, 6);
  assert.equal(result.top, 6);
});
