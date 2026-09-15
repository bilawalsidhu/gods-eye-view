import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildEventEntry,
  candidateQueryUrl,
  defaultServiceForYear,
  deriveWindow,
  displayName,
  extentQueryUrl,
  formatCandidateTable,
  padBbox,
  parseCompactDay,
  rankCandidates,
  slugifyEventId,
  sourcesForYear,
} from './fireEventScaffold.js';

test('service and sources follow the year', () => {
  assert.equal(defaultServiceForYear(2018), 'nifc-history');
  assert.equal(defaultServiceForYear(2021), 'wfigs');
  assert.deepEqual(sourcesForYear(2008), ['MODIS_SP']);
  assert.deepEqual(sourcesForYear(2018), ['VIIRS_SNPP_SP', 'MODIS_SP']);
  assert.deepEqual(sourcesForYear(2024), ['VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP', 'MODIS_SP']);
});

test('candidateQueryUrl builds escaped, year-bounded queries per service', () => {
  const wfigs = candidateQueryUrl({ name: "o'brien", year: 2021, state: 'US-CA' });
  assert.equal(wfigs.service, 'wfigs');
  const p = new URL(wfigs.url).searchParams;
  assert.equal(
    p.get('where'),
    "UPPER(attr_IncidentName)='O''BRIEN' AND attr_FireDiscoveryDateTime >= timestamp '2021-01-01' AND attr_FireDiscoveryDateTime < timestamp '2022-01-01' AND attr_POOState='US-CA'",
  );
  assert.equal(p.get('returnGeometry'), 'false');
  const hist = candidateQueryUrl({ name: 'Camp', year: 2018 });
  assert.equal(hist.service, 'nifc-history');
  assert.equal(new URL(hist.url).searchParams.get('where'), "UPPER(INCIDENT)='CAMP' AND FIRE_YEAR='2018'");
  assert.throws(() => candidateQueryUrl({ name: 'x', year: 2020, service: 'nope' }), /Unknown perimeter service/);
  assert.match(extentQueryUrl('wfigs', 30039.7), /where=OBJECTID%3D30039&returnExtentOnly=true&outSR=4326/);
});

test('rankCandidates normalizes both services and sorts by acreage', () => {
  const wfigs = rankCandidates(
    { features: [
      { attributes: { OBJECTID: 1, attr_IncidentName: 'Park', attr_POOState: 'US-NM', poly_GISAcres: 0.1, attr_FireDiscoveryDateTime: 1751495794000 } },
      { attributes: { OBJECTID: 2, attr_IncidentName: 'PARK', attr_POOState: 'US-CA', attr_POOCounty: 'Butte', poly_GISAcres: 429602.85, attr_FireDiscoveryDateTime: 1721857963000, attr_ContainmentDateTime: null, poly_DateCurrent: 1724525800000 } },
      { attributes: { OBJECTID: 'x' } },
    ] },
    'wfigs',
  );
  assert.deepEqual(wfigs.map((c) => c.objectId), [2, 1]);
  assert.equal(wfigs[0].county, 'Butte');
  assert.equal(wfigs[0].containmentMs, null);
  const hist = rankCandidates(
    { features: [{ attributes: { OBJECTID: 50567, INCIDENT: 'CAMP', FIRE_YEAR: '2018', GIS_ACRES: 153335.6, UNIT_ID: 'CABTU', AGENCY: 'CDF', DATE_CUR: 20181126 } }] },
    'nifc-history',
  );
  assert.equal(hist[0].unitId, 'CABTU');
  assert.equal(hist[0].currentMs, Date.UTC(2018, 10, 26));
  assert.equal(parseCompactDay('2018-11-26'), null);
  assert.deepEqual(rankCandidates(null, 'wfigs'), []);
});

test('deriveWindow prefers published dates and flags estimates', () => {
  const disc = Date.UTC(2024, 6, 24);
  const full = deriveWindow({ discoveryMs: disc, containmentMs: Date.UTC(2024, 8, 26) });
  assert.deepEqual(full, { startDate: '2024-07-24', endDate: '2024-09-26', startEstimated: false, endEstimated: false });
  const current = deriveWindow({ discoveryMs: disc, currentMs: Date.UTC(2024, 7, 24) });
  assert.equal(current.endDate, '2024-08-24');
  assert.equal(current.endEstimated, true);
  const bare = deriveWindow({ discoveryMs: disc });
  assert.equal(bare.endDate, '2024-08-23');
  assert.equal(bare.endEstimated, true);
  const history = deriveWindow({ currentMs: Date.UTC(2018, 10, 26) });
  assert.equal(history.startDate, '2018-10-27');
  assert.equal(history.startEstimated, true);
  assert.equal(history.endDate, '2018-11-26');
  const overridden = deriveWindow({ discoveryMs: disc }, { start: '2024-07-20', end: '2024-07-10' });
  assert.equal(overridden.endDate, '2024-07-20', 'end never precedes start');
  assert.throws(() => deriveWindow({}), /--start/);
});

test('padBbox pads proportionally with a floor and rounds', () => {
  assert.deepEqual(padBbox({ xmin: -121.7778, ymin: 39.5986, xmax: -121.3526, ymax: 39.8978 }), [-121.829, 39.548, -121.302, 39.949]);
  assert.deepEqual(padBbox({ xmin: 0, ymin: 0, xmax: 0.01, ymax: 0.01 }), [-0.02, -0.02, 0.03, 0.03]);
  assert.throws(() => padBbox({ xmin: 1, ymin: 1, xmax: 0, ymax: 2 }), /--bbox/);
});

test('ids and names are normalized', () => {
  assert.equal(slugifyEventId('CAMP', 2018), 'camp-fire-2018');
  assert.equal(slugifyEventId('Dixie Fire', 2021), 'dixie-fire-2021');
  assert.equal(slugifyEventId("Lahaina", 2023), 'lahaina-fire-2023');
  assert.equal(slugifyEventId('São Paulo', 2020), 'sao-paulo-fire-2020');
  assert.equal(displayName('CAMP'), 'Camp Fire');
  assert.equal(displayName('Park'), 'Park Fire');
  assert.equal(displayName('Dixie Fire'), 'Dixie Fire');
});

test('buildEventEntry yields a validated config entry with honest warnings', () => {
  const candidate = { objectId: 2, name: 'PARK', state: 'US-CA', county: 'Butte', acres: 429602.85, discoveryMs: Date.UTC(2024, 6, 24) };
  const window = deriveWindow(candidate, { end: '2024-09-26' });
  const { entry, warnings } = buildEventEntry({ candidate, service: 'wfigs', year: 2024, bbox: [-122.1, 39.75, -121.3, 40.45], window });
  assert.equal(entry.id, 'park-fire-2024');
  assert.equal(entry.name, 'Park Fire');
  assert.equal(entry.region, 'Butte County, CA, USA');
  assert.equal(entry.burnedHa, 173854);
  assert.deepEqual(entry.sources, ['VIIRS_SNPP_SP', 'VIIRS_NOAA20_SP', 'VIIRS_NOAA21_SP', 'MODIS_SP']);
  assert.deepEqual(entry.perimeter, { service: 'wfigs', incident: 'PARK', state: 'US-CA', discoveredAfter: '2024-07-17' });
  assert.ok(warnings.some((w) => /summary/.test(w)));
  assert.ok(warnings.some((w) => /references/.test(w)));
  const hist = buildEventEntry({
    candidate: { objectId: 1, name: 'CAMP', unitId: 'CABTU', acres: 153335.6, currentMs: Date.UTC(2018, 10, 26) },
    service: 'nifc-history', year: 2018, bbox: [-121.83, 39.55, -121.3, 39.95],
    window: deriveWindow({ currentMs: Date.UTC(2018, 10, 26) }, { start: '2018-11-08' }),
    region: 'Butte County, California, USA', summary: 'x', references: [{ label: 'a', url: 'https://a.example' }],
  });
  assert.deepEqual(hist.entry.perimeter, { service: 'nifc-history', incident: 'CAMP', fireYear: '2018', unitId: 'CABTU' });
  assert.equal(hist.entry.burnedHa, 62053);
  assert.ok(hist.warnings.every((w) => !/summary|references|region/.test(w)));
  assert.match(formatCandidateTable([candidate]), /\[0\]  PARK  US-CA  Butte  429,603 ac  disc 2024-07-24/);
});
