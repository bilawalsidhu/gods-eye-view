import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cockpitCloudRenderSize,
  cockpitWeatherRefreshDue,
  cockpitWeatherEnabledFromStoredValue,
} from './cockpitCloudEffects.js';

test('cockpit cloud framebuffer stays low resolution on large displays', () => {
  assert.deepEqual(cockpitCloudRenderSize(2048, 1152), { width: 520, height: 293 });
  assert.deepEqual(cockpitCloudRenderSize(1280, 720), { width: 520, height: 293 });
});

test('cockpit cloud framebuffer never upscales or collapses to zero', () => {
  assert.deepEqual(cockpitCloudRenderSize(640, 360), { width: 269, height: 151 });
  assert.deepEqual(cockpitCloudRenderSize(0, Number.NaN), { width: 1, height: 1 });
});

test('cockpit weather defaults off and enables only from an explicit saved opt-in', () => {
  assert.equal(cockpitWeatherEnabledFromStoredValue(null), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue(''), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('0'), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('1'), true);
});

test('cockpit weather refreshes after time or meaningful movement', () => {
  const anchor = { latitude: 30, longitude: -97 };
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 1000,
    fetchedAt: 500,
    anchor,
    point: anchor,
    hasWeather: false,
  }), true);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 60_000,
    fetchedAt: 0,
    anchor,
    point: { latitude: 30.01, longitude: -97 },
    hasWeather: true,
  }), false);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 5 * 60_000,
    fetchedAt: 0,
    anchor,
    point: anchor,
    hasWeather: true,
  }), true);
  assert.equal(cockpitWeatherRefreshDue({
    nowMs: 60_000,
    fetchedAt: 0,
    anchor,
    point: { latitude: 30.3, longitude: -97 },
    hasWeather: true,
  }), true);
});

// ── controller harness (headless DOM + WebGL + rAF stubs) ───────────────────

/** A WebGL context stub that records draw/uniform/clear traffic. */
function makeGlStub() {
  const record = { uniform2f: [], uniform1f: [], drawArrays: [], clearColor: [], clear: [], viewport: [], bufferData: [], deleteProgram: [] };
  let nextHandle = 1;
  const gl = {
    VERTEX_SHADER: 'vertex', FRAGMENT_SHADER: 'fragment', ARRAY_BUFFER: 'array-buffer',
    STATIC_DRAW: 'static-draw', TRIANGLES: 'triangles', FLOAT: 'float',
    COMPILE_STATUS: 'compile-status', LINK_STATUS: 'link-status', COLOR_BUFFER_BIT: 'color-bit',
    createShader: () => ({ handle: nextHandle++ }),
    shaderSource: () => {},
    compileShader: () => {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: () => {},
    createProgram: () => ({ handle: nextHandle++ }),
    attachShader: () => {},
    linkProgram: () => {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    createBuffer: () => ({ handle: nextHandle++ }),
    bindBuffer: () => {},
    bufferData: (...args) => record.bufferData.push(args),
    getAttribLocation: () => 0,
    enableVertexAttribArray: () => {},
    vertexAttribPointer: () => {},
    getUniformLocation: (_program, name) => ({ uniform: name }),
    useProgram: () => {},
    uniform2f: (loc, x, y) => record.uniform2f.push([loc?.uniform, x, y]),
    uniform1f: (loc, x) => record.uniform1f.push([loc?.uniform, x]),
    drawArrays: (...args) => record.drawArrays.push(args),
    viewport: (...args) => record.viewport.push(args),
    clearColor: (...args) => record.clearColor.push(args),
    clear: (...args) => record.clear.push(args),
    deleteProgram: (p) => record.deleteProgram.push(p),
  };
  return { gl, record };
}

/** Full browser-environment stub installed for one test; auto-restored. */
function installEnv(t, { reducedMotion = false, cockpitMode = false, stored = null, glAvailable = true } = {}) {
  const { gl, record } = makeGlStub();
  const canvas = {
    id: '', dataset: {}, width: 300, height: 150, removed: false,
    attributes: new Map(),
    setAttribute(name, value) { this.attributes.set(name, value); },
    getContext: () => (glAvailable ? gl : null),
    classList: {
      set: new Set(),
      add(c) { this.set.add(c); },
      remove(c) { this.set.delete(c); },
      toggle(c, force) {
        const next = force === undefined ? !this.set.has(c) : Boolean(force);
        if (next) this.set.add(c); else this.set.delete(c);
        return next;
      },
      contains(c) { return this.set.has(c); },
    },
    remove() { this.removed = true; },
  };
  const win = {
    innerWidth: 1280, innerHeight: 720,
    listeners: new Map(),
    removedListeners: [],
    events: [],
    timeouts: [],
    nextTimeoutId: 1,
    addEventListener(name, fn) {
      if (!this.listeners.has(name)) this.listeners.set(name, []);
      this.listeners.get(name).push(fn);
    },
    removeEventListener(name, fn) { this.removedListeners.push([name, fn]); },
    dispatchEvent(event) { this.events.push(event); },
    setTimeout(fn) { this.timeouts.push(fn); return this.nextTimeoutId++; },
    clearTimeout() {},
    matchMedia: () => ({ matches: reducedMotion }),
  };
  const rafQ = [];
  let rafId = 1;
  const raf = {
    request: (cb) => { rafId += 1; rafQ.push({ id: rafId, cb }); return rafId; },
    cancel: (id) => { const i = rafQ.findIndex((e) => e.id === id); if (i >= 0) rafQ.splice(i, 1); },
  };
  const store = new Map(stored === null ? [] : [['godsEyeView.cockpitWeatherEffects.enabled', stored]]);
  const documentStub = {
    body: {
      classList: {
        set: new Set(cockpitMode ? ['cockpit-mode'] : []),
        contains(c) { return this.set.has(c); },
        add(c) { this.set.add(c); },
        remove(c) { this.set.delete(c); },
      },
      appended: [],
      appendChild(el) { this.appended.push(el); },
    },
    createElement: () => canvas,
    hidden: false,
  };
  const warnings = [];
  const original = {
    document: globalThis.document, window: globalThis.window, localStorage: globalThis.localStorage,
    fetch: globalThis.fetch, requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame, performance: globalThis.performance,
    consoleWarn: console.warn,
  };
  globalThis.document = documentStub;
  globalThis.window = win;
  globalThis.localStorage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v) };
  globalThis.fetch = () => new Promise(() => {}); // replaced per-test via setFetch
  globalThis.requestAnimationFrame = raf.request;
  globalThis.cancelAnimationFrame = raf.cancel;
  console.warn = (...args) => warnings.push(args);
  t.after(() => {
    globalThis.document = original.document;
    globalThis.window = original.window;
    globalThis.localStorage = original.localStorage;
    globalThis.fetch = original.fetch;
    globalThis.requestAnimationFrame = original.requestAnimationFrame;
    globalThis.cancelAnimationFrame = original.cancelAnimationFrame;
    globalThis.performance = original.performance;
    console.warn = original.consoleWarn;
  });
  const viewer = {
    camera: {
      positionCartographic: {
        latitude: (30 * Math.PI) / 180, longitude: (-97 * Math.PI) / 180, height: 1200,
      },
    },
  };
  return {
    gl, record, canvas, win, rafQ, viewer, warnings,
    setFetch(fn) { globalThis.fetch = fn; },
    enterCockpitMode() { documentStub.body.classList.add('cockpit-mode'); },
    exitCockpitMode() { documentStub.body.classList.remove('cockpit-mode'); },
    runFrame(timeMs) { const e = rafQ.shift(); if (e) e.cb(timeMs); },
    runTimeout(index = 0) { const fn = win.timeouts.splice(index, 1)[0]; if (fn) fn(); },
  };
}

const CLOUDY = { weatherCode: 3, cloudCoverPct: 92, precipitationMm: 0, visibilityM: 24000, windDirectionDeg: 200 };
const weatherResponse = (weather = CLOUDY, status = 'ready') => ({
  ok: true, status: 200, json: async () => ({ weather, status }),
});

async function controllerInCockpitMode(t, env) {
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  controller.setEnabled(true);
  env.enterCockpitMode();
  controller.start();
  return controller;
}

// ── controller lifecycle ────────────────────────────────────────────────────

test('the controller defaults off, persists opt-ins, and mirrors state on a window event', async (t) => {
  const env = installEnv(t);
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  assert.equal(controller.enabled, false, 'no stored preference → off');
  assert.equal(env.canvas.getAttribute ?? true, true); // setAttribute path exercised via aria-hidden
  assert.equal(env.canvas.attributes.get('aria-hidden'), 'true');
  assert.equal(env.win.events.at(-1)?.detail?.enabled, false, 'the initial state is mirrored');
  assert.equal(env.win.listeners.get('resize')?.length, 1);
  assert.equal(env.win.listeners.get('gev:cockpit-mode-changed')?.length, 1);
  assert.equal(env.win.listeners.get('gev:cockpit-weather-toggle')?.length, 1);

  env.win.events.length = 0;
  env.win.listeners.get('gev:cockpit-weather-toggle')[0]({ detail: { enabled: true } });
  assert.equal(controller.enabled, true, 'the toggle event enables');
  assert.equal(env.win.events.at(-1)?.detail?.enabled, true);
  assert.equal(globalThis.localStorage.getItem('godsEyeView.cockpitWeatherEffects.enabled'), '1',
    'the opt-in persists');

  env.win.listeners.get('gev:cockpit-weather-toggle')[0]({ detail: undefined });
  assert.equal(controller.enabled, false, 'a detail-less event toggles');
});

test('a saved opt-in enables the controller at construction (and a persisted 0 does not)', async (t) => {
  for (const [stored, expected] of [['1', true], ['0', false], [null, false]]) {
    const env = installEnv(t, { stored });
    const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
    const controller = new CockpitCloudEffectsController(env.viewer);
    assert.equal(controller.enabled, expected, `stored=${String(stored)} → ${expected}`);
    controller.destroy();
    assert.equal(env.canvas.removed, true);
    assert.equal(env.win.removedListeners.length, 3, 'all three window listeners detached');
    assert.equal(env.record.deleteProgram.length, 0, 'no GL init happened while disabled');
  }
});

test('cockpit-mode change events start and stop the pass', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  const handler = env.win.listeners.get('gev:cockpit-mode-changed')[0];

  handler({ detail: { active: true } });
  assert.equal(controller.frame !== null, true, 'active → the rAF loop starts');
  assert.equal(env.canvas.dataset.cockpit, 'true');
  assert.ok(env.win.timeouts.length >= 1, 'the startup refresh timer is armed');

  handler({ detail: { active: false } });
  assert.equal(controller.frame, null, 'inactive → the loop stops');
  assert.equal(env.canvas.dataset.cockpit, 'false');
  assert.equal(env.canvas.classList.contains('active'), false);

  // No detail: fall back to reading the body class.
  env.enterCockpitMode();
  handler({});
  assert.equal(controller.frame !== null, true, 'class-based fallback starts the pass');
  controller.destroy();
});

test('start() with no WebGL marks the canvas unavailable and never schedules a frame', async (t) => {
  const env = installEnv(t, { stored: '1', glAvailable: false });
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  env.enterCockpitMode();
  controller.start();
  assert.equal(controller.frame, null, 'no renderer → no loop');
  assert.equal(env.canvas.dataset.status, 'unavailable');
  assert.equal(env.warnings.length, 1, 'the failure is warned once');
  assert.match(String(env.warnings[0][0]), /Cockpit clouds/);
  controller.destroy();
});

test('refresh() fetches weather once, caches it, and reports failure honestly', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  let fetches = 0;
  env.setFetch(async () => { fetches += 1; return weatherResponse(); });

  await controller.refresh();
  assert.equal(fetches, 1);
  assert.equal(controller.weather?.weatherCode, 3);
  assert.ok(controller.targetStrength > 0.03, `overcast sky drives visible strength (${controller.targetStrength.toFixed(2)})`);
  assert.equal(env.canvas.dataset.sourceStatus, 'ready');
  assert.ok(Number(env.canvas.dataset.cloudStrength) > 0);

  await controller.refresh(); // fresh cache, same anchor → no second fetch
  assert.equal(fetches, 1, 'within the 5-minute/25 km window the cached observation is reused');

  env.setFetch(async () => ({ ok: false, status: 503 }));
  controller.fetchedAt = -1e12; // force the refresh gate open
  await controller.refresh();
  assert.equal(env.canvas.dataset.sourceStatus, 'unavailable', 'a failed refresh says so');
  assert.equal(controller.targetStrength, 0);
  controller.destroy();
});

test('refresh() is a no-op outside cockpit mode and after destroy; aborts are silent', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  let fetches = 0;
  env.setFetch(async () => { fetches += 1; return weatherResponse(); });
  await controller.refresh();
  assert.equal(fetches, 1);

  env.exitCockpitMode();
  controller.fetchedAt = -1e12;
  await controller.refresh();
  assert.equal(fetches, 1, 'suspended guard blocks the fetch');

  env.enterCockpitMode();
  controller.destroyed = true;
  await controller.refresh();
  assert.equal(fetches, 1, 'destroyed guard blocks the fetch');

  controller.destroyed = false;
  controller.fetchedAt = -1e12;
  env.setFetch(async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
  assert.equal(await controller.refresh(), null, 'an AbortError resolves null');
  assert.equal(env.canvas.dataset.sourceStatus, 'ready', 'aborts do not flip the honest status');
  controller.destroy();
});

test('the tick loop blends strength, renders at ≤12 fps, and re-checks weather every second', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  let fetches = 0;
  env.setFetch(async () => { fetches += 1; return weatherResponse(); });

  env.runFrame(1001); // first tick past the 1 s gate: no weather yet → refresh fires
  assert.equal(fetches, 1, 'the once-a-second gate fired with no weather in hand');
  await controller.pending;

  controller.targetStrength = 0.5;
  env.runFrame(1100); // blend 0.08 → strength 0.04 > the 0.035 floor → visible + drawn
  const blended = controller.strength;
  assert.ok(blended > 0.035, `the blend crossed the visibility floor (${blended.toFixed(3)})`);
  assert.equal(env.canvas.classList.contains('active'), true);
  assert.ok(env.record.drawArrays.length >= 1, 'the cloud quad rendered');
  const drawsBefore = env.record.drawArrays.length;
  env.runFrame(1140); // only 40 ms since the last draw → throttled below 12 fps
  assert.equal(env.record.drawArrays.length, drawsBefore, 'frames throttle to CLOUD_FRAME_MS');
  env.runFrame(1240); // ≥100 ms since the last draw → draws again
  assert.ok(env.record.drawArrays.length > drawsBefore, 'the next ≥100 ms frame draws');

  // Leaving cockpit mode mid-loop makes the next tick stop itself.
  env.exitCockpitMode();
  env.runFrame(2000);
  assert.equal(controller.frame, null, 'the loop tears itself down when the mode exits');
  controller.destroy();
});

test('reduced motion jumps strength instantly and runs on a 1 s timer chain, not rAF', async (t) => {
  const env = installEnv(t, { stored: '1', reducedMotion: true });
  const controller = await controllerInCockpitMode(t, env);
  let fetches = 0;
  env.setFetch(async () => { fetches += 1; return weatherResponse(); });

  assert.equal(env.rafQ.length, 1, 'the first frame was rAF-scheduled by start()');
  env.runFrame(1001);
  assert.equal(fetches, 1, 'the tick still refreshes weather');
  await controller.pending;
  assert.equal(controller.strength, controller.targetStrength, 'reduced motion skips the blend');
  assert.equal(env.canvas.classList.contains('active'), true, 'visible clouds toggle active');
  assert.ok(env.record.drawArrays.length >= 1, 'the static frame rendered immediately');
  assert.equal(env.rafQ.length, 0, 'no further rAF — the loop moved to timeouts');
  assert.equal(env.win.timeouts.length, 2, 'the start() timer + the 1 s refresh chain');

  env.runTimeout(); // the start() refresh timer — the cached observation answers it
  env.runTimeout(); // the refresh chain re-ticks
  assert.equal(fetches, 1, 'the 1 s chain re-checks against the cache, not the network');
  assert.equal(env.rafQ.length, 0, 'the timeout re-ticks without re-arming rAF');
  assert.equal(env.win.timeouts.length, 1, 'the chain re-arms itself (startup consumed)');
  controller.destroy();
});

test('applyWeather drives the reduced-motion visibility toggle both ways', async (t) => {
  const env = installEnv(t, { stored: '1', reducedMotion: true });
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  controller.setEnabled(true);
  env.enterCockpitMode();
  controller.initializeRenderer(); // render() no-ops until the GL program exists

  controller.applyWeather({ ...CLOUDY }, 0);
  assert.equal(controller.canvas.classList.contains('active'), true, 'strong cloud → active + drawn');
  assert.ok(env.record.drawArrays.length >= 1);

  controller.applyWeather({ weatherCode: 0, cloudCoverPct: 0, precipitationMm: 0, visibilityM: 30000 }, 0);
  assert.equal(controller.canvas.classList.contains('active'), false, 'clear sky → inactive + cleared');
  assert.ok(env.record.clear.length >= 1, 'the framebuffer was cleared');
  assert.equal(env.canvas.dataset.weatherCode, '0');
  controller.destroy();
});

test('setSuspended pauses both scheduling chains and resume restarts exactly one', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  assert.equal(env.rafQ.length, 1);

  controller.setSuspended(true);
  assert.equal(env.rafQ.length, 0, 'the rAF chain is cancelled');
  assert.equal(controller.frame, null);
  assert.equal(controller.refreshTimer, null);

  controller.setSuspended(false); // still in cockpit mode → restarts
  assert.equal(env.rafQ.length, 1, 'exactly one chain restarts');
  controller.setSuspended(true);
  controller.setSuspended(false);
  assert.equal(env.rafQ.length, 1, 'repeated resume never stacks loops');
  controller.destroy();
});

test('a suspended tick stops both chains without tearing down weather state', async (t) => {
  const env = installEnv(t, { stored: '1', reducedMotion: true });
  const controller = await controllerInCockpitMode(t, env);
  env.setFetch(async () => weatherResponse());
  env.runFrame(1001);
  await controller.pending;
  const strengthBefore = controller.strength;

  controller.setSuspended(true);
  // Simulate a late rAF/timeout firing after suspension: the tick must bail.
  controller.tick(5000);
  assert.equal(controller.frame, null, 'the tick does not re-arm rAF while suspended');
  assert.equal(controller.refreshTimer, null, 'the timeout chain is cut too');
  assert.equal(controller.strength, strengthBefore, 'weather state survives suspension');
  assert.equal(controller.weather?.weatherCode, 3, 'the cached observation survives suspension');
  controller.destroy();
});

test('cameraPoint normalizes the camera cartographic; garbage reads return null', async (t) => {
  const env = installEnv(t);
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  const point = controller.cameraPoint();
  assert.ok(Math.abs(point.latitude - 30) < 1e-9);
  assert.ok(Math.abs(point.longitude + 97) < 1e-9);
  assert.equal(point.altitudeM, 1200);

  controller.viewer = {};
  assert.equal(controller.cameraPoint(), null, 'no camera → null');

  controller.viewer = { camera: { positionCartographic: { latitude: Number.NaN, longitude: 0, height: 0 } } };
  assert.equal(controller.cameraPoint(), null, 'non-finite cartographic → null');

  controller.viewer = { camera: { positionCartographic: { latitude: 0, longitude: 0, height: -5 } } };
  assert.equal(controller.cameraPoint().altitudeM, 0, 'negative altitude clamps to 0');
  controller.destroy();
});

test('render() clamps strength and writes wind uniforms; it no-ops without a program', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  env.record.uniform1f.length = 0;
  env.record.uniform2f.length = 0;
  env.record.drawArrays.length = 0;

  controller.strength = 2; // over the clamp
  controller.windDirectionDeg = 90;
  controller.windStrength = 0.5;
  controller.render(12.5);
  const timeUniform = env.record.uniform1f.find(([name]) => name === 'uTime');
  const strengthUniform = env.record.uniform1f.find(([name]) => name === 'uStrength');
  const windUniform = env.record.uniform2f.find(([name]) => name === 'uWind');
  assert.equal(timeUniform[1], 12.5);
  assert.equal(strengthUniform[1], 1, 'strength clamps to 1');
  assert.ok(Math.abs(windUniform[1] - 0.019) < 1e-6, 'wind east for 90° at scale 0.008+0.5·0.022');
  assert.ok(Math.abs(windUniform[2]) < 1e-6);
  assert.deepEqual(env.record.drawArrays.at(-1), ['triangles', 0, 6], 'a full-screen two-triangle quad');

  env.record.drawArrays.length = 0;
  controller.gl = null;
  controller.render(13);
  assert.equal(env.record.drawArrays.length, 0, 'no GL → no draw');
  controller.destroy();
});

test('a hostile localStorage degrades silently instead of blocking construction', async (t) => {
  const env = installEnv(t);
  const original = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('SecurityError'); },
    setItem: () => { throw new Error('SecurityError'); },
  };
  t.after(() => { globalThis.localStorage = original; });
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  assert.equal(controller.enabled, false, 'a throwing read defaults off');
  env.enterCockpitMode();
  controller.setEnabled(true); // the throwing write must not surface
  assert.equal(controller.enabled, true, 'the toggle still applies in memory');
  assert.equal(env.rafQ.length, 1, 'enabling DURING cockpit mode starts the pass right away');
  assert.equal(env.win.events.at(-1)?.detail?.enabled, true);
  controller.destroy();
});

test('a shader link failure warns and marks the renderer unavailable', async (t) => {
  const env = installEnv(t);
  const { CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = new CockpitCloudEffectsController(env.viewer);
  const realGetProgramParameter = env.gl.getProgramParameter;
  env.gl.getProgramParameter = (_program, pname) => (
    pname === env.gl.LINK_STATUS ? false : realGetProgramParameter(_program, pname)
  );
  controller.initializeRenderer();
  assert.equal(controller.gl, null, 'a failed link leaves no usable context');
  assert.equal(env.canvas.dataset.status, 'unavailable');
  assert.match(String(env.warnings.at(-1)?.[0]), /Cockpit clouds/);
  controller.destroy();
});

test('initCockpitCloudEffects returns a live controller', async (t) => {
  const env = installEnv(t);
  const { initCockpitCloudEffects, CockpitCloudEffectsController } = await import('./cockpitCloudEffects.js');
  const controller = initCockpitCloudEffects(env.viewer);
  assert.ok(controller instanceof CockpitCloudEffectsController);
  controller.destroy();
});

test('getSnapshot mirrors the externally observable state', async (t) => {
  const env = installEnv(t, { stored: '1' });
  const controller = await controllerInCockpitMode(t, env);
  env.setFetch(async () => weatherResponse(CLOUDY, 'live'));
  await controller.refresh();

  const snap = controller.getSnapshot();
  assert.equal(snap.enabled, true);
  assert.equal(snap.sourceStatus, 'live');
  assert.ok(snap.strength > 0);
  assert.equal(snap.weather.weatherCode, 3, 'the snapshot copies the observation');
  assert.notEqual(snap.weather, controller.weather, 'the observation is cloned, not aliased');
  assert.ok(snap.renderSize.width >= 1 && snap.renderSize.height >= 1);
  controller.destroy();
});
