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
const { createMapillaryViewer } = await import('./viewer.js');

/**
 * A viewer host over `adapter`. `marker` records where the position marker
 * was put (null once cleared), `framing` counts framing calls and
 * `selected` every sequence the layer was asked to select.
 */
function harness(adapter) {
  const state = {
    enabled: true,
    notify() {},
    street: { host: {}, renderMode: 'letterbox' },
    sequence: { selectedId: null },
  };
  const selected = [];
  const framing = { begun: 0, started: 0, cancelled: 0 };
  const marker = [];
  const parts = {
    marker: {
      set: (position, bearing) =>
        marker.push(position && { position, bearing }),
      clear: () => marker.push(null),
    },
    framing: {
      begin: () => ({ generation: ++framing.begun }),
      frame: (ticket) => ticket && framing.started++,
      cancel: () => framing.cancelled++,
    },
    sequences: {
      select(id) {
        selected.push(id);
        state.sequence.selectedId = id;
      },
    },
  };
  return {
    state,
    framing,
    marker,
    selected,
    /** Esc on the map: the selected sequence is dropped. */
    clearSequence() {
      state.sequence.selectedId = null;
    },
    host: createViewerHost({ state, parts, adapter }),
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
  await host.open('a');
  assert.equal(state.street.error, 'library failed to load');
  assert.equal(adapter.calls.listeners, 0, 'the pose listener was released');
  await host.open('b');
  assert.equal(state.street.error, null);
  assert.equal(adapter.calls.mount, 2);
  assert.deepEqual(adapter.calls.open, ['b']);
  assert.equal(state.street.imageId, 'b');
  assert.equal(state.street.externalUrl, 'https://example.test/b');
});

test('concurrent opens share one mount and one pose listener', async () => {
  const adapter = fakeAdapter();
  const { host } = harness(adapter);
  await Promise.all([host.open('a'), host.open('b')]);
  assert.equal(adapter.calls.mount, 1);
  assert.equal(adapter.calls.listeners, 1);
});

test('unmounting while a mount is in flight does not leave it active', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  const opening = host.open('a');
  host.unmount();
  await opening;
  assert.equal(adapter.calls.listeners, 0);
  assert.equal(adapter.calls.unmount, 2, 'layer off, then the late mount');
  assert.equal(state.street.open, false);
  // Not left active: the next open mounts again.
  await host.open('b');
  assert.equal(adapter.calls.mount, 2);
  assert.equal(state.street.imageId, 'b');
});

test('a pose that arrives after the photo was closed does not bring it back', async () => {
  const adapter = fakeAdapter();
  const { state, host } = harness(adapter);
  await host.open('a');
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test('every pose the viewer reports moves the marker; only the open frames the camera', async () => {
  const adapter = fakeAdapter();
  const { host, marker, framing } = harness(adapter);
  await host.open('a');
  assert.deepEqual(marker, [{ position: { lon: 1, lat: 2 }, bearing: 90 }]);
  // The user walks on: the marker goes along, the globe camera stays.
  adapter.emitPose('b', { position: { lon: 3, lat: 4 }, bearing: 180 });
  assert.deepEqual(marker.at(-1), {
    position: { lon: 3, lat: 4 },
    bearing: 180,
  });
  // Looking around in place is a pose too.
  adapter.emitPose('b', { position: { lon: 3, lat: 4 }, bearing: 270 });
  assert.equal(marker.at(-1).bearing, 270);
  assert.deepEqual([framing.begun, framing.started], [1, 1]);
});

test('a pose on another sequence selects it, but not while the image still loads', async () => {
  const openGate = deferred();
  const adapter = fakeAdapter({ openGate });
  const { state, host, selected, clearSequence } = harness(adapter);
  const opening = host.open('a');
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
  await host.open('a');
  assert.notEqual(marker.at(-1), null);
  host.close();
  assert.equal(marker.at(-1), null);
});

test('an open still mounting when the photo is closed does nothing when the mount lands', async () => {
  const gate = deferred();
  const adapter = fakeAdapter({ gate });
  const { state, host, framing, selected } = harness(adapter);
  const opening = host.open('a'); // MapillaryJS still loading
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
  assert.equal(await host.open('b'), true);
  assert.equal(state.street.imageId, 'b');
});

test('an image still opening when the photo is closed is neither framed nor selected', async () => {
  const openGate = deferred();
  const adapter = fakeAdapter({ openGate });
  const { state, host, framing, selected } = harness(adapter);
  const opening = host.open('a');
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
  const first = host.open('img1');
  await Promise.resolve();
  host.unmount();
  const second = host.open('img2');
  await Promise.resolve();
  gate.resolve();
  await Promise.all([first, second]);
  assert.equal(state.street.error, null);
  assert.equal(state.street.imageId, 'img2');
  await host.open('img3');
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

test('closing the photo stops sequence playback in the hidden viewer', async () => {
  const { gate, viewers } = fakeLibrary();
  gate.resolve();
  const adapter = createMapillaryViewer({ source: { token: 't' } });
  const { host } = harness(adapter);
  await host.open('img1');
  const [viewer] = viewers.instances;
  assert.equal(viewer.playback.stops, 0);
  host.close();
  assert.equal(viewer.playback.stops, 1, 'playback stopped with the photo');
  assert.equal(viewers.live, 1, 'the viewer itself stays warm');
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
  const { host, framing } = harness(adapter);
  const opening = host.open('a');
  assert.equal(framing.begun, 1, 'claimed before the download');
  await settle();
  assert.equal(framing.started, 0);
  openGate.resolve();
  assert.equal(await opening, true);
  assert.equal(framing.started, 1);
});
