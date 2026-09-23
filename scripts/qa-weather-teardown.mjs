/**
 * Weather teardown and cross-layer regression probe.
 *
 * Against a running dev server: records a resource baseline, turns every
 * weather layer on and exercises it (history playback, a wind reading, a
 * storm selection), turns them all off, and asserts the scene is back to the
 * baseline (imagery layers on the globe and the tileset, primitives, ground
 * primitives, data sources, entities, camera/scene listeners, the weather
 * panel, the wind reading marker). Then it enables a set of non-weather
 * layers one at a time and samples the render rate, long tasks and console
 * errors for each, and repeats the same non-weather sequence in a control
 * page that never had weather on. Writes <out>/<label>/results.json.
 *
 *   node scripts/qa-weather-teardown.mjs --url http://localhost:4173 --label google
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')
    ? argv[i + 1]
    : fallback;
};
const flag = (name) => argv.includes(name);
const rawUrl = arg('--url', 'http://localhost:4173');
const url = rawUrl.includes('welcome=')
  ? rawUrl
  : `${rawUrl}${rawUrl.includes('?') ? '&' : '?'}welcome=0`;
const label = arg('--label', 'teardown');
const outDir = path.resolve(arg('--out', 'qa-shots/weather-teardown'), label);
mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WEATHER = [
  'wind',
  'weather-radar',
  'weather-satellite',
  'weather-lightning',
  'weather-cyclones',
];

const browser = await puppeteer.launch({
  headless: flag('--headless') ? 'new' : false,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find((p) =>
      existsSync(p),
    ),
  protocolTimeout: 300_000,
  defaultViewport: null,
  args: [
    '--no-sandbox',
    '--window-size=1400,1000',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
  ],
});

const boot = async () => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 920, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) =>
    errors.push(`pageerror: ${e.message}`.slice(0, 200)),
  );
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`console: ${m.text()}`.slice(0, 200));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => !!window.__godsEyeView?.viewer, {
    timeout: 120_000,
  });
  await sleep(10_000);
  await page.evaluate(async () => {
    const gev = window.__godsEyeView;
    const dm = gev.dataManager;
    for (const [id, e] of dm.layers)
      if (e.enabled) await dm.setEnabled(id, false, { origin: 'user' });
    const v = gev.viewer;
    const d = Math.PI / 180;
    v.camera.setView({
      destination: v.scene.ellipsoid.cartographicToCartesian({
        longitude: -95 * d,
        latitude: 32 * d,
        height: 4_500_000,
      }),
      orientation: { heading: 0, pitch: -90 * d, roll: 0 },
    });
  });
  await sleep(3000);
  return { page, errors };
};

const snapshot = (page) =>
  page.evaluate(() => {
    const gev = window.__godsEyeView;
    const v = gev.viewer;
    const s = v.scene;
    const t = gev.tileset;
    const dm = gev.dataManager;
    const weather = {};
    for (const id of [
      'weather-radar',
      'weather-satellite',
      'weather-lightning',
    ]) {
      const d = dm.layers.get(id)?.module?.getDiagnostics?.();
      if (d)
        weather[id] = {
          imagery: d.imageryCount,
          mosaics: d.cache?.mosaics ?? 0,
          prefetching: !!d.cache?.prefetching,
        };
    }
    const wind = dm.layers.get('wind')?.module?.getDiagnostics?.() || {};
    return {
      globeImagery: v.imageryLayers.length,
      tilesetImagery: t?.imageryLayers?.length ?? null,
      primitives: s.primitives.length,
      groundPrimitives: s.groundPrimitives.length,
      dataSources: v.dataSources.length,
      entities: v.entities.values.length,
      listeners: {
        postRender: s.postRender.numberOfListeners,
        preRender: s.preRender.numberOfListeners,
        postUpdate: s.postUpdate.numberOfListeners,
        moveEnd: v.camera.moveEnd.numberOfListeners,
        moveStart: v.camera.moveStart.numberOfListeners,
        changed: v.camera.changed.numberOfListeners,
        tick: v.clock.onTick.numberOfListeners,
      },
      dom: {
        weatherPanelHidden:
          document.getElementById('weather-panel')?.hidden ?? null,
        weatherCards: document.querySelectorAll('.weather-card').length,
        windReading: !!document.querySelector(
          '.gev-wind-reading:not([hidden])',
        ),
      },
      weather,
      windCells: wind.gpu?.pathCount ?? wind.paths ?? null,
      enabled: [...dm.layers].filter(([, e]) => e.enabled).map(([id]) => id),
    };
  });

const sample = async (page, seconds) => {
  await page.evaluate(() => {
    window.__qaRenders = 0;
    window.__qaLong = { count: 0, ms: 0 };
    const s = window.__godsEyeView.viewer.scene;
    window.__qaOff = s.postRender.addEventListener(() => window.__qaRenders++);
    window.__qaObs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        window.__qaLong.count++;
        window.__qaLong.ms += e.duration;
      }
    });
    window.__qaObs.observe({ entryTypes: ['longtask'] });
    window.__qaRaf = () => {
      s.requestRender();
      window.__qaRafId = requestAnimationFrame(window.__qaRaf);
    };
    window.__qaRaf();
  });
  await sleep(seconds * 1000);
  return page.evaluate((seconds) => {
    cancelAnimationFrame(window.__qaRafId);
    window.__qaOff();
    window.__qaObs.disconnect();
    return {
      fps: +(window.__qaRenders / seconds).toFixed(1),
      longTasks: window.__qaLong.count,
      longMs: Math.round(window.__qaLong.ms),
    };
  }, seconds);
};

const setLayer = (page, id, on) =>
  page.evaluate(
    async ({ id, on }) => {
      const dm = window.__godsEyeView.dataManager;
      const e = dm.layers.get(id);
      if (e && Boolean(e.enabled) !== on)
        await dm.setEnabled(id, on, { origin: 'user' });
      return !!e;
    },
    { id, on },
  );

const diff = (a, b) => {
  const out = {};
  const walk = (x, y, prefix) => {
    for (const key of Object.keys(x)) {
      const p = prefix ? `${prefix}.${key}` : key;
      if (x[key] && typeof x[key] === 'object' && !Array.isArray(x[key]))
        walk(x[key], y?.[key] || {}, p);
      else if (JSON.stringify(x[key]) !== JSON.stringify(y?.[key]))
        out[p] = [x[key], y?.[key]];
    }
  };
  walk(a, b, '');
  return out;
};

const results = { url: rawUrl, label, startedAt: new Date().toISOString() };
try {
  // ── Run A: weather on → exercised → off → baseline check → other layers ──
  const a = await boot();
  const others = await a.page.evaluate(() =>
    [...window.__godsEyeView.dataManager.layers.keys()].filter((id) =>
      /^flights$|^satellites$|vessel|firms|earthquake|cables|^military$/.test(
        id,
      ),
    ),
  );
  console.log('other layers under test:', others.join(', '));
  const baseline = await snapshot(a.page);
  console.log('baseline', JSON.stringify(baseline));
  for (const id of WEATHER) await setLayer(a.page, id, true);
  await a.page
    .waitForFunction(
      () =>
        ['weather-radar', 'weather-satellite', 'weather-lightning'].every(
          (id) => {
            const d = window.__godsEyeView.dataManager.layers
              .get(id)
              ?.module?.getDiagnostics?.();
            return d && !d.loading && d.time;
          },
        ),
      { timeout: 120_000 },
    )
    .catch(() => console.log('  !! weather not ready'));
  await sleep(2000);
  // exercise: history playback, wind reading, storm selection, product switch
  await a.page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    dm.setLayerParams('weather-radar', { play: true }, { origin: 'user' });
    dm.setLayerParams('wind', { overlay: 'speed' }, { origin: 'user' });
    dm.setLayerParams('wind', { inspect: true }, { origin: 'user' });
    dm.setLayerParams(
      'weather-satellite',
      { product: 'clouds' },
      { origin: 'user' },
    );
  });
  await sleep(8000);
  await a.page.evaluate(() => {
    const dm = window.__godsEyeView.dataManager;
    const storms =
      dm.layers.get('weather-cyclones')?.module?.getRowControls?.().list
        ?.items || [];
    if (storms[1])
      dm.setLayerParams('weather-cyclones', storms[1].params, {
        origin: 'user',
      });
    dm.setLayerParams('weather-radar', { play: true }, { origin: 'user' });
  });
  await sleep(4000);
  const weatherOn = await snapshot(a.page);
  console.log('weather on', JSON.stringify(weatherOn));
  results.weatherOnSample = await sample(a.page, 5);
  for (const id of WEATHER) await setLayer(a.page, id, false);
  await sleep(4000);
  const afterOff = await snapshot(a.page);
  const leak = diff(
    { ...baseline, enabled: undefined, weather: undefined },
    { ...afterOff, enabled: undefined, weather: undefined },
  );
  results.baseline = baseline;
  results.afterOff = afterOff;
  results.leak = leak;
  console.log('after off', JSON.stringify(afterOff));
  console.log(
    Object.keys(leak).length
      ? `!! DIFFERENCES after teardown: ${JSON.stringify(leak)}`
      : 'teardown: scene back to baseline',
  );
  results.afterWeather = [];
  for (const id of others) {
    const ok = await setLayer(a.page, id, true);
    await sleep(9000);
    const m = await sample(a.page, 5);
    const snap = await snapshot(a.page);
    results.afterWeather.push({
      id,
      ok,
      ...m,
      primitives: snap.primitives,
      dataSources: snap.dataSources,
    });
    console.log(
      `after weather + ${id}: fps=${m.fps} long=${m.longTasks}/${m.longMs}ms`,
    );
  }
  results.errorsA = a.errors;
  await a.page.screenshot({ path: path.join(outDir, 'a-others-on.png') });
  await a.page.close();

  // ── Run B: control (same others, never had weather) ──
  const b = await boot();
  results.control = [];
  for (const id of others) {
    const ok = await setLayer(b.page, id, true);
    await sleep(9000);
    const m = await sample(b.page, 5);
    const snap = await snapshot(b.page);
    results.control.push({
      id,
      ok,
      ...m,
      primitives: snap.primitives,
      dataSources: snap.dataSources,
    });
    console.log(
      `control + ${id}: fps=${m.fps} long=${m.longTasks}/${m.longMs}ms`,
    );
  }
  results.errorsB = b.errors;
  await b.page.screenshot({ path: path.join(outDir, 'b-control.png') });
  await b.page.close();

  console.log(
    '\nerrors (weather run):',
    results.errorsA.length ? results.errorsA : 'none',
  );
  console.log(
    'errors (control run):',
    results.errorsB.length ? results.errorsB : 'none',
  );
  writeFileSync(
    path.join(outDir, 'results.json'),
    JSON.stringify(results, null, 2),
  );
  console.log(`wrote ${path.join(outDir, 'results.json')}`);
} finally {
  await browser.close();
}
