// directionToHeading — two matching modes. The regression that motivated the
// split (owner adversarial review, 2026-07-04): bare cardinal words were
// matched in free-form Austin camera names, so a street like "5TH ST / WEST
// AVE" was mis-read as a west-facing camera with false high confidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { directionToHeading } from './directionText.js';

test('explicit travel forms resolve in BOTH modes (bound words + abbreviations)', () => {
  for (const allowBare of [false, true]) {
    assert.equal(directionToHeading('NORTHBOUND', allowBare), 0);
    assert.equal(directionToHeading('SB', allowBare), 180);
    assert.equal(directionToHeading('EASTBOUND lanes', allowBare), 90);
    assert.equal(directionToHeading('WB', allowBare), 270);
    assert.equal(directionToHeading('NORTHEAST', allowBare), 45);
    assert.equal(directionToHeading('SW', allowBare), 225);
  }
});

test('bare cardinal words resolve ONLY when allowBare (dedicated direction field)', () => {
  assert.equal(directionToHeading('West', true), 270);
  assert.equal(directionToHeading('North', true), 0);
  assert.equal(directionToHeading('South', true), 180);
  assert.equal(directionToHeading('East', true), 90);
  // Caltrans-style field with trailing text still extracts the bare cardinal.
  assert.equal(directionToHeading('West / SR-24', true), 270);
});

test('REGRESSION: bare cardinals in free-form names do NOT resolve (allowBare=false)', () => {
  // These are real Austin camera name shapes (live-sampled). Each contains a
  // cardinal word as part of a STREET NAME, not a facing direction — they must
  // return NaN so the camera falls back to low-confidence id-hash heading.
  assert.ok(Number.isNaN(directionToHeading('5TH ST / WEST AVE')), 'WEST AVE street name');
  assert.ok(Number.isNaN(directionToHeading('LAMAR BLVD / NORTH LOOP BLVD')), 'NORTH LOOP street name');
  assert.ok(Number.isNaN(directionToHeading('SOUTH CONGRESS AVE / RIVERSIDE')), 'SOUTH CONGRESS street name');
  assert.ok(Number.isNaN(directionToHeading('EAST 7TH ST / I-35')), 'EAST 7TH street name');
  // …but a name that genuinely carries a travel form still resolves.
  assert.equal(directionToHeading('IH-35 SOUTHBOUND AT 15TH'), 180);
});

test('compound words are not shadowed and word boundaries hold', () => {
  // "NORTH" must not match inside "NORTHBOUND" (returns via the bound branch)
  // nor inside "NORTHLAND" (no boundary → no match even with allowBare).
  assert.equal(directionToHeading('NORTHBOUND', true), 0);
  assert.ok(Number.isNaN(directionToHeading('NORTHLAND DR', true)), 'NORTHLAND is not NORTH');
  assert.ok(Number.isNaN(directionToHeading('EASTON PARK', true)), 'EASTON is not EAST');
});

test('empty / junk input returns NaN', () => {
  assert.ok(Number.isNaN(directionToHeading('')));
  assert.ok(Number.isNaN(directionToHeading(null)));
  assert.ok(Number.isNaN(directionToHeading('somewhere', true)));
});

test('conflicting facing directions cannot manufacture one heading', () => {
  for (const bare of [false, true]) {
    for (const value of ['NB / SB', 'EASTBOUND WESTBOUND', 'NE SW'])
      assert.ok(Number.isNaN(directionToHeading(value, bare)), value);
    assert.equal(directionToHeading('NB northbound', bare), 0);
    assert.equal(directionToHeading('IH-35 SOUTHBOUND AT 15TH', bare), 180);
  }
  assert.ok(Number.isNaN(directionToHeading('North / East', true)));
  assert.equal(directionToHeading('West / SR-24', true), 270);
});

test('travel tokens retain precedence over quadrant streets and bare words', () => {
  for (const [text, heading] of [
    ['I-5 NB at NE 45th St', 0],
    ['SR 520 EB at NE 148th', 90],
    ['US 13 SB @ SW Front St', 180],
  ]) {
    for (const bare of [false, true])
      assert.equal(directionToHeading(text, bare), heading);
  }
  assert.equal(
    directionToHeading('Hwy 401 east of Keele St - Westbound', true),
    270,
  );
  assert.equal(directionToHeading('NE near West St', true), 45);
  assert.ok(Number.isNaN(directionToHeading('NB SB near NE St', true)));
});
