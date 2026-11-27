import '../testSupport/registerDom.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPinia } from 'pinia';
import { createApp, h } from 'vue';
import * as picking from '../data/pickRegistry.js';
import { createKartaViewProvider } from '../layers/streetLevel/providers/kartaview/index.js';
import { createMapillaryProvider } from '../layers/streetLevel/providers/mapillary/index.js';
import { createStreetLevelLayer } from '../layers/streetLevel/index.js';
import {
  PHOTO_HISTORY_CAP,
  parseNearPointId,
  createPhotoHistory,
  nearPointId,
  parsePhotoId,
  photoId,
} from '../layers/streetLevel/photos.js';
import { describeEntity } from '../data/entityContext.js';
import { holdAirportPack } from '../testSupport/holdAirportPack.mjs';
import { announcePlacePick, installPlacePick } from './placePick.js';
import { installEntityContext } from './entityContextBridge.js';
import { useEntityCardStore } from './stores/entityCard.js';
import { useStreetLevelStore } from './stores/streetLevel.js';
import { presentStreetLevel } from './streetLevelPresentation.js';
import { StreetLevelControls } from './streetLevelControls.js';
import {
  placeStreetLevelViewer,
  registerStreetLevelViewerHome,
} from './streetLevelViewerPlacement.js';
import { StyleManager } from './applicationShell.js';
import StreetLevelPhotoViewer from './views/panels/StreetLevelPhotoViewer.vue';
import StreetLevelViewer from './views/panels/StreetLevelViewer.vue';
import { usePanelChromeStore } from './stores/panelChrome.js';
import { useDockedStore } from './stores/docked.js';
import { useDisplayStore } from './stores/display.js';
import { fakeInput } from '../input/testDoubles.mjs';
import * as Cesium from 'cesium';
import { createGevActionRunner, showStreetLevel } from '../voice/gevActions.js';
import { applicationPinia } from './vueRuntime.js';
import {
  STREET_LEVEL_PHOTO_EVENT,
  STREET_LEVEL_PHOTO_REQUEST_EVENT,
  streetLevelCardKey,
} from './streetLevelEvents.js';
import {
  fakeCesiumViewer,
  fakeMapillarySource,
  fakePhotoViewer,
  fakeStreetLevelProvider,
  posingStreetLevelProvider,
} from '../testSupport/streetLevelFakes.mjs';
import { initMobileShell } from './mobileShell.js';

// A street-level photo's card in Context: the layer remembers the photos
// opened, a card reads them, the bridge opens the card of each new photo
// unless something newer was picked, and a docked photo follows.

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const dockedPhoto = { identity: { id: 'mapillary:A' } };

const street = (overrides = {}) => ({
  open: true,
  providerId: 'kartaview',
  providerName: 'KartaView',
  imageId: '42',
  position: { lat: 59.33, lon: 18.06 },
  bearing: 90,
  isPano: false,
  capturedAt: Date.UTC(2024, 4, 1),
  capturedAtPrecision: 'day',
  title: 'Drottninggatan',
  still: 'https://example.org/42.jpg',
  ...overrides,
});

test('a photo id names its source and image, and splits back', () => {
  assert.equal(photoId('google', 'pano:x'), 'google:pano:x');
  assert.deepEqual(parsePhotoId('google:pano:x'), {
    providerId: 'google',
    imageId: 'pano:x',
  });
  assert.equal(parsePhotoId('nocolon'), null);
  assert.equal(parsePhotoId(':x'), null);
  assert.equal(parsePhotoId('x:'), null);
});

test('the layer remembers the photos opened, newest first, up to its cap', () => {
  const history = createPhotoHistory();
  assert.equal(history.remember(street({ open: false })), null, 'not open');
  assert.equal(history.remember(street({ position: null })), null, 'unplaced');
  const first = history.remember(street());
  assert.equal(first.id, 'kartaview:42');
  assert.equal(first.name, 'Drottninggatan');
  assert.equal(first.headingDeg, 90);
  assert.equal(first.pano, false);
  // A pose without a picture keeps the one the photo had.
  history.remember(street({ still: null, bearing: 120 }));
  assert.equal(history.get('kartaview:42').still, 'https://example.org/42.jpg');
  assert.equal(history.get('kartaview:42').headingDeg, 120);
  for (let i = 0; i < PHOTO_HISTORY_CAP + 2; i++)
    history.remember(street({ imageId: `n${i}` }));
  const list = history.list();
  assert.equal(list.length, PHOTO_HISTORY_CAP);
  assert.equal(list[0].id, `kartaview:n${PHOTO_HISTORY_CAP + 1}`);
  assert.equal(history.get('kartaview:42'), null, 'the oldest is forgotten');
});

test('a remembered photo makes a card: its road, else what it is', () => {
  const records = [
    createPhotoHistory().remember(street()),
    createPhotoHistory().remember(street({ imageId: '7', title: null })),
  ];
  const dataManager = {
    isEnabled: () => true,
    layers: new Map([
      ['street-level', { module: { getAnalystRecords: () => records } }],
    ]),
  };
  const named = describeEntity(dataManager, {
    layerId: 'street-level',
    id: 'kartaview:42',
  });
  assert.equal(named.key, 'street-level:kartaview:42');
  assert.equal(named.title, 'Drottninggatan');
  assert.equal(named.icon, 'streetview');
  assert.equal(named.lat, 59.33);
  const unnamed = describeEntity(dataManager, {
    layerId: 'street-level',
    id: 'kartaview:7',
  });
  assert.equal(unnamed.title, 'Street-level photo');
  assert.ok(unnamed.titleWords, 'translated in the card');
});

/** A layer over a fake provider whose viewer poses each image it opens. */
async function layerWithPoses(
  t,
  {
    beforePose,
    nearestImage,
    sources = ['mapillary'],
    viewer = fakeCesiumViewer(),
    afterPose,
    groundClick = false,
    keepDisplayedOnCancel = false,
    walker = null,
    billed = false,
    surface = null,
  } = {},
) {
  const providers = sources.map((id) =>
    posingStreetLevelProvider(id, {
      nearestImage,
      groundClick,
      keepDisplayedOnCancel,
      beforePose,
      afterPose,
      walker,
    }),
  );
  if (billed) for (const provider of providers) provider.billedPerImage = true;
  const layer = createStreetLevelLayer({ providers });
  viewer.canvas = viewer.scene.canvas;
  layer.init(viewer);
  layer.enable(viewer);
  layer.attachViewerHost(
    document.body.appendChild(document.createElement('div')),
    surface,
  );
  t.after(() => layer.destroy());
  await settle();
  return layer;
}

test('switching Street Level providers hides inactive history until the provider returns', async (t) => {
  const layer = await layerWithPoses(t, {
    sources: ['kartaview', 'panoramax'],
  });
  const point = { lat: 48, lon: 2 };
  layer.setProviderEnabled('kartaview', true);
  assert.equal(await layer.openImage('kartaview', 'A', { frame: false }), true);
  layer.closeViewer();
  assert.deepEqual(
    layer.getAnalystRecords().map(({ id }) => id),
    ['kartaview:A'],
  );
  const before = layer.getStats().recordsRevision;

  layer.setProviderEnabled('panoramax', true);
  assert.deepEqual(
    layer.getAnalystRecords(),
    [],
    'the place-card reader cannot see inactive stills',
  );
  assert.deepEqual(
    layer.getRecordsNear(point, 1),
    [],
    'Nearby omits unavailable photos',
  );
  assert.notEqual(
    layer.getStats().recordsRevision,
    before,
    'cached rows are invalidated',
  );
  assert.equal(await layer.openPhoto('kartaview:A'), false);

  layer.setProviderEnabled('kartaview', true);
  assert.deepEqual(
    layer.getRecordsNear(point, 1).map(({ id }) => id),
    ['kartaview:A'],
  );
  assert.equal(await layer.openPhoto('kartaview:A'), true);
});

test('Nearby reads the new remembered photo at the same point after its viewer closes', async (t) => {
  const layer = await layerWithPoses(t);
  const row = {
    id: 'street-level',
    name: 'Street Level',
    enabled: true,
    module: layer,
    get stats() {
      return layer.getStats();
    },
  };
  const manager = {
    layers: new Map([[row.id, row]]),
    isEnabled: () => true,
    getAll: () => [row],
  };
  const cards = useEntityCardStore(createPinia());
  cards.connect({ dataManager: () => manager });
  t.after(() => cards.connect(null));
  const near = () => cards.nearbyLayers(48, 2, { radiusKm: 5 })[0];
  assert.equal(near().count, 0);
  await layer.openImage('mapillary', 'A', { frame: false });
  layer.closeViewer();
  assert.deepEqual(
    near().items.map((item) => item.identity.id),
    ['mapillary:A'],
  );
});

test('the layer lists its photos while on, reopens one, and closes only the one asked', async (t) => {
  const layer = await layerWithPoses(t);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  assert.equal(await layer.openImage('mapillary', 'B', { frame: false }), true);
  assert.deepEqual(
    layer.getAnalystRecords().map((record) => record.id),
    ['mapillary:B', 'mapillary:A'],
  );
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(await layer.openPhoto('nonsense'), false);
  // A card that went away closes its own photo, never another one.
  assert.equal(layer.closePhoto('mapillary:B'), false);
  assert.equal(layer.getUIState().street.open, true);
  assert.equal(layer.closePhoto('mapillary:A'), true);
  assert.equal(layer.getUIState().street.open, false);
  // Disabling the layer releases its session pictures.
  layer.disable();
  assert.deepEqual(layer.getAnalystRecords(), []);
  assert.equal(layer.photo('mapillary:A'), null);
});

test('dismissing a card cancels its pending photo without closing a replacement', async (t) => {
  const { promise: waiting, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started();
      await gate;
    },
  });
  await layer.openPhoto('mapillary:A');
  const opening = layer.openPhoto('mapillary:B');
  await waiting;
  assert.equal(layer.getUIState().street.loading, true);
  assert.equal(layer.closePhoto('mapillary:A'), false);
  assert.equal(layer.closePhoto('mapillary:B'), true);
  release();
  assert.equal(await opening, null, 'withdrawn, not failed');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(
    await layer.openPhoto('mapillary:A'),
    true,
    'a fresh open still works',
  );
});

async function dockBilledPhoto(t, beforePose) {
  const prepared = [];
  const surface = {
    prepare: async () => {
      const state = layer.getUIState();
      prepared.push(state);
      return state.street.opening === true && state.billedPhoto === true;
    },
    isVisible: () => true,
  };
  const layer = await layerWithPoses(t, {
    beforePose,
    sources: ['google'],
    billed: true,
    surface,
  });
  assert.equal(await layer.openPhoto('google:A'), true);
  const docked = { identity: { id: 'google:A' } };
  layer.attachDockedPhoto(() => docked);
  return { layer, prepared };
}

test('an explicit billed replacement of a docked photo opens through the paid loading slot while the dock keeps the original', async (t) => {
  const { layer, prepared } = await dockBilledPhoto(t);
  assert.equal(await layer.openPhoto('google:B'), true);
  const pending = prepared.at(-1);
  assert.equal(pending.street.imageId, 'A');
  assert.equal(pending.street.opening, true);
  assert.equal(pending.billedPhoto, true);
  assert.equal(pending.dockPhotoLoading, true);
  assert.equal(layer.getUIState().street.imageId, 'B');
});

test('a billed docked original is not reopened automatically after its replacement fails', async (t) => {
  const { layer, prepared } = await dockBilledPhoto(t, (id) => {
    if (id === 'B') throw new Error('Image unavailable');
  });
  assert.equal(await layer.openPhoto('google:B'), false);
  assert.equal(prepared.length, 2);
  const state = layer.getUIState();
  assert.equal(state.street.imageId, 'A');
  assert.equal(state.dockPhotoUnavailable, true);
  assert.equal(state.dockPhotoLoading, undefined);
});

test('a saved photo from a switched-off source opens its card alongside the active dock', async (t) => {
  const opens = [];
  const layer = await layerWithPoses(t, {
    beforePose: (id) => opens.push(id),
    sources: ['kartaview', 'panoramax'],
  });
  const { store, docked, setContextOpen } = bridge(t, { streetLayer: layer });
  watchPhotos(t, layer, docked);
  setContextOpen(true);
  layer.setProviderEnabled('panoramax', true);
  assert.equal(await layer.openPhoto('panoramax:B'), true);
  const saved = { ...store.card.identity };
  layer.setProviderEnabled('kartaview', true);
  assert.equal(await layer.openPhoto('kartaview:A'), true);
  docked.dock({
    key: store.card.key,
    kind: 'street',
    title: 'A',
    identity: store.card.identity,
  });
  assert.equal(store.open(saved, { fromPin: true }), true);
  await settle();
  assert.deepEqual(opens, ['B', 'A']);
  assert.equal(store.card.identity.id, 'panoramax:B');
  assert.equal(store.fromPin, true);
  assert.equal(docked.view.identity.id, 'kartaview:A');
  assert.equal(layer.providerStatus('panoramax').on, false);

  layer.setProviderEnabled('panoramax', true);
  assert.equal(await layer.openPhoto(saved.id), true);
  assert.deepEqual(opens, ['B', 'A', 'B']);
  assert.equal(layer.settledPhotoId(), saved.id);
});

test('a docked replacement publishes its position and moves the camera only after it shows', async (t) => {
  const { promise: pose, resolve: poseReceived } = Promise.withResolvers();
  const { promise: waitForPhoto, resolve: showPhoto } = Promise.withResolvers();
  t.after(showPhoto);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    sources: ['mapillary', 'panoramax'],
    viewer,
    afterPose: async (id) => {
      if (id !== 'B') return;
      poseReceived();
      await waitForPhoto;
    },
  });
  const { store, docked, setContextOpen } = bridge(t, { streetLayer: layer });
  const published = watchPhotos(t, layer, docked);
  setContextOpen(true);
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  assert.equal(store.card?.identity.id, 'mapillary:A');
  docked.dock({
    key: store.card.key,
    kind: 'street',
    title: 'A',
    identity: store.card.identity,
  });

  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await pose;
  assert.equal(layer.getUIState().dockPhotoLoading, true);
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(
    layer.settledPhotoId(),
    null,
    'the stable dock card does not claim a live frame during replacement',
  );
  assert.equal(viewer.flights.started, 0);
  assert.equal(store.card?.identity.id, 'mapillary:A');
  assert.equal(docked.view?.identity.id, 'mapillary:A');
  assert.deepEqual(published, ['mapillary:A']);
  showPhoto();
  assert.equal(await opening, true);
  assert.deepEqual(published, ['mapillary:A', 'panoramax:B']);
  assert.equal(docked.view?.identity.id, 'panoramax:B');
  assert.equal(store.card?.identity.id, 'panoramax:B');
  assert.ok(
    layer.getAnalystRecords().every((photo) => photo.id !== 'panoramax:B'),
    'the explicit dock photo stays outside the inactive provider’s Nearby list',
  );
  assert.equal(layer.getUIState().acceptedPhoto?.id, 'panoramax:B');
  assert.equal(layer.settledPhotoId(), 'panoramax:B');
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(layer.getUIState().street.providerId, 'panoramax');
  assert.equal(layer.getUIState().street.imageId, 'B');
  assert.deepEqual(layer.getUIState().street.position, { lat: 49, lon: 2 });
  assert.equal(viewer.flights.started, 1);
});

test('cancel restores the docked photo and camera even if an old provider reports late', async (t) => {
  const { promise: pending, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started();
      await gate;
    },
    sources: ['mapillary', 'panoramax'],
    viewer,
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await pending;
  layer.cancelDockedPhoto();
  assert.equal(await opening, false);
  release();
  await settle();
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(layer.getUIState().street.providerId, 'mapillary');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(
    layer.getUIState().dockPhotoNotice,
    undefined,
    'a cancelled replacement is not reported as failed',
  );
  assert.equal(viewer.flights.started, 0);
});

test('rejection restores the original photo across providers without a camera flight', async (t) => {
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    beforePose: (id) => {
      if (id === 'B') throw new Error('The fixture could not open this photo');
    },
    sources: ['mapillary', 'panoramax'],
    viewer,
  });
  const published = watchPhotos(t, layer);
  await layer.openPhoto('mapillary:A');
  const revision = layer.getUIState().acceptedPhoto?.revision;
  layer.attachDockedPhoto(() => dockedPhoto);
  assert.equal(await layer.openPhoto('panoramax:B', { frame: true }), false);
  assert.equal(layer.getUIState().acceptedPhoto?.revision, revision);
  assert.deepEqual(published, ['mapillary:A'], 'restoring A is silent');
  assert.equal(layer.getUIState().street.providerId, 'mapillary');
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(viewer.flights.started, 0);
});

test('the restored KartaView panorama shows the heading reported by the remounted viewer', async (t) => {
  const walker = {};
  const layer = await layerWithPoses(t, {
    beforePose: (id) => {
      if (id === 'B') throw new Error('Photo unavailable');
    },
    sources: ['kartaview'],
    walker,
  });
  assert.equal(await layer.openPhoto('kartaview:A'), true);
  walker.step('A', {
    position: { lat: 48, lon: 2 },
    bearing: 100,
    isPano: true,
  });
  const heading = () =>
    presentStreetLevel(layer.getUIState()).viewer.captionRight;
  assert.equal(heading(), '360° · 100°');
  const dock = { identity: { id: 'kartaview:A' } };
  layer.attachDockedPhoto(() => dock);
  assert.equal(await layer.openPhoto('kartaview:B'), false);
  assert.equal(layer.settledPhotoId(), 'kartaview:A');
  assert.equal(heading(), '360° · 10°');
});

test('a dock restore accepts only the original presentation', async (t) => {
  const walker = {};
  let restoring = false;
  const layer = await layerWithPoses(t, {
    beforePose: (id) => {
      if (id === 'B') {
        restoring = true;
        throw new Error('The fixture could not open this photo');
      }
    },
    sources: ['mapillary'],
    walker,
    afterPose: (id) => {
      if (restoring && id === 'A') walker.step('C');
    },
  });
  const published = watchPhotos(t, layer);
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  layer.attachDockedPhoto(() => dockedPhoto);

  assert.equal(await layer.openPhoto('mapillary:B'), false);
  const state = layer.getUIState();
  assert.equal(state.acceptedPhoto, null);
  assert.equal(state.street.imageId, 'A');
  assert.deepEqual(state.street.position, { lat: 48, lon: 2 });
  assert.equal(state.dockPhotoUnavailable, true);
  assert.equal(state.dockPhotoLoading, undefined);
  assert.deepEqual(published, ['mapillary:A']);
  assert.equal(layer.photo('mapillary:C'), null);
});

test('a docked photo cannot commit after its deadline before the timer callback runs', async (t) => {
  const { promise: firstPose, resolve: reportFirstPose } =
    Promise.withResolvers();
  const { promise: loading, resolve: showPhoto } = Promise.withResolvers();
  t.after(showPhoto);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    sources: ['mapillary', 'panoramax'],
    viewer,
    afterPose: async (id) => {
      if (id !== 'B') return;
      reportFirstPose();
      await loading;
    },
  });
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  layer.attachDockedPhoto(() => dockedPhoto);
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await firstPose;
  // Advance the clock without dispatching the replacement's real timer.
  t.mock.timers.setTime(10_001);
  showPhoto();
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(layer.photo('panoramax:B'), null);
  assert.equal(viewer.flights.started, 0);
});

test('a stalled docked replacement times out and takes the original photo back', async (t) => {
  const viewer = fakeCesiumViewer();
  const never = new Promise(() => {});
  const layer = await layerWithPoses(t, {
    beforePose: (id) => (id === 'B' ? never : undefined),
    sources: ['mapillary', 'panoramax'],
    viewer,
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  assert.equal(layer.getUIState().dockPhotoLoading, true);
  t.mock.timers.tick(10_000);
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(viewer.flights.started, 0);
  // The dock says it could not load the photo, for a few seconds only.
  assert.equal(layer.getUIState().dockPhotoNotice, 'failed');
  t.mock.timers.tick(4_000);
  assert.equal(layer.getUIState().dockPhotoNotice, undefined);
});

test('a pick while the dock restores its photo is refused and says so; the failure then says it', async (t) => {
  const { promise: restoring, resolve: restoreStarted } =
    Promise.withResolvers();
  const { promise: restoreGate, resolve: releaseRestore } =
    Promise.withResolvers();
  t.after(releaseRestore);
  let opensOfA = 0;
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') throw new Error('The fixture could not open this photo');
      if (id === 'A' && ++opensOfA === 2) {
        restoreStarted();
        await restoreGate;
      }
    },
    sources: ['mapillary', 'panoramax'],
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await restoring;
  assert.equal(layer.dockedPhotoRestoring(), true);
  assert.equal(await layer.openPhoto('mapillary:C'), false);
  assert.equal(layer.getUIState().dockPhotoNotice, 'restoring');
  releaseRestore();
  assert.equal(await opening, false);
  assert.equal(layer.dockedPhotoRestoring(), false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(layer.getUIState().dockPhotoNotice, 'failed');
  // The next pick takes the word away.
  assert.equal(await layer.openPhoto('mapillary:C'), true);
  assert.equal(layer.getUIState().dockPhotoNotice, undefined);
});

test('while the dock restores its photo it says so, and Cancel cannot end the restore', async (t) => {
  const { promise: restoring, resolve: restoreStarted } =
    Promise.withResolvers();
  const { promise: restoreGate, resolve: releaseRestore } =
    Promise.withResolvers();
  t.after(releaseRestore);
  let opensOfA = 0;
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') throw new Error('The fixture could not open this photo');
      if (id === 'A' && ++opensOfA === 2) {
        restoreStarted();
        await restoreGate;
      }
    },
    sources: ['mapillary', 'panoramax'],
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  const updates = [];
  t.after(
    layer.subscribe((ui) => updates.push(ui.dockPhotoRestoring === true)),
  );
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  assert.equal(layer.getUIState().dockPhotoRestoring, undefined, 'loading B');
  await restoring;
  assert.equal(layer.getUIState().dockPhotoLoading, true);
  assert.equal(layer.getUIState().dockPhotoRestoring, true);
  layer.cancelDockedPhoto();
  await settle();
  assert.equal(
    layer.getUIState().dockPhotoRestoring,
    true,
    'the restore runs on',
  );
  assert.equal(updates.at(-1), true, 'listeners hear the restore start');
  releaseRestore();
  assert.equal(await opening, false);
  const settled = layer.getUIState();
  assert.equal(settled.dockPhotoLoading, undefined);
  assert.equal(settled.dockPhotoRestoring, undefined);
  assert.equal(settled.street.imageId, 'A');
  assert.equal(settled.dockPhotoUnavailable, undefined, 'the original is back');
});

// Show here moves the docked photo into its card: the dock lets it go, and
// DockedView cancels a replacement still loading. The original comes back
// on the card, not nothing.
test('Show here while a replacement loads cancels it and brings the original back on its card', async (t) => {
  const { promise: pending, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started();
      await gate;
    },
    sources: ['mapillary', 'panoramax'],
    viewer,
  });
  await layer.openPhoto('mapillary:A');
  let dock = dockedPhoto;
  layer.attachDockedPhoto(() => dock);
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await pending;
  // Show here: the dock closes, and DockedView cancels what it was loading.
  dock = null;
  layer.cancelDockedPhoto();
  assert.equal(await opening, false);
  release();
  await settle();
  const ui = layer.getUIState();
  assert.equal(ui.street.open, true, 'a photo is open');
  assert.equal(ui.street.providerId, 'mapillary');
  assert.equal(ui.street.imageId, 'A', 'the original');
  assert.equal(ui.street.error, null);
  assert.equal(ui.dockPhotoLoading, undefined);
  assert.equal(ui.dockPhotoUnavailable, undefined);
  assert.equal(viewer.flights.started, 0);
});

test('Show here while the original restores lets the restore finish on its card', async (t) => {
  const { promise: restoring, resolve: restoreStarted } =
    Promise.withResolvers();
  const { promise: restoreGate, resolve: releaseRestore } =
    Promise.withResolvers();
  t.after(releaseRestore);
  let opensOfA = 0;
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') throw new Error('The fixture could not open this photo');
      if (id === 'A' && ++opensOfA === 2) {
        restoreStarted();
        await restoreGate;
      }
    },
    sources: ['mapillary', 'panoramax'],
  });
  await layer.openPhoto('mapillary:A');
  let dock = dockedPhoto;
  layer.attachDockedPhoto(() => dock);
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await restoring;
  dock = null;
  layer.cancelDockedPhoto();
  releaseRestore();
  assert.equal(await opening, false);
  const ui = layer.getUIState();
  assert.equal(ui.street.open, true, 'a photo is open');
  assert.equal(ui.street.imageId, 'A', 'the original');
  assert.equal(ui.dockPhotoRestoring, undefined);
  assert.equal(
    ui.dockPhotoNotice,
    undefined,
    'no dock is left to say anything',
  );
});

// Out of the dock, a restore that cannot finish says so on the card.
test('Show here, then an original that cannot come back: the card says so', async (t) => {
  const { promise: pending, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  let opensOfA = 0;
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') {
        started();
        await gate;
      }
      if (id === 'A' && ++opensOfA === 2)
        throw new Error('The fixture could not open this photo');
    },
    sources: ['mapillary', 'panoramax'],
  });
  await layer.openPhoto('mapillary:A');
  let dock = dockedPhoto;
  layer.attachDockedPhoto(() => dock);
  const opening = layer.openPhoto('panoramax:B', { frame: true });
  await pending;
  dock = null;
  layer.cancelDockedPhoto();
  assert.equal(await opening, false);
  release();
  await settle();
  const ui = layer.getUIState();
  assert.equal(ui.dockPhotoLoading, undefined);
  assert.ok(ui.street.error, 'an error the card shows');
});

test('a pick while the street photo dock is stowed keeps its photo and card', async (t) => {
  const viewer = fakeCesiumViewer();
  const opened = [];
  const layer = await layerWithPoses(t, {
    beforePose: (id) => opened.push(id),
    sources: ['mapillary'],
    viewer,
  });
  await layer.openPhoto('mapillary:B');
  await layer.openPhoto('mapillary:A');
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  const contextViewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(contextViewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer: contextViewer,
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map([['street-level', { module: layer }]]),
      getAll: () => [],
    }),
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const docked = useDockedStore(pinia);
  const store = useEntityCardStore(pinia);
  layer.attachDockedPhoto(
    () => (docked.view?.kind === 'street' ? docked.view : null),
    () => !docked.stowed,
  );
  const original = { layerId: 'street-level', id: 'mapillary:A' };
  assert.equal(store.select(original, { reveal: false }), true);
  docked.dock({
    key: streetLevelCardKey(original.id),
    kind: 'street',
    title: 'A',
    identity: original,
  });
  const originalDock = docked.view;
  const originalCard = store.card;
  const generation = store.selectionGeneration();
  docked.setStowed(true);

  const picked = store.open({
    layerId: 'street-level',
    id: 'mapillary:B',
  });

  assert.equal(docked.view, originalDock, 'the dock still owns the original');
  assert.equal(store.card, originalCard);
  assert.equal(store.selectionGeneration(), generation);
  assert.equal(picked, false);
  await settle();
  assert.deepEqual(opened, ['B', 'A'], 'the provider was not asked again');
  docked.setStowed(false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(viewer.flights.started, 0);
});

test('a late B cannot disturb the newer C or change the dock again', async (t) => {
  const { promise: pending, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: showB } = Promise.withResolvers();
  t.after(showB);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    sources: ['mapillary'],
    viewer,
    afterPose: async (id) => {
      if (id !== 'B') return;
      started();
      await gate;
    },
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  const older = layer.openPhoto('mapillary:B', { frame: true });
  await pending;
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(await layer.openPhoto('mapillary:C', { frame: true }), true);
  showB();
  assert.equal(await older, false);
  assert.equal(layer.getUIState().street.imageId, 'C');
  assert.deepEqual(layer.getUIState().street.position, { lat: 49, lon: 2 });
  assert.equal(viewer.flights.started, 1);
});

test('a lookup that finishes after the original was docked respects the dock visibility gate', async (t) => {
  const pending = Promise.withResolvers();
  const opens = [];
  const layer = await layerWithPoses(t, {
    beforePose: (id) => opens.push(id),
    nearestImage: () => pending.promise,
  });
  await layer.openPhoto('mapillary:A');
  const opening = layer.openNearest({ lat: 49, lon: 2 });
  layer.attachDockedPhoto(
    () => dockedPhoto,
    () => false,
  );
  pending.resolve('B');
  assert.equal(await opening, false);
  assert.deepEqual(opens, ['A']);
  assert.equal(layer.getUIState().street.imageId, 'A');
});

test('an empty docked lookup leaves the intact viewer alone and reports the attempted result', async (t) => {
  let photoOpens = 0;
  const layer = await layerWithPoses(t, {
    beforePose: () => {
      photoOpens++;
    },
    nearestImage: async () => null,
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  let failure;
  assert.equal(
    await layer.openNearest(
      { lat: 49, lon: 2 },
      {
        providerIds: ['mapillary'],
        onDockedFailure: (state) => {
          failure = state;
        },
      },
    ),
    false,
  );
  assert.equal(failure.nearestOutcome, 'empty');
  assert.equal(photoOpens, 1);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
});

test('switching sources during a lookup keeps the docked still without reopening the disabled source', async (t) => {
  const { promise: looking, resolve: startLookup } = Promise.withResolvers();
  const { promise: result, resolve: finishLookup } = Promise.withResolvers();
  t.after(() => finishLookup(null));
  const opens = [];
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    beforePose: (id) => opens.push(id),
    nearestImage: async () => {
      startLookup();
      return result;
    },
    sources: ['mapillary', 'panoramax'],
    viewer,
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  const opening = layer.openNearest(
    { lat: 49, lon: 2 },
    { providerIds: ['mapillary'] },
  );
  await looking;
  layer.setProviderEnabled('panoramax', true);
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(layer.getUIState().dockPhotoUnavailable, true);
  assert.equal(viewer.flights.started, 0);
  assert.deepEqual(opens, ['A']);
});

test('a replacement cannot take the camera while the dock is hidden', async (t) => {
  const { promise: posed, resolve: ready } = Promise.withResolvers();
  const { promise: wait, resolve: finish } = Promise.withResolvers();
  t.after(finish);
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    sources: ['mapillary'],
    viewer,
    afterPose: async (id) => {
      if (id !== 'B') return;
      ready();
      await wait;
    },
  });
  await layer.openPhoto('mapillary:A');
  let visible = true;
  layer.attachDockedPhoto(
    () => dockedPhoto,
    () => visible,
  );
  const opening = layer.openPhoto('mapillary:B', { frame: true });
  await posed;
  visible = false;
  finish();
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(viewer.flights.started, 0);
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
});

test('an unavailable original ends the recovery deadline with its last known identity', async (t) => {
  let loseProvider = false;
  const never = new Promise(() => {});
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, {
    beforePose: () => (loseProvider ? never : undefined),
    sources: ['mapillary'],
    viewer,
  });
  await layer.openPhoto('mapillary:A');
  layer.attachDockedPhoto(() => dockedPhoto);
  loseProvider = true;
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'] });
  const opening = layer.openPhoto('mapillary:B', { frame: true });
  t.mock.timers.tick(10_000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(4_000);
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(layer.getUIState().dockPhotoUnavailable, true);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.deepEqual(layer.getUIState().street.position, { lat: 48, lon: 2 });
  assert.equal(
    layer.settledPhotoId(),
    null,
    'a docked photo that could not be restored is not settled',
  );
  assert.equal(viewer.flights.started, 0);

  assert.equal(
    await layer.openNearest(
      { lat: 49, lon: 2 },
      { providerIds: ['mapillary'] },
    ),
    false,
  );
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
  assert.equal(layer.getUIState().dockPhotoUnavailable, true);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(viewer.flights.started, 0);
});

test('a dismissed Nearby street card cancels its lookup', async (t) => {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const layer = await layerWithPoses(t, {
    nearestImage: async () => {
      await gate;
      return 'A';
    },
  });
  const id = nearPointId('mapillary', { lat: 48, lon: 2 });
  const opening = layer.openPhoto(id);
  assert.equal(layer.getUIState().street.loading, true);
  assert.equal(layer.closePhoto(id), true);
  release();
  assert.equal(await opening, null, 'withdrawn, not failed');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().street.loading, false);
});

test('dismissing the shown photo closes it during an unrelated lookup', async (t) => {
  const { promise, resolve } = Promise.withResolvers();
  t.after(() => resolve('B'));
  const layer = await layerWithPoses(t, { nearestImage: () => promise });
  await layer.openPhoto('mapillary:A');
  const lookup = layer.openNearest({ lat: 48, lon: 2 });
  assert.equal(layer.getUIState().street.loading, true);
  assert.equal(layer.closePhoto('mapillary:A', { pendingOnly: true }), false);
  assert.equal(layer.getUIState().street.open, true);

  assert.equal(layer.closePhoto('mapillary:A'), true);
  assert.equal(layer.getUIState().street.open, false);
  resolve('B');
  assert.equal(await lookup, false);
  assert.equal(layer.getUIState().street.open, false);
});

test('a newer empty lookup withdraws an older loading photo', async (t) => {
  const started = Promise.withResolvers();
  const ready = Promise.withResolvers();
  t.after(ready.resolve);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started.resolve();
      await ready.promise;
    },
    nearestImage: async () => null,
  });
  await layer.openPhoto('mapillary:A');
  const opening = layer.openImage('mapillary', 'B', { frame: false });
  await started.promise;
  await layer.openNearest({ lat: 48, lon: 2 });

  assert.equal(layer.closePhoto('mapillary:A'), false);
  ready.resolve();
  assert.equal(await opening, false);
  assert.notEqual(layer.getUIState().street.imageId, 'B');
  assert.ok(layer.getUIState().street.error);
});

test('dismissing the displayed card withdraws a pending sequence step', async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(gate.resolve);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started.resolve();
      await gate.promise;
    },
  });
  assert.ok(await layer.openPhoto('mapillary:A'));
  const step = layer.openImage('mapillary', 'B', {
    frame: false,
    request: false,
  });
  await started.promise;
  assert.equal(layer.settledPhotoId(), 'mapillary:A');
  assert.equal(layer.closePhoto('mapillary:A'), true);
  gate.resolve();
  assert.equal(await step, false);
  assert.equal(layer.settledPhotoId(), null);
  assert.equal(layer.getUIState().street.open, false);
});

test('an empty line lookup cancels a pending card load and keeps its prior frame', async (t) => {
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  t.after(gate.resolve);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started.resolve();
      await gate.promise;
    },
    nearestImage: async () => null,
    sources: ['kartaview'],
    keepDisplayedOnCancel: true,
  });
  assert.ok(await layer.openPhoto('kartaview:A'));
  const pending = layer.openPhoto('kartaview:B');
  await started.promise;
  assert.equal(
    await layer.openNearest({ lat: 48, lon: 2 }, { sequenceId: 'S' }),
    false,
  );
  gate.resolve();
  assert.equal(await pending, null);
  assert.equal(layer.settledPhotoId(), 'kartaview:A');
});

test('a newer card can cancel a pending lookup and keep the photo already shown', async (t) => {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(release);
  const layer = await layerWithPoses(t, {
    nearestImage: async () => {
      await gate;
      return 'B';
    },
  });
  await layer.openPhoto('mapillary:A');
  const near = nearPointId('mapillary', { lat: 48, lon: 2 });
  const opening = layer.openPhoto(near);
  assert.equal(layer.closePhoto(near, { pendingOnly: true }), true);
  release();
  assert.equal(await opening, null, 'withdrawn, not failed');
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(layer.getUIState().street.open, true);
  assert.equal(layer.closePhoto('mapillary:A', { pendingOnly: true }), false);
});

test('another pick withdraws every photo request and closes the photo, with or without a card', async (t) => {
  const lookups = [];
  t.after(() => lookups.forEach((lookup) => lookup.resolve('B')));
  const layer = await layerWithPoses(t, {
    nearestImage: () => {
      const lookup = Promise.withResolvers();
      lookups.push(lookup);
      return lookup.promise;
    },
  });
  assert.equal(layer.withdrawPhoto(), false, 'nothing to close');
  // A photo opened from the map, which no card shows, closes.
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  assert.equal(layer.withdrawPhoto(), true);
  assert.equal(layer.settledPhotoId(), null);
  assert.equal(layer.getUIState().street.open, false);
  // A map lookup in flight is withdrawn: nothing opens when it answers.
  const passive = layer.openNearest({ lat: 48, lon: 2 }, { frame: false });
  assert.equal(layer.withdrawPhoto(), true);
  lookups[0].resolve('B');
  assert.equal(await passive, false);
  // So is a card's Nearby lookup, and the card says nothing about it.
  const card = layer.openPhoto(nearPointId('mapillary', { lat: 48, lon: 2 }));
  assert.equal(layer.withdrawPhoto(), true);
  lookups[1].resolve('B');
  assert.equal(await card, null, 'withdrawn, not failed');
  assert.equal(layer.settledPhotoId(), null);
  assert.equal(layer.getUIState().street.loading, false);
  assert.deepEqual(
    layer.getAnalystRecords().map((photo) => photo.id),
    ['mapillary:A'],
    'B is never listed',
  );
});

test('a new map lookup takes over from a card whose photo is loading', async (t) => {
  const { promise: photoGate, resolve: releasePhoto } = Promise.withResolvers();
  const { promise: lookupGate, resolve: releaseLookup } =
    Promise.withResolvers();
  const { promise: startedPhoto, resolve: started } = Promise.withResolvers();
  t.after(releasePhoto);
  t.after(releaseLookup);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'B') return;
      started();
      await photoGate;
    },
    nearestImage: async () => {
      await lookupGate;
      return 'C';
    },
  });
  const old = layer.openPhoto('mapillary:B');
  await startedPhoto;
  const next = layer.openNearest({ lat: 48, lon: 2 }, { frame: false });
  assert.equal(
    layer.closePhoto('mapillary:B'),
    false,
    'the old card cannot cancel the new lookup',
  );
  releasePhoto();
  assert.equal(await old, null, 'withdrawn, not failed');
  assert.equal(
    layer.getUIState().street.loading,
    true,
    'the new lookup still owns loading',
  );
  releaseLookup();
  assert.equal(await next, true);
  assert.equal(layer.getUIState().street.imageId, 'C');
});

/**
 * The bridge on a page with the real card store: a Street Level layer that
 * remembers photos A, B and C, a flight to pick, and Context's rail button,
 * whose clicks count the times Context was opened.
 */
function bridge(
  t,
  { streetLayer = null, exitContextSelectionView, contextSelectionCover } = {},
) {
  const previous = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  document.body.replaceChildren();
  const rail = document.body.appendChild(document.createElement('nav'));
  rail.className = 'ui-rail--right';
  const button = rail.appendChild(document.createElement('button'));
  button.className = 'ui-rail__item';
  button.dataset.railItem = 'global-context-panel';
  button.setAttribute('aria-pressed', 'false');
  let opened = 0;
  button.addEventListener('click', () => opened++);
  const photos = createPhotoHistory();
  for (const imageId of ['A', 'B', 'C'])
    photos.remember(street({ providerId: 'mapillary', imageId }));
  const flights = [
    {
      id: 'abc123',
      icao24: 'abc123',
      callsign: 'ABC123',
      lat: 59.3,
      lon: 18.1,
      altitudeM: 2500,
    },
  ];
  const viewer = { scene: { pick: () => null, drillPick: () => [] } };
  const input = fakeInput(viewer);
  const pinia = createPinia();
  const disconnect = installEntityContext({
    viewer,
    exitContextSelectionView,
    revealContext: () => {
      if (document.body.classList.contains('mobile-shell'))
        document.body.setAttribute('data-mobile-sheet', 'context');
    },
    getDataManager: () => ({
      isEnabled: () => true,
      layers: new Map([
        [
          'street-level',
          {
            module: streetLayer ?? {
              getAnalystRecords: () => photos.list(),
              photo: (id) => photos.get(id),
            },
          },
        ],
        ['flights', { module: { getAnalystRecords: () => flights } }],
      ]),
      getAll: () => [],
    }),
    pinia,
  });
  t.after(() => {
    disconnect();
    input.destroy();
    document.body.replaceChildren();
    if (previous) globalThis.matchMedia = previous;
    else delete globalThis.matchMedia;
  });
  const store = useEntityCardStore(pinia);
  let nextRequestId = 0;
  let pendingRequestId = null;
  const request = () => {
    pendingRequestId = ++nextRequestId;
    document.dispatchEvent(
      new CustomEvent(STREET_LEVEL_PHOTO_REQUEST_EVENT, {
        detail: {
          requestId: pendingRequestId,
          cover: contextSelectionCover?.(),
        },
      }),
    );
  };
  const announce = (imageId, explicit = false, cardPhotoId = null) => {
    const requestId = pendingRequestId;
    pendingRequestId = null;
    document.dispatchEvent(
      new CustomEvent(STREET_LEVEL_PHOTO_EVENT, {
        detail: {
          layerId: 'street-level',
          id: `mapillary:${imageId}`,
          requestId,
          cardPhotoId,
          ...(explicit ? { explicit: true } : {}),
          lat: 59.33,
          lon: 18.06,
        },
      }),
    );
  };
  // Context's open state, as the rail button and the panel chrome show it.
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  const setContextOpen = (open) => {
    chrome.publish(owner, 'global-context-panel', { collapsed: !open });
    button.setAttribute('aria-pressed', String(open));
  };
  setContextOpen(false);
  return {
    pinia,
    store,
    docked: useDockedStore(pinia),
    request,
    announce,
    opened: () => opened,
    button,
    setContextOpen,
  };
}

async function lineClickFixture(t, provider, lineId) {
  document.body.replaceChildren();
  t.mock.method(
    Cesium.GroundPolylinePrimitive,
    'initializeTerrainHeights',
    async () => {},
  );
  const viewer = fakeCesiumViewer({ view: true });
  const pick = { id: { set: 'street-level:coverage', id: lineId } };
  viewer.scene.pick = () => pick;
  viewer.scene.drillPick = () => [pick];
  const input = fakeInput(viewer);
  const layer = createStreetLevelLayer({
    providers: [provider],
    services: { picking },
  });
  const dataManager = {
    layers: new Map([['street-level', { module: layer }]]),
    isEnabled: () => true,
    getAll: () => [],
  };
  const pinia = applicationPinia();
  const app = createApp({
    render: () => [h(StreetLevelViewer), h(StreetLevelPhotoViewer)],
  }).use(pinia);
  app.mount(document.body.appendChild(document.createElement('div')));
  const chrome = usePanelChromeStore(pinia);
  const owner = chrome.connect({});
  chrome.publish(owner, 'global-context-panel', { collapsed: false });
  const cards = useEntityCardStore(pinia);
  cards.clear();
  const disconnect = installEntityContext({
    viewer,
    getDataManager: () => dataManager,
    pinia,
  });
  const shell = {
    services: { streetLevelLayer: layer },
    _dataManager: dataManager,
    _streetLevelViewer: document.getElementById('sl-viewer-root'),
  };
  layer.init(viewer);
  layer.enable(viewer);
  layer.setProviderEnabled(provider.id, true);
  StyleManager.prototype._initStreetLevelControls.call(shell);
  t.after(() => {
    shell._streetLevelControls.destroy();
    shell._streetLevelPhotoUnsubscribe?.();
    disconnect();
    layer.destroy();
    input.destroy();
    chrome.detach(owner);
    app.unmount();
  });
  await settle();

  assert.equal(picking.findPickOwner(lineId), 'street-level');
  return { cards, click: () => input.click({ x: 50, y: 50 }) };
}

test('a Mapillary line click only selects Context after its provider returns a photo', async (t) => {
  const result = Promise.withResolvers();
  const requested = [];
  const source = fakeMapillarySource({
    nearestImages(point) {
      requested.push(point);
      return result.promise;
    },
  });
  const provider = createMapillaryProvider({
    source,
    photoViewer: fakePhotoViewer({
      pose: { position: { lat: 38.58, lon: -121.49 } },
    }),
  });
  const { cards, click } = await lineClickFixture(t, provider, 'mly:seq:S');
  click();
  assert.equal(requested.length, 1);
  assert.equal(cards.card, null);
  result.resolve([
    {
      id: 'A',
      sequence: 'S',
      captured_at: Date.now(),
      geometry: {
        type: 'Point',
        coordinates: [requested[0].lon, requested[0].lat],
      },
    },
  ]);
  await settle();
  assert.equal(cards.card?.key, streetLevelCardKey('mapillary:A'));
});

test(
  'a KartaView coverage line opens only its resolved photo in Context',
  { timeout: 3000 },
  async (t) => {
    const result = Promise.withResolvers();
    const requested = [];
    const provider = createKartaViewProvider({
      source: {
        getTile: async () => ({ lines: [] }),
        nearestPhotos(point) {
          requested.push(point);
          return result.promise;
        },
        probeImage: async () => true,
        getSequencePhotos: async () => ({ photos: [], hasMore: false }),
      },
      viewerOptions: {
        load: async () => ({
          src: 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==',
        }),
      },
    });
    const { cards, click } = await lineClickFixture(t, provider, 'kv:line:1');
    const selected = t.mock.method(cards, 'select');
    const photo = Promise.withResolvers();
    document.addEventListener(STREET_LEVEL_PHOTO_EVENT, photo.resolve, {
      once: true,
    });
    t.after(() =>
      document.removeEventListener(STREET_LEVEL_PHOTO_EVENT, photo.resolve),
    );
    click();
    await settle();
    assert.equal(requested.length, 1);
    assert.equal(selected.mock.callCount(), 0);
    assert.equal(cards.card, null);
    result.resolve([
      {
        id: '42',
        lat: requested[0].lat,
        lng: requested[0].lon,
        projection: 'PLANE',
        storage: 'storage2',
        filepathProc: '2025/1/2/proc/42.jpg',
      },
    ]);
    await photo.promise;
    assert.deepEqual(
      selected.mock.calls.map((call) => call.arguments[0].id),
      ['kartaview:42'],
    );
    assert.equal(cards.card?.key, streetLevelCardKey('kartaview:42'));
  },
);

test('a photo pick reveals Context and selects the accepted photo', (t) => {
  const { store, request, announce, opened } = bridge(t);
  request();
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  assert.equal(opened(), 1, 'the rail button opens Context');
});

test('a photo asked for while Context is open shows its card; the photo on show is left as it is', (t) => {
  const { store, request, announce, opened, setContextOpen } = bridge(t);
  setContextOpen(true);
  request();
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  assert.equal(opened(), 0, 'Context was already open');
  const generation = store.selectionGeneration();
  announce('A');
  assert.equal(
    store.selectionGeneration(),
    generation,
    'the photo on show is left as it is',
  );
});

test('a new photo pick opens the Context sheet on a phone', (t) => {
  const { store, request, announce, setContextOpen } = bridge(t);
  const body = document.body;
  t.after(() => {
    body.classList.remove('mobile-shell');
    body.removeAttribute('data-mobile-sheet');
  });
  setContextOpen(true);
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'layers');
  request();
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  assert.equal(body.getAttribute('data-mobile-sheet'), 'context');
});

test('a walk step moves the photo card along without counting as a new pick', (t) => {
  const { store, request, announce, setContextOpen } = bridge(t);
  setContextOpen(true);
  request();
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  const generation = store.selectionGeneration();
  // The viewer steps on (arrows, PLAY): no new request.
  announce('B');
  announce('C');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:C'));
  assert.equal(
    store.selectionGeneration(),
    generation,
    'a search or voice request waiting on the selection is not cancelled',
  );
});

test('a photo that loads late does not replace a street card picked after its request', (t) => {
  const { store, request, announce, setContextOpen } = bridge(t);
  setContextOpen(true);
  // A line's lookup starts; meanwhile photo A is picked from Nearby.
  request();
  assert.equal(
    store.select({ layerId: 'street-level', id: 'mapillary:A' }),
    true,
  );
  announce('C');
  assert.equal(
    store.card?.key,
    streetLevelCardKey('mapillary:A'),
    'the newer pick stays',
  );
  // A PLAY step from the old frame cannot take the newly selected card.
  announce('B');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  // Once the viewer confirms A, its next step belongs to A's card.
  request();
  announce('A', false, 'mapillary:A');
  announce('B');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:B'));
});

test('a fresh photo request starts a selection; a covered rail ignores a passive result', (t) => {
  const { store, request, announce, setContextOpen } = bridge(t);
  setContextOpen(true);
  request();
  announce('A');
  const generation = store.selectionGeneration();
  request();
  announce('B');
  assert.equal(store.selectionGeneration(), generation + 1);
  document.body.classList.add('ui-clean-view');
  t.after(() => document.body.classList.remove('ui-clean-view'));
  request();
  announce('C');
  assert.equal(store.card.key, streetLevelCardKey('mapillary:B'));
});

test('a place lookup and a photo pick yield to whichever started later', async (t) => {
  const { pinia, store, request, announce, setContextOpen } = bridge(t);
  t.after(installPlacePick({ pinia }));
  const pack = holdAirportPack(t, []);
  const pickPlace = () =>
    announcePlacePick({
      name: 'Test district',
      latitude: 48,
      longitude: 2,
    });

  setContextOpen(true);
  pickPlace();
  request();
  pack.release();
  await settle();
  assert.equal(store.card, null, 'the older place does not replace the card');
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));

  request();
  pickPlace();
  announce('B');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  await settle();
  assert.equal(store.card?.title, 'Test district');
});

test('a reselected photo adopts its own completion and advances under another phone sheet', (t) => {
  const { store, request, announce, opened, setContextOpen } = bridge(t);
  const body = document.body;
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'context');
  t.after(() => {
    body.classList.remove('mobile-shell');
    body.removeAttribute('data-mobile-sheet');
  });
  setContextOpen(true);
  const photo = { layerId: 'street-level', id: 'mapillary:A' };
  assert.ok(store.select(photo));
  request();
  assert.ok(store.select(photo));
  const opens = opened();
  body.setAttribute('data-mobile-sheet', 'layers');
  announce('A', false, 'mapillary:A');
  announce('B');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:B'));
  request();
  announce('C', false, 'mapillary:B');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:C'));
  assert.equal(opened(), opens);
  assert.equal(body.getAttribute('data-mobile-sheet'), 'layers');
});

test('a valid pick leaves Clean View and brings even its existing card forward', (t) => {
  const shell = {
    setCleanView: StyleManager.prototype.setCleanView,
    toggleCleanView: StyleManager.prototype.toggleCleanView,
    contextSelectionCover: StyleManager.prototype.contextSelectionCover,
    _scheduleLeftPanelLayout() {},
  };
  const { store, request, announce, setContextOpen } = bridge(t, {
    exitContextSelectionView: (cover) =>
      StyleManager.prototype.exitContextSelectionView.call(shell, cover),
    contextSelectionCover: () => shell.contextSelectionCover(),
  });
  const body = document.body;
  t.after(() => {
    body.classList.remove('ui-clean-view');
  });
  setContextOpen(true);
  const photo = { layerId: 'street-level', id: 'mapillary:A' };
  assert.ok(store.select(photo));
  body.classList.add('ui-clean-view');
  assert.equal(store.select({ layerId: 'street-level', id: 'absent' }), false);
  assert.equal(body.classList.contains('ui-clean-view'), true);
  assert.ok(store.select(photo));
  assert.equal(body.classList.contains('ui-clean-view'), false);

  request();
  shell.toggleCleanView(true);
  announce('B');
  assert.equal(body.classList.contains('ui-clean-view'), true);
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));

  request();
  announce('B');
  assert.equal(body.classList.contains('ui-clean-view'), false);
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:B'));
});

test('a photo that loads late does not replace a newer flight card', (t) => {
  const { store, request, announce, setContextOpen } = bridge(t);
  setContextOpen(true);
  request();
  // A flight is picked while the photo still loads.
  assert.equal(store.select({ layerId: 'flights', id: 'abc123' }), true);
  const flightKey = store.card?.key;
  assert.ok(flightKey?.startsWith('flights:'));
  announce('A');
  assert.equal(store.card?.key, flightKey, "the flight's card stays");
});

test('explicitly opening Street Level shows its settled photo only on the visible Context surface', (t) => {
  const { store, announce, opened, setContextOpen } = bridge(t);
  store.select({ layerId: 'flights', id: 'abc123' }, { reveal: false });
  const priorOpens = opened();
  announce('A', true);
  assert.equal(store.card?.key, 'flights:abc123');
  assert.equal(opened(), priorOpens);

  setContextOpen(true);
  announce('A', true);
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  assert.equal(
    opened(),
    priorOpens,
    'the photo event never opens Context by itself',
  );
});

test('a walk through the photo moves its card along, leaving a collapsed Context collapsed', (t) => {
  const { store, request, announce, opened, setContextOpen } = bridge(t);
  setContextOpen(true);
  request();
  announce('A');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:A'));
  // Context is collapsed now; the viewer steps on (arrows, PLAY).
  setContextOpen(false);
  announce('B');
  announce('C');
  assert.equal(store.card?.key, streetLevelCardKey('mapillary:C'));
  assert.equal(opened(), 0, 'stepping never reopens Context');
});

test('the Street Level viewer reports the request and settled photo without revealing Context', async (t) => {
  const { promise: waiting, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  // B's viewer reports its pose, then holds the load open.
  const layer = await layerWithPoses(t, {
    sources: ['mapillary'],
    afterPose: async (id) => {
      if (id !== 'B') return;
      started();
      await gate;
    },
  });
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StreetLevelViewer);
  const pinia = createPinia();
  app.use(pinia);
  app.mount(host);
  const events = [];
  const controls = new StreetLevelControls({
    root: document.getElementById('sl-viewer-root'),
    layer,
    store: useStreetLevelStore(pinia),
    actions: {
      isEnabled: () => true,
      setEnabled() {},
      setParams() {},
      showToast() {},
      revealPanel: () => events.push('reveal'),
      photoRequested: () => events.push('request'),
      showPhoto: (photo) => events.push(`photo ${photo.id}`),
    },
  });
  controls.connect();
  t.after(() => {
    controls.destroy?.();
    app.unmount();
  });
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  await settle();
  assert.deepEqual(events, ['request', 'photo mapillary:A']);
  // Until B has finished loading, only its request is reported.
  const opening = layer.openPhoto('mapillary:B');
  await waiting;
  await settle();
  assert.equal(layer.getUIState().street.loading, true);
  assert.deepEqual(events, ['request', 'photo mapillary:A', 'request']);
  release();
  assert.equal(await opening, true);
  await settle();
  assert.deepEqual(events, [
    'request',
    'photo mapillary:A',
    'request',
    'photo mapillary:B',
  ]);
});

test('two coverage sequences that meet at one point get their own Nearby rows', async (t) => {
  const point = { lat: 48.8566, lon: 2.3522 };
  const a = nearPointId('mapillary', { ...point, sequenceId: 'seq-a' });
  const b = nearPointId('mapillary', { ...point, sequenceId: 'seq-b' });
  assert.notEqual(a, b);
  assert.deepEqual(parseNearPointId(b), {
    providerId: 'mapillary',
    point,
    sequenceId: 'seq-b',
  });
  assert.equal(
    parseNearPointId(nearPointId('mapillary', point)).sequenceId,
    null,
  );
  assert.equal(parseNearPointId('near:mapillary'), null);
  // The layer keys each line it lists by its sequence.
  const provider = fakeStreetLevelProvider({ id: 'mapillary' });
  const create = provider.create;
  provider.create = (context) => ({
    ...create(context),
    coverageNear: () =>
      ['seq-a', 'seq-b'].map((sequenceId) => ({
        sequenceId,
        ...point,
        km: 0.01,
        capturedAt: 0,
        isPano: false,
      })),
  });
  const viewer = fakeCesiumViewer();
  const layer = createStreetLevelLayer({ providers: [provider] });
  viewer.canvas = viewer.scene.canvas;
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy());
  await settle();
  const ids = layer.getRecordsNear(point, 1).map((record) => record.id);
  assert.deepEqual(ids, [a, b]);
});

test('a lookup given up while its photo loads publishes no photo and opens no card', async (t) => {
  const { promise: waiting, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  // The lookup finds A; the viewer holds A's load until released, then poses.
  const layer = await layerWithPoses(t, {
    beforePose: async () => {
      started();
      await gate;
    },
    nearestImage: async () => 'A',
  });
  const photos = watchPhotos(t, layer);
  let wanted = true;
  const opening = layer.openNearest(
    { lat: 48, lon: 2 },
    { providerIds: ['mapillary'], frame: false, proceed: () => wanted },
  );
  await waiting;
  // The camera is taken (a newer navigation) while A loads.
  wanted = false;
  release();
  assert.equal(await opening, false);
  await settle();
  assert.deepEqual(photos, [], 'no photo event for the stale image');
  assert.equal(layer.getUIState().street.open, false, 'the photo is closed');
  assert.equal(layer.photo('mapillary:A'), null, 'nor is it in the history');
  // An accepted photo still reaches Nearby; the withdrawn one never does.
  wanted = true;
  assert.equal(await layer.openPhoto('mapillary:B'), true);
  const nearby = layer
    .getRecordsNear({ lat: 48.5, lon: 2 }, 100)
    .map((record) => record.id);
  assert.ok(nearby.includes('mapillary:B'), 'the accepted photo is listed');
  assert.ok(!nearby.includes('mapillary:A'), 'the withdrawn photo is not');
});

test('a lookup given up after its photo first posed keeps that photo out of Nearby', async (t) => {
  const { promise: firstPose, resolve: posed } = Promise.withResolvers();
  const { promise: loaded, resolve: finish } = Promise.withResolvers();
  t.after(() => finish());
  // A's viewer reports its first pose, then keeps loading until released.
  const layer = await layerWithPoses(t, {
    nearestImage: async () => 'A',
    sources: ['mapillary'],
    afterPose: async (id) => {
      if (id !== 'A') return;
      posed();
      await loaded;
    },
  });
  let wanted = true;
  const opening = layer.openNearest(
    { lat: 48, lon: 2 },
    { providerIds: ['mapillary'], frame: false, proceed: () => wanted },
  );
  await firstPose;
  assert.equal(layer.getUIState().street.loading, true);
  // The camera is taken after the first pose, before the load ends.
  wanted = false;
  finish();
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.open, false);
  // An accepted photo still reaches Nearby; the withdrawn one never does.
  assert.equal(await layer.openPhoto('mapillary:B'), true);
  const nearby = layer
    .getRecordsNear({ lat: 48.5, lon: 2 }, 100)
    .map((record) => record.id);
  assert.ok(nearby.includes('mapillary:B'), 'the accepted photo is listed');
  assert.ok(!nearby.includes('mapillary:A'), 'the withdrawn photo is not');
});

/** The photos the real Street Level viewer announces for `layer`. */
function watchPhotos(t, layer, docked = null) {
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StreetLevelViewer);
  const pinia = createPinia();
  app.use(pinia);
  app.mount(host);
  const photos = [];
  const controls = new StreetLevelControls({
    root: document.getElementById('sl-viewer-root'),
    layer,
    store: useStreetLevelStore(pinia),
    actions: {
      isEnabled: () => true,
      setEnabled() {},
      setParams() {},
      showToast() {},
      dockedPhoto: () => docked?.view,
      dockedPhotoCanPresent: () => !docked?.stowed,
      photoRequested(requestId) {
        if (docked)
          document.dispatchEvent(
            new CustomEvent(STREET_LEVEL_PHOTO_REQUEST_EVENT, {
              detail: { requestId },
            }),
          );
      },
      showPhoto(photo) {
        photos.push(photo.id);
        if (docked)
          document.dispatchEvent(
            new CustomEvent(STREET_LEVEL_PHOTO_EVENT, { detail: photo }),
          );
      },
    },
  });
  controls.connect();
  t.after(() => {
    controls.destroy?.();
    app.unmount();
  });
  return photos;
}

test('a restored photo is accepted before its caller decides whether to reveal Context', async (t) => {
  const layer = await layerWithPoses(t, { nearestImage: async () => 'A' });
  const { store, docked, opened } = bridge(t, { streetLayer: layer });
  const photos = watchPhotos(t, layer, docked);
  assert.ok(
    await layer.openNearest(
      { lat: 48, lon: 2 },
      { frame: false, origin: 'programmatic' },
    ),
  );
  await settle();
  assert.deepEqual(photos, ['mapillary:A']);
  assert.equal(store.card, null);
  assert.equal(opened(), 0);
});

test('an empty lookup leaves the accepted photo silent, while an explicit reopen announces it again', async (t) => {
  const layer = await layerWithPoses(t, { nearestImage: async () => null });
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  await settle();
  assert.equal(
    await layer.openNearest({ lat: 48, lon: 2 }, { frame: false }),
    false,
  );
  await settle();
  assert.deepEqual(photos, ['mapillary:A']);
  assert.equal(layer.getUIState().street.imageId, 'A');

  assert.equal(await layer.openPhoto('mapillary:A'), true);
  await settle();
  assert.deepEqual(photos, ['mapillary:A', 'mapillary:A']);
});

test('two overlapping rejections leave the accepted photo dismissible', async (t) => {
  const { promise: entered, resolve: entering } = Promise.withResolvers();
  const { promise: gate, resolve: finish } = Promise.withResolvers();
  t.after(finish);
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') {
        entering();
        await gate;
      }
      if (id !== 'A') throw new Error('Image could not be opened');
    },
  });
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  const original = layer.getUIState().acceptedPhoto;
  const opening = layer.openImage('mapillary', 'B', { frame: false });
  await entered;
  assert.equal(
    await layer.openImage('mapillary', 'C', { frame: false }),
    false,
  );
  finish();
  assert.equal(await opening, false);
  await settle();

  const { acceptedPhoto, street } = layer.getUIState();
  assert.deepEqual(acceptedPhoto, original);
  assert.equal(street.imageId, 'A');
  assert.deepEqual(street.position, { lat: original.lat, lon: original.lon });
  assert.deepEqual(photos, ['mapillary:A']);
  assert.equal(layer.closePhoto('mapillary:A'), true);
  assert.equal(layer.getUIState().acceptedPhoto, null);
});

test('a native step to another accepted photo clears the failed open error', async (t) => {
  const walker = {};
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') throw new Error('Image could not be opened');
    },
    sources: ['mapillary'],
    walker,
  });
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  assert.equal(
    await layer.openImage('mapillary', 'B', { frame: false }),
    false,
  );
  const failure = layer.getUIState().street.error;
  assert.match(failure, /could not be opened/);

  walker.step('A');
  assert.equal(layer.getUIState().street.error, failure);
  walker.step('C');
  assert.equal(layer.getUIState().street.error, null);
  await settle();
  assert.deepEqual(photos, ['mapillary:A', 'mapillary:C']);
});

test('a rejected open does not retain a frame the viewer reports lost', async (t) => {
  const walker = {};
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'A') return;
      walker.loseFrame();
      throw new Error('Image could not be opened');
    },
    sources: ['mapillary'],
    walker,
  });
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  assert.equal(
    await layer.openImage('mapillary', 'B', { frame: false }),
    false,
  );
  await settle();
  const { acceptedPhoto, street } = layer.getUIState();
  assert.equal(acceptedPhoto, null);
  assert.equal(street.imageId, null);
  assert.deepEqual(photos, ['mapillary:A']);
});

test('recovering the same photo makes it available without announcing it again', async (t) => {
  const walker = {};
  const layer = await layerWithPoses(t, { sources: ['mapillary'], walker });
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  const original = layer.getUIState().acceptedPhoto;
  assert.equal(original.id, 'mapillary:A');

  walker.loseFrame();
  assert.equal(layer.getUIState().acceptedPhoto, null);
  assert.equal(layer.photo('mapillary:A').id, 'mapillary:A');
  walker.step('A');
  await settle();
  assert.equal(layer.getUIState().acceptedPhoto.revision, original.revision);
  assert.deepEqual(photos, ['mapillary:A']);
});

const nearbyIds = (layer) =>
  layer.getRecordsNear({ lat: 48.5, lon: 2 }, 100).map((record) => record.id);

test('a withdrawn photo that poses after an unrelated empty lookup is neither announced nor listed', async (t) => {
  const { promise: held, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  let lookups = 0;
  // The first lookup finds A, whose viewer holds it before its first pose;
  // the next lookup finds nothing.
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'A') return;
      started();
      await gate;
    },
    nearestImage: async () => (++lookups === 1 ? 'A' : null),
  });
  const photos = watchPhotos(t, layer);
  let wanted = true;
  const opening = layer.openNearest(
    { lat: 48, lon: 2 },
    { providerIds: ['mapillary'], frame: false, proceed: () => wanted },
  );
  await held;
  wanted = false;
  // Another lookup finds nothing and ends the shared loading state.
  assert.equal(
    await layer.openNearest(
      { lat: 10, lon: 10 },
      { providerIds: ['mapillary'], frame: false },
    ),
    false,
  );
  assert.equal(layer.getUIState().street.loading, false);
  // A now poses late, and its open is given up.
  release();
  assert.equal(await opening, false);
  await settle();
  assert.deepEqual(photos, [], 'no photo event for A');
  assert.ok(!nearbyIds(layer).includes('mapillary:A'), 'A is not in Nearby');
});

test('a step the viewer takes while an unrelated lookup runs is announced and listed', async (t) => {
  const { promise: lookupGate, resolve: finishLookup } =
    Promise.withResolvers();
  t.after(() => finishLookup());
  let lookups = 0;
  const walker = {};
  const layer = await layerWithPoses(t, {
    nearestImage: async () => {
      if (++lookups === 1) return 'A';
      await lookupGate;
      return null;
    },
    sources: ['mapillary'],
    walker,
  });
  const photos = watchPhotos(t, layer);
  assert.equal(
    await layer.openNearest(
      { lat: 48, lon: 2 },
      { providerIds: ['mapillary'], frame: false },
    ),
    true,
  );
  await settle();
  assert.deepEqual(photos, ['mapillary:A']);
  // A lookup elsewhere starts, and the viewer steps on to B meanwhile.
  const lookup = layer.openNearest(
    { lat: 10, lon: 10 },
    { providerIds: ['mapillary'], frame: false },
  );
  assert.equal(layer.getUIState().street.loading, true);
  walker.step('B');
  await settle();
  assert.deepEqual(photos, ['mapillary:A', 'mapillary:B'], 'B is announced');
  assert.ok(nearbyIds(layer).includes('mapillary:B'), 'B is in Nearby');
  finishLookup();
  await lookup;
});

test('a photo posing while the viewer switches source is held until its open is accepted', async (t) => {
  const { promise: aHeld, resolve: heldA } = Promise.withResolvers();
  const { promise: aGate, resolve: releaseA } = Promise.withResolvers();
  const { promise: bPosed, resolve: posedB } = Promise.withResolvers();
  const { promise: bGate, resolve: finishB } = Promise.withResolvers();
  t.after(() => {
    releaseA();
    finishB();
  });
  // KartaView holds A before its first pose; Panoramax poses B, then keeps
  // loading until released.
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'A') return;
      heldA();
      await aGate;
    },
    nearestImage: async () => 'B',
    sources: ['kartaview', 'panoramax'],
    afterPose: async (id) => {
      if (id !== 'B') return;
      posedB();
      await bGate;
    },
  });
  const photos = watchPhotos(t, layer);
  const openingA = layer.openPhoto('kartaview:A');
  await aHeld;
  // The viewer switches source to Panoramax for B while A still loads.
  layer.setProviderEnabled('panoramax', true);
  const openingB = layer.openPhoto('panoramax:B');
  await bPosed;
  await settle();
  assert.deepEqual(photos, [], 'B is not announced while it opens');
  assert.ok(!nearbyIds(layer).includes('panoramax:B'), 'nor listed');
  // B's card goes away before its open is accepted.
  assert.equal(layer.closePhoto('panoramax:B'), true);
  finishB();
  assert.equal(await openingB, null, 'withdrawn, not failed');
  releaseA();
  assert.equal(await openingA, null, 'A was taken over by B');
  await settle();
  assert.deepEqual(photos, []);
  assert.ok(!nearbyIds(layer).includes('panoramax:B'));
});

test('a newer empty lookup keeps an older photo from being shown, announced or listed', async (t) => {
  const { promise: held, resolve: entered } = Promise.withResolvers();
  const { promise: gate, resolve: finish } = Promise.withResolvers();
  t.after(() => finish());
  let lookups = 0;
  const layer = await layerWithPoses(t, {
    beforePose: async () => {
      entered();
      await gate;
    },
    nearestImage: async () => (++lookups === 1 ? 'A' : null),
  });
  const photos = watchPhotos(t, layer);
  const opening = layer.openNearest(
    { lat: 48, lon: 2 },
    { providerIds: ['mapillary'], frame: false, proceed: () => true },
  );
  await held;
  // Another lookup finds nothing and reports its own error.
  assert.equal(
    await layer.openNearest(
      { lat: 10, lon: 10 },
      { providerIds: ['mapillary'], frame: false },
    ),
    false,
  );
  assert.ok(layer.getUIState().street.error);
  finish();
  assert.equal(await opening, false);
  await settle();
  assert.ok(layer.getUIState().street.error);
  assert.equal(layer.getUIState().acceptedPhoto, null);
  assert.deepEqual(photos, []);
  assert.ok(!nearbyIds(layer).includes('mapillary:A'));
});

test('a photo whose viewer fails after its first pose is neither announced nor listed', async (t) => {
  const layer = await layerWithPoses(t, {
    nearestImage: async () => 'A',
    sources: ['mapillary'],
    afterPose: async () => {
      throw new Error('Image could not be opened');
    },
  });
  const photos = watchPhotos(t, layer);
  assert.equal(
    await layer.openNearest(
      { lat: 48, lon: 2 },
      { providerIds: ['mapillary'], frame: false },
    ),
    false,
  );
  await settle();
  assert.equal(layer.getUIState().street.error, 'Image could not be opened');
  assert.deepEqual(photos, [], 'the failed photo is not announced');
  assert.ok(!nearbyIds(layer).includes('mapillary:A'), 'nor listed');
});

/** The viewer's offscreen home and a card's slot inside `cardTab`. */
function viewerPlaces(t) {
  document.body.replaceChildren();
  const home = document.body.appendChild(document.createElement('div'));
  const wrap = home.appendChild(document.createElement('div'));
  wrap.id = 'sl-viewer-wrap';
  const rail = document.body.appendChild(document.createElement('aside'));
  rail.id = 'right-context-rail';
  const cardTab = rail.appendChild(document.createElement('div'));
  const slot = cardTab.appendChild(document.createElement('div'));
  slot.id = 'sl-viewer-slot';
  registerStreetLevelViewerHome(home);
  t.after(() => {
    document.body.classList.remove('mobile-shell');
    document.body.removeAttribute('data-mobile-sheet');
    registerStreetLevelViewerHome(null);
    document.body.replaceChildren();
  });
  return { home, wrap, cardTab, slot };
}

test('the lifted embedded viewer has a labelled pointer close control', async (t) => {
  const pinia = createPinia();
  const street = useStreetLevelStore(pinia);
  let closes = 0;
  street.attach({ closeViewer: () => closes++ });
  const host = document.body.appendChild(document.createElement('div'));
  const app = createApp(StreetLevelViewer).use(pinia);
  app.mount(host);
  t.after(() => {
    app.unmount();
    host.remove();
  });
  assert.equal(host.querySelector('#sl-viewer-close'), null);
  street.setEmbedOverlay(true);
  await settle();
  const close = host.querySelector('#sl-viewer-wrap #sl-viewer-close');
  assert.equal(close?.getAttribute('aria-label'), 'Close');
  close.click();
  assert.equal(closes, 1);
});

test('the viewer stays in its home while another Context tab hides its card', (t) => {
  const { home, wrap, cardTab, slot } = viewerPlaces(t);
  placeStreetLevelViewer();
  assert.ok(wrap.parentElement === slot, 'in the card while it shows');
  // Another Context tab hides the card with v-show (display: none).
  cardTab.style.display = 'none';
  placeStreetLevelViewer();
  assert.ok(wrap.parentElement === home, 'home while the card is hidden');
  cardTab.style.display = '';
  placeStreetLevelViewer();
  assert.ok(wrap.parentElement === slot, 'back in the card');
});

test('Bhote Koshi covering Context returns the same Street Level viewer home', async (t) => {
  const { home, wrap, cardTab, slot } = viewerPlaces(t);
  const rail = cardTab.parentElement;
  assert.ok(wrap.parentElement === slot);
  rail.classList.add('bhote-event-active');
  await settle();
  assert.ok(wrap.parentElement === home);
  rail.classList.remove('bhote-event-active');
  await settle();
  assert.ok(wrap.parentElement === slot);
});

test('an expanded viewer stays attached until fullscreen exits', (t) => {
  const { home, wrap, cardTab, slot } = viewerPlaces(t);
  Object.defineProperty(document, 'fullscreenElement', {
    configurable: true,
    value: wrap,
  });
  t.after(() => {
    delete document.fullscreenElement;
  });
  cardTab.hidden = true;
  placeStreetLevelViewer();
  assert.equal(wrap.parentElement, slot);
  delete document.fullscreenElement;
  placeStreetLevelViewer();
  assert.equal(wrap.parentElement, home);
});

test('on a phone the viewer follows the sheet: in the card only while the Context sheet shows', async (t) => {
  const { home, wrap, slot } = viewerPlaces(t);
  const body = document.body;
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  placeStreetLevelViewer();
  assert.ok(wrap.parentElement === home, 'home under the Layers sheet');
  // Switching sheets moves it, with no other prompt.
  body.setAttribute('data-mobile-sheet', 'context');
  await settle();
  assert.ok(wrap.parentElement === slot, 'in the card under the Context sheet');
  body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  assert.ok(wrap.parentElement === home, 'home again');
});

test('on a phone the same viewer stays in the visible dock outside the Context sheet', async (t) => {
  const { home, wrap, slot } = viewerPlaces(t);
  const body = document.body;
  const dock = body.appendChild(document.createElement('div'));
  dock.id = 'sl-docked-slot';
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'context');
  await settle();
  assert.equal(wrap.parentElement, slot);
  body.setAttribute('data-mobile-sheet', 'cameras');
  await settle();
  assert.equal(wrap.parentElement, dock);
  dock.hidden = true;
  placeStreetLevelViewer();
  assert.equal(wrap.parentElement, home);
});

test('unmounting the viewer home lets its viewer go, and a remounted home takes over', async (t) => {
  // Count the body watchers still live, so a stale one shows.
  const Native = globalThis.MutationObserver;
  const live = new Set();
  globalThis.MutationObserver = class extends Native {
    observe(...args) {
      live.add(this);
      return super.observe(...args);
    }
    disconnect() {
      live.delete(this);
      return super.disconnect();
    }
  };
  t.after(() => {
    globalThis.MutationObserver = Native;
  });
  const { home, wrap, slot } = viewerPlaces(t);
  const body = document.body;
  placeStreetLevelViewer();
  assert.ok(wrap.parentElement === slot, 'in the card');
  assert.equal(live.size, 1, 'one watcher while mounted');

  // Vue clears the function ref with null when the home unmounts.
  home.remove();
  registerStreetLevelViewerHome(null);
  assert.equal(live.size, 0, 'the watcher stops with the home');
  assert.ok(wrap.parentElement === home, 'the old viewer leaves the card');
  assert.equal(slot.childElementCount, 0, 'the card slot is empty');
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  body.classList.remove('mobile-shell');
  body.removeAttribute('data-mobile-sheet');
  await settle();
  placeStreetLevelViewer();
  assert.equal(slot.childElementCount, 0, 'nothing comes back to the slot');

  // A new home brings its own viewer, which the card then shows.
  const home2 = body.appendChild(document.createElement('div'));
  const wrap2 = home2.appendChild(document.createElement('div'));
  wrap2.id = 'sl-viewer-wrap';
  registerStreetLevelViewerHome(home2);
  assert.equal(live.size, 1, 'one watcher again');
  assert.ok(wrap2.parentElement === slot, 'the new viewer moves into the card');
  assert.equal(slot.childElementCount, 1, 'and only it');
  // Vue calls the same ref again on each update: the viewer stays put.
  registerStreetLevelViewerHome(home2);
  assert.ok(wrap2.parentElement === slot, 'a repeat call keeps it in the card');
  assert.equal(live.size, 1);
  body.classList.add('mobile-shell');
  body.setAttribute('data-mobile-sheet', 'layers');
  await settle();
  assert.ok(wrap2.parentElement === home2, 'the new watcher follows the sheet');
  assert.ok(wrap.parentElement === home, 'the old viewer stays released');
});

test('opening the photo on show again announces it again, so its card can come up', async (t) => {
  const layer = await layerWithPoses(t);
  const photos = watchPhotos(t, layer);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  await settle();
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  await settle();
  assert.deepEqual(photos, ['mapillary:A', 'mapillary:A']);
});

test('a Nearby line row opens with its own sequence named to the provider', async (t) => {
  const asked = [];
  const layer = await layerWithPoses(t, {
    nearestImage: async (point, options) => {
      asked.push(options?.sequenceId ?? null);
      return 'A';
    },
  });
  const id = nearPointId('mapillary', { lat: 48, lon: 2, sequenceId: 'seq-b' });
  assert.equal(await layer.openPhoto(id), true);
  assert.deepEqual(asked, ['seq-b']);
});

test('a failed open never brings back a photo that was itself still opening', async (t) => {
  const { promise: aPosed, resolve: posedA } = Promise.withResolvers();
  const { promise: aGate, resolve: finishA } = Promise.withResolvers();
  t.after(() => finishA());
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') throw new Error('Image could not be opened');
    },
    sources: ['mapillary'],
    afterPose: async (id) => {
      if (id !== 'A') return;
      posedA();
      await aGate;
    },
  });
  const photos = watchPhotos(t, layer);
  const openingA = layer.openImage('mapillary', 'A', { frame: false });
  await aPosed;
  // B replaces A while A still opens, and fails.
  assert.equal(
    await layer.openImage('mapillary', 'B', { frame: false }),
    false,
  );
  finishA();
  assert.equal(await openingA, false);
  await settle();
  assert.notEqual(
    layer.getUIState().street.imageId,
    'A',
    'A was never accepted',
  );
  assert.deepEqual(photos, [], 'and is not announced');
});

test('a card’s photo request taken over by a newer open reports neither success nor failure', async (t) => {
  const { promise: held, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id !== 'A') return;
      started();
      await gate;
    },
  });
  const card = layer.openPhoto('mapillary:A');
  await held;
  assert.equal(await layer.openImage('mapillary', 'B', { frame: false }), true);
  release();
  assert.equal(await card, null);
});

for (const scenario of [
  'closed Context',
  'another phone sheet',
  'passive rejection with visible Context',
  'failed replacement that leaves the prior photo on screen',
  'visible Context',
  'a newer card',
  'row OPEN on desktop',
  'row OPEN with Context already visible',
  'row OPEN on a phone',
  'row OPEN after switching phone sheets',
  'row OPEN with a newer card',
  'row OPEN with a provider error',
  'row OPEN with an explicit panel command before settlement',
  'row OPEN with a later desktop close',
  'row OPEN after returning to Layers',
  'row OPEN after a different desktop right panel opens',
]) {
  test(`an explicit Street Level request respects ${scenario}`, async (t) => {
    const body = document.body;
    body.replaceChildren();
    const rowOpen = scenario.startsWith('row OPEN');
    const anotherRightPanel =
      scenario === 'row OPEN after a different desktop right panel opens';
    const switchedSheet = scenario === 'row OPEN after switching phone sheets';
    const desktopClose = scenario === 'row OPEN with a later desktop close';
    const visibleStart = scenario === 'row OPEN with Context already visible';
    const returnsToLayers = scenario === 'row OPEN after returning to Layers';
    const mobile =
      scenario === 'another phone sheet' ||
      scenario === 'row OPEN on a phone' ||
      switchedSheet ||
      returnsToLayers;
    const preservesNewer = scenario.endsWith('a newer card');
    const explicitWhilePending =
      scenario === 'row OPEN with an explicit panel command before settlement';
    const passiveRejection =
      scenario === 'passive rejection with visible Context';
    const retainedPhoto =
      scenario === 'failed replacement that leaves the prior photo on screen';
    const providerError =
      scenario === 'row OPEN with a provider error' ||
      explicitWhilePending ||
      passiveRejection;
    const posed = Promise.withResolvers();
    const finish = Promise.withResolvers();
    t.after(() => finish.resolve());
    const pinia = applicationPinia();
    const display = useDisplayStore(pinia);
    const previousPhone = display.phoneShell;
    const cards = useEntityCardStore(pinia);
    cards.clear();
    const viewer = fakeCesiumViewer({ view: rowOpen });
    const layer = await layerWithPoses(t, {
      beforePose: (imageId) => {
        if (retainedPhoto && imageId === 'R')
          throw new Error('Provider unavailable');
        if (preservesNewer)
          assert.equal(
            cards.select(
              {
                layerId: 'place',
                id: 'newer',
                label: 'Newer place',
                lat: 49,
                lon: 3,
              },
              { reveal: false },
            ),
            true,
          );
      },
      nearestImage: async () => 'A',
      sources: ['mapillary'],
      viewer,
      groundClick: rowOpen,
      afterPose:
        rowOpen || passiveRejection
          ? async () => {
              posed.resolve();
              await finish.promise;
              if (providerError) throw new Error('Provider unavailable');
            }
          : undefined,
    });
    const input = fakeInput(viewer);
    const dataManager = {
      isEnabled: () => true,
      getLayerParams: () => ({ mapillary: true }),
      setLayerParams: () => true,
      getAll: () => [],
      layers: new Map([['street-level', { module: layer }]]),
    };
    const chrome = usePanelChromeStore(pinia);
    const owner = chrome.connect({});
    const setCollapsed = (collapsed) =>
      chrome.publish(owner, 'global-context-panel', { collapsed });
    const initiallyCollapsed =
      !mobile &&
      scenario !== 'visible Context' &&
      !passiveRejection &&
      !retainedPhoto &&
      !desktopClose &&
      !visibleStart;
    setCollapsed(initiallyCollapsed);
    const phone = mobile
      ? initMobileShell({
          matchMedia: () => ({ matches: true }),
          publish: (view) => display.publishPhoneShell(view),
          setPanelCollapsed: (id, collapsed) =>
            chrome.publish(owner, id, { collapsed }),
          requestFrame: null,
        })
      : null;
    const setSheet = (sheet) => phone?.setSheet(sheet);
    setSheet('layers');
    const rail = body.appendChild(document.createElement('div'));
    rail.className = 'ui-rail--right';
    const button = rail.appendChild(document.createElement('button'));
    button.className = 'ui-rail__item';
    button.dataset.railItem = 'global-context-panel';
    button.setAttribute('aria-pressed', String(!initiallyCollapsed));
    button.addEventListener('click', () => {
      const collapsed = !chrome.panels['global-context-panel'].collapsed;
      setCollapsed(collapsed);
      button.setAttribute('aria-pressed', String(!collapsed));
    });
    const host = body.appendChild(document.createElement('div'));
    const app = createApp(StreetLevelViewer);
    app.use(pinia);
    app.mount(host);
    let revealsRequested = 0;
    const disconnect = installEntityContext({
      viewer,
      getDataManager: () => dataManager,
      pinia,
      revealContext: () => {
        revealsRequested++;
        if (mobile) setSheet('context');
      },
    });
    const streetLevels = useStreetLevelStore(pinia);
    const previousView = streetLevels.view;
    // Context's Inspect tab is asked for when the card should show.
    let inspectorAsked = 0;
    const askInspector = () => inspectorAsked++;
    globalThis.addEventListener('gev:context-show-view', askInspector);
    const shell = {
      services: { streetLevelLayer: layer },
      _dataManager: dataManager,
      _streetLevelViewer: document.getElementById('sl-viewer-root'),
    };
    StyleManager.prototype._initStreetLevelControls.call(shell);
    const events = [];
    const photoShown = ({ detail }) =>
      events.push({
        id: detail.id,
        explicit: detail.explicit === true,
        contextShown:
          chrome.panels['global-context-panel']?.collapsed === false &&
          (!mobile || body.getAttribute('data-mobile-sheet') === 'context'),
      });
    document.addEventListener(STREET_LEVEL_PHOTO_EVENT, photoShown);
    t.after(() => {
      document.removeEventListener(STREET_LEVEL_PHOTO_EVENT, photoShown);
      shell._streetLevelControls.destroy();
      shell._streetLevelPhotoUnsubscribe?.();
      disconnect();
      input.destroy();
      app.unmount();
      phone?.destroy();
      chrome.detach(owner);
      streetLevels.view = previousView;
      globalThis.removeEventListener('gev:context-show-view', askInspector);
      display.publishPhoneShell(previousPhone);
      body.replaceChildren();
      body.classList.remove('mobile-shell');
      body.removeAttribute('data-mobile-sheet');
    });

    if (retainedPhoto) {
      assert.equal(
        await layer.openImage('mapillary', 'A', { frame: false }),
        true,
      );
      assert.equal(layer.settledPhotoId(), 'mapillary:A');
      assert.equal(cards.card?.key, 'street-level:mapillary:A');
      const announced = events.length;
      assert.equal(
        await layer.openImage('mapillary', 'R', { frame: false }),
        false,
      );
      await settle();
      assert.equal(layer.getUIState().street.imageId, 'A');
      assert.equal(streetLevels.view.viewer.photo?.id, 'mapillary:A');
      assert.equal(cards.card?.key, 'street-level:mapillary:A');
      assert.equal(
        events.length,
        announced,
        'a failed replacement emits no event',
      );
      const run = createGevActionRunner({
        viewer,
        dataManager,
        styleManager: {
          setPanelCollapsed: (id, collapsed) => {
            if (id === 'global-context-panel') setCollapsed(collapsed);
          },
          revealPanel: () => {},
        },
      });
      const result = await run('set_panel_open', {
        panelId: 'street-level-panel',
        open: true,
      });
      assert.equal(result.action, 'set_panel_open', JSON.stringify(result));
      assert.match(result.say, /latest request failed/);
      assert.doesNotMatch(result.say, /Provider unavailable/);
      return;
    }
    if (passiveRejection) {
      const opening = layer.openImage('mapillary', 'A', { frame: false });
      await posed.promise;
      assert.deepEqual(events, [], 'no event while the provider is unresolved');
      finish.resolve();
      assert.equal(await opening, false);
      await settle();
      const result = {
        events,
        card: cards.card?.key,
        settled: layer.settledPhotoId(),
        error: layer.getUIState().street.error,
      };
      assert.deepEqual(result, {
        events: [],
        card: undefined,
        settled: null,
        error: 'Provider unavailable',
      });
      return;
    }
    if (rowOpen) {
      const open = layer
        .getRowControls()
        .chips.find(({ id }) => id === 'sl-open-nearest');
      assert.equal(open?.disabled, false);
      const opening = open.onClick();
      await posed.promise;
      const previousKey = preservesNewer ? 'place:newer' : null;
      assert.equal(cards.card?.key ?? null, previousKey);
      assert.equal(
        chrome.panels['global-context-panel'].collapsed,
        initiallyCollapsed && !preservesNewer,
        'only the newer place pick can open Context during the held photo',
      );
      if (mobile)
        assert.equal(body.getAttribute('data-mobile-sheet'), 'layers');
      assert.deepEqual(events, [], 'a pose is withheld until its open settles');
      if (explicitWhilePending) {
        const panelsOpened = [];
        const run = createGevActionRunner({
          viewer,
          dataManager,
          styleManager: {
            // Only Context's own panel moves Context; Data Layers is noted.
            setPanelCollapsed: (id, collapsed) => {
              if (id === 'global-context-panel') setCollapsed(collapsed);
              else panelsOpened.push(`${id}:${collapsed ? 'closed' : 'open'}`);
            },
            revealPanel: () => {},
          },
        });
        const result = await run('set_panel_open', {
          panelId: 'street-level-panel',
          open: true,
        });
        const before = {
          result,
          adapterLoading: layer.getUIState().street.loading,
          card: cards.card?.key ?? null,
          events: [...events],
        };
        finish.resolve();
        await opening;
        await settle();
        const after = {
          card: cards.card?.key ?? null,
          providerError: layer.getUIState().street.error,
          events: [...events],
        };
        assert.equal(before.adapterLoading, true);
        assert.equal(
          before.result.action,
          'show_data_layers_menu',
          'a photo still opening falls back to its Data Layers row',
        );
        assert.deepEqual(
          before.events,
          [],
          'the explicit route must not announce an unsettled pose',
        );
        assert.equal(
          after.card,
          null,
          'provider rejection leaves no failed photo selected',
        );
        assert.deepEqual(panelsOpened, ['data-panel:open']);
        // Asked again once the rejection has landed: still not that photo.
        const afterRejection = await run('set_panel_open', {
          panelId: 'street-level-panel',
          open: true,
        });
        assert.equal(afterRejection.action, 'show_data_layers_menu');
        assert.match(afterRejection.reason, /did not open/);
        assert.deepEqual(events, [], 'the rejected photo is never announced');
        assert.equal(cards.card, null);
        return;
      }
      if (anotherRightPanel) chrome.claimRightRail(owner);
      if (switchedSheet || returnsToLayers) setSheet('more');
      if (returnsToLayers) {
        await settle();
        setSheet('layers');
      }
      if (desktopClose) {
        button.click();
        assert.equal(chrome.panels['global-context-panel'].collapsed, true);
        assert.equal(button.getAttribute('aria-pressed'), 'false');
      }
      finish.resolve();
      await opening;
      await settle();
      const reveals =
        !providerError &&
        !preservesNewer &&
        !switchedSheet &&
        !desktopClose &&
        !returnsToLayers &&
        !anotherRightPanel;
      assert.equal(
        cards.card?.key ?? null,
        reveals ? streetLevelCardKey('mapillary:A') : previousKey,
      );
      assert.equal(
        chrome.panels['global-context-panel'].collapsed,
        !mobile && !reveals && !preservesNewer,
      );
      if (mobile)
        assert.equal(
          body.getAttribute('data-mobile-sheet'),
          switchedSheet ? 'more' : returnsToLayers ? 'layers' : 'context',
        );
      if (reveals) assert.ok(inspectorAsked > 0, 'the Inspect tab shows');
      assert.equal(revealsRequested, reveals && !visibleStart ? 1 : 0);
      assert.deepEqual(
        events,
        providerError
          ? []
          : [
              {
                id: 'mapillary:A',
                explicit: false,
                contextShown: reveals || preservesNewer,
              },
            ],
      );
      return;
    }

    const show = () =>
      showStreetLevel(
        { provider: 'mapillary', latitude: 48, longitude: 2, fly: false },
        {
          viewer,
          dataManager,
          styleManager: {
            setPanelCollapsed: (_id, collapsed) => setCollapsed(collapsed),
            revealPanel: () => {
              if (mobile) setSheet('context');
            },
          },
        },
      );
    const startingGeneration = cards.selectionGeneration();
    assert.equal((await show()).ok, true);
    assert.equal(streetLevels.view.viewer.photo.id, 'mapillary:A');
    assert.equal(chrome.panels['global-context-panel'].collapsed, false);
    if (mobile) assert.equal(body.getAttribute('data-mobile-sheet'), 'context');
    assert.equal(
      cards.card?.key,
      preservesNewer ? 'place:newer' : streetLevelCardKey('mapillary:A'),
    );
    assert.equal(cards.selectionGeneration(), startingGeneration + 1);
    const wasVisible = scenario === 'visible Context';
    assert.deepEqual(events, [
      {
        id: 'mapillary:A',
        explicit: false,
        contextShown: true,
      },
    ]);
    if (wasVisible) {
      // Asked again while its card shows: Inspect is brought forward
      // in case another tab hid the card.
      const asked = inspectorAsked;
      assert.equal((await show()).ok, true);
      assert.ok(inspectorAsked > asked, 'the Inspect tab shows again');
      assert.equal(
        events.length,
        2,
        'an explicit reopen announces its accepted photo once',
      );
      assert.equal(
        cards.selectionGeneration(),
        startingGeneration + 1,
        'the same photo keeps its selection',
      );
    }
  });
}

test('explicitly reopening the accepted dock photo reuses its frame', async (t) => {
  const opened = [];
  const layer = await layerWithPoses(t, {
    beforePose: (id) => opened.push(id),
  });
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  layer.attachDockedPhoto(() => dockedPhoto);
  const revision = layer.getUIState().acceptedPhoto.revision;
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  assert.deepEqual(opened, ['A']);
  assert.ok(layer.getUIState().acceptedPhoto.revision > revision);
  assert.equal(layer.getUIState().dockPhotoLoading, undefined);
});

test('a visible dock admits an idle cursor step without another selection or frame', async (t) => {
  const viewer = fakeCesiumViewer();
  const layer = await layerWithPoses(t, { sources: ['mapillary'], viewer });
  assert.equal(await layer.openPhoto('mapillary:A'), true);
  layer.attachDockedPhoto(() => dockedPhoto);
  const generation = layer.getUIState().photoRequests;
  assert.equal(
    await layer.openImage('mapillary', 'B', { request: false }),
    true,
  );
  assert.equal(layer.settledPhotoId(), 'mapillary:B');
  assert.equal(layer.getUIState().acceptedPhoto.requestId, null);
  assert.equal(layer.getUIState().photoRequests, generation);
  assert.equal(viewer.flights.started, 0);
});

test('a docked photo follows the viewer, and another card stays', (t) => {
  const { store, docked, announce } = bridge(t);
  const selected = [];
  store.select = (identity) => {
    selected.push(identity.id);
    return true;
  };
  docked.dock({
    key: streetLevelCardKey('mapillary:A'),
    kind: 'street',
    title: 'A',
    identity: { layerId: 'street-level', id: 'mapillary:A' },
  });
  // A camera's card shows while the docked photo walks on.
  store.card = { key: 'cctv:1', layerId: 'cctv', identity: { id: '1' } };
  announce('B');
  assert.equal(docked.view.key, 'street-level:mapillary:B');
  assert.equal(docked.view.kind, 'street');
  assert.deepEqual(selected, [], "the camera's card stays");
  store.card = null;
  announce('C');
  assert.equal(docked.view.key, 'street-level:mapillary:C');
  assert.deepEqual(
    selected,
    [],
    'Nearby stays while the docked photo advances',
  );
  announce('C');
  assert.deepEqual(
    selected,
    [],
    'restoring the docked photo leaves Nearby open',
  );
});

test('the layer offers as settled only the photo its viewer accepted, steps included', async (t) => {
  const { promise: held, resolve: started } = Promise.withResolvers();
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  let lookups = 0;
  const walker = {};
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'R') throw new Error('Provider unavailable');
    },
    nearestImage: async () => {
      if (++lookups === 1) return 'A';
      started();
      await gate;
      return null;
    },
    sources: ['mapillary'],
    walker,
  });
  assert.equal(layer.settledPhotoId(), null);
  assert.equal(
    await layer.openNearest({ lat: 48, lon: 2 }, { frame: false }),
    true,
  );
  assert.equal(layer.settledPhotoId(), 'mapillary:A');
  assert.equal(layer.photoOpening(), false);
  // A lookup elsewhere runs; the viewer steps on to B meanwhile.
  const lookup = layer.openNearest({ lat: 10, lon: 10 }, { frame: false });
  await held;
  assert.equal(layer.getUIState().street.loading, true);
  walker.step('B');
  release();
  assert.equal(await lookup, false);
  assert.equal(layer.settledPhotoId(), 'mapillary:B', 'the step is accepted');
  assert.equal(layer.photoOpening(), false);
  // A photo its provider rejects is never settled; B, still on screen in
  // the same viewer, stays the settled photo.
  const rejected = layer.openImage('mapillary', 'R', { frame: false });
  assert.equal(layer.photoOpening(), true);
  assert.equal(
    layer.settledPhotoId(),
    'mapillary:B',
    'only the still visible photo is accepted',
  );
  assert.equal(await rejected, false);
  assert.equal(layer.settledPhotoId(), 'mapillary:B');
  assert.equal(layer.photoOpening(), false);
  // A step the viewer then takes shows a photo again, without the old error.
  walker.step('C');
  assert.equal(layer.settledPhotoId(), 'mapillary:C');
  assert.equal(layer.getUIState().street.error, null);
  // Closed, nothing is.
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  layer.closeViewer();
  assert.equal(layer.settledPhotoId(), null);
});

test('closing a photo while it opens leaves no open in flight, so later steps are accepted', async (t) => {
  const { promise: gate, resolve: release } = Promise.withResolvers();
  t.after(() => release());
  const walker = {};
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'B') await gate;
    },
    sources: ['mapillary'],
    walker,
  });
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  const opening = layer.openImage('mapillary', 'B', { frame: false });
  assert.equal(layer.photoOpening(), true);
  layer.closeViewer();
  assert.equal(layer.photoOpening(), false);
  release();
  assert.equal(await opening, false);
  assert.equal(await layer.openImage('mapillary', 'A', { frame: false }), true);
  walker.step('C');
  assert.equal(layer.settledPhotoId(), 'mapillary:C');
});

test('overlapping opens that both reject keep the previously shown photo accepted', async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  const layer = await layerWithPoses(t, {
    beforePose: async (id) => {
      if (id === 'R1') {
        started.resolve();
        await release.promise;
      }
      if (id === 'R1' || id === 'R2') throw new Error('Provider unavailable');
    },
  });
  const open = (id) => layer.openImage('mapillary', id, { frame: false });
  assert.equal(await open('A'), true);
  assert.equal(layer.settledPhotoId(), 'mapillary:A');

  const first = open('R1');
  await started.promise;
  assert.equal(await open('R2'), false);
  release.resolve();
  assert.equal(await first, false);
  assert.equal(layer.getUIState().street.imageId, 'A');
  assert.equal(layer.settledPhotoId(), 'mapillary:A');
});
