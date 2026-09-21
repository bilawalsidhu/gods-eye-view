import assert from 'node:assert/strict';
import test from 'node:test';
import {
  quantizeWaterQualityBox,
  resolveCharacteristicType,
  resolveWindowYears,
  validSiteIdentifier,
  validWaterQualityBox,
  waterQualityBBoxParam,
  waterQualityCacheKey,
  waterQualityFailureReason,
  windowStart,
} from './query.js';
import { WQ_DEFAULT_WINDOW_YEARS } from './constants.js';

const params = (entries) => new URLSearchParams(entries);
const box = { south: 34, west: -79.2, north: 35.4, east: -77.8 };

test('viewport admission rejects unbounded, inverted and dateline-spanning boxes', () => {
  assert.deepEqual(
    validWaterQualityBox(
      params({ south: '34', west: '-79.2', north: '35.4', east: '-77.8' }),
    ),
    box,
  );
  for (const invalid of [
    { south: '34', west: '-79.2', north: '35.4' },
    { south: '34', west: '-79.2', north: '33', east: '-77.8' },
    { south: '34', west: '-79.2', north: '35.4', east: '-80' },
    { south: '-91', west: '-79.2', north: '35.4', east: '-77.8' },
    { south: '10', west: '-120', north: '50', east: '-70' },
    // Measured: 3 degrees times the upstream out, so the bound is 2 — widening
    // this back to the Overpass layers' 10 empties every regional view.
    { south: '30', west: '-98', north: '33', east: '-95' },
    { south: '34', west: 'x', north: '35.4', east: '-77.8' },
  ])
    assert.equal(validWaterQualityBox(params(invalid)), null);
});

test('an absent sampling window falls back to the default, not to the floor', () => {
  // Number(null) is 0 and finite, so a naive check narrows every unparameterised
  // request to one year and hides most of the monitoring record.
  assert.equal(resolveWindowYears(null), WQ_DEFAULT_WINDOW_YEARS);
  assert.equal(resolveWindowYears(undefined), WQ_DEFAULT_WINDOW_YEARS);
  assert.equal(resolveWindowYears(''), WQ_DEFAULT_WINDOW_YEARS);
  assert.equal(resolveWindowYears('nonsense'), WQ_DEFAULT_WINDOW_YEARS);
  assert.equal(resolveWindowYears('3'), 3);
  assert.equal(resolveWindowYears('0'), 1);
  assert.equal(resolveWindowYears('9999'), 25);
});

test('analyte families resolve to their full upstream vocabulary list', () => {
  const pfas = resolveCharacteristicType('PFAS');
  assert.equal(pfas.family, 'pfas');
  // Cape Fear sites index under the comma-free spelling and return nothing for
  // the other, so a single-value query would silently lose them.
  assert.ok(
    pfas.characteristicTypes.includes('PFAS,Perfluorinated Alkyl Substance'),
  );
  assert.ok(pfas.characteristicTypes.length > 1);
  assert.deepEqual(resolveCharacteristicType('nutrient').characteristicTypes, [
    'Nutrient',
  ]);
  for (const unlisted of ['', null, 'Organics, PFAS', '../../etc', 'pfas; drop'])
    assert.equal(resolveCharacteristicType(unlisted), null);
});

test('the sampling window converts to both the client and upstream date formats', () => {
  const window = windowStart(5, Date.parse('2026-09-18T00:00:00Z'));
  assert.equal(window.iso, '2021-09-18');
  assert.equal(window.upstream, '09-18-2021');
});

test('the upstream bbox is positional west,south,east,north', () => {
  // Our API speaks named bounds; the upstream wants this ordering and nothing
  // else may depend on remembering it.
  assert.equal(waterQualityBBoxParam(box), '-79.20000,34.00000,-77.80000,35.40000');
});

test('quantizing snaps outward so a snapped box always covers the request', () => {
  const snapped = quantizeWaterQualityBox({
    south: 34.011,
    west: -79.231,
    north: 35.409,
    east: -77.782,
  });
  assert.ok(snapped.south <= 34.011);
  assert.ok(snapped.west <= -79.231);
  assert.ok(snapped.north >= 35.409);
  assert.ok(snapped.east >= -77.782);
  assert.equal(waterQualityCacheKey(snapped).split(',').length, 4);
});

test('site identifiers are admitted by grammar and never truncated to fit', () => {
  assert.equal(
    validSiteIdentifier('WATERKEEPER-CAPCapeFear[9/5/2024]-WDown'),
    'WATERKEEPER-CAPCapeFear[9/5/2024]-WDown',
  );
  for (const invalid of ['', '   ', '-leading', 'a'.repeat(200), 'bad<tag>'])
    assert.equal(validSiteIdentifier(invalid), null);
});

test('failure reasons are classified rather than passed through', () => {
  assert.equal(
    waterQualityFailureReason({ waterQualityReason: 'rate_limited' }),
    'rate_limited',
  );
  assert.equal(waterQualityFailureReason(new Error('boom')), 'unavailable');
  assert.equal(
    waterQualityFailureReason({ waterQualityReason: 'anything else' }),
    'unavailable',
  );
});
