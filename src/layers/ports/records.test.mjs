import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWpiFeature,
  normalizeWpiFeatures,
  portProfileLines,
  visibleWpiPort,
  wpiAffirmative,
} from './records.js';

const port = (number, props = {}, lon = -2.5, lat = 53.4) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties: {
    objectid: number,
    wpinumber: number,
    main_port_name: `Harbour ${number}`,
    wpi_cc: 'GB',
    fac_container: 'Yes',
    fac_solidbulk: null,
    fac_oilterm: 'No',
    fac_lngterm: '-',
    unlocode: 'GBABC',
    ...props,
  },
});

test('only affirmative WPI facility values satisfy facility filters', () => {
  for (const value of ['Y', 'yes', 'TRUE', true, 1])
    assert.equal(wpiAffirmative(value), true);
  for (const value of ['No', 'n', false, 0])
    assert.equal(wpiAffirmative(value), false);
  for (const value of [null, undefined, '', '-', 'unknown', 'N/A', 5])
    assert.equal(wpiAffirmative(value), null);
  const record = normalizeWpiFeature(port(404));
  assert.equal(record.facilities.container, true);
  assert.equal(record.facilities['solid-bulk'], null);
  assert.equal(record.facilities.oil, false);
  assert.equal(record.facilities.lng, null);
  assert.equal(visibleWpiPort(record, { facility: 'container' }), true);
  assert.equal(visibleWpiPort(record, { facility: 'solid-bulk' }), false);
  assert.equal(visibleWpiPort(record, { facility: 'oil' }), false);
  assert.equal(visibleWpiPort(record, { facility: 'lng' }), false);
  assert.equal(visibleWpiPort(record, { country: 'GB' }), true);
  assert.equal(visibleWpiPort(record, { country: 'FR' }), false);
});

test('WPI identifier is stable and commercial fields are explicitly unknown', () => {
  const record = normalizeWpiFeature(port(123));
  assert.equal(record.id, 'wpi:123');
  assert.equal(record.wpiNumber, 123);
  assert.equal(record.unlocode, 'GBABC');
  assert.equal(record.source.includes('NGA WPI'), true);
  assert.deepEqual(record.commercial, {
    operator: null,
    ownership: null,
    annualThroughput: null,
    handlingCapacity: null,
    operationalStatus: null,
    expansion: null,
  });
  assert.match(
    portProfileLines(record).join('\n'),
    /Operational status: Unavailable/,
  );
  assert.match(
    portProfileLines(record).join('\n'),
    /Annual throughput: Unavailable/,
  );
});

test('reject invalid coordinates, identifiers, and duplicate WPI numbers', () => {
  assert.equal(normalizeWpiFeature(port(1, {}, null, 0)), null);
  assert.equal(normalizeWpiFeature(port(2, {}, 190, 1)), null);
  assert.equal(normalizeWpiFeature(port(3, {}, 2, -91)), null);
  assert.equal(normalizeWpiFeature(port(4, { wpinumber: 'a' })), null);
  assert.equal(normalizeWpiFeature(port(5, { wpinumber: 0 })), null);
  assert.equal(
    normalizeWpiFeature({
      ...port(6),
      geometry: {
        type: 'LineString',
        coordinates: [
          [0, 0],
          [1, 1],
        ],
      },
    }),
    null,
  );
  assert.equal(normalizeWpiFeatures([port(7), port(8)]).records.length, 2);
  assert.equal(normalizeWpiFeatures('not a feature collection'), null);
});

// Real NETL layer 17 shape: objectid is unique, wpinumber is not always.
const netl = (objectid, wpinumber, name) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [-16.1, 65.26] },
  properties: {
    objectid,
    wpinumber,
    regionname: 'Iceland',
    main_port_name: name,
    alternate_name: null,
    wpi_cc: 'IS',
    unlocode: 'ISSEY',
    harbor_size_code: 'S',
    fac_container: 'No',
  },
});

test('a duplicate WPI number keeps the first row and counts the rest', () => {
  const out = normalizeWpiFeatures([
    netl(1, 400, 'Seydisfjordur'),
    netl(2, 401, 'Other'),
    netl(3, 400, 'Seydhisfjordhur'),
  ]);
  assert.deepEqual(
    out.records.map((r) => r.id),
    ['wpi:400', 'wpi:401'],
  );
  assert.equal(out.records[0].name, 'Seydisfjordur');
  assert.equal(out.skipped.duplicateId, 1);
  assert.equal(out.skipped.total, 1);
});

test('fractional and malformed WPI numbers are skipped and counted, never coerced', () => {
  const out = normalizeWpiFeatures([
    netl(1, 49454.5, 'Kattupalli Port'),
    netl(2, 9510.1, 'Puerto Progreso'),
    netl(3, 'abc', 'Bad text id'),
    netl(4, null, 'Null id'),
    netl(5, -3, 'Negative id'),
    netl(6, 12, 'Good Port'),
  ]);
  assert.deepEqual(
    out.records.map((r) => r.id),
    ['wpi:12'],
  );
  assert.equal(out.skipped.fractionalId, 2);
  assert.equal(out.skipped.malformedId, 3);
  assert.equal(out.skipped.total, 5);
});

test('a snapshot with a few bad rows still serves the good rows', () => {
  const rows = [
    ...Array.from({ length: 50 }, (_, i) =>
      netl(i + 1, i + 1, `Port ${i + 1}`),
    ),
    netl(51, 7, 'Dup of 7'),
    netl(52, 49454.5, 'Fractional'),
    netl(53, 'x', 'Malformed'),
    { type: 'Feature', geometry: null, properties: { wpinumber: 99 } },
    (() => {
      const nameless = netl(55, 100, '   ');
      nameless.properties.regionname = null;
      return nameless;
    })(),
  ];
  const out = normalizeWpiFeatures(rows);
  assert.equal(out.records.length, 50);
  assert.deepEqual(out.skipped, {
    total: 5,
    duplicateId: 1,
    fractionalId: 1,
    malformedId: 1,
    invalidGeometry: 1,
    missingName: 1,
  });
});

test('unknown origin facts remain unavailable, never current operations', () => {
  const record = normalizeWpiFeature(
    port(700, {
      main_port_name: 'Bay Port',
      fac_oilterm: 'unknown',
      fac_lngterm: 'Y',
      port_security: 'Yes',
    }),
  );
  assert.equal(record.facilities.oil, null);
  assert.equal(record.facilities.lng, true);
  assert.equal(record.commercial.operationalStatus, null);
  assert.ok(
    portProfileLines(record).some((text) =>
      text.includes('not current operation'),
    ),
  );
  assert.equal(visibleWpiPort(record, { facility: 'does-not-exist' }), false);
});
