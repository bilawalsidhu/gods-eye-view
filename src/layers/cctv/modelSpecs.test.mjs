// src/layers/cctv/modelSpecs.test.mjs
// Hardware-model spec enrichment: lookup semantics (case-insensitive, alias
// matching, unknown → null — never a guess), datasheet-FOV parsing across the
// real fov_deg string shapes, and the HUD spec-summary line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lookupModelSpec,
  horizontalFovRangeDeg,
  fixedHorizontalFovDeg,
  specFovCapabilityToken,
  specSummary,
} from './modelSpecs.js';
import { createCatalog } from './catalog.js';

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
  assert.ok(autodome && horizontalFovRangeDeg(autodome).maxDeg > 0);
  const vg4 = lookupModelSpec('VG4 AUTODOME H.264'); // Sarasota's string
  assert.ok(vg4);
  const axis = lookupModelSpec('Q6155-E'); // Sioux Falls
  assert.deepEqual(horizontalFovRangeDeg(axis), { minDeg: 2.36, maxDeg: 66.7 });
});

test('verbose registry strings resolve via distinctive-token fallback', () => {
  // Sioux Falls publishes the full product title, not the bare model.
  assert.equal(
    lookupModelSpec('AXIS Q6155-E PTZ Dome Network Camera')?.model,
    'Q6155-E',
  );
  assert.equal(lookupModelSpec('AXIS Q6000-E Mk II')?.model, 'Q6000-E Mk II');
  assert.equal(
    lookupModelSpec('AUTODOME IP starlight 7000i camera')?.id,
    'bosch-ndp-7512-z30',
  );
  // Punctuation around the model token doesn't defeat the match.
  assert.equal(
    lookupModelSpec('camera (P3707-PE), outdoor')?.model,
    'P3707-PE',
  );
});

test('token fallback never matches on generic words or wrong models', () => {
  // Only generic descriptors — no distinctive hardware token — stays null.
  assert.equal(lookupModelSpec('PTZ Dome Camera'), null);
  assert.equal(lookupModelSpec('HD Network Camera'), null);
  assert.equal(lookupModelSpec('Outdoor Dome Camera'), null);
  // A real-looking but unknown model resolves to nothing, not a near neighbour.
  assert.equal(lookupModelSpec('AXIS FooBar-9 Network Camera'), null);
  // A generation token alone must not collide with a similar one: "7000"
  // belongs to two records (dynamic / starlight 7000 HD), so a bare
  // "AUTODOME 7000" is ambiguous → null rather than an arbitrary pick.
  assert.equal(lookupModelSpec('AUTODOME 7000'), null);
});

test('exact match still wins over the token fallback', () => {
  // "3965" is an alias of the 3960; exact alias match, not a token scan.
  assert.equal(lookupModelSpec('3965')?.id, 'cohu-3960');
  assert.equal(lookupModelSpec('AUTODOME IP 5000i')?.id, 'bosch-ndp-5502-30');
});

test('lookupModelSpec returns null for unknown or empty input — never guesses', () => {
  assert.equal(lookupModelSpec('NOT-A-REAL-MODEL'), null);
  assert.equal(lookupModelSpec(''), null);
  assert.equal(lookupModelSpec(null), null);
  assert.equal(lookupModelSpec(undefined), null);
});

test('horizontalFovRangeDeg reads the full range across real fov_deg shapes', () => {
  const range = (model) => horizontalFovRangeDeg(lookupModelSpec(model));
  // PTZ zoom: both ends, not just the wide one.
  assert.deepEqual(range('Q6135-LE'), { minDeg: 2.4, maxDeg: 58.3 });
  // Vertical figures never count.
  assert.deepEqual(range('XNP-6400RW'), { minDeg: 1.88, maxDeg: 65.66 });
  // Lens options: parenthesized focal lengths are not FOV figures.
  assert.deepEqual(range('DS-2CD2087G3-LI2UY'), {
    minDeg: 93.3,
    maxDeg: 108.8,
  });
  assert.deepEqual(range('F4105-LRE'), { minDeg: 110, maxDeg: 110 });
  // The "360 combined" panoramic figure is not a horizontal lens FOV.
  assert.deepEqual(range('Q6000-E Mk II'), { minDeg: 113, maxDeg: 152 });
  assert.deepEqual(range('P3707-PE'), { minDeg: 54, maxDeg: 108 });
});

test('horizontalFovRangeDeg returns null when no numeric FOV is stated', () => {
  assert.equal(horizontalFovRangeDeg({ fov_deg: '' }), null);
  assert.equal(horizontalFovRangeDeg({ fov_deg: 'wide dynamic range' }), null);
  assert.equal(horizontalFovRangeDeg({ fov_deg: '60 vertical' }), null);
  assert.equal(horizontalFovRangeDeg({}), null);
  assert.equal(horizontalFovRangeDeg(null), null);
});

test('fixedHorizontalFovDeg is the current FOV only for fixed single-lens hardware', () => {
  // Fixed dome, one horizontal figure: the datasheet IS the optical state.
  assert.equal(fixedHorizontalFovDeg(lookupModelSpec('F4105-LRE')), 110);
  // Known hardware capability != known pose state: PTZ, multi-sensor, and a
  // model sold in several lens options all stay estimated.
  for (const model of [
    'Q6135-LE',
    'XNP-6400RW',
    'AUTODOME IP 5000i',
    'P3707-PE',
    'Q6000-E Mk II',
    'DS-2CD2087G3-LI2UY',
  ]) {
    assert.equal(fixedHorizontalFovDeg(lookupModelSpec(model)), null, model);
  }
  assert.equal(fixedHorizontalFovDeg(null), null);
});

test('specFovCapabilityToken labels a datasheet range as capability, never as current FOV', () => {
  assert.equal(
    specFovCapabilityToken({ specFovMinDeg: 2.4, specFovMaxDeg: 58.3 }),
    'SPEC FOV 2.4–58° (CAPABILITY)',
  );
  assert.equal(
    specFovCapabilityToken({ specFovMinDeg: 113, specFovMaxDeg: 113 }),
    'SPEC FOV 113° (CAPABILITY)',
  );
  // Already the camera's FOV (fixed lens) or nothing known: no token.
  assert.equal(
    specFovCapabilityToken({
      fovSource: 'datasheet',
      specFovMinDeg: 110,
      specFovMaxDeg: 110,
    }),
    null,
  );
  assert.equal(specFovCapabilityToken({}), null);
  assert.equal(specFovCapabilityToken(null), null);
});

/** Browser catalog with the pose math stubbed: only enrichment is under test. */
function browserCatalog() {
  const model = {
    safeNumber: (value, fallback = NaN) =>
      Number.isFinite(Number(value)) ? Number(value) : fallback,
    normalizeHeading: (deg) => ((deg % 360) + 360) % 360,
    clamp: (value, lo, hi) => Math.min(hi, Math.max(lo, value)),
    headingFromId: () => 0,
    normalizeFeedType: (type) => type,
    ensureCameraPose: () => {},
  };
  return createCatalog({
    state: {},
    services: { locations: { CITY_POIS: {} } },
    parts: { model },
    source: {},
  });
}

test('catalog keeps the estimated FOV for PTZ hardware and substitutes only fixed-lens datasheets', () => {
  const [ptz, fixed, unknown] = browserCatalog().buildCatalogFromSources([
    { id: 'ptz', lat: 47.7, lon: -122, fovDeg: 44, model: 'Q6135-LE' },
    { id: 'fixed', lat: 47.7, lon: -122, fovDeg: 44, model: 'F4105-LRE' },
    { id: 'unknown', lat: 47.7, lon: -122, fovDeg: 44, model: 'NOPE-1' },
  ]);

  // PTZ: the frustum keeps its estimate; the datasheet range is metadata.
  assert.equal(ptz.fovDeg, 44);
  assert.equal(ptz.fovSource, undefined);
  assert.equal(ptz.specFovMinDeg, 2.4);
  assert.equal(ptz.specFovMaxDeg, 58.3);
  assert.equal(ptz.spec.model, 'Q6135-LE');

  // Fixed lens: the datasheet figure is the optical state.
  assert.equal(fixed.fovDeg, 110);
  assert.equal(fixed.fovSource, 'datasheet');

  // Unknown hardware changes nothing.
  assert.equal(unknown.fovDeg, 44);
  assert.equal(unknown.spec, undefined);
  assert.equal(unknown.specFovMaxDeg, undefined);
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
