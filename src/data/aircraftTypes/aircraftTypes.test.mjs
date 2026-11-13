import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import catalog from './catalog.json' with { type: 'json' };
import frequency from './typeFrequency.json' with { type: 'json' };
import { aircraftTypeClass, aircraftTypeEntry } from './index.js';
import { validateCatalog } from './validateCatalog.js';

const PUBLIC = fileURLToPath(new URL('../../../public', import.meta.url));
const photoBytes = (publicPath) => {
  const file = `${PUBLIC}${publicPath}`;
  return existsSync(file) ? statSync(file).size : null;
};

test('lookup ignores case and surrounding space', () => {
  const entry = aircraftTypeEntry(' b789 ');
  assert.equal(entry?.icao, 'B789');
  assert.match(entry.name, /787-9/);
  assert.equal(aircraftTypeEntry('B789'), entry);
});

test('unknown or empty designators have no entry', () => {
  assert.equal(aircraftTypeEntry('ZZZZ'), null);
  assert.equal(aircraftTypeEntry(''), null);
  assert.equal(aircraftTypeEntry(undefined), null);
});

test('class falls back to classifyAircraft for an unknown type', () => {
  assert.equal(aircraftTypeEntry('PA38'), null);
  assert.equal(aircraftTypeClass(' pa38'), 'light');
  assert.equal(aircraftTypeClass('ZZZZ'), 'airliner');
});

test('class comes from the catalog where it corrects classifyAircraft', () => {
  const corrected = catalog.find((entry) => entry.classOverride);
  assert.ok(corrected, 'catalog records at least one class override');
  assert.notEqual(corrected.class, corrected.classOverride.classifier);
  assert.equal(
    aircraftTypeClass(corrected.icao.toLowerCase()),
    corrected.class,
  );
});

test('the shipped catalog satisfies every rule', () => {
  assert.deepEqual(validateCatalog(catalog, { photoBytes }), []);
});

const good = () =>
  structuredClone(
    catalog.find((entry) => entry.photo?.licence.startsWith('CC BY')),
  );

const rejects = (mutate, rule) => {
  const entry = good();
  mutate(entry);
  const problems = validateCatalog([entry], { photoBytes });
  assert.ok(
    problems.some((line) => line.includes(rule)),
    `expected "${rule}" in ${JSON.stringify(problems)}`,
  );
};

test('validator rejects a licence outside the allowlist', () => {
  rejects((e) => (e.photo.licence = 'CC BY-NC 4.0'), 'not allowlisted');
  rejects((e) => (e.photo.licence = 'CC BY-ND 2.0'), 'not allowlisted');
  rejects((e) => (e.photo.licence = undefined), 'not allowlisted');
});

test('validator requires author, licence link and a Commons source', () => {
  rejects((e) => (e.photo.author = '  '), 'author is required');
  rejects((e) => (e.photo.licenceUrl = null), 'licenceUrl is required');
  rejects(
    (e) => (e.photo.sourceUrl = 'https://example.com/a.jpg'),
    'Commons file page',
  );
});

test('validator requires the photo file, its size and width limits', () => {
  rejects((e) => (e.photo.path = '/aircraft-types/NOPE.webp'), 'photo.path');
  const entry = good();
  assert.ok(
    validateCatalog([entry], { photoBytes: () => null }).some((line) =>
      line.includes('is missing'),
    ),
  );
  assert.ok(
    validateCatalog([entry], { photoBytes: () => 10_000_000 }).some((line) =>
      line.includes('over'),
    ),
  );
  rejects((e) => (e.photo.width = 1200), 'px wide');
});

test('validator rejects a class that disagrees without an override', () => {
  rejects((e) => {
    e.class = e.class === 'glider' ? 'uav' : 'glider';
    delete e.classOverride;
  }, 'disagrees with classifyAircraft');
  rejects((e) => {
    e.class = e.class === 'glider' ? 'uav' : 'glider';
    e.classOverride = { classifier: 'quadjet', reason: 'wrong classifier' };
  }, 'disagrees with classifyAircraft');
});

test('validator rejects unsorted, duplicate and invented-looking entries', () => {
  const a = good();
  assert.ok(
    validateCatalog([a, structuredClone(a)], { photoBytes }).some((line) =>
      line.includes('duplicate'),
    ),
  );
  rejects((e) => (e.specs.lengthM = -3), 'specs.lengthM');
  rejects((e) => (e.role = 'spy'), 'role');
});

test('photos cover at least 95% of airframes seen with a type code', () => {
  const covered = frequency.types
    .filter((type) => aircraftTypeEntry(type.icao)?.photo)
    .reduce((sum, type) => sum + type.count, 0);
  const share = covered / frequency.withTypeCode;
  console.log(
    `aircraft type photo coverage: ${(share * 100).toFixed(2)}% (${covered}/${frequency.withTypeCode} airframes)`,
  );
  assert.ok(share >= 0.95, `coverage ${(share * 100).toFixed(2)}% < 95%`);
});
