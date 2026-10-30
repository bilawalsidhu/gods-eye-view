// The HUD summary line in another language: what the model is sent and what
// the readout shows. hud.js imports `mgrs`, which Node's ESM loader cannot
// read named exports from, so a module hook swaps it for a stub before the
// import (the same setup as hudSummaryGate.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';

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
const { setLocale } = await import('./i18n/index.js');
const { hudSummaryInput } = await import('./hudSummaryResponse.js');

const PARTIAL_FLIGHTS = {
  id: 'flights',
  name: 'Live Flights',
  enabled: true,
  stats: { count: 4, partial: true, source: 'opensky' },
};

/** A ru HUD over one partial Live Flights layer, answering with `reply`. */
function createHud(t, reply) {
  const summary = { textContent: '' };
  const previous = { document: globalThis.document, window: globalThis.window };
  globalThis.document = {
    hidden: false,
    visibilityState: 'visible',
    getElementById: (id) => (id === 'hud-summary' ? summary : null),
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
  t.mock.timers.enable({ apis: ['setInterval'] });
  const viewer = {
    scene: { canvas: { width: 0, height: 0 }, pickPositionSupported: false },
    camera: {
      pitch: -Math.PI / 2,
      heading: 0,
      positionCartographic: { latitude: 0.53, longitude: -1.7, height: 600 },
      computeViewRectangle: () => undefined,
      moveStart: { addEventListener() {}, removeEventListener() {} },
      moveEnd: { addEventListener() {}, removeEventListener() {} },
    },
  };
  const sent = [];
  const hud = new IntelHUD(viewer, {
    summaryService: {
      configured: async () => true,
      async summarize(context) {
        sent.push(context);
        return { ok: true, status: 200, data: { error: null, ...reply } };
      },
    },
  });
  t.after(() => {
    hud.destroy();
    setLocale('en');
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  hud._dataManager = { getAll: () => [PARTIAL_FLIGHTS] };
  hud._latestMetrics = { altM: 600 };
  setLocale('ru');
  return { hud, sent, shown: () => summary.textContent };
}

test('a ru HUD request carries no English layer name', async (t) => {
  const { hud } = createHud(t, {});
  const context = await hud._summaryContext();
  assert.equal(context.locale, 'ru');
  assert.deepEqual(context.enabledLayerLabels, ['Рейсы онлайн']);
  const input = hudSummaryInput(context);
  assert.doesNotMatch(input, /Live Flights/, input);
  // The locale signs the dedupe signature; the English names stay local.
  assert.match(JSON.stringify(context), /"locale":"ru"/);
  assert.doesNotMatch(JSON.stringify(context), /translatedLayerNames/);
});

test('a ru summary shows the state word first and the layer names last', async (t) => {
  const { hud, shown } = createHud(t, {
    summary: 'Аэропорт задерживает рейсы',
    feedState: 'partial',
  });
  await hud._updateSummary(false, true);
  assert.equal(shown(), 'ЧАСТИЧНО | Аэропорт задерживает рейсы | РЕЙСЫ ОНЛАЙН');
});

for (const words of [
  'Live Flights частично онлайн',
  'Рейсы онлайн stale данные',
]) {
  test(`a ru reply echoing English falls back: ${words}`, async (t) => {
    const { hud, shown } = createHud(t, {
      summary: words,
      feedState: 'partial',
    });
    await hud._updateSummary(false, true);
    assert.ok(shown().startsWith('ЧАСТИЧНО | '), shown());
    assert.ok(!shown().includes(words), shown());
  });
}

test('a camera move during typing shows the plain line, not a fragment', (t) => {
  const { hud, shown } = createHud(t, {});
  hud._setSummaryText('ЧАСТИЧНО | Аэропорт задерживает рейсы', true);
  hud._onCameraMoveStart();
  assert.equal(shown(), hud._composeSummary());
});

test('a view with no labels and no layers does not ask the model', async (t) => {
  const { hud, sent, shown } = createHud(t, {
    summary: 'пусто',
    feedState: null,
  });
  hud._dataManager = { getAll: () => [] };
  await hud._updateSummary(false, true);
  assert.equal(sent.length, 0);
  assert.equal(shown(), hud._composeSummary());
});
