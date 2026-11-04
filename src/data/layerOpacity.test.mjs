import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LAYER_OPACITY_PARAM,
  MAX_LAYER_OPACITY_CHARS,
  MAX_LAYER_OPACITY_ENTRIES,
  decodeLayerOpacity,
  encodeLayerOpacity,
  normalizeOpacity,
  opacityPercent,
  readLayerOpacityFromUrl,
  writeLayerOpacityToUrl,
} from './layerOpacity.js';
import { LAYER_STATE_REGISTRY } from './layerState.js';
import { appRootUrl, shareLinkUrl } from '../share/shareLinkPath.js';

test('normalizeOpacity clamps to 0-1, rounds to a percent and defaults', () => {
  assert.equal(normalizeOpacity(0.4), 0.4);
  assert.equal(normalizeOpacity(0.404), 0.4);
  assert.equal(normalizeOpacity(-3), 0);
  assert.equal(normalizeOpacity(7), 1);
  for (const bad of [NaN, Infinity, -Infinity, undefined, null, '0.5', {}, []])
    assert.equal(normalizeOpacity(bad), 1, String(bad));
  assert.equal(opacityPercent(0.35), 35);
  assert.equal(opacityPercent(undefined), 100);
});

test('encode writes only layers off 100 %, in id order', () => {
  assert.equal(encodeLayerOpacity([]), '');
  assert.equal(encodeLayerOpacity([['wind', 1]]), '');
  assert.equal(
    encodeLayerOpacity([
      ['wind', 0.4],
      ['earthquakes', 0],
      ['sea-marks', 1],
    ]),
    'earthquakes:0,wind:40',
  );
});

test('encode refuses ids outside the layer-id grammar', () => {
  assert.equal(
    encodeLayerOpacity([
      ['a&b=c', 0.5],
      ['', 0.5],
      ['UPPER', 0.5],
      ['x'.repeat(65), 0.5],
      ['ok', 0.5],
    ]),
    'ok:50',
  );
});

test('every registered layer id survives the address grammar', () => {
  for (const { id } of LAYER_STATE_REGISTRY)
    assert.equal(encodeLayerOpacity([[id, 0.5]]), `${id}:50`, id);
});

test('decode round-trips what encode writes', () => {
  const entries = [
    ['fire-perimeters', 0.25],
    ['wind', 0.8],
  ];
  assert.deepEqual(
    [...decodeLayerOpacity(encodeLayerOpacity(entries))],
    entries,
  );
});

test('decode drops unknown ids, malformed pairs, duplicates and 100 %', () => {
  const known = new Set(['wind', 'sea-marks', 'earthquakes']);
  const parsed = decodeLayerOpacity(
    [
      'wind:40',
      'wind:90', // duplicate: the first wins
      'nope:50', // unknown layer
      'sea-marks', // no value
      ':50', // no id
      'earthquakes:abc', // not a number
      'earthquakes:-5', // sign
      'earthquakes:1e2', // exponent
      'earthquakes:101', // above 100 snaps to 100 and is dropped
      'sea-marks:100', // the default is never stored
      '__proto__:50',
      'constructor:50',
    ].join(','),
    (id) => known.has(id),
  );
  assert.deepEqual([...parsed], [['wind', 0.4]]);
});

test('decode snaps to the slider step so handle and readout agree', () => {
  assert.equal(decodeLayerOpacity('wind:37').get('wind'), 0.35);
  assert.equal(decodeLayerOpacity('wind:38').get('wind'), 0.4);
  assert.equal(decodeLayerOpacity('wind:2').get('wind'), 0);
  assert.equal(decodeLayerOpacity('wind:98').has('wind'), false);
});

test('decode never throws and ignores hostile values', () => {
  const hostile = [
    undefined,
    null,
    42,
    {},
    [],
    '',
    ',,,',
    ':::',
    'wind:',
    'wind:40:50',
    'a'.repeat(MAX_LAYER_OPACITY_CHARS + 1),
    Array.from({ length: MAX_LAYER_OPACITY_ENTRIES + 1 }, () => 'x:5').join(
      ',',
    ),
    '<script>alert(1)</script>:50',
    'wind:40\u0000',
    'wind:４０', // full-width digits are not digits
  ];
  for (const value of hostile)
    assert.doesNotThrow(() => decodeLayerOpacity(value), String(value));
  assert.equal(decodeLayerOpacity(hostile[10]).size, 0);
  assert.equal(decodeLayerOpacity(hostile[11]).size, 0);
  assert.equal(decodeLayerOpacity('wind:40\u0000').size, 0);
  assert.equal(decodeLayerOpacity('wind:４０').size, 0);
});

test('decode refuses a value past either cap, even when every pair is valid', () => {
  // Distinct, well-formed pairs: only the caps can reject these.
  const long = Array.from(
    { length: 40 },
    (_, i) => `${'a'.repeat(60)}${String(i).padStart(3, '0')}:50`,
  ).join(',');
  assert.ok(long.length > MAX_LAYER_OPACITY_CHARS);
  assert.equal(decodeLayerOpacity(long).size, 0);
  const many = Array.from(
    { length: MAX_LAYER_OPACITY_ENTRIES + 1 },
    (_, i) => `l${i}:50`,
  ).join(',');
  assert.ok(many.length < MAX_LAYER_OPACITY_CHARS);
  assert.equal(decodeLayerOpacity(many).size, 0);
  // Just inside both caps, the same shape reads.
  const edge = Array.from(
    { length: MAX_LAYER_OPACITY_ENTRIES },
    (_, i) => `l${i}:50`,
  ).join(',');
  assert.equal(decodeLayerOpacity(edge).size, MAX_LAYER_OPACITY_ENTRIES);
});

test('decode survives a throwing id filter', () => {
  assert.equal(
    decodeLayerOpacity('wind:40', () => {
      throw new Error('boom');
    }).size,
    0,
  );
  // Only an explicit `true` admits an id.
  assert.equal(decodeLayerOpacity('wind:40', () => 'yes').size, 0);
});

test('the address keeps every other parameter, the path and the hash', () => {
  const base = 'https://gev.example/app/?lang=de&x=a%20b#v=2&l=f&lat=1';
  const written = writeLayerOpacityToUrl(base, [['wind', 0.4]]);
  assert.equal(
    written,
    'https://gev.example/app/?lang=de&x=a%20b&lop=wind:40#v=2&l=f&lat=1',
  );
  assert.equal(writeLayerOpacityToUrl(written, []), base);
  assert.equal(
    writeLayerOpacityToUrl('https://gev.example/?lop=wind:40', []),
    'https://gev.example/',
  );
  // Replacing never duplicates the parameter.
  assert.equal(
    writeLayerOpacityToUrl(written, [['wind', 0.2]]).split('lop=').length,
    2,
  );
});

test('an encoded spelling of lop is replaced, not left to shadow the new value', () => {
  const written = writeLayerOpacityToUrl(
    'https://gev.example/?l%6Fp=wind:90&x=1&lop=wind:10',
    [['wind', 0.4]],
  );
  assert.equal(written, 'https://gev.example/?x=1&lop=wind:40');
  assert.equal(readLayerOpacityFromUrl(written).get('wind'), 0.4);
});

test('the address reads back what it wrote and tolerates a bad address', () => {
  const href = writeLayerOpacityToUrl('https://gev.example/', [
    ['wind', 0.4],
    ['sea-marks', 0.75],
  ]);
  const parsed = readLayerOpacityFromUrl(href, () => true);
  assert.deepEqual(
    [...parsed],
    [
      ['sea-marks', 0.75],
      ['wind', 0.4],
    ],
  );
  assert.equal(readLayerOpacityFromUrl('not a url').size, 0);
  assert.equal(readLayerOpacityFromUrl('https://gev.example/').size, 0);
  // An encoded value (`%3A`, `%2C`) reads the same as a raw one.
  assert.equal(
    readLayerOpacityFromUrl(
      'https://gev.example/?lop=wind%3A40%2Csea-marks%3A50',
    ).size,
    2,
  );
});

test('a copied share link carries the opacity of the page it came from', () => {
  const page = writeLayerOpacityToUrl('https://gev.example/app/?lang=de#v=2', [
    ['wind', 0.4],
  ]);
  const link = shareLinkUrl('AQc', page);
  // The share path re-serializes the query, so compare what it carries.
  assert.equal(new URL(link).pathname, '/app/share/AQc');
  assert.equal(new URL(link).searchParams.get('lang'), null);
  assert.deepEqual([...readLayerOpacityFromUrl(link)], [['wind', 0.4]]);
  // The address a `/share/` page rewrites to keeps it too.
  assert.deepEqual(
    [...readLayerOpacityFromUrl(appRootUrl(link).href)],
    [['wind', 0.4]],
  );
  assert.equal(LAYER_OPACITY_PARAM, 'lop');
});
