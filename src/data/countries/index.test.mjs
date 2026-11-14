import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allCountries,
  buildIcao24Lookup,
  buildLookup,
  catalog,
  countryEntry,
  countryForIcao24,
} from './index.js';
import { flagOf, normalizeIso2, normalizeName, parseIcao24 } from './naming.js';

const fixture = [
  {
    iso2: 'AA',
    iso3: 'AAA',
    name: 'Alpha',
    flag: flagOf('AA'),
    regPrefixes: [],
    icao24Ranges: [
      ['100000', '1000FF'],
      ['300000', '3FFFFF'],
    ],
  },
  {
    iso2: 'BB',
    iso3: 'BBB',
    name: 'Beta',
    flag: flagOf('BB'),
    regPrefixes: [],
    icao24Ranges: [['200000', '2FFFFF']],
  },
  {
    iso2: 'CC',
    iso3: 'CCC',
    name: 'Gamma',
    flag: flagOf('CC'),
    regPrefixes: [],
    icao24Ranges: [],
  },
];

test('flagOf computes the regional-indicator pair and rejects a non-code', () => {
  assert.equal(flagOf('US'), '\u{1F1FA}\u{1F1F8}');
  assert.equal(flagOf('ch'), '\u{1F1E8}\u{1F1ED}');
  assert.equal(flagOf('USA'), '');
  assert.equal(flagOf(''), '');
  assert.equal(flagOf(null), '');
});

test('normalizers fold codes and names', () => {
  assert.equal(normalizeIso2(' ch '), 'CH');
  assert.equal(normalizeIso2('CHE'), '');
  assert.equal(normalizeName("Côte d'Ivoire"), 'cote d ivoire');
  assert.equal(normalizeName('Korea,  Republic of'), 'korea republic of');
  assert.equal(normalizeName(undefined), '');
});

test('parseIcao24 reads hex with optional prefix, spaces and case', () => {
  assert.equal(parseIcao24('A00000'), 0xa00000);
  assert.equal(parseIcao24('0xa00000'), 0xa00000);
  assert.equal(parseIcao24(' 4b 1814 '), 0x4b1814);
  assert.equal(parseIcao24('1F'), 0x1f);
  assert.equal(parseIcao24(0x4b1814), 0x4b1814);
});

test('parseIcao24 rejects anything that is not an address', () => {
  for (const bad of ['', 'ZZZZZZ', '~A00000', '1000000', '0x', null, undefined])
    assert.equal(parseIcao24(bad), -1, String(bad));
  assert.equal(parseIcao24(0x1000000), -1);
  assert.equal(parseIcao24(-1), -1);
  assert.equal(parseIcao24(1.5), -1);
});

test('an ISO code resolves in any case; a non-country is null', () => {
  const lookup = buildLookup(fixture);
  assert.equal(lookup('aa').name, 'Alpha');
  assert.equal(lookup('BB').name, 'Beta');
  assert.equal(lookup('ZZ'), null);
  assert.equal(lookup('AAA'), null);
  assert.equal(lookup(''), null);
  assert.equal(lookup(null), null);
});

test('an address resolves to the block that holds it, at both edges and between blocks', () => {
  const lookup = buildIcao24Lookup(fixture);
  assert.equal(lookup('100000').iso2, 'AA');
  assert.equal(lookup('1000FF').iso2, 'AA');
  assert.equal(lookup('100100'), null);
  assert.equal(lookup('0FFFFF'), null);
  assert.equal(lookup('250000').iso2, 'BB');
  assert.equal(lookup('3fffff').iso2, 'AA');
  assert.equal(lookup('400000'), null);
  assert.equal(lookup('0x200000').iso2, 'BB');
  assert.equal(lookup('not hex'), null);
  assert.equal(lookup(null), null);
});

test('the bundled catalog names the country of a known address', () => {
  assert.equal(countryForIcao24('A00000').iso2, 'US');
  assert.equal(countryForIcao24('AFFFFF').iso2, 'US');
  assert.equal(countryForIcao24('4B1814').iso2, 'CH');
  assert.equal(countryForIcao24('400000').iso2, 'GB');
  assert.equal(countryForIcao24('718123').iso2, 'KR');
  assert.equal(countryForIcao24('3C6444').iso2, 'DE');
  assert.equal(countryForIcao24('000000'), null);
  assert.equal(countryForIcao24('FFFFFF'), null);
});

test('the bundled catalog resolves a code and reports the flag and prefix', () => {
  const us = countryEntry('us');
  assert.equal(us.name, 'United States');
  assert.equal(us.iso3, 'USA');
  assert.equal(us.flag, '\u{1F1FA}\u{1F1F8}');
  assert.deepEqual(us.regPrefixes, ['N']);
  assert.equal(countryEntry('XX'), null);
});

test('every address block of the catalog resolves back to its own country', () => {
  for (const entry of catalog)
    for (const [start, end] of entry.icao24Ranges)
      for (const hex of [start, end])
        assert.equal(
          countryForIcao24(hex)?.iso2,
          entry.iso2,
          `${entry.iso2} ${hex}`,
        );
});

test('the catalog is every ISO country, sorted by iso2, with unique keys', () => {
  assert.equal(allCountries(), catalog);
  assert.ok(catalog.length >= 240, `${catalog.length} countries`);
  const keys = catalog.map((e) => e.iso2);
  assert.deepEqual(keys, [...keys].sort());
  assert.equal(new Set(keys).size, keys.length);
});
