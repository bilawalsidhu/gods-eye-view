import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLifecycle } from './lifecycle.js';
import { createSelection } from './selection.js';
import { CCTV_OVERLAY_SOURCE_ID } from '../../data/cctvCards.js';
import { fakeInput } from '../../input/testDoubles.mjs';
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

test('world clicks respect the painted top card and registered card backgrounds', async (t) => {
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
  // An aircraft layer that runs before ours and starts tracking the plane
  // it was clicked on, which makes that plane passive mid-click.
  let tracked = null;
  input.input.onClick((event) => {
    if (event.hit?.id === 'plane:9') tracked = 'plane:9';
  });
  const ownCard = { sourceId: CCTV_OVERLAY_SOURCE_ID, entryId: 'cam-1' };
  const foreignCard = {
    sourceId: 'earthquake-card',
    entryId: 'earthquake-card:qa',
  };
  let painted = [];
  const actions = [];
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
        hit?.set === 'cctv:fixture' ? hit.id : null,
    },
    hover: { handleHoverMove: noop },
    health: { syncHealthState: async () => {} },
    presentation: { notifyListeners: noop },
  };
  const services = {
    sprites: {},
    focus: {},
    render: {},
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
    picking.unregisterPickOwner('area-control');
    picking.unregisterPickOwner('test-trails');
    picking.unregisterPickOwner('test-planes');
    picking.unregisterPickOwner('test-tracking');
    picking.unregisterCardBackground('area-fixture');
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
  // Each of those layers registers its own shapes this way (their tests
  // check the real predicates); CCTV only asks the registry.
  picking.registerCardBackground('area-fixture', (hit) =>
    backgrounds.some((b) => b.set === hit.set && b.id === hit.id),
  );
  for (const area of backgrounds) {
    click(area, [ownCard], ['cam-1']);
    click(area, [], []);
    click(area, [foreignCard, ownCard], []);
  }
  for (const hit of [
    { set: 'flights:1', id: 'aircraft', surface: false },
    { set: '', id: 'unregistered-local-entity', surface: false },
    { set: '', id: '', surface: false },
    { ...drone, set: 'unrelated:1:fills' },
    { ...drone, id: 'unregistered-local-entity' },
  ])
    click(hit, [ownCard], []);
  // A passive owner's pick (a trail, a route) acts for nobody: the live top
  // card keeps the click, and with no card the pick is not empty map.
  const trail = { set: 'trails:1', id: 'gev-trail:fl-1:head', surface: false };
  picking.registerPickOwner('test-trails', (id) => id === trail.id, {
    passive: true,
  });
  click(trail, [ownCard], ['cam-1']);
  click(trail, [], []);
  click(trail, [foreignCard, ownCard], []);
  picking.unregisterPickOwner('test-trails');
  // A coarse tap whose touch contact is an aircraft (a layer that acts on
  // nearby contacts) is the aircraft's, even under a live CCTV card.
  const previousMatch = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  picking.registerPickOwner('test-planes', (id) => id === 'plane:1', {
    expanded: true,
  });
  drilled = ['plane:1'];
  click(null, [ownCard], []);
  // With no card, the bare tap near the aircraft still deselects.
  click(null, [], ['clear']);
  // A contact whose layer acts only on exact hits leaves the card its tap.
  picking.registerPickOwner('test-exact', (id) => id === 'exact:1');
  drilled = ['exact:1'];
  click(null, [ownCard], ['cam-1']);
  picking.unregisterPickOwner('test-exact');
  drilled = [];
  click(null, [ownCard], ['cam-1']);
  picking.unregisterPickOwner('test-planes');
  if (previousMatch) globalThis.matchMedia = previousMatch;
  else delete globalThis.matchMedia;
  // The live card reads the owners that acted when the click resolved, so it
  // yields to the aircraft even though tracking made it passive meanwhile.
  picking.registerPickOwner('test-tracking', (id) => id === 'plane:9', {
    expanded: true,
    passive: (id) => id === tracked,
  });
  click({ set: 'flights:1', id: 'plane:9', surface: false }, [ownCard], []);
  assert.equal(tracked, 'plane:9', 'the aircraft started tracking');
  picking.unregisterPickOwner('test-tracking');
  picking.registerPickOwner('area-control', (id) => id === drone.id);
  click(drone, [ownCard], []);
  picking.unregisterPickOwner('area-control');
  click(null, [foreignCard, ownCard], []);
  click(null, [ownCard], ['cam-1']);
  click(null, [], ['clear']);
  click(drone, [{ ...ownCard, entryId: 'stale-camera' }], []);
  click(
    { set: 'cctv:fixture', id: 'cam-1' },
    [foreignCard, ownCard],
    ['cam-1'],
  );
});
