import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeUsgsWaterSnapshot,
  waterNumber,
  waterCardDetails,
  waterTime,
} from './records.js';
import { usgsWaterFixtures } from '../../../scripts/qa-usgs-water-fixtures.mjs';

const NOW = Date.UTC(2026, 9, 11, 18);
export function joinedFixture() {
  const f = usgsWaterFixtures(NOW);
  return {
    observations: f.observations.map((row) => ({
      id: row.id,
      ...row.properties,
    })),
    stations: f.stations.map((row) => ({
      ...row.properties,
      lon: row.geometry.coordinates[0],
      lat: row.geometry.coordinates[1],
    })),
    series: f.series.map((row) => ({ ...row.properties })),
    fetchedAt: NOW,
  };
}

test('full numeric strings preserve zero, negative stage and source text without manufacturing missing zeros', () => {
  for (const [input, output] of [
    ['0.00', 0],
    ['-0.75', -0.75],
    ['  +1.2e2 ', 120],
    [null, null],
    ['', null],
    ['  ', null],
    ['Ice', null],
    ['1 ft', null],
    ['0x10', null],
    ['Infinity', null],
    ['1e999', null],
  ])
    assert.equal(waterNumber(input), output);
  const n = normalizeUsgsWaterSnapshot(joinedFixture());
  assert.equal(n.records.length, 2);
  const stream = n.records.find((r) => r.bexar);
  assert.equal(stream.readings.length, 4);
  assert.equal(
    stream.readings.filter((r) => r.parameterCode === '00065').length,
    2,
  );
  assert.equal(
    stream.readings.find((r) => r.seriesId === 'stage-a').numericValue,
    -0.75,
  );
  assert.equal(
    stream.readings.find((r) => r.seriesId === 'stage-b').valueText,
    '0.00',
  );
  const well = n.records.find((r) => !r.bexar);
  assert.equal(well.numericReadingCount, 0);
  assert.deepEqual(
    well.readings.map((r) => r.numericValue),
    [null, null, null],
  );
  assert.equal(well.county, 'Comal County');
});

test('cards retain times, units, qualifier lists, provisional status and separate series/sublocation meaning', () => {
  const f = joinedFixture();
  f.observations[0].qualifier = ['EQUIP', 'UNAVAIL'];
  const s = normalizeUsgsWaterSnapshot(f).records.find((r) => r.bexar);
  const index = s.readings.findIndex((r) => r.seriesId === 'stage-a');
  const card = waterCardDetails(s, index, NOW).join('\n');
  for (const text of [
    '-0.75 ft',
    'Provisional',
    'EQUIP, UNAVAIL',
    'Upstream',
    'stage-a',
    'Observed',
    'Retrieved',
    'not necessarily river depth',
  ])
    assert.ok(card.includes(text), text);
  assert.deepEqual(s.readings[index].qualifier, ['EQUIP', 'UNAVAIL']);
  assert.equal(s.provisional, true);
  assert.equal(s.name, 'QA Creek');
  const rain = s.readings.findIndex((r) => r.parameterCode === '00045');
  assert.match(
    waterCardDetails(s, rain, NOW).join('\n'),
    /not a 24-hour rainfall total/,
  );
});

test('a recent last_modified is never the observation timestamp; old readings are omitted', () => {
  const f = joinedFixture();
  f.observations[0].time = new Date(NOW - 2 * 86400000).toISOString();
  f.observations[0].last_modified = new Date(NOW).toISOString();
  const n = normalizeUsgsWaterSnapshot(f);
  assert.equal(n.excludedOldCount, 1);
  assert.equal(n.readingCount, 6);
  assert.ok(
    n.records.every((s) =>
      s.readings.every((r) => r.observedAt === NOW - 15 * 60000),
    ),
  );
  assert.equal(waterTime('2026-10-11 12:00:00'), null);
  assert.equal(waterTime('2026-02-31T12:00:00Z'), null);
  assert.equal(waterTime('2026-10-11T24:00:00Z'), null);
});

test('Bexar requires both state 48 and county 029; missing metadata is an error', () => {
  const f = joinedFixture();
  f.stations[0].state_code = '12';
  assert.equal(
    normalizeUsgsWaterSnapshot(f).records.filter((r) => r.bexar).length,
    0,
  );
  f.stations.pop();
  assert.throws(() => normalizeUsgsWaterSnapshot(f), /Incomplete/);
});
