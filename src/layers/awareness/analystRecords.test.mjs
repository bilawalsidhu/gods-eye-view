import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { describeEntity } from '../../data/entityContext.js';
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

test('Contacts card shows the military cohort count', () => {
  const controls = controlsWith({
    subject: {
      layerId: 'flights',
      id: 'abc',
      label: 'N123',
      position: { x: 6378137, y: 0, z: 0 },
    },
    results: {
      radiusM: 250_000,
      cohorts: [
        { id: 'flights', summary: { count: 3 } },
        { id: 'military', summary: { count: 2 } },
        { id: 'ais-live-vessels', summary: { count: 4 } },
        { id: 'military-installations', summary: { count: 1 } },
      ],
    },
  });
  const [record] = controls.getAnalystRecords();
  const facts = describeEntity(null, {
    layerId: 'military-awareness',
    id: record.id,
    record,
  }).facts;
  assert.ok(
    facts.some((f) => f.value === '3'),
    'flights count shown',
  );
  assert.ok(
    facts.some(
      (f) =>
        /military/i.test(f.field) &&
        !/installation/i.test(f.field) &&
        f.value === '2',
    ),
    'military cohort count shown',
  );
});

test('Contacts card qualifies the installations count by its own coverage', () => {
  // Installations searched only 100 km around the subject (installations/source.js caps at 100 km).
  const controls = controlsWith({
    subject: {
      layerId: 'flights',
      id: 'abc',
      label: 'N123',
      position: { x: 6378137, y: 0, z: 0 },
    },
    results: {
      evaluatedAt: 1,
      radiusM: 250_000,
      cohorts: [
        { id: 'flights', summary: { count: 3 } },
        {
          id: 'military-installations',
          coverage: 'WITHIN 100 KM',
          summary: {
            count: 0,
            reason: 'none mapped within 100 km; not a complete 250 km survey',
          },
        },
      ],
    },
  });
  const [record] = controls.getAnalystRecords();
  const facts = describeEntity(null, {
    layerId: 'military-awareness',
    id: record.id,
    record,
  }).facts;
  const text = JSON.stringify(facts);
  assert.match(
    text,
    /100/,
    'the installation count names its 100 km coverage, not only the 250 km radius',
  );
});

test('installation coverage requires a count', () => {
  const controls = controlsWith({
    subject: {
      layerId: 'flights',
      id: 'abc',
      label: 'N123',
      position: { x: 6378137, y: 0, z: 0 },
    },
    results: {
      evaluatedAt: 1,
      radiusM: 250_000,
      cohorts: [
        { id: 'flights', summary: { count: 3 } },
        {
          id: 'military-installations',
          coverage: 'CURRENT VIEWPORT ONLY',
          summary: { count: null, reason: 'layer off' },
        },
      ],
    },
  });
  const [record] = controls.getAnalystRecords();
  const facts = describeEntity(null, {
    layerId: 'military-awareness',
    id: record.id,
    record,
  }).facts;
  assert.ok(
    !facts.some((f) => /Installations searched/.test(f.label)),
    'no coverage fact without a count',
  );
});
