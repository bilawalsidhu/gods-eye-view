import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeBoundaryType,
  normalizeTectonicPlateSnapshot,
} from './tectonicPlates.js';

test('normalizes known tectonic boundary labels', () => {
  assert.equal(normalizeBoundaryType('Convergent Boundary'), 'convergent');
  assert.equal(normalizeBoundaryType('Divergent Boundary'), 'divergent');
  assert.equal(normalizeBoundaryType('Transform Boundary'), 'transform');
});

test('unknown tectonic boundary label falls back to other', () => {
  assert.equal(normalizeBoundaryType('Something New'), 'other');
  assert.equal(normalizeBoundaryType(null), 'other');
});

test('normalizes a valid USGS LineString feature', () => {
  const result = normalizeTectonicPlateSnapshot({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        geometry: {
          type: 'LineString',
          coordinates: [
            [66.5439987180665, 86.6549987795701],
            [66.3010025028633, 86.6060028079833],
          ],
        },
        properties: {
          OBJECTID: 1,
          NAME: 'Eurasian:North American',
          LABEL: 'Transform Boundary',
        },
      },
    ],
  });

  assert.deepEqual(result, [
    {
      id: '1',
      name: 'Eurasian:North American',
      boundaryType: 'transform',
      sourceLabel: 'Transform Boundary',
      coordinates: [
        [66.5439987180665, 86.6549987795701],
        [66.3010025028633, 86.6060028079833],
      ],
    },
  ]);
});

test('rejects invalid coordinates', () => {
  const result = normalizeTectonicPlateSnapshot({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        geometry: {
          type: 'LineString',
          coordinates: [
            [200, 95],
            [10, 20],
          ],
        },
        properties: {
          OBJECTID: 1,
          NAME: 'Broken',
          LABEL: 'Transform Boundary',
        },
      },
    ],
  });

  assert.equal(result, null);
});

test('rejects duplicate ids', () => {
  const result = normalizeTectonicPlateSnapshot({
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        id: 1,
        geometry: {
          type: 'LineString',
          coordinates: [
            [10, 20],
            [11, 21],
          ],
        },
        properties: {
          OBJECTID: 1,
          NAME: 'A',
          LABEL: 'Transform Boundary',
        },
      },
      {
        type: 'Feature',
        id: 1,
        geometry: {
          type: 'LineString',
          coordinates: [
            [12, 22],
            [13, 23],
          ],
        },
        properties: {
          OBJECTID: 1,
          NAME: 'B',
          LABEL: 'Divergent Boundary',
        },
      },
    ],
  });

  assert.equal(result, null);
});