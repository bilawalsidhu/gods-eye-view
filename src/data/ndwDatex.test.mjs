import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordScanner, parseSiteRecord, parseSiteMeasurement } from './ndwDatex.js';

const SITE = `<measurementSiteRecord id="PZH01_MST_0870_00" version="19">`
  + `<measurementSiteName><values><value lang="nl">N470 km 15.391 Re</value></values></measurementSiteName>`
  + `<measurementSiteLocation xsi:type="Point"><locationForDisplay>`
  + `<latitude>52.03194</latitude><longitude>4.484946</longitude>`
  + `</locationForDisplay></measurementSiteLocation></measurementSiteRecord>`;

const speed = (used, value) =>
  `<measuredValue index="1"><measuredValue><basicData xsi:type="TrafficSpeed">`
  + `<averageVehicleSpeed numberOfInputValuesUsed="${used}"><speed>${value}</speed></averageVehicleSpeed>`
  + `</basicData></measuredValue></measuredValue>`;
const flow = (rate) =>
  `<measuredValue index="2"><measuredValue><basicData xsi:type="TrafficFlow">`
  + `<vehicleFlow><vehicleFlowRate>${rate}</vehicleFlowRate></vehicleFlow>`
  + `</basicData></measuredValue></measuredValue>`;
const block = (inner, id = 'PZH01_MST_0870_00') =>
  `<siteMeasurements><measurementSiteReference id="${id}" version="12"/>`
  + `<measurementTimeDefault>2026-09-11T13:39:00Z</measurementTimeDefault>${inner}</siteMeasurements>`;

test('a site record yields its id, display point and human name', () => {
  const site = parseSiteRecord(SITE);
  assert.equal(site.id, 'PZH01_MST_0870_00');
  assert.equal(site.lat, 52.03194);
  assert.equal(site.lon, 4.484946);
  // `<values>` also starts with `<value`; matching the plural drags the tag in.
  assert.equal(site.name, 'N470 km 15.391 Re');
});

test('a record with no display point is skipped, not positioned at zero', () => {
  assert.equal(parseSiteRecord(SITE.replace(/<locationForDisplay>.*?<\/locationForDisplay>/, '')), null);
  assert.equal(parseSiteRecord('<measurementSiteRecord id="X"></measurementSiteRecord>'), null);
});

test('an out-of-range coordinate is refused', () => {
  assert.equal(parseSiteRecord(SITE.replace('52.03194', '991')), null);
  assert.equal(parseSiteRecord(SITE.replace('4.484946', '-400')), null);
});

test('the wanted-set filter keeps only the ids asked for', () => {
  assert.equal(parseSiteRecord(SITE, new Set(['PZH01_MST_0870_00'])).id, 'PZH01_MST_0870_00');
  assert.equal(parseSiteRecord(SITE, new Set(['other'])), null);
  assert.ok(parseSiteRecord(SITE, null), 'no filter means keep everything');
});

test('lanes that measured nothing are left out of the average', () => {
  // A loop with no vehicle to time reports speed -1 and zero inputs. Averaging
  // those in drags every quiet road towards zero.
  const m = parseSiteMeasurement(block(speed(0, -1) + speed(4, 76) + speed(2, 80)));
  assert.equal(m.speedKph, 78, 'the -1 lane must not be averaged in');
  assert.equal(m.lanes, 2);
});

test('flow is summed across lanes while speed is averaged', () => {
  const m = parseSiteMeasurement(block(speed(4, 60) + speed(4, 80) + flow(240) + flow(60)));
  assert.equal(m.speedKph, 70);
  assert.equal(m.flowVph, 300);
});

test('a block with no usable value at all yields null', () => {
  assert.equal(parseSiteMeasurement(block(speed(0, -1))), null);
  assert.equal(parseSiteMeasurement('<siteMeasurements></siteMeasurements>'), null);
});

test('the site id is read by attribute name, not by attribute position', () => {
  // traveltime.xml.gz writes targetClass before id; a positional read breaks.
  const reordered = block(speed(4, 70)).replace(
    '<measurementSiteReference id="PZH01_MST_0870_00" version="12"/>',
    '<measurementSiteReference targetClass="MeasurementSiteRecord" id="PZH01_MST_0870_00" version="12"/>');
  assert.equal(parseSiteMeasurement(reordered).siteId, 'PZH01_MST_0870_00');
});

test('records split across chunk boundaries are still delivered whole', () => {
  const seen = [];
  const scanner = createRecordScanner('siteMeasurements', (r) => seen.push(r));
  const doc = block(speed(4, 50), 'A') + block(speed(4, 90), 'B');
  // One character at a time is the worst case a stream can produce.
  for (const c of doc) scanner.push(c);
  assert.equal(seen.length, 2);
  assert.equal(parseSiteMeasurement(seen[0]).siteId, 'A');
  assert.equal(parseSiteMeasurement(seen[1]).speedKph, 90);
});

test('the scanner does not emit an unterminated tail, and drops nothing before it', () => {
  const seen = [];
  const scanner = createRecordScanner('siteMeasurements', (r) => seen.push(r));
  scanner.push(block(speed(4, 50), 'A') + '<siteMeasurements><measurementSiteReference id="B"');
  assert.equal(seen.length, 1, 'the half-written record must wait for its close tag');
  scanner.push(' version="1"/>' + speed(4, 60) + '</siteMeasurements>');
  assert.equal(seen.length, 2);
  assert.equal(parseSiteMeasurement(seen[1]).siteId, 'B');
});

test('a lane reporting zero inputs is excluded even when its speed looks valid', () => {
  // The -1 sentinel is not the only shape this takes: a loop can report a
  // plausible number with nothing behind it. `numberOfInputValuesUsed` is the
  // authority, and a range check on the value alone does not stand in for it.
  const m = parseSiteMeasurement(block(speed(0, 50) + speed(4, 90)));
  assert.equal(m.speedKph, 90, 'the zero-input lane must not be averaged in');
  assert.equal(m.lanes, 1);
});

test('a child tag sharing the record name as a prefix does not become the start', () => {
  // measurementSiteRecordVersionTime lives INSIDE measurementSiteRecord, so a
  // scanner matching on the bare prefix starts the record in the middle of it.
  const seen = [];
  const scanner = createRecordScanner('measurementSiteRecord', (r) => seen.push(r));
  scanner.push(`<measurementSiteRecord id="A" version="1">`
    + `<measurementSiteRecordVersionTime>2025-10-14T15:24:21Z</measurementSiteRecordVersionTime>`
    + `<measurementSiteLocation><locationForDisplay><latitude>52.0</latitude>`
    + `<longitude>4.4</longitude></locationForDisplay></measurementSiteLocation>`
    + `</measurementSiteRecord>`);
  assert.equal(seen.length, 1);
  const site = parseSiteRecord(seen[0]);
  assert.equal(site?.id, 'A', 'a record starting mid-element loses its id');
});
