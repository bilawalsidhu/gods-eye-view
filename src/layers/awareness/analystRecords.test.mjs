import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { fromDegrees } from '../../geo/ellipsoid.js';

function controlsWith(state) {
  return createControls({
    state: { enabled: true, subject: null, results: null, ...state },
    services: {},
    parts: {},
    source: null,
  }).methods;
}

test('Contacts lists its chosen contact at its position with cohort counts', () => {
  const controls = controlsWith({
    subject: {
      layerId: 'flights',
      id: 'abc123',
      label: 'UAL1',
      position: fromDegrees(-97.7, 30.3, 10000),
    },
    results: {
      evaluatedAt: 1_700_000_000_000,
      radiusM: 185_200,
      cohorts: [
        { id: 'flights', summary: { count: 12 } },
        { id: 'ais-live-vessels', summary: { count: null } },
      ],
    },
  });
  const [record, ...rest] = controls.getAnalystRecords();
  assert.equal(rest.length, 0);
  assert.equal(record.id, 'flights:abc123');
  assert.equal(record.name, 'UAL1');
  assert.ok(Math.abs(record.lat - 30.3) < 1e-6);
  assert.ok(Math.abs(record.lon + 97.7) < 1e-6);
  assert.equal(record.flightsCount, 12);
  assert.equal('vesselsCount' in record, false);
  assert.equal(record.radiusKm, 185.2);
});

test('Contacts lists nothing while off, passive or with no contact', () => {
  const subject = { layerId: 'flights', id: 'a', position: fromDegrees(0, 0) };
  assert.deepEqual(controlsWith({}).getAnalystRecords(), []);
  assert.deepEqual(
    controlsWith({ enabled: false, subject }).getAnalystRecords(),
    [],
  );
  assert.deepEqual(
    controlsWith({ passive: true, subject }).getAnalystRecords(),
    [],
  );
});
