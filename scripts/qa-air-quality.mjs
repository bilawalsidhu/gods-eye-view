/**
 * qa-air-quality.mjs — headless proof for the Air quality layer.
 *
 * Checks what unit tests cannot: that the live ECCC feed answers, that readings
 * reach the app in the provider-shaped form other networks will share, and that
 * the Weather readout descriptor carries a legend and an in-view list.
 *
 * AQHI is reported by ECCC as an integer from 1 with "10+" above ten. The API
 * returns the underlying decimal, so a reading arriving as 1.08 — or a station
 * with no reading surfacing as a confident 1 — is a real defect this catches.
 *
 * Run:  node scripts/qa-air-quality.mjs --url http://localhost:4173
 */

import puppeteer from 'puppeteer';

const argv = process.argv.slice(2);
const getOpt = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const APP_URL = getOpt('--url', 'http://localhost:4173');

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  const tag = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${tag}] ${name}${detail ? `  — ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let exitCode = 0;
  const consoleErrors = [];
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--use-gl=swiftshader',
      '--enable-unsafe-swiftshader',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
    defaultViewport: { width: 1400, height: 900 },
  });

  try {
    const page = await browser.newPage();
    page.on('pageerror', (e) => consoleErrors.push(String(e).slice(0, 160)));
    page.on('console', (m) => {
      if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 160));
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 90000 },
    );
    await sleep(1500);

    const stats = await page.evaluate(async () => {
      const dm = window.__godsEyeView.dataManager;
      await dm.setEnabled('air-quality', true);
      const mod = dm.layers.get('air-quality')?.module;
      if (!mod) return { missing: true };
      let s = null;
      for (let i = 0; i < 45; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        s = mod.getStats();
        if (s.count > 0 || s.error) break;
      }
      return s;
    });

    const loaded = !stats?.missing && !stats?.error && stats?.count > 0;
    record('stations report a current index', loaded,
      `count=${stats?.count} error=${stats?.error}`);
    if (!loaded) exitCode = 1;

    const records = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager
          .layers.get('air-quality')
          ?.module.getAnalystRecords(500) || [],
    );

    // The provider-neutral contract other networks will share.
    const shaped = records.every(
      (r) => r.provider && r.scale && Number.isFinite(r.value) && r.band,
    );
    record('every reading carries provider, scale, value and band', shaped,
      records.length
        ? `sample={provider:${records[0].provider}, scale:${records[0].scale}, value:${records[0].value}, band:${records[0].band}}`
        : 'no records');
    if (!shaped) exitCode = 1;

    const published = records.every((r) => Number.isInteger(r.value) && r.value >= 1);
    record('every AQHI value is in the published integer form, floored at 1', published,
      `values=${[...new Set(records.map((r) => r.value))].sort((a, b) => a - b).join(',')}`);
    if (!published) exitCode = 1;

    const zones = [...new Set(records.map((r) => r.zone).filter(Boolean))].sort();
    record('coverage spans multiple ECCC administrative zones', zones.length >= 3,
      `zones=${zones.join(',') || 'none'} stations=${records.length}`);
    if (zones.length < 3) exitCode = 1;

    // The card's whole point is "highest readings in view", so put the camera
    // over Canada before asserting on it — the default view is over Austin,
    // where an empty in-view list is correct and proves nothing.
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const ellipsoid = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight in progress */
      }
      gev.viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: -100 * d2r,
          latitude: 55 * d2r,
          height: 4_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    });
    await sleep(2500);

    const controls = await page.evaluate(
      () =>
        window.__godsEyeView.dataManager
          .layers.get('air-quality')
          ?.module.getRowControls?.() || null,
    );
    const readoutOk =
      controls?.readout === true &&
      Array.isArray(controls?.legend?.colors) &&
      controls.legend.colors.length === controls.legend.labels.length &&
      Array.isArray(controls?.list?.items) &&
      controls.list.items.length > 0 &&
      controls.list.items.every((item) => item.id && item.label && item.value) &&
      /Canada only/.test(controls?.summary?.coverage || '');
    record('the Weather readout lists the worst readings in view, with a legend', readoutOk,
      controls
        ? `bands=${controls.legend?.labels?.join('/')} inView=${controls.list?.items?.length} coverage="${controls.summary?.coverage}"`
        : 'no descriptor');
    if (!readoutOk) exitCode = 1;

    record('no console errors', consoleErrors.length === 0,
      consoleErrors.length ? consoleErrors.slice(0, 2).join(' | ') : 'clean');
    if (consoleErrors.length) exitCode = 1;
  } catch (e) {
    console.error('\x1b[31mHarness error:\x1b[0m', e);
    exitCode = 3;
  } finally {
    await browser.close();
  }

  const pass = results.filter((r) => r.ok === true).length;
  const fail = results.filter((r) => r.ok === false).length;
  console.log('\n' + '─'.repeat(60));
  console.log(`  RESULT: ${pass} passed, ${fail} failed`);
  console.log('─'.repeat(60) + '\n');
  process.exit(exitCode || (fail > 0 ? 1 : 0));
}

main().catch((e) => {
  console.error(e);
  process.exit(3);
});
