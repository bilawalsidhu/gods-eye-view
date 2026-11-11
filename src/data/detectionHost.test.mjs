import { readShellSource } from '../testSupport/readShellSource.mjs';
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
  getOverlayPaintRect,
  initWorldOverlay,
  setOverlayEntries,
} from '../overlays/worldOverlay.js';
import { applyVesselOverlayPolicy } from './vesselLabels.js';
import {
  getKeyholeFadeTuning,
  getKeyholeGeometry,
  keyholeLabelAlphaFromGeometry,
} from '../celestialRing.js';
import { DETECTION_THEME_MAP } from '../overlays/worldOverlayTokens.js';
import {
  clearAwarenessEchoField,
  setAwarenessEchoField,
} from '../awarenessEcho.js';
import { composeLabel, resolveTier } from './detectionDraw.js';
import {
  createFakeDepthScene,
  createFakeGl,
  depthImage,
  viewDistanceToDepth,
} from './fixtures/fakeDepthScene.mjs';

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
  constructor() { this.points = []; }
  moveTo(x, y) { this.points.push([x, y]); }
  lineTo(x, y) { this.points.push([x, y]); }
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
    stroke(path) { record('stroke', path, this.strokeStyle, this.lineWidth, this.globalAlpha); },
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

test('detection lifecycle re-hosts unchanged painters behind the sole host listener', () => {
  // Opts into the telemetry banner: this test reads it as the repaint probe.
  const env = installEnvironment({ search: '?detectDebug=1' });
  const modes = [];
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [detectableLayer()], (mode) => modes.push(mode));
    assert.equal(env.postRender.listeners.size, 1);
    assert.equal(env.document.getElementById('detection-overlay'), null);
    assert.ok(env.document.getElementById('world-overlay-canvas'));
    const surface = env.document.getElementById('world-overlay-detection-surface');
    const root = env.document.getElementById('world-overlay-root');
    const mainCanvas = env.document.getElementById('world-overlay-canvas');
    assert.ok(surface);
    // The surface must sit in the Cesium container (no stacking context
    // between it and the WebGL canvas) or its `screen` blend is discarded;
    // ordering under the card canvas is carried by z-index, not siblinghood.
    assert.equal(surface.parentElement, env.viewer.container);
    assert.deepEqual(root.children, [mainCanvas]);
    assert.equal(surface.style.mixBlendMode, 'screen');
    assert.equal(
      surface.style.filter,
      'contrast(1.05) saturate(1.05) drop-shadow(0 0 3px rgba(0, 244, 255, 0.4))',
    );
    assert.equal(surface.style.display, 'none');

    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    const first = getDetectionDiagnostics();
    assert.equal(first.profile, 'DENSE');
    assert.ok(Array.isArray(first.calloutRects));
    if (first.calloutRects.length) {
      const x=first.calloutRects[0].x;
      first.calloutRects[0].x=NaN;
      assert.equal(getDetectionDiagnostics().calloutRects[0].x,x,'QA owns a copy, never a live plate');
    }
    assert.equal(first.observationCount, 2);
    assert.equal(first.didSolve, true);
    assert.ok(first.solveRevision > 0);
    assert.ok(first.collectiveLabelBudget > 0);
    assert.ok(first.bracketOpacityCounts.full + first.bracketOpacityCounts.partial > 0);
    assert.ok(env.detectionCtx.calls.some(([name, text]) => name === 'fillText'
      && String(text).startsWith('DENSE  VIS:')));
    assert.ok(env.detectionCtx.calls.some(([name, path]) => name === 'stroke' && path instanceof MockPath2D));
    assert.ok(env.detectionCtx.calls.some(([name]) => name === 'fillRect'), 'scanlines and banner still paint');
    assert.equal(env.detectionCtx.globalCompositeOperation, 'source-over');
    assert.equal(env.detectionCtx.filter, 'none');
    assert.equal(surface.style.display, 'block');
    const canvas = env.document.getElementById('world-overlay-canvas');
    assert.equal(Number(canvas.dataset.solveRevision), first.solveRevision);
    assert.equal(canvas.dataset.profile, 'DENSE');

    // The existing 125 ms arbiter cadence remains authoritative.
    env.advance(124);
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().solveRevision, first.solveRevision);
    // Callsigns paint on the SHARED normal-blend canvas, never on the
    // screen-blended sensor surface: `screen` can only lighten, so a callout's
    // dark backing plate is a no-op over sunlit ground and the text dissolves
    // into it. Brackets, banner and scanlines stay on the sensor surface.
    assert.ok(env.ctx.calls.some(([name, text]) => name === 'fillText' && text === 'TEST0'));
    assert.ok(!env.detectionCtx.calls.some(([name, text]) => name === 'fillText' && text === 'TEST0'));
    env.advance(1);
    env.postRender.raise();
    assert.ok(getDetectionDiagnostics().solveRevision > first.solveRevision);

    setDetectionTuning({ densityPct: 25, allocationStrategy: 'WEIGHTED' });
    env.postRender.raise();
    assert.equal(getMode(), 'SPARSE');
    assert.equal(getDetectionDiagnostics().profile, 'SPARSE');
    assert.equal(getDetectionDiagnostics().allocationStrategy, 'WEIGHTED');
    assert.ok(env.detectionCtx.calls.some(([name]) => name === 'arc'), 'sparse focus ring remains available');

    setMode('BALANCED');
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().profile, 'BALANCED');
    setMode('DENSE');
    env.postRender.raise();
    assert.equal(getDetectionDiagnostics().profile, 'DENSE');

    const bannerCount = () => env.detectionCtx.calls.filter(([name, text]) => (
      name === 'fillText' && /^(SPARSE|BALANCED|DENSE)  VIS:/.test(String(text))
    )).length;
    const beforeSuspend = bannerCount();
    suspendDetection('intercity');
    assert.equal(isDetectionSuspended(), true);
    assert.equal(surface.style.opacity, '0');
    env.postRender.raise();
    assert.equal(bannerCount(), beforeSuspend);
    assert.equal(env.postRender.listeners.size, 1);
    resumeDetection();
    env.postRender.raise();
    assert.equal(isDetectionSuspended(), false);
    assert.equal(surface.style.opacity, '1');
    assert.ok(bannerCount() > beforeSuspend);

    // These are the exact engine calls made by military style presets after
    // their production UI gate chooses CRT/NVG/FLIR defaults.
    const expectedThemes = {
      retro: 'contrast(1.08) saturate(1.04) drop-shadow(0 0 3px rgba(255, 176, 56, 0.45))',
      surveillance: 'contrast(1.12) saturate(1.12) drop-shadow(0 0 3px rgba(120, 255, 120, 0.42))',
      thermal: 'contrast(1.1) saturate(1.08) drop-shadow(0 0 3px rgba(255, 224, 170, 0.42))',
    };
    for (const style of ['retro', 'surveillance', 'thermal']) {
      setMode('OFF');
      setDetectionStyle(style);
      assert.equal(surface.style.mixBlendMode, 'screen');
      assert.equal(surface.style.filter, expectedThemes[style]);
      setDetectionTuning({ densityPct: 75 });
      setMode('DENSE');
      env.postRender.raise();
      assert.equal(getDetectionDiagnostics().profile, 'DENSE');
      assert.ok(getDetectionTheme().line);
      assert.equal(env.postRender.listeners.size, 1);
    }

    setMode('OFF');
    setDetectionStyle('normal');
    assert.equal(surface.style.mixBlendMode, 'screen');
    assert.equal(
      surface.style.filter,
      'contrast(1.05) saturate(1.05) drop-shadow(0 0 3px rgba(0, 244, 255, 0.4))',
    );
    env.postRender.raise();
    assert.equal(getMode(), 'OFF');
    assert.equal(surface.style.display, 'none');
    assert.equal(env.postRender.listeners.size, 1);
    assert.ok(modes.includes('SPARSE') && modes.includes('BALANCED') && modes.includes('DENSE'));

    destroyDetection();
    assert.equal(env.postRender.listeners.size, 1, 'detection never owns the listener');
    setMode('DENSE');
    env.postRender.raise();
    assert.equal(env.document.getElementById('detection-overlay'), null);
    destroyWorldOverlay();
    assert.equal(env.postRender.listeners.size, 0);
    assert.equal(env.document.getElementById('world-overlay-canvas'), null);
    assert.equal(env.document.getElementById('world-overlay-detection-surface'), null);
  } finally {
    env.cleanup();
  }
});

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

test('every style paints its OWN plate token through the production callout path', () => {
  // The token table and the direct painter are both pinned elsewhere, but a
  // pin on either one still passes if the runtime stops consulting the active
  // theme and freezes on a single plate. This drives the real stash → replay
  // path once per style and reads the fill style the shared canvas received.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [mixedTierLayer()], () => {});
    setMode('DENSE');
    settleFrame(env);
    settleFrame(env);

    for (const style of ['surveillance', 'retro', 'thermal', 'normal']) {
      setDetectionStyle(style);
      settleFrame(env);
      env.ctx.calls.length = 0;
      settleFrame(env);

      const theme = DETECTION_THEME_MAP[style] || DETECTION_THEME_MAP._default;
      const fills = sharedFillStyles(env);
      assert.ok(
        fills.includes(theme.calloutPlate),
        `${style} must paint its own callout plate (${theme.calloutPlate})`,
      );
      for (const [otherName, other] of Object.entries(DETECTION_THEME_MAP)) {
        if (other.calloutPlate === theme.calloutPlate) continue;
        assert.ok(
          !fills.includes(other.calloutPlate),
          `${style} must not paint the ${otherName} plate`,
        );
      }
    }
  } finally {
    env.cleanup();
  }
});

/** A vessel detection contact that names its ambient card, like the AIS layer does. */
function shipWithCard(mmsi, position) {
  return {
    position,
    sourceId: mmsi,
    id: `SHIP-${mmsi}`,
    metric: '6 kn',
    type: 'SEA',
    cardSourceId: 'ais-live-vessels',
    cardEntryId: `vessel:${mmsi}`,
  };
}

/** The production ambient vessel card (not protected: it goes through the arbiter). */
function ambientVesselCard(mmsi, position) {
  return applyVesselOverlayPolicy({
    id: `vessel:${mmsi}`,
    position,
    title: `CARD-${mmsi}`,
    details: ['CARGO · 6KT · 80°'],
    gapPx: 10,
  });
}

test('a callout stays readable when its own card is faded out at the keyhole rim', () => {
  // Default keyhole tuning: 7% feather, 1% outside opacity.
  assert.deepEqual(getKeyholeFadeTuning(), { fadeRatio: 0.07, outsideOpacity: 0.01 });
  const width = 1600;
  const height = 900;
  const keyhole = getKeyholeGeometry(width, height);
  const env = installEnvironment({ width, height, dpr: 1 });
  // Just outside the keyhole's left rim: the card sits above or below the
  // anchor (outside, 1% alpha), the callout to its right (inside the feather).
  const position = new Cesium.Cartesian3(270 / (width / 2) - 1, 1 - 460 / (height / 2), 6_356_752);
  const ship = shipWithCard('200', position);
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'ais-live-vessels', getDetectableObjects: () => [ship] }], () => {});
    setMode('DENSE');
    for (let i = 0; i < 4; i++) settleFrame(env);
    const [alone] = getDetectionDiagnostics().calloutRects;
    assert.ok(alone && alone.alpha >= 0.5, 'without a card the callout is clearly visible');

    setOverlayEntries('ais-live-vessels', [ambientVesselCard('200', position)]);
    for (let i = 0; i < 4; i++) settleFrame(env);
    const rect = getOverlayPaintRect('ais-live-vessels', 'vessel:200');
    assert.ok(rect, 'the host paints the card (at the outside opacity)');
    const cardAlpha = keyholeLabelAlphaFromGeometry(rect.x + rect.w / 2, rect.y + rect.h / 2, keyhole);
    assert.ok(cardAlpha <= 0.05, `the card is invisible at the rim (keyhole alpha ${cardAlpha})`);

    const callouts = getDetectionDiagnostics().calloutRects;
    assert.equal(callouts.length, 1, 'the callout keeps painting while its card is faded out');
    assert.ok(callouts[0].alpha >= 0.4, 'and stays readable');
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('a callout stays hidden while its card fades out after leaving the published cohort', () => {
  const env = installEnvironment({ width: 1600, height: 900, dpr: 1 });
  const at = (x, y) => new Cesium.Cartesian3(x, y, 6_356_752);
  const ship = shipWithCard('200', at(0.1, 0.1));
  const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
  const frame = (ms) => {
    env.ctx.calls.length = 0;
    env.advance(ms);
    env.postRender.raise();
  };
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'ais-live-vessels', getDetectableObjects: () => [ship] }], () => {});
    setMode('DENSE');
    setOverlayEntries('ais-live-vessels', [ambientVesselCard('200', ship.position)]);
    for (let i = 0; i < 6; i++) frame(250);
    frame(16);
    assert.ok(painted('CARD-200') && !painted('SHIP-200'), 'steady state: card only');

    // The vessel layer republishes its screen-grid cohort after a camera move:
    // this vessel's card is replaced by another one, the vessel stays detectable.
    setOverlayEntries('ais-live-vessels', [ambientVesselCard('300', at(-0.5, -0.4))]);
    frame(16);
    assert.ok(getOverlayPaintRect('ais-live-vessels', 'vessel:200'), 'the dropped card is still fading out');
    assert.ok(painted('CARD-200'), 'and its text still paints');
    assert.ok(!painted('SHIP-200'), 'no full callout under the fading card');

    for (let i = 0; i < 4; i++) frame(250);
    assert.ok(!painted('CARD-200'), 'the card has faded out');
    assert.ok(painted('SHIP-200'), 'and the callout is back');
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('a vessel whose ambient card loses the collision keeps its callout', () => {
  const env = installEnvironment({ width: 900, height: 600, dpr: 1 });
  // Four vessels a few pixels apart: their cards collide (a card goes only
  // above or below its anchor), so the arbiter paints only some of them.
  const ships = [0, 1, 2, 3].map((i) =>
    shipWithCard(String(100 + i), new Cesium.Cartesian3(-0.2 + i * 0.005, i * 0.005, 6_356_752)),
  );
  const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'ais-live-vessels', getDetectableObjects: () => ships }], () => {});
    setOverlayEntries(
      'ais-live-vessels',
      ships.map((ship) => ambientVesselCard(ship.sourceId, ship.position)),
    );
    setMode('DENSE');
    for (let i = 0; i < 4; i++) settleFrame(env);
    env.ctx.calls.length = 0;
    settleFrame(env);

    const winners = ships.filter((ship) => getOverlayPaintRect('ais-live-vessels', ship.cardEntryId));
    assert.ok(
      winners.length >= 1 && winners.length < ships.length,
      `the colliding cards leave some unpainted (${winners.length} of ${ships.length} painted)`,
    );
    for (const ship of ships) {
      const carded = winners.includes(ship);
      assert.equal(
        painted(ship.id),
        !carded,
        carded ? `${ship.id} draws no callout under its card` : `${ship.id} keeps its callout`,
      );
    }
    assert.equal(
      getDetectionDiagnostics().calloutRects.length,
      ships.length - winners.length,
      'only the callouts that painted are reported',
    );
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('a callout fades out while its card fades in instead of vanishing at once', () => {
  const env = installEnvironment({ width: 1600, height: 900, dpr: 1 });
  const ship = shipWithCard('200', new Cesium.Cartesian3(0.1, 0.1, 6_356_752));
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [{ id: 'ais-live-vessels', getDetectableObjects: () => [ship] }], () => {});
    setMode('DENSE');
    for (let i = 0; i < 4; i++) settleFrame(env);
    const [alone] = getDetectionDiagnostics().calloutRects;
    assert.ok(alone.alpha >= 0.9, 'the callout starts fully visible');

    setOverlayEntries('ais-live-vessels', [ambientVesselCard('200', ship.position)]);
    const alphas = [];
    for (let i = 0; i < 30; i++) {
      env.advance(16);
      env.postRender.raise();
      alphas.push(getDetectionDiagnostics().calloutRects[0]?.alpha ?? 0);
    }
    assert.ok(
      alphas.some((alpha) => alpha > 0.1 && alpha < alone.alpha - 0.1),
      `the callout passes through partial opacity: ${alphas.map((a) => a.toFixed(2)).join(' ')}`,
    );
    assert.equal(alphas.at(-1), 0, 'and is gone once the card is fully in');
  } finally {
    destroyDetection();
    destroyWorldOverlay();
    env.cleanup();
  }
});

test('space-tier callouts take the heavier plate while air contacts keep the light one', () => {
  // Satellites sit over the high-albedo lit Earth disc far more often than
  // aircraft do, so the space tier carries the heavier backing. Losing the
  // tier split is invisible to the token table — only a frame carrying BOTH
  // tiers at once can show it.
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [mixedTierLayer()], () => {});
    setDetectionStyle('surveillance');
    setMode('DENSE');
    settleFrame(env);
    env.ctx.calls.length = 0;
    settleFrame(env);

    const theme = DETECTION_THEME_MAP.surveillance;
    assert.notEqual(
      theme.calloutPlate,
      theme.calloutPlateSpace,
      'the fixture is only meaningful while the two tiers differ',
    );
    const painted = (text) => env.ctx.calls.some(([name, value]) => name === 'fillText' && value === text);
    assert.ok(painted('AIRONE') && painted('SATONE'), 'both tiers reached the frame under test');

    const fills = sharedFillStyles(env);
    assert.ok(fills.includes(theme.calloutPlate), 'the air contact keeps the light plate');
    assert.ok(fills.includes(theme.calloutPlateSpace), 'the space contact takes the heavier plate');
  } finally {
    env.cleanup();
  }
});

test('surveillance military tier reaches the dedicated render target as shipped red', () => {
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [militaryLayer()], () => {});
    setDetectionStyle('surveillance');
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();

    assert.ok(
      env.detectionCtx.calls.some(([name, value]) => name === 'strokeStyle' && value === '#ff5a47'),
      'the production projection/tier/batched-bracket paint path emits surveillance military red',
    );
    assert.ok(env.detectionCtx.calls.some(([name, path]) => name === 'stroke'
      && path instanceof MockPath2D));
  } finally {
    env.cleanup();
  }
});

test('Global Context echo brackets reach the canvas in the detection style colour', () => {
  const env = installEnvironment();
  // Fronts every millisecond with a long fade, so the contact is lit on
  // whatever frame paints; a distinctive width picks the echo stroke out.
  const echo = {
    layerIds: ['military'],
    fadeMs: 60_000,
    color: 'rgb(1, 2, 3)',
    spreadPx: 8,
    lineWidth: 3.25,
  };
  const echoStrokes = () =>
    env.detectionCtx.calls
      .filter(([name, , , width]) => name === 'stroke' && width === echo.lineWidth)
      .map(([, , style]) => style);
  try {
    setAwarenessEchoField({
      center: Cesium.Cartesian3.fromDegrees(0, 89, 0),
      radiusM: 250_000,
      pulse: { count: 1000, periodMs: 1000, startFraction: 0 },
      echo,
    });
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [militaryLayer()], () => {});
    setMode('DENSE');
    setDetectionStyle('normal');
    settleFrame(env);
    assert.ok(echoStrokes().length > 0, 'the echo bracket is painted');
    assert.ok(echoStrokes().every((style) => style === echo.color));

    // CRT, NVG and FLIR keep their own palettes.
    for (const style of ['retro', 'surveillance', 'thermal']) {
      env.detectionCtx.calls.length = 0;
      setDetectionStyle(style);
      settleFrame(env);
      const strokes = echoStrokes();
      assert.ok(strokes.length > 0, style);
      assert.ok(
        strokes.every((stroke) => stroke === DETECTION_THEME_MAP[style].line),
        `${style} echoes take the style line colour, got ${strokes}`,
      );
    }

  } finally {
    clearAwarenessEchoField();
    env.cleanup();
  }
});

test('a Global Context echo bracket is drawn outside its contact bracket and dimmer than it', () => {
  const env = installEnvironment();
  const echo = {
    layerIds: ['military'],
    fadeMs: 60_000,
    color: 'rgb(1, 2, 3)',
    spreadPx: 8,
    lineWidth: 3.25,
  };
  // Fronts every millisecond keep the echo at full strength; a level of 0.5
  // halves it, so it sits 4 px out and draws at half the bracket's alpha.
  try {
    setAwarenessEchoField({
      center: Cesium.Cartesian3.fromDegrees(0, 89, 0),
      radiusM: 250_000,
      pulse: { count: 1000, periodMs: 1000, startFraction: 0 },
      echo,
      level: () => 0.5,
    });
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [militaryLayer()], () => {});
    setMode('DENSE');
    setDetectionStyle('normal');
    settleFrame(env);
    env.detectionCtx.calls.length = 0;
    settleFrame(env);
    const strokes = env.detectionCtx.calls.filter(([name]) => name === 'stroke');
    const echoStroke = strokes.find(([, , style, width]) => style === echo.color && width === echo.lineWidth);
    assert.ok(echoStroke, 'the echo bracket is painted');
    const bracketStroke = strokes.find(([, path, style, width]) =>
      path instanceof MockPath2D && path.points.length && width !== echo.lineWidth && style !== echo.color);
    assert.ok(bracketStroke, 'the contact bracket is painted');
    const extent = (path) => {
      const xs = path.points.map(([x]) => x);
      const ys = path.points.map(([, y]) => y);
      return { halfW: (Math.max(...xs) - Math.min(...xs)) / 2, halfH: (Math.max(...ys) - Math.min(...ys)) / 2 };
    };
    const echoBox = extent(echoStroke[1]);
    const bracketBox = extent(bracketStroke[1]);
    assert.ok(Math.abs(echoBox.halfW - bracketBox.halfW - echo.spreadPx / 2) < 1e-3,
      `echo ${echoBox.halfW} vs bracket ${bracketBox.halfW}`);
    assert.ok(Math.abs(echoBox.halfH - bracketBox.halfH - echo.spreadPx / 2) < 1e-3);
    const echoAlpha = echoStroke[4];
    const bracketAlpha = bracketStroke[4];
    assert.ok(echoAlpha > 0 && echoAlpha < bracketAlpha, `${echoAlpha} vs ${bracketAlpha}`);
    assert.ok(Math.abs(echoAlpha - bracketAlpha / 2) < 1e-6, `${echoAlpha} vs ${bracketAlpha}`);
  } finally {
    clearAwarenessEchoField();
    env.cleanup();
  }
});

test('under the Cyber sonar sweep an echo is never brighter than its own bracket', () => {
  const env = installEnvironment();
  // The cyber theme with its HUD open turns the contact sonar on; its sweep
  // dims brackets it is not passing over.
  env.document.documentElement = {
    // The lowest sweep floor, so dimmed brackets drop a whole alpha band.
    dataset: { uiTheme: 'cyber', cyberSonarOpacity: '35' },
    style: { setProperty() {}, removeProperty() {} },
  };
  const hud = env.document.createElement('div');
  hud.id = 'intel-hud';
  hud.classList = { contains: (name) => name === 'active' };
  env.document.body.appendChild(hud);
  const echo = {
    layerIds: ['military'],
    fadeMs: 60_000,
    color: 'rgb(1, 2, 3)',
    spreadPx: 8,
    lineWidth: 3.25,
  };
  const contact = {
    id: 'military',
    getDetectableObjects: () => [{
      position: new Cesium.Cartesian3(0.5, 0.3, 6_356_752),
      sourceId: 'sonar-pin',
      id: 'SONAR',
      metric: 'FL300',
      type: 'AIR',
      tier: 'military',
    }],
  };
  try {
    setAwarenessEchoField({
      center: Cesium.Cartesian3.fromDegrees(0, 89, 0),
      radiusM: 250_000,
      pulse: { count: 1000, periodMs: 1000, startFraction: 0 },
      echo,
      level: () => 1,
    });
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [contact], () => {});
    setMode('DENSE');
    setDetectionStyle('normal');
    settleFrame(env);
    let dimmed = 0;
    let compared = 0;
    for (let frame = 0; frame < 40; frame++) {
      env.detectionCtx.calls.length = 0;
      settleFrame(env);
      const strokes = env.detectionCtx.calls.filter(([name]) => name === 'stroke');
      const echoStroke = strokes.find(([, , style, width]) => style === echo.color && width === echo.lineWidth);
      const bracketStroke = strokes.find(([, path, style, width]) =>
        path instanceof MockPath2D && path.points.length && width !== echo.lineWidth && style !== echo.color);
      if (!bracketStroke) continue;
      const bracketAlpha = bracketStroke[4];
      if (bracketAlpha < 0.99) dimmed++;
      if (!echoStroke) continue;
      compared++;
      assert.ok(
        echoStroke[4] <= bracketAlpha + 1e-9,
        `echo ${echoStroke[4]} over bracket ${bracketAlpha} on frame ${frame}`,
      );
    }
    assert.ok(dimmed > 0, 'the sweep dimmed the bracket on some frame');
    assert.ok(compared > 0, 'an echo was painted');
  } finally {
    clearAwarenessEchoField();
    env.cleanup();
  }
});

test('resting Global Context pulses skip echo work for the whole frame, not per contact', () => {
  const env = installEnvironment();
  // Six echo-eligible flights on screen; the identity camera maps x/y
  // straight to device coordinates.
  const flights = Array.from({ length: 6 }, (_, index) => ({
    position: new Cesium.Cartesian3(-0.5 + index * 0.2, 0, 6_356_752),
    sourceId: `flight-${index}`,
    id: `ECHO${index}`,
    metric: `FL${300 + index}`,
    type: 'AIR',
  }));
  const layer = { id: 'flights', getDetectableObjects: () => flights };
  let levelCalls = 0;
  try {
    setAwarenessEchoField({
      center: Cesium.Cartesian3.fromDegrees(0, 89, 0),
      radiusM: 250_000,
      pulse: { count: 1000, periodMs: 1000, startFraction: 0 },
      echo: {
        layerIds: ['flights'],
        fadeMs: 60_000,
        color: 'rgb(1, 2, 3)',
        spreadPx: 8,
        lineWidth: 3.25,
      },
      level: () => {
        levelCalls++;
        return 0;
      },
    });
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, [layer], () => {});
    setMode('DENSE');
    settleFrame(env);
    levelCalls = 0;
    settleFrame(env);
    const painted = getDetectionDiagnostics().visibleCount;
    assert.equal(painted, flights.length, 'every flight is on screen');
    // One check per painted frame, however many contacts are on screen.
    assert.ok(levelCalls >= 1, 'the frame asks whether echoes are live');
    assert.ok(levelCalls < painted, `${levelCalls} level checks for ${painted} contacts`);
    assert.ok(
      !env.detectionCtx.calls.some(
        ([name, , style]) => name === 'stroke' && style === 'rgb(1, 2, 3)',
      ),
      'no echoes while the pulses rest',
    );
  } finally {
    clearAwarenessEchoField();
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

test('detection cannot resurrect a private canvas, listener, matrix, resize, clear, or UI inventory', () => {
  const source = readFileSync(new URL('./detection.js', import.meta.url), 'utf8');
  const uiSource = readShellSource()
  + '\n' + readFileSync(new URL('../ui/visualPresets.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /createElement\(\s*['"]canvas['"]\s*\)/);
  assert.doesNotMatch(source, /postRender\.addEventListener/);
  assert.doesNotMatch(source, /['"]detection-overlay['"]/);
  assert.doesNotMatch(source, /devicePixelRatio/);
  assert.doesNotMatch(source, /clearRect\(/);
  assert.doesNotMatch(source, /Matrix4\.multiply/);
  assert.doesNotMatch(source, /CALLOUT_OCCLUSION_SELECTORS/);
  assert.doesNotMatch(source, /_ctx\.(?:filter|globalCompositeOperation)\s*=/);
  assert.match(source, /_hostSurface\.style\.mixBlendMode = _theme\.blend;/);
  assert.match(source, /_hostSurface\.style\.filter = `\$\{_theme\.filter\} drop-shadow\(0 0 \$\{GLOW_PX\}px \$\{_theme\.glow\}\)`;/);
  assert.match(source, /const LABEL_SOLVE_INTERVAL_MS = 125;/);
  assert.match(source, /const _labelArbiter = new LabelArbiter\(\);/);
  assert.match(source, /const clipW = vp3 \* px \+ vp7 \* py \+ vp11 \* pz \+ vp15;/);
  assert.match(source, /registerWorldOverlayPaintLane\('detection', _paintDetectionLane/);
  assert.match(source, /target: 'detection'/);
  assert.match(source, /shouldPaint: _shouldPaintDetectionLane/);
  // The three military styles used to carry three copies of these numbers.
  // They now share ONE frozen object, which Cockpit's force-on reuses too, so
  // the pin moved from "three identical literals" to "one preset, referenced
  // three times" — same guarantee, and the copies can no longer drift.
  assert.match(
    uiSource,
    /const MILITARY_DETECTION_PRESET = Object\.freeze\(\{\s*mode: 'dense',\s*densityPct: 75,?\s*\}\);/,
    'the tactical detection default is still Dense @ 75%',
  );
  assert.equal(
    uiSource.match(/detection: MILITARY_DETECTION_PRESET,/g)?.length,
    3,
    'CRT, NVG, and FLIR retain their Dense auto-enable defaults',
  );
  assert.match(uiSource, /preset\.detection && !this\._detectionUserOverridden/);
});

// ── Developer telemetry gate (2026-08-20 QA hunt) ───────────────────────────
// The orange mode banner ("DENSE  VIS:15  SRC:1036  DENS:100%  ELASTIC  0.4ms")
// painted for every user: CRT/NVG/FLIR auto-enable detection, so engine
// telemetry was the first thing a visitor saw, overlapping the cockpit callsign
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

test('a transit vehicle is a contact: box, route, mode and operator on the shared canvas', () => {
  // The owner's finding was that buses were "green dots moving around
  // clumsily" — the layer rendered them and the detection overlay ignored
  // them, because transit published no detectable objects at all. This drives
  // the real host with the shape the layer now returns.
  const env = installEnvironment();
  const objects = [
    {
      position: new Cesium.Cartesian3(0, 0, 6_356_752),
      sourceId: 'mbta:y1276',
      tier: 'transit_bus',
      id: '111',
      type: 'VEH',
      klass: 'MBTA',
      metric: 'BUS 34 KM/H',
    },
    {
      position: new Cesium.Cartesian3(0, 900, 6_356_752),
      sourceId: 'mbta:R-548BBB14',
      id: 'RED',
      type: 'VEH',
      klass: 'MBTA',
      metric: 'METRO STOPPED',
      skipLabel: true,
    },
  ];
  try {
    initWorldOverlay(env.viewer);
    initDetection(
      env.viewer,
      [{ id: 'transit', getDetectableObjects: () => objects }],
      () => {},
    );
    setMode('DENSE');
    env.advance(250);
    env.postRender.raise();
    env.advance(250);
    env.postRender.raise();
    const painted = env.ctx.calls
      .filter(([name]) => name === 'fillText')
      .map(([, text]) => text);
    assert.ok(
      painted.includes('111'),
      `the route is the bright line; painted ${JSON.stringify(painted)}`,
    );
    // The host paints a single-line track label — bright id, one dim micro
    // field — so the mode and what the vehicle is doing share that field.
    assert.ok(
      painted.some((text) => String(text).includes('BUS')),
      `the mode rides along on the micro line; painted ${JSON.stringify(painted)}`,
    );
    assert.ok(
      painted.some((text) => String(text).includes('34 KM/H')),
      'and so does what the vehicle is doing',
    );
    assert.ok(env.ctx.calls.some(([name, , color, width]) => name === 'stroke' && color === '#5EF08A' && width === 1.25));
    assert.ok(env.ctx.calls.some(([name, , color, width]) => name === 'stroke' && color === '#05080C' && width === 3.25));
    assert.ok(!env.detectionCtx.calls.some(([name, , color]) => name === 'stroke' && color === '#5EF08A'));
    // The operator travels on the object for the two-tier card form, which is
    // where `klass` is read; the host's track label does not paint it.
    assert.equal(composeLabel(objects[0]).secondary, 'MBTA · BUS 34 KM/H');
    // The selected vehicle carries its own fuller card, so detection must not
    // label it a second time.
    assert.equal(
      painted.includes('RED'),
      false,
      'skipLabel keeps the selected vehicle from being labelled twice',
    );
  } finally {
    env.cleanup();
  }
});

test('transit contacts take the vehicle tier, not the civil-air one', () => {
  assert.equal(resolveTier({ type: 'VEH' }), 'vehicle');
  assert.equal(resolveTier({ type: 'AIR' }), 'civil');
  assert.equal(resolveTier({ type: 'SEA' }), 'sea');
});

/**
 * Give the host environment a scene that keeps frame depth: the camera 10,000
 * km up the +Z axis looking down it, and one depth range in which the whole
 * frame is a surface `surfaceDistance()` metres in front of the camera.
 */
function installDepthScene(env, surfaceDistance, { webgl2 = true } = {}) {
  const near = 1;
  const far = 100_000_000;
  const gl = createFakeGl({ webgl2 });
  const camera = env.viewer.camera;
  camera.viewMatrix = Cesium.Matrix4.fromTranslation(new Cesium.Cartesian3(0, 0, -10_000_000));
  camera.frustum.fovy = Math.PI / 2;
  camera.frustum.aspectRatio = 800 / 600;
  const paint = () =>
    depthImage(8, 6, () => viewDistanceToDepth(surfaceDistance(), near, far, true));
  const image = paint();
  const scene = createFakeDepthScene({ gl, ranges: [{ near, far, image }] });
  Object.assign(env.viewer.scene, scene, { camera });
  return {
    gl,
    /** Draw the next frame's depth. */
    redraw() {
      image.data.set(paint().data);
    },
  };
}

/** Street contacts 3,643 km and 2,000 km below the camera, and a flight. */
function occlusionLayers() {
  return [
    {
      id: 'traffic',
      getDetectableObjects: () => [
        { position: new Cesium.Cartesian3(-0.4, 0, 6_356_752), id: 'VEH-0001', type: 'VEH', depthTested: true },
        { position: new Cesium.Cartesian3(0.4, 0, 8_000_000), id: 'VEH-0002', type: 'VEH', depthTested: true },
      ],
    },
    {
      id: 'flights',
      // The same nearer surface is in front of it, but it is not depth-tested.
      getDetectableObjects: () => [
        { position: new Cesium.Cartesian3(-0.4, 0.3, 6_356_752), sourceId: 'f1', id: 'AIR1', metric: 'FL300', type: 'AIR' },
      ],
    },
  ];
}

function paintedText(env) {
  return env.ctx.calls.filter(([name]) => name === 'fillText').map(([, text]) => text);
}

/** One rendered frame 16 ms on; `settleFrame` is one 250 ms on (a solve). */
function nextFrame(env) {
  env.advance(16);
  env.postRender.raise();
}

test('a depth-tested contact behind drawn geometry loses its bracket and callout, tested on the GPU without anything read back', () => {
  const env = installEnvironment();
  // A roof 3,000 km below the camera: in front of VEH-0001, behind VEH-0002.
  let surface = 3_000_000;
  const depth = installDepthScene(env, () => surface);
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, occlusionLayers(), () => {});
    setMode('DENSE');
    settleFrame(env);
    let diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceDepthMode, 'async');
    assert.equal(diagnostics.surfaceTestedCount, 2, 'only the depth-tested contacts');
    assert.equal(diagnostics.surfaceProbeTests, 2);
    // New to the view, so held back for the frame or two the first answer
    // takes: neither is drawn yet. The flight is.
    assert.equal(diagnostics.surfaceHiddenCount, 2, 'no answer has arrived yet');
    assert.equal(diagnostics.visibleCount, 1);
    assert.equal(depth.gl.counts.queries, 3, 'a control point and one query per contact');

    // Frames before the GPU answers start nothing new and wait for nothing.
    nextFrame(env);
    nextFrame(env);
    assert.equal(depth.gl.counts.queries, 3);
    assert.equal(depth.gl.counts.resultReads, 0);

    // The answers land. The contact above the roof is drawn from then on; the
    // one under it never is.
    depth.gl.finishGpu();
    nextFrame(env);
    depth.gl.finishGpu();
    settleFrame(env);
    env.ctx.calls.length = 0;
    nextFrame(env);
    assert.ok(!paintedText(env).includes('VEH-0001'));
    assert.ok(paintedText(env).includes('VEH-0002'));

    // It stays gone, frame after frame and solve after solve.
    for (let i = 0; i < 40; i++) {
      depth.gl.finishGpu();
      env.ctx.calls.length = 0;
      nextFrame(env);
      assert.ok(!paintedText(env).includes('VEH-0001'), `frame ${i}`);
    }
    depth.gl.finishGpu();
    settleFrame(env);
    diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceHiddenCount, 1);
    assert.equal(diagnostics.visibleCount, 2, 'the hidden contact has no bracket');
    assert.ok(diagnostics.labeledKeys.includes('traffic:VEH-0002'));
    assert.ok(!diagnostics.labeledKeys.includes('traffic:VEH-0001'));
    assert.ok(diagnostics.labeledKeys.includes('flights:f1'));
    assert.ok(paintedText(env).includes('AIR1'));
    assert.equal(depth.gl.counts.readPixels, 0, 'depth never left the GPU');

    // The roof goes away: the bracket returns once visible answers have kept
    // coming for the reappear time, and the callout once a solve re-admits it.
    surface = 5_000_000;
    depth.redraw();
    for (let i = 0; i < 80; i++) {
      depth.gl.finishGpu();
      nextFrame(env);
    }
    for (let i = 0; i < 8; i++) {
      depth.gl.finishGpu();
      settleFrame(env);
    }
    diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceHiddenCount, 0);
    assert.equal(diagnostics.visibleCount, 3);
    assert.ok(diagnostics.labeledKeys.includes('traffic:VEH-0001'));
  } finally {
    env.cleanup();
  }
});

test('a labelled contact that goes behind something loses its callout at once, and does not get it back by leaving the view', () => {
  const env = installEnvironment();
  // To begin with the drawn surface is below both vehicles.
  let surface = 5_000_000;
  const depth = installDepthScene(env, () => surface);
  const layers = occlusionLayers();
  const everyVehicle = layers[0].getDetectableObjects;
  const answerAndSolve = (count) => {
    for (let i = 0; i < count; i++) {
      depth.gl.finishGpu();
      settleFrame(env);
    }
  };
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, layers, () => {});
    setMode('DENSE');
    answerAndSolve(6);
    assert.ok(getDetectionDiagnostics().labeledKeys.includes('traffic:VEH-0001'));
    env.ctx.calls.length = 0;
    nextFrame(env);
    assert.ok(paintedText(env).includes('VEH-0001'));

    // A roof is drawn over VEH-0001. Its callout goes on the frame the answer
    // lands, which is not a solve: no carry-over, no fade.
    surface = 3_000_000;
    depth.redraw();
    let gone = -1;
    for (let i = 0; i < 30 && gone < 0; i++) {
      depth.gl.finishGpu();
      env.ctx.calls.length = 0;
      nextFrame(env);
      if (!paintedText(env).includes('VEH-0001')) gone = i;
    }
    assert.ok(gone >= 0, 'the callout went');
    // The layer stops reporting it (it drove out of view). The arbiter still
    // remembers where its callout was; it must not paint it there again.
    layers[0].getDetectableObjects = () => everyVehicle().slice(1);
    for (let i = 0; i < 12; i++) {
      depth.gl.finishGpu();
      env.ctx.calls.length = 0;
      nextFrame(env);
      assert.ok(!paintedText(env).includes('VEH-0001'), `frame ${i}`);
    }
  } finally {
    env.cleanup();
  }
});

test('without scene depth every contact keeps its bracket and callout', () => {
  const env = installEnvironment();
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, occlusionLayers(), () => {});
    setMode('DENSE');
    settleFrame(env);
    settleFrame(env);
    const diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceDepthMode, 'off');
    assert.equal(diagnostics.surfaceTestedCount, 2);
    assert.equal(diagnostics.surfaceProbeTests, 0);
    assert.equal(diagnostics.surfaceHiddenCount, 0);
    assert.equal(diagnostics.visibleCount, 3);
    assert.ok(diagnostics.labeledKeys.includes('traffic:VEH-0001'));
  } finally {
    env.cleanup();
  }
});

test('scene depth that goes away puts hidden contacts back', () => {
  const env = installEnvironment();
  const depth = installDepthScene(env, () => 3_000_000);
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, occlusionLayers(), () => {});
    setMode('DENSE');
    settleFrame(env);
    depth.gl.finishGpu();
    settleFrame(env);
    assert.equal(getDetectionDiagnostics().surfaceHiddenCount, 1);
    // The scene stops keeping pick depth (a 2D view, depth picking turned off).
    depth.gl.finishGpu();
    env.viewer.scene.useDepthPicking = false;
    // The hidden time runs on painted frames, so paint a second's worth.
    for (let i = 0; i < 70; i++) nextFrame(env);
    settleFrame(env);
    const diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceDepthMode, 'off');
    assert.equal(diagnostics.surfaceHiddenCount, 0);
    assert.equal(diagnostics.visibleCount, 3);
  } finally {
    env.cleanup();
  }
});

test('turning detection off drops every test in flight; tearing it down frees the GPU objects', () => {
  const env = installEnvironment();
  const depth = installDepthScene(env, () => 3_000_000);
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, occlusionLayers(), () => {});
    setMode('DENSE');
    settleFrame(env);
    assert.equal(depth.gl.liveQueries.size, 3);
    // Off keeps the GPU objects (the shader is not compiled again on the next
    // on) but the answers in flight are no longer wanted.
    setMode('OFF');
    assert.equal(depth.gl.counts.deleted, 0);
    depth.gl.finishGpu();
    setMode('DENSE');
    settleFrame(env);
    assert.equal(depth.gl.counts.queries, 6, 'both contacts are tested afresh');
    assert.equal(depth.gl.liveQueries.size, 3, 'on the same queries, reused');
    depth.gl.finishGpu();
    nextFrame(env);
    settleFrame(env);
    assert.equal(getDetectionDiagnostics().surfaceHiddenCount, 1);
    assert.equal(getDetectionDiagnostics().visibleCount, 2);
  } finally {
    env.cleanup();
  }
  // Tearing detection down releases everything.
  assert.equal(depth.gl.liveQueries.size, 0);
  assert.equal(depth.gl.counts.deleted, 5);
});

test('a WebGL 1 scene reads depth synchronously and reports it once', () => {
  const env = installEnvironment();
  const depth = installDepthScene(env, () => 3_000_000, { webgl2: false });
  const originalInfo = console.info;
  const reported = [];
  console.info = (...args) => reported.push(args.join(' '));
  try {
    initWorldOverlay(env.viewer);
    initDetection(env.viewer, occlusionLayers(), () => {});
    setMode('DENSE');
    for (let i = 0; i < 30; i++) nextFrame(env);
    settleFrame(env);
    const diagnostics = getDetectionDiagnostics();
    assert.equal(diagnostics.surfaceDepthMode, 'sync');
    assert.equal(diagnostics.surfaceHiddenCount, 1);
    assert.equal(diagnostics.visibleCount, 2);
    // Half a second of frames: a read about every eighth of one, not one per
    // frame and not one per contact.
    assert.ok(depth.gl.counts.readPixels >= 3 && depth.gl.counts.readPixels <= 6, `${depth.gl.counts.readPixels} reads`);
    assert.equal(reported.length, 1);
    assert.match(reported[0], /synchronously/);
  } finally {
    console.info = originalInfo;
    env.cleanup();
  }
});
