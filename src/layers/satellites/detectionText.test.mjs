import test from 'node:test';
import assert from 'node:assert/strict';
import { createControls } from './controls.js';
import { getLocale, setLocale } from '../../i18n/index.js';
import { satelliteClassText } from '../../data/satelliteClass.js';

test('cached satellite detection text follows in-place classification, subtype and language changes', (t) => {
  const previous = getLocale();
  t.after(() => setLocale(previous));
  setLocale('en');
  const cat = { name: 'Test', satelliteClass: 'imaging', group: 'visual' };
  const point = { position: { x: 1, y: 2, z: 3 } };
  const state = {
    _pointCollection: { show: true },
    _points: new Map([[60000, point]]),
    _catalog: new Map([[60000, cat]]),
    _denseIds: [],
    _dockedCompanions: new Set(),
    _detectionObjects: new Map(),
    _params: { catalog: 'core', classes: { imaging: true, telecom: true } },
    _trackedNorad: null,
  };
  const { methods } = createControls({
    state,
    services: { layerState: {} },
    parts: {},
    source: {},
  });
  const a = methods.getDetectableObjects()[0];
  assert.equal(a.klass, satelliteClassText('imaging', 'visual'));
  assert.equal(methods.getDetectableObjects()[0], a);
  cat.satelliteClass = 'telecom';
  cat.group = 'gps-ops';
  const b = methods.getDetectableObjects()[0];
  assert.equal(b, a);
  assert.equal(b.klass, satelliteClassText('telecom', 'gps-ops'));
  setLocale('fr');
  assert.equal(
    methods.getDetectableObjects()[0].klass,
    satelliteClassText('telecom', 'gps-ops'),
  );

  point.position = { x: 4, y: 5, z: 6 };
  assert.equal(methods.getDetectableObjects()[0].position, point.position);
});

test('detection stops after the last core point without traversing dense extras', () => {
  const points = new Map([[60000, { position: { x: 1, y: 2, z: 3 } }]]);
  const catalog = new Map([
    [60000, { name: 'Core', satelliteClass: 'imaging', group: 'visual' }],
  ]);
  const dense = [];
  for (let id = 70000; id < 75000; id++) {
    dense.push(id);
    points.set(id, { position: { x: 4, y: 5, z: 6 } });
    catalog.set(id, { group: 'dense', satelliteClass: 'starlink' });
  }
  let visited = 0;
  const iterator = points[Symbol.iterator].bind(points);
  points[Symbol.iterator] = function* () {
    for (const entry of iterator()) {
      visited++;
      yield entry;
    }
  };
  const state = {
    _pointCollection: { show: true },
    _points: points,
    _catalog: catalog,
    _denseIds: dense,
    _dockedCompanions: new Set(),
    _detectionObjects: new Map(),
    _params: { catalog: 'dense', classes: { imaging: true } },
    _trackedNorad: null,
  };
  const { methods } = createControls({
    state,
    services: { layerState: {} },
    parts: {},
    source: {},
  });
  assert.deepEqual(
    methods.getDetectableObjects().map((o) => o.sourceId),
    [60000],
  );
  assert.ok(visited <= 2, `${visited} map entries visited`);
  points.delete(60000);
  catalog.delete(60000);
  visited = 0;
  assert.deepEqual(methods.getDetectableObjects(), []);
  assert.equal(visited, 0, 'all-dense catalog has no detection candidates');
});
