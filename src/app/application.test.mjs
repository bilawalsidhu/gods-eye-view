import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createApplication } from './application.js';
import {
  installTrackpadPinchZoom,
  clampResolutionToTextureLimits,
  installTextureLimitGuard,
  setRequestedResolutionScale,
} from './viewer.js';

const phases = ['Scene', 'Controls', 'Data', 'Tools'];
function fixture(overrides = {}) {
  const events = [];
  const constructors = Object.fromEntries(
    phases.map((phase) => [
      `create${phase}`,
      ({ defer }) => {
        events.push(`start:${phase}`);
        defer(() => events.push(`stop:${phase}`));
        return { name: phase };
      },
    ]),
  );
  return { events, app: createApplication({ ...constructors, ...overrides }) };
}
function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('importing and constructing the package is inactive without browser globals', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `
    globalThis.fetch = () => { throw new Error('unexpected request'); };
    globalThis.setTimeout = () => { throw new Error('unexpected timer'); };
    const { createApplication } = await import('gods-eye-view/application');
    const fail = () => { throw new Error('unexpected construction'); };
    const app = createApplication({ createScene: fail, createControls: fail, createData: fail, createTools: fail });
    if (app.getState().status !== 'created') process.exit(1);
  `,
    ],
    { cwd: new URL('../../', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('constructors are validated before allocating anything', () => {
  assert.throws(() => createApplication({}), /Missing scene constructor/);
});

test('startup shares one promise and teardown keeps data alive for controls', async () => {
  const { app, events } = fixture({
    createTools({ scene, controls, data, defer }) {
      assert.equal(scene.name, 'Scene');
      assert.equal(controls.name, 'Controls');
      assert.equal(data.name, 'Data');
      defer(() => events.push('stop:Tools'));
      return { name: 'Tools' };
    },
  });
  const states = [];
  app.subscribe((state) => states.push(`${state.status}:${state.phase}`));
  const started = app.start();
  assert.equal(started, app.start());
  const components = await started;
  assert.ok(Object.isFrozen(components));
  assert.equal(components.tools.name, 'Tools');
  assert.equal(app.getState().status, 'ready');
  const stopped = app.destroy();
  assert.equal(stopped, app.destroy());
  await stopped;
  assert.deepEqual(events.slice(-4), [
    'stop:Tools',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.deepEqual(app.getComponents(), {});
  assert.equal(states.at(-1), 'destroyed:null');
  await assert.rejects(app.start(), /destroyed/);
});

for (const phase of phases) {
  test(`failure during ${phase} releases partially acquired resources`, async () => {
    const { app, events } = fixture({
      [`create${phase}`]({ defer }) {
        defer(() => events.push('partial:released'));
        throw new Error('broken constructor');
      },
    });
    await assert.rejects(app.start(), /broken constructor/);
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
    assert.equal(app.getState().status, 'failed');
    assert.deepEqual(app.getComponents(), {});
    await app.destroy();
    assert.equal(
      events.filter((value) => value === 'partial:released').length,
      1,
    );
  });
}

test('destroy before startup prevents every constructor', async () => {
  const { app, events } = fixture();
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await app.destroy();
  await failed;
  assert.deepEqual(events, []);
});

test('destroy aborts an in-flight constructor and cleans late acquisitions before resolving', async () => {
  const gate = deferred();
  const entered = deferred();
  let observedSignal;
  const { app, events } = fixture({
    async createScene({ signal, defer }) {
      observedSignal = signal;
      entered.resolve();
      await gate.promise;
      defer(() => events.push('late:released'));
      return {};
    },
  });
  const started = app.start();
  const failed = assert.rejects(started, { name: 'AbortError' });
  await entered.promise;
  let settled = false;
  const stopped = app.destroy().then(() => {
    settled = true;
  });
  assert.equal(observedSignal.aborted, true);
  await Promise.resolve();
  assert.equal(settled, false);
  gate.resolve();
  await stopped;
  await failed;
  assert.deepEqual(events, ['late:released']);
});

test('cleanup errors are reported after all remaining resources are attempted', async () => {
  const { app, events } = fixture({
    createTools({ defer }) {
      defer(() => events.push('tools:earlier'));
      defer(() => {
        throw new Error('dispose failed');
      });
      return {};
    },
  });
  await app.start();
  await assert.rejects(app.destroy(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors[0].message, 'dispose failed');
    return true;
  });
  assert.deepEqual(events.slice(-4), [
    'tools:earlier',
    'stop:Controls',
    'stop:Data',
    'stop:Scene',
  ]);
  assert.equal(app.getState().status, 'failed');
});

test('subscribers can destroy during startup without allowing the next constructor', async () => {
  const { app, events } = fixture();
  app.subscribe((state) => {
    if (state.phase === 'controls') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.deepEqual(events, ['start:Scene', 'stop:Scene']);
});

test('destroy during ready notification rejects startup and tears everything down', async () => {
  const { app } = fixture();
  app.subscribe((state) => {
    if (state.status === 'ready') void app.destroy();
  });
  await assert.rejects(app.start(), { name: 'AbortError' });
  await app.destroy();
  assert.equal(app.getState().status, 'destroyed');
});

test('cleanup registration closes when a constructor settles', async () => {
  let register;
  const { app } = fixture({
    createScene({ defer }) {
      register = defer;
      return {};
    },
  });
  await app.start();
  assert.throws(() => register(() => {}), /during component construction/);
  await app.destroy();
});

test('different application instances do not share lifecycle state', async () => {
  const first = fixture();
  const second = fixture();
  await Promise.all([first.app.start(), second.app.start()]);
  await first.app.destroy();
  assert.equal(second.app.getState().status, 'ready');
  assert.equal(second.events.length, 4);
  await second.app.destroy();
});

test('the separate viewer export imports without constructing a browser viewer', async () => {
  const { createApplicationViewer } =
    await import('gods-eye-view/application/viewer');
  assert.equal(typeof createApplicationViewer, 'function');
  assert.throws(() => createApplicationViewer({}), /containers are required/);
});

function pinchFixture({ zoomEventTypes } = {}) {
  const handlers = new Set();
  const relayed = [];
  const container = {
    addEventListener(type, handler, options) {
      assert.equal(type, 'wheel');
      assert.deepEqual(options, { capture: true, passive: false });
      handlers.add(handler);
    },
    removeEventListener(type, handler, capture) {
      assert.equal(type, 'wheel');
      assert.equal(capture, true);
      handlers.delete(handler);
    },
    emit(event) {
      for (const handler of handlers) handler(event);
    },
  };
  const canvas = {
    dispatchEvent(event) {
      // A real canvas dispatch crosses the container's capture listener again.
      container.emit(event);
      relayed.push(event);
      return true;
    },
  };
  const controller = { zoomEventTypes };
  const viewer = {
    container,
    canvas,
    scene: { screenSpaceCameraController: controller },
  };
  const createEvent = (init = {}) => ({
    deltaX: 0,
    deltaY: 0,
    deltaZ: 0,
    deltaMode: 0,
    screenX: 0,
    screenY: 0,
    clientX: 0,
    clientY: 0,
    ctrlKey: false,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.propagationStopped = true;
    },
    ...init,
  });
  return { viewer, controller, container, handlers, relayed, createEvent };
}

test('trackpad pinch adds the Ctrl+wheel binding without replacing Cesium inputs', () => {
  const original = [1, 2, 3];
  const f = pinchFixture({ zoomEventTypes: original });
  const dispose = installTrackpadPinchZoom(f.viewer, {
    createWheelEvent: (_type, init) => f.createEvent(init),
  });
  assert.deepEqual(f.controller.zoomEventTypes.slice(0, 3), original);
  assert.equal(f.controller.zoomEventTypes.length, 4);

  const plain = f.createEvent({ deltaY: 2 });
  f.container.emit(plain);
  assert.equal(plain.defaultPrevented, false);
  const lineMode = f.createEvent({ ctrlKey: true, deltaY: 2, deltaMode: 1 });
  f.container.emit(lineMode);
  assert.equal(lineMode.defaultPrevented, false);
  assert.equal(f.relayed.length, 0);

  dispose();
  dispose();
  assert.equal(f.controller.zoomEventTypes, original);
  assert.equal(f.handlers.size, 0);
});

test('trackpad pinch relays pixel deltas once with bounded amplification', () => {
  const f = pinchFixture({ zoomEventTypes: [1, 2, 3] });
  installTrackpadPinchZoom(f.viewer, {
    createWheelEvent: (_type, init) => f.createEvent(init),
  });

  const small = f.createEvent({ ctrlKey: true, deltaY: 2 });
  f.container.emit(small);
  assert.equal(small.defaultPrevented, true);
  assert.equal(small.propagationStopped, true);
  assert.equal(f.relayed.length, 1);
  assert.equal(f.relayed[0].deltaY, 16);
  assert.equal(f.relayed[0].ctrlKey, true);

  const large = f.createEvent({ ctrlKey: true, deltaY: -100 });
  f.container.emit(large);
  assert.equal(f.relayed.length, 2);
  assert.equal(f.relayed[1].deltaY, -120);
});

test('trackpad pinch falls back to the original event when relay construction fails', () => {
  const f = pinchFixture({ zoomEventTypes: [1, 2, 3] });
  installTrackpadPinchZoom(f.viewer, {
    createWheelEvent() {
      throw new Error('unsupported');
    },
  });
  const event = f.createEvent({ ctrlKey: true, deltaY: 2 });
  f.container.emit(event);
  assert.equal(event.defaultPrevented, false);
  assert.equal(event.propagationStopped, false);
  assert.equal(f.relayed.length, 0);
});

test('clampResolutionToTextureLimits constrains resolutionScale on high-res displays (#905)', () => {
  const getLimit = () => 2048;

  // Case 1: 2560x1440 screen on a GPU with 2048 maxTextureSize (Issue #905 exact repro)
  const viewer = {
    resolutionScale: 1.0,
    canvas: { clientWidth: 2560, clientHeight: 1440 },
  };
  clampResolutionToTextureLimits(viewer, { getLimit });
  assert.equal(viewer.resolutionScale, 2048 / 2560);
  assert.equal(viewer.canvas.clientWidth * viewer.resolutionScale, 2048);

  // Case 2: Display within limit remains at requested scale (1.0)
  const viewer1080p = {
    resolutionScale: 1.0,
    canvas: { clientWidth: 1920, clientHeight: 1080 },
  };
  clampResolutionToTextureLimits(viewer1080p, { getLimit });
  assert.equal(viewer1080p.resolutionScale, 1.0);

  // Case 3: Resizing smaller restores resolutionScale back to requested scale (1.0)
  viewer.canvas.clientWidth = 1920;
  viewer.canvas.clientHeight = 1080;
  clampResolutionToTextureLimits(viewer, { getLimit });
  assert.equal(viewer.resolutionScale, 1.0);

  // Case 4: A deliberately lower requested scale (e.g. 0.75 preset) stays put when window shrinks
  const viewerPreset = {
    resolutionScale: 0.75,
    canvas: { clientWidth: 3840, clientHeight: 2160 },
  };
  // On 4K with 2048 limit: maxAllowedScale = 2048 / 3840
  clampResolutionToTextureLimits(viewerPreset, { getLimit });
  assert.equal(viewerPreset.resolutionScale, 2048 / 3840);
  // Shrinking window to 1080p restores requested preset 0.75, staying put
  viewerPreset.canvas.clientWidth = 1920;
  viewerPreset.canvas.clientHeight = 1080;
  clampResolutionToTextureLimits(viewerPreset, { getLimit });
  assert.equal(viewerPreset.resolutionScale, 0.75);

  // Case 5: When useBrowserRecommendedResolution is false, accounts for devicePixelRatio
  const viewerRetina = {
    resolutionScale: 1.0,
    useBrowserRecommendedResolution: false,
    canvas: { clientWidth: 1600, clientHeight: 900 },
  };
  clampResolutionToTextureLimits(viewerRetina, {
    getLimit,
    getPixelRatio: () => 2.0,
  });
  // 1600 * 2.0 = 3200 > 2048 => 2048 / 3200 = 0.64
  assert.equal(viewerRetina.resolutionScale, 2048 / 3200);

  // Case 6: Safe with incomplete viewer or missing limits
  clampResolutionToTextureLimits(null);
  clampResolutionToTextureLimits({});
  clampResolutionToTextureLimits(
    { canvas: { clientWidth: 100 } },
    { getLimit: () => 0 },
  );
});

test('installTextureLimitGuard registers and cleans up window resize listeners', () => {
  let resizeHandler = null;
  const mockWindow = {
    addEventListener(type, handler) {
      if (type === 'resize') resizeHandler = handler;
    },
    removeEventListener(type, handler) {
      if (type === 'resize' && resizeHandler === handler) resizeHandler = null;
    },
  };
  let preRenderHandler = null;
  const viewer = {
    resolutionScale: 1.0,
    canvas: { clientWidth: 2560, clientHeight: 1440 },
    scene: {
      preRender: {
        addEventListener(handler) {
          preRenderHandler = handler;
        },
        removeEventListener(handler) {
          if (preRenderHandler === handler) preRenderHandler = null;
        },
      },
    },
  };
  const uninstall = installTextureLimitGuard(viewer, {
    getLimit: () => 2048,
    windowTarget: mockWindow,
  });
  assert.equal(viewer.resolutionScale, 2048 / 2560);
  assert.equal(typeof resizeHandler, 'function');
  assert.equal(typeof preRenderHandler, 'function');

  // Changing canvas size triggers recalculation on resize event
  viewer.canvas.clientWidth = 3840;
  resizeHandler();
  assert.equal(viewer.resolutionScale, 2048 / 3840);

  // Pre-render also recalculates
  viewer.canvas.clientWidth = 2560;
  preRenderHandler();
  assert.equal(viewer.resolutionScale, 2048 / 2560);

  // Disposing uninstalls listeners
  uninstall();
  assert.equal(resizeHandler, null);
  assert.equal(preRenderHandler, null);
});

test('setRequestedResolutionScale records requested scale and preserves it across resizes (#905, #1017)', () => {
  const viewer = {
    resolutionScale: 1.0,
    canvas: { clientWidth: 2560, clientHeight: 1440 },
  };
  const getLimit = () => 2048;

  // At 2560, initial 1.0 clamps to 0.8 (2048 / 2560)
  clampResolutionToTextureLimits(viewer, { getLimit });
  assert.equal(viewer.resolutionScale, 2048 / 2560);

  // Explicitly set scale to 0.8 via setRequestedResolutionScale
  setRequestedResolutionScale(viewer, 0.8, { getLimit });
  assert.equal(viewer.resolutionScale, 0.8);

  // Shrink the window to 1080p: requested 0.8 stays 0.8 rather than reverting to 1.0
  viewer.canvas.clientWidth = 1920;
  viewer.canvas.clientHeight = 1080;
  clampResolutionToTextureLimits(viewer, { getLimit });
  assert.equal(viewer.resolutionScale, 0.8);

  // Set scale to 1.0 again
  setRequestedResolutionScale(viewer, 1.0, { getLimit });
  assert.equal(viewer.resolutionScale, 1.0);
});
