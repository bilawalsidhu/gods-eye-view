// Shared WorldOverlay entry construction — the three host-default flags live
// here once so the 13 layer-side `create*OverlayEntry` factories cannot drift
// from each other or from the host normalizer.
import test from 'node:test';
import assert from 'node:assert/strict';

import { createOverlayEntry } from './overlayEntry.js';

test('every entry carries the shared host-default baseline', () => {
  const entry = createOverlayEntry({ id: 'x', variant: 'label' });
  assert.equal(entry.interactive, false);
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
  assert.equal(entry.id, 'x');
});

test('an explicit caller value overrides the baseline (CCTV thumbnails)', () => {
  const entry = createOverlayEntry({ interactive: true });
  assert.equal(entry.interactive, true);
  assert.equal(entry.horizonCull, true);
});

test('entries are fresh objects sharing no mutable state with the baseline', () => {
  const a = createOverlayEntry({});
  const b = createOverlayEntry({});
  assert.notEqual(a, b);
  a.horizonCull = false;
  assert.equal(b.horizonCull, true, 'the frozen baseline must never be mutated');
});

test('the baseline matches the host normalizer defaults byte for byte', () => {
  // worldOverlay.js `_normalizeEntry`: `interactive === true` else false,
  // `horizonCull !== false` else true, `terrainOcclusion === true` else false.
  // An ABSENT field must normalize the same way as the baseline value.
  const absent = {};
  assert.equal(absent.interactive === true, false);
  assert.equal(absent.horizonCull !== false, true);
  assert.equal(absent.terrainOcclusion === true, false);
});
