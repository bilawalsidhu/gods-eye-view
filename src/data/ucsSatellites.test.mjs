import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { indexUcsPack, loadUcsSatellites } from './ucsSatellites.js';

const PACK_URL = new URL(
  './local_data/ucs_satellites/ucs_satellites.json',
  import.meta.url,
);

test('the bundled UCS pack names its release, licence and curation', () => {
  const pack = JSON.parse(readFileSync(PACK_URL, 'utf8'));
  assert.equal(pack.meta.version, 'UCS-Satellite-Database 5-1-2023');
  assert.equal(pack.meta.url, 'https://www.ucsusa.org/satellite_database');
  assert.equal(pack.meta.dataCurrentTo, '2023-05-01');
  assert.match(pack.meta.license, /unrestricted/);
  assert.equal(pack.meta.recordCount, pack.records.length);
  assert.equal(
    pack.meta.curation.sourceRows,
    pack.records.length +
      pack.meta.curation.starlinkRowsDropped +
      pack.meta.curation.invalidNoradDropped +
      pack.meta.curation.duplicateNoradDropped,
  );
  assert.deepEqual(pack.fields, [
    'noradId',
    'operator',
    'operatorCountry',
    'purpose',
  ]);
  // Small enough to load with the layer.
  assert.ok(readFileSync(PACK_URL).length < 200_000);
});

test('the pack loads into records keyed by NORAD number', async () => {
  const records = await loadUcsSatellites();
  assert.equal(records, await loadUcsSatellites(), 'loaded once');
  const iss = records.get(25544);
  assert.ok(iss, 'the ISS is in UCS');
  assert.equal(iss.noradId, 25544);
  assert.ok(iss.operator);
  assert.ok(iss.purpose);
  for (const record of records.values()) {
    assert.doesNotMatch(
      `${record.operator ?? ''} ${record.purpose ?? ''}`,
      /starlink/i,
      'Starlink rows are dropped',
    );
  }
});

test('indexing reads the string tables and turns empty strings into null', () => {
  const records = indexUcsPack({
    fields: ['noradId', 'operator', 'purpose'],
    strings: { operator: ['', 'ESA'], purpose: ['', 'Earth Observation'] },
    records: [
      [39634, 1, 1],
      [40000, 0, 1],
      ['bad', 1, 1],
      [-5, 1, 1],
    ],
  });
  assert.deepEqual([...records.keys()], [39634, 40000]);
  assert.deepEqual(records.get(39634), {
    noradId: 39634,
    operator: 'ESA',
    purpose: 'Earth Observation',
  });
  assert.equal(records.get(40000).operator, null);
});

test('a pack of the wrong shape throws, so the loader tries again', () => {
  // Read as empty, it would be cached for the session as a success.
  assert.throws(() => indexUcsPack(null), TypeError);
  assert.throws(
    () => indexUcsPack({ fields: ['name'], records: [[1]] }),
    TypeError,
  );
  assert.throws(() => indexUcsPack({ fields: ['noradId'] }), TypeError);
});
