// The HUD summary's locality tag. The 2026-08-20 QA hunt caught the HUD calling
// out landmarks on other continents — NEAR SACRE-COEUR (PARIS) 2470KM while
// parked over Moscow — because the NEAR bound was 2,500 km. These pin the metro
// bound, both sides of it, and the SECTOR fallback that already worked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { composeLocalityTag, NEAR_POI_MAX_KM } from './hudLocality.js';
import { LOCALIZED_LOCALITY } from './hudLocalityFormat.js';
import { setLocale } from './i18n/index.js';

const ALCATRAZ = { poi: 'Alcatraz Island', city: 'San Francisco' };
const LINCOLN = { poi: 'Lincoln Memorial', city: 'Washington DC' };
const SACRE_COEUR = { poi: 'Sacré-Cœur', city: 'Paris' };

test('the NEAR bound is metro scale, not continental', () => {
  assert.equal(NEAR_POI_MAX_KM, 150);
});

test('a landmark under the camera reads NEAR', () => {
  assert.equal(
    composeLocalityTag({ ...ALCATRAZ, distKm: 2.4 }, 37.8267, -122.423),
    'NEAR ALCATRAZ ISLAND (SAN FRANCISCO) 2KM',
  );
  assert.equal(
    composeLocalityTag({ ...LINCOLN, distKm: 0.6 }, 38.8893, -77.0502),
    'NEAR LINCOLN MEMORIAL (WASHINGTON DC) 1KM',
  );
});

test('the field failures now fall through to the SECTOR readout', () => {
  // Over Moscow, 2,470 km from the nearest catalogued POI.
  assert.equal(
    composeLocalityTag({ ...SACRE_COEUR, distKm: 2470 }, 55.7558, 37.6173),
    'SECTOR 55.76N 37.62E',
  );
  // Over Chicago, 962 km from the Lincoln Memorial.
  assert.equal(
    composeLocalityTag({ ...LINCOLN, distKm: 962 }, 41.8781, -87.6298),
    'SECTOR 41.88N 87.63W',
  );
});

test('the boundary is pinned on both sides, inclusive at the bound', () => {
  const at = composeLocalityTag(
    { ...LINCOLN, distKm: NEAR_POI_MAX_KM },
    40,
    -78,
  );
  assert.match(
    at,
    /^NEAR LINCOLN MEMORIAL/,
    'exactly at the bound still reads NEAR',
  );

  const just_under = composeLocalityTag(
    { ...LINCOLN, distKm: NEAR_POI_MAX_KM - 0.1 },
    40,
    -78,
  );
  assert.match(just_under, /^NEAR LINCOLN MEMORIAL/);

  const just_over = composeLocalityTag(
    { ...LINCOLN, distKm: NEAR_POI_MAX_KM + 0.1 },
    40,
    -78,
  );
  assert.match(just_over, /^SECTOR /, 'one step past the bound falls through');
});

test('southern and western hemispheres carry the right suffixes', () => {
  // Rio and Honolulu — the two the fallback already handled correctly in the field.
  assert.equal(
    composeLocalityTag(null, -22.9068, -43.1729),
    'SECTOR 22.91S 43.17W',
  );
  assert.equal(
    composeLocalityTag(null, 21.3069, -157.8583),
    'SECTOR 21.31N 157.86W',
  );
});

// The tests above all pass against a hud.js that still computes the tag inline —
// they only exercise the helper. This pins the PRODUCTION wiring: hud.js must
// import the helper, call it, and no longer carry the old 2,500 km branch.
// (hud.js itself cannot be imported here: it pulls in the `mgrs` CommonJS package,
// which Vite resolves but plain Node cannot import by named export.)
test('hud.js actually composes its summary through this helper', () => {
  const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
  // Boolean probes, not assert.match on the whole file — a failure here should
  // name the missing wiring, not print all of hud.js.
  const has = (pattern) => pattern.test(source);
  assert.equal(
    has(/import \{ composeLocalityTag \} from '\.\/hudLocality\.js';/),
    true,
    'hud.js must import composeLocalityTag from ./hudLocality.js',
  );
  assert.equal(
    has(
      /const localityTag = composeLocalityTag\(\s*nearest,\s*m\.latDeg,\s*m\.lonDeg,\s*LOCALIZED_LOCALITY,?\s*\);/,
    ),
    true,
    '_composeSummary must build its locality tag through composeLocalityTag()',
  );
  assert.equal(
    has(/distKm < 2500/),
    false,
    'the continental NEAR bound must not come back inline in hud.js',
  );
  assert.equal(
    has(/NEAR \$\{/),
    false,
    'the NEAR line must be composed in hudLocality.js, not re-inlined in hud.js',
  );
});

test('a missing or malformed nearest POI never crashes the summary', () => {
  assert.match(composeLocalityTag(null, 0, 0), /^SECTOR /);
  assert.match(composeLocalityTag(undefined, 0, 0), /^SECTOR /);
  assert.match(
    composeLocalityTag({ ...LINCOLN, distKm: NaN }, 10, 10),
    /^SECTOR /,
  );
  assert.match(composeLocalityTag({ ...LINCOLN }, 10, 10), /^SECTOR /);
});

test('a formatter builds the line from the same parts', () => {
  const format = {
    near: ({ poi, city, distKm }) => `near:${poi}|${city}|${distKm}`,
    sector: ({ latDeg, lonDeg }) => `sector:${latDeg}|${lonDeg}`,
  };
  assert.equal(
    composeLocalityTag({ ...ALCATRAZ, distKm: 2.4 }, 37.8, -122.4, format),
    'near:Alcatraz Island|San Francisco|2.4',
  );
  assert.equal(
    composeLocalityTag(null, 21.3, -157.8, format),
    'sector:21.3|-157.8',
  );
});

test('the HUD formatter translates the catalogued city, then upper-cases it', () => {
  const tokyo = { poi: 'Tokyo Tower', city: 'Tokyo', distKm: 2 };
  assert.equal(
    composeLocalityTag(tokyo, 35.66, 139.75, LOCALIZED_LOCALITY),
    'NEAR TOKYO TOWER (TOKYO) 2KM',
  );
  setLocale('ru');
  try {
    assert.match(
      composeLocalityTag(tokyo, 35.66, 139.75, LOCALIZED_LOCALITY),
      /\(ТОКИО\)/,
    );
  } finally {
    setLocale('en');
  }
});
