#!/usr/bin/env node
/** Focused browser proof for the current Azure Maps/OSM source tray. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const shotsDir = path.join(root, 'qa-shots', 'map-source-tray');
const appUrl = process.env.QA_BASE_URL || 'http://localhost:4173';
const headful = process.argv.includes('--headful');
const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH
  || (() => { try { return puppeteer.executablePath(); } catch { return null; } })();
if (!executablePath || !fs.existsSync(executablePath)) {
  throw new Error('Puppeteer Chrome for Testing is unavailable');
}
fs.mkdirSync(shotsDir, { recursive: true });

const browser = await puppeteer.launch({
  headless: headful ? false : 'new',
  executablePath,
  args: headful ? ['--no-sandbox'] : [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
  ],
});
const page = await browser.newPage();
const failures = [];
const check = (name, passed, detail = '') => {
  console.log(`  [${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!passed) failures.push(name);
};

try {
  await page.setViewport({ width: 1000, height: 900, deviceScaleFactor: 1 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === new URL(appUrl).origin
      && url.pathname === '/api/azure/foundry/hud-summary') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          configured: true,
          summary: 'Map Source tray ready',
          error: null,
        }),
      });
      return;
    }
    if (url.origin === new URL(appUrl).origin
      && url.pathname === '/api/azure/maps/attribution') {
      request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ attributions: ['© Microsoft Azure Maps and data suppliers'] }),
      });
      return;
    }
    request.continue();
  });

  await page.goto(`${appUrl}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60_000,
  });
  await page.waitForFunction(
    () => window.__godsEyeView?.styleManager?.mapStackController,
    { timeout: 60_000 },
  );

  const presentation = await page.evaluate(() => ({
    ids: [...document.querySelectorAll('.map-stack-chip')].map((chip) => chip.dataset.stackId),
    toggleTag: document.getElementById('control-panel-toggle')?.tagName,
    controls: document.getElementById('control-panel-toggle')?.getAttribute('aria-controls'),
  }));
  const expected = ['azure-satellite', 'azure-hybrid', 'azure-streets', 'osm'];
  check(
    'exact four-source Azure/OSM presentation',
    JSON.stringify(presentation.ids) === JSON.stringify(expected),
    JSON.stringify(presentation),
  );
  check(
    'compact wing is a semantic disclosure',
    presentation.toggleTag === 'BUTTON' && presentation.controls === 'control-panel-popover',
    JSON.stringify(presentation),
  );

  await page.focus('#control-panel-toggle');
  await page.keyboard.press('Enter');
  await new Promise((resolve) => setTimeout(resolve, 150));
  const opened = await page.evaluate(() => ({
    expanded: document.getElementById('control-panel-toggle')?.getAttribute('aria-expanded'),
    focused: document.activeElement?.dataset?.stackId,
  }));
  check(
    'keyboard opens the tray at Azure Satellite',
    opened.expanded === 'true' && opened.focused === 'azure-satellite',
    JSON.stringify(opened),
  );

  await page.click('[data-stack-id="osm"]');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.mapStackController.getActiveId() === 'osm',
    { timeout: 20_000 },
  );
  const osm = await page.evaluate(() => ({
    activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
    pressed: [...document.querySelectorAll('.map-stack-chip')]
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      .map((chip) => chip.dataset.stackId),
    imageryLayers: window.__godsEyeView.viewer.imageryLayers.length,
  }));
  check(
    'OSM switch commits one truthful active tile and rendered imagery',
    osm.activeId === 'osm'
      && JSON.stringify(osm.pressed) === JSON.stringify(['osm'])
      && osm.imageryLayers > 0,
    JSON.stringify(osm),
  );

  await page.evaluate(async () => {
    await window.__godsEyeView.styleManager._setMapStack('removed-provider', {
      syncShare: false,
    });
  });
  const invalid = await page.evaluate(() => ({
    activeId: window.__godsEyeView.styleManager.mapStackController.getActiveId(),
    pressed: [...document.querySelectorAll('.map-stack-chip')]
      .filter((chip) => chip.getAttribute('aria-pressed') === 'true')
      .map((chip) => chip.dataset.stackId),
  }));
  check(
    'unknown saved source resolves to Azure Satellite',
    invalid.activeId === 'azure-satellite'
      && JSON.stringify(invalid.pressed) === JSON.stringify(['azure-satellite']),
    JSON.stringify(invalid),
  );

  await page.setViewport({ width: 480, height: 900, deviceScaleFactor: 1 });
  await page.evaluate(() => window.__godsEyeView.styleManager
    .setPanelCollapsed('control-panel', false, { explicit: true }));
  await new Promise((resolve) => setTimeout(resolve, 180));
  const responsive = await page.evaluate(() => {
    const popover = document.getElementById('control-panel-popover').getBoundingClientRect();
    const chips = [...document.querySelectorAll('.map-stack-chip')]
      .map((chip) => chip.getBoundingClientRect());
    return {
      inside: popover.left >= 0 && popover.right <= innerWidth
        && chips.every((rect) => rect.left >= 0 && rect.right <= innerWidth),
      rows: new Set(chips.map((rect) => rect.top)).size,
    };
  });
  check('480 px tray stays in bounds', responsive.inside, JSON.stringify(responsive));
  await page.screenshot({ path: path.join(shotsDir, '480-open.png') });
} finally {
  await browser.close();
}

if (failures.length) {
  console.error(`\nMap Source tray QA failed: ${failures.join(', ')}`);
  process.exitCode = 1;
} else {
  console.log('\nMap Source tray QA passed.');
}
