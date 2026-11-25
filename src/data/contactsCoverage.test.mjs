import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from '../layers/awareness/controls.js';
import { describeEntity } from './entityContext.js';

test('Contacts card qualifies the installations count by its own coverage', () => {
  // Installations searched only 100 km around the subject (installations/source.js caps at 100 km).
  const layerState = {
    enabled: true,
    passive: false,
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
  };
  const controls = createControls({
    state: layerState,
    services: {},
    parts: { dependencies: {} },
    source: {},
  });
  const [record] = controls.methods.getAnalystRecords();
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
