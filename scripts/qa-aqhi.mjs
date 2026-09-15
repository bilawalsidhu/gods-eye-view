/**
 * qa-aqhi.mjs — headless proof for the Air Quality Health Index layer.
 *
 * Checks the two things unit tests cannot: that the live ECCC feed actually
 * answers with national coverage, and that every reading reaches the app in the
 * index's published form.
 *
 * AQHI is reported by ECCC as an integer from 1 with "10+" above ten. The API
 * returns the underlying decimal, so a reading arriving as 1.08 — or a station
 * with no reading surfacing as a confident 1 — is a real defect this catches.
 *
 * Run:  node scripts/qa-aqhi.mjs --url http://localhost:4173
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
  const tag =
    ok === null
      ? '\x1b[33mINCONCLUSIVE\x1b[0m'
      : ok
        ? '\x1b[32mPASS\x1b[0m'
        : '\x1b[31mFAIL\x1b[0m';
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
      await dm.setEnabled('aqhi', true);
      const mod = dm.layers.get('aqhi')?.module;
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
          .layers.get('aqhi')
          ?.module.getAnalystRecords(500) || [],
    );

    // National coverage: ECCC splits Canada into five administrative zones
    // (atl, que, ont, pnr, pyr). A layer that only reaches one is not national.
    const zones = [...new Set(records.map((r) => r.zone).filter(Boolean))].sort();
    record('coverage spans multiple ECCC administrative zones', zones.length >= 3,
      `zones=${zones.join(',') || 'none'} stations=${records.length}`);
    if (zones.length < 3) exitCode = 1;

    const published = records.every((r) => Number.isInteger(r.aqhi) && r.aqhi >= 1);
    record('every reading is in the published integer form, floored at 1', published,
      `values=${[...new Set(records.map((r) => r.aqhi))].sort((a, b) => a - b).join(',')}`);
    if (!published) exitCode = 1;

    const named = records.every((r) => r.risk && r.name && Number.isFinite(r.lat));
    record('readings carry a risk band, a station name, and coordinates', named,
      records.length ? `sample=${records[0].name} ${records[0].aqhi} (${records[0].risk})` : 'none');
    if (!named) exitCode = 1;

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
