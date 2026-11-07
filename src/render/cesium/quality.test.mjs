import assert from 'node:assert/strict';
import test from 'node:test';
import { QUALITY_KEYS, checkPortShape } from '../contract/index.js';
import { createCesiumQuality, errorFactor } from './quality.js';

function event() {
  const listeners = new Set();
  return {
    addEventListener(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    raise: () => [...listeners].forEach((cb) => cb()),
    get size() {
      return listeners.size;
    },
  };
}

class Tileset {
  constructor(error = 16) {
    this.maximumScreenSpaceError = error;
  }
}
class Collection {
  constructor(items = []) {
    this.items = items;
  }
  get length() {
    return this.items.length;
  }
  get(i) {
    return this.items[i];
  }
}

function fixture({
  msaaSupported = true,
  maximumSamples = 8,
  tickStarted,
} = {}) {
  const primitives = new Collection();
  const scene = {
    preUpdate: event(),
    preRender: event(),
    postRender: event(),
    primitives,
    globe: { maximumScreenSpaceError: 2 },
    msaaSupported,
    msaaSamples: 4,
    shadowMap: { enabled: false },
    requestRenderMode: true,
    pixelRatio: 1,
    drawingBufferWidth: 800,
    drawingBufferHeight: 600,
    context: { webgl2: true },
  };
  const widget = {
    scene,
    resolutionScale: 1,
    useBrowserRecommendedResolution: true,
  };
  const requests = [];
  let targetFps = 60;
  const frame = {
    requestRender: (reason) => requests.push(reason),
    setTargetFps: (fps) => (targetFps = fps > 0 ? fps : 0),
    diagnostics: () => ({ targetFps, pendingReasons: [], holds: ['flights'] }),
  };
  const errors = [];
  const part = createCesiumQuality(widget, {
    frame,
    report: (error) => errors.push(error),
    isTileset: (p) => p instanceof Tileset,
    isCollection: (p) => p instanceof Collection,
    limits: { maximumTextureSize: 16384, maximumSamples },
    tickStarted,
  });
  const tick = () => {
    scene.preUpdate.raise();
    scene.preRender.raise();
    scene.postRender.raise();
  };
  return {
    ...part,
    quality: part.port,
    scene,
    widget,
    primitives,
    requests,
    errors,
    tick,
  };
}

test('the port has the contract’s members', () => {
  const { quality } = fixture();
  assert.deepEqual(checkPortShape(quality, 'quality', new Set()), []);
});

test('building the port changes nothing in the scene', () => {
  const { scene, widget } = fixture();
  assert.equal(scene.msaaSamples, 4);
  assert.equal(scene.shadowMap.enabled, false);
  assert.equal(scene.globe.maximumScreenSpaceError, 2);
  assert.equal(widget.resolutionScale, 1);
});

test('knobs name contract keys, with the scene’s own values as defaults', () => {
  const { quality } = fixture();
  const knobs = quality.knobs();
  for (const k of knobs) assert.ok(QUALITY_KEYS.includes(k.key), k.key);
  const byKey = Object.fromEntries(knobs.map((k) => [k.key, k]));
  assert.equal(byKey.msaa.default, 4);
  assert.deepEqual(byKey.msaa.options, [0, 2, 4, 8]);
  assert.equal(byKey.shadows.default, false);
  assert.equal(byKey.targetFps.default, 60);
  assert.equal(byKey.pixelRatio.default, 0);
  assert.deepEqual(quality.get(), {
    pixelRatio: 0,
    shadows: false,
    msaa: 4,
    tiles3dDetail: 1,
    terrainDetail: 1,
    targetFps: 60,
  });
});

test('set applies supported keys, asks for a frame and returns the rest', () => {
  const { quality, scene, requests } = fixture();
  const ignored = quality.set({
    msaa: 0,
    shadows: true,
    targetFps: 30,
    clouds: 'high',
    water: 'off',
  });
  assert.deepEqual(ignored, ['clouds', 'water']);
  assert.equal(scene.msaaSamples, 1, 'off is Cesium’s 1');
  assert.equal(scene.shadowMap.enabled, true);
  assert.equal(quality.get().targetFps, 30);
  assert.equal(quality.get().msaa, 0);
  assert.deepEqual(requests, ['quality']);
  quality.set({ msaa: 6 });
  assert.equal(scene.msaaSamples, 4, 'the most samples up to the count asked');
});

test('msaa is not listed, and is ignored, where the context cannot multisample', () => {
  const { quality, scene } = fixture({ msaaSupported: false });
  assert.ok(!quality.knobs().some((k) => k.key === 'msaa'));
  assert.deepEqual(quality.set({ msaa: 8 }), ['msaa']);
  assert.equal(scene.msaaSamples, 4);
  assert.ok(!('msaa' in quality.get()));
  assert.deepEqual(quality.device().msaaSamples, [0]);
});

test('msaa options stop at what the context can draw', () => {
  const { quality } = fixture({ maximumSamples: 4 });
  const msaa = quality.knobs().find((k) => k.key === 'msaa');
  assert.deepEqual(msaa.options, [0, 2, 4]);
});

test('pixelRatio is an absolute ratio; 0 is the browser’s recommended one', () => {
  const { quality, widget } = fixture();
  widget.useBrowserRecommendedResolution = false;
  widget.resolutionScale = 0.75;
  quality.set({ pixelRatio: 2 });
  assert.equal(widget.useBrowserRecommendedResolution, true);
  assert.equal(widget.resolutionScale, 2);
  assert.equal(quality.get().pixelRatio, 2);
  quality.set({ pixelRatio: 0 });
  assert.equal(widget.useBrowserRecommendedResolution, true);
  assert.equal(widget.resolutionScale, 1);
  quality.set({ pixelRatio: 'x' });
  assert.equal(quality.get().pixelRatio, 0, 'not a number: left as it was');
});

test('detail scales each tileset’s and the globe’s own error, and gives it back', () => {
  const { quality, scene, primitives } = fixture();
  const google = new Tileset(16);
  const nested = new Tileset(8);
  primitives.items.push(google, new Collection([nested]), { other: true });
  quality.set({ tiles3dDetail: 0, terrainDetail: 0.5 });
  assert.equal(google.maximumScreenSpaceError, 16 * 8);
  assert.equal(nested.maximumScreenSpaceError, 8 * 8);
  assert.equal(scene.globe.maximumScreenSpaceError, 2 * errorFactor(0.5));
  quality.set({ tiles3dDetail: 1, terrainDetail: 1 });
  assert.equal(google.maximumScreenSpaceError, 16);
  assert.equal(nested.maximumScreenSpaceError, 8);
  assert.equal(scene.globe.maximumScreenSpaceError, 2);
  assert.equal(scene.preRender.size, 1, 'no watch at full detail');
});

test('a tileset added while detail is lowered is lowered on the next tick', () => {
  const { quality, primitives, scene, tick } = fixture();
  quality.set({ tiles3dDetail: 0.5 });
  const late = new Tileset(16);
  primitives.items.push(late);
  tick();
  assert.equal(late.maximumScreenSpaceError, 16 * errorFactor(0.5));
  tick();
  assert.equal(late.maximumScreenSpaceError, 16 * errorFactor(0.5), 'once');
  // An error someone sets since is the tileset's own from then on.
  late.maximumScreenSpaceError = 4;
  tick();
  assert.equal(late.maximumScreenSpaceError, 4 * errorFactor(0.5));
  quality.set({ tiles3dDetail: 1 });
  assert.equal(late.maximumScreenSpaceError, 4);
  assert.equal(scene.preRender.size, 1);
});

test('a tileset taken out while lowered gets its own error back', () => {
  const { quality, primitives, tick } = fixture();
  const tileset = new Tileset(16);
  primitives.items.push(tileset);
  quality.set({ tiles3dDetail: 0 });
  primitives.items.length = 0;
  tick();
  assert.equal(tileset.maximumScreenSpaceError, 16);
});

test('frame signals come with each drawn frame and follow the listener rules', () => {
  const { quality, tick, errors, dispose } = fixture();
  const seen = [];
  quality.signals.on('frame', () => {
    throw new Error('listener failure');
  });
  const off = quality.signals.on('frame', (s) => seen.push(s));
  tick();
  assert.equal(errors.length, 1, 'a throw is reported, the rest still run');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].width, 800);
  assert.equal(seen[0].height, 600);
  assert.equal(seen[0].mode, 'demand');
  assert.equal(seen[0].requested, false);
  assert.deepEqual(seen[0].holds, ['flights']);
  assert.ok(seen[0].cpuMs >= 0);
  assert.equal(quality.signals.gpuTiming, 'none');
  off();
  tick();
  assert.equal(seen.length, 1);
  quality.signals.on('frame', (s) => seen.push(s));
  dispose();
  tick();
  assert.equal(seen.length, 1, 'nothing after dispose');
});

test('device and probe describe the context and the browser', () => {
  const { quality } = fixture();
  const facts = quality.device();
  assert.equal(facts.backend, 'webgl2');
  assert.equal(facts.maxTextureSize, 16384);
  assert.equal(facts.gpuTimer, false);
  const probe = quality.probe();
  assert.deepEqual(probe.device, facts);
  assert.equal(typeof probe.browser.touchOnly, 'boolean');
  assert.deepEqual(probe.knobs, quality.knobs());
});

test('a disposed port changes nothing and ignores every key', () => {
  const { quality, scene, dispose } = fixture();
  dispose();
  assert.deepEqual(quality.set({ shadows: true }), ['shadows']);
  assert.equal(scene.shadowMap.enabled, false);
});

test('an unchanged error is not written again, each write resetting Cesium’s memory adjustment', () => {
  const { quality, primitives, tick } = fixture();
  let writes = 0;
  let error = 16;
  const tileset = new Tileset();
  Object.defineProperty(tileset, 'maximumScreenSpaceError', {
    get: () => error,
    set(value) {
      writes += 1;
      error = value;
    },
  });
  primitives.items.push(tileset);
  quality.set({ tiles3dDetail: 0 });
  assert.equal(writes, 1);
  tick();
  tick();
  assert.equal(writes, 1, 'ticks leave the lowered error alone');
});

test('terrain detail alone sets the globe once and watches no tick', () => {
  const { quality, scene } = fixture();
  quality.set({ terrainDetail: 0 });
  assert.equal(scene.globe.maximumScreenSpaceError, 16);
  assert.equal(scene.preRender.size, 1, 'no watch');
});

test('cpu time counts from the tick’s start when the frame port gives it', () => {
  const started = performance.now() - 50;
  const { quality, scene, tick } = fixture({ tickStarted: () => started });
  assert.equal(scene.preUpdate.size, 0, 'no timer of its own');
  const seen = [];
  quality.signals.on('frame', (s) => seen.push(s));
  tick();
  assert.ok(seen[0].cpuMs >= 50);
});

test('lowering detail again scales the tileset’s own error, not the lowered one', () => {
  const { quality, primitives } = fixture();
  const tileset = new Tileset(16);
  primitives.items.push(tileset);
  quality.set({ tiles3dDetail: 0.5 });
  quality.set({ tiles3dDetail: 0 });
  assert.equal(tileset.maximumScreenSpaceError, 16 * 8);
});

test('signals say when the loop runs every frame and when a frame was asked for', () => {
  const { quality, scene, tick } = fixture();
  const seen = [];
  quality.signals.on('frame', (s) => seen.push(s));
  scene.requestRenderMode = false;
  tick();
  assert.equal(seen[0].mode, 'continuous');
});

test('the msaa default stays within what the context can draw', () => {
  const { quality } = fixture({ maximumSamples: 2 });
  const msaa = quality.knobs().find((k) => k.key === 'msaa');
  assert.deepEqual(msaa.options, [0, 2]);
  assert.equal(msaa.default, 2);
  assert.equal(quality.get().msaa, 2);
});
