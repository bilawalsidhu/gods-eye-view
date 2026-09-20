// IntelHUD — the public surface, the summary pipeline, and the idle timers.
//
// hudAltitudeDatum.test.mjs owns the ALT-datum story and hudLocality.test.mjs
// owns the locality tag; this file drives everything else the class does:
// the show/hide/mode/variant API, the AI-summary fetch lifecycle (single
// flight, signature dedupe, stale-revision discard, failure fallbacks), the
// four background timers, and the camera-telemetry math.
//
// Same bootstrap rules as hudAltitudeDatum: hud.js imports `mgrs`, a CommonJS
// package Node's ESM loader cannot see, so a module hook swaps that one
// specifier for a stub — and the import has to happen BEFORE any DOM globals
// exist, because Cesium's widget bundle probes for a real `document` at module
// scope and a partial stub sends it down the browser path. Hence hook →
// import → install DOM, in that order.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';

import { registerHooks } from 'node:module';
import * as Cesium from 'cesium';
import { ensureGeoidReady } from './data/geoid.js';

const MGRS_STUB_URL = 'gev-test-stub:mgrs';
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === 'mgrs') return { url: MGRS_STUB_URL, shortCircuit: true };
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url === MGRS_STUB_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: [
          'export function forward() {',
          '  if (globalThis.__GEV_TEST_MGRS_THROW) {',
          "    throw new Error('mgrs unavailable');",
          '  }',
          "  return '18SUJ23370716';",
          '}',
          'export default { forward };',
          '\n',
        ].join('\n'),
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

/** Every element id the HUD reads back through document.getElementById. */
const READOUT_IDS = [
  'hud-timestamp',
  'hud-rec-dot',
  'hud-mode',
  'hud-summary',
  'hud-mgrs',
  'hud-latlon',
  'hud-bottom-line',
  'hud-gsd',
  'hud-alt',
  'hud-coll',
  'hud-ona',
];

/** SFO runway 28R area — inside the San Francisco POI catalogue radius. */
const SFO = { latDeg: 37.616, lonDeg: -122.368 };

/** Element stand-in: text sink + classList + style/dataset writes. */
function makeElement(id) {
  const classes = new Set();
  const styleProps = {};
  return {
    id,
    textContent: '',
    dataset: {},
    style: {
      visibility: '',
      setProperty(name, value) { styleProps[name] = value; },
      getPropertyValue(name) { return styleProps[name] ?? null; },
    },
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      contains: (name) => classes.has(name),
    },
  };
}

/**
 * DOM + viewer + fetch environment sized to what the HUD touches. The viewer's
 * canvas is 0×0 on purpose: that makes the real `getBasemapLabelContext` (the
 * imported-from-gevActions one) fall through every pick stage to its "no
 * target" early return, so `_summaryContext` runs production code with no
 * network and no Cesium scene.
 */
function installHudEnvironment({ viewRect = null } = {}) {
  const elements = new Map();
  const el = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  for (const id of READOUT_IDS) el(id);
  el('intel-hud'); // present → _buildDOM populates the shell

  const moveEndHandlers = [];
  const viewer = {
    scene: { canvas: { clientWidth: 0, clientHeight: 0 } },
    camera: {
      heading: 0,
      pitch: -Math.PI / 2,
      positionCartographic: {
        latitude: Cesium.Math.toRadians(SFO.latDeg),
        longitude: Cesium.Math.toRadians(SFO.lonDeg),
        height: -15,
      },
      computeViewRectangle: () => viewRect ?? undefined,
      moveEnd: {
        addEventListener: (fn) => moveEndHandlers.push(fn),
        removeEventListener: (fn) => {
          const index = moveEndHandlers.indexOf(fn);
          if (index >= 0) moveEndHandlers.splice(index, 1);
        },
      },
    },
  };

  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  const previousFetch = globalThis.fetch;
  const timeoutDurations = [];
  const clearedTimeoutIds = [];
  globalThis.document = { getElementById: (id) => elements.get(id) ?? null };
  // The 5 s fetch timeout must NOT schedule a real timer — a pending 5 s
  // setTimeout would stall this test file's process exit for its full delay.
  globalThis.window = {
    setTimeout: (_fn, ms) => { timeoutDurations.push(ms); return timeoutDurations.length; },
    clearTimeout: (id) => { clearedTimeoutIds.push(id); },
  };

  const fetchCalls = [];
  const env = {
    elements,
    el,
    moveEndHandlers,
    viewer,
    fetchCalls,
    timeoutDurations,
    clearedTimeoutIds,
    setFetch(impl) {
      globalThis.fetch = async (url, options) => {
        fetchCalls.push({ url, options });
        return impl(url, options);
      };
    },
    restore() {
      globalThis.fetch = previousFetch;
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
      if (previousWindow === undefined) delete globalThis.window;
      else globalThis.window = previousWindow;
    },
  };
  env.setFetch(async () => ({ ok: true, status: 200, json: async () => ({ summary: 'AI LINE' }) }));
  return env;
}

/** Flush the fetch/summary microtask chain (real macrotasks, mocked-safe). */
async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Put the HUD into steady geoid state BEFORE any telemetry tick: a fresh HUD
 * requests the grid on its first visible tick, and under a loaded parallel
 * suite the EGM96 chunk resolves mid-test — the correction transition then
 * repaints the deterministic summary line right over a landed AI line. Tests
 * that pin the AI line must not share that race.
 */
function primeGeoidSteadyState(hud) {
  hud._geoidReady = true;
  hud._geoidRequested = true;
  hud._geoidCorrectionApplied = true;
}

// ── Geoid lookup failure (must run before anything warms the grid) ──────────

test('a geoid lookup failure degrades to the uncorrected datum', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    // The grid module is still cold in a fresh process, so with the ready flag
    // forced past the lazy loader the geoidHeight() call throws and the cache
    // stores null — the readout's signal to print the raw ellipsoidal height.
    hud._geoidReady = true;
    hud._geoidCellKey = null;
    assert.equal(hud._geoidUndulationM(SFO.latDeg, SFO.lonDeg), null);
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Construction and the public visibility API ──────────────────────────────

test('construction builds the shell and subscribes to camera settle', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    assert.equal(hud._el, env.el('intel-hud'), 'the shell element is adopted');
    assert.equal(env.el('intel-hud').dataset.variant, 'tactical');
    assert.equal(env.moveEndHandlers.length, 1, 'one moveEnd listener registered');
    assert.equal(hud.visible, false);
    assert.equal(hud.getMode(), 'auto');
    assert.equal(hud.getVariant(), 'tactical');
  } finally {
    hud?.destroy();
    assert.equal(env.moveEndHandlers.length, 0, 'destroy removes the camera listener');
    env.restore();
  }
});

test('show() paints telemetry, activates the overlay, and lands the AI summary', async () => {
  await ensureGeoidReady();
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    primeGeoidSteadyState(hud);
    hud.show();
    assert.equal(hud.visible, true);
    assert.ok(env.el('intel-hud').classList.contains('active'));
    assert.match(env.el('hud-alt').textContent, /^ALT: /);
    await settle();
    assert.ok(env.fetchCalls.length >= 1, 'show() kicks the AI summary immediately');
    assert.equal(env.el('hud-summary').textContent, 'AI LINE');
    assert.equal(hud.getMode(), 'auto', 'show() does not leave auto mode by itself');

    hud.toggle();
    assert.equal(hud.visible, false);
    assert.ok(!env.el('intel-hud').classList.contains('active'));
    assert.equal(hud.getMode(), 'off', 'toggle() takes the user override');

    hud.toggle();
    assert.equal(hud.visible, true);
    assert.equal(hud.getMode(), 'on');

    hud.hide();
    assert.equal(hud.visible, false);
    assert.ok(!env.el('intel-hud').classList.contains('active'));
    await settle(); // every show() kicked a summary chain — flush it before teardown
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Style reactions ─────────────────────────────────────────────────────────

test('onStyleChange swaps the mode label, the theme, and auto-visibility', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);

    hud.onStyleChange('surveillance');
    assert.equal(env.el('hud-mode').textContent, 'NVG');
    assert.equal(env.el('intel-hud').style.getPropertyValue('--hud-color'), 'rgba(51, 255, 51, 0.8)');
    assert.equal(hud.visible, true, 'a military style auto-shows the HUD');

    hud.onStyleChange('thermal');
    assert.equal(env.el('hud-mode').textContent, 'FLIR');
    assert.equal(env.el('intel-hud').style.getPropertyValue('--hud-border'), 'rgba(255, 255, 255, 0.15)');

    hud.onStyleChange('retro');
    assert.equal(env.el('hud-mode').textContent, 'CRT');
    assert.equal(env.el('intel-hud').style.getPropertyValue('--hud-glow'), 'rgba(255, 170, 0, 0.5)');

    hud.onStyleChange('cinema');
    assert.equal(env.el('hud-mode').textContent, 'CINEMA', 'unknown styles upper-case');
    assert.equal(
      env.el('intel-hud').style.getPropertyValue('--hud-color'),
      'rgba(0, 255, 255, 0.6)',
      'unknown styles fall back to the default palette',
    );
    assert.equal(hud.visible, false, 'a non-military style auto-hides the HUD');

    hud.toggle(); // visible again, auto mode off
    hud.onStyleChange('surveillance');
    assert.equal(hud.visible, true);
    hud.onStyleChange('normal');
    assert.equal(hud.visible, true, 'the user override survives style flips');
    await settle(); // the military-style auto-shows kicked summary chains
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('setMode drives auto, forced-on, and forced-off', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud.setMode('on');
    assert.equal(hud.visible, true);
    assert.equal(hud.getMode(), 'on');

    hud.setMode('off');
    assert.equal(hud.visible, false);
    assert.equal(hud.getMode(), 'off');

    hud.setMode('auto');
    assert.equal(hud.getMode(), 'auto');
    assert.equal(hud.visible, false, 'auto re-applies the current (non-military) style');

    hud.onStyleChange('surveillance');
    assert.equal(hud.visible, true, 'auto mode shows on a military style again');
    await settle(); // the auto-show kicked a summary chain
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('setVariant accepts the three layouts and falls back to tactical', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud.setVariant('operator');
    assert.equal(hud.getVariant(), 'operator');
    assert.equal(env.el('intel-hud').dataset.variant, 'operator');

    hud.setVariant('MINIMAL');
    assert.equal(hud.getVariant(), 'minimal', 'variant names normalise to lower case');

    hud.setVariant('bogus');
    assert.equal(hud.getVariant(), 'tactical');
    hud.setVariant(null);
    assert.equal(hud.getVariant(), 'tactical');
    hud.setVariant(undefined);
    assert.equal(hud.getVariant(), 'tactical');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Data-manager wiring ─────────────────────────────────────────────────────

test('attachDataManager dirties on visibility changes and feeds layer labels', async () => {
  const env = installHudEnvironment();
  const subscribers = [];
  const layers = [
    { enabled: true, name: 'Flights' },
    { enabled: false, name: 'CCTV' },
  ];
  let unsubscribes = 0;
  const dataManager = {
    getAll: () => layers,
    subscribe: (fn) => {
      subscribers.push(fn);
      return () => { unsubscribes += 1; };
    },
  };

  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud.attachDataManager(dataManager);

    const revisionBefore = hud._summaryRevision;
    subscribers[0]({ type: 'visibility' });
    assert.equal(hud._summaryRevision, revisionBefore + 1, 'a visibility change dirties the summary');
    subscribers[0]({ type: 'enable' });
    assert.equal(hud._summaryRevision, revisionBefore + 1, 'other change kinds do not');

    hud.show();
    await settle();
    assert.equal(env.fetchCalls.length, 1);
    const body = JSON.parse(env.fetchCalls[0].options.body);
    assert.deepEqual(body.enabledLayerLabels, ['Flights'], 'only enabled layers reach the summary context');
    assert.deepEqual(body.placeLabels, [], 'the label context flows through the real helper');

    hud.attachDataManager(dataManager);
    assert.equal(unsubscribes, 1, 're-attaching unwires the previous subscription');
    hud.destroy();
    assert.equal(unsubscribes, 2, 'destroy unwires the live subscription');

    // A manager without subscribe(), and a null manager, are both tolerated.
    const plain = new IntelHUD(env.viewer);
    plain.attachDataManager({ getAll: () => layers });
    plain.attachDataManager(null);
    assert.equal(plain._dataManager, null);
    plain.destroy();
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Telemetry readouts ──────────────────────────────────────────────────────

test('a camera without a cartographic position leaves telemetry untouched', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    env.viewer.camera.positionCartographic = null;
    hud._updateCameraData();
    assert.equal(hud._latestMetrics, null);
    assert.equal(env.el('hud-alt').textContent, '');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('MGRS formatting succeeds, and a failed lookup degrades to dashes', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData();
    assert.equal(env.el('hud-mgrs').textContent, 'MGRS: 18S UJ 2337 0716');
    assert.match(env.el('hud-bottom-line').textContent, /^MGRS: 18S UJ 2337 0716/);

    globalThis.__GEV_TEST_MGRS_THROW = true;
    try {
      hud._updateCameraData();
      assert.equal(env.el('hud-mgrs').textContent, 'MGRS: ---');
      assert.match(env.el('hud-bottom-line').textContent, /^MGRS: ---/);
    } finally {
      delete globalThis.__GEV_TEST_MGRS_THROW;
    }
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('the summary line composes band, region, locality, window, and zone', () => {
  // A rect spanning the antimeridian: 170°E → 170°W. The shorter arc (20°)
  // must be used, not the naive 340° span.
  const viewRect = {
    north: Cesium.Math.toRadians(5),
    south: Cesium.Math.toRadians(-5),
    east: Cesium.Math.toRadians(-170),
    west: Cesium.Math.toRadians(170),
  };
  const env = installHudEnvironment({ viewRect });
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData();
    const summary = env.el('hud-summary').textContent;

    assert.match(summary, /^NORMAL STREET /, 'mode label defaults with no style change');
    assert.match(summary, /NEAR .+ \(SAN FRANCISCO\) \d+KM/, 'a catalogued POI within range reads NEAR');
    assert.match(summary, /NORTH AMERICA/);
    // The corner and the summary must print the SAME altitude datum, whatever
    // state the (per-process) geoid grid is in.
    const altM = env.el('hud-alt').textContent.match(/ALT: (-?\d+)m/)[1];
    assert.match(summary, new RegExp(`\\| ALT ${altM}M \\|`));
    const widthKm = Math.round(20 * 111 * Math.cos((SFO.latDeg * Math.PI) / 180));
    assert.match(summary, new RegExp(`WINDOW ${widthKm}x1110KM`), 'antimeridian span takes the shorter arc');
    assert.match(summary, /SUN -?\d+° \| ONA 0°/, 'a -90° pitch reads as nadir');
    assert.match(summary, /UTC-8$/, 'the zone tag rounds longitude to hours');

    // Without a view rectangle the window tag degrades instead of crashing.
    const empty = installHudEnvironment();
    let bare;
    try {
      bare = new IntelHUD(empty.viewer);
      bare._updateCameraData();
      assert.match(empty.el('hud-summary').textContent, /WINDOW N\/A \|/);
    } finally {
      bare?.destroy();
      empty.restore();
    }
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('the classification, DMS, haversine, and sun helpers stay exact', () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);

    assert.deepEqual(
      [hud._viewBand(1), hud._viewBand(1200), hud._viewBand(5000), hud._viewBand(30000), hud._viewBand(250000)],
      ['STREET', 'CITY', 'METRO', 'REGIONAL', 'GLOBAL'],
    );

    assert.equal(hud._regionLabel(80, 0), 'ARCTIC');
    assert.equal(hud._regionLabel(-70, 0), 'ANTARCTIC');
    assert.equal(hud._regionLabel(40, -100), 'NORTH AMERICA');
    assert.equal(hud._regionLabel(-20, -60), 'SOUTH AMERICA');
    assert.equal(hud._regionLabel(50, 10), 'EUROPE');
    assert.equal(hud._regionLabel(0, 20), 'AFRICA');
    assert.equal(hud._regionLabel(40, 100), 'ASIA');
    assert.equal(hud._regionLabel(-20, 140), 'OCEANIA');
    assert.equal(hud._regionLabel(2, 80), 'NORTHERN OCEANIC GRID');
    assert.equal(hud._regionLabel(-10, 60), 'SOUTHERN OCEANIC GRID');

    assert.equal(hud._toDMS(30.5, 'lat'), '30°30\'00.00"N');
    assert.equal(hud._toDMS(-30.5, 'lat'), '30°30\'00.00"S');
    assert.equal(hud._toDMS(-97.7431, 'lon'), '097°44\'35.16"W', 'longitude pads to three degrees');

    assert.equal(hud._haversineKm(10, 20, 10, 20), 0);
    const oneDegreeAtEquator = hud._haversineKm(0, 0, 0, 1);
    assert.ok(oneDegreeAtEquator > 110 && oneDegreeAtEquator < 112, `1° ≈ 111 km, got ${oneDegreeAtEquator}`);

    const nearest = hud._nearestKnownPoint(SFO.latDeg, SFO.lonDeg);
    assert.equal(nearest.city, 'San Francisco');
    assert.ok(nearest.distKm < 50);

    const sun = hud._estimateSunElevation(SFO.latDeg, SFO.lonDeg);
    assert.ok(sun > -90 && sun < 90, 'the sun elevation stays a plausible angle');

    assert.equal(hud._formatMGRS('18SUJ23370716'), '18S UJ 2337 0716');
    assert.equal(hud._formatMGRS('not-mgrs'), 'not-mgrs', 'unparseable strings pass through');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('the Zulu timestamp is UTC-padded, not local', () => {
  const env = installHudEnvironment();
  const PinnedDate = class extends Date {
    constructor(...args) {
      if (args.length === 0) super(Date.UTC(2026, 8, 14, 7, 8, 9));
      else super(...args);
    }
  };
  const previousDate = globalThis.Date;
  globalThis.Date = PinnedDate;
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    assert.equal(hud._formatUTC(), '2026-09-14 07:08:09Z');
  } finally {
    globalThis.Date = previousDate;
    hud?.destroy();
    env.restore();
  }
});

// ── The AI summary pipeline ─────────────────────────────────────────────────

test('the summary pipeline: placeholder, deterministic line, dedupe, fetch', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);

    await hud._updateSummary(false); // no metrics yet
    assert.equal(env.el('hud-summary').textContent, 'Awaiting telemetry...');
    assert.equal(env.fetchCalls.length, 0, 'no fetch without telemetry');

    hud._updateCameraData(); // paints the deterministic line, no fetch
    const deterministic = env.el('hud-summary').textContent;
    assert.match(deterministic, /\| ALT /);

    await hud._updateSummary(false, true); // forced
    assert.equal(env.fetchCalls.length, 1);
    assert.equal(env.el('hud-summary').textContent, 'AI LINE');
    assert.ok(env.timeoutDurations.includes(5000), 'the fetch runs under a 5 s abort timeout');

    await hud._updateSummary(false); // clean → early return
    assert.equal(env.fetchCalls.length, 1);

    hud._markSummaryDirty();
    await hud._updateSummary(false); // dirty but identical context → dedupe
    assert.equal(env.fetchCalls.length, 1, 'an unchanged context never refetches');
    assert.equal(hud._summaryDirty, false, 'the dedupe consumes the dirty flag');
    assert.equal(env.el('hud-summary').textContent, 'AI LINE');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('a summary-context failure degrades to the deterministic line and retries later', async () => {
  const env = installHudEnvironment();
  const warn = mock.method(console, 'warn');
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData();
    hud._summaryContext = async () => { throw new Error('scene closed'); };

    await hud._updateSummary(false, true);
    assert.equal(env.fetchCalls.length, 0);
    assert.match(env.el('hud-summary').textContent, /\| ALT /, 'the deterministic line replaces the failure');
    assert.equal(hud._summaryDirty, true, 'left dirty so the next tick retries');
    assert.ok(
      warn.mock.calls.some((call) => String(call.arguments[0]).includes('summary context unavailable')),
      'the degradation is logged, not silent',
    );
  } finally {
    warn.mock.restore();
    hud?.destroy();
    env.restore();
  }
});

test('AI summary failures repaint the fallback and reopen the retry', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData();

    const warn = mock.method(console, 'warn');
    try {
      env.setFetch(async () => ({ ok: false, status: 503, json: async () => ({ error: 'model down' }) }));
      await hud._updateSummary(false, true);
      assert.match(env.el('hud-summary').textContent, /\| ALT /);
      assert.equal(hud._summaryDirty, true);
      assert.equal(hud._lastSummarySignature, null, 'the signature is invalidated so the tick retries');
      assert.equal(hud._summaryRequest, null, 'the in-flight guard is released');
      assert.ok(
        warn.mock.calls.some((call) => call.arguments.map(String).join(' ').includes('AI summary unavailable')),
        'the failure is logged',
      );

      env.setFetch(async () => ({
        ok: false,
        status: 502,
        json: async () => { throw new Error('bad json'); },
      }));
      await hud._updateSummary(false, true);
      assert.match(env.el('hud-summary').textContent, /\| ALT /);
      assert.ok(
        warn.mock.calls.some((call) => call.arguments.map(String).join(' ').includes('HTTP 502')),
        'a malformed body surfaces as the HTTP status',
      );
    } finally {
      warn.mock.restore();
    }

    // An abort (destroy during a slow model call) is NOT an error: no warn,
    // the committed signature survives, and the fallback still paints.
    const abortWarn = mock.method(console, 'warn');
    try {
      env.setFetch((_url, options) => new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }));
      const pending = hud._updateSummary(false, true);
      await settle();
      hud._summaryRequest.abort();
      await pending;
      assert.equal(env.fetchCalls.at(-1).options.signal.aborted, true);
      assert.equal(abortWarn.mock.calls.length, 0, 'an abort is not logged as a failure');
      // Only a real failure invalidates the signature; an abort leaves the
      // value committed at request start alone (a destroy-time abort must not
      // force a pointless retry).
      assert.equal(
        hud._lastSummarySignature,
        '{"placeLabels":[],"streetLabels":[],"nearbyPlaceLabels":[],"enabledLayerLabels":[]}',
      );
      assert.match(env.el('hud-summary').textContent, /\| ALT /);
    } finally {
      abortWarn.mock.restore();
    }
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('one fetch in flight, and a stale revision never repaints', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData();

    let release;
    env.setFetch(() => new Promise((resolve) => { release = resolve; }));

    const first = hud._updateSummary(false, true);
    await settle();
    assert.equal(env.fetchCalls.length, 1);

    const second = hud._updateSummary(false, true); // must be suppressed
    await settle();
    assert.equal(await second, undefined);
    assert.equal(env.fetchCalls.length, 1, 'a second request is dropped while one is in flight');

    hud._markSummaryDirty(); // a newer revision lands while the fetch hangs
    release({ ok: true, status: 200, json: async () => ({ summary: 'STALE AI LINE' }) });
    await first;
    await settle();
    assert.equal(env.el('hud-summary').textContent !== 'STALE AI LINE', true);
    assert.match(env.el('hud-summary').textContent, /\| ALT /, 'the stale response is discarded');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Camera settle ───────────────────────────────────────────────────────────

test('camera settle repaints deterministic context and kicks one AI summary', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    const onMoveEnd = env.moveEndHandlers[0];

    const revisionBefore = hud._summaryRevision;
    onMoveEnd(); // hidden, no metrics
    assert.equal(hud._summaryRevision, revisionBefore + 1);
    assert.equal(hud._latestMetrics, null, 'a hidden HUD does not repaint telemetry');
    assert.equal(env.fetchCalls.length, 0);

    hud.show(); // kicks the first AI summary itself — but not the moveEnd one-shot
    await settle();
    assert.equal(env.fetchCalls.length, 1);

    onMoveEnd(); // visible with metrics: deterministic repaint + the one-shot kick
    assert.match(env.el('hud-summary').textContent, /\| ALT /);
    await settle();
    assert.equal(env.fetchCalls.length, 2, 'the settled view kicks its own summary');

    onMoveEnd();
    await settle();
    assert.equal(env.fetchCalls.length, 2, 'the first-summary kick is one-shot');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Idle timers ─────────────────────────────────────────────────────────────

test('the idle timers repaint on their cadences and stop when hidden', async (t) => {
  await ensureGeoidReady();
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    primeGeoidSteadyState(hud);
    hud.show();
    await settle();
    assert.equal(env.el('hud-summary').textContent, 'AI LINE');
    assert.equal(env.fetchCalls.length, 1);

    const dot = env.el('hud-rec-dot');
    t.mock.timers.tick(800);
    assert.equal(dot.style.visibility, 'hidden', 'the REC dot blinks off');
    t.mock.timers.tick(800);
    assert.equal(dot.style.visibility, 'visible', 'the REC dot blinks back on');

    t.mock.timers.tick(1000);
    assert.match(env.el('hud-timestamp').textContent, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}Z$/);

    // The 15 s tick must actually REFETCH when the context changed — a clean
    // but unchanged context would dedupe to nothing. Flipping a layer's
    // enabled state changes the signature the next tick computes.
    const layers = [{ enabled: false, name: 'Flights' }];
    hud.attachDataManager({ getAll: () => layers });
    layers[0].enabled = true;
    t.mock.timers.tick(15000);
    await settle();
    assert.equal(env.fetchCalls.length, 2, 'a changed context refetches on the periodic tick');
    t.mock.timers.tick(24 * 100);
    assert.equal(env.el('hud-summary').textContent, 'AI LINE', 'the animated repaint completes');

    hud.hide();
    hud._markSummaryDirty();
    t.mock.timers.tick(30000);
    await settle();
    assert.equal(env.fetchCalls.length, 2, 'a hidden HUD stops refreshing the summary');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('animated summaries type out two characters per tick', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    const summary = () => env.el('hud-summary').textContent;

    hud._typeSummary('KHI-11 TRACKING');
    assert.equal(summary(), '');
    t.mock.timers.tick(24 * 4);
    assert.equal(summary(), 'KHI-11 T');
    t.mock.timers.tick(24 * 4);
    assert.equal(summary(), 'KHI-11 TRACKING', 'the line completes and the timer clears');
    assert.equal(hud._summaryTypingInterval, null);

    hud._typeSummary('SHORT');
    assert.equal(summary(), '', 're-typing restarts from empty');
    t.mock.timers.tick(24 * 3);
    assert.equal(summary(), 'SHORT');

    env.elements.delete('hud-summary');
    hud._typeSummary('NO ELEMENT');
    t.mock.timers.tick(100);
    assert.equal(hud._summaryTypingInterval, null, 'a missing readout is a no-op');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Geoid memoization (grid warm) ───────────────────────────────────────────

test('the undulation lookup memoizes per coarse cell once the grid is warm', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    await ensureGeoidReady();
    hud._geoidReady = true; // the flag is per-instance; this instance never requested
    hud._geoidCellKey = null;
    const n = hud._geoidUndulationM(SFO.latDeg, SFO.lonDeg);
    assert.ok(Number.isFinite(n), 'a warm grid returns a number');
    assert.equal(hud._geoidUndulationM(SFO.latDeg, SFO.lonDeg), n, 'the same cell is served from the cache');
  } finally {
    hud?.destroy();
    env.restore();
  }
});

// ── Teardown ────────────────────────────────────────────────────────────────

test('destroy() aborts an in-flight summary request and unwinds everything', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    let unsubscribes = 0;
    hud.attachDataManager({ subscribe: () => () => { unsubscribes += 1; } });

    env.setFetch((_url, options) => new Promise((_resolve, reject) => {
      // Hang until destroy() aborts the request — that rejection is what
      // unwinds _updateSummary's finally block in production.
      options.signal.addEventListener('abort', () => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        reject(error);
      });
    }));
    hud.show();
    await settle();
    assert.ok(hud._summaryRequest, 'a request is in flight');

    hud.destroy();
    assert.equal(env.fetchCalls.at(-1).options.signal.aborted, true, 'the fetch is aborted');
    await settle();
    assert.equal(hud._summaryRequest, null, 'the in-flight guard unwinds');
    assert.ok(env.clearedTimeoutIds.length >= 1, 'the abort timeout is cleared');
    assert.equal(unsubscribes, 1, 'the data-manager subscription is released');
    assert.equal(env.moveEndHandlers.length, 0, 'the camera listener is removed');
  } finally {
    hud?.destroy();
    env.restore();
  }
});
