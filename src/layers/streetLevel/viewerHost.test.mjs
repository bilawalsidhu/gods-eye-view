import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import test from 'node:test';
import { createViewerHost } from './viewerHost.js';

// MapillaryJS needs a browser; the adapter tests swap in a stand-in library.
// Every import gets a fresh copy that waits for the current test's gate, so
// each test controls when its "download" finishes.
let libraryImports = 0;
registerHooks({
  resolve(specifier, context, next) {
    if (!specifier.startsWith('mapillary-js')) return next(specifier, context);
    const kind = specifier === 'mapillary-js' ? 'library' : 'asset';
    return {
      url: `gev-test-stub:mapillary-js/${kind}?${++libraryImports}`,
      shortCircuit: true,
    };
  },
  load(url, context, next) {
    if (!url.startsWith('gev-test-stub:mapillary-js/'))
      return next(url, context);
    const source = url.includes('/library?')
      ? 'const lib = await globalThis.__gevMapillaryLibrary();\n' +
        'export const Viewer = lib.Viewer;\n' +
        'export const RenderMode = lib.RenderMode;\n'
      : 'export default {};\n';
    return { format: 'module', shortCircuit: true, source };
  },
});
const { createMapillaryViewer } =
  await import('./providers/mapillary/viewer.js');

/**
 * A viewer host over `adapter`. `marker` records where the position marker
 * was put (null once cleared), `followed` counts camera-follow updates and
 * `selected` every sequence the provider was asked to select.
 */
function harness(adapter) {
  const state = {
    enabled: true,
    notify() {},
    providers: new Map(),
    street: { host: {}, renderMode: 'letterbox', follow: false },
  };
  const def = { id: 'mapillary', name: 'Mapillary', label: 'MAPILLARY' };
  const selected = [];
  let selectedId = null;
  const instance = {
    viewer: adapter,
    selectSequence(id) {
      selected.push(id);
      selectedId = id;
    },
    sequenceStats: () => ({ selectedId }),
  };
  state.providers.set('mapillary', { def, instance });
  const framing = { begun: 0, started: 0, cancelled: 0 };
  const marker = [];
  const followed = { count: 0 };
  const parts = {
    marker: {
      set: (position, bearing) =>
        marker.push(position && { position, bearing }),
      clear: () => marker.push(null),
    },
    follow: {
      followCamera: () => followed.count++,
      beginFraming: () => ({ generation: ++framing.begun }),
      lookAtPosition: (ticket) => ticket && framing.started++,
      cancelFraming: () => framing.cancelled++,
    },
  };
  return {
    state,
    framing,
    marker,
    followed,
    selected,
    /** Esc on the map: the provider drops its selected sequence. */
    clearSequence() {
      selectedId = null;
    },
    host: createViewerHost({ state, parts }),
  };
}

/**
 * A stand-in adapter. Like the real one, concurrent mounts share one
 * construction (`gate` holds it open) and `unmount` destroys the viewer that
 * every later `open` needs.
 */
function fakeAdapter({ failMounts = 0, gate = null, openGate = null } = {}) {
  const calls = { mount: 0, open: [], unmount: 0, listeners: 0 };
  let emit = null;
  let mounted = false;
  return {
    calls,
    async mount() {
      calls.mount++;
      const attempt = calls.mount;
      await gate?.promise;
      if (attempt <= failMounts) throw new Error('library failed to load');
      mounted = true;
    },
    /** A pose event from the library, as MapillaryJS fires them. */
    emitPose(id, overrides = {}) {
      emit?.({
        providerId: 'mapillary',
        imageId: id,
        sequenceId: `seq-${id}`,
        position: { lon: 1, lat: 2 },
        bearing: 90,
        isPano: false,
        externalUrl: `https://example.test/${id}`,
        ...overrides,
      });
    },
    /** Like MapillaryJS: the image event comes first, then `moveTo` settles. */
    async open(id) {
      if (!mounted) throw new Error('viewer is not mounted');
      calls.open.push(id);
      this.emitPose(id);
      await openGate?.promise;
    },
    close() {},
    unmount() {
      calls.unmount++;
      mounted = false;
    },
    resize() {},
    onPose(listener) {
      calls.listeners++;
      emit = listener;
      return () => {
        calls.listeners--;
        emit = null;
      };
    },
  };
}

test('a failed mount is retried on the next open instead of being cached', async () => {
  const adapter = fakeAdapter({ failMounts: 1 });
  const { state, host } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.equal(state.street.error, 'library failed to load');
  assert.equal(adapter.calls.listeners, 0, 'the pose listener was released');
  await host.open('mapillary', 'b');
  assert.equal(state.street.error, null);
  assert.equal(adapter.calls.mount, 2);
  assert.deepEqual(adapter.calls.open, ['b']);
  assert.equal(state.street.imageId, 'b');
  assert.equal(state.street.externalUrl, 'https://example.test/b');
});

test('concurrent opens share one mount and one pose listener', async () => {
  const adapter = fakeAdapter();
  const { host } = harness(adapter);
  await Promise.all([host.open('mapillary', 'a'), host.open('mapillary', 'b')]);
  assert.equal(adapter.calls.mount, 1);
  assert.equal(adapter.calls.listeners, 1);
});

test('unmounting while a mount is in flight does not leave it active', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  host.unmount();
  await opening;
  assert.equal(adapter.calls.listeners, 0);
  assert.equal(adapter.calls.unmount, 1);
  assert.equal(state.street.open, false);
  // Not left active: the next open mounts again.
  await host.open('mapillary', 'b');
  assert.equal(adapter.calls.mount, 2);
  assert.equal(state.street.imageId, 'b');
});

test('a prewarmed viewer is released when the layer goes off, or at once if it went off mid-load', async () => {
  const adapter = fakeAdapter();
  let release = null;
  adapter.prewarm = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;

  // Warmed, then the layer is switched off: unmount releases the warm viewer.
  const warming = host.prewarm([entry]);
  release();
  await warming;
  assert.equal(adapter.calls.unmount, 0);
  host.unmount();
  assert.equal(adapter.calls.unmount, 1, 'the WebGL viewer is destroyed');

  // Switched off while the library was still loading: released on arrival.
  const late = host.prewarm([entry]);
  state.enabled = false;
  release();
  await late;
  assert.equal(adapter.calls.unmount, 2);
});

test('switching one provider off releases only its viewer', async () => {
  const adapter = fakeAdapter();
  adapter.prewarm = async () => {};
  const { state, host } = harness(adapter);
  const entry = state.providers.get('mapillary');
  entry.on = true;
  await host.prewarm([entry]);
  host.unmount('panoramax');
  assert.equal(adapter.calls.unmount, 0, 'another provider leaves it alone');
  host.unmount('mapillary');
  assert.equal(adapter.calls.unmount, 1);
});

test('a pose that arrives after the photo was closed does not bring it back', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  await host.open('mapillary', 'a');
  host.close();
  const before = { ...state.street };
  // The library's `image` event for a photo that was still loading.
  adapter.emitPose('a');
  assert.equal(state.street.open, false);
  assert.equal(state.street.imageId, null);
  assert.equal(state.street.sequenceId, null);
  assert.deepEqual(state.street, before);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('switching the layer off and on during a cold first open keeps the shared viewer', async () => {
  const gate = deferred();
  const adapter = fakeAdapter({ gate });
  const { state, host } = harness(adapter);
  const first = host.open('mapillary', 'a'); // the library is still loading
  host.unmount(); // layer off …
  const second = host.open('mapillary', 'b'); // … on again, and a new click
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(adapter.calls.unmount, 0, 'the outdated mount left it alone');
  assert.equal(adapter.calls.listeners, 1);
  assert.equal(state.street.error, null);
  assert.equal(state.street.imageId, 'b');
  await host.open('mapillary', 'c');
  assert.equal(state.street.error, null, 'later opens are not stuck');
  assert.equal(state.street.imageId, 'c');
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('every pose the viewer reports moves the marker and the followed camera', async () => {
  const adapter = fakeAdapter();
  const { state, host, marker, followed } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.deepEqual(marker, [{ position: { lon: 1, lat: 2 }, bearing: 90 }]);
  assert.equal(followed.count, 1);
  // The user walks on, with FOLLOW on: the globe camera goes along.
  state.street.follow = true;
  adapter.emitPose('b', { position: { lon: 3, lat: 4 }, bearing: 180 });
  assert.deepEqual(marker.at(-1), {
    position: { lon: 3, lat: 4 },
    bearing: 180,
  });
  assert.equal(followed.count, 2);
  // Looking around in place is a pose too.
  adapter.emitPose('b', { position: { lon: 3, lat: 4 }, bearing: 270 });
  assert.equal(marker.at(-1).bearing, 270);
  assert.equal(followed.count, 3);
});

test('a pose on another sequence selects it, but not while the image still loads', async () => {
  const openGate = deferred();
  const adapter = fakeAdapter({ openGate });
  const { state, host, selected, clearSequence } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  await settle();
  assert.equal(state.street.loading, true, 'the image is downloading');
  assert.equal(state.street.sequenceId, 'seq-a', 'its pose is in');
  assert.deepEqual(selected, [], 'no sequence lookup competes with it');
  openGate.resolve();
  assert.equal(await opening, true);
  assert.deepEqual(selected, ['seq-a']);
  // Stepping onto the next sequence (an arrow at a junction) selects it …
  adapter.emitPose('b');
  assert.deepEqual(selected, ['seq-a', 'seq-b']);
  // … and walking along it does not ask again.
  adapter.emitPose('c', { sequenceId: 'seq-b' });
  assert.deepEqual(selected, ['seq-a', 'seq-b']);
  // Once Esc cleared it, looking around on the same sequence leaves it so.
  clearSequence();
  adapter.emitPose('c', { sequenceId: 'seq-b', bearing: 10 });
  assert.deepEqual(selected, ['seq-a', 'seq-b']);
});

test('closing the photo clears the marker', async () => {
  const adapter = fakeAdapter();
  const { host, marker } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.notEqual(marker.at(-1), null);
  host.close();
  assert.equal(marker.at(-1), null);
});

test('an open still mounting when the photo is closed does nothing when the mount lands', async () => {
  const gate = deferred();
  const adapter = fakeAdapter({ gate });
  const { state, host, framing, selected } = harness(adapter);
  const opening = host.open('mapillary', 'a'); // MapillaryJS still loading
  await settle();
  host.close();
  gate.resolve();
  assert.equal(await opening, false);
  assert.deepEqual(adapter.calls.open, [], 'the image is never opened');
  assert.equal(framing.started, 0, 'the globe does not fly to it');
  assert.deepEqual(selected, []);
  assert.deepEqual(
    [state.street.open, state.street.loading, state.street.imageId],
    [false, false, null],
  );
  // The mounted viewer serves the next open.
  assert.equal(await host.open('mapillary', 'b'), true);
  assert.equal(state.street.imageId, 'b');
});

test('an image still opening when the photo is closed is neither framed nor selected', async () => {
  const openGate = deferred();
  const adapter = fakeAdapter({ openGate });
  const { state, host, framing, selected } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  await settle();
  assert.deepEqual(adapter.calls.open, ['a'], 'the image is downloading');
  host.close();
  openGate.resolve();
  assert.equal(await opening, false);
  assert.equal(framing.started, 0, 'the globe does not fly to it');
  assert.deepEqual(selected, []);
  assert.deepEqual(
    [state.street.open, state.street.loading, state.street.imageId],
    [false, false, null],
  );
});

/**
 * MapillaryJS, counting live viewers (each holds a WebGL context). A test can
 * hold `moveTo(id)` on `viewers.moveGates.get(id)` and every position read on
 * `viewers.positionGate`, and fire a viewer's events through `handlers`.
 */
function fakeLibrary() {
  const gate = deferred();
  const viewers = {
    created: 0,
    live: 0,
    instances: [],
    moveGates: new Map(),
    moves: [],
    positionGate: null,
  };
  class Viewer {
    constructor(options) {
      this.options = options;
      viewers.created++;
      viewers.live++;
      viewers.instances.push(this);
      this.removed = false;
      this.playback = { stops: 0 };
      this.handlers = {};
    }
    /** The sequence component's play/stop API, as MapillaryJS 4 exposes it. */
    getComponent(name) {
      if (name !== 'sequence') return undefined;
      return { stop: () => this.playback.stops++ };
    }
    on(type, handler) {
      this.handlers[type] = handler;
    }
    async getPosition() {
      await viewers.positionGate?.promise;
      return { lng: 1, lat: 2 };
    }
    async getPointOfView() {
      return { bearing: 10, tilt: 0 };
    }
    async moveTo(id) {
      viewers.moves.push(id);
      await viewers.moveGates.get(id)?.promise;
      return { id, cameraType: 'perspective', sequenceId: `seq-${id}` };
    }
    remove() {
      if (this.removed) return;
      this.removed = true;
      viewers.live--;
    }
    setRenderMode() {}
    resize() {}
  }
  globalThis.__gevMapillaryLibrary = async () => {
    await gate.promise;
    return { Viewer, RenderMode: {} };
  };
  return { gate, viewers };
}

test('the Mapillary viewer survives the layer going off and on during its first download', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const { state, host } = harness(adapter);
  const first = host.open('mapillary', 'img1');
  await Promise.resolve();
  host.unmount();
  const second = host.open('mapillary', 'img2');
  await Promise.resolve();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(state.street.error, null);
  assert.equal(state.street.imageId, 'img2');
  await host.open('mapillary', 'img3');
  assert.equal(state.street.error, null, 'later opens are not stuck');
  assert.equal(state.street.imageId, 'img3');
  assert.equal(viewers.live, 1);
});

test('a Mapillary viewer unmounted mid-download is never built; the next mount builds afresh', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const element = {};
  const stale = adapter.mount(element);
  adapter.unmount();
  const fresh = adapter.mount(element);
  gate.resolve();
  await assert.rejects(stale, /unmounted/);
  await fresh;
  assert.equal(viewers.created, 1, 'only the fresh mount built one');
  await adapter.open('x');
  adapter.unmount();
  assert.equal(viewers.live, 0, 'nothing left holding a WebGL context');
});

test('a prewarm that gave up when the layer went off and on mid-download is followed by one that builds', async () => {
  const { gate, viewers } = fakeLibrary();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const element = {};
  const first = adapter.prewarm(element);
  adapter.unmount(); // layer off while MapillaryJS downloads
  const second = adapter.prewarm(element); // layer on again
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(viewers.created, 1, 'the second prewarm built the viewer');
  assert.equal(viewers.live, 1);
  adapter.unmount();
});

test('the Mapillary viewer leaves resizing to the panel, so a hidden one never asks for z=NaN', async () => {
  const { gate, viewers } = fakeLibrary();
  gate.resolve();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  await adapter.mount({});
  assert.equal(viewers.instances[0].options.trackResize, false);
  adapter.unmount();
});

test('closing the photo stops sequence playback in the hidden viewer', async () => {
  const { gate, viewers } = fakeLibrary();
  gate.resolve();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const { host } = harness(adapter);
  await host.open('mapillary', 'img1');
  const [viewer] = viewers.instances;
  assert.equal(viewer.playback.stops, 0);
  host.close();
  assert.equal(viewer.playback.stops, 1, 'playback stopped with the photo');
  assert.equal(viewers.live, 1, 'the viewer itself stays warm');
});

test('closing the photo or switching the layer off stops its framing flight', async () => {
  const adapter = fakeAdapter();
  const { framing, host } = harness(adapter);
  await host.open('mapillary', 'a');
  assert.equal(framing.started, 1, 'the open framed the photo');
  host.close();
  assert.equal(framing.cancelled, 1, 'closed: the globe stops flying to it');
  await host.open('mapillary', 'b');
  host.unmount('panoramax');
  assert.equal(framing.cancelled, 1, 'another provider leaves it alone');
  host.unmount();
  assert.equal(framing.cancelled, 2, 'layer off: likewise');
});

/** The real Mapillary adapter, mounted on a ready library, and its poses. */
async function mountedMapillary() {
  const library = fakeLibrary();
  library.gate.resolve();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const poses = [];
  adapter.onPose((pose) => poses.push(pose));
  await adapter.mount({});
  return { ...library, adapter, poses };
}

test('a Mapillary pose still being read when the photo closes is never emitted (M57)', async () => {
  const { viewers, adapter, poses } = await mountedMapillary();
  await adapter.open('a');
  assert.deepEqual(
    poses.map((pose) => pose.imageId),
    ['a'],
  );
  // The library steps to the next image; its position is still being read.
  const [viewer] = viewers.instances;
  viewers.positionGate = deferred();
  viewer.handlers.image({
    image: { id: 'b', cameraType: 'perspective', sequenceId: 'seq-b' },
  });
  adapter.close();
  viewers.positionGate.resolve();
  await settle();
  assert.deepEqual(
    poses.map((pose) => pose.imageId),
    ['a'],
    'the closed photo does not come back',
  );
});

test('a Mapillary image overtaken by a newer open emits no pose when it lands (M58)', async () => {
  const { viewers, adapter, poses } = await mountedMapillary();
  const gateA = deferred();
  const gateB = deferred();
  viewers.moveGates.set('a', gateA);
  viewers.moveGates.set('b', gateB);
  const openA = adapter.open('a');
  await settle(); // A's image is downloading …
  const openB = adapter.open('b'); // … when the user picks another one
  gateA.resolve();
  await openA;
  assert.deepEqual(poses, [], 'nothing for the image the user left');
  gateB.resolve();
  await openB;
  assert.deepEqual(
    poses.map((pose) => [pose.imageId, pose.sequenceId]),
    [['b', 'seq-b']],
  );
});

test('back-to-back Mapillary opens download only the newer image', async () => {
  const { viewers, adapter, poses } = await mountedMapillary();
  await Promise.all([adapter.open('a'), adapter.open('b')]);
  assert.deepEqual(viewers.moves, ['b']);
  assert.deepEqual(
    poses.map((pose) => pose.imageId),
    ['b'],
  );
});

test('a photo asks for the camera when it starts opening and frames with that ticket once loaded', async () => {
  const openGate = deferred();
  const adapter = fakeAdapter({ openGate });
  const { state, host, framing } = harness(adapter);
  const opening = host.open('mapillary', 'a');
  assert.equal(framing.begun, 1, 'claimed before the download');
  await settle();
  assert.equal(framing.started, 0);
  openGate.resolve();
  assert.equal(await opening, true);
  assert.equal(framing.started, 1);

  // FOLLOW owns the camera already: an open neither claims nor frames.
  state.street.follow = true;
  assert.equal(await host.open('mapillary', 'b'), true);
  assert.deepEqual([framing.begun, framing.started], [1, 1]);
});

/** The harness with a second provider, `google`, whose adapter has no render modes. */
function twoProviders() {
  const mapillary = fakeAdapter();
  mapillary.prewarm = async () => {};
  mapillary.setRenderMode = () => {};
  const google = fakeAdapter();
  google.prewarm = async () => {};
  const h = harness(mapillary);
  h.state.providers.set('google', {
    def: { id: 'google', name: 'Google Street View', label: 'STREET VIEW' },
    instance: { viewer: google },
    on: true,
  });
  h.state.providers.get('mapillary').on = true;
  return { ...h, mapillary, google };
}

test("opening one provider's image releases another's prewarmed viewer in the shared host", async () => {
  const { state, host, mapillary, google } = twoProviders();
  await host.prewarm([state.providers.get('mapillary')]);
  assert.equal(mapillary.calls.unmount, 0, 'warm');
  await host.open('google', 'g-1');
  assert.equal(mapillary.calls.unmount, 1, 'not left under the panorama');
  assert.equal(google.calls.unmount, 0);
  // While Google shows, Mapillary is not built again under it.
  let built = 0;
  mapillary.prewarm = async () => built++;
  await host.prewarm([...state.providers.values()]);
  assert.equal(built, 0);
});

test('the render modes follow the viewer that is open', async () => {
  const { state, host } = twoProviders();
  await host.open('mapillary', 'm-1');
  assert.equal(state.street.renderModes, true);
  await host.open('google', 'g-1');
  assert.equal(state.street.renderModes, false, 'Google always fills');
});

test('a pose can date its image by month and name its place', async () => {
  const { state, host, google } = twoProviders();
  await host.open('google', 'g-1');
  google.emitPose('g-1', {
    providerId: 'google',
    capturedAtPrecision: 'month',
    title: '1014 10th St',
    capturedAt: Date.UTC(2023, 0, 1),
  });
  assert.equal(state.street.capturedAtPrecision, 'month');
  assert.equal(state.street.title, '1014 10th St');
  host.close();
  assert.deepEqual(
    [state.street.capturedAtPrecision, state.street.title],
    ['day', null],
  );
});

test('a prewarm that lands after another provider took the host is released, not built under it', async () => {
  const { state, host, mapillary } = twoProviders();
  let release;
  mapillary.prewarm = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const warming = host.prewarm([state.providers.get('mapillary')]);
  await host.open('google', 'g-1'); // the user opens Street View meanwhile
  release();
  await warming;
  assert.equal(mapillary.calls.unmount, 1, 'released at once');
  // Not kept warm: the next Mapillary open mounts afresh.
  await host.open('mapillary', 'm-1');
  assert.equal(state.street.providerId, 'mapillary');
});

test('FIT/FILL stays hidden for a second Street View panorama after a close', async () => {
  const { state, host } = twoProviders();
  await host.open('google', 'g-1');
  assert.equal(state.street.renderModes, false);
  host.close();
  await host.open('google', 'g-2');
  assert.equal(state.street.renderModes, false);
});
