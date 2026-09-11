import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  OSM_OVERLAYS,
  applyOsmOverlayParams,
  osmOverlaysHiddenReason,
} from './osmOverlays.js';

test('OSM_OVERLAYS: exactly the two shipped overlays, each with a tile template and credit', () => {
  assert.deepEqual(OSM_OVERLAYS.map((o) => o.key), ['seamap', 'snowmap']);
  for (const overlay of OSM_OVERLAYS) {
    assert.match(overlay.urlTemplate, /\{z\}.*\{x\}.*\{y\}/);
    assert.ok(overlay.credit);
  }
});

test('osmOverlaysHiddenReason: null when disabled, nothing chosen, or the globe is shown', () => {
  assert.equal(osmOverlaysHiddenReason(false, { seamap: true, snowmap: true }, false), null);
  assert.equal(osmOverlaysHiddenReason(true, { seamap: false, snowmap: false }, false), null);
  assert.equal(osmOverlaysHiddenReason(true, { seamap: true, snowmap: false }, true), null);
});

test('osmOverlaysHiddenReason: explains itself when enabled + chosen but the photoreal globe is hidden', () => {
  const reason = osmOverlaysHiddenReason(true, { seamap: true, snowmap: false }, false);
  assert.ok(reason && /globe/i.test(reason));
});

test('applyOsmOverlayParams: flips only known keys with boolean values, reports whether anything changed', () => {
  const current = { seamap: true, snowmap: true };
  const a = applyOsmOverlayParams(current, { seamap: false });
  assert.deepEqual(a.next, { seamap: false, snowmap: true });
  assert.equal(a.changed, true);

  const b = applyOsmOverlayParams(current, { seamap: true });
  assert.deepEqual(b.next, current);
  assert.equal(b.changed, false);

  const c = applyOsmOverlayParams(current, { unknownKey: false, snowmap: 'nope' });
  assert.deepEqual(c.next, current);
  assert.equal(c.changed, false);
});
