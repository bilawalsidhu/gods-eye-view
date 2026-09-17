// src/layers/cctv/modelSpecs.test.mjs
// Hardware-model spec enrichment: lookup semantics (case-insensitive, alias
// matching, unknown → null — never a guess), datasheet-FOV parsing across the
// real fov_deg string shapes, and the HUD spec-summary line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupModelSpec,
  horizontalFovDeg,
  specSummary,
} from './modelSpecs.js';

test('lookupModelSpec matches case-insensitively and trims', () => {
  const spec = lookupModelSpec('  q6135-le ');
  assert.ok(spec);
  assert.equal(spec.brand, 'Axis');
  assert.equal(lookupModelSpec('Q6135-LE'), spec);
});

test('lookupModelSpec matches aliases', () => {
  const byAlias = lookupModelSpec('01959-004');
  assert.ok(byAlias);
  assert.equal(byAlias.model, 'Q6135-LE');
});

test('vendored table covers the integrated catalogs published hardware', () => {
  // Models the live packs publish: King County (Cohu, AUTODOME IP 5000i),
  // Sarasota (Bosch AUTODOME 7000/VG4), Sioux Falls (Axis).
  const cohu = lookupModelSpec('3950'); // King County publishes "3950"
  assert.equal(cohu?.brand, 'Cohu');
  const autodome = lookupModelSpec('AUTODOME IP 5000i');
  assert.ok(autodome && horizontalFovDeg(autodome) > 0);
  const vg4 = lookupModelSpec('VG4 AUTODOME H.264'); // Sarasota's string
  assert.ok(vg4);
  const axis = lookupModelSpec('Q6155-E'); // Sioux Falls
  assert.equal(horizontalFovDeg(axis), 66.7);
});

test('lookupModelSpec returns null for unknown or empty input — never guesses', () => {
  assert.equal(lookupModelSpec('NOT-A-REAL-MODEL'), null);
  assert.equal(lookupModelSpec(''), null);
  assert.equal(lookupModelSpec(null), null);
  assert.equal(lookupModelSpec(undefined), null);
});

test('horizontalFovDeg takes the wide end of a varifocal/PTZ range', () => {
  // '58.3-2.4 horizontal' → 58.3 (wide), not 2.4 (tele).
  assert.equal(horizontalFovDeg(lookupModelSpec('Q6135-LE')), 58.3);
});

test('horizontalFovDeg reads multi-variant and plain fov strings', () => {
  // '108.8 horizontal (2.8mm) / 93.3 horizontal (4mm)' → first variant.
  assert.equal(horizontalFovDeg(lookupModelSpec('DS-2CD2087G3-LI2UY')), 108.8);
  // '110 horizontal, 60 vertical' → horizontal figure.
  assert.equal(horizontalFovDeg(lookupModelSpec('F4105-LRE')), 110);
});

test('horizontalFovDeg returns null when no numeric FOV is stated', () => {
  assert.equal(horizontalFovDeg({ fov_deg: '' }), null);
  assert.equal(horizontalFovDeg({ fov_deg: 'wide dynamic range' }), null);
  assert.equal(horizontalFovDeg({}), null);
  assert.equal(horizontalFovDeg(null), null);
});

test('specSummary renders the HUD line and degrades by omission', () => {
  assert.equal(
    specSummary(lookupModelSpec('Q6135-LE')),
    'Axis Q6135-LE · 1080p · IR 250m · PTZ',
  );
  // No night vision / no PTZ → those segments are simply absent.
  assert.equal(
    specSummary({ brand: 'Axis', model: 'X', resolution: { label: '4K' } }),
    'Axis X · 4K',
  );
  assert.equal(specSummary(null), '');
});
