import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as Cesium from 'cesium';
import {
  countFadingRenderEntries,
  destroyDetection,
  detectionDebugRequested,
  getDetectionDiagnostics,
  getDetectionTheme,
  getMode,
  initDetection,
  isDetectionSuspended,
  resumeDetection,
  setDetectionStyle,
  setDetectionTuning,
  setMode,
  suspendDetection,
} from './detection.js';
import {
  destroyWorldOverlay,
  initWorldOverlay,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { DETECTION_THEME_MAP } from '../overlays/worldOverlayTokens.js';

test('detection diagnostics count rendered fading rows instead of absent selected identities', () => {
  assert.equal(countFadingRenderEntries([
    { selected: true },
    { selected: false },
    { selected: true },
    { selected: false },
  ]), 2);
  assert.equal(countFadingRenderEntries([{ selected: true }, { selected: true }]), 0);
});

class MockEvent {
  constructor() { this.listeners = new Set(); }

  addEventListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  raise() {
    for (const listener of [...this.listeners]) listener();
  }
}

class MockPath2D {
  moveTo() {}
  lineTo() {}
  roundRect() {}
  arcTo() {}
  closePath() {}
}

function mockContext(target, trace) {
  const calls = [];
  const record = (...call) => {
    calls.push(call);
    trace.push([target, ...call]);
  };
  let filter = 'none';
  let strokeStyle = '';
  let globalCompositeOperation = 'source-over';
  return {
    calls,
    font: '',
    get filter() { return filter; },
    set filter(value) { filter = value; record('filter', value); },
    fillStyle: '',
    get strokeStyle() { return strokeStyle; },
    set strokeStyle(value) { strokeStyle = value; record('strokeStyle', value); },
    globalAlpha: 1,
    get globalCompositeOperation() { return globalCompositeOperation; },
    set globalCompositeOperation(value) { globalCompositeOperation = value; record('globalCompositeOperation', value); },
    lineWidth: 1,
    measureText(text) { return { width: String(text).length * 6 }; },
    setTransform(...args) { record('setTransform', ...args); },
    clearRect(...args) { record('clearRect', ...args); },
    save() { record('save'); },
    restore() { record('restore'); },
    translate(...args) { record('translate', ...args); },
    scale(...args) { record('scale', ...args); },
    beginPath() { record('beginPath'); },
    rect(...args) { record('rect', ...args); },
    clip(...args) { record('clip', ...args); },
    moveTo(...args) { record('moveTo', ...args); },
    lineTo(...args) { record('lineTo', ...args); },
    arc(...args) { record('arc', ...args); },
    arcTo(...args) { record('arcTo', ...args); },
    closePath() { record('closePath'); },
    // The style is recorded AT fill time, not on assignment, so a pin can prove
    // which plate token actually reached the canvas rather than which one was
    // set at some point during the frame. globalAlpha rides along for the same
    // reason: the backdrop feather is an alpha, not a colour.
    fill(path) { record('fill', path, this.fillStyle, this.globalAlpha); },
    stroke(path) { record('stroke', path); },
    fillRect(...args) { record('fillRect', ...args); },
    fillText(...args) { record('fillText', ...args); },
    drawImage(...args) { record('drawImage', ...args); },
  };
}

// `search` seeds window.location.search. The detection mode banner is developer
// telemetry gated behind ?detectDebug=1, so any test that uses the banner as its
// "did this frame repaint" probe must opt in explicitly.
function installEnvironment({ width = 800, height = 600, dpr = 2, search = '' } = {}) {
  const byId = new Map();
  const paintTrace = [];
  const ctx = mockContext('shared', paintTrace);
  const detectionCtx = mockContext('detection', paintTrace);
  const originalPerformance = Object.getOwnPropertyDescriptor(globalThis, 'performance');
  const originalDateNow = Date.now;
  const originalPath2D = globalThis.Path2D;
  let currentTime = 1_000;
  let performanceStep = 0;
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    value: { now: () => {
      const value = currentTime;
      currentTime += performanceStep;
      return value;
    } },
  });
  Date.now = () => currentTime;
  globalThis.Path2D = MockPath2D;

  class MockElement {
    constructor(tagName) {
      this.tagName = tagName.toUpperCase();
      this.id = '';
      this.children = [];
      this.parentElement = null;
      this.style = {};
      this.dataset = {};
      this.hidden = false;
      this.width = 0;
      this.height = 0;
      this.clientWidth = width;
      this.clientHeight = height;
      this._rect = { left: 0, top: 0, width, height };
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      register(child);
      return child;
    }

    insertBefore(child, before) {
      child.parentElement = this;
      const index = this.children.indexOf(before);
      if (index < 0) this.children.push(child);
      else this.children.splice(index, 0, child);
      register(child);
      return child;
    }

    setAttribute(name, value) {
      if (name === 'id') this.id = String(value);
      else this[name] = String(value);
      register(this);
    }

    getBoundingClientRect() { return this._rect; }
    getContext() {
      if (this.tagName !== 'CANVAS') return null;
      return this.id === 'world-overlay-detection-surface' ? detectionCtx : ctx;
    }

    querySelector(selector) {
      const wanted = selector.slice(1);
      return this.children.find((child) => child.id === wanted) || null;
    }

    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
      }
      unregister(this);
      this.parentElement = null;
    }

    get nextSibling() { return null; }
  }

  function register(element) {
    if (element.id) byId.set(element.id, element);
    for (const child of element.children) register(child);
  }

  function unregister(element) {
    if (element.id) byId.delete(element.id);
    for (const child of element.children) unregister(child);
  }

  const body = new MockElement('body');
  body.classList = { contains() { return false; } };
  const document = {
    body,
    createElement(tagName) { return new MockElement(tagName); },
    getElementById(id) { return byId.get(id) || null; },
    querySelector(selector) { return byId.get(selector.slice(1)) || null; },
    querySelectorAll(selector) {
      const element = selector.startsWith('#') ? byId.get(selector.slice(1)) : null;
      return element ? [element] : [];
    },
  };
  const window = {
    devicePixelRatio: dpr,
    location: { search },
    addEventListener() {},
    removeEventListener() {},
    getComputedStyle() { return { display: 'block', visibility: 'visible', opacity: '1' }; },
  };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  globalThis.document = document;
  globalThis.window = window;

  const container = new MockElement('div');
  container.id = 'cesiumContainer';
  body.appendChild(container);
  const root = new MockElement('div');
  root.id = 'world-overlay-root';
  body.appendChild(root);
  const canvas = new MockElement('canvas');
  canvas.id = 'world-overlay-canvas';
  root.appendChild(canvas);

  const postRender = new MockEvent();
  const viewer = {
    container,
    canvas: { clientWidth: width, clientHeight: height },
    camera: {
      positionWC: new Cesium.Cartesian3(0, 0, 10_000_000),
      positionCartographic: { height: 1_000_000 },
      viewMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY),
      frustum: { projectionMatrix: Cesium.Matrix4.clone(Cesium.Matrix4.IDENTITY) },
      moveEnd: new MockEvent(),
    },
    scene: { postRender, requestRender() {} },
  };

  return {
    viewer,
    postRender,
    document,
    ctx,
    detectionCtx,
    paintTrace,
    advance(ms) { currentTime += ms; },
    setPerformanceStep(ms) { performanceStep = ms; },
    cleanup() {
      destroyDetection();
      destroyWorldOverlay();
      Date.now = originalDateNow;
      if (originalPath2D === undefined) delete globalThis.Path2D;
      else globalThis.Path2D = originalPath2D;
      delete globalThis.document;
      delete globalThis.window;
      delete globalThis.ResizeObserver;
      delete globalThis.MutationObserver;
      if (originalPerformance) Object.defineProperty(globalThis, 'performance', originalPerformance);
      else delete globalThis.performance;
    },
  };
}

function detectableLayer() {
  const positions = [
    new Cesium.Cartesian3(0, 0, 6_356_752),
    new Cesium.Cartesian3(10_000, 0, 6_356_740),
  ];
  return {
    id: 'flights',
    getDetectableObjects() {
      return positions.map((position, index) => ({
        position,
        sourceId: `flight-${index}`,
        id: `TEST${index}`,
        metric: `FL${300 + index}`,
        type: 'AIR',
      }));
    },
  };
}

function militaryLayer() {
  return {
    id: 'military',
    getDetectableObjects() {
      return [{
        position: new Cesium.Cartesian3(0, 0, 6_356_752),
        sourceId: 'military-pin',
        id: 'MIL-PIN',
        metric: 'FL450',
        type: 'AIR',
        tier: 'military',
      }];
    },
  };
}

// One air contact and one space contact, both on screen. The mock camera
// projects through an identity view-projection, so a position's x/y ARE its
// normalized device coordinates; these two land ~320px apart and both survive
// the declutter.
function mixedTierLayer() {
  return {
    id: 'mixed',
    getDetectableObjects() {
      return [
        {
          position: new Cesium.Cartesian3(-0.4, 0.2, 6_356_752),
          sourceId: 'air-1',
          id: 'AIRONE',
          metric: 'FL350',
          type: 'AIR',
        },
        {
          position: new Cesium.Cartesian3(0.4, -0.2, 6_356_752),
          sourceId: 'sat-1',
          id: 'SATONE',
          metric: '412KM',
          type: 'SAT',
        },
      ];
    },
  };
}

/** Fill styles that actually reached the shared normal-blend canvas. */
function sharedFillStyles(env) {
  return env.ctx.calls
    .filter(([name]) => name === 'fill')
    .map(([, , fillStyle]) => fillStyle);
}

/** Settle a frame so the arbiter has promoted its identities to render entries. */
function settleFrame(env) {
  env.advance(250);
  env.postRender.raise();
}


test('callouts stop painting the moment the last detectable object goes away', () => {
  // The callout lane replays the previous solve on frames the sensor lane
  // skips under load, which is what keeps plates from strobing against
  // persistent brackets. The cost of that design is that an empty field MUST
  // clear the replay buffer, or the final callsigns stay stranded on the
  // shared canvas after the last data layer is switched off.
  const env = installEnvironment();
  let objects = [{
    position: new Cesium.Cartesian3(0, 0, 6_356_752),
    sourceId: 'lonely-1',
    id: 'LASTONE',
    metric: 'FL120',
    type: 'AIR',
  }];
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'flights', getDetectableObjects: () => objects }], () => {});
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    // The first frame solves; the arbiter hands the identity back as a render
    // entry on the frame after that.
    env.advance(250);
    env.postRender.raise();
    assert.ok(
      env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'LASTONE'),
      'the callout paints on the shared canvas while the contact exists',
    );

    objects = [];
    env.ctx.calls.length = 0;
    env.advance(250);
    env.postRender.raise();
    env.advance(250);
    env.postRender.raise();
    assert.ok(
      !env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'LASTONE'),
      'an empty field must drop the replay buffer, not strand the last callsign',
    );
  } finally {
    env.cleanup();
  }
});


test('pathological detection paint holds alternate frames without freezing shared lanes', () => {
  // Opts into the telemetry banner: the held-frame assertions count banner paints.
  const env = installEnvironment({ search: '?detectDebug=1' });
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], () => {});
    setOverlayEntries('valve-card', [{
      id: 'ambient-card',
      position: new Cesium.Cartesian3(0, 0, 0),
      variant: 'label',
      title: 'AMBIENT-CONTINUES',
      selected: true,
      protected: true,
      horizonCull: false,
      edgeFade: 'none',
    }]);
    setMode('DENSE');
    env.advance(250);
    env.setPerformanceStep(30);

    env.postRender.raise();
    env.postRender.raise();
    const detectionClears = env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length;
    const detectionBanners = env.detectionCtx.calls.filter(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')).length;
    const sharedClears = env.ctx.calls.filter(([name]) => name === 'clearRect').length;
    const sharedCards = env.ctx.calls.filter(([name, text]) => name === 'fillText'
      && text === 'AMBIENT-CONTINUES').length;

    env.postRender.raise();
    assert.equal(env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length, detectionClears,
      'the host preserves detection pixels on the held odd frame');
    assert.equal(env.detectionCtx.calls.filter(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')).length, detectionBanners);
    assert.equal(env.ctx.calls.filter(([name]) => name === 'clearRect').length, sharedClears + 1,
      'the shared surface still clears');
    assert.equal(env.ctx.calls.filter(([name, text]) => name === 'fillText'
      && text === 'AMBIENT-CONTINUES').length, sharedCards + 1,
      'the shared lane still repaints');
    assert.equal(getDetectionDiagnostics().throttleSkipCount, 1);

    env.postRender.raise();
    assert.equal(env.detectionCtx.calls.filter(([name]) => name === 'clearRect').length,
      detectionClears + 1, 'the next even frame repaints detection');
    assert.equal(getDetectionDiagnostics().throttleSkipCount, 1);
  } finally {
    env.cleanup();
  }
});


// ── Developer telemetry gate (2026-08-20 QA hunt) ───────────────────────────
// The orange mode banner ("DENSE  VIS:15  SRC:1036  DENS:100%  ELASTIC  0.4ms")
// painted for every user, so engine
// telemetry was the first thing a visitor saw, overlapping the tracked-contact readout
// block. It is kept as a debug affordance, but must default OFF.
test('detectionDebugRequested parses the query-string gate and nothing else', () => {
  assert.equal(detectionDebugRequested('?detectDebug=1'), true);
  assert.equal(detectionDebugRequested('?foo=bar&detectDebug=1'), true);
  assert.equal(detectionDebugRequested(''), false);
  assert.equal(detectionDebugRequested('?detectDebug=0'), false);
  assert.equal(detectionDebugRequested('?detectDebug'), false);
  assert.equal(detectionDebugRequested('?detectdebug=1'), false, 'the flag is case-sensitive');
  assert.equal(detectionDebugRequested(undefined), false);
  assert.equal(detectionDebugRequested(null), false);
});

test('the mode banner is absent by default and present behind the flag', () => {
  const bannerPaints = (env) => env.detectionCtx.calls.filter(([name, text]) => (
    name === 'fillText' && /^(SPARSE|BALANCED|DENSE)  VIS:/.test(String(text))
  )).length;

  const painted = (search) => {
    const env = installEnvironment({ search });
    try {
      initWorldOverlay(env.viewer);
      initDetection(env.viewer, [detectableLayer()], () => {});
      setMode('DENSE');
      env.advance(250);
      env.postRender.raise();
      // The overlay is alive either way — brackets still stroke.
      assert.ok(
        env.detectionCtx.calls.some(([name, path]) => name === 'stroke' && path instanceof MockPath2D),
        'detection still paints its contacts regardless of the debug gate',
      );
      return bannerPaints(env);
    } finally {
      destroyDetection();
      destroyWorldOverlay();
      env.cleanup();
    }
  };

  assert.equal(painted(''), 0, 'users must never see the engine telemetry banner');
  assert.ok(painted('?detectDebug=1') > 0, 'the flag brings the telemetry back');
});

test('detection telemetry stays reachable programmatically with the banner hidden', () => {
  // Hiding the banner must not remove the numbers — getDetectionDiagnostics()
  // is the supported way to read them, and is what the QA harnesses use.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], () => {});
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    const diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.profile, 'DENSE');
    assert.equal(typeof diagnostics.observationCount, 'number');
    assert.equal(typeof diagnostics.visibleCount, 'number');
    assert.equal(typeof diagnostics.densityPct, 'number');
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('civilian and military AIR brackets cover front, left, and right at Sparse density', () => {
  for (const layerId of ['flights', 'military']) {
    const env = installEnvironment({ width: 900, height: 600, dpr: 1 });
    try {
      const objects = [-0.82, 0, 0.82].map((x, index) => ({
        position: new Cesium.Cartesian3(x, 0, 6_356_752),
        sourceId: `${layerId}-${index}`,
        id: `${layerId.toUpperCase()}-${index}`,
        metric: 'FL120',
        type: 'AIR',
      }));
      initWorldOverlay(env.viewer);
      initDetection(env.viewer, [{ id: layerId, getDetectableObjects: () => objects }], () => {});
      setDetectionTuning({ densityPct: 25 });
      setMode('SPARSE');
      settleFrame(env);
      const diagnostics = getDetectionDiagnostics();
      assert.deepEqual(
        diagnostics.aircraftBracketSectors,
        { left: 1, front: 1, right: 1 },
        `${layerId} side brackets must not be starved by the central keyhole`,
      );
      assert.equal(diagnostics.visibleCount, 3);
      assert.equal(diagnostics.densityPct, 25);
      assert.equal(diagnostics.profile, 'SPARSE');
      assert.ok(diagnostics.selectedCount <= diagnostics.collectiveLabelBudget,
        'Sparse keeps its documented budget instead of silently becoming Dense');
    } finally {
      destroyDetection();
      destroyWorldOverlay();
      env.cleanup();
    }
  }
});

/**
 * Two air contacts at the same screen radius, one with the planet behind it and
 * one with sky. The mock camera sits at (0, 0, 10 000 km) and projects through
 * an identity view-projection, so a position's x/y ARE its NDC and z is free:
 * the pole-surface contact looks straight down the axis into the planet, while
 * its mirror sits 10 000 km FURTHER out, so the view ray through it escapes.
 * Equal screen radius keeps the keyhole's radial fade identical for both, which
 * makes the two painted plate alphas directly comparable.
 */
function backdropLayer() {
  return {
    id: 'flights',
    getDetectableObjects() {
      return [
        {
          position: new Cesium.Cartesian3(-0.4, 0.2, 6_356_752),
          sourceId: 'ground-1', id: 'GROUNDED', metric: 'FL100', type: 'AIR',
        },
        {
          position: new Cesium.Cartesian3(0.4, -0.2, 20_000_000),
          sourceId: 'sky-1', id: 'SKYBACK', metric: 'FL400', type: 'AIR',
        },
      ];
    },
  };
}

test('the backdrop feather reaches the canvas as a lighter plate against sky', () => {
  // The discriminator and the painter are pinned in their own modules, but both
  // pins still pass if detection stops carrying the factor between them. This
  // drives the real collect → solve → stash → replay path and reads the alpha
  // the shared canvas actually received for each plate.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [backdropLayer()], () => {});
    setDetectionStyle('normal');
    setMode('DENSE');
    settleFrame(env);
    env.ctx.calls.length = 0;
    settleFrame(env);

    const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
    assert.ok(painted('GROUNDED') && painted('SKYBACK'), 'both backdrops reached the frame under test');

    const plate = DETECTION_THEME_MAP._default.calloutPlate;
    const plateAlphas = env.ctx.calls
      .filter(([name, , fillStyle]) => name === 'fill' && fillStyle === plate)
      .map(([, , , globalAlpha]) => globalAlpha);
    assert.equal(plateAlphas.length, 2, 'exactly one plate per contact');

    const heaviest = Math.max(...plateAlphas);
    const lightest = Math.min(...plateAlphas);
    assert.ok(heaviest > 0, 'the grounded contact still gets a plate');
    assert.ok(lightest > 0, 'the sky contact keeps a whisper rather than vanishing');
    // Reverting the feature makes both plates equal, which fails here first.
    assert.ok(
      lightest < heaviest * 0.5,
      `sky plate ${lightest} must be markedly lighter than ground plate ${heaviest}`,
    );
  } finally {
    env.cleanup();
  }
});
