import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from '../layers/awareness/controls.js';
import { describeEntity } from './entityContext.js';

test('Contacts card shows the military cohort count', () => {
  const state = {
    enabled: true,
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
  };
  const [record] = createControls({
    state,
    services: {},
    parts: {},
    source: {},
  }).methods.getAnalystRecords();
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
