import test from 'node:test';
import assert from 'node:assert/strict';
import { createCycloneRendering } from './rendering.js';

function harness({ deferred = false } = {}) {
  const sources = [],
    completions = [];
  const color = (value) => ({
    value,
    withAlpha: (alpha) => ({ value, alpha }),
  });
  const cesium = {
    Color: {
      fromCssColorString: color,
      WHITE: color('white'),
      BLACK: color('black'),
    },
    Cartesian2: class {
      constructor(x, y) {
        this.x = x;
        this.y = y;
      }
    },
    Cartesian3: { fromDegrees: (lon, lat, height) => ({ lon, lat, height }) },
    PolygonHierarchy: class {
      constructor(positions, holes = []) {
        this.positions = positions;
        this.holes = holes;
      }
    },
    BoundingSphere: { fromPoints: (points) => ({ points, radius: 10 }) },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
    HorizontalOrigin: { LEFT: 1 },
    ArcType: { GEODESIC: 1 },
    CustomDataSource: class {
      constructor() {
        const values = [];
        this.entities = {
          values,
          add: (value) => {
            values.push(value);
            return value;
          },
          removeAll: () => {
            values.length = 0;
          },
        };
      }
    },
  };
  let renders = 0;
  const viewer = {
    scene: { requestRender: () => renders++ },
    dataSources: {
      add(value) {
        if (deferred)
          return new Promise((resolve) =>
            completions.push(() => {
              sources.push(value);
              resolve(value);
            }),
          );
        sources.push(value);
        return Promise.resolve(value);
      },
      remove(value) {
        const i = sources.indexOf(value);
        if (i >= 0) sources.splice(i, 1);
      },
    },
  };
  return {
    rendering: createCycloneRendering({ viewer, cesium }),
    sources,
    completions,
    get renders() {
      return renders;
    },
  };
}
const storm = () => ({
  id: 'ep152026',
  name: 'Fifteen-E',
  advisoryNumber: '10',
  geometryAdvisoryNumber: '10',
  geometryStatus: 'current',
  position: { longitude: 179, latitude: 15 },
  forecastPoints: [
    { position: { longitude: -179, latitude: 16 }, tauHours: 12 },
  ],
  track: {
    type: 'MultiLineString',
    coordinates: [
      [
        [179, 15],
        [-179, 16],
      ],
    ],
  },
  cone: {
    type: 'MultiPolygon',
    coordinates: [
      [
        [
          [178, 10],
          [-178, 10],
          [-178, 20],
          [178, 10],
        ],
        [
          [179, 12],
          [-179, 12],
          [-179, 14],
          [179, 12],
        ],
      ],
      [
        [
          [170, 1],
          [171, 1],
          [171, 2],
          [170, 1],
        ],
      ],
    ],
  },
});

test('picking accepts exact current owned entities, never prefixes or superseded identities', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  const oldEntities = [...h.sources[0].entities.values];
  assert.equal(oldEntities.length, 5);
  for (const entity of oldEntities) {
    assert.equal(h.rendering.pickStorm({ id: entity }), 'ep152026', entity.id);
    assert.equal(h.rendering.ownsPickId(entity.id), true);
    assert.equal(
      h.rendering.pickStorm({ id: { ...entity } }),
      null,
      'copied ID is not ownership',
    );
    assert.equal(
      h.rendering.pickStorm({ id: entity.id }),
      null,
      'string prefix is not ownership',
    );
  }
  assert.equal(h.rendering.pickStorm(undefined), null);
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:unknown'), false);
  await h.rendering.setSnapshot({ storms: [storm()] });
  for (const entity of oldEntities)
    assert.equal(h.rendering.pickStorm({ id: entity }), null);
  const current = h.sources[0].entities.values[0];
  assert.equal(h.rendering.pickStorm({ id: current }), 'ep152026');
  h.rendering.clear();
  assert.equal(h.rendering.pickStorm({ id: current }), null);
  assert.equal(h.rendering.ownsPickId(current.id), false);
  h.rendering.destroy();
});

test('registry IDs switch only when the next coherent data source commits', async () => {
  const h = harness({ deferred: true });
  const first = h.rendering.setSnapshot({ storms: [storm()] });
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:center'), false);
  h.completions.shift()();
  await first;
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:center'), true);
  const next = h.rendering.setSnapshot({
    storms: [{ ...storm(), id: 'ep162026' }],
  });
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:center'), true);
  assert.equal(h.rendering.ownsPickId('cyclone:ep162026:center'), false);
  h.completions.shift()();
  await next;
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:center'), false);
  assert.equal(h.rendering.ownsPickId('cyclone:ep162026:center'), true);
  h.rendering.destroy();
  assert.equal(h.rendering.ownsPickId('cyclone:ep162026:center'), false);
});
test('static entities preserve polygon parts, holes and geographic seam coordinates', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  const entities = h.sources[0].entities.values;
  const cones = entities.filter((e) => e.polygon);
  assert.equal(cones.length, 2);
  assert.equal(cones[0].polygon.hierarchy.holes.length, 1);
  assert.equal(cones[0].polygon.hierarchy.positions[1].lon, -178);
  assert.equal(
    entities.find((e) => e.polyline).polyline.positions[1].lon,
    -179,
  );
  assert.deepEqual(h.rendering.getDiagnostics(), {
    storms: 1,
    tracks: 1,
    cones: 2,
    forecastPoints: 1,
    dataSources: 1,
    entities: 5,
    selectedId: null,
    timerActive: false,
  });
  h.rendering.setSelection('ep152026');
  assert.equal(
    entities.find((e) => e.id.endsWith('forecast:0')).label.show,
    true,
  );
  assert.ok(h.rendering.getFocusSphere('ep152026').radius >= 500000);
  h.rendering.destroy();
  assert.equal(h.sources.length, 0);
  assert.equal(h.rendering.getDiagnostics().entities, 0);
});
test('pending or mismatched advisory geometry never renders even when supplied', async () => {
  for (const changed of [
    { geometryStatus: 'pending' },
    { geometryAdvisoryNumber: '9' },
  ]) {
    const h = harness();
    await h.rendering.setSnapshot({ storms: [{ ...storm(), ...changed }] });
    assert.equal(h.sources[0].entities.values.length, 1);
    assert.equal(h.rendering.getDiagnostics().tracks, 0);
    h.rendering.destroy();
  }
});
test('a data-source add settling after disable is removed, without a new owner', async () => {
  const h = harness({ deferred: true });
  const pending = h.rendering.setSnapshot({ storms: [storm()] });
  h.rendering.clear();
  h.completions.shift()();
  assert.equal(await pending, false);
  assert.equal(h.sources.length, 0);
  assert.equal(h.rendering.getDiagnostics().dataSources, 0);
});
test('superseded asynchronous additions cannot replace newer geometry', async () => {
  const h = harness({ deferred: true });
  const old = h.rendering.setSnapshot({ storms: [storm()] });
  const latest = h.rendering.setSnapshot({ storms: [] });
  h.completions[1]();
  assert.equal(await latest, true);
  h.completions[0]();
  assert.equal(await old, false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.rendering.getDiagnostics().storms, 0);
  h.rendering.destroy();
});
test('aborting a pending add retains the prior complete source', async () => {
  const h = harness({ deferred: true });
  const initial = h.rendering.setSnapshot({ storms: [storm()] });
  h.completions.shift()();
  await initial;
  const controller = new AbortController();
  const update = h.rendering.setSnapshot(
    { storms: [] },
    { signal: controller.signal },
  );
  controller.abort();
  h.completions.shift()();
  assert.equal(await update, false);
  assert.equal(h.sources.length, 1);
  assert.equal(h.rendering.getDiagnostics().storms, 1);
  h.rendering.destroy();
});
