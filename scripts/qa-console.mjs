#!/usr/bin/env node
/** Browser proof of the Operations Console: telemetry, palette, rail, dossier and stand-down. */
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  // Same escape hatch as scripts/qa-application.mjs: a checkout that skipped
  // the bundled download points at its own browser.
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
  protocolTimeout: 240000,
});
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
let failures = 0;
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
const check = (name, passed, detail = '') => {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures++;
};
const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('#gev-console-topbar', { visible: true, timeout: 60000 });
  check('console chrome mounts before the scene is up', true);
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90000,
  });
  await settle(5000);

  // ── Telemetry ──────────────────────────────────────────────────────────
  const readouts = await page.evaluate(() => {
    const read = (id) => document.getElementById(id)?.textContent?.trim() || '';
    return {
      lat: read('gev-console-lat'),
      lon: read('gev-console-lon'),
      elev: read('gev-console-elev'),
      hdg: read('gev-console-hdg'),
      grid: read('gev-console-grid'),
      clock: read('gev-console-clock'),
    };
  });
  check('camera readouts resolve', /°[NS]$/.test(readouts.lat) && /°[EW]$/.test(readouts.lon),
    JSON.stringify(readouts));
  check('grid reference resolves', /^\d{1,2}[A-Z] [A-Z]{2} \d+ \d+$/.test(readouts.grid), readouts.grid);
  check('UTC clock ticks', /^\d{2}:\d{2}:\d{2}$/.test(readouts.clock), readouts.clock);

  // ── The attribution credit stays reachable ─────────────────────────────
  const credit = await page.evaluate(() => {
    const element = document.getElementById('cesium-credits');
    const rect = element?.getBoundingClientRect();
    if (!rect || !rect.width) return { measured: false };
    const target = document.elementFromPoint(rect.left + 4, rect.top + rect.height / 2);
    return { measured: true, covered: !element.contains(target), by: target?.id || target?.tagName };
  });
  check('console chrome never covers the Cesium credit',
    !credit.measured || !credit.covered, JSON.stringify(credit));

  // ── Command palette ────────────────────────────────────────────────────
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyK');
  await page.keyboard.up('Control');
  await page.waitForSelector('#gev-console-palette:not([hidden])', { timeout: 5000 });
  await page.type('#gev-console-palette-input', 'tokyo');
  await settle(400);
  const palette = await page.evaluate(() => ({
    first: document.querySelector('#gev-console-palette-list .gc-row-title')?.textContent,
    active: document.querySelector('#gev-console-palette-list .gc-row.is-active')?.id,
    described: document.getElementById('gev-console-palette-input')?.getAttribute('aria-activedescendant'),
  }));
  check('palette ranks the matching command first', palette.first === 'Tokyo', palette.first);
  check('the combobox points at the active row', Boolean(palette.active) && palette.active === palette.described,
    JSON.stringify(palette));
  await page.keyboard.press('Enter');
  await settle(3000);
  const flown = await page.evaluate(() =>
    document.getElementById('gev-console-lon')?.textContent?.trim());
  check('running a place command flies the camera', /°E$/.test(flown || ''), flown);
  check('the palette closes after a run',
    await page.evaluate(() => document.getElementById('gev-console-palette')?.hidden === true));

  // ── Module rail drives the application's own panels ────────────────────
  await page.click('.gc-rail-btn[data-console-panel="data-panel"]');
  await settle(600);
  const opened = await page.evaluate(() => ({
    panel: !document.getElementById('data-panel')?.classList.contains('collapsed'),
    pressed: document.querySelector('.gc-rail-btn[data-console-panel="data-panel"]')?.getAttribute('aria-pressed'),
  }));
  check('the rail opens the application panel', opened.panel && opened.pressed === 'true', JSON.stringify(opened));
  // ...and follows it when the application's own control closes it.
  await page.click('[data-collapse-target="data-panel"]');
  await settle(600);
  check('the rail follows a panel closed elsewhere', await page.evaluate(() =>
    document.querySelector('.gc-rail-btn[data-console-panel="data-panel"]')?.getAttribute('aria-pressed') === 'false'));

  // ── Dossier: the feed roster is a real control surface ─────────────────
  await page.click('#gev-console-dossier-btn');
  await page.click('#gev-console-tab-feeds');
  await settle(800);
  const layerId = 'telegeography-submarine-cables';
  const toggled = await page.evaluate(async (id) => {
    const manager = window.__godsEyeView.dataManager;
    const index = manager.getAll().filter((l) => l.showInTogglePanel !== false)
      .findIndex((l) => l.id === id);
    if (index < 0) return { error: 'layer absent' };
    const rows = [...document.querySelectorAll('#gev-console-feed-list .gc-feed-row')];
    rows[index]?.querySelector('.gc-feed-toggle')?.click();
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (manager.isEnabled(id)) break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2600));
    return {
      enabled: manager.isEnabled(id),
      panelActive: document
        .querySelector(`#data-toggles [data-layer-id="${id}"] .data-toggle-btn`)
        ?.classList.contains('active'),
      rail: document.getElementById('gev-console-rail-count')?.textContent,
    };
  }, layerId);
  check('a dossier toggle enables the layer through its lifecycle',
    toggled.enabled === true && toggled.panelActive === true, JSON.stringify(toggled));
  check('the console counts the layer it started', toggled.rail === '1', toggled.rail);

  // ── The analyst reports its own availability ───────────────────────────
  await page.click('#gev-console-tab-analyst');
  await settle(500);
  const analyst = await page.evaluate(() => ({
    chip: document.getElementById('gev-console-chip-analyst')?.textContent?.trim(),
    note: document.getElementById('gev-console-analyst-note')?.textContent?.trim(),
    disabled: document.getElementById('gev-console-analyst-input')?.disabled,
  }));
  const configured = /READY/.test(analyst.chip || '');
  check('the analyst states whether a credential is configured',
    configured ? analyst.disabled === false : /OPENAI_API_KEY/.test(analyst.note || ''),
    JSON.stringify(analyst));

  // ── Stand-down restores the original interface ─────────────────────────
  await page.click('#gev-console-exit-btn');
  await settle(600);
  const classic = await page.evaluate(() => ({
    bodyClass: document.body.classList.contains('gev-console'),
    hidden: document.getElementById('gev-console')?.hidden,
    restore: document.getElementById('gev-console-restore')?.hidden,
    title: getComputedStyle(document.getElementById('title-bar')).display,
    stackX: getComputedStyle(document.documentElement).getPropertyValue('--left-stack-x').trim(),
  }));
  check('standing down removes every console surface',
    classic.bodyClass === false && classic.hidden === true && classic.restore === false,
    JSON.stringify(classic));
  check('the application title block comes back', classic.title === 'block', classic.title);
  await page.click('#gev-console-restore');
  await settle(600);
  check('the console comes back on request', await page.evaluate(() =>
    document.body.classList.contains('gev-console')));

  check('no page errors', errors.length === 0, errors.join(' | '));
} catch (error) {
  check(`console QA run: ${error.message}`, false);
} finally {
  await browser.close();
}
console.log(failures ? `${failures} check(s) failed` : 'All console checks passed');
process.exit(failures ? 1 : 0);
