import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createStreetLevelLayer } from './index.js';
import { MAPILLARY_CREDIT_HTML } from './providers/mapillary/policy.js';
import { createMapillaryProvider } from './providers/mapillary/index.js';
import { createKartaViewProvider } from './providers/kartaview/index.js';
import {
  fakeCesiumViewer,
  fakeMapillarySource,
  fakePhotoViewer,
  fakeStreetLevelProvider as fakeProvider,
} from '../../testSupport/streetLevelFakes.mjs';
import { setLocale } from '../../i18n/index.js';

/**
 * A layer over `source` and `photoViewer`, initialised on a stand-in viewer
 * and (unless `enable` is false) enabled.
 */
async function startLayer(
  t,
  {
    source = fakeMapillarySource(),
    photoViewer = fakePhotoViewer(),
    providers = [createMapillaryProvider({ source, photoViewer })],
    view = false,
    enable = true,
  } = {},
) {
  const saved = globalThis.document;
  // The click handler listens for Esc on the document.
  globalThis.document = new EventTarget();
  // Skip Cesium's one-time terrain table download for draped lines.
  t.mock.method(
    Cesium.GroundPolylinePrimitive,
    'initializeTerrainHeights',
    async () => {},
  );
  const viewer = fakeCesiumViewer({ view });
  const layer = createStreetLevelLayer({ providers });
  layer.init(viewer);
  if (enable) layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await settle();
  return { layer, viewer, source, photoViewer };
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

/** A photo viewer reporting a pose for every image it opens. */
const posingViewer = () =>
  fakePhotoViewer({ pose: { position: { lon: -121.49, lat: 38.58 } } });

test('the CC BY-SA credit shows while Mapillary is on and goes with it', async (t) => {
  const { layer, viewer } = await startLayer(t);
  const shown = () => viewer.credits.map((credit) => credit.html);
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML], 'shown on enable');
  assert.match(shown()[0], /CC BY-SA 4\.0/);
  layer.setParams({ mapillary: false });
  assert.deepEqual(shown(), [], 'hidden with the switch');
  layer.setParams({ mapillary: true });
  assert.deepEqual(shown(), [MAPILLARY_CREDIT_HTML]);
  layer.disable();
  assert.deepEqual(shown(), [], 'the credit goes with the layer');
});

test('coverage asks for no tiles before the key status is known, and none without a key', async (t) => {
  for (const configured of [false, true]) {
    const status = deferred();
    const source = fakeMapillarySource({ getStatus: () => status.promise });
    const { layer } = await startLayer(t, { source, view: true });
    assert.equal(source.calls.tiles.length, 0, 'nothing before the status');
    status.resolve({ configured });
    await settle();
    if (configured) assert.ok(source.calls.tiles.length > 0, 'then coverage');
    else {
      assert.equal(
        source.calls.tiles.length,
        0,
        'a key-less install never asks',
      );
      assert.deepEqual(
        [layer.getStats().loadingLabel, layer.getStats().error],
        ['KEY REQUIRED', 'KEY REQUIRED'],
      );
      assert.equal(layer.getUIState().keyRequired, true);
      assert.equal(layer.getUIState().keyRejected, false);
    }
    layer.destroy();
  }
});

test('a key status that failed is asked again on the next switch-on', async (t) => {
  let up = false;
  let asked = 0;
  const source = fakeMapillarySource({
    hasToken: () => false,
    getStatus: async () => {
      asked++;
      if (!up) throw new TypeError('fetch failed');
      return { configured: true };
    },
  });
  const { layer, viewer } = await startLayer(t, { source, view: true });
  assert.equal(asked, 1, 'one check for init and the first switch-on');
  assert.equal(layer.getUIState().keyRequired, true);
  up = true; // the server is reachable again
  layer.disable();
  layer.enable(viewer);
  await settle();
  assert.equal(asked, 2);
  assert.equal(layer.getUIState().keyRequired, false);
  assert.ok(source.calls.tiles.length > 0, 'coverage loads');
  // A known key is not asked again.
  layer.disable();
  layer.enable(viewer);
  await settle();
  assert.equal(asked, 2);
});

test('a key status that never answers gives up, so the next switch-on asks again', async (t) => {
  // The check's timeout, fired when the test says.
  const timeouts = [];
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    const controller = new AbortController();
    timeouts.push({ ms, fire: () => controller.abort(new Error('timed out')) });
    return controller.signal;
  });
  let asked = 0;
  const source = fakeMapillarySource({
    hasToken: () => false,
    getStatus: ({ signal } = {}) =>
      new Promise((_, reject) => {
        asked++;
        signal?.addEventListener('abort', () => reject(signal.reason));
      }),
  });
  const { layer, viewer } = await startLayer(t, { source, view: true });
  assert.equal(asked, 1);
  assert.equal(timeouts[0].ms, 10_000, 'the check can be cut short');
  assert.equal(layer.getUIState().coverage.loading, true, 'LOADING meanwhile');
  timeouts[0].fire();
  await settle();
  assert.equal(layer.getUIState().coverage.loading, false);
  assert.equal(layer.getUIState().keyRequired, true, 'no token: KEY REQUIRED');
  layer.disable();
  layer.enable(viewer);
  assert.equal(asked, 2, 'asked again, not stuck on the first');
});

test('a rejected key gates the layer as KEY REJECTED until it goes off', async (t) => {
  const rejected = Object.assign(new Error('Mapillary rejected the token'), {
    keyRejected: true,
  });
  const source = fakeMapillarySource({
    getTile: async () => {
      throw rejected;
    },
  });
  const { layer, viewer } = await startLayer(t, { source, view: true });
  await settle();
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.equal(stats.loadingLabel, 'KEY REJECTED');
  assert.match(stats.error, /rejected MAPILLARY_CLIENT_TOKEN/);
  const ui = layer.getUIState();
  assert.deepEqual([ui.keyRequired, ui.keyRejected], [true, true]);
  layer.disable();
  layer.enable(viewer);
  assert.equal(layer.getUIState().keyRejected, false, 'asked again once on');
});

test('switching Mapillary off clears coverage and closes the image it shows', async (t) => {
  const { layer, photoViewer } = await startLayer(t);
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.deepEqual(photoViewer.calls.open, ['img1']);
  assert.equal(layer.getUIState().street.open, true);
  layer.setParams({ mapillary: false });
  assert.equal(photoViewer.calls.unmount, 1, 'its viewer is released');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().providers[0].on, false);
});

test('a sequence that fails to load reports it apart from the photo, and the error goes with it', async (t) => {
  const source = fakeMapillarySource({
    getSequenceImages: async () => {
      throw new Error('Sequence images unavailable');
    },
  });
  // The photo's pose names its sequence, which opening selects.
  const photoViewer = fakePhotoViewer({
    pose: { position: { lon: -121.49, lat: 38.58 }, sequenceId: 'seq-1' },
  });
  const { layer } = await startLayer(t, { source, photoViewer });
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  await settle();
  let ui = layer.getUIState();
  assert.equal(ui.sequence.error, 'Sequence images unavailable');
  assert.equal(ui.street.error, null, 'the photo itself is fine');
  layer.closeViewer();
  ui = layer.getUIState();
  assert.equal(ui.sequence.error, null, 'withdrawn with the sequence');
});

test('closing the photo, switching the layer off or destroying it stops the framing flight', async (t) => {
  const { layer, viewer } = await startLayer(t, {
    photoViewer: posingViewer(),
  });
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('mapillary', 'img1'), true);
  assert.equal(viewer.flights.started, 1, 'the photo is framed');
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 1, 'closed');

  await layer.openImage('mapillary', 'img2');
  layer.disable();
  assert.equal(viewer.flights.cancelled, 2, 'layer off');

  layer.enable(viewer);
  await layer.openImage('mapillary', 'img3');
  layer.destroy();
  assert.equal(viewer.flights.cancelled, 3, 'destroyed');
});

test('setParams takes "any date" (0 days) and the switch over the current values (share-link defaults)', async (t) => {
  const { layer } = await startLayer(t);
  assert.deepEqual(layer.getParams(), {
    mapillary: true,
    pano: 'all',
    sinceDays: 0,
  });
  layer.setParams({ pano: 'flat', sinceDays: 365 });
  assert.equal(layer.getParams().sinceDays, 365);
  layer.setParams({ sinceDays: 0 });
  assert.deepEqual(layer.getParams(), {
    mapillary: true,
    pano: 'flat',
    sinceDays: 0,
  });
  layer.setParams({ mapillary: false });
  assert.equal(layer.getParams().mapillary, false);
});

test('setParams ignores unknown keys and malformed values', async (t) => {
  const { layer } = await startLayer(t);
  layer.setParams({ pano: 'pano', sinceDays: 730 });
  layer.setParams({ mapillary: '0', kartaview: true, pano: 'weird', x: 1 });
  layer.setParams({ sinceDays: -3 });
  layer.setParams(null);
  assert.deepEqual(layer.getParams(), {
    mapillary: true,
    pano: 'pano',
    sinceDays: 730,
  });
});

test('switching Mapillary on while the layer is off draws nothing', async (t) => {
  const { layer, viewer, source, photoViewer } = await startLayer(t, {
    view: true,
    enable: false,
  });
  layer.attachViewerHost({});
  layer.setParams({ mapillary: false });
  layer.setParams({ mapillary: true });
  await settle();
  assert.equal(source.calls.tiles.length, 0, 'no coverage drawn');
  assert.deepEqual(viewer.credits, [], 'no credit shown');
  assert.equal(photoViewer.calls.mount, 0, 'no viewer stood up');
  assert.equal(layer.getUIState().providers[0].on, true, 'the switch is kept');
  // Enabling the layer is what draws it.
  layer.enable(viewer);
  await settle();
  assert.ok(source.calls.tiles.length > 0);
  assert.equal(viewer.credits.length, 1);
});

test('an empty provider composition enables and tears down without acquiring imagery', async (t) => {
  const { layer, viewer } = await startLayer(t, { providers: [] });
  assert.deepEqual(layer.providerIds, []);
  assert.deepEqual(layer.getUIState().providers, []);
  assert.equal(layer.getUIState().keyRequired, false);
  assert.match(
    layer.getUIState().coverage.hint,
    /No street-level imagery providers/,
  );
  layer.disable();
  layer.enable(viewer);
  assert.deepEqual(layer.getUIState().providers, []);
});

// ── Several providers: one source at a time, Google 3D, nearest lookups ──

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
      removeStaticCredit: (credit) => {
        // Cesium ignores a credit it does not hold.
        const at = credits.indexOf(credit);
        if (at !== -1) credits.splice(at, 1);
      },
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

function posingProvider(options) {
  const provider = fakeProvider(options);
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

/** The real Google provider over the Street View fakes, beside a Mapillary stand-in. */
async function withStreetView(
  t,
  { mapStack = 'photoreal', nearest, mapillaryKeyless = false } = {},
) {
  const { createGoogleProvider } = await import('./providers/google/index.js');
  const { fakeHost, fakeMapsLoader, fakeStreetViewLibrary } =
    await import('../../testSupport/googleStreetViewFakes.mjs');
  const fake = fakeStreetViewLibrary({
    panoramas: {
      'pano-a': { lat: 38.5816, lng: -121.4944, imageDate: '2024-05' },
    },
    nearest: nearest ?? (() => 'pano-a'),
  });
  const mapillaryLookups = [];
  const mapillary = fakeProvider({
    nearestImage: async (point) => {
      mapillaryLookups.push(point);
      return null;
    },
  });
  mapillary.requiresKeyId = 'mapillary';
  if (mapillaryKeyless) {
    mapillary.stats.keyRequired = true;
    const create = mapillary.create;
    mapillary.create = (context) => ({
      ...create(context),
      status: async () => ({ configured: false }),
    });
  }
  const loader = fakeMapsLoader(fake.library);
  const google = createGoogleProvider({
    getApiKey: () => 'browser-key',
    loader,
  });
  const { layer, viewer } = await enabledLayer(t, [mapillary, google]);
  const stack = fakeMapStack(mapStack);
  layer.attachMapStackController(stack);
  layer.attachViewerHost(fakeHost());
  return { layer, viewer, stack, fake, loader, mapillaryLookups };
}

test('Street View starts off, and the layer row names the key of the providers that are on', async (t) => {
  const { layer } = await withStreetView(t);
  const google = () =>
    layer.getUIState().providers.find((p) => p.id === 'google');
  assert.equal(google().on, false);
  assert.equal(layer.requiresKeyId, 'mapillary');
  layer.setProviderEnabled('google', true);
  assert.equal(layer.requiresKeyId, 'google-maps', 'Street View alone');
});

test('the layer starts with one source lit: the first that defaults on', async (t) => {
  const { layer } = await enabledLayer(t, [
    fakeProvider(),
    fakeProvider({ id: 'panoramax', pickPrefix: 'pmx:' }),
  ]);
  assert.deepEqual(
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id),
    ['mapillary'],
  );
});

test('leaving Google 3D during a Street View lookup ends it without an error or a stuck spinner', async (t) => {
  const { layer, stack, fake } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  let answer;
  fake.library.StreetViewService.prototype.getPanorama = () =>
    new Promise((resolve) => {
      answer = resolve;
    });
  const opening = layer.openNearest({ lat: 38.5816, lon: -121.4944 });
  await settle();
  assert.equal(layer.getUIState().street.loading, true);
  stack.switchTo('bing');
  answer({ data: { location: { pano: 'pano-a' }, imageDate: '2024-05' } });
  assert.equal(await opening, false);
  const { street } = layer.getUIState();
  assert.equal(street.loading, false, 'OPEN STREET VIEW is usable again');
  assert.equal(street.error, null);
  assert.equal(street.open, false);
});

test('a source swap during a lookup reports no false "no imagery"', async (t) => {
  let answer;
  const mapillary = fakeProvider({
    nearestImage: () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  });
  const other = fakeProvider({ id: 'panoramax', pickPrefix: 'pmx:' });
  const { layer } = await enabledLayer(t, [mapillary, other]);
  const opening = layer.openNearest({ lat: 1, lon: 2 });
  layer.setProviderEnabled('panoramax', true);
  answer('img-1');
  assert.equal(await opening, false);
  assert.equal(layer.getUIState().street.error, null);
  assert.equal(layer.getUIState().street.loading, false);
});

test('Street View lit off Google 3D says why the panel is empty', async (t) => {
  const { layer, stack } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  stack.switchTo('esri-imagery');
  assert.match(
    layer.getUIState().coverage.hint,
    /Google Street View needs the Google 3D map/,
  );
  layer.setProviderEnabled('mapillary', true);
  assert.doesNotMatch(layer.getUIState().coverage.hint, /Google 3D/);
});

test('one imagery source at a time: lighting one darkens the other, either way', async (t) => {
  const { layer } = await withStreetView(t);
  const lit = () =>
    layer
      .getUIState()
      .providers.filter((p) => p.on)
      .map((p) => p.id);
  assert.deepEqual(lit(), ['mapillary'], 'Mapillary by default: it is free');
  layer.setProviderEnabled('google', true);
  assert.deepEqual(lit(), ['google']);
  assert.equal(layer.getParams().mapillary, false);
  layer.setProviderEnabled('mapillary', true);
  assert.deepEqual(lit(), ['mapillary']);
  assert.equal(layer.getParams().google, false);
  // Params that light one switch to it; reapplying them changes nothing.
  layer.setParams({ google: true });
  assert.deepEqual(lit(), ['google']);
  layer.setParams({ google: true });
  assert.deepEqual(lit(), ['google']);
  // Params lighting both keep the one already on, however often applied.
  for (let i = 0; i < 2; i++) {
    layer.setParams({ mapillary: true, providerSwitches: 'google-1' });
    assert.deepEqual(lit(), ['google']);
  }
  layer.setParams({ mapillary: true, google: false });
  assert.deepEqual(lit(), ['mapillary']);
  // Filter-only params leave the source alone.
  layer.setParams({ pano: 'pano' });
  assert.deepEqual(lit(), ['mapillary']);
  // Darkening the only lit one leaves none: the panel turns the layer off.
  layer.setProviderEnabled('mapillary', false);
  assert.deepEqual(lit(), []);
});

test('Street View appears only on the Google 3D map: chip, credit, source and images', async (t) => {
  const { layer, viewer, stack } = await withStreetView(t, {
    mapStack: 'esri-imagery',
  });
  layer.setProviderEnabled('google', true);
  await settle();
  const ui = () => layer.getUIState();
  const listed = () => ui().providers.map((p) => p.id);
  const credited = () =>
    viewer.credits.some((credit) => /Street View imagery/.test(credit.html));
  assert.deepEqual(listed(), ['mapillary'], 'no Street View chip');
  assert.equal(credited(), false, 'no Google credit on another map');
  assert.equal(layer.source, 'Mapillary');
  assert.equal(layer.getStats().source, 'Mapillary');
  assert.equal(await layer.openImage('google', 'pano-a'), false);
  assert.match(ui().street.error, /needs the Google 3D map/);
  assert.equal(layer.getParams().google, true, 'the choice is kept');

  stack.switchTo('photoreal');
  assert.deepEqual(listed(), ['mapillary', 'google']);
  assert.equal(credited(), true);
  assert.equal(layer.source, 'Mapillary · Google Street View');
  assert.equal(await layer.openImage('google', 'pano-a'), true);
  assert.equal(ui().street.providerId, 'google');

  stack.switchTo('bing');
  await settle();
  assert.equal(ui().street.open, false, 'closed with the map');
  assert.equal(credited(), false);
  assert.deepEqual(listed(), ['mapillary']);
});

test('under Google 3D the ground is measured again once its tiles load, without a move', async (t) => {
  const saved = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = saved;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = fakeViewer();
  // 4 km up the ellipsoid, 2 km over a city whose tiles are still loading.
  let ground;
  viewer.camera.positionCartographic = { height: 4000 };
  viewer.scene.globe = { show: false };
  viewer.scene.sampleHeightSupported = true;
  viewer.scene.sampleHeight = () => ground;
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy());
  assert.equal(layer.getUIState().groundClickReady, false);

  ground = 2000;
  t.mock.timers.tick(1000);
  assert.equal(layer.getUIState().groundClickReady, true);
});

test('an unknown ground is measured only a few times, and not after the layer is off', (t) => {
  const saved = globalThis.document;
  globalThis.document = new EventTarget();
  t.after(() => {
    globalThis.document = saved;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const viewer = fakeViewer();
  let samples = 0;
  viewer.camera.positionCartographic = { height: 4000 };
  viewer.scene.globe = { show: false };
  viewer.scene.sampleHeightSupported = true;
  viewer.scene.sampleHeight = () => {
    samples++;
    return undefined;
  };
  const layer = createStreetLevelLayer({ providers: [fakeProvider()] });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => layer.destroy());
  t.mock.timers.tick(60_000);
  const measured = samples;
  assert.ok(measured > 1 && measured <= 12, `measured ${measured} times`);

  viewer.camera.moveEnd.raiseEvent();
  layer.disable();
  const atDisable = samples;
  t.mock.timers.tick(60_000);
  assert.equal(samples, atDisable, 'no measuring once the layer is off');
});

test('the UI state says when a click (or the button) can open Street View here', async (t) => {
  const { layer } = await withStreetView(t);
  assert.equal(typeof layer.getUIState().groundClickReady, 'boolean');
});

test('a lookup for the click-to-open providers asks only them and reports "that point"', async (t) => {
  const { layer, mapillaryLookups } = await withStreetView(t, {
    nearest: () => null,
  });
  layer.setProviderEnabled('google', true);
  await settle();
  const opened = await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.equal(opened, false);
  assert.deepEqual(mapillaryLookups, [], 'Mapillary was not asked');
  assert.equal(
    layer.getUIState().street.error,
    'No street-level imagery within 50 m of that point',
  );
});

test('the nearest-image refusal is written in the language of the page', async (t) => {
  const { layer } = await withStreetView(t, { nearest: () => null });
  layer.setProviderEnabled('google', true);
  await settle();
  setLocale('es');
  try {
    await layer.openNearest(
      { lat: 38.58, lon: -121.49 },
      { providerIds: ['google'], frame: false },
    );
    const error = layer.getUIState().street.error;
    assert.notEqual(error, 'No street-level imagery within 50 m of that point');
    assert.match(error, /50/, 'keeps the radius');
  } finally {
    setLocale('en');
  }
});

test('an image opened from a ground click leaves the camera where it is', async (t) => {
  const { layer, viewer } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  await settle();
  await layer.openNearest(
    { lat: 38.58, lon: -121.49 },
    { providerIds: ['google'], frame: false },
  );
  assert.equal(layer.getUIState().street.imageId, 'pano-a');
  assert.equal(viewer.flights.started, 0, 'no framing flight');
});

test('off Google 3D not even Google\u2019s script is loaded for Street View', async (t) => {
  const { layer, loader } = await withStreetView(t, {
    mapStack: 'esri-imagery',
  });
  layer.setProviderEnabled('google', true);
  layer.attachViewerHost({ ownerDocument: { createElement: () => ({}) } });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(loader.imports, [], 'no prewarm, no lookup');
});

test('the button’s “centre of the view” is the ground under the middle of the screen', async (t) => {
  const { createStreetLevelLayer: create } = await import('./index.js');
  const scenePick = await import('../../data/scenePick.js');
  const lookups = [];
  const provider = fakeProvider({
    nearestImage: async (point) => {
      lookups.push(point);
      return null;
    },
  });
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  const centre = Cesium.Cartesian3.fromDegrees(-121.4937, 38.5799, 0);
  Object.assign(viewer.scene, {
    pickPositionSupported: true,
    pickPosition: (at) => (at.x === 500 && at.y === 300 ? centre : undefined),
  });
  viewer.scene.canvas.clientWidth = 1000;
  viewer.scene.canvas.clientHeight = 600;
  const layer = create({ providers: [provider], services: { scenePick } });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  await layer.openNearest(undefined, { aim: 'screen-centre' });
  assert.equal(lookups.length, 1);
  assert.ok(Math.abs(lookups[0].lat - 38.5799) < 1e-9);
  assert.ok(Math.abs(lookups[0].lon - -121.4937) < 1e-9);
});

test('the button aimed at the sky opens nothing, and says to aim at a street', async (t) => {
  const { createStreetLevelLayer: create } = await import('./index.js');
  const scenePick = await import('../../data/scenePick.js');
  const lookups = [];
  const provider = fakeProvider({
    nearestImage: async (point) => {
      lookups.push(point);
      return null;
    },
  });
  const saved = globalThis.document;
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  const viewer = fakeViewer();
  // Every ground pick misses: the middle of the screen is sky.
  Object.assign(viewer.scene, {
    pickPositionSupported: true,
    pickPosition: () => undefined,
  });
  viewer.camera.pickEllipsoid = () => undefined;
  viewer.scene.canvas.clientWidth = 1000;
  viewer.scene.canvas.clientHeight = 600;
  const layer = create({ providers: [provider], services: { scenePick } });
  layer.init(viewer);
  layer.enable(viewer);
  t.after(() => {
    layer.destroy();
    globalThis.document = saved;
  });
  assert.equal(
    await layer.openNearest(undefined, { aim: 'screen-centre' }),
    false,
  );
  assert.deepEqual(lookups, [], 'no lookup at the view centre instead');
  const { street } = layer.getUIState();
  assert.match(street.error, /Aim the middle of the view at a street/);
  assert.equal(street.loading, false);
});

test('with no Mapillary token, the layer points at Street View, on Google 3D only', async (t) => {
  const { layer, stack } = await withStreetView(t, { mapillaryKeyless: true });
  await settle();
  const stats = layer.getStats();
  assert.equal(stats.keyRequired, true);
  assert.deepEqual(stats.keyAlternatives, [
    { id: 'google', label: 'GOOGLE STREET VIEW', requiresKeyId: 'google-maps' },
  ]);
  assert.deepEqual(layer.getUIState().keyAlternatives, stats.keyAlternatives);
  stack.switchTo('esri-imagery');
  assert.deepEqual(layer.getStats().keyAlternatives, [], 'not off Google 3D');
  // Lit, Street View draws: the layer is no longer key-gated.
  stack.switchTo('photoreal');
  layer.setProviderEnabled('google', true);
  assert.equal(layer.getStats().keyRequired, false);
});

test('a failed lookup’s error goes when another source is lit; a provider can open an image without framing', async (t) => {
  const failing = fakeProvider({
    nearestImage: async () => {
      throw new Error('KartaView did not answer in time — try again');
    },
  });
  const other = fakeProvider({ id: 'other', pickPrefix: 'oth:' });
  const { layer, viewer } = await enabledLayer(t, [failing, other]);
  layer.attachViewerHost({});
  await layer.openNearest({ lat: 1, lon: 1 });
  assert.match(layer.getUIState().street.error, /did not answer/);
  layer.setProviderEnabled('other', true);
  await settle();
  assert.equal(layer.getUIState().street.error, null);
  // A provider's own open (KartaView's ‹ ›) can leave the camera alone.
  await other.context().actions.openImage('img-1', { frame: false });
  assert.deepEqual(other.calls.open, ['img-1']);
  assert.equal(viewer.flights.started, 0);
});

test('a provider’s own open can leave the camera where it is; a default open frames', async (t) => {
  const provider = posingProvider();
  const { layer, viewer } = await enabledLayer(t, [provider]);
  layer.attachViewerHost({});
  await provider.context().actions.openImage('img-1', { frame: false });
  assert.deepEqual(provider.calls.open, ['img-1']);
  assert.equal(viewer.flights.started, 0, 'frame: false keeps the camera');
  await provider.context().actions.openImage('img-2');
  assert.equal(viewer.flights.started, 1, 'a default open frames the image');
});

test('a provider’s openNearest (a line click) asks only that provider and leaves the camera', async (t) => {
  const lit = posingProvider({ nearestImage: async () => 'lit-near' });
  const other = fakeProvider({
    id: 'other',
    pickPrefix: 'oth:',
    nearestImage: async () => 'other-near',
  });
  const { layer, viewer } = await enabledLayer(t, [lit, other]);
  layer.attachViewerHost({});
  const point = { lat: 38.58, lon: -121.49 };
  // The other source is off: its click asks nobody else.
  await other.context().actions.openNearest(point);
  await settle();
  assert.deepEqual(lit.calls.open, [], 'the lit source was not asked');
  assert.deepEqual(other.calls.open, []);
  await lit.context().actions.openNearest(point);
  assert.deepEqual(lit.calls.open, ['lit-near']);
  assert.equal(viewer.flights.started, 0, 'the user picked the spot');
});

test('KartaView through the core: its lines counted as streets', async (t) => {
  const kartaView = createKartaViewProvider({
    source: {
      getTile: async () => ({ lines: [] }),
      nearestPhotos: async () => [],
      getPhoto: async () => {
        throw new Error('KartaView has no such photo');
      },
      getSequencePhotos: async () => ({ photos: [], hasMore: false }),
      probeImage: async () => true,
    },
  });
  const { layer } = await enabledLayer(t, [kartaView]);
  layer.setProviderEnabled('kartaview', true);
  await settle();
  const ui = layer.getUIState();
  assert.equal(ui.coverage.label?.noun, 'streets');
});

test('switching source by params (the chip path) stops a running lookup and clears its spinner and error', async (t) => {
  const slow = slowLookups();
  const looking = fakeProvider({ nearestImage: slow.nearestImage });
  const other = fakeProvider({ id: 'other', pickPrefix: 'oth:' });
  const { layer } = await enabledLayer(t, [looking, other]);
  layer.attachViewerHost({});
  const opening = layer.openNearest({ lat: 1, lon: 1 });
  await settle();
  assert.equal(layer.getUIState().street.loading, true);
  layer.setParams({ mapillary: false, other: true });
  assert.equal(slow.lookups[0].signal.aborted, true, 'the lookup is stopped');
  assert.equal(
    layer.getUIState().street.loading,
    false,
    'no spinner left behind',
  );
  // The stopped lookup answers late: nothing opens, nothing is reported.
  slow.lookups[0].answer.resolve('img1');
  assert.equal(await opening, false);
  assert.deepEqual(looking.calls.open, []);
  assert.equal(layer.getUIState().street.error, null);
});

test('switching source by params clears a failed lookup’s error; reapplying the same switches does not', async (t) => {
  const failing = fakeProvider({
    nearestImage: async () => {
      throw new Error('KartaView did not answer in time — try again');
    },
  });
  const { layer: second } = await enabledLayer(t, [
    failing,
    fakeProvider({ id: 'other', pickPrefix: 'oth:' }),
  ]);
  second.attachViewerHost({});
  await second.openNearest({ lat: 1, lon: 1 });
  assert.match(second.getUIState().street.error, /did not answer/);
  second.setParams({ mapillary: false, other: true });
  assert.equal(second.getUIState().street.error, null);
  // Reapplying the same switches (a restore) leaves state alone.
  await second.openNearest({ lat: 1, lon: 1 });
  const kept = second.getUIState().street.error;
  assert.match(kept, /No street-level imagery/);
  second.setParams({ mapillary: false, other: true });
  assert.equal(second.getUIState().street.error, kept);
});

test('the panel says why a lit Street View draws nothing off Google 3D', async (t) => {
  const { presentStreetLevelPanel } =
    await import('../../ui/streetLevelPresentation.js');
  const { layer, stack } = await withStreetView(t);
  layer.setProviderEnabled('google', true);
  stack.switchTo('esri-imagery');
  const view = presentStreetLevelPanel(layer.getUIState());
  assert.match(view.meta, /Google Street View needs the Google 3D map/);
});
