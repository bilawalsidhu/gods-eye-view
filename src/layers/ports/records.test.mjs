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
  assert.match(portProfileLines(record).join('\n'), /Operational status: Unavailable/);
  assert.match(portProfileLines(record).join('\n'), /Annual throughput: Unavailable/);
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
      geometry: { type: 'LineString', coordinates: [[0, 0], [1, 1]] },
    }),
    null,
  );
  assert.equal(normalizeWpiFeatures([port(7), port(7)]), null);
  assert.equal(normalizeWpiFeatures([port(7), port(8)]).length, 2);
  assert.equal(normalizeWpiFeatures('not a feature collection'), null);
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
  assert.ok(portProfileLines(record).some((text) => text.includes('not current operation')));
  assert.equal(visibleWpiPort(record, { facility: 'does-not-exist' }), false);
});
