// The datacenter and dam layers' engine-free parts (localGeojsonCore.js):
// card copy and entries, the card cohort, the overlay publisher and the
// dataset error text. The drawing is tested in
// src/layers/infrastructure/render/display.test.mjs, the session in
// src/layers/infrastructure/session.test.mjs.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as geo from '../geo/index.js';
import {
  LOCAL_OVERLAY_COHORT_LIMIT,
  createLocalInfrastructureOverlayEntry,
  createLocalInfrastructureOverlayPublisher,
  localDatasetError,
  localInfrastructureOverlayCopy,
  selectLocalInfrastructureOverlayCohort,
} from './localGeojsonCore.js';

test('local infrastructure card copy uses the owner-approved source fields', () => {
  assert.deepEqual(
    localInfrastructureOverlayCopy(
      {
        tags: {
          name: 'DFW-1',
          operator: 'Example Cloud',
          'capacity:it_load': '27 MW',
        },
      },
      'local-datacenters',
    ),
    {
      title: 'DFW-1',
      details: ['Example Cloud · 27 MW'],
    },
  );

  assert.deepEqual(
    localInfrastructureOverlayCopy(
      {
        name: 'Barrage Bin el Ouidane',
        tags: { associated_river: 'El Abid' },
      },
      'local-dams',
    ),
    {
      title: 'Barrage Bin el Ouidane',
      details: ['El Abid'],
    },
  );

  assert.deepEqual(
    localInfrastructureOverlayCopy(
      {
        tags: { name: 'Amazon Web Services', operator: 'Amazon Web Services' },
      },
      'local-datacenters',
    ),
    {
      title: 'Amazon Web Services',
      details: [],
    },
  );
});

test('local infrastructure entries satisfy the shared presentation contract', () => {
  const position = geo.cartesian3.fromDegrees(-97.7, 30.2, 2000);
  const entry = createLocalInfrastructureOverlayEntry({
    id: 'dc-42',
    layerId: 'local-datacenters',
    position,
    properties: { tags: { name: 'AUS-1', operator: 'Example Cloud' } },
    priority: 1180,
    accent: '#00ffff',
  });

  assert.equal(entry.id, 'dc-42');
  assert.equal(entry.source, 'local-datacenters');
  assert.equal(
    entry.position,
    position,
    'entry stays attached to the mutable stem-tip Cartesian',
  );
  assert.equal(entry.variant, 'card');
  assert.equal(entry.title, 'AUS-1');
  assert.deepEqual(entry.details, ['Example Cloud']);
  assert.equal(entry.priority, 1180);
  assert.equal(entry.collisionGroup, 'ambient-card');
  assert.equal(
    entry.interactive,
    false,
    'the display picks its tips and stems',
  );
  assert.equal(entry.maxDistance, 14_000_000);
  assert.equal(entry.distanceFadeStartRatio, 250_000 / 14_000_000);
  assert.deepEqual(entry.distanceScale, {
    near: 250_000,
    nearValue: 1,
    far: 9_000_000,
    farValue: 0.62,
  });
  assert.equal(entry.edgeFade, 'keyhole');
  assert.equal(entry.horizonCull, true);
  assert.equal(entry.terrainOcclusion, false);
});

test('shipped local cohorts keep one grid winner plus bounded surplus contenders', () => {
  const makeRecord = (id, priority, x, y = 20) => ({
    id,
    priority,
    screen: { x, y },
    entry: { id },
  });
  const sameCell = [
    makeRecord('low', 1, 20),
    makeRecord('high', 3, 21),
    makeRecord('mid', 2, 22),
    makeRecord('offscreen', 100, -500),
  ];
  const selected = selectLocalInfrastructureOverlayCohort(sameCell, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 1440,
    height: 900,
    project: (record) => record.screen,
  });
  assert.deepEqual(
    selected.map(({ id }) => id),
    ['high', 'mid'],
  );

  const field = Array.from({ length: 220 }, (_, index) =>
    makeRecord(`record-${index}`, 1000 - index, index * 140),
  );
  const datacenters = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  const dams = selectLocalInfrastructureOverlayCohort(field, {
    maxEntries: 900,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 132,
    width: 150_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(datacenters.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(dams.length, LOCAL_OVERLAY_COHORT_LIMIT);

  const pairedCells = Array.from({ length: 120 }, (_, index) => [
    makeRecord(`primary-${index}`, 1000, index * 140),
    makeRecord(`surplus-${index}`, 900, index * 140 + 1),
  ]).flat();
  const hostBound = selectLocalInfrastructureOverlayCohort(pairedCells, {
    maxEntries: 700,
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    gridPx: 138,
    width: 20_000,
    height: 900,
    project: (record) => record.screen,
  });
  assert.equal(hostBound.length, LOCAL_OVERLAY_COHORT_LIMIT);
  assert.equal(
    hostBound.filter(({ id }) => id.startsWith('primary-')).length,
    120,
  );
  assert.equal(
    hostBound.filter(({ id }) => id.startsWith('surplus-')).length,
    40,
  );
});

test('local overlay publisher owns add/remove/visibility lifecycle and becomes inert on destroy', () => {
  const calls = [];
  const publisher = createLocalInfrastructureOverlayPublisher({
    sourceId: 'local-datacenters',
    host: {
      setVisible: (...args) => calls.push(['visible', ...args]),
      setEntries: (...args) => calls.push(['entries', ...args]),
      clearSource: (...args) => calls.push(['clear', ...args]),
    },
  });

  publisher.publish([{ id: 'ignored-before-show' }]);
  publisher.show();
  publisher.show();
  publisher.publish([{ id: 'dc-1' }]);
  publisher.publish([]);
  publisher.hide();
  publisher.show();
  publisher.publish([{ id: 'dc-2' }]);
  publisher.destroy();
  const countAtDestroy = calls.length;
  publisher.show();
  publisher.publish([{ id: 'zombie' }]);

  assert.equal(
    calls.length,
    countAtDestroy,
    'destroyed publishers reject late source work',
  );
  assert.deepEqual(calls[0], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[1].slice(0, 3), [
    'entries',
    'local-datacenters',
    [{ id: 'dc-1' }],
  ]);
  assert.deepEqual(calls[1][3], {
    cohortLimit: LOCAL_OVERLAY_COHORT_LIMIT,
    collisionCapacity: 96,
    moving: false,
  });
  assert.deepEqual(calls[2].slice(0, 3), ['entries', 'local-datacenters', []]);
  assert.deepEqual(calls[3], ['visible', 'local-datacenters', false]);
  assert.deepEqual(calls[4], ['visible', 'local-datacenters', true]);
  assert.deepEqual(calls[6], ['clear', 'local-datacenters']);
  assert.deepEqual(calls[7], ['visible', 'local-datacenters', false]);
});

test('a bundled-dataset failure reduces to a short, honest reason', () => {
  assert.equal(
    localDatasetError(
      new SyntaxError('Unexpected token < in JSON at position 0'),
    ),
    'dataset is malformed',
  );
  assert.equal(
    localDatasetError(new Error('HTTP 404')),
    'dataset unavailable (HTTP 404)',
  );
  assert.equal(localDatasetError(new Error('')), 'dataset unavailable');
  assert.equal(localDatasetError(undefined), 'dataset unavailable');
});
