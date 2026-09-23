/**
 * Headless browser proof for the Web Receivers layer.
 *
 * Loads the app on a running dev server, refuses every sub-frame request (no
 * receiver page is contacted), enables the layer, checks the panel and marker
 * state, drives the three voice tools through the real action runner, and
 * verifies the dock and teardown behaviour.
 *
 * Run: node scripts/qa-web-receivers.mjs --url http://localhost:4173
 */
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const APP_URL =
  urlIndex >= 0 && args[urlIndex + 1]
    ? args[urlIndex + 1]
    : process.env.QA_BASE_URL || 'http://localhost:4173';
const errors = [];
const browser = await puppeteer.launch({
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    '--disable-dev-shm-usage',
    '--window-size=1440,900',
  ],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    // The app loads normally; only sub-frame traffic is refused so the tuned
    // receiver page in the dock is never actually contacted by the smoke test.
    const frame = request.frame();
    if (frame && frame !== page.mainFrame()) request.abort();
    else request.continue();
  });
  page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error')
      errors.push(`console: ${message.text().slice(0, 200)}`);
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  const appReady = () =>
    window.__godsEyeView?.dataManager?.layers?.has('web-receivers');
  try {
    await page.waitForFunction(appReady, { timeout: 20_000, polling: 500 });
  } catch {
    // A dev server that just restarted answers the first module request with
    // "504 Outdated Optimize Dep"; a real browser reloads, so do the same once.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForFunction(appReady, { timeout: 150_000, polling: 500 });
  }

  const dom = await page.evaluate(() => ({
    toggleRow: Array.from(document.querySelectorAll('#data-toggles *')).some(
      (element) => /Web Receivers/.test(element.textContent || ''),
    ),
    panel: Boolean(document.getElementById('web-receivers-panel')),
    stateText: document.getElementById('web-receivers-layer-state')
      ?.textContent,
    enableBtn: document.getElementById('web-receivers-enable-btn')?.textContent,
  }));
  console.log('dom before enable:', JSON.stringify(dom));

  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('web-receivers', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => {
      const module =
        window.__godsEyeView.dataManager.layers.get('web-receivers').module;
      const state = module.getUIState();
      return state.receiverCount > 1000 && !state.loading;
    },
    { timeout: 90_000, polling: 500 },
  );
  const afterEnable = await page.evaluate(() => {
    const module =
      window.__godsEyeView.dataManager.layers.get('web-receivers').module;
    const state = module.getUIState();
    return {
      enabled: window.__godsEyeView.dataManager.isEnabled('web-receivers'),
      receiverCount: state.receiverCount,
      filteredCount: state.filteredCount,
      degraded: state.degraded,
      stale: state.stale,
      error: state.error,
      stateText: document.getElementById('web-receivers-layer-state')
        ?.textContent,
      enableBtn: document.getElementById('web-receivers-enable-btn')
        ?.textContent,
      typeOptions:
        document.getElementById('web-receivers-type')?.options.length,
      bandOptions:
        document.getElementById('web-receivers-band')?.options.length,
      entities:
        window.__godsEyeView.viewer.dataSources.getByName('Web receivers')[0]
          ?.entities.values.length,
    };
  });
  console.log('after enable:', JSON.stringify(afterEnable));

  // Panel filter → fewer markers visible
  await page.select('#web-receivers-band', 'vhf');
  const filtered = await page.evaluate(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('web-receivers')
        .module.getUIState().filteredCount,
  );
  await page.select('#web-receivers-band', 'all');
  console.log('vhf filter count:', filtered);

  // Voice tools through the real action runner
  const voice = await page.evaluate(async () => {
    const { createGevActionRunner } = await import('/src/voice/gevActions.js');
    const app = window.__godsEyeView;
    const run = createGevActionRunner({
      viewer: app.viewer,
      styleManager: app.styleManager,
      dataManager: app.dataManager,
    });
    const found = await run('find_web_receivers', {
      latitude: 52.52,
      longitude: 13.4,
      frequencyKhz: 14233,
      limit: 5,
      frameResults: false,
    });
    const tuned = found.ok
      ? await run('tune_web_receiver', {
          receiverId: found.results[0].id,
          frequencyKhz: 14233,
          mode: 'usb',
          openIn: 'dock',
        })
      : null;
    const nearest = await run('tune_web_receiver', {
      target: 'nearest',
      latitude: 35.68,
      longitude: 139.69,
      frequencyKhz: 7055,
      openIn: 'dock',
    });
    const layerToggle = await run('set_layer_visibility', {
      layerId: 'sdr',
      enabled: true,
    });
    const spectrum = await run('show_rf_spectrum', {
      startKhz: 10000,
      stopKhz: 15000,
      latitude: 52.52,
      longitude: 13.4,
      openIn: 'dock',
    });
    const spectrumSelected = await run('show_rf_spectrum', {
      centerKhz: 7100,
      spanKhz: 200,
    });
    const dock = document.getElementById('web-receivers-dock');
    return {
      spectrum: {
        ok: spectrum.ok,
        name: spectrum.receiver?.name,
        type: spectrum.receiver?.type,
        url: spectrum.spectrumUrl,
        muted: spectrum.muted,
        zoom: spectrum.zoom,
        shownSpanKhz: spectrum.shownSpanKhz,
        covers: spectrum.covers,
        resolvedBy: spectrum.resolvedBy,
        error: spectrum.error,
      },
      spectrumSelected: {
        ok: spectrumSelected.ok,
        url: spectrumSelected.spectrumUrl,
        rangeLabel: spectrumSelected.rangeLabel,
        resolvedBy: spectrumSelected.resolvedBy,
      },
      focusOnApp:
        document.activeElement !==
        document.getElementById('web-receivers-frame'),
      found: {
        ok: found.ok,
        count: found.count,
        scopeLabel: found.scopeLabel,
        first: found.results?.[0],
      },
      tuned: tuned && {
        ok: tuned.ok,
        url: tuned.tuneUrl,
        mode: tuned.mode,
        covers: tuned.covers,
        resolvedBy: tuned.resolvedBy,
      },
      nearest: {
        ok: nearest.ok,
        name: nearest.receiver?.name,
        url: nearest.tuneUrl,
        mode: nearest.mode,
        covers: nearest.covers,
        error: nearest.error,
      },
      layerToggle: { ok: layerToggle.ok, layerId: layerToggle.layerId },
      dockVisible: dock && !dock.hidden,
      dockLabel: document.getElementById('web-receivers-dock-label')
        ?.textContent,
      frameSrc: document
        .getElementById('web-receivers-frame')
        ?.getAttribute('src'),
      panelOpen: !document
        .getElementById('web-receivers-panel')
        ?.classList.contains('collapsed'),
      statusText: document.getElementById('web-receivers-status')?.textContent,
      cardName: document.getElementById('web-receivers-name')?.textContent,
      cardMeta: document.getElementById('web-receivers-meta')?.textContent,
    };
  });
  console.log('voice:', JSON.stringify(voice, null, 1));
  // Let the startup splash and the intro flight clear before the screenshot.
  await page
    .waitForFunction(
      () => {
        const splash =
          document.getElementById('loading-screen') ||
          document.querySelector('.loading-screen, #splash');
        return (
          !splash ||
          splash.hidden ||
          getComputedStyle(splash).display === 'none' ||
          getComputedStyle(splash).opacity === '0'
        );
      },
      { timeout: 60_000, polling: 500 },
    )
    .catch(() => {});
  await page.screenshot({
    path: process.env.SHOT || 'qa-shots/web-receivers.png',
  });

  // Disable → dock closes, markers hidden
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('web-receivers', false, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => !window.__godsEyeView.dataManager.isEnabled('web-receivers'),
    { timeout: 30_000, polling: 500 },
  );
  const afterDisable = await page.evaluate(() => ({
    dockHidden: document.getElementById('web-receivers-dock')?.hidden,
    dsShown:
      window.__godsEyeView.viewer.dataSources.getByName('Web receivers')[0]
        ?.show,
    stateText: document.getElementById('web-receivers-layer-state')
      ?.textContent,
  }));
  console.log('after disable:', JSON.stringify(afterDisable));
} finally {
  await browser.close();
  // Network noise from tiles and the refused sub-frame is expected; anything else is a finding.
  const relevant = errors.filter(
    (entry) =>
      !/Failed to load resource|net::ERR_|Access-Control-Allow-Origin|Outdated Optimize Dep/i.test(
        entry,
      ),
  );
  console.log(
    'page errors (filtered):',
    relevant.length ? relevant.slice(0, 8) : 'none',
  );
}
