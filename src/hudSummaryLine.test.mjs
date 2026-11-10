import { test } from 'node:test';
import assert from 'node:assert/strict';
import './testSupport/stubMgrs.mjs';
import { hudReadouts } from './testSupport/hudReadouts.mjs';

const { IntelHUD } = await import('./hud.js');
const { setLocale } = await import('./i18n/index.js');
const { hudSummaryHasEnglish, hudSummaryInput } =
  await import('./hudSummaryResponse.js');

const PARTIAL_FLIGHTS = {
  id: 'flights',
  name: 'Live Flights',
  enabled: true,
  stats: { count: 4, partial: true, source: 'opensky' },
};

function createHud(
  t,
  reply,
  { places = ['Остин'], locale = 'ru', layers = () => [PARTIAL_FLIGHTS] } = {},
) {
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
    publish,
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
  // The test viewer has no view target, so no place lookup runs.
  const buildContext = hud._summaryContext.bind(hud);
  hud._summaryContext = async () =>
    Object.assign(await buildContext(), { placeLabels: places });
  hud._dataManager = { getAll: layers };
  hud._latestMetrics = { altM: 600 };
  setLocale(locale);
  return {
    hud,
    sent,
    shown: () => elements.get('hud-summary').textContent,
  };
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
  assert.doesNotMatch(JSON.stringify(context), /englishLayerWords|warning/);
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
  'Остин flights частично онлайн',
  'Austin flights partially online',
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

test('a view with layers but no place label does not ask the model', async (t) => {
  const { hud, sent, shown } = createHud(
    t,
    { summary: 'Москва Рейсы онлайн частично', feedState: 'partial' },
    { places: [] },
  );
  await hud._updateSummary(false, true);
  assert.equal(sent.length, 0);
  assert.equal(shown(), hud._composeSummary());
});

test('a ja request leaves the layer state ids to `overall`', async (t) => {
  const { hud } = createHud(t, {}, { locale: 'ja' });
  const context = await hud._summaryContext();
  assert.equal(context.feedProvenance.overall, 'partial');
  assert.ok(!('feedState' in context.enabledLayers[0]));
  assert.ok(!('feedState' in context.feedProvenance.layers[0]));
});

for (const [locale, summary] of [
  ['ja', '東京上空のstale航空情報'],
  ['ja', '東京上空のLive Flights'],
  ['zh-CN', '北京航班stale数据'],
  ['ru', 'Остин Live-Flights частично'],
]) {
  test(`English flush against other text is an echo: ${summary}`, () => {
    assert.ok(hudSummaryHasEnglish(summary, locale, ['stale', 'Live Flights']));
  });
}

test('English inside a longer Latin word is not an echo', () => {
  assert.ok(!hudSummaryHasEnglish('Datos stalesque', 'es', ['stale']));
});

for (const [locale, summary, places] of [
  ['es', 'Tráfico aéreo nominal sobre Madrid', ['Madrid']],
  ['de', 'Fallback Daten über Berlin', ['Berlin']],
  ['ja', 'Live Flights Plaza周辺', ['Live Flights Plaza']],
  ['es', 'Estación Loading Dock Madrid', ['Estación Loading Dock']],
]) {
  test(`a ${locale} word that is not an echo is shown: ${summary}`, async (t) => {
    const { hud, shown } = createHud(
      t,
      { summary, feedState: 'partial' },
      { places, locale },
    );
    await hud._updateSummary(false, true);
    assert.ok(shown().includes(summary), shown());
  });
}

test('a language switch drops the reply in flight and asks again', async (t) => {
  const { hud, sent, shown } = createHud(t, {});
  let answer;
  hud.summaryService.summarize = (context, { signal }) => {
    sent.push(context);
    return new Promise((resolve, reject) => {
      answer = () =>
        resolve({
          ok: true,
          status: 200,
          data: {
            error: null,
            summary: 'Остин рейсы частично',
            feedState: 'partial',
          },
        });
      signal.addEventListener('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
      );
    });
  };
  const pending = hud._updateSummary(false, true);
  while (!answer) await new Promise((resolve) => setImmediate(resolve));
  setLocale('es');
  answer();
  await pending;
  assert.ok(!shown().includes('Остин'), shown());
  assert.equal(shown(), hud._composeSummary());

  hud.summaryService.summarize = async (context) => {
    sent.push(context);
    return {
      ok: true,
      status: 200,
      data: {
        error: null,
        summary: 'Austin vuelos parciales',
        feedState: 'partial',
      },
    };
  };
  await hud._updateSummary(false);
  assert.equal(sent.at(-1).locale, 'es');
  assert.ok(shown().startsWith('PARCIAL | Austin vuelos parciales'), shown());
});

test('a reused ru reply carries the current warning, not the cached one', async (t) => {
  // Both layers load an empty view: no count, no lastUpdate yet.
  let flights = { loading: true, count: 0 };
  const { hud, shown } = createHud(
    t,
    { summary: 'Остин небо над городом', feedState: 'loading' },
    {
      layers: () => [
        { id: 'flights', name: 'Live Flights', enabled: true, stats: flights },
        {
          id: 'ais',
          name: 'Live AIS Vessels',
          enabled: true,
          stats: { loading: true, count: 0 },
        },
      ],
    },
  );
  await hud._updateSummary(false, true);
  assert.match(shown(), /РЕЙСЫ ОНЛАЙН/, shown());
  // Live Flights finishes with nothing to show; AIS is still loading.
  flights = { count: 0 };
  hud._markSummaryDirty();
  await hud._updateSummary(false);
  assert.match(
    shown(),
    /^ЗАГРУЗКА \| Остин небо над городом \| СУДА AIS/,
    shown(),
  );
  assert.doesNotMatch(shown(), /РЕЙСЫ ОНЛАЙН/, shown());
});

test('with every feed healthy a reply calling one unavailable falls back', async (t) => {
  const { hud, shown } = createHud(
    t,
    { summary: 'Остин рейсы недоступно сейчас', feedState: null },
    { layers: () => [] },
  );
  await hud._updateSummary(false, true);
  assert.equal(shown(), hud._composeSummary());
});

for (const [locale, place, summary] of [
  ['zh-CN', '北京', '北京航班不可用'],
  ['zh-Hant', '北京', '北京航班不可用'],
  ['ja', '東京', '東京航空便利用不可'],
]) {
  test(`a ${locale} reply calling a feed unavailable flush against Han falls back`, async (t) => {
    const { hud, shown } = createHud(
      t,
      { summary, feedState: null },
      { locale, places: [place], layers: () => [] },
    );
    await hud._updateSummary(false, true);
    assert.equal(shown(), hud._composeSummary());
  });
}

test('an ar reply opening with a Latin name keeps reading right to left', async (t) => {
  const { hud, shown } = createHud(
    t,
    { summary: 'Times Square نيويورك الولايات المتحدة', feedState: null },
    { locale: 'ar', places: ['Times Square'], layers: () => [] },
  );
  await hud._updateSummary(false, true);
  assert.equal(shown(), '\u200fTimes Square نيويورك الولايات المتحدة');
});

test('a one-word layer name that is a French word is not an echo', async (t) => {
  const summary = 'Bus en transit à Paris';
  const { hud, shown } = createHud(
    t,
    { summary, feedState: null },
    {
      locale: 'fr',
      places: ['Paris'],
      layers: () => [{ id: 'transit', name: 'Transit', enabled: true }],
    },
  );
  await hud._updateSummary(false, true);
  assert.equal(shown(), summary);
});
