import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initCockpitCloudEffects,
  cockpitCloudRenderSize,
  cockpitWeatherRefreshDue,
  cockpitWeatherEnabledFromStoredValue,
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
