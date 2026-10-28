// The HUD's ALT readout datum. Field report (2026-08-22, cockpit parked at
// SFO): the bottom-right OSD read "ALT: -15M" — and JFK, earlier, "ALT: -18M".
// Cesium reports the camera's height against the WGS84 ELLIPSOID, and San
// Francisco's geoid sits ~32 m BELOW it, so a camera 17 m over the SFO deck
// reads 32 m too low. The number a viewer reads as "ALT" is MSL.
//
// The arithmetic itself is pinned in src/data/geoid.test.mjs
// (ellipsoidalToMslDisplayM, including the no-geoid fallback). This file pins
// the PRODUCTION wiring two ways: source probes that hud.js routes both of its
// on-screen altitude strings through that correction, and a live IntelHUD
// driven across the real cold → resolved geoid transition.
//
// hud.js imports `mgrs`, a CommonJS package whose named exports Node's ESM
// loader cannot see, so the live half installs a module hook that swaps that
// one specifier for a stub. The import also has to happen BEFORE any DOM
// globals exist: Cesium's widget bundle probes for a real `document` at module
// scope and a partial stub sends it down the browser path. Hence hook →
// import → install DOM, in that order.
//
// The same hook is why the live AI-summary test lives here too: this is the
// one file that can construct a real IntelHUD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
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
        source:
          'export function forward() { return "10SEG55776339"; }\nexport default { forward };\n',
      };
    }
    return next(url, context);
  },
});

const { IntelHUD } = await import('./hud.js');

const source = readFileSync(new URL('./hud.js', import.meta.url), 'utf8');
// Boolean probes, not assert.match on the whole file — a failure here should
// name the missing wiring, not print all of hud.js.
const has = (pattern) => pattern.test(source);

/** SFO runway 28R touchdown area — the field report's coordinates. */
const SFO = { latDeg: 37.616, lonDeg: -122.368 };
/** The ellipsoidal camera height the owner's screenshot reported. */
const SFO_ELLIPSOIDAL_M = -15;

/**
 * Minimal DOM + viewer the HUD's telemetry tick actually touches. `intel-hud`
 * is deliberately absent so `_buildDOM` bails and the readouts stay the plain
 * text sinks this test reads.
 */
function installHudEnvironment() {
  const elements = new Map(
    [
      'hud-alt',
      'hud-summary',
      'hud-mgrs',
      'hud-latlon',
      'hud-bottom-line',
      'hud-gsd',
      'hud-coll',
      'hud-ona',
      'hud-mode',
    ].map((id) => [id, { textContent: '' }]),
  );
  const previousDocument = globalThis.document;
  const cameraListeners = {};
  globalThis.document = {
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  const viewer = {
    camera: {
      pitch: -Math.PI / 2,
      positionCartographic: {
        latitude: (SFO.latDeg * Math.PI) / 180,
        longitude: (SFO.lonDeg * Math.PI) / 180,
        height: SFO_ELLIPSOIDAL_M,
      },
      computeViewRectangle: () => undefined,
      moveStart: {
        addEventListener(listener) {
          cameraListeners.moveStart = listener;
        },
        removeEventListener() {},
      },
      moveEnd: {
        addEventListener(listener) {
          cameraListeners.moveEnd = listener;
        },
        removeEventListener() {},
      },
    },
  };
  return {
    elements,
    viewer,
    cameraListeners,
    restore() {
      if (previousDocument === undefined) delete globalThis.document;
      else globalThis.document = previousDocument;
    },
  };
}

test('hud.js corrects the camera height to MSL through the geoid module', () => {
  assert.equal(
    has(
      /import \{[^}]*\bellipsoidalToMslDisplayM\b[^}]*\} from '\.\/data\/geoid\.js';/s,
    ),
    true,
    'hud.js must take the datum correction from ./data/geoid.js, not re-derive one',
  );
  assert.equal(
    has(/ensureGeoidReady\(\)\s*\n\s*\.then\(/),
    true,
    'the geoid grid must be loaded opportunistically, never awaited on a readout tick',
  );
  assert.equal(
    has(/this\._geoidRequested = true;/),
    true,
    'the ~2.7 MB grid must be requested once, on demand — not at HUD construction',
  );
  assert.equal(
    has(
      /\.catch\(\(\) => \{\s*\/\* readout falls back to the uncorrected height \*\/\s*\}\)/,
    ),
    true,
    'a failed geoid load must leave the readout uncorrected, not unhandled',
  );
});

test('the corner ALT readout prints the MSL height, never the ellipsoidal one', () => {
  assert.equal(
    has(/const geoidN = this\._geoidUndulationM\(latDeg, lonDeg\);/),
    true,
    'the telemetry tick must look N up once and reuse it',
  );
  assert.equal(
    has(/const altMslM = ellipsoidalToMslDisplayM\(altM, geoidN\);/),
    true,
    'the ALT readout must convert the camera height before printing it',
  );
  assert.equal(
    has(/`ALT: \$\{Math\.round\(altMslM\)\}m/),
    true,
    'the #hud-alt line must print altMslM',
  );
  assert.equal(
    has(/`ALT: \$\{Math\.round\(altM\)\}m/),
    false,
    'the #hud-alt line must not regress to the raw ellipsoidal camera height',
  );
});

test('the summary ALT tag agrees with the corner readout', () => {
  // Both are on screen together; a viewer reading "ALT -15M" in one corner and
  // "ALT: 17m" in the other has found a bug, not a distinction.
  assert.equal(
    has(
      /const altDisplayM = Number\.isFinite\(m\.altMslM\) \? m\.altMslM : m\.altM;/,
    ),
    true,
    'the summary altitude tag must prefer the MSL datum and fall back to the raw height',
  );
  assert.equal(
    has(/const altTag = m\.altM >= 1000/),
    false,
    'the summary altitude tag must not regress to the raw ellipsoidal height',
  );
});

test('the sensor model keeps the ellipsoidal height it was tuned against', () => {
  // GSD/NIIRS and the STREET/CITY/METRO view band are camera-geometry math,
  // not readouts. Re-datuming them would silently move their thresholds, so
  // altM stays and altMslM is purely additive.
  assert.equal(
    has(/const gsd = Math\.max\(0\.01, altM \* 0\.000375\);/),
    true,
    'GSD must keep reading the raw camera height',
  );
  assert.equal(
    has(/const band = this\._viewBand\(m\.altM\);/),
    true,
    'the view band must keep reading the raw camera height',
  );
});

// ── The cold → resolved transition, driven live ─────────────────────────────
//
// The grid is a lazy ~2.7 MB chunk, so the first telemetry ticks of a session
// paint UNCORRECTED. The corner readout picks the correction up on the very
// next tick once it lands; the summary line has no such cadence — it repaints
// on camera settle or its own 15 s retry. That left a window at SFO where the
// corner read `ALT: 17m` beside a summary still reading `ALT -15M`, for up to
// fifteen seconds. Both must move in the SAME tick.

test('a cold tick paints both readouts uncorrected, and resolving flips both in one tick', async () => {
  const env = installHudEnvironment();
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    const alt = () => env.elements.get('hud-alt').textContent;
    const summary = () => env.elements.get('hud-summary').textContent;

    // Tick 1 — cold. This is also the tick that requests the grid.
    hud._updateCameraData();
    assert.match(alt(), /^ALT: -15m/, `cold corner readout, got ${alt()}`);
    assert.match(
      summary(),
      /\| ALT -15M \|/,
      `cold summary tag, got ${summary()}`,
    );

    // The HUD registered its own continuation on this same shared promise
    // during tick 1, and it registered first, so awaiting here means its
    // readiness flag is already set. No timers, no 15 s retry.
    await ensureGeoidReady();
    await Promise.resolve();

    // Tick 2 — resolved. ONE tick has to move both.
    hud._updateCameraData();
    assert.match(alt(), /^ALT: 17m/, `corrected corner readout, got ${alt()}`);
    assert.match(
      summary(),
      /\| ALT 17M \|/,
      `the summary must repaint in the same tick the corner does, got ${summary()}`,
    );

    // Tick 3 — steady state. The repaint is a transition, not a per-tick cost.
    const summaryRevisionAfterFlip = hud._summaryRevision;
    hud._updateCameraData();
    assert.match(alt(), /^ALT: 17m/);
    assert.match(summary(), /\| ALT 17M \|/);
    assert.equal(
      hud._summaryRevision,
      summaryRevisionAfterFlip,
      'a settled geoid must not re-dirty the summary on every telemetry tick',
    );
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('the corrected readouts are the MSL datum, not a coincidence of the SFO sign', async () => {
  await ensureGeoidReady();
  const env = installHudEnvironment();
  // London: N is +46 m, so the correction moves the readout DOWN. A sign flip
  // that happens to look right at SFO fails here.
  env.viewer.camera.positionCartographic.latitude = (51.5072 * Math.PI) / 180;
  env.viewer.camera.positionCartographic.longitude = (-0.1275 * Math.PI) / 180;
  env.viewer.camera.positionCartographic.height = 100;
  let hud;
  try {
    hud = new IntelHUD(env.viewer);
    hud._updateCameraData(); // cold: requests the grid, paints uncorrected
    assert.match(env.elements.get('hud-alt').textContent, /^ALT: 100m/);
    await ensureGeoidReady();
    await Promise.resolve();
    hud._updateCameraData();
    assert.match(
      env.elements.get('hud-alt').textContent,
      /^ALT: 54m/,
      `100 m ellipsoidal over London is 54 m MSL, got ${env.elements.get('hud-alt').textContent}`,
    );
    assert.match(env.elements.get('hud-summary').textContent, /\| ALT 54M \|/);
  } finally {
    hud?.destroy();
    env.restore();
  }
});

test('a summary asked for one view is dropped once the camera moves', async () => {
  const env = installHudEnvironment();
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  const pending = [];
  const summaryService = {
    summarize: (context) =>
      new Promise((resolve) => {
        pending.push({
          context,
          reply: (summary) =>
            resolve({ ok: true, status: 200, data: { summary, error: null } }),
        });
      }),
  };
  let hud;
  try {
    hud = new IntelHUD(env.viewer, { summaryService });
    let place = 'Yellowstone';
    hud._summaryContext = async () => ({ place });
    const summary = () => env.elements.get('hud-summary').textContent;
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    hud._updateCameraData();

    // The periodic tick's call (force=false): it asks only for a dirty
    // summary. Asked over Yellowstone; the camera leaves before the reply
    // lands.
    const first = hud._updateSummary(false);
    await settle();
    assert.equal(pending.length, 1);
    env.cameraListeners.moveStart();
    pending[0].reply('Canyon Junction Wyoming');
    await first;
    assert.doesNotMatch(
      summary(),
      /Canyon Junction/,
      'a reply for the old view is dropped',
    );

    // The next tick, with the camera still moving (a follow camera or an
    // orbit emits no moveEnd), asks about where it is now and paints it.
    place = 'Atlantic';
    const moving = hud._updateSummary(false);
    await settle();
    assert.equal(pending.length, 2, 'the move marked the summary dirty');
    assert.deepEqual(pending[1].context, { place: 'Atlantic' });
    pending[1].reply('North Atlantic Ocean');
    await moving;
    assert.equal(summary(), 'North Atlantic Ocean');
  } finally {
    for (const request of pending) request.reply('');
    hud?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    env.restore();
  }
});

test('a request the camera leaves paints nothing: aborted, failed, or its context build throws', async () => {
  const env = installHudEnvironment();
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  const pending = [];
  // Like fetch: an abort rejects with an AbortError, unless `ignoreAbort`.
  let ignoreAbort = false;
  const summaryService = {
    summarize: (context, { signal }) =>
      new Promise((resolve, reject) => {
        pending.push({ signal, reject });
        if (!ignoreAbort)
          signal.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
      }),
  };
  let hud;
  try {
    hud = new IntelHUD(env.viewer, { summaryService });
    hud._summaryContext = async () => ({ place: 'Yellowstone' });
    const element = env.elements.get('hud-summary');
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    hud._updateCameraData();

    // The move aborts the request in flight, and the abort paints nothing.
    let update = hud._updateSummary(false, true);
    await settle();
    element.textContent = 'shown before the move';
    env.cameraListeners.moveStart();
    assert.equal(pending[0].signal.aborted, true, 'the request is aborted');
    await update;
    assert.equal(element.textContent, 'shown before the move');

    // A request that fails after the move (an error, the 5 s timeout) does
    // not paint the old view's fallback line either.
    ignoreAbort = true;
    update = hud._updateSummary(false, true);
    await settle();
    element.textContent = 'shown before the move';
    env.cameraListeners.moveStart();
    pending[1].reject(new Error('network'));
    await update;
    assert.equal(element.textContent, 'shown before the move');

    // Nor does a context build that throws once the camera has moved.
    hud._summaryContext = async () => {
      env.cameraListeners.moveStart();
      throw new Error('view target unavailable');
    };
    element.textContent = 'shown before the move';
    await hud._updateSummary(false, true);
    assert.equal(element.textContent, 'shown before the move');
  } finally {
    hud?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    env.restore();
  }
});

test('a cancelled summary retries the same context but completed answers stay reusable', async () => {
  const env = installHudEnvironment();
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  const pending = [];
  const summaryService = {
    summarize: (context, { signal }) =>
      new Promise((resolve, reject) => {
        pending.push({
          context,
          reply: (summary) =>
            resolve({ ok: true, status: 200, data: { summary } }),
        });
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  };
  let hud;
  try {
    hud = new IntelHUD(env.viewer, { summaryService });
    hud._summaryContext = async () => ({ place: 'San Francisco' });
    hud._updateCameraData();
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    const first = hud._updateSummary(false);
    await settle();
    assert.equal(pending.length, 1);
    env.cameraListeners.moveStart();
    await first;

    // An orbit can leave all semantic place/layer labels unchanged. The next
    // periodic tick must retry even though its context equals the aborted one.
    const retry = hud._updateSummary(false);
    await settle();
    assert.equal(
      pending.length,
      2,
      'the cancelled signature cannot suppress a retry',
    );
    assert.deepEqual(pending[1].context, pending[0].context);
    pending[1].reply('San Francisco Bay Urban Landscape');
    await retry;
    assert.equal(
      env.elements.get('hud-summary').textContent,
      'San Francisco Bay Urban Landscape',
    );

    // Movement without an active request must not discard a completed answer.
    env.cameraListeners.moveStart();
    await hud._updateSummary(false);
    assert.equal(pending.length, 2, 'completed context still deduplicates');
  } finally {
    for (const request of pending) request.reply('');
    hud?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    env.restore();
  }
});

test('after a dropped or timed-out request the next tick asks again, and a move stops typing', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const env = installHudEnvironment();
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  const pending = [];
  const summaryService = {
    summarize: (context, { signal }) =>
      new Promise((resolve, reject) => {
        pending.push({ resolve });
        signal.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
  };
  let hud;
  try {
    hud = new IntelHUD(env.viewer, { summaryService });
    // The same place before and after: a slow follow camera, a small pan.
    hud._summaryContext = async () => ({ place: 'Lisboa' });
    const element = env.elements.get('hud-summary');
    const settle = () => new Promise((resolve) => setImmediate(resolve));
    hud._updateCameraData();

    // A move aborts the request; the next tick over the same place asks again.
    let update = hud._updateSummary(false);
    await settle();
    env.cameraListeners.moveStart();
    await update;
    update = hud._updateSummary(false);
    await settle();
    assert.equal(pending.length, 2, 'asked again after the abort');

    // That one times out at 5 s: retried like any failure.
    t.mock.timers.tick(5_000);
    await update;
    update = hud._updateSummary(false);
    await settle();
    assert.equal(pending.length, 3, 'asked again after the timeout');
    pending[2].resolve({
      ok: true,
      status: 200,
      data: { summary: 'Lisboa Rua Augusta', error: null },
    });
    await update;

    // A reply still typing stops when the camera starts moving.
    hud._typeSummary('Canyon Junction Wyoming Yellowstone National Park');
    t.mock.timers.tick(48);
    const typed = element.textContent;
    env.cameraListeners.moveStart();
    t.mock.timers.tick(2_000);
    assert.equal(
      element.textContent,
      typed,
      'no more characters after the move',
    );
  } finally {
    hud?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    env.restore();
  }
});

test('a summary interrupted while typing can retry unchanged context', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const env = installHudEnvironment();
  const previousWindow = globalThis.window;
  globalThis.window = globalThis;
  let calls = 0;
  const text = 'San Francisco Bay Urban Landscape';
  const summaryService = {
    summarize: async () => {
      calls++;
      return { ok: true, status: 200, data: { summary: text } };
    },
  };
  let hud;
  try {
    hud = new IntelHUD(env.viewer, { summaryService });
    hud._summaryContext = async () => ({ place: 'San Francisco' });
    hud._updateCameraData();
    await hud._updateSummary(true);
    t.mock.timers.tick(48);
    const element = env.elements.get('hud-summary');
    assert.notEqual(element.textContent, text, 'the answer is still typing');
    assert.equal(
      hud._summaryRequest,
      null,
      'the network request already finished',
    );
    env.cameraListeners.moveStart();
    assert.equal(hud._summaryTypingInterval, null);
    await hud._updateSummary(false);
    assert.equal(
      calls,
      2,
      'a partially displayed answer must not suppress retry',
    );
    assert.equal(element.textContent, text);
    env.cameraListeners.moveStart();
    await hud._updateSummary(false);
    assert.equal(calls, 2, 'the fully displayed answer remains reusable');
  } finally {
    hud?.destroy();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    env.restore();
  }
});
