// The HUD's place lookups are paid Google requests made only to feed the AI
// summary, so a server without one must not be asked to make them.
//
// hud.js imports `mgrs`, which Node's ESM loader cannot read named exports
// from, so a module hook swaps it for a stub before the import (the same
// setup as hudPageVisibility.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { playOpeningIntro } from './app/openingIntro.js';
import { hudReadouts } from './testSupport/hudReadouts.mjs';
import { registerHooks } from 'node:module';
import { fakeCameraPort } from './testSupport/fakeCameraPort.mjs';
import { toDegrees as deg } from './geo/index.js';

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

function installPage() {
  const { elements, publish } = hudReadouts();
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById: (id) => elements.get(id) ?? null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window ??= {
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  };
  const viewer = {};
  return {
    viewer,
    publish,
    restore() {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete globalThis[key];
        else globalThis[key] = value;
      }
    },
  };
}

/** A HUD whose place lookup and summary service only count their calls. */
function createHud(t, summaryService) {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const page = installPage();
  const hud = new IntelHUD(page.viewer, {
    camera: fakeCameraPort({
      pose: { lat: deg(0.53), lon: deg(-1.7), height: 600 },
    }).port,
    summaryService,
    publish: page.publish,
  });
  t.after(() => {
    hud.destroy();
    page.restore();
  });
  const calls = { context: 0 };
  hud._latestMetrics = { altM: 600 };
  hud._summaryContext = async () => {
    calls.context += 1;
    return { placeLabels: ['Austin'], streetLabels: [], nearbyPlaceLabels: [] };
  };
  return { hud, calls };
}

test('a server that reports no AI summary gets no place lookups', async (t) => {
  const service = {
    calls: 0,
    configured: async () => false,
    async summarize() {
      this.calls += 1;
      return { ok: true, status: 200, data: { summary: 'never' } };
    },
  };
  const { hud, calls } = createHud(t, service);
  await hud._updateSummary(false, true);
  hud._markSummaryDirty();
  await hud._updateSummary(false);
  assert.equal(calls.context, 0);
  assert.equal(service.calls, 0);
});

test('an unconfigured reply stops the lookups for the rest of the page', async (t) => {
  const service = {
    calls: 0,
    async summarize() {
      this.calls += 1;
      return {
        ok: true,
        status: 200,
        data: {
          configured: false,
          code: 'OPENAI_NOT_CONFIGURED',
          error: null,
          summary: null,
        },
      };
    },
  };
  const { hud, calls } = createHud(t, service);
  await hud._updateSummary(false, true);
  assert.equal(calls.context, 1, 'a server without the probe is asked once');
  hud._markSummaryDirty();
  await hud._updateSummary(false, true);
  assert.equal(calls.context, 1);
  assert.equal(service.calls, 1);
});

test('a configured or unknown summary keeps looking places up', async (t) => {
  for (const configured of [true, null, undefined]) {
    await t.test(String(configured), async (st) => {
      const service = {
        configured:
          configured === undefined ? undefined : async () => configured,
        summarize: async () => ({
          ok: true,
          status: 200,
          data: { summary: 'Austin capitol district live' },
        }),
      };
      const { hud, calls } = createHud(st, service);
      await hud._updateSummary(false, true);
      assert.equal(calls.context, 1);
    });
  }
});

test('an unchanged context restores its accepted reply over the fallback line', async (t) => {
  const service = {
    calls: 0,
    configured: async () => true,
    async summarize() {
      this.calls += 1;
      return {
        ok: true,
        status: 200,
        data: { summary: 'Austin capitol district live' },
      };
    },
  };
  const { hud } = createHud(t, service);
  const shown = () =>
    globalThis.document.getElementById('hud-summary').textContent;
  await hud._updateSummary(false, true);
  assert.equal(shown(), 'Austin capitol district live');

  // A small pan settles: the fallback line is painted and the reused labels
  // give the same context, so no new request is made.
  hud._setSummaryText('fallback line', false);
  hud._markSummaryDirty();
  await hud._updateSummary(false);
  assert.equal(service.calls, 1);
  assert.equal(shown(), 'Austin capitol district live');
});

test('the first summary waits for the opening to land', (t) => {
  const { hud } = createHud(t, {
    summarize: async () => ({ ok: true, status: 200, data: { summary: 'x' } }),
  });
  hud._visible = true;
  let asked = 0;
  hud._updateSummary = async () => {
    asked += 1;
  };

  const win = new Window();
  win.document.body.innerHTML = `
    <div id="loading-screen"><span class="loader-logo"><svg>
      <path id="outer_eye"/><path id="inner_eye"/>
    </svg></span></div>`;
  win.requestAnimationFrame = () => 1;
  win.matchMedia = () => ({ matches: false });
  const opening = playOpeningIntro({
    win,
    loadingScreen: win.document.getElementById('loading-screen'),
    camera: {
      pose: () => ({
        lon: 10,
        lat: 50,
        height: 23e6,
        heading: 0,
        pitch: -Math.PI / 2,
        roll: 0,
        fovy: 1,
      }),
      setView() {},
      onCommand: () => () => {},
    },
  });
  t.after(() => opening.cancel());
  hud._onCameraMoveEnd();
  assert.equal(asked, 0);
  opening.cancel();
  hud._onCameraMoveEnd();
  assert.equal(asked, 1);
});
