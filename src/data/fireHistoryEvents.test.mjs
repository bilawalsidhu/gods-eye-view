import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterRecordsToEvent,
  firmsAreaSegment,
  normalizeFireEvent,
  normalizeFireEventCatalog,
  normalizeFirePerimeter,
  perimeterQueryUrl,
  selectPerimeterFeature,
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

test('normalizeFirePerimeter accepts only whitelisted services and structured filters', () => {
  const history = normalizeFirePerimeter({ service: 'nifc-history', incident: 'CAMP', fireYear: '2018', unitId: 'CABTU' });
  assert.deepEqual(history, { service: 'nifc-history', incident: 'CAMP', fireYear: '2018', unitId: 'CABTU' });
  assert.ok(Object.isFrozen(history));
  const wfigs = normalizeFirePerimeter({ service: 'wfigs', incident: "O'Brien", state: 'US-CA', discoveredAfter: '2024-07-01' });
  assert.equal(wfigs.discoveredAfter, '2024-07-01');
  assert.equal(normalizeFirePerimeter({ service: 'other', incident: 'X' }), null);
  assert.equal(normalizeFirePerimeter({ service: 'nifc-history', incident: 'CAMP', fireYear: '18' }), null);
  assert.equal(normalizeFirePerimeter({ service: 'nifc-history', incident: "X' OR 1=1 --", fireYear: '2018' }), null);
  assert.equal(normalizeFirePerimeter({ service: 'wfigs', incident: 'Park', state: 'CA', discoveredAfter: '2024-07-01' }), null);
  assert.equal(normalizeFirePerimeter({ service: 'wfigs', incident: 'Park', state: 'US-CA', discoveredAfter: 'soon' }), null);
  assert.equal(normalizeFirePerimeter(null), null);
  // An event with a malformed perimeter is rejected as a whole.
  assert.equal(normalizeFireEvent({ ...VALID, perimeter: { service: 'nope' } }), null);
  assert.equal(normalizeFireEvent({ ...VALID }).perimeter, null);
});

test('perimeterQueryUrl targets the whitelisted service with escaped filters', () => {
  const url = perimeterQueryUrl({ service: 'wfigs', incident: "O'Brien", state: 'US-CA', discoveredAfter: '2024-07-01' });
  assert.ok(url.startsWith('https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters/FeatureServer/0/query?'));
  const params = new URL(url).searchParams;
  assert.equal(params.get('where'), "attr_IncidentName='O''Brien' AND attr_POOState='US-CA' AND attr_FireDiscoveryDateTime > timestamp '2024-07-01'");
  assert.equal(params.get('f'), 'geojson');
  assert.equal(params.get('outSR'), '4326');
  const hist = new URL(perimeterQueryUrl({ service: 'nifc-history', incident: 'CAMP', fireYear: '2018', unitId: 'CABTU' })).searchParams;
  assert.equal(hist.get('where'), "INCIDENT='CAMP' AND FIRE_YEAR='2018' AND UNIT_ID='CABTU'");
  assert.equal(perimeterQueryUrl({ service: 'x' }), null);
});

test('selectPerimeterFeature keeps the largest polygon and its currency date', () => {
  const poly = { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] };
  const picked = selectPerimeterFeature(
    { features: [
      { geometry: poly, properties: { poly_GISAcres: 10, poly_DateCurrent: 1694128641000 } },
      { geometry: { type: 'Point', coordinates: [0, 0] }, properties: { poly_GISAcres: 999 } },
      { geometry: { ...poly, type: 'MultiPolygon', coordinates: [poly.coordinates] }, properties: { poly_GISAcres: 2123.5, poly_DateCurrent: 1694128641000 } },
    ] },
    'wfigs',
  );
  assert.equal(picked.acres, 2123.5);
  assert.equal(picked.geometry.type, 'MultiPolygon');
  assert.equal(picked.dateCurrentMs, 1694128641000);
  assert.equal(selectPerimeterFeature({ features: [] }, 'wfigs'), null);
  assert.equal(selectPerimeterFeature({ features: [{ geometry: poly, properties: {} }] }, 'nifc-history').acres, null);
  assert.equal(selectPerimeterFeature({}, 'bogus'), null);
});
