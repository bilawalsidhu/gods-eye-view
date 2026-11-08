// Layer display behavior on the fake engine.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import * as geo from '../../../geo/index.js';
import { createFakeEngine } from '../../../globe/testing/fakeEngine.js';
import { rgbaFromCss } from '../../shared/color.js';
import { createCyclonesDisplay, cycloneSphereVisible } from './display.js';
import {
  CYCLONE_ACCENT,
  CYCLONE_OVERLAY_SOURCE_ID,
  CYCLONE_SELECTED_ACCENT,
} from '../labels.js';

// Node has no GL context: GroundPolylinePrimitive checks its render state's
// line width against these limits when it is made.
Cesium.ContextLimits._minimumAliasedLineWidth = 1;
Cesium.ContextLimits._maximumAliasedLineWidth = 1;

const BLUE = rgbaFromCss(CYCLONE_ACCENT).rgba();
const GOLD = rgbaFromCss(CYCLONE_SELECTED_ACCENT).rgba();

/** Records what the display publishes to the shared overlay host. */
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

// The items each ground set was last given, by set id.
function spyGround(engine) {
  const items = new Map();
  const createSet = engine.ground.createSet.bind(engine.ground);
  engine.ground.createSet = (options) => {
    const set = createSet(options);
    const replace = set.replace.bind(set);
    set.replace = (next) => {
      replace(next);
      items.set(options.id, next);
    };
    return set;
  };
  return items;
}

const ENGINES = {
  fake() {
    const engine = createFakeEngine({ longitude: 0, latitude: 0 });
    return {
      engine,
      frame: () => engine.fake.frame(),
      points(prefix) {
        const id = engine.movers
          .list()
          .find((set) => set.id.startsWith(prefix))?.id;
        const { store, commits } = engine.fake.moverSet(id);
        return {
          id,
          commits,
          count: store.count,
          outlinePx: engine.fake.moverSet(id).options.point.outlinePx,
          depthTest: engine.fake.moverSet(id).options.depthTest,
          at: (index) => ({
            color: [...store.colors.subarray(index * 4, index * 4 + 4)],
            pixelSize: Math.fround(
              engine.fake.moverSet(id).options.point.sizePx *
                store.scales[index],
            ),
            show: store.shows[index] === 1,
            pickId: store.pickIds[index],
          }),
        };
      },
      preRenderListeners: null,
    };
  },
};

function bothEngines(name, body) {
  for (const [kind, make] of Object.entries(ENGINES))
    test(`${name} (${kind})`, async () => {
      const harness = make();
      const ground = spyGround(harness.engine);
      const overlay = overlayRecorder();
      const display = createCyclonesDisplay(harness.engine, {
        overlayHost: overlay.host,
      });
      try {
        await body({ ...harness, kind, ground, overlay, display });
      } finally {
        display.destroy();
        harness.engine.destroy();
      }
    });
}

const close = (actual, expected, label) =>
  expected.forEach((value, index) =>
    assert.ok(
      Math.abs(actual[index] - value) < 1e-6,
      `${label}: ${actual} vs ${expected}`,
    ),
  );

const storm = () => ({
  id: 'ep152026',
  name: 'Fifteen-E',
  advisoryNumber: '10',
  geometryAdvisoryNumber: '10',
  geometryStatus: 'current',
  position: { longitude: 179, latitude: 15 },
  forecastPoints: [
    { position: { longitude: 179, latitude: 15 }, tauHours: 0 },
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

bothEngines(
  'points, tracks and cones draw in the Cesium styles and keep cone parts, holes and seam coordinates',
  async ({ engine, kind, viewer, ground, display, points }) => {
    assert.equal(await display.setSnapshot({ storms: [storm()] }), true);
    const centers = points('weather-cyclones-centers');
    assert.equal(centers.count, 1);
    assert.equal(centers.outlinePx, 2);
    assert.equal(centers.depthTest, 'always');
    close(centers.at(0).color, BLUE, 'centre');
    assert.equal(centers.at(0).pixelSize, 9);
    assert.equal(centers.at(0).pickId, 'cyclone:ep152026:center');
    const forecasts = points('weather-cyclones-forecasts');
    assert.equal(forecasts.count, 1, 'the tau-0 fix is the centre');
    assert.equal(forecasts.outlinePx, 1);
    assert.equal(forecasts.depthTest, 'always');
    close(forecasts.at(0).color, [1, 1, 1, 1], 'forecast');
    assert.equal(forecasts.at(0).pixelSize, 5);
    assert.equal(forecasts.at(0).pickId, 'cyclone:ep152026:forecast:1');

    const tracks = ground.get('weather-cyclones-tracks:ep152026');
    assert.equal(tracks.length, 1);
    assert.deepEqual(tracks[0].positions, storm().track.coordinates[0]);
    assert.equal(tracks[0].widthPx, 2.5);
    close(tracks[0].color, BLUE, 'track');
    assert.equal(tracks[0].pickId, 'cyclone:ep152026:track:0');
    const cones = ground.get('weather-cyclones-cones:ep152026');
    assert.equal(cones.length, 2);
    assert.deepEqual(
      cones.map((cone) => cone.rings),
      storm().cone.coordinates,
      'every exterior keeps its own holes, longitudes as given',
    );
    for (const cone of cones) {
      close(cone.fill, [...BLUE.slice(0, 3), 0.16], 'cone fill');
      close(cone.outline.color, [...BLUE.slice(0, 3), 0.55], 'cone outline');
      assert.equal(cone.outline.widthPx, 1);
    }
    assert.deepEqual(
      engine.ground
        .list()
        .map(({ id, kind: shape, count, order }) => [id, shape, count, order]),
      [
        ['weather-cyclones-cones:ep152026', 'polygon', 2, 0],
        ['weather-cyclones-tracks:ep152026', 'corridor', 1, 1],
      ],
      'cones under the tracks, draped on terrain and tiles',
    );

    assert.deepEqual(display.getDiagnostics(), {
      storms: 1,
      tracks: 1,
      cones: 2,
      forecastPoints: 1,
      dataSources: 1,
      entities: 5,
      selectedId: null,
      timerActive: false,
    });
    const sphere = display.getFocusSphere('ep152026');
    assert.ok(sphere.radius >= 500_000);
    assert.equal(display.getFocusSphere('unknown'), null);
  },
);

bothEngines(
  'pending or mismatched advisory geometry never draws even when supplied',
  async ({ engine, display, points }) => {
    for (const changed of [
      { geometryStatus: 'pending' },
      { geometryAdvisoryNumber: '9' },
    ]) {
      await display.setSnapshot({ storms: [{ ...storm(), ...changed }] });
      assert.deepEqual(engine.ground.list(), []);
      assert.equal(points('weather-cyclones-centers').count, 1);
      assert.equal(points('weather-cyclones-forecasts').count, 0);
      assert.equal(display.getDiagnostics().tracks, 0);
      assert.equal(display.getDiagnostics().entities, 1);
    }
  },
);

bothEngines(
  'selection paints the centre gold and larger, publishes lead-hour labels at the point anchors and is quiet when unchanged',
  async ({ display, overlay, points }) => {
    assert.equal(overlay.calls.length, 0, 'nothing publishes before a commit');
    await display.setSnapshot({
      storms: [storm(), { ...storm(), id: 'near', name: 'Near' }],
    });
    assert.deepEqual(
      overlay.calls
        .slice(0, 2)
        .map(({ kind, source, visible }) => [kind, source, visible]),
      [
        ['visible', CYCLONE_OVERLAY_SOURCE_ID, true],
        ['entries', CYCLONE_OVERLAY_SOURCE_ID, undefined],
      ],
    );
    assert.deepEqual(
      overlay.published().map((entry) => entry.id),
      ['storm:ep152026', 'storm:near'],
      'no selection, no lead-hour labels',
    );
    display.setSelection('near');
    const centers = points('weather-cyclones-centers');
    close(centers.at(1).color, GOLD, 'selected');
    assert.ok(Math.abs(centers.at(1).pixelSize - 12) < 1e-5);
    close(centers.at(0).color, BLUE, 'other');
    assert.equal(centers.at(0).pixelSize, 9);
    assert.equal(overlay.entry('storm:near').variant, 'selected');
    assert.equal(overlay.entry('storm:ep152026').variant, 'card');
    const lead = overlay.entry('lead:near:12');
    assert.ok(lead);
    assert.ok(
      geo.cartesian3.equalsEpsilon(
        lead.position,
        geo.cartesian3.fromDegrees(-179, 16, 0),
        0,
        1e-6,
      ),
    );
    const publishes = overlay.publishes;
    display.setSelection('near');
    assert.equal(overlay.publishes, publishes, 'unchanged selection is quiet');
    assert.equal(display.getDiagnostics().selectedId, 'near');

    // A refresh republishes the new anchors with the retained selection.
    await display.setSnapshot({
      storms: [{ ...storm(), id: 'near', name: 'Near' }],
    });
    assert.deepEqual(
      overlay.published().map((entry) => [entry.id, entry.variant]),
      [
        ['storm:near', 'selected'],
        ['lead:near:12', 'card'],
      ],
    );
    close(points('weather-cyclones-centers').at(0).color, GOLD, 'retained');

    display.clear();
    assert.deepEqual(overlay.calls.slice(-2), [
      { kind: 'clear', source: CYCLONE_OVERLAY_SOURCE_ID },
      { kind: 'visible', source: CYCLONE_OVERLAY_SOURCE_ID, visible: false },
    ]);
    assert.equal(display.getDiagnostics().selectedId, null);
  },
);

// A storm at `longitude` on the equator with a short track and a cone.
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

bothEngines(
  'horizon culling hides far points and shapes, keeps partly visible extents and writes only changes',
  async ({ engine, frame, display, overlay, points, preRenderListeners }) => {
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(0, 0, 350),
    });
    const listeners = preRenderListeners?.();
    await display.setSnapshot({
      storms: [at('near', 0), at('far', 180), at('limb', 5)],
    });
    if (preRenderListeners)
      assert.equal(preRenderListeners(), listeners + 1, 'one listener');
    display.setSelection('near');
    frame();
    const centers = points('weather-cyclones-centers');
    const forecasts = points('weather-cyclones-forecasts');
    assert.deepEqual(
      [0, 1, 2].map((index) => centers.at(index).show),
      [true, false, false],
      'near shown; far and limb centres beyond the horizon',
    );
    assert.deepEqual(
      [0, 1, 2].map((index) => forecasts.at(index).show),
      [true, false, false],
    );
    const shown = Object.fromEntries(
      engine.ground.list().map(({ id, shown: visible }) => [id, visible]),
    );
    assert.deepEqual(shown, {
      'weather-cyclones-cones:near': true,
      'weather-cyclones-tracks:near': true,
      'weather-cyclones-cones:far': false,
      'weather-cyclones-tracks:far': false,
      'weather-cyclones-cones:limb': true,
      'weather-cyclones-tracks:limb': true,
    });
    assert.equal(overlay.entry('storm:near').horizonCull, true);
    assert.equal(overlay.entry('lead:near:24').maxDistance, 4_000_000);
    const publishes = overlay.publishes;
    const commits = centers.commits;
    frame();
    assert.equal(overlay.publishes, publishes, 'culling never republishes');
    if (commits !== undefined)
      assert.equal(
        points('weather-cyclones-centers').commits,
        commits,
        'a still camera writes nothing',
      );

    // The camera turns to the far side.
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(180, 0, 350),
    });
    frame();
    assert.equal(points('weather-cyclones-centers').at(0).show, false);
    assert.equal(points('weather-cyclones-centers').at(1).show, true);
    assert.equal(
      engine.ground.list().find(({ id }) => id.endsWith(':far')).shown,
      true,
    );
    assert.equal(
      engine.ground.list().find(({ id }) => id.endsWith(':near')).shown,
      false,
    );

    // The listener follows nonempty snapshots, clear and destroy.
    await display.setSnapshot({ storms: [] });
    if (preRenderListeners) assert.equal(preRenderListeners(), listeners);
    await display.setSnapshot({ storms: [at('near', 0)] });
    display.clear();
    if (preRenderListeners) assert.equal(preRenderListeners(), listeners);
    await display.setSnapshot({ storms: [at('near', 0)] });
    display.destroy();
    if (preRenderListeners) assert.equal(preRenderListeners(), listeners);
  },
);

test('the inscribed-sphere test matches Cesium Occluder', () => {
  const occluder = new Cesium.Occluder(
    new Cesium.BoundingSphere(
      Cesium.Cartesian3.ZERO,
      Cesium.Ellipsoid.WGS84.minimumRadius,
    ),
    Cesium.Cartesian3.fromDegrees(0, 0, 350),
  );
  const cameras = [
    [0, 0, 350],
    [30, 10, 2_000_000],
    [120, -40, 20_000_000],
    [0, 0, -30_000],
  ];
  const spheres = [];
  for (let lon = -180; lon < 180; lon += 15)
    for (const radius of [1000, 500_000, 3_000_000, 7_000_000])
      spheres.push({
        center: Cesium.Cartesian3.fromDegrees(lon, lon / 4, 0),
        radius,
      });
  for (const [lon, lat, height] of cameras) {
    const camera = Cesium.Cartesian3.fromDegrees(lon, lat, height);
    occluder.cameraPosition = camera;
    for (const sphere of spheres)
      assert.equal(
        cycloneSphereVisible(sphere, camera),
        occluder.isBoundingSphereVisible(
          new Cesium.BoundingSphere(sphere.center, sphere.radius),
        ),
        `${lon},${lat},${height} ${sphere.radius}`,
      );
  }
});

bothEngines(
  'picks resolve current owned ids only, never foreign owners, unknown ids or replaced storms',
  async ({ engine, kind, display }) => {
    await display.setSnapshot({ storms: [storm(), at('other', 0)] });
    const owner = (prefix) =>
      engine.movers.list().find(({ id }) => id.startsWith(prefix)).id;
    const ids = [
      ['cyclone:ep152026:center', owner('weather-cyclones-centers')],
      ['cyclone:ep152026:forecast:1', owner('weather-cyclones-forecasts')],
      ['cyclone:ep152026:track:0', 'weather-cyclones-tracks:ep152026'],
      ['cyclone:ep152026:cone:0', 'weather-cyclones-cones:ep152026'],
      ['cyclone:ep152026:cone:1', 'weather-cyclones-cones:ep152026'],
    ];
    for (const [id, set] of ids) {
      assert.equal(display.ownsPickId(id), true, id);
      assert.equal(display.pickStorm({ id, owner: set }), 'ep152026', id);
      assert.equal(display.pickStorm({ id, owner: 'flights' }), null, id);
    }
    assert.equal(display.ownsPickId('cyclone:ep152026'), false, 'no prefix');
    assert.equal(display.ownsPickId('cyclone:ep152026:unknown'), false);
    assert.equal(display.pickStorm(undefined), null);
    if (kind === 'fake') {
      // A real pick of the drawn centre, as a click would get it.
      const screen = engine.projector.worldToWindow(
        geo.cartesian3.fromDegrees(0, 0, 0),
      );
      assert.equal(display.pickStorm(engine.picker.pick(screen)), 'other');
    }
    // The next advisory without the storm: its ids no longer resolve.
    await display.setSnapshot({ storms: [at('other', 0)] });
    for (const [id, set] of ids) {
      assert.equal(display.ownsPickId(id), false, id);
      assert.equal(display.pickStorm({ id, owner: set }), null, id);
    }
    assert.equal(
      engine.ground.list().some(({ id }) => id.endsWith(':ep152026')),
      false,
      "the storm's ground sets go",
    );
    display.clear();
    assert.equal(display.ownsPickId('cyclone:other:center'), false);
    assert.deepEqual(engine.ground.list(), []);
    assert.deepEqual(display.getDiagnostics(), {
      storms: 0,
      tracks: 0,
      cones: 0,
      forecastPoints: 0,
      dataSources: 0,
      entities: 0,
      selectedId: null,
      timerActive: false,
    });
  },
);

bothEngines(
  'an aborted snapshot draws nothing and keeps the prior one; a destroyed display draws nothing',
  async ({ engine, display, overlay }) => {
    await display.setSnapshot({ storms: [storm()] });
    const publishes = overlay.publishes;
    assert.throws(
      () =>
        display.setSnapshot({ storms: [] }, { signal: AbortSignal.abort() }),
      { name: 'AbortError' },
    );
    assert.equal(display.getDiagnostics().storms, 1);
    assert.equal(overlay.publishes, publishes);
    display.destroy();
    display.destroy();
    assert.deepEqual(engine.ground.list(), []);
    assert.deepEqual(
      engine.movers.list().filter(({ id }) => id.startsWith('weather-')),
      [],
    );
    assert.equal(display.setSnapshot({ storms: [storm()] }), false);
    assert.deepEqual(engine.ground.list(), []);
    assert.equal(display.getDiagnostics().entities, 0);
  },
);

bothEngines(
  'more storms than the first capacity rebuild the centre set larger',
  async ({ display, points }) => {
    const storms = Array.from({ length: 40 }, (_, index) => ({
      ...storm(),
      id: `s${index}`,
      geometryStatus: 'pending',
    }));
    await display.setSnapshot({ storms });
    assert.equal(points('weather-cyclones-centers').count, 40);
    assert.equal(
      points('weather-cyclones-centers').at(39).pickId,
      'cyclone:s39:center',
    );
  },
);
