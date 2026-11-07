import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import test from 'node:test';
import { bindRenderer, drawOf, findQuery, queryOf } from '../rendererOf.js';
import './query.js';

/**
 * A viewer's scene with what the draw and query ports touch: primitives,
 * frame events, picks, and height samples that record what they see
 * through.
 */
function fakeViewer() {
  const added = [];
  const sampled = [];
  const scene = {
    added,
    sampled,
    preRender: new Cesium.Event(),
    postRender: new Cesium.Event(),
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    camera: {
      positionWC: new Cesium.Cartesian3(2e7, 0, 0),
      pickEllipsoid: (s) =>
        s.x === 50 && s.y === 50 ? new Cesium.Cartesian3(6378137, 0, 0) : null,
    },
    primitives: {
      add: (primitive) => (added.push(primitive), primitive),
      remove: (primitive) => {
        const at = added.indexOf(primitive);
        if (at >= 0) added.splice(at, 1);
        return at >= 0;
      },
      length: 0,
    },
    picked: undefined,
    pick() {
      return this.picked;
    },
    drillPick() {
      return this.picked ? [this.picked] : [];
    },
    sampleHeightSupported: true,
    sampleHeight(carto, exclude) {
      sampled.push(exclude);
      return 12;
    },
    updateHeight: () => () => {},
    getHeight: () => undefined,
    requestRender() {},
    isDestroyed: () => false,
  };
  return { scene };
}

test('a viewer of its own, with no renderer bound, is queried through a built port over its draw sets', () => {
  const viewer = fakeViewer();
  const { scene } = viewer;
  const query = queryOf(viewer);
  assert.equal(findQuery(viewer), query, 'one per viewer');

  const ground = drawOf(viewer).points({
    id: 'mine',
    includeInHeightQueries: true,
  });
  ground.set([
    { id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4, meta: { n: 1 } },
  ]);
  const other = drawOf(viewer).points({ id: 'theirs' });
  other.set([{ id: 'b', pos: { lon: 1, lat: 0 }, pixelSize: 4 }]);
  const idsOf = (exclude) => exclude.map((id) => `${id.set}:${id.id}`).sort();

  // Heights see through the sets not drawn as ground, and those excluded.
  assert.equal(query.sampleHeightNow({ lon: 0, lat: 0 }), 12);
  assert.deepEqual(idsOf(scene.sampled.at(-1)), ['theirs:b']);
  query.sampleHeightNow({ lon: 0, lat: 0 }, { exclude: ['mine'] });
  assert.deepEqual(idsOf(scene.sampled.at(-1)), ['mine:a', 'theirs:b']);

  // Picks name the set's item.
  scene.picked = { id: scene.added[0].get(0).id };
  assert.deepEqual(query.pick(5, 5), {
    set: 'mine',
    id: 'a',
    meta: { n: 1 },
    surface: false,
  });

  // The screen centre's ellipsoid point, and the horizon from the eye.
  assert.deepEqual(query.pickEllipsoid(50, 50), { x: 6378137, y: 0, z: 0 });
  assert.equal(query.pickEllipsoid(0, 0), null);
  assert.equal(query.isOccluded({ x: 6378137, y: 0, z: 0 }), false);
  assert.equal(query.isOccluded({ x: -6378137, y: 0, z: 0 }), true);

  // A renderer bound later answers new callers.
  const unbind = bindRenderer(viewer, { query: { id: 'renderer' } });
  assert.equal(findQuery(viewer).id, 'renderer');
  unbind();
  assert.notEqual(findQuery(viewer), query, 'built again once unbound');
  ground.dispose();
  other.dispose();
});

test('terrain heights answer without depth textures; the drawn surface does not', () => {
  const viewer = fakeViewer();
  viewer.scene.sampleHeightSupported = false;
  viewer.scene.globe = { getHeight: () => 2600 };
  const query = queryOf(viewer);
  const point = { lon: 1, lat: 2 };
  assert.equal(query.sampleHeightNow(point, { against: 'terrain' }), 2600);
  assert.equal(query.sampleHeightNow(point), null);
  const out = new Float64Array(1);
  query.sampleHeightNowMany(new Float64Array([1, 2]), out, {
    against: 'terrain',
  });
  assert.equal(out[0], 2600);
  query.sampleHeightNowMany(new Float64Array([1, 2]), out);
  assert.ok(Number.isNaN(out[0]));
});

test('nothing to query, no port', () => {
  assert.equal(findQuery({ scene: {} }), null);
  assert.throws(() => queryOf({ scene: {} }), /no renderer to query/);
  assert.throws(
    () => queryOf({ scene: {}, isDestroyed: () => true }),
    /destroyed/,
  );
});

test('a query port built before its viewer can draw sees the sets drawn later, and goes with the viewer', () => {
  const viewer = fakeViewer();
  const { scene } = viewer;
  const primitives = scene.primitives;
  scene.primitives = undefined;
  const query = queryOf(viewer);
  assert.equal(query.pick(5, 5)?.set, undefined, 'nothing drawn yet');
  scene.primitives = primitives;
  const set = drawOf(viewer).points({ id: 'later' });
  set.set([{ id: 'a', pos: { lon: 0, lat: 0 }, pixelSize: 4 }]);
  scene.picked = { id: scene.added[0].get(0).id };
  assert.equal(query.pick(5, 5)?.set, 'later', 'its sets are picked');
  query.sampleHeightNow({ lon: 0, lat: 0 }, { exclude: ['later'] });
  assert.deepEqual(
    scene.sampled.at(-1).map((id) => id.set),
    ['later'],
    'and seen through',
  );
  set.dispose();
  viewer.isDestroyed = () => true;
  assert.equal(findQuery(viewer), null, 'gone with its viewer');
});
