import test from 'node:test';
import assert from 'node:assert/strict';
import { airlineCoverage, validateAirlineCatalog } from './validate.js';
import { catalog } from './index.js';
import { catalog as countries } from '../countries/index.js';

const knownIso2 = new Set(['CH', 'GB']);

const good = () => ({
  icao: 'SWR',
  iata: 'LX',
  name: 'Swiss International Air Lines',
  callsign: 'SWISS',
  country: 'CH',
  active: true,
  tailColor: '#E30613',
});

const problemsOf = (entry) =>
  validateAirlineCatalog([entry], { knownIso2 })[0]?.problems ?? [];

test('a well-formed entry passes, with and without optional fields', () => {
  assert.deepEqual(problemsOf(good()), []);
  assert.deepEqual(
    problemsOf({
      ...good(),
      iata: null,
      callsign: null,
      country: null,
      tailColor: null,
    }),
    [],
  );
});

test('mutation: each corrupted field is flagged by the validator', () => {
  const mutants = {
    'bad icao': (e) => (e.icao = 'SW'),
    'bad iata': (e) => (e.iata = 'lx'),
    'missing name': (e) => (e.name = ' '),
    'bad callsign': (e) => (e.callsign = ' '),
    'unknown country': (e) => (e.country = 'XX'),
    active: (e) => (e.active = 'Y'),
    'bad tailColor': (e) => (e.tailColor = 'red'),
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

test('mutation: a repeated icao is flagged', () => {
  const dup = validateAirlineCatalog([good(), good()], { knownIso2 });
  assert.match(dup[0].problems.join(), /duplicate icao/);
});

test('mutation: a six-digit colour must start with a hash', () => {
  assert.match(
    problemsOf({ ...good(), tailColor: 'E30613' }).join(),
    /tailColor/,
  );
  assert.match(
    problemsOf({ ...good(), tailColor: '#E3061' }).join(),
    /tailColor/,
  );
});

test('coverage counts the optional fields', () => {
  const entries = [
    good(),
    { ...good(), icao: 'BAW', country: 'GB', iata: null, tailColor: null },
    { ...good(), icao: 'ACR', country: null, iata: null, tailColor: null },
  ];
  assert.deepEqual(airlineCoverage(entries), {
    total: 3,
    withCountry: 2,
    withIata: 1,
    withTailColor: 1,
  });
});

test('the committed catalog passes validation against the country library', () => {
  const failures = validateAirlineCatalog(catalog, {
    knownIso2: countries.map((c) => c.iso2),
  });
  assert.deepEqual(failures, []);
});

test('the committed catalog covers countries and IATA codes at the recorded floor', () => {
  const coverage = airlineCoverage(catalog);
  assert.equal(coverage.total, catalog.length);
  assert.ok(coverage.withCountry / coverage.total >= 0.95, 'country rate');
  assert.ok(coverage.withIata >= 1000, `withIata ${coverage.withIata}`);
  assert.ok(
    coverage.withTailColor >= 20,
    `withTailColor ${coverage.withTailColor}`,
  );
});

test('mutation: a tail colour can never name a logo or an image', () => {
  for (const entry of catalog)
    if (entry.tailColor !== null)
      assert.match(entry.tailColor, /^#[0-9A-F]{6}$/, entry.icao);
});
