import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createStreetLevelLayer } from './index.js';
import { MAPILLARY_CREDIT_HTML } from './providers/mapillary/policy.js';
import { createMapillaryProvider } from './providers/mapillary/index.js';
import { fakeStreetLevelProvider as fakeProvider } from '../../testSupport/streetLevelFakes.mjs';

/**
 * A stand-in Cesium viewer the layer can be enabled on: a canvas for the
 * click handler, camera events, a primitive list and a credit display.
 */
function fakeViewer() {
  const credits = [];
  /** Cesium's flight bookkeeping: a new flight cancels the current one. */
  let flight = null;
  const flights = { started: 0, cancelled: 0 };
  const stopFlight = () => {
    const current = flight;
    flight = null;
    current?.cancel?.();
    return Boolean(current);
  };
  const canvas = Object.assign(new EventTarget(), {
    style: {},
    // Keep Cesium's handler on the canvas; there is no real document here.
    disableRootEvents: true,
    onwheel: null,
  });
  return {
    credits,
    flights,
    scene: {
      canvas,
      primitives: { add: (p) => p, remove() {} },
      // Enough of a scene for the position marker to clamp to the ground.
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
    },
    camera: {
      changed: new Cesium.Event(),
      moveStart: new Cesium.Event(),
      moveEnd: new Cesium.Event(),
      flyToBoundingSphere(sphere, options = {}) {
        stopFlight();
        flight = options;
        flights.started++;
      },
      cancelFlight() {
        if (stopFlight()) flights.cancelled++;
      },
    },
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit),
      removeStaticCredit: (credit) =>
        credits.splice(credits.indexOf(credit), 1),
    },
  };
}

/** A layer over `providers`, initialised and enabled on a stand-in viewer. */
async function enabledLayer(t, providers = [fakeProvider()]) {
  const saved = globalThis.document;
  // A pose moves the position marker, whose glyph is drawn on a canvas.
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await settle();
  return { layer, viewer };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A provider whose viewer reports a pose for every image it opens. */
function posingProvider() {
  const provider = fakeProvider();
  const create = provider.create;
  provider.create = (context) => {
    const instance = create(context);
    let emit = null;
    instance.viewer.onPose = (listener) => {
      emit = listener;
      return () => {
        emit = null;
      };
    };
    instance.viewer.open = async (imageId) => {
      provider.calls.open.push(imageId);
      emit?.({
        providerId: 'mapillary',
        imageId,
        position: { lon: -121.49, lat: 38.58 },
        bearing: 90,
      });
    };
    return instance;
  };
  return provider;
}

/** nearestImage lookups that answer when the test says, with their signals. */
function slowLookups() {
  const lookups = [];
  const nearestImage = (point, { signal } = {}) => {
    const answer = deferred();
    lookups.push({ point, signal, answer });
    return answer.promise;
  };
  return { lookups, nearestImage };
}

/** A map stack controller that can be switched between stacks. */
function fakeMapStack(initial) {
  let active = initial;
  const listeners = new Set();
  return {
    getActiveId: () => active,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    switchTo(id) {
      active = id;
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

test('FOLLOW is available only while the Google 3D map stack is active', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  assert.equal(
    layer.getUIState().street.followAvailable,
    false,
    'unknown stack: off',
  );

  const stack = fakeMapStack('esri-imagery');
  layer.attachMapStackController(stack);
  assert.equal(layer.getUIState().street.followAvailable, false);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, false, 'refused on Esri');

  stack.switchTo('photoreal');
  assert.equal(layer.getUIState().street.followAvailable, true);
  layer.setFollow(true);
  assert.equal(layer.getUIState().street.follow, true);

  stack.switchTo('osm');
  assert.equal(layer.getUIState().street.followAvailable, false);
  assert.equal(
    layer.getUIState().street.follow,
    false,
    'leaving Google 3D stops following',
  );
});

test('the layer lets go of the map stack when destroyed or re-attached', () => {
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  const first = fakeMapStack('photoreal');
  layer.attachMapStackController(first);
  assert.equal(first.listenerCount(), 1);
  const second = fakeMapStack('photoreal');
  layer.attachMapStackController(second);
  assert.equal(first.listenerCount(), 0);
  assert.equal(second.listenerCount(), 1);
  layer.destroy();
  assert.equal(second.listenerCount(), 0);
});

test('the CC BY-SA credit shows while a provider is on and goes with it', async (t) => {
  const { layer, viewer } = await enabledLayer(t);
  const shown = () => viewer.credits.map((credit) => credit.html);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML], 'shown on activate');
  assert.match(shown()[0], /CC BY-SA 4\.0/);
  layer.setProviderEnabled('mapillary', false);
  assert.deepEqual(shown(), [], 'hidden with the provider');
  layer.setProviderEnabled('mapillary', true);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML]);
  layer.disable();
  assert.deepEqual(shown(), [], 'every credit goes with the layer');
});

test('getStats tells a rejected key from a missing one', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  provider.stats.loading = true;
  assert.equal(layer.getStats().loadingLabel, 'loading coverage...');
  assert.equal(layer.getStats().keyRequired, false);

  provider.stats.keyRequired = true;
  assert.deepEqual(
    [layer.getStats().loadingLabel, layer.getStats().error],
    ['KEY REQUIRED', 'KEY REQUIRED'],
  );

  // A rejected key gates the provider exactly like a missing one.
  provider.stats.keyRequired = false;
  provider.stats.keyRejected = true;
  provider.stats.error = 'Mapillary rejected MAPILLARY_CLIENT_TOKEN';
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.loadingLabel, 'KEY REJECTED');
  assert.equal(stats.error, 'Mapillary rejected MAPILLARY_CLIENT_TOKEN');
  const ui = layer.getUIState();
  assert.equal(ui.keyRequired, true);
  assert.equal(ui.keyRejected, true);
  assert.equal(ui.providers[0].keyRequired, true);
});

test('switching a provider off deactivates it and closes the image it shows', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.deepEqual(provider.calls.open, ['img1']);
  assert.equal(layer.getUIState().street.open, true);
  layer.setProviderEnabled('mapillary', false);
  assert.equal(provider.calls.deactivate, 1);
  assert.equal(provider.calls.unmount, 1, 'its viewer is released');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().street.providerId, null);
});

test('openNearest without the panel reports it instead of loading forever', async (t) => {
  const provider = fakeProvider({ nearestImage: async () => 'img1' });
  const { layer } = await enabledLayer(t, [provider]);
  assert.equal(await layer.openNearest({ lat: 38.58, lon: -121.49 }), false);
  const { street } = layer.getUIState();
  assert.equal(street.loading, false);
  assert.match(street.error, /Open the Street Level panel/);
  assert.equal(provider.calls.mount, 0);
});

test('openNearest opens nothing once the layer went off during the lookup', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.disable();
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.equal(provider.calls.mount, 0, 'no viewer was stood up');
  const { street } = layer.getUIState();
  assert.equal(street.open, false);
  assert.equal(street.loading, false);
  assert.equal(street.error, null);
});

test('openNearest skips a provider switched off during its lookup', async (t) => {
  const answer = deferred();
  const provider = fakeProvider({ nearestImage: () => answer.promise });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.setProviderEnabled('mapillary', false);
  answer.resolve('img1');
  assert.equal(await opening, false);
  assert.deepEqual(provider.calls.open, []);
  assert.equal(layer.getUIState().street.loading, false);
});

test('a provider withdraws only the error it reported', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  const { actions } = provider.context();
  actions.reportError('Sequence images unavailable');
  assert.equal(layer.getUIState().street.error, 'Sequence images unavailable');
  actions.reportError(null);
  assert.equal(layer.getUIState().street.error, null, 'withdrawn');

  // The viewer's own error is not the provider's to clear.
  layer.attachViewerHost(null);
  actions.reportError('Sequence images unavailable');
  await layer.openImage('mapillary', 'img1');
  actions.reportError(null);
  assert.match(layer.getUIState().street.error, /Open the Street Level panel/);
});

test('closing the photo stops the globe flying to it', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.equal(viewer.flights.started, 1, 'the photo is framed');
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 1);
});

test('switching the layer off or destroying it stops the framing flight', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  await layer.openImage('mapillary', 'img1');
  layer.disable();
  assert.equal(viewer.flights.cancelled, 1, 'layer off');

  layer.enable(viewer);
  await layer.openImage('mapillary', 'img2');
  layer.destroy();
  assert.equal(viewer.flights.cancelled, 2, 'destroyed');
});

test('closing the photo leaves a newer navigation flight alone', async (t) => {
  const { layer, viewer } = await enabledLayer(t, [posingProvider()]);
  layer.attachViewerHost({});
  await layer.openImage('mapillary', 'img1');
  assert.equal(viewer.flights.started, 1, 'the photo is being framed');
  // A search result flies the globe elsewhere before the framing lands.
  viewer.camera.flyToBoundingSphere(null, {});
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 0, 'the search flight keeps going');
});

test('an older nearest lookup that answers late cannot replace a newer one', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const older = layer.openNearest({ lat: 38.58, lon: -121.49 });
  const newer = layer.openNearest({ lat: 38.59, lon: -121.48 });
  lookups[1].answer.resolve('newer');
  assert.equal(await newer, true);
  lookups[0].answer.resolve('older');
  assert.equal(await older, false);
  assert.deepEqual(provider.calls.open, ['newer']);
  assert.equal(lookups[0].signal?.aborted, true, 'its request was aborted');
  assert.equal(lookups[1].signal?.aborted, false);
});

test('an image picked during a nearest lookup wins over its late answer', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  const lookup = layer.openNearest({ lat: 38.58, lon: -121.49 });
  // A cone click goes through the provider's openImage action.
  assert.equal(await provider.context().actions.openImage('picked'), true);
  lookups[0].answer.resolve('nearest');
  assert.equal(await lookup, false);
  assert.deepEqual(provider.calls.open, ['picked']);
  assert.equal(lookups[0].signal?.aborted, true);
});

test('closing the viewer or switching the layer off retires a nearest lookup', async (t) => {
  const { lookups, nearestImage } = slowLookups();
  const provider = fakeProvider({ nearestImage });
  const { layer, viewer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});

  const closed = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.closeViewer();
  // The aborted fetch rejects, as fetch does; that is not the user's error.
  lookups[0].answer.reject(new DOMException('aborted', 'AbortError'));
  assert.equal(await closed, false);
  let { street } = layer.getUIState();
  assert.deepEqual(
    [street.open, street.loading, street.error],
    [false, false, null],
  );
  assert.equal(lookups[0].signal?.aborted, true, 'closing aborts the request');

  const disabled = layer.openNearest({ lat: 38.58, lon: -121.49 });
  layer.disable();
  layer.enable(viewer);
  lookups[1].answer.resolve('img1');
  assert.equal(await disabled, false, 'nor does it open once back on');
  assert.deepEqual(provider.calls.open, []);
  ({ street } = layer.getUIState());
  assert.deepEqual(
    [street.open, street.loading, street.error],
    [false, false, null],
  );
  assert.equal(lookups[1].signal?.aborted, true, 'layer off aborts it too');
});

test('the Mapillary provider hands the lookup signal to its source', async () => {
  const requests = [];
  const source = {
    hasToken: () => true,
    getStatus: async () => ({ configured: true }),
    getTile: async () => new Uint8Array(0),
    getSequenceImages: async () => [],
    nearestImages: async (query, options) => {
      requests.push(options);
      return [{ id: 7, is_pano: false, captured_at: 10 }];
    },
  };
  const instance = createMapillaryProvider({ source }).create({
    services: {},
    getFilter: () => ({ pano: 'all', sinceMs: null }),
    isActive: () => true,
    notify() {},
    actions: { openImage() {}, reportError() {} },
  });
  const { signal } = new AbortController();
  assert.equal(
    await instance.nearestImage({ lat: 1, lon: 2 }, { signal }),
    '7',
  );
  assert.equal(requests[0]?.signal, signal);
});

test('setParams takes "any date" (0 days) and a provider switch over the current values (share-link defaults)', async (t) => {
  const provider = fakeProvider();
  const { layer } = await enabledLayer(t, [provider]);
  layer.setParams({ pano: 'flat', sinceDays: 365 });
  assert.equal(layer.getParams().sinceDays, 365);
  layer.setParams({ sinceDays: 0 });
  assert.deepEqual(layer.getParams(), {
    mapillary: true,
    pano: 'flat',
    sinceDays: 0,
  });
  assert.equal(
    provider.filters.at(-1).sinceMs,
    null,
    'providers drop the cut-off',
  );
  layer.setParams({ mapillary: false });
  assert.equal(layer.getParams().mapillary, false);
});

/** A layer initialised on a stand-in viewer but never enabled. */
function initialisedLayer(t, providers) {
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  return { layer, viewer };
}

test('switching a provider on while the layer is off activates nothing (M01)', async (t) => {
  const provider = fakeProvider();
  const prewarmed = [];
  const create = provider.create;
  provider.create = (context) => {
    const instance = create(context);
    instance.viewer.prewarm = async (host) => prewarmed.push(host);
    return instance;
  };
  const { layer, viewer } = initialisedLayer(t, [provider]);
  layer.attachViewerHost({});
  layer.setProviderEnabled('mapillary', false);
  layer.setProviderEnabled('mapillary', true);
  layer.setParams({ mapillary: false });
  layer.setParams({ mapillary: true });
  await new Promise((resolve) => setTimeout(resolve, 40)); // past whenIdle
  assert.equal(provider.calls.activate, 0, 'no coverage drawn');
  assert.deepEqual(viewer.credits, [], 'no credit shown');
  assert.deepEqual(prewarmed, [], 'no viewer stood up');
  assert.equal(layer.getUIState().providers[0].on, true, 'the switch is kept');
  // Enabling the layer is what activates it, once.
  layer.enable(viewer);
  assert.equal(provider.calls.activate, 1);
  assert.equal(viewer.credits.length, 1);
});
