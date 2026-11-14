import test from 'node:test';
import assert from 'node:assert/strict';
import { countryCoverage, validateCountryCatalog } from './validate.js';
import { catalog } from './index.js';
import { flagOf } from './naming.js';

const good = (iso2 = 'CH', ranges = [['4B0000', '4B7FFF']]) => ({
  iso2,
  iso3: `${iso2}X`,
  name: 'Switzerland',
  flag: flagOf(iso2),
  regPrefixes: ['HB'],
  icao24Ranges: ranges,
});

const problemsOf = (entry) =>
  validateCountryCatalog([entry])[0]?.problems ?? [];

test('a well-formed entry passes', () => {
  assert.deepEqual(problemsOf(good()), []);
});

test('mutation: each corrupted field is flagged by the validator', () => {
  const mutants = {
    'bad iso2': (e) => (e.iso2 = 'ch'),
    'bad iso3': (e) => (e.iso3 = 'CH'),
    'missing name': (e) => (e.name = '  '),
    'flag does not match': (e) => (e.flag = flagOf('US')),
    'bad regPrefixes': (e) => (e.regPrefixes = ['hb']),
    'bad icao24Ranges': (e) => delete e.icao24Ranges,
    'bad icao24 range': (e) => (e.icao24Ranges = [['4B0000']]),
    'start after end': (e) => (e.icao24Ranges = [['4B7FFF', '4B0000']]),
  };
  for (const [expected, mutate] of Object.entries(mutants)) {
    const entry = good();
    mutate(entry);
    const problems = problemsOf(entry);
    assert.ok(
      problems.some((p) => p.includes(expected)),
      `${expected} not flagged: ${problems.join('; ')}`,
    );
  }
});

test('mutation: a non-hex or short bound is flagged', () => {
  for (const range of [
    ['4B000G', '4B7FFF'],
    ['4B0', '4B7FFF'],
    ['4b0000', '4b7fff'],
  ])
    assert.match(
      problemsOf(good('CH', [range])).join(),
      /bad icao24 range/,
      range.join('-'),
    );
});

test('mutation: a repeated iso2 is flagged', () => {
  const dup = validateCountryCatalog([good('CH'), good('CH', [])]);
  assert.match(dup[0].problems.join(), /duplicate iso2/);
});

test('mutation: overlapping blocks, even across countries, are flagged on both', () => {
  const failures = validateCountryCatalog([
    good('CH', [['400000', '4FFFFF']]),
    good('DE', [['4B0000', '4B00FF']]),
    good('FR', [['500000', '5000FF']]),
  ]);
  assert.deepEqual(failures.map((f) => f.key).sort(), ['CH', 'DE']);
  assert.match(failures[0].problems.join(), /icao24 overlap/);
});

test('mutation: touching blocks that share one address are flagged', () => {
  const failures = validateCountryCatalog([
    good('CH', [['400000', '40FFFF']]),
    good('DE', [['40FFFF', '41FFFF']]),
  ]);
  assert.equal(failures.length, 2);
});

test('coverage counts allocations and prefixes and lists countries without a block', () => {
  const reduced = [
    good('CH'),
    { ...good('LI', []), regPrefixes: [] },
    good('MC', []),
  ];
  assert.deepEqual(countryCoverage(reduced), {
    isoTotal: 3,
    withIcao24: 1,
    withRegPrefix: 2,
    missingIcao24: ['LI', 'MC'],
  });
});

test('the committed catalog passes validation and covers the ISO list', () => {
  assert.deepEqual(validateCountryCatalog(catalog), []);
  const coverage = countryCoverage(catalog);
  assert.equal(coverage.isoTotal, catalog.length);
  assert.ok(coverage.withIcao24 >= 185, `withIcao24 ${coverage.withIcao24}`);
  assert.ok(coverage.withRegPrefix >= 180);
  assert.equal(
    coverage.missingIcao24.length,
    coverage.isoTotal - coverage.withIcao24,
  );
});

test('mutation: dropping a country with a block is reported as a coverage gap', () => {
  const reduced = catalog.map((e) =>
    e.iso2 === 'US' ? { ...e, icao24Ranges: [] } : e,
  );
  assert.ok(countryCoverage(reduced).missingIcao24.includes('US'));
});
