import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createCycloneRendering } from './rendering.js';
import { CYCLONE_OVERLAY_SOURCE_ID } from './labels.js';

/** Records what the renderer publishes to the shared overlay host. */
function overlayRecorder() {
  const calls = [];
  return {
    calls,
    host: {
      setEntries: (source, entries, options) =>
        calls.push({ kind: 'entries', source, entries, options }),
      setVisible: (source, visible) =>
        calls.push({ kind: 'visible', source, visible }),
      clearSource: (source) => calls.push({ kind: 'clear', source }),
    },
    get publishes() {
      return calls.filter(({ kind }) => kind === 'entries').length;
    },
    published() {
      return calls.findLast(({ kind }) => kind === 'entries')?.entries || [];
    },
    entry(id) {
      return this.published().find((entry) => entry.id === id) || null;
    },
  };
}

function harness({ deferred = false } = {}) {
  const sources = [],
    completions = [],
    pointOccluders = [],
    sphereOccluders = [];
  const listeners = new Set();
  const visibility = {
    points: new Map(),
    spheres: new Map(),
    pointCalls: [],
    sphereCalls: [],
    writes: 0,
  };
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
    Cartesian3: {
      ZERO: { x: 0, y: 0, z: 0 },
      fromDegrees: (lon, lat, height) => ({ lon, lat, height }),
    },
    Ellipsoid: { WGS84: { minimumRadius: 6356752 } },
    EllipsoidalOccluder: class {
      constructor(ellipsoid, cameraPosition) {
        this.ellipsoid = ellipsoid;
        this.cameraPosition = cameraPosition;
        pointOccluders.push(this);
      }
      isPointVisible(position) {
        visibility.pointCalls.push(position);
        return visibility.points.get(position) ?? true;
      }
    },
    Occluder: class {
      constructor(sphere, cameraPosition) {
        this.sphere = sphere;
        this.cameraPosition = cameraPosition;
        sphereOccluders.push(this);
      }
      isBoundingSphereVisible(sphere) {
        visibility.sphereCalls.push(sphere);
        return visibility.spheres.get(sphere) ?? true;
      }
    },
    PolygonHierarchy: class {
      constructor(positions, holes = []) {
        this.positions = positions;
        this.holes = holes;
      }
    },
    BoundingSphere: class {
      constructor(center, radius) {
        this.center = center;
        this.radius = radius;
      }
      static fromPoints(points) {
        return { points, radius: 10 };
      }
    },
    LabelStyle: { FILL_AND_OUTLINE: 1 },
    HorizontalOrigin: { LEFT: 1 },
    ArcType: { GEODESIC: 1 },
    HeightReference: Cesium.HeightReference,
    ClassificationType: Cesium.ClassificationType,
    DistanceDisplayCondition: Cesium.DistanceDisplayCondition,
    CustomDataSource: class {
      constructor() {
        const values = [];
        this.entities = {
          values,
          add: (value) => {
            let show = true;
            Object.defineProperty(value, 'show', {
              get: () => show,
              set: (next) => {
                show = next;
                visibility.writes++;
              },
            });
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
  const overlay = overlayRecorder();
  const viewer = {
    camera: { positionWC: { x: 6378487, y: 0, z: 0 } },
    scene: {
      requestRender: () => renders++,
      preRender: {
        addEventListener(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    },
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
    rendering: createCycloneRendering({
      viewer,
      cesium,
      overlayHost: overlay.host,
    }),
    overlay,
    sources,
    completions,
    viewer,
    cesium,
    visibility,
    pointOccluders,
    sphereOccluders,
    listeners,
    frame() {
      for (const listener of listeners) listener();
    },
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

test('horizon culling updates only changed entities and keeps selection independent', async () => {
  const h = harness();
  await h.rendering.setSnapshot({
    storms: [storm(), { ...storm(), id: 'near' }],
  });
  const entities = h.sources[0].entities.values;
  const far = entities.filter((e) => e.id.startsWith('cyclone:ep152026:'));
  const near = entities.filter((e) => e.id.startsWith('cyclone:near:'));
  const forecast = far.find((e) => e.id.endsWith('forecast:0'));
  const sphere = h.rendering.getFocusSphere('ep152026');
  for (const entity of far)
    if (entity.position) h.visibility.points.set(entity.position, false);
  h.visibility.spheres.set(sphere, false);
  h.rendering.setSelection('ep152026');
  const publishes = h.overlay.publishes;
  const before = h.renders;
  h.frame();
  assert.ok(far.every((e) => e.show === false));
  assert.ok(near.every((e) => e.show === true));
  assert.equal(
    h.overlay.entry('lead:ep152026:12').position,
    forecast.position,
    'the host culls labels at the same anchors the points use',
  );
  assert.equal(h.overlay.publishes, publishes, 'culling never republishes');
  assert.equal(h.renders, before + 1);
  assert.equal(h.visibility.writes, far.length);
  assert.equal(h.visibility.pointCalls.length, 4);
  assert.deepEqual(h.visibility.sphereCalls, [
    sphere,
    h.rendering.getFocusSphere('near'),
  ]);
  h.frame();
  assert.equal(h.renders, before + 1);
  assert.equal(h.visibility.writes, far.length);

  // A visible portion of the extent keeps all tracks/cones shown even when
  // the centre and an individual forecast point remain beyond the horizon.
  h.visibility.spheres.set(sphere, true);
  h.viewer.camera.positionWC = { x: 0, y: 6378487, z: 0 };
  h.frame();
  assert.ok(far.filter((e) => !e.position).every((e) => e.show));
  assert.ok(far.filter((e) => e.position).every((e) => !e.show));
  assert.equal(h.renders, before + 2);
  assert.equal(h.pointOccluders.length, 1);
  assert.equal(h.sphereOccluders.length, 1);
  assert.equal(h.pointOccluders[0].ellipsoid, h.cesium.Ellipsoid.WGS84);
  assert.equal(h.pointOccluders[0].cameraPosition, h.viewer.camera.positionWC);
  assert.equal(h.sphereOccluders[0].cameraPosition, h.viewer.camera.positionWC);

  h.rendering.setSelection('near');
  assert.equal(h.overlay.entry('lead:ep152026:12'), null);
  assert.equal(
    h.overlay.entry('lead:near:12').position,
    near.find((e) => e.id.endsWith('forecast:0')).position,
  );
  h.visibility.points.set(forecast.position, true);
  const beforeReveal = h.renders;
  const revealPublishes = h.overlay.publishes;
  h.frame();
  assert.equal(forecast.show, true);
  assert.equal(h.overlay.entry('lead:ep152026:12'), null);
  assert.equal(h.overlay.publishes, revealPublishes);
  assert.equal(far[0].show, false);
  assert.equal(h.renders, beforeReveal + 1);
  h.rendering.destroy();
});

test('horizon listener follows committed nonempty snapshots and clear/destroy', async () => {
  const h = harness();
  assert.equal(h.listeners.size, 0);
  await h.rendering.setSnapshot({ storms: [] });
  assert.equal(h.listeners.size, 0);
  await h.rendering.setSnapshot({ storms: [storm()] });
  assert.equal(h.listeners.size, 1);
  const old = [...h.sources[0].entities.values];
  await h.rendering.setSnapshot({ storms: [storm()] });
  assert.equal(h.listeners.size, 1);
  h.frame();
  assert.ok(
    h.visibility.pointCalls.every((p) => !old.some((e) => e.position === p)),
  );
  await h.rendering.setSnapshot({ storms: [] });
  assert.equal(h.listeners.size, 0);
  await h.rendering.setSnapshot({ storms: [storm()] });
  h.rendering.clear();
  assert.equal(h.listeners.size, 0);
  const before = h.renders;
  h.frame();
  assert.equal(h.renders, before);
  await h.rendering.setSnapshot({ storms: [storm()] });
  assert.equal(h.listeners.size, 1);
  h.rendering.destroy();
  h.rendering.destroy();
  assert.equal(h.listeners.size, 0);
  assert.equal(await h.rendering.setSnapshot({ storms: [storm()] }), false);
  assert.equal(h.listeners.size, 0);
});

test('late asynchronous additions never restore a cleared or destroyed horizon listener', async () => {
  for (const method of ['clear', 'destroy']) {
    const h = harness({ deferred: true });
    const pending = h.rendering.setSnapshot({ storms: [storm()] });
    assert.equal(h.listeners.size, 0);
    h.rendering[method]();
    h.completions.shift()();
    assert.equal(await pending, false);
    assert.equal(h.listeners.size, 0);
  }
});

test('real Cesium culls far storms and retains partially visible extents with either globe visibility', async () => {
  for (const globeShow of [true, false]) {
    const sources = [];
    const viewer = {
      camera: { positionWC: Cesium.Cartesian3.fromDegrees(0, 0, 350) },
      scene: {
        globe: { show: globeShow },
        preRender: new Cesium.Event(),
        requestRender() {},
      },
      dataSources: {
        async add(source) {
          sources.push(source);
        },
        remove() {},
      },
    };
    const overlay = overlayRecorder();
    const rendering = createCycloneRendering({
      viewer,
      cesium: Cesium,
      overlayHost: overlay.host,
    });
    const at = (id, longitude) => ({
      ...storm(),
      id,
      position: { longitude, latitude: 0 },
      forecastPoints: [{ position: { longitude, latitude: 0 }, tauHours: 24 }],
      track: {
        type: 'LineString',
        coordinates: [
          [longitude, 0],
          [longitude, 1],
        ],
      },
      cone: {
        type: 'Polygon',
        coordinates: [
          [
            [longitude, 0],
            [longitude + 1, 0],
            [longitude, 1],
            [longitude, 0],
          ],
        ],
      },
    });
    await rendering.setSnapshot({
      storms: [at('near', 0), at('far', 180), at('limb', 5)],
    });
    rendering.setSelection('near');
    viewer.scene.preRender.raiseEvent();
    const entities = sources[0].entities.values;
    for (const entity of entities.filter((e) => e.position)) {
      assert.equal(
        entity.point.heightReference.getValue(),
        Cesium.HeightReference.CLAMP_TO_GROUND,
      );
      assert.equal(entity.point.disableDepthTestDistance.getValue(), Infinity);
      assert.equal(entity.label, undefined, 'no Cesium label graphics');
      const published = overlay.entry(
        entity.id.includes(':forecast:')
          ? `lead:${entity.id.split(':')[1]}:24`
          : `storm:${entity.id.split(':')[1]}`,
      );
      if (entity.id.startsWith('cyclone:near:')) {
        assert.ok(
          Cesium.Cartesian3.equals(
            published.position,
            entity.position.getValue(),
          ),
        );
        assert.equal(published.horizonCull, true);
      }
      if (entity.id === 'cyclone:near:forecast:0')
        assert.equal(published.maxDistance, 4_000_000);
    }
    assert.ok(
      entities
        .filter((e) => e.id.startsWith('cyclone:near:'))
        .every((e) => e.show),
    );
    assert.ok(
      entities
        .filter((e) => e.id.startsWith('cyclone:far:'))
        .every((e) => !e.show),
    );
    const limb = entities.filter((e) => e.id.startsWith('cyclone:limb:'));
    assert.ok(limb.filter((e) => e.position).every((e) => !e.show));
    assert.ok(limb.filter((e) => !e.position).every((e) => e.show));
    rendering.destroy();
    assert.equal(viewer.scene.preRender.numberOfListeners, 0);
  }
});

test('picking accepts exact current owned entities, never prefixes or superseded identities', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  const oldEntities = [...h.sources[0].entities.values];
  assert.equal(oldEntities.length, 8);
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
  for (const cone of cones) {
    assert.equal(
      cone.polygon.classificationType,
      h.cesium.ClassificationType.BOTH,
    );
    assert.equal(cone.polygon.height, undefined);
    assert.equal(cone.polygon.extrudedHeight, undefined);
    assert.equal(cone.polygon.outline, undefined);
  }
  const outlines = entities.filter((e) => e.id.includes(':outline:'));
  assert.equal(outlines.length, 3);
  assert.deepEqual(
    outlines.map((e) => e.polyline.positions.map((p) => [p.lon, p.lat])),
    storm().cone.coordinates.flat(),
  );
  for (const outline of outlines) {
    assert.deepEqual(outline.polyline.material, {
      value: '#7fe6ed',
      alpha: 0.55,
    });
  }
  for (const { polyline } of entities.filter((e) => e.polyline)) {
    assert.equal(polyline.clampToGround, true);
    assert.equal(polyline.classificationType, h.cesium.ClassificationType.BOTH);
    assert.ok(polyline.positions.every((p) => p.height === 0));
  }
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
    entities: 8,
    selectedId: null,
    timerActive: false,
  });
  h.rendering.setSelection('ep152026');
  assert.equal(
    h.overlay.entry('lead:ep152026:12').position,
    entities.find((e) => e.id.endsWith('forecast:0')).position,
  );
  assert.ok(entities.every((e) => e.label === undefined));
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

test('labels publish committed anchors to the shared overlay and follow selection and clear', async () => {
  const h = harness({ deferred: true });
  const pending = h.rendering.setSnapshot({
    storms: [storm(), { ...storm(), id: 'near', name: 'Near' }],
  });
  assert.equal(h.overlay.calls.length, 0, 'nothing publishes before commit');
  h.completions.shift()();
  assert.equal(await pending, true);
  const entities = h.sources[0].entities.values;
  const center = (id) => entities.find((e) => e.id === `cyclone:${id}:center`);
  assert.deepEqual(
    h.overlay.calls
      .slice(0, 2)
      .map(({ kind, source, visible }) => [kind, source, visible]),
    [
      ['visible', CYCLONE_OVERLAY_SOURCE_ID, true],
      ['entries', CYCLONE_OVERLAY_SOURCE_ID, undefined],
    ],
  );
  assert.deepEqual(
    h.overlay.published().map((entry) => entry.id),
    ['storm:ep152026', 'storm:near'],
    'no selection, no lead-hour labels',
  );
  assert.equal(h.overlay.entry('storm:near').title, 'Near');
  assert.equal(h.overlay.entry('storm:near').position, center('near').position);

  h.rendering.setSelection('near');
  assert.equal(center('near').point.pixelSize, 12);
  assert.equal(center('ep152026').point.pixelSize, 9);
  assert.equal(h.overlay.entry('storm:near').variant, 'selected');
  assert.equal(h.overlay.entry('storm:ep152026').variant, 'card');
  assert.ok(h.overlay.entry('lead:near:12'));
  const publishes = h.overlay.publishes;
  h.rendering.setSelection('near');
  assert.equal(h.overlay.publishes, publishes, 'unchanged selection is quiet');

  // A refresh republishes the new anchors with the retained selection.
  const refresh = h.rendering.setSnapshot({
    storms: [{ ...storm(), id: 'near', name: 'Near' }],
  });
  h.completions.shift()();
  await refresh;
  assert.deepEqual(
    h.overlay.published().map((entry) => [entry.id, entry.variant]),
    [
      ['storm:near', 'selected'],
      ['lead:near:12', 'card'],
    ],
  );
  assert.equal(
    h.overlay.entry('storm:near').position,
    h.sources[0].entities.values[0].position,
  );

  // A superseded addition never publishes, and clear hides the source.
  const stale = h.rendering.setSnapshot({ storms: [storm()] });
  h.rendering.clear();
  const afterClear = h.overlay.calls.slice(-2);
  assert.deepEqual(afterClear, [
    { kind: 'clear', source: CYCLONE_OVERLAY_SOURCE_ID },
    { kind: 'visible', source: CYCLONE_OVERLAY_SOURCE_ID, visible: false },
  ]);
  h.completions.shift()();
  assert.equal(await stale, false);
  assert.equal(h.overlay.calls.at(-1), afterClear[1]);
  h.rendering.destroy();
  assert.equal(h.overlay.calls.at(-1), afterClear[1]);
});
