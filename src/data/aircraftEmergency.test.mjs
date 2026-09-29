// src/data/aircraftEmergency.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  aircraftEmergency,
  isEmergency,
  normalizeSquawk,
} from './aircraftEmergency.js';

test('the three ICAO emergency squawks map to their kinds', () => {
  assert.equal(aircraftEmergency({ squawk: '7500' }).kind, 'unlawful');
  assert.equal(aircraftEmergency({ squawk: '7600' }).kind, 'nordo');
  const general = aircraftEmergency({ squawk: ' 7700 ' });
  assert.deepEqual(general, {
    kind: 'general',
    label: 'General emergency',
    severity: 'emergency',
    squawk: '7700',
    source: 'squawk',
  });
});

test('ordinary codes, blanks and non-octal values are not emergencies', () => {
  for (const squawk of ['1200', '7000', '2000', '', null, undefined, '7800'])
    assert.equal(aircraftEmergency({ squawk }), null, String(squawk));
  assert.equal(aircraftEmergency(), null);
  assert.equal(normalizeSquawk('7800'), null);
  assert.equal(normalizeSquawk(7700), '7700');
  assert.equal(normalizeSquawk('770'), null);
});

test('the ADS-B emergency field wins, and `none` defers to the squawk', () => {
  const minfuel = aircraftEmergency({ squawk: '4521', emergency: 'MinFuel' });
  assert.equal(minfuel.kind, 'minfuel');
  assert.equal(minfuel.severity, 'priority');
  assert.equal(minfuel.source, 'ads-b');
  assert.equal(minfuel.squawk, '4521');
  assert.equal(
    aircraftEmergency({ squawk: '7700', emergency: 'none' }).source,
    'squawk',
  );
  assert.equal(aircraftEmergency({ emergency: 'downed' }).kind, 'downed');
  assert.equal(aircraftEmergency({ emergency: 'none' }), null);
  assert.equal(aircraftEmergency({ emergency: 'reserved' }), null);
});

test('priority statuses are reported but are not emergencies', () => {
  assert.equal(isEmergency(aircraftEmergency({ squawk: '7700' })), true);
  assert.equal(
    isEmergency(aircraftEmergency({ emergency: 'lifeguard' })),
    false,
  );
  assert.equal(isEmergency(aircraftEmergency({ emergency: 'minfuel' })), false);
  assert.equal(isEmergency(null), false);
});
