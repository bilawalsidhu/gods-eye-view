import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Cesium from 'cesium';
import { satelliteClassColor } from '../../data/satelliteClass.js';
import satellitesLayer, {
  _clearSatelliteLabelLifecycleForTest,
  _setSatelliteLabelLifecycleStateForTest,
} from '../../data/satellites.js';
import {
  POINT_STYLES,
  TRACK_VIEW_FROM_LEO,
  TRACKED_ORBIT_COLOR,
} from './policy.js';
import { createRendering } from './rendering.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { gstime } from 'satellite.js';
import * as focusDeemphasis from '../../data/focusDeemphasis.js';

const rgba = (color) => [color.red, color.green, color.blue, color.alpha];

test('point styles keep the colours the dots were drawn in', () => {
  const outline = rgba(Cesium.Color.WHITE.withAlpha(0.3));
  const expected = {
    iss: Cesium.Color.fromCssColorString('#ff4444'),
    dense: Cesium.Color.fromCssColorString(
      satelliteClassColor('dense'),
    ).withAlpha(0.9),
  };
  for (const [group, style] of Object.entries(POINT_STYLES)) {
    const color =
      expected[group] ??
      Cesium.Color.fromCssColorString(satelliteClassColor(group));
    assert.deepEqual([...style.color], rgba(color), `${group} colour`);
    assert.deepEqual([...style.outlineColor], outline, `${group} outline`);
  }
  assert.deepEqual([...TRACKED_ORBIT_COLOR], rgba(Cesium.Color.YELLOW));
  assert.deepEqual(
    { ...TRACK_VIEW_FROM_LEO },
    {
      x: -450000,
      y: -450000,
      z: 350000,
    },
  );
});

test('positions read back from the drawn dots match the Cesium geodetic conversion', () => {
  const position = Cesium.Cartesian3.fromDegrees(-97.7, 30.2, 420_000);
  const point = { pos: position, show: true };
  _setSatelliteLabelLifecycleStateForTest({
    viewer: {},
    satrec: null,
    point,
    overlayHost: { setEntries() {}, setVisible() {}, clearSource() {} },
  });
  try {
    const [row] = satellitesLayer.getAllPositions();
    const carto = Cesium.Cartographic.fromCartesian(position);
    assert.equal(row.id, 25544);
    assert.equal(row.position, position, 'the drawn position itself');
    assert.ok(
      Math.abs(row.latitude - Cesium.Math.toDegrees(carto.latitude)) < 1e-9,
    );
    assert.ok(
      Math.abs(row.longitude - Cesium.Math.toDegrees(carto.longitude)) < 1e-9,
    );
    assert.ok(Math.abs(row.altitudeM - carto.height) < 1e-6);
  } finally {
    _clearSatelliteLabelLifecycleForTest();
  }
});

test('no part of the layer drives Cesium', () => {
  const offList = [
    'catalog',
    'cockpitSubject',
    'controls',
    'index',
    'ingestion',
    'interaction',
    'labels',
    'lifecycle',
    'orbits',
    'policy',
    'records',
    'source',
    'state',
    'testing',
    'tracking',
  ];
  const forbidden = [
    /from 'cesium'/,
    /render\/cesium\//,
    /\bCesium\./,
    /viewer\??\.entities\b/,
    /\.scene\b/,
    /\bscene\./,
    /\.primitive\b/,
    // The dots, rings and tracked entity are the rendering part's. Elsewhere
    // the handles are only stored, cleared, tested or passed on whole, and
    // the maps answer by id: no member of a handle is read, with or without
    // optional chaining, and no handle is taken into a local name.
    /\b_(pointCollection|trackedEntity)\s*(\?\.|\.|\[)/,
    /\b_(points|orbitPaths)\s*(\?\.|\.|\[)\s*(?!(has|keys|size|clear|set|delete)\b)/,
    /of\s+[\w.?]*\b_(points|orbitPaths)\s*\)/,
    /(\.\.\.|Array\.from\()\s*[\w.?]*\b_(points|orbitPaths)\b(?!\s*\??\.)/,
    /(^|[;{}(\s])\w+\s*=\s*\(*\s*[\w.?]*\b_(pointCollection|trackedEntity|points|orbitPaths)\s*(;|,|\)|\?\?|\|\||&&)/,
    /\}\s*=\s*\(*\s*[\w.?]*\b_(pointCollection|trackedEntity|points|orbitPaths)\b/,
    /[\w)\]]\s*(\?\.)?\[\s*['"`]_(pointCollection|trackedEntity|points|orbitPaths)\b/,
    /\{[^}]*\b_(pointCollection|trackedEntity|points|orbitPaths)\b[^}]*\}\s*=[^=]/,
  ];
  for (const name of offList) {
    const source = readFileSync(
      new URL(`./${name}.js`, import.meta.url),
      'utf8',
    );
    for (const pattern of forbidden)
      assert.doesNotMatch(source, pattern, `${name}.js: ${pattern}`);
  }
  // The rendering part owns the handles, and draws through the draw port.
  const rendering = readFileSync(
    new URL('./rendering.js', import.meta.url),
    'utf8',
  );
  for (const pattern of forbidden.slice(0, 7))
    assert.doesNotMatch(rendering, pattern, `rendering.js: ${pattern}`);
  // The patterns themselves still catch what they are for.
  const caught = [
    'layerState._trackedEntity.position.setValue(p)',
    'layerState._pointCollection?.removeAll()',
    'state._trackedEntity?.["position"]',
    'layerState._points.get(id).show = false',
    'layerState._orbitPaths?.values()',
    'for (const p of layerState._points) {}',
    'const pc = layerState._pointCollection;',
    'const { _trackedEntity: e } = layerState;',
    'const e = layerState?._trackedEntity;',
    'for (const p of layerState?._points) {}',
    '[...layerState._points]',
    'Array.from(layerState._orbitPaths)',
    'e = layerState._trackedEntity;',
    'let e; e = layerState._trackedEntity;',
    'const { position } = layerState._trackedEntity;',
    'const e = layerState._trackedEntity ?? null;',
    'const e = (layerState._trackedEntity);',
    'const { get } = layerState._points;',
    'layerState["_trackedEntity"].position',
  ];
  for (const line of caught)
    assert.ok(
      forbidden.some((pattern) => pattern.test(line)),
      `not caught: ${line}`,
    );
  const allowed = [
    'layerState._points.has(id)',
    'layerState._points.size',
    'layerState._trackedEntity = null;',
    'parts.rendering._removeTrackedEntity(layerState._trackedEntity);',
    'layerState._trackedEntityChangedRemove();',
    'const had = layerState._points.has(id);',
    'const t = layerState._trackedEntity\n    ? a\n    : b;',
    'const ids = ["_points", "_orbitPaths"];',
    'const n = layerState._orbitPaths.size;',
    '[...layerState._points.keys()]',
    'layerState._trackedEntity = parts.rendering._addTrackedEntity({',
  ];
  for (const line of allowed)
    assert.ok(
      !forbidden.some((pattern) => pattern.test(line)),
      `wrongly caught: ${line}`,
    );
});

test('the rendering part draws the dots, the tracked dot and the rings through the draw port', () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  try {
    const state = {
      now: Date.now,
      _points: new Map(),
      _orbitPaths: new Map(),
      _catalog: new Map([[25544, { satrec: {} }]]),
      _viewer: viewer,
      _trackedNorad: null,
      _enabled: false,
    };
    const path = [
      { x: 7e6, y: 0, z: 0 },
      { x: 0, y: 7e6, z: 0 },
      { x: -7e6, y: 0, z: 0 },
    ];
    const rendering = createRendering({
      state,
      services: {
        focus: {
          focusNowMs: (ms) => ms,
          getFocusTarget: () => null,
          focusPassIsNeeded: () => false,
        },
      },
      parts: {
        orbits: { computeOrbitPath: () => path },
        tracking: { _getTrackedFramePosition: () => sampleFrame() },
      },
    });
    // The frame's own sample, taken after the tick's first part.
    let sampleFrame = () => null;
    rendering._attach(viewer);
    const points = draw.find('satellites:').spec.id;
    assert.match(points, /^satellites:\d+:points$/);
    rendering._addPoint(25544, { x: 1, y: 2, z: 3 }, POINT_STYLES.iss);
    const point = state._points.get(25544);
    assert.deepEqual(point.pos, { x: 1, y: 2, z: 3 });
    assert.equal(draw.set(points).items.size, 0, 'sent with the frame');
    rendering._preRenderTick({ frame: 1 });
    const drawn = draw.set(points).items.get('25544');
    assert.equal(drawn, point);
    assert.deepEqual(
      [...drawn.color],
      rgba(Cesium.Color.fromCssColorString('#ff4444')),
    );
    assert.deepEqual(
      [...drawn.outlineColor],
      rgba(Cesium.Color.WHITE.withAlpha(0.3)),
    );
    assert.equal(drawn.pixelSize, 12);
    assert.equal(drawn.outlineWidth, 2);
    assert.deepEqual(drawn.meta, { noradId: 25544 });
    assert.deepEqual(
      { ...drawn.scaleByDistance },
      { near: 1e6, nearValue: 1.5, far: 2e7, farValue: 0.6 },
    );
    // Moves go out in one upsert a frame.
    const writes = draw.set(points).writes;
    rendering._movePoint(25544, { x: 4, y: 5, z: 6 });
    rendering._movePoint(25544, { x: 7, y: 8, z: 9 });
    rendering._preRenderTick({ frame: 2 });
    assert.equal(draw.set(points).writes, writes + 1);
    assert.deepEqual(draw.set(points).items.get('25544').pos, {
      x: 7,
      y: 8,
      z: 9,
    });
    // A pick on a dot names its satellite; one on another set does not.
    assert.equal(rendering._hitPointId({ set: points, id: '25544' }), 25544);
    assert.equal(rendering._hitPointId({ set: 'other:1', id: '25544' }), null);

    rendering._showOrbitPath(25544, TRACKED_ORBIT_COLOR);
    const rings = draw.sets.get(points.replace(':points', ':rings'));
    assert.equal(rings.spec.pickable, false, 'ring clicks fall through');
    const ring = rings.items.get('25544');
    assert.deepEqual(ring.style, { kind: 'solid', color: [1, 1, 0, 0.6] });
    // The Earth hides the part of the ring behind it: no depth-fail style.
    assert.equal(ring.depthFail, undefined, 'no ring draws through the Earth');
    assert.equal(ring.widthPx, 2, 'the ISS ring is as wide as any');
    assert.equal(ring.mode, 'geodesic');
    assert.deepEqual([...ring.positions.slice(0, 3)], [7e6, 0, 0]);
    // Turned with the Earth: by minus the GMST elapsed since its bake.
    const path0 = state._orbitPaths.get(25544);
    const later = new Date(Date.now() + 600_000);
    rendering._updateOrbitPathRotations(later);
    const angle = -(gstime(later) - path0.gmstAtBake);
    const turned = rings.items.get('25544').positions;
    assert.ok(Math.abs(turned[0] - 7e6 * Math.cos(angle)) < 1e-3);
    assert.ok(Math.abs(turned[1] - 7e6 * Math.sin(angle)) < 1e-3);
    rendering._hideOrbitPath(25544);
    assert.equal(rings.items.size, 0);

    // The tracked dot draws at the tracker's position, from the next frame.
    state._trackedNorad = 25544;
    state._enabled = true;
    state._params = { showPoints: false, showOrbits: false };
    let at = { x: 10, y: 20, z: 30 };
    const issRed = [1, 0.27, 0.27, 1];
    const carrier = rendering._addTrackedEntity({
      position: () => at,
      color: issRed,
    });
    assert.deepEqual(carrier, { noradId: 25544 });
    const tracked = draw.set(points.replace(':points', ':tracked'));
    assert.equal(tracked.items.size, 0);
    rendering._preRenderTick({ frame: 3 });
    assert.deepEqual(tracked.items.get('25544').pos, at);
    assert.equal(tracked.items.get('25544').pixelSize, 14);
    assert.deepEqual(
      tracked.items.get('25544').color,
      issRed,
      'the satellite keeps its own colour',
    );
    assert.equal(tracked.items.get('25544').disableDepthTest, Infinity);
    at = { x: 11, y: 21, z: 31 };
    rendering._preRenderTick({ frame: 4 });
    assert.deepEqual(tracked.items.get('25544').pos, at);
    // When the follow camera has already sampled this frame's key, the dot
    // draws at that sample, before the frame's own sample moves it on.
    const framed = { x: 12, y: 22, z: 32 };
    at = framed;
    state._trackedFrameGeo = {};
    state._trackedFrameNumber = 4;
    sampleFrame = () => {
      at = { x: 13, y: 23, z: 33 };
      return at;
    };
    rendering._preRenderTick({ frame: 5 });
    assert.deepEqual(tracked.items.get('25544').pos, framed);
    // With no sample under the frame's key, it draws after the frame's own.
    state._trackedFrameNumber = 3;
    at = framed;
    rendering._preRenderTick({ frame: 6 });
    assert.deepEqual(tracked.items.get('25544').pos, { x: 13, y: 23, z: 33 });
    assert.equal(
      rendering._hitIsTracked({ set: tracked.spec.id, id: '25544' }),
      true,
    );
    rendering._removeTrackedEntity(carrier);
    assert.equal(tracked.items.size, 0);
    rendering._detach(viewer);
    assert.ok([...draw.sets.values()].every((set) => set.disposed));
  } finally {
    unbind();
  }
});

test('a dot handed to a station model draws only beyond its range; the tracked dot too', () => {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  try {
    const state = {
      now: Date.now,
      _points: new Map(),
      _orbitPaths: new Map(),
      _catalog: new Map(),
      _viewer: viewer,
      _trackedNorad: null,
      _enabled: true,
      _params: { showPoints: false, showOrbits: false },
    };
    const rendering = createRendering({
      state,
      services: {
        focus: {
          focusNowMs: (ms) => ms,
          getFocusTarget: () => null,
          focusPassIsNeeded: () => false,
        },
      },
      parts: { tracking: { _getTrackedFramePosition: () => null } },
    });
    rendering._attach(viewer);
    const points = draw.find('satellites:').spec.id;
    const set = draw.set(points);
    const range = [1.5e6, Number.MAX_VALUE];
    let frame = 0;
    const tick = () => rendering._preRenderTick({ frame: ++frame });
    rendering._addPoint(25544, { x: 1, y: 2, z: 3 }, POINT_STYLES.iss);
    tick();
    assert.equal(set.items.get('25544').displayRange, undefined);
    assert.equal(rendering._pointDisplayRange(25544), null);
    // The range goes to the set with the frame, as the item's own copy.
    assert.equal(rendering._setPointDisplayRange(25544, range), true);
    assert.equal(rendering._setPointDisplayRange(1, range), false, 'no dot');
    let writes = set.writes;
    tick();
    assert.equal(set.writes, writes + 1, 'sent with the frame');
    assert.deepEqual(set.items.get('25544').displayRange, range);
    assert.notEqual(set.items.get('25544').displayRange, range);
    assert.deepEqual(rendering._pointDisplayRange(25544), range);
    assert.equal(set.items.get('25544').show, true, 'shown, within its range');
    // The same range again sends nothing (asked every frame).
    writes = set.writes;
    rendering._setPointDisplayRange(25544, [1.5e6, Number.MAX_VALUE]);
    tick();
    assert.equal(set.writes, writes);
    // None again: every distance.
    rendering._setPointDisplayRange(25544, null);
    tick();
    assert.equal(set.items.get('25544').displayRange, undefined);
    assert.equal(rendering._pointDisplayRange(25544), null);
    // A dot added again (a catalog rebuild) arrives with no range.
    rendering._setPointDisplayRange(25544, range);
    rendering._addPoint(25544, { x: 1, y: 2, z: 3 }, POINT_STYLES.iss);
    tick();
    assert.equal(set.items.get('25544').displayRange, undefined);

    // The tracked dot: redrawn at once while drawn, fresh for each tracking.
    const tracked = draw.set(points.replace(':points', ':tracked'));
    state._trackedNorad = 25544;
    assert.equal(rendering._trackedDotDisplayRange(), null, 'no tracked dot');
    rendering._setTrackedDotDisplayRange(range); // nothing to put it on
    rendering._addTrackedEntity({ position: () => ({ x: 1, y: 2, z: 3 }) });
    assert.equal(rendering._trackedDotDisplayRange(), null);
    tick();
    assert.equal(tracked.items.get('25544').displayRange, undefined);
    writes = tracked.writes;
    rendering._setTrackedDotDisplayRange(range);
    assert.equal(tracked.writes, writes + 1, 'redrawn at once');
    assert.deepEqual(tracked.items.get('25544').displayRange, range);
    assert.deepEqual(rendering._trackedDotDisplayRange(), range);
    rendering._setTrackedDotDisplayRange([1.5e6, Number.MAX_VALUE]);
    assert.equal(tracked.writes, writes + 1, 'the same range sends nothing');
    rendering._setTrackedDotDisplayRange(null);
    assert.equal(tracked.items.get('25544').displayRange, undefined);
    assert.equal(rendering._trackedDotDisplayRange(), null);
    rendering._setTrackedDotDisplayRange(range);
    rendering._removeTrackedEntity();
    assert.equal(rendering._trackedDotDisplayRange(), null);
    rendering._addTrackedEntity({ position: () => ({ x: 1, y: 2, z: 3 }) });
    tick();
    assert.equal(tracked.items.get('25544').displayRange, undefined);
    rendering._detach(viewer);
  } finally {
    unbind();
  }
});

test('the orbit frame matrix turns ECEF about Z by minus the GMST elapsed', () => {
  const rendering = createRendering({
    state: {},
    services: { focus: {} },
    parts: {},
  });
  const bake = new Date('2026-07-20T10:00:00Z');
  const now = new Date('2026-07-20T10:10:00Z');
  const m = rendering.orbitFrameModelMatrix(gstime(bake), now);
  const angle = -(gstime(now) - gstime(bake));
  assert.equal(m.length, 16);
  assert.ok(Math.abs(m[0] - Math.cos(angle)) < 1e-12);
  assert.ok(Math.abs(m[1] - Math.sin(angle)) < 1e-12);
  assert.ok(Math.abs(m[4] + Math.sin(angle)) < 1e-12);
  assert.equal(m[10], 1);
  assert.equal(m[15], 1);
  // Written in place into a matrix it is handed.
  const into = new Cesium.Matrix4();
  assert.equal(rendering.orbitFrameModelMatrix(gstime(bake), now, into), into);
  assert.ok(Math.abs(into[0] - Math.cos(angle)) < 1e-12);
});

test('the focus pass projects every dot in one call and dims the dot under the focus', () => {
  const viewer = {};
  const calls = [];
  const { unbind } = bindFakeDraw(viewer, {
    camera: { pose: () => ({ position: { x: 0, y: 0, z: 0 } }) },
    query: {
      // Screen x, y are the point's own x, y.
      projectMany(source, out) {
        calls.push(source.length / 3);
        for (let i = 0, j = 0; i + 2 < source.length; i += 3, j += 2) {
          out[j] = source[i];
          out[j + 1] = source[i + 1];
        }
      },
      project: () => {
        throw new Error('the pass projects in one batch');
      },
    },
  });
  try {
    const target = {
      screenRect: { left: 90, right: 110, top: 90, bottom: 110 },
      cameraDistance: 1,
    };
    const state = {
      now: Date.now,
      _points: new Map(),
      _orbitPaths: new Map(),
      _catalog: new Map(),
      _viewer: viewer,
      _trackedNorad: null,
      _enabled: true,
      _params: { showPoints: true, showOrbits: false },
      _activeFocusCount: 0,
      _lastFocusUpdate: -Infinity,
    };
    const rendering = createRendering({
      state,
      services: {
        focus: {
          ...focusDeemphasis,
          focusNowMs: (ms) => ms,
          getFocusTarget: () => target,
          focusPassIsNeeded: () => true,
        },
      },
      parts: {
        controls: { _pointStyleFor: () => ({ color: [1, 1, 1, 1] }) },
        tracking: { _getTrackedFramePosition: () => null },
      },
    });
    rendering._attach(viewer);
    const style = { ...POINT_STYLES.iss, color: [1, 1, 1, 1] };
    rendering._addPoint(1, { x: 100, y: 100, z: 0 }, style);
    rendering._addPoint(2, { x: 100, y: 100, z: 0 }, style);
    rendering._addPoint(3, { x: 500, y: 500, z: 0 }, style);
    rendering._addPoint(4, { x: 100, y: 100, z: 0 }, style);
    state._points.get(2).show = false;
    state._trackedNorad = 4;
    for (let now = 0; now <= 5000; now += 100) rendering._updatePointFocus(now);
    assert.ok(calls.length > 0);
    assert.ok(
      calls.every((n) => n === 4),
      'one call over every dot',
    );
    const alpha = (id) => state._points.get(id).color[3];
    assert.ok(alpha(1) < 1, 'the dot under the focus dims');
    assert.equal(alpha(2), 1, 'a hidden dot is not dimmed');
    assert.equal(alpha(3), 1, 'a dot away from the focus is not dimmed');
    assert.equal(alpha(4), 1, 'the tracked dot is not dimmed');
    rendering._detach(viewer);
  } finally {
    unbind();
  }
});
