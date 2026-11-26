import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { createSelection } from './selection.js';
import { ownsCctvPick } from './pickIds.js';
import { GIZMO_ID_PREFIX } from '../../data/cctvGizmo.js';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { fakeInput, fakeInputUnderLabel } from '../../input/testDoubles.mjs';
import * as picking from '../../data/pickRegistry.js';
import { bindRenderer } from '../../render/rendererOf.js';
import { fakeCameraPort } from '../../testSupport/fakeCameraPort.mjs';

function viewerWithCamera() {
  const camera = fakeCameraPort();
  const viewer = {};
  bindRenderer(viewer, { camera: camera.port });
  return { viewer, camera };
}

function lifecycleFor(state) {
  const passes = [];
  const lifecycle = createLifecycle({
    state,
    services: {
      sprites: {},
      activation: {},
      picking: {},
      focus: {},
      render: {},
    },
    parts: {
      rendering: {
        refreshHorizonCulling: () => {
          passes.push('view');
          return false;
        },
      },
      geometryQueue: { enqueueViewGeometry() {} },
      cards: { refreshAmbientCards() {} },
      presentation: { notifyListeners() {} },
      navigation: { reopenNearestCamera() {} },
    },
  });
  return { lifecycle, passes };
}

test('the view listeners follow the camera port and let go on teardown', () => {
  const first = viewerWithCamera();
  const state = { _viewer: first.viewer, _enabled: false };
  const { lifecycle, passes } = lifecycleFor(state);
  const counts = (camera) => [
    camera.listenerCount('moveStart'),
    camera.listenerCount('moveEnd'),
  ];

  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);
  first.camera.emit('moveStart');
  assert.equal(state._cameraMoving, true, 'hover pauses while moving');
  first.camera.emit('moveEnd');
  assert.equal(state._cameraMoving, false);
  assert.deepEqual(passes, ['view'], 'a settled move reruns the view pass');

  // A re-init on the same viewer keeps its listeners.
  lifecycle.attachViewListeners();
  assert.deepEqual(counts(first.camera), [1, 1]);

  // One on a new viewer moves them to its camera.
  const second = viewerWithCamera();
  state._viewer = second.viewer;
  first.camera.emit('moveStart');
  lifecycle.attachViewListeners();
  assert.equal(state._cameraMoving, false, 'the old move is forgotten');
  assert.deepEqual(counts(first.camera), [0, 0]);
  assert.deepEqual(counts(second.camera), [1, 1]);

  lifecycle.detachViewListeners();
  assert.deepEqual(counts(second.camera), [0, 0]);
  assert.equal(state._viewListenerCamera, null);
});

test('terrain loading and surface changes rerun the view pass', () => {
  const viewer = {};
  let version = 1,
    progress,
    removed = false;
  bindRenderer(viewer, {
    camera: fakeCameraPort().port,
    globe: {
      surfaceVersion: () => version,
      on(event, cb) {
        assert.equal(event, 'progress');
        progress = cb;
        return () => {
          removed = true;
        };
      },
    },
  });
  const { lifecycle, passes } = lifecycleFor({
    _viewer: viewer,
    _enabled: true,
  });
  lifecycle.attachViewListeners();
  progress({ terrainPending: 2 });
  assert.equal(passes.length, 0);
  progress({ terrainPending: 0 });
  assert.equal(passes.length, 1);
  version++;
  progress({ terrainPending: 0 });
  assert.equal(passes.length, 2);
  lifecycle.detachViewListeners();
  assert.ok(removed);
});

/** A part whose members are `own`'s, and any other a function that does
 *  nothing. */
const inert = (own = {}) =>
  new Proxy(own, {
    get: (target, name) => (name in target ? target[name] : () => {}),
  });

test("a click on a mission label over a camera's card never turns that camera on, and keeps the active one", async (t) => {
  const { viewer } = viewerWithCamera();
  viewer.scene = { canvas: {}, pick: () => null };
  // The card of camera `cam-1` lies under every click, under the label.
  const fake = fakeInputUnderLabel(viewer, {
    beneath: () => ({ sourceId: CCTV_OVERLAY_SOURCE_ID, entryId: 'cam-1' }),
  });
  t.after(() => fake.destroy());
  const activated = [];
  const deactivated = [];
  const state = {};
  const lifecycle = createLifecycle({
    state,
    services: {
      activation: {
        activateCctvCameraFromWorldClick: (id) => activated.push(id),
      },
      picking,
      focus: {},
      render: {},
    },
    parts: {
      calibration: { loadCalibrationStore: () => new Map() },
      catalog: {
        loadCameraSources: async () => [],
        buildCatalogFromSources: () => [],
        seedCatalog: () => [],
      },
      ground: {
        resolveGroundPriors: async () => [],
        currentSurfaceRegime: () => null,
      },
      rendering: inert({ refreshHorizonCulling: () => false }),
      health: { syncHealthState: async () => {} },
      geometryQueue: inert(),
      cards: inert(),
      projection: inert(),
      presentation: inert(),
      navigation: inert(),
      hover: inert(),
      selection: {
        // The camera's own gate takes only clean clicks; these are.
        bindCctvWorldClickGesture: (input, onClick) => input.onClick(onClick),
        extractPickedCameraId: () => null,
        cctvEmptyClickDeselects: (picked, { activeCameraId }) =>
          Boolean(activeCameraId) && picking.resolvePickId(picked) === null,
        deactivateActiveCamera: () => deactivated.push(state._activeCameraId),
      },
    },
  });
  // Init's bounded wait for ground heights never runs out here: they are in.
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await lifecycle.methods.init(viewer);
  t.after(() => state._clickSubscription?.());
  state._enabled = true;
  state._activeCameraId = 'cam-0';
  state._recordById.set('cam-1', {});

  fake.label.over = true;
  fake.click();
  assert.deepEqual(activated, [], 'the camera under the label stays off');
  assert.deepEqual(deactivated, [], 'the active camera stays on');

  // Off the label, a click on the card turns its camera on.
  fake.label.over = false;
  fake.click();
  assert.deepEqual(activated, ['cam-1']);
});

test('the card painted on top takes world clicks, whatever is drawn under it', async (t) => {
  const noop = () => {};
  const { viewer } = viewerWithCamera();
  let picked = null;
  viewer.scene = {
    canvas: {},
    pick: () => (picked ? { id: picked } : undefined),
    drillPick: () => drilled.map((id) => ({ id })),
  };
  let drilled = [];
  const input = fakeInput(viewer);
  // An aircraft layer that runs before ours and tracks the plane it was
  // clicked on, standing aside under another layer's card.
  let tracked = null;
  input.input.onClick((event) => {
    if (picking.isUnderOtherCard(event)) return;
    if (event.hit?.id === 'plane:9') tracked = 'plane:9';
  });
  const ownCard = { sourceId: CCTV_OVERLAY_SOURCE_ID, entryId: 'cam-1' };
  const foreignCard = {
    sourceId: 'earthquake-card',
    entryId: 'earthquake-card:qa',
  };
  let painted = [];
  const actions = [];
  // The card on top at a click, as the host answers the pick registry.
  picking.setClickCardHitTest(() => painted[0] ?? null);
  const state = {
    _cctvOverlayHost: {
      hitTest: (_x, _y, options = {}) =>
        painted.find(
          (hit) => !options.sourceId || hit.sourceId === options.sourceId,
        ) ?? null,
    },
  };
  const parts = {
    calibration: { loadCalibrationStore: () => new Map() },
    catalog: {
      loadCameraSources: async () => [],
      buildCatalogFromSources: () => [],
      seedCatalog: () => [],
    },
    ground: {
      resolveGroundPriors: async () => [],
      currentSurfaceRegime: () => 'terrain-globe',
    },
    cards: { teardownAmbientCards: noop },
    projection: { clearProjectionOverlay: noop },
    geometryQueue: { stopGeometryLoadQueue: noop },
    rendering: {
      createCameraIcons: noop,
      refreshHorizonCulling: () => false,
      refreshCoverageStyles: noop,
      extractPickedCameraId: (hit) =>
        hit?.set === 'cctv:fixture' ? (hit.meta?.cameraId ?? hit.id) : null,
    },
    hover: { handleHoverMove: noop },
    health: { syncHealthState: async () => {} },
    presentation: { notifyListeners: noop },
  };
  const services = {
    sprites: {},
    focus: { onFocusTargetAppear: () => noop },
    render: { releaseContinuousRender: noop },
    picking,
    activation: { activateCctvCameraFromWorldClick: (id) => actions.push(id) },
  };
  parts.selection = createSelection({ state, services, parts });
  parts.selection.deactivateActiveCamera = () => actions.push('clear');
  const lifecycle = createLifecycle({ state, services, parts });
  t.after(() => {
    state._clickSubscription?.();
    lifecycle.detachViewListeners();
    input.destroy();
    picking.setClickCardHitTest(null);
    picking.unregisterPickOwner('area-control');
    picking.unregisterPickOwner('test-trails');
    picking.unregisterPickOwner('test-planes');
    picking.unregisterPickOwner('test-tracking');
    picking.unregisterPickOwner('test-exact');
  });
  await lifecycle.methods.init(viewer);
  state._enabled = true;
  state._activeCameraId = 'cam-1';
  state._recordById.set('cam-1', { camera: { id: 'cam-1' } });
  const click = (hit, cards, expected) => {
    picked = hit;
    painted = cards;
    actions.length = 0;
    input.tap();
    assert.deepEqual(actions, expected, JSON.stringify({ hit, cards }));
  };
  const drone = {
    set: 'drone-airspace:1:fills',
    id: 'drone-airspace:zone:0',
    surface: false,
  };
  const perimeter = {
    set: 'fire-perimeters:1:lines',
    id: 'fire-perimeter:incident:0',
    surface: false,
  };
  const quake = { set: 'earthquakes:1', id: 'earthquake:q1', surface: false };
  const cable = { set: 'submarine-cables:1:lines', id: 'c:0', surface: false };
  const launch = {
    set: 'launches:1:markers',
    id: 'rocket-x:1',
    surface: false,
  };
  const backgrounds = [drone, perimeter, quake, cable, launch];
  for (const area of backgrounds) {
    click(area, [ownCard], ['cam-1']);
    click(area, [], []);
    click(area, [foreignCard, ownCard], []);
  }
  // The live top card acts over anything drawn under it; with no card an
  // identified object is not empty map.
  for (const hit of [
    { set: 'flights:1', id: 'aircraft', surface: false },
    { set: '', id: 'unregistered-local-entity', surface: false },
    { ...drone, set: 'unrelated:1:fills' },
    { ...drone, id: 'unregistered-local-entity' },
  ]) {
    click(hit, [ownCard], ['cam-1']);
    click(hit, [], []);
  }
  // A trail under the live top card: the card keeps the click, and with no
  // card the owned pick is not empty map.
  const trail = { set: 'trails:1', id: 'gev-trail:fl-1:head', surface: false };
  picking.registerPickOwner('test-trails', (id) => id === trail.id);
  click(trail, [ownCard], ['cam-1']);
  click(trail, [], []);
  click(trail, [foreignCard, ownCard], []);
  picking.unregisterPickOwner('test-trails');
  // A coarse tap whose touch contact is an aircraft (a layer that acts on
  // nearby contacts) under a live CCTV card is the card's.
  const previousMatch = globalThis.matchMedia;
  const restoreMatch = () => {
    if (previousMatch) globalThis.matchMedia = previousMatch;
    else delete globalThis.matchMedia;
  };
  // Restored below for the fine-pointer clicks that follow; here too, so a
  // failing assertion cannot leave the coarse pointer for later tests.
  t.after(restoreMatch);
  globalThis.matchMedia = () => ({ matches: true });
  picking.registerPickOwner('test-planes', (id) => id === 'plane:1');
  drilled = ['plane:1'];
  click(null, [ownCard], ['cam-1']);
  // With no card, the bare tap near the aircraft still deselects.
  click(null, [], ['clear']);
  // Context accepts a registered ray inside the touch radius.
  picking.registerPickOwner('cctv', (id) =>
    ownsCctvPick(id, state._recordById, GIZMO_ID_PREFIX),
  );
  t.after(() => picking.unregisterPickOwner('cctv'));
  drilled = [
    {
      set: 'cctv:fixture',
      id: 'cctv-cam-1-ray-tl',
      meta: { cameraId: 'cam-1' },
    },
  ];
  click(null, [], ['cam-1']);
  click(null, [foreignCard], []);
  // A contact whose layer acts only on exact hits leaves the card its tap.
  picking.registerPickOwner('test-exact', (id) => id === 'exact:1');
  drilled = ['exact:1'];
  click(null, [ownCard], ['cam-1']);
  picking.unregisterPickOwner('test-exact');
  drilled = [];
  click(null, [ownCard], ['cam-1']);
  picking.unregisterPickOwner('test-planes');
  restoreMatch();
  // The live card over an aircraft takes the click; the aircraft layer,
  // run first, stands aside and does not track.
  picking.registerPickOwner('test-tracking', (id) => id === 'plane:9');
  click(
    { set: 'flights:1', id: 'plane:9', surface: false },
    [ownCard],
    ['cam-1'],
  );
  assert.equal(tracked, null, 'the aircraft did not track');
  picking.unregisterPickOwner('test-tracking');
  picking.registerPickOwner('area-control', (id) => id === drone.id);
  click(drone, [ownCard], ['cam-1']);
  picking.unregisterPickOwner('area-control');
  click(null, [foreignCard, ownCard], []);
  click(null, [ownCard], ['cam-1']);
  click(null, [], ['clear']);
  click(drone, [{ ...ownCard, entryId: 'stale-camera' }], []);
  // A card of ours that is going away is still not the scene under it: no
  // camera beneath it activates, and nothing clears.
  const staleCard = { ...ownCard, entryId: 'stale-camera' };
  click({ set: 'cctv:fixture', id: 'cam-1' }, [staleCard], []);
  click(null, [staleCard], []);
  // A camera icon under another layer's card is that card's click.
  click({ set: 'cctv:fixture', id: 'cam-1' }, [foreignCard, ownCard], []);
  click({ set: 'cctv:fixture', id: 'cam-1' }, [], ['cam-1']);
});
