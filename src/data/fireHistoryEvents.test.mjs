import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRecordsToEvent,
  firmsAreaSegment,
  normalizeFireEvent,
  normalizeFireEventCatalog,
  parseUtcDay,
  splitDateWindows,
} from './fireHistoryEvents.js';

const VALID = {
  id: 'camp-fire-2018',
  name: 'Camp Fire',
  region: 'Butte County',
  startDate: '2018-11-08',
  endDate: '2018-11-25',
  bbox: [-121.75, 39.65, -121.3, 39.95],
  sources: ['VIIRS_SNPP_SP', 'MODIS_SP'],
  burnedHa: 62053,
  references: [{ label: 'CAL FIRE', url: 'https://www.fire.ca.gov/x' }],
};

test('parseUtcDay accepts real calendar days only', () => {
  assert.equal(parseUtcDay('2018-11-08'), Date.UTC(2018, 10, 8));
  assert.ok(Number.isNaN(parseUtcDay('2018-02-31')));
  assert.ok(Number.isNaN(parseUtcDay('2018-11-8')));
  assert.ok(Number.isNaN(parseUtcDay(20181108)));
});

test('normalizeFireEvent freezes a validated copy with an exclusive endMs', () => {
  const event = normalizeFireEvent(VALID);
  assert.ok(Object.isFrozen(event));
  assert.equal(event.startMs, Date.UTC(2018, 10, 8));
  assert.equal(event.endMs, Date.UTC(2018, 10, 26));
  assert.deepEqual([...event.sources], ['VIIRS_SNPP_SP', 'MODIS_SP']);
  assert.equal(event.references.length, 1);
});

test('normalizeFireEvent rejects unsafe or meaningless definitions', () => {
  const reject = (patch) =>
    assert.equal(normalizeFireEvent({ ...VALID, ...patch }), null);
  reject({ id: '../etc' });
  reject({ id: 'Camp Fire' });
  reject({ name: '' });
  reject({ endDate: '2018-11-07' });
  reject({ bbox: [-121.3, 39.65, -121.75, 39.95] });
  reject({ bbox: [-181, 39.65, -121.3, 39.95] });
  reject({ sources: ['VIIRS_SNPP_NRT'] });
  reject({ sources: [] });
});

test('normalizeFireEvent drops non-https references and unknown sources', () => {
  const event = normalizeFireEvent({
    ...VALID,
    sources: ['MODIS_SP', 'BOGUS', 'MODIS_SP'],
    references: [{ label: 'x', url: 'http://insecure.example' }],
  });
  assert.deepEqual([...event.sources], ['MODIS_SP']);
  assert.equal(event.references.length, 0);
});

test('normalizeFireEventCatalog keeps valid events and reports the rest', () => {
  const { events, rejected } = normalizeFireEventCatalog({
    events: [VALID, { ...VALID, name: '' }, VALID, { id: 'x-2' }],
  });
  assert.equal(events.length, 1);
  assert.deepEqual(rejected, ['camp-fire-2018', 'camp-fire-2018', 'x-2']);
  assert.deepEqual(normalizeFireEventCatalog(null), {
    events: [],
    rejected: [],
  });
});

test('splitDateWindows covers the inclusive range in FIRMS-sized windows', () => {
  assert.deepEqual(splitDateWindows('2018-11-08', '2018-11-25'), [
    { date: '2018-11-08', days: 5 },
    { date: '2018-11-13', days: 5 },
    { date: '2018-11-18', days: 5 },
    { date: '2018-11-23', days: 3 },
  ]);
  assert.deepEqual(splitDateWindows('2023-08-08', '2023-08-08'), [
    { date: '2023-08-08', days: 1 },
  ]);
  assert.deepEqual(splitDateWindows('2023-08-08', '2023-08-12'), [
    { date: '2023-08-08', days: 5 },
  ]);
  assert.deepEqual(splitDateWindows('2023-08-09', '2023-08-08'), []);
  // A caller cannot exceed the upstream cap.
  assert.deepEqual(splitDateWindows('2024-07-24', '2024-07-28', 30), [
    { date: '2024-07-24', days: 5 },
  ]);
});

test('firmsAreaSegment emits bounded-precision W,S,E,N', () => {
  assert.equal(
    firmsAreaSegment([-121.75, 39.65, -121.3, 39.95]),
    '-121.7500,39.6500,-121.3000,39.9500',
  );
});

test('filterRecordsToEvent clamps to box and day range', () => {
  const event = normalizeFireEvent(VALID);
  const inside = { lat: 39.8, lon: -121.5, acqDate: '2018-11-10' };
  const lastDay = { lat: 39.8, lon: -121.5, acqDate: '2018-11-25' };
  const spill = { lat: 39.8, lon: -121.5, acqDate: '2018-11-26' };
  const outside = { lat: 41, lon: -121.5, acqDate: '2018-11-10' };
  const badDate = { lat: 39.8, lon: -121.5, acqDate: 'nope' };
  assert.deepEqual(
    filterRecordsToEvent([inside, lastDay, spill, outside, badDate], event),
    [inside, lastDay],
  );
  assert.deepEqual(filterRecordsToEvent(null, event), []);
});
