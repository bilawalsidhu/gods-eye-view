import test from 'node:test';
import assert from 'node:assert/strict';
import { fromDegrees } from '../../geo/ellipsoid.js';
import { sphereFromPoints } from '../../geo/sphere.js';
import { bindFakeDraw } from '../../testSupport/fakeDrawPort.mjs';
import { CYCLONE_SET_PREFIX, createCycloneRendering } from './rendering.js';
import {
  CYCLONE_ACCENT,
  CYCLONE_MARKER_PX,
  CYCLONE_OVERLAY_SOURCE_ID,
  CYCLONE_SELECTED_ACCENT,
} from './labels.js';

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

/** A rendering on a viewer bound to a fake draw port. */
function harness() {
  const viewer = {};
  const { draw, unbind } = bindFakeDraw(viewer);
  const overlay = overlayRecorder();
  const rendering = createCycloneRendering({
    viewer,
    overlayHost: overlay.host,
  });
  const sets = {};
  for (const kind of ['points', 'lines', 'cones'])
    sets[kind] = [...draw.sets.values()].find((record) =>
      record.spec.id.endsWith(`:${kind}`),
    );
  return {
    viewer,
    draw,
    unbind,
    overlay,
    rendering,
    sets,
    /** Every item drawn now, across the rendering's sets. */
    items() {
      return Object.values(sets).flatMap((record) => [
        ...record.items.values(),
      ]);
    },
    /** A click's draw hit on the item `id`, in the set of `kind`. */
    hit(kind, id) {
      return { set: sets[kind].spec.id, id, surface: false };
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

test('each rendering draws into its own point, line and cone sets', () => {
  const a = harness();
  const { sets } = a;
  assert.match(sets.points.spec.id, new RegExp(`^${CYCLONE_SET_PREFIX}:\\d+:`));
  assert.equal(sets.points.kind, 'points');
  assert.equal(sets.points.spec.horizonCull, true);
  assert.equal(sets.points.spec.clampTo, 'both');
  assert.equal(sets.lines.kind, 'lines');
  assert.equal(sets.lines.spec.clampTo, 'both');
  assert.equal(sets.cones.kind, 'shapes');
  assert.equal(sets.cones.spec.clampTo, 'both');

  // A second rendering on the same renderer is a separate display.
  const viewer = {};
  const { draw } = bindFakeDraw(viewer);
  const first = createCycloneRendering({
    viewer,
    overlayHost: overlayRecorder().host,
  });
  const second = createCycloneRendering({
    viewer,
    overlayHost: overlayRecorder().host,
  });
  assert.equal(draw.sets.size, 6);
  second.destroy();
  assert.equal(
    [...draw.sets.values()].filter((record) => !record.disposed).length,
    3,
  );
  first.destroy();
  a.rendering.destroy();
});

test('advisory geometry keeps polygon parts, holes and geographic seam coordinates', async () => {
  const h = harness();
  assert.equal(await h.rendering.setSnapshot({ storms: [storm()] }), true);
  const cones = [...h.sets.cones.items.values()];
  assert.deepEqual(
    cones.map((cone) => cone.id),
    ['cyclone:ep152026:cone:0', 'cyclone:ep152026:cone:1'],
  );
  assert.equal(cones[0].geometry.kind, 'polygon');
  assert.equal(cones[0].geometry.rings.length, 2, 'the hole stays');
  assert.equal(cones[0].geometry.rings[0][1].lon, -178);
  for (const cone of cones) {
    assert.equal(cone.height, 'clampGround');
    assert.equal(cone.fill, 'rgba(127,230,237,0.16)');
    assert.equal(cone.outline, undefined, 'outlines are lines of their own');
    assert.equal(cone.extrudedHeight, undefined);
  }
  const lines = [...h.sets.lines.items.values()];
  const outlines = lines.filter((line) => line.id.includes(':outline:'));
  assert.equal(outlines.length, 3);
  assert.deepEqual(
    outlines.map((line) => line.positions),
    storm()
      .cone.coordinates.flat()
      .map((ring) => ring.map(([lon, lat]) => fromDegrees(lon, lat, 0))),
    'lines take ECEF',
  );
  for (const outline of outlines) {
    assert.equal(outline.widthPx, 1);
    assert.deepEqual(outline.style, {
      kind: 'solid',
      color: 'rgba(127,230,237,0.55)',
    });
  }
  const track = lines.find((line) => line.id === 'cyclone:ep152026:track:0');
  assert.equal(track.widthPx, 2.5);
  assert.deepEqual(track.style, { kind: 'solid', color: CYCLONE_ACCENT });
  assert.deepEqual(track.positions[1], fromDegrees(-179, 16, 0));
  for (const line of lines) assert.equal(line.mode, 'draped');
  const points = [...h.sets.points.items.values()];
  assert.deepEqual(
    points.map((point) => point.id),
    ['cyclone:ep152026:center', 'cyclone:ep152026:forecast:1'],
    'the zero-hour forecast is the center',
  );
  for (const point of points) {
    assert.equal(point.height, 'clampGround');
    assert.equal(point.disableDepthTest, Number.POSITIVE_INFINITY);
    assert.deepEqual(point.outlineColor, [0, 0, 0, 1]);
  }
  assert.deepEqual(points[1].color, [1, 1, 1, 1]);
  assert.equal(points[1].pixelSize, CYCLONE_MARKER_PX.forecast);
  assert.equal(points[0].pixelSize, CYCLONE_MARKER_PX.storm);
  assert.equal(points[1].outlineWidth, 1);
  assert.equal(points[0].outlineWidth, 2);
  assert.deepEqual(h.rendering.getDiagnostics(), {
    storms: 1,
    tracks: 1,
    cones: 2,
    dangerAreas: 0,
    forecastPoints: 1,
    dataSources: 1,
    entities: 8,
    selectedId: null,
    timerActive: false,
  });
  h.rendering.destroy();
  assert.ok(Object.values(h.sets).every((record) => record.disposed));
  assert.equal(h.rendering.getDiagnostics().entities, 0);
});

test('selection redraws the centers and labels; an unchanged one is quiet', async () => {
  const h = harness();
  await h.rendering.setSnapshot({
    storms: [storm(), { ...storm(), id: 'near', name: 'Near' }],
  });
  const center = (id) => h.sets.points.items.get(`cyclone:${id}:center`);
  assert.equal(center('near').pixelSize, 9);
  h.rendering.setSelection('near');
  assert.equal(center('near').pixelSize, 12);
  assert.equal(center('near').color, CYCLONE_SELECTED_ACCENT);
  assert.equal(center('ep152026').pixelSize, 9);
  assert.equal(center('ep152026').color, CYCLONE_ACCENT);
  assert.ok(h.sets.points.items.has('cyclone:near:forecast:1'));
  const pointWrites = h.sets.points.writes;
  const lineWrites = h.sets.lines.writes;
  const publishes = h.overlay.publishes;
  h.rendering.setSelection('near');
  assert.equal(h.overlay.publishes, publishes, 'unchanged selection is quiet');
  assert.equal(h.sets.points.writes, pointWrites, 'points are not redrawn');
  assert.equal(h.sets.lines.writes, lineWrites, 'tracks are not redrawn');
  h.rendering.destroy();
});

test('a click names a storm only through a current item of its own sets', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  const items = h.items();
  assert.equal(items.length, 8);
  for (const kind of ['points', 'lines', 'cones'])
    for (const id of h.sets[kind].items.keys()) {
      assert.equal(h.rendering.pickStorm(h.hit(kind, id)), 'ep152026', id);
      assert.equal(h.rendering.ownsPickId(id), true);
      assert.equal(
        h.rendering.pickStorm({ set: 'other:points', id, surface: false }),
        null,
        "another layer's set is not ownership",
      );
    }
  assert.equal(
    h.rendering.pickStorm({
      ...h.hit('points', 'cyclone:ep152026:center'),
      surface: true,
    }),
    null,
  );
  assert.equal(h.rendering.pickStorm(undefined), null);
  assert.equal(h.rendering.pickStorm(null), null);
  assert.equal(
    h.rendering.pickStorm(h.hit('points', 'cyclone:ep152026')),
    null,
    'a prefix is not an item',
  );
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:unknown'), false);

  // A newer advisory without the storm drops its ids at once.
  await h.rendering.setSnapshot({ storms: [{ ...storm(), id: 'ep162026' }] });
  assert.equal(
    h.rendering.pickStorm(h.hit('points', 'cyclone:ep152026:center')),
    null,
  );
  assert.equal(h.rendering.ownsPickId('cyclone:ep152026:center'), false);
  assert.equal(
    h.rendering.pickStorm(h.hit('points', 'cyclone:ep162026:center')),
    'ep162026',
  );
  h.rendering.clear();
  assert.equal(
    h.rendering.pickStorm(h.hit('points', 'cyclone:ep162026:center')),
    null,
  );
  assert.equal(h.rendering.ownsPickId('cyclone:ep162026:center'), false);
  h.rendering.destroy();
});

test('focus spheres bound the advisory and never shrink below a region', async () => {
  const h = harness();
  const statusOnly = {
    ...storm(),
    id: 'status',
    geometryStatus: 'pending',
  };
  await h.rendering.setSnapshot({ storms: [storm(), statusOnly] });
  const at = ([lon, lat]) => fromDegrees(lon, lat, 0);
  const expected = sphereFromPoints([
    at([179, 15]),
    ...storm().track.coordinates[0].map(at),
    ...storm().cone.coordinates[0][0].map(at),
    ...storm().cone.coordinates[1][0].map(at),
    at([-179, 16]),
  ]);
  const sphere = h.rendering.getFocusSphere('ep152026');
  assert.deepEqual(sphere.center, expected.center);
  assert.equal(sphere.radius, Math.max(expected.radius, 500_000));
  assert.equal(h.rendering.getFocusSphere('status').radius, 500_000);
  assert.equal(h.rendering.getFocusSphere('missing'), null);
  h.rendering.clear();
  assert.equal(h.rendering.getFocusSphere('ep152026'), null);
  h.rendering.destroy();
});

test('pending or mismatched advisory geometry never renders even when supplied', async () => {
  for (const changed of [
    { geometryStatus: 'pending' },
    { geometryAdvisoryNumber: '9' },
  ]) {
    const h = harness();
    await h.rendering.setSnapshot({ storms: [{ ...storm(), ...changed }] });
    assert.deepEqual(
      h.items().map((item) => item.id),
      ['cyclone:ep152026:center'],
    );
    assert.equal(h.rendering.getDiagnostics().tracks, 0);
    h.rendering.destroy();
  }
});

test('an aborted or destroyed update keeps what is drawn', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    h.rendering.setSnapshot({ storms: [] }, { signal: controller.signal }),
  );
  assert.equal(h.items().length, 8);
  assert.equal(h.rendering.getDiagnostics().storms, 1);
  h.rendering.destroy();
  h.rendering.destroy();
  assert.equal(await h.rendering.setSnapshot({ storms: [storm()] }), false);
  assert.ok(Object.values(h.sets).every((record) => record.disposed));
});

test('an empty advisory after a full one leaves nothing drawn', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  h.rendering.setSelection('ep152026');
  assert.equal(await h.rendering.setSnapshot({ storms: [] }), true);
  assert.deepEqual(h.items(), []);
  assert.equal(h.rendering.getDiagnostics().entities, 0);
  h.rendering.destroy();
  h.rendering.setSelection('ep152026');
});

test('clear empties the sets and a later advisory draws again', async () => {
  const h = harness();
  await h.rendering.setSnapshot({ storms: [storm()] });
  h.rendering.setSelection('ep152026');
  h.rendering.clear();
  assert.equal(h.items().length, 0);
  assert.ok(Object.values(h.sets).every((record) => !record.disposed));
  assert.deepEqual(h.rendering.getDiagnostics(), {
    storms: 0,
    tracks: 0,
    cones: 0,
    dangerAreas: 0,
    forecastPoints: 0,
    dataSources: 0,
    entities: 0,
    selectedId: null,
    timerActive: false,
  });
  await h.rendering.setSnapshot({ storms: [storm()] });
  assert.equal(h.items().length, 8);
  assert.equal(
    h.sets.points.items.get('cyclone:ep152026:center').pixelSize,
    9,
    'clear drops the selection',
  );
  h.rendering.destroy();
});

test('labels publish committed anchors to the shared overlay and follow selection and clear', async () => {
  const h = harness();
  await h.rendering.setSnapshot({
    storms: [storm(), { ...storm(), id: 'near', name: 'Near' }],
  });
  const anchor = (item) => fromDegrees(item.pos.lon, item.pos.lat, 0);
  const point = (id) => h.sets.points.items.get(id);
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
  assert.deepEqual(
    h.overlay.entry('storm:near').position,
    anchor(point('cyclone:near:center')),
    'labels sit at the anchors the points use',
  );
  assert.equal(h.overlay.entry('storm:near').horizonCull, true);

  h.rendering.setSelection('near');
  assert.equal(h.overlay.entry('storm:near').variant, 'selected');
  assert.equal(h.overlay.entry('storm:ep152026').variant, 'card');
  assert.deepEqual(
    h.overlay.entry('lead:near:12').position,
    anchor(point('cyclone:near:forecast:1')),
  );
  assert.equal(h.overlay.entry('lead:near:12').maxDistance, 4_000_000);
  assert.equal(h.overlay.entry('lead:ep152026:12'), null);

  // A refresh republishes the new anchors with the retained selection.
  await h.rendering.setSnapshot({
    storms: [{ ...storm(), id: 'near', name: 'Near' }],
  });
  assert.deepEqual(
    h.overlay.published().map((entry) => [entry.id, entry.variant]),
    [
      ['storm:near', 'selected'],
      ['lead:near:12', 'card'],
    ],
  );

  h.rendering.clear();
  const afterClear = h.overlay.calls.slice(-2);
  assert.deepEqual(afterClear, [
    { kind: 'clear', source: CYCLONE_OVERLAY_SOURCE_ID },
    { kind: 'visible', source: CYCLONE_OVERLAY_SOURCE_ID, visible: false },
  ]);
  h.rendering.destroy();
  assert.equal(h.overlay.calls.at(-1), afterClear[1]);
});

test('a JTWC danger area is drawn apart from any cone, with a dashed edge and its name for the selected storm', async () => {
  const h = harness();
  const jtwc = {
    ...storm(),
    id: 'sh042027',
    cone: null,
    dangerArea: {
      type: 'Polygon',
      coordinates: [
        [
          [178, 10],
          [-178, 10],
          [-178, 20],
          [178, 10],
        ],
      ],
    },
  };
  assert.equal(await h.rendering.setSnapshot({ storms: [jtwc] }), true);
  const [area] = [...h.sets.cones.items.values()];
  assert.equal(area.id, 'cyclone:sh042027:danger:0');
  assert.equal(area.fill, 'rgba(255,177,92,0.12)');
  const outline = [...h.sets.lines.items.values()].find(
    (line) => line.id === 'cyclone:sh042027:danger:0:outline:0',
  );
  assert.deepEqual(outline.style, {
    kind: 'dash',
    color: 'rgba(255,177,92,0.8)',
    length: 16,
  });
  const diagnostics = h.rendering.getDiagnostics();
  assert.equal(diagnostics.cones, 0);
  assert.equal(diagnostics.dangerAreas, 1);
  // A click on the area names its storm.
  assert.equal(
    h.rendering.pickStorm(h.hit('cones', 'cyclone:sh042027:danger:0')),
    'sh042027',
  );
  assert.equal(h.overlay.entry('area:sh042027'), null, 'unselected: no name');
  h.rendering.setSelection('sh042027');
  const name = h.overlay.entry('area:sh042027');
  assert.equal(name.title, '34-knot wind danger area');
  // On the area's edge, at the vertex nearest the middle forecast point.
  assert.deepEqual(name.position, fromDegrees(-178, 20, 0));
  h.rendering.destroy();
});
