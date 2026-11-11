// The overlay's labels and glyph scale; its painting over the badges is in
// render/display.test.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAlprNode } from './records.js';
import { alprLabelDetails, markerScale } from './visuals.js';

test('adapter labels never claim a custom source is public OSM data', () => {
  assert.deepEqual(
    alprLabelDetails(
      { manufacturer: 'Vendor', operator: 'Vendor' },
      { label: 'Custom directory' },
    ),
    ['Source: Custom directory', 'VENDOR'],
  );
});

test('a mapped bearing that rounds up to a whole turn reads 0°, not 360°', () => {
  const direction = (tag) =>
    alprLabelDetails(
      normalizeAlprNode({
        type: 'node',
        id: 1,
        lat: 30,
        lon: -97,
        tags: { 'surveillance:type': 'ALPR', 'camera:direction': tag },
      }),
      { label: 'Custom directory' },
    ).find((line) => line.startsWith('DIRECTION'));
  assert.equal(direction('359.6'), 'DIRECTION 0°');
  assert.equal(direction('359.4'), 'DIRECTION 359°');
  assert.equal(direction('0.4'), 'DIRECTION 0°');
});

test('overlay glyphs and native badges shrink alike with distance', () => {
  assert.equal(markerScale(100), 1.15);
  assert.equal(markerScale(40_000), 0.45);
  assert.equal(markerScale(90_000), 0.45);
  assert.ok(Math.abs(markerScale(20_250) - 0.8) < 1e-9);
});
