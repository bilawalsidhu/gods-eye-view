// src/data/icaoCountry.test.mjs
// Registering state from the ICAO 24-bit address block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  icaoCountryCode,
  icaoCountryName,
  _ICAO_BLOCKS_FOR_TEST,
} from './icaoCountry.js';

test('blocks are sorted, well-formed and never overlap', () => {
  let previousLast = -1;
  for (const [first, last, code] of _ICAO_BLOCKS_FOR_TEST) {
    assert.ok(first <= last, `${code} block is inverted`);
    assert.ok(first > previousLast, `${code} block overlaps or is out of order`);
    assert.match(code, /^[A-Z]{2}$/);
    previousLast = last;
  }
});

test('military blocks resolve to their registering state', () => {
  assert.equal(icaoCountryCode('43c6f2'), 'GB', 'UK military block');
  assert.equal(icaoCountryCode('AE1234'), 'US', 'US military block, any case');
  assert.equal(icaoCountryCode('3f4a21'), 'DE');
  assert.equal(icaoCountryCode('7cf8a1'), 'AU');
  assert.equal(icaoCountryCode('06a1c3'), 'QA', 'small block');
});

test('block edges are inclusive', () => {
  assert.equal(icaoCountryCode('400000'), 'GB');
  assert.equal(icaoCountryCode('43ffff'), 'GB');
  assert.equal(icaoCountryCode('440000'), 'AT');
  assert.equal(icaoCountryCode('a00000'), 'US');
  assert.equal(icaoCountryCode('afffff'), 'US');
});

test('unallocated, reserved and non-ICAO addresses return null', () => {
  assert.equal(icaoCountryCode('f00001'), null, 'ICAO-reserved block');
  assert.equal(icaoCountryCode('000001'), null, 'gap below the first block');
  assert.equal(icaoCountryCode('~43c6f2'), null, 'TIS-B/MLAT non-ICAO');
  assert.equal(icaoCountryCode('43c6f'), null, 'too short');
  assert.equal(icaoCountryCode(''), null);
  assert.equal(icaoCountryCode(null), null);
});

test('names come from Intl in the requested language', () => {
  assert.equal(icaoCountryName('43c6f2'), 'United Kingdom');
  assert.equal(icaoCountryName('ae1234'), 'United States');
  assert.equal(icaoCountryName('43c6f2', 'de'), 'Vereinigtes Königreich');
  assert.equal(icaoCountryName('f00001'), null);
});
