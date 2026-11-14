import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNameIndex,
  parseCsv,
  parseIcaoRanges,
  parseIsoCountries,
} from './source.js';

test('parseCsv reads quoted commas, doubled quotes, CRLF and a missing final newline', () => {
  assert.deepEqual(parseCsv('a,"b,c",d\r\n"say ""hi""",,x\n\ny,z'), [
    ['a', 'b,c', 'd'],
    ['say "hi"', '', 'x'],
    ['y', 'z'],
  ]);
  assert.deepEqual(parseCsv(''), []);
});

test('parseIsoCountries keeps name, alpha-2 and alpha-3 and requires the columns', () => {
  const csv =
    'name,alpha-2,alpha-3,country-code\n"Korea, Republic of",KR,KOR,410\nNamibia,NA,NAM,516\n';
  assert.deepEqual(parseIsoCountries(csv), [
    { iso2: 'KR', iso3: 'KOR', name: 'Korea, Republic of' },
    { iso2: 'NA', iso3: 'NAM', name: 'Namibia' },
  ]);
  assert.throws(() => parseIsoCountries('name,alpha-2\nA,AA\n'), /alpha-3/);
});

test('parseIcaoRanges reads blocks without evaluating and stops at the array end', () => {
  const js = `"use strict";
var ICAO_Ranges = [
  // comment { start: 0x1, end: 0x2, country: "Skip" }
  { start: 0x0A0000, end: 0x0A7FFF, country: "Algeria", flag_image: "x.png" },
  { start: 0xc00000, end:0xC3FFFF, country:"Canada" },
];
var other = { start: 0x1, end: 0x2, country: "After" };`;
  assert.deepEqual(parseIcaoRanges(js), [
    { start: '0A0000', end: '0A7FFF', country: 'Algeria' },
    { start: 'C00000', end: 'C3FFFF', country: 'Canada' },
  ]);
});

test('buildNameIndex matches names and aliases after folding and rejects bad aliases', () => {
  const entries = [
    { iso2: 'CI', name: "Côte d'Ivoire" },
    { iso2: 'KR', name: 'South Korea' },
  ];
  const resolve = buildNameIndex(entries, {
    'Korea, Republic of': 'KR',
    'Ivory Coast': 'CI',
  });
  assert.equal(resolve("Cote d'Ivoire"), 'CI');
  assert.equal(resolve('IVORY COAST'), 'CI');
  assert.equal(resolve('korea republic of'), 'KR');
  assert.equal(resolve('Atlantis'), null);
  assert.equal(resolve(''), null);
  assert.throws(() => buildNameIndex(entries, { Nowhere: 'ZZ' }), /unknown ZZ/);
  assert.throws(
    () => buildNameIndex(entries, { 'South Korea': 'CI' }),
    /is both/,
  );
});
