import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Cesium from 'cesium';
import { createPinia } from 'pinia';
import { useScreenAnnotationsStore } from '../ui/stores/screenAnnotations.js';
import { createHybridAnnotationRenderer } from './hybridAnnotationRenderer.js';

/** A hybrid renderer whose screen board is presented to its own store. */
function hybridWithBoard(viewer) {
  const store = useScreenAnnotationsStore(createPinia());
  const renderer = createHybridAnnotationRenderer(viewer, { screen: { store } });
  return { store, renderer };
}

/** The screen marks the board shows, fading ones included. */
function annotationGroups(store) {
  return store.board?.marks ?? [];
}

const childrenWithClass = (mark, name) =>
  mark.children.filter((child) => child.attrs?.class?.split(' ').includes(name));

function cameraLookingAt(lon, lat) {
  const target = Cesium.Cartesian3.fromDegrees(lon, lat);
  const radial = Cesium.Cartesian3.normalize(target, new Cesium.Cartesian3());
  const position = Cesium.Cartesian3.multiplyByScalar(
    radial,
    Cesium.Cartesian3.magnitude(target) + 1_000_000,
    new Cesium.Cartesian3(),
  );
  const direction = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.subtract(target, position, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const right = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(direction, Cesium.Cartesian3.UNIT_Z, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const up = Cesium.Cartesian3.normalize(
    Cesium.Cartesian3.cross(right, direction, new Cesium.Cartesian3()),
    new Cesium.Cartesian3(),
  );
  const frustum = new Cesium.PerspectiveFrustum({
    fov: Cesium.Math.toRadians(60),
    aspectRatio: 1280 / 720,
    near: 1,
    far: 20_000_000,
  });
  return {
    positionWC: position,
    directionWC: direction,
    rightWC: right,
    upWC: up,
    viewMatrix: Cesium.Matrix4.computeView(
      position,
      direction,
      up,
      right,
      new Cesium.Matrix4(),
    ),
    frustum,
    positionCartographic: { height: 1_000_000 },
  };
}

/** Install the browser globals both renderers touch, restored after the test. */
function installBrowserGlobals(t) {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalWindow = globalThis.window;
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  globalThis.window = { setTimeout: (fn) => { fn(); return 1; } };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });
}

/** A viewer whose scene/camera is just enough for both sub-renderers. */
function fakeViewer(lon, lat) {
  const camera = cameraLookingAt(lon, lat);
  const dataSources = [];
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  return {
    dataSources,
    viewer: {
      scene,
      camera,
      trackedEntity: null,
      dataSources: {
        add(dataSource) {
          dataSources.push(dataSource);
          return dataSource;
        },
        remove(dataSource) {
          const index = dataSources.indexOf(dataSource);
          if (index >= 0) dataSources.splice(index, 1);
          return index >= 0;
        },
      },
    },
  };
}


function naiveRingCentroid(ring) {
  const totals = ring.reduce(
    (sum, [lon, lat]) => ({ lon: sum.lon + lon, lat: sum.lat + lat }),
    { lon: 0, lat: 0 },
  );
  return { lon: totals.lon / ring.length, lat: totals.lat / ring.length, height: 0 };
}

test('hybrid outline upgrade preserves the screen group and adds world geometry', (t) => {
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalBrowserConstructors = new Map([
    ['HTMLCanvasElement', globalThis.HTMLCanvasElement],
    ['HTMLImageElement', globalThis.HTMLImageElement],
    ['ImageBitmap', globalThis.ImageBitmap],
    ['OffscreenCanvas', globalThis.OffscreenCanvas],
  ]);
  globalThis.requestAnimationFrame = (callback) => { callback(); return 1; };
  for (const name of originalBrowserConstructors.keys()) globalThis[name] = class {};
  t.after(() => {
    if (originalRequestAnimationFrame === undefined) delete globalThis.requestAnimationFrame;
    else globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    for (const [name, original] of originalBrowserConstructors) {
      if (original === undefined) delete globalThis[name];
      else globalThis[name] = original;
    }
  });

  const camera = cameraLookingAt(-99, 31);
  const dataSources = [];
  const scene = {
    camera,
    canvas: { clientWidth: 1280, clientHeight: 720, width: 1280, height: 720 },
    frameState: { mode: Cesium.SceneMode.SCENE3D },
    clampToHeightSupported: true,
    clampToHeight: (world) => world,
    postRender: { addEventListener() {}, removeEventListener() {} },
  };
  const viewer = {
    scene,
    camera,
    trackedEntity: null,
    dataSources: {
      add(dataSource) {
        dataSources.push(dataSource);
        return dataSource;
      },
      remove(dataSource) {
        const index = dataSources.indexOf(dataSource);
        if (index >= 0) dataSources.splice(index, 1);
        return index >= 0;
      },
    },
  };
  const { store, renderer } = hybridWithBoard(viewer);
  const anno = {
    id: 'anno-hybrid-fb3',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: { lon: -99, lat: 31, height: 0 },
    ring: null,
    footprintKind: null,
    synthesized: false,
  };

  renderer.add(anno);
  const [before] = annotationGroups(store);
  assert.equal(childrenWithClass(before, 'gev-anno-ring').length, 2);
  assert.equal(dataSources.length, 1);
  assert.equal(dataSources[0].entities.values.length, 0);

  const ring = [
    [-106, 25],
    [-93, 25],
    [-93, 36],
    [-106, 36],
    [-106, 25],
  ];
  const centroid = naiveRingCentroid(ring);
  anno.ring = ring;
  anno.anchor = centroid;
  anno.footprintKind = 'area';
  renderer.update(anno);

  const [after, ...others] = annotationGroups(store);
  const expectedWindow = Cesium.SceneTransforms.worldToWindowCoordinates(
    scene,
    Cesium.Cartesian3.fromDegrees(centroid.lon, centroid.lat, centroid.height),
  );
  assert.equal(after.key, before.key, 'the real hybrid keeps the existing screen mark');
  assert.equal(others.length, 0);
  assert.equal(childrenWithClass(after, 'gev-anno-ring').length, 0, 'screen reticle rings are removed');
  assert.deepEqual(
    after.children.map((child) => child.key),
    ['dot', 'leader', 'callout'],
    'the dot, leader and callout are retained',
  );
  const dot = after.children.find((child) => child.key === 'dot');
  assert.equal(dot.attrs.cx, expectedWindow.x.toFixed(1));
  assert.equal(dot.attrs.cy, expectedWindow.y.toFixed(1));
  assert.deepEqual(centroid, { lon: -100.8, lat: 29.4, height: 0 }, 'closed-ring vertex mean stays pinned');
  assert.equal(dataSources[0].entities.values.length, 2, 'world area adds one fill and one outline');
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polygon).length, 1);
  assert.equal(dataSources[0].entities.values.filter((entity) => entity.polyline).length, 1);
  assert.equal(Object.hasOwn(anno, '_entities'), false, 'world entity state stays on the inherited proxy');
  renderer.destroy();
});

// ── Partial-add rollback (review round 2) ─────────────────────────────────────
//
// The hybrid builds a mark across TWO sub-renderers. It used to record the
// route only after both had run, so a throw in the second one left the first
// one's content live with nothing pointing at it: remove() was a no-op and the
// engine's rollback (which knows only the id) could not reach it. The next
// annotate of the same geometry then stacked a fresh mark over that orphan.

test('a sub-renderer throw mid-add leaves state the rollback can still remove', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const { store, renderer } = hybridWithBoard(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The world drape lands first; the screen caption then fails the way a lost
  // context does, AFTER the world geometry is already on the board.
  const publish = store.publish;
  let failNextInsert = true;
  store.publish = (board) => {
    if (failNextInsert) {
      failNextInsert = false;
      throw new Error('screen insert failed');
    }
    return publish(board);
  };

  assert.throws(() => renderer.add(anno), /screen insert failed/);
  assert.equal(dataSources[0].entities.values.length, 2, 'the world drape is already live');
  assert.equal(annotationGroups(store).length, 0, 'the half-built screen group detached itself');

  // The engine's rollback path — it must reach the partial state by id.
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0, 'partial world state must be released');

  // …and the id is free again: a retry draws ONE mark, not a second one over
  // an orphan nothing owns.
  renderer.add(anno);
  assert.equal(dataSources[0].entities.values.length, 2, 'the retry draws exactly one world drape');
  assert.equal(annotationGroups(store).length, 1, 'and exactly one screen caption');
  renderer.remove(anno);
  assert.equal(dataSources[0].entities.values.length, 0);
  renderer.destroy();
});

test('a release that throws keeps the mark addressable for a retry cleanup', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const { store, renderer } = hybridWithBoard(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-release-throw',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  renderer.add(anno);
  assert.equal(dataSources[0].entities.values.length, 2);
  assert.equal(annotationGroups(store).length, 1);

  // The world route releases fine, then the screen release fails part-way
  // (its fade-out timer throws) — so its mark is still on the board.
  const workingSetTimeout = globalThis.window.setTimeout;
  globalThis.window.setTimeout = () => { throw new Error('teardown scheduling failed'); };
  assert.throws(() => renderer.remove(anno), /teardown scheduling failed/);
  assert.equal(dataSources[0].entities.values.length, 0, 'the world route did release');
  assert.equal(annotationGroups(store).length, 1, 'the screen route did NOT — that is the orphan');

  // Dropping the routing entry here would make that orphan permanently
  // unreachable. It must still be addressable, so a retry finishes the job.
  globalThis.window.setTimeout = workingSetTimeout;
  renderer.remove(anno);
  assert.equal(annotationGroups(store).length, 0, 'the retry cleanup must reach the orphan');
  assert.equal(dataSources[0].entities.values.length, 0, 'without double-releasing the world route');

  // Fully released now — a third call is inert.
  renderer.remove(anno);
  assert.equal(annotationGroups(store).length, 0);
  renderer.destroy();
});

test('a world add that fails mid-way leaves its landed entities removable', (t) => {
  installBrowserGlobals(t);
  const { viewer, dataSources } = fakeViewer(-99, 31);
  const { store, renderer } = hybridWithBoard(viewer);
  const ring = [[-106, 25], [-93, 25], [-93, 36], [-106, 36], [-106, 25]];
  const anno = {
    id: 'anno-partial-world-add',
    type: 'area',
    color: 'primary',
    label: 'Texas',
    alpha: 1,
    anchor: naiveRingCentroid(ring),
    ring,
    footprintKind: 'area',
    synthesized: false,
  };

  // The draped fill lands; the outline throws (bad geometry / lost context).
  const entities = dataSources[0].entities;
  const realAdd = entities.add.bind(entities);
  let addsLeft = 1;
  entities.add = (options) => {
    if (addsLeft <= 0) throw new Error('entity add failed');
    addsLeft -= 1;
    return realAdd(options);
  };

  assert.throws(() => renderer.add(anno), /entity add failed/);
  assert.equal(entities.values.length, 1, 'one entity landed before the failure');

  entities.add = realAdd;
  renderer.remove(anno);
  assert.equal(entities.values.length, 0,
    'the rollback must see the entities that landed before the throw');

  renderer.add(anno);
  assert.equal(entities.values.length, 2, 'the retry draws a complete mark');
  assert.equal(annotationGroups(store).length, 1);
  renderer.destroy();
});
