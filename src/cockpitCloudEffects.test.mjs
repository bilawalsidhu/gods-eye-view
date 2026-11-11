import test from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from './globe/testing/fakeEngine.js';
import * as geo from './geo/index.js';
import {
  initCockpitCloudEffects,
  cockpitCloudRenderSize,
  cockpitCloudsShowFor,
  cockpitWeatherRefreshDue,
  cockpitWeatherEnabledFromStoredValue,
  COCKPIT_CLOUD_COVERAGE_MAX,
  CockpitWeatherFeed,
  cockpitCloudCoverage,
  cockpitCloudStrength,
  initEngineCockpitClouds,
} from './cockpitCloudEffects.js';

test('cockpit cloud framebuffer stays low resolution on large displays', () => {
  assert.deepEqual(cockpitCloudRenderSize(2048, 1152), {
    width: 520,
    height: 293,
  });
  assert.deepEqual(cockpitCloudRenderSize(1280, 720), {
    width: 520,
    height: 293,
  });
});

test('cockpit cloud framebuffer never upscales or collapses to zero', () => {
  assert.deepEqual(cockpitCloudRenderSize(640, 360), {
    width: 269,
    height: 151,
  });
  assert.deepEqual(cockpitCloudRenderSize(0, Number.NaN), {
    width: 1,
    height: 1,
  });
});

test('cockpit weather defaults off and enables only from an explicit saved opt-in', () => {
  assert.equal(cockpitWeatherEnabledFromStoredValue(null), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue(''), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('0'), false);
  assert.equal(cockpitWeatherEnabledFromStoredValue('1'), true);
});

test('the cloud pass stays off in orbit and runs for aircraft and bridges', () => {
  assert.equal(cockpitCloudsShowFor('satellites'), false);
  for (const layerId of ['flights', 'military', 'ais-live-vessels', null]) {
    assert.equal(cockpitCloudsShowFor(layerId), true, String(layerId));
  }
});

test('cockpit weather refreshes after time or meaningful movement', () => {
  const anchor = { latitude: 30, longitude: -97 };
  assert.equal(
    cockpitWeatherRefreshDue({
      nowMs: 1000,
      fetchedAt: 500,
      anchor,
      point: anchor,
      hasWeather: false,
    }),
    true,
  );
  assert.equal(
    cockpitWeatherRefreshDue({
      nowMs: 60_000,
      fetchedAt: 0,
      anchor,
      point: { latitude: 30.01, longitude: -97 },
      hasWeather: true,
    }),
    false,
  );
  assert.equal(
    cockpitWeatherRefreshDue({
      nowMs: 5 * 60_000,
      fetchedAt: 0,
      anchor,
      point: anchor,
      hasWeather: true,
    }),
    true,
  );
  assert.equal(
    cockpitWeatherRefreshDue({
      nowMs: 60_000,
      fetchedAt: 0,
      anchor,
      point: { latitude: 30.3, longitude: -97 },
      hasWeather: true,
    }),
    true,
  );
});

// A WebGL context that records what is allocated, freed and lost.
function fakeWebGl() {
  const calls = [];
  const gl = {
    VERTEX_SHADER: 1,
    FRAGMENT_SHADER: 2,
    ARRAY_BUFFER: 3,
    STATIC_DRAW: 4,
    FLOAT: 5,
    COLOR_BUFFER_BIT: 6,
    LINK_STATUS: 7,
    COMPILE_STATUS: 8,
    calls,
    createShader: () => ({}),
    shaderSource() {},
    compileShader() {},
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader() {},
    createProgram: () => ({ program: true }),
    attachShader() {},
    linkProgram() {},
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    deleteProgram: (program) => calls.push(['deleteProgram', program]),
    createBuffer: () => ({ buffer: true }),
    bindBuffer() {},
    bufferData() {},
    deleteBuffer: (buffer) => calls.push(['deleteBuffer', buffer]),
    getAttribLocation: () => 0,
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    getUniformLocation: () => ({}),
    viewport() {},
    clearColor() {},
    clear() {},
    getExtension: (name) =>
      name === 'WEBGL_lose_context'
        ? { loseContext: () => calls.push(['loseContext']) }
        : null,
  };
  return gl;
}

test('a destroyed cockpit cloud controller frees its GPU objects and WebGL context', () => {
  const saved = Object.fromEntries(
    [
      'document',
      'window',
      'localStorage',
      'CustomEvent',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ].map((name) => [name, globalThis[name]]),
  );
  const gl = fakeWebGl();
  let contexts = 0;
  const canvas = {
    dataset: {},
    classList: { add() {}, remove() {} },
    setAttribute() {},
    remove() {
      canvas.removed = true;
    },
    getContext() {
      contexts += 1;
      return gl;
    },
  };
  globalThis.document = {
    createElement: () => canvas,
    body: { appendChild() {}, classList: { contains: () => true } },
  };
  globalThis.window = {
    innerWidth: 1280,
    innerHeight: 720,
    matchMedia: () => ({ matches: false }),
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    setTimeout: () => 1,
    clearTimeout() {},
  };
  globalThis.localStorage = { getItem: () => '1', setItem() {} };
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  globalThis.requestAnimationFrame = () => 7;
  globalThis.cancelAnimationFrame = () => {};
  try {
    const clouds = initCockpitCloudEffects(null, { weatherService: {} });
    clouds.start();
    clouds.stop();
    clouds.start();
    assert.equal(
      contexts,
      1,
      'one context per controller, reused across starts',
    );
    const { program, buffer } = clouds;
    clouds.destroy();
    assert.deepEqual(gl.calls, [
      ['deleteBuffer', buffer],
      ['deleteProgram', program],
      ['loseContext'],
    ]);
    assert.equal(clouds.gl, null);
    assert.equal(canvas.removed, true);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  }
});

const OVERCAST = { weatherCode: 3, cloudCoverPct: 100, windKph: 20 };
const CLEAR = { weatherCode: 0, cloudCoverPct: 0, windKph: 5 };

test('the cloud strength is the weather profile cloud under the deck, the cover its share', () => {
  assert.ok(cockpitCloudStrength(OVERCAST, 1000) > 0.5);
  assert.equal(cockpitCloudStrength(CLEAR, 1000), 0);
  assert.equal(cockpitCloudStrength({}, 1000), 0, 'no observation, no cloud');
  assert.equal(cockpitCloudStrength(OVERCAST, 30000), 0, 'above the deck');
  assert.equal(cockpitCloudCoverage(1), COCKPIT_CLOUD_COVERAGE_MAX);
  assert.equal(cockpitCloudCoverage(0), 0);
  assert.equal(cockpitCloudCoverage(Number.NaN), 0);
  assert.equal(cockpitCloudCoverage(0.5), 0.5 * COCKPIT_CLOUD_COVERAGE_MAX);
});

test('the weather feed keeps the last observation and reports failures', async () => {
  const asked = [];
  let answer = { status: 'live', weather: OVERCAST };
  const feed = new CockpitWeatherFeed({
    getConditions: async (lat, lon, { signal }) => {
      asked.push([lat, lon, signal.aborted]);
      if (answer instanceof Error) throw answer;
      return answer;
    },
  });
  const point = { latitude: 30, longitude: -97, altitudeM: 900 };
  assert.equal(feed.due(point), true);
  const seen = [];
  assert.deepEqual(
    await feed.fetch(point, { onWeather: (w, s) => seen.push([w, s]) }),
    OVERCAST,
  );
  assert.deepEqual(seen, [[OVERCAST, 'live']]);
  assert.equal(feed.due(point), false, 'fresh and here');
  assert.equal(feed.pending, null);
  answer = new Error('down');
  const errors = [];
  assert.equal(
    await feed.fetch(point, { onError: (e) => errors.push(e) }),
    null,
  );
  assert.equal(errors.length, 1);
  assert.equal(feed.sourceStatus, 'unavailable');
  assert.deepEqual(feed.weather, OVERCAST, 'the last observation stays');
  // A cancelled request reports nothing.
  answer = { weather: CLEAR };
  const late = feed.fetch(point, { onWeather: () => seen.push('late') });
  feed.cancel();
  assert.equal(await late, null);
  assert.equal(seen.length, 1);
});

// The page globals the engine controller reads, restored afterwards.
function withPage(run) {
  const names = ['document', 'window', 'localStorage', 'CustomEvent'];
  const saved = Object.fromEntries(names.map((n) => [n, globalThis[n]]));
  const listeners = new Map();
  const timers = new Map();
  let nextTimer = 1;
  const body = new Set(['cockpit-mode']);
  let created = 0;
  globalThis.document = {
    createElement() {
      created++;
      return {};
    },
    body: { classList: { contains: (name) => body.has(name) } },
  };
  globalThis.window = {
    addEventListener: (type, fn) => listeners.set(type, fn),
    removeEventListener: (type) => listeners.delete(type),
    dispatchEvent() {},
    setInterval: (fn) => {
      timers.set(nextTimer, fn);
      return nextTimer++;
    },
    clearInterval: (id) => timers.delete(id),
  };
  globalThis.localStorage = { getItem: () => '1', setItem() {} };
  globalThis.CustomEvent = class {
    constructor(type, init) {
      this.type = type;
      this.detail = init?.detail;
    }
  };
  const page = {
    body,
    listeners,
    timers,
    get canvases() {
      return created;
    },
  };
  return Promise.resolve(run(page)).finally(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete globalThis[name];
      else globalThis[name] = value;
    }
  });
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test('on an engine with its own clouds the cockpit weather sets their cover, no canvas', () =>
  withPage(async (page) => {
    const engine = createFakeEngine({ kind: 'navara', cloudCover: true });
    engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-97.74, 30.27, 1500),
    });
    let weather = OVERCAST;
    const clouds = initEngineCockpitClouds(engine, {
      weatherService: { getConditions: async () => ({ weather }) },
    });
    await settle();
    const overcast = cockpitCloudCoverage(cockpitCloudStrength(OVERCAST, 1500));
    assert.ok(Math.abs(engine.render.cloudCover().coverage - overcast) < 1e-9);
    assert.equal(page.canvases, 0, 'no canvas, no second WebGL context');
    assert.equal(page.timers.size, 1, 'one refresh check');
    assert.equal(clouds.getSnapshot().active, true);
    // Leaving the cockpit gives the engine its own clouds back.
    page.body.delete('cockpit-mode');
    page.listeners.get('gev:cockpit-mode-changed')({
      detail: { active: false },
    });
    assert.deepEqual(engine.render.cloudCover(), { coverage: null });
    assert.equal(page.timers.size, 0);
    // Back in, with clear weather after the cache is stale.
    page.body.add('cockpit-mode');
    weather = CLEAR;
    clouds.feed.fetchedAt = 0;
    page.listeners.get('gev:cockpit-mode-changed')({
      detail: { active: true },
    });
    await settle();
    assert.equal(engine.render.cloudCover().coverage, 0);
    // The weather toggle off stops it; destroy leaves the engine its own.
    page.listeners.get('gev:cockpit-weather-toggle')({
      detail: { enabled: false },
    });
    assert.deepEqual(engine.render.cloudCover(), { coverage: null });
    clouds.destroy();
    assert.equal(page.listeners.size, 0);
  }));

test('a hidden page pauses the engine cockpit clouds checks', () =>
  withPage(async (page) => {
    const engine = createFakeEngine({ kind: 'navara', cloudCover: true });
    let asked = 0;
    const clouds = initEngineCockpitClouds(engine, {
      weatherService: {
        getConditions: async () => {
          asked++;
          return { weather: OVERCAST };
        },
      },
    });
    await settle();
    clouds.setSuspended(true);
    assert.equal(page.timers.size, 0);
    clouds.setSuspended(false);
    assert.equal(page.timers.size, 1);
    clouds.destroy();
    assert.ok(asked >= 1);
  }));
