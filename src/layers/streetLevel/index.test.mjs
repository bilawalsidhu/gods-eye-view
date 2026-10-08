import assert from 'node:assert/strict';
import test from 'node:test';
import * as Cesium from 'cesium';
import { createStreetLevelLayer } from './index.js';
import { MAPILLARY_CREDIT_HTML } from './providers/mapillary/policy.js';
import {
  fakeMapillarySource,
  fakePhotoViewer,
  rayCamera,
} from '../../testSupport/streetLevelFakes.mjs';

/**
 * A stand-in Cesium viewer the layer can be enabled on: a canvas for the
 * click handler, camera events, a primitive list and a credit display. With
 * `view`, the camera looks straight down on Sacramento from 900 m, so
 * coverage asks for tiles.
 */
function fakeViewer({ view = false } = {}) {
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
    ...(view ? { clientWidth: 100, clientHeight: 100 } : {}),
  });
  const camera = Object.assign(
    view
      ? rayCamera({
          lon: -121.4944,
          lat: 38.5816,
          altitude: 900,
          pitch: -90,
          width: 100,
          height: 100,
        })
      : {},
    {
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
  );
  return {
    credits,
    flights,
    scene: {
      canvas,
      primitives: { add: (p) => p, remove() {} },
      groundPrimitives: { add: (p) => p, remove() {} },
      // Enough of a scene for the position marker to clamp to the ground.
      frameState: { mode: Cesium.SceneMode.SCENE3D },
      updateHeight: () => () => {},
      getHeight: () => undefined,
    },
    camera,
    creditDisplay: {
      addStaticCredit: (credit) => credits.push(credit),
      removeStaticCredit: (credit) =>
        credits.splice(credits.indexOf(credit), 1),
    },
  };
}

/**
 * A layer over `source` and `photoViewer`, initialised on a stand-in viewer
 * and (unless `enable` is false) enabled.
 */
async function startLayer(
  t,
  {
    source = fakeMapillarySource(),
    photoViewer = fakePhotoViewer(),
    view = false,
    enable = true,
  } = {},
) {
  const saved = globalThis.document;
  // A pose moves the position marker, whose glyph is drawn on a canvas.
  const drawing = new Proxy({}, { get: () => () => ({ addColorStop() {} }) });
  globalThis.document = Object.assign(new EventTarget(), {
    createElement: () => ({ getContext: () => drawing }),
  });
  // Skip Cesium's one-time terrain table download for draped lines.
  t.mock.method(
    Cesium.GroundPolylinePrimitive,
    'initializeTerrainHeights',
    async () => {},
  );
  const viewer = fakeViewer({ view });
  const layer = createStreetLevelLayer({ source, photoViewer });
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
  assert.equal(await layer.openImage('img1'), true);
  assert.deepEqual(photoViewer.calls.open, ['img1']);
  assert.equal(layer.getUIState().street.open, true);
  layer.setParams({ mapillary: false });
  assert.equal(photoViewer.calls.unmount, 1, 'its viewer is released');
  assert.equal(layer.getUIState().street.open, false);
  assert.equal(layer.getUIState().providerOn, false);
});

test('a sequence error goes with the sequence and leaves the viewer’s own', async (t) => {
  const source = fakeMapillarySource({
    getSequenceImages: async () => {
      throw new Error('Sequence images unavailable');
    },
  });
  const { layer } = await startLayer(t, { source });
  await layer.selectSequence('seq-1');
  layer.attachViewerHost(null);
  await layer.openImage('img1');
  let ui = layer.getUIState();
  assert.equal(ui.sequence.error, 'Sequence images unavailable');
  assert.match(ui.street.error, /Open the Street Level panel/);
  layer.clearSequence();
  ui = layer.getUIState();
  assert.equal(ui.sequence.error, null, 'withdrawn with the sequence');
  assert.match(ui.street.error, /Open the Street Level panel/, 'kept');
});

test('closing the photo, switching the layer off or destroying it stops the framing flight', async (t) => {
  const { layer, viewer } = await startLayer(t, {
    photoViewer: posingViewer(),
  });
  layer.attachViewerHost({});
  assert.equal(await layer.openImage('img1'), true);
  assert.equal(viewer.flights.started, 1, 'the photo is framed');
  layer.closeViewer();
  assert.equal(viewer.flights.cancelled, 1, 'closed');

  await layer.openImage('img2');
  layer.disable();
  assert.equal(viewer.flights.cancelled, 2, 'layer off');

  layer.enable(viewer);
  await layer.openImage('img3');
  layer.destroy();
  assert.equal(viewer.flights.cancelled, 3, 'destroyed');
});

test('setParams takes "any date" (0 days) and the switch over the current values (share-link defaults)', async (t) => {
  assert.throws(() => createStreetLevelLayer({ source: {} }), /source/);
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

test('switching Mapillary on while the layer is off draws nothing (M01)', async (t) => {
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
  assert.equal(layer.getUIState().providerOn, true, 'the switch is kept');
  // Enabling the layer is what draws it.
  layer.enable(viewer);
  await settle();
  assert.ok(source.calls.tiles.length > 0);
  assert.equal(viewer.credits.length, 1);
});
