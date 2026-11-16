import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MARKER_TINT_ALPHA_FLOOR,
  formatKmlColor,
  isNeutralTint,
  kmlColor,
  kmlTintColor,
  markerTintAlpha,
} from './kmlTint.js';

test('a KML colour is aabbggrr, not rrggbbaa', () => {
  assert.deepEqual(kmlColor('ff0000ff'), [1, 0, 0, 1]);
  assert.deepEqual(kmlColor('8000ff00'), [0, 1, 0, 128 / 255]);
  assert.equal(kmlColor('red'), null);
  assert.equal(kmlColor(''), null);
});

test('the black an ArcGIS export writes is a placeholder, not a colour', () => {
  // Opaque black and transparent black are the same placeholder.
  assert.equal(isNeutralTint(kmlColor('ff000000')), true);
  assert.equal(isNeutralTint(kmlColor('00000000')), true);
  assert.equal(isNeutralTint([0.01, 0.01, 0.01, 1]), true);
  // Near-white is the other placeholder.
  assert.equal(isNeutralTint([1, 1, 1, 1]), true);
  assert.equal(isNeutralTint([0.96, 0.96, 0.96, 1]), true);
  // A colour that says something is not a placeholder.
  assert.equal(isNeutralTint([1, 0, 0, 1]), false);
  assert.equal(isNeutralTint([0, 0.5, 1, 0.5]), false);
  // No colour at all says nothing.
  assert.equal(isNeutralTint(null), true);
  assert.equal(isNeutralTint(undefined), true);
});

test('a tint is never fainter than the floor, so no colour can hide a marker', () => {
  assert.equal(MARKER_TINT_ALPHA_FLOOR, 0.35);
  // A quarter opaque is lifted to the floor.
  assert.equal(markerTintAlpha(0.25), MARKER_TINT_ALPHA_FLOOR);
  // A fully transparent tint is lifted too: it would erase the marker.
  assert.equal(markerTintAlpha(0), MARKER_TINT_ALPHA_FLOOR);
  // An opaque tint is left alone, and nothing is made more than opaque.
  assert.equal(markerTintAlpha(1), 1);
  assert.equal(markerTintAlpha(2), 1);
  assert.equal(markerTintAlpha(null), 1);
  assert.equal(markerTintAlpha(Number.NaN), 1);
});

test('a placeholder tints nothing and a real colour tints as it asks', () => {
  // The ArcGIS placeholder: no tint at all.
  assert.equal(kmlTintColor('ff000000'), null);
  assert.equal(kmlTintColor('00000000'), null);
  assert.equal(kmlTintColor('ffffffff'), null);
  // A real colour keeps its hue, with the alpha floored. KML writes
  // `aabbggrr`, so a red at full opacity is `ff0000ff` and a red at the
  // floor is `590000ff`.
  assert.equal(kmlTintColor('ff0000ff'), 'ff0000ff');
  assert.equal(kmlTintColor('400000ff'), '590000ff');
  // A colour that is not a KML colour tints nothing.
  assert.equal(kmlTintColor('red'), null);
  assert.equal(kmlTintColor(''), null);
});

test('a colour survives the round trip through the KML format', () => {
  assert.equal(formatKmlColor([1, 0, 0, 1]), 'ff0000ff');
  assert.equal(formatKmlColor([0, 1, 0, 0.5]), '8000ff00');
  assert.equal(formatKmlColor(null), null);
});
