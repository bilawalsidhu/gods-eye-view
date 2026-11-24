#!/usr/bin/env node
/**
 * Real-browser proof for manager-owned periodic work and document visibility.
 * Uses the app's development-only layer registration seam; no provider keys.
 * Run: node scripts/qa-layer-visibility.mjs --url http://localhost:4173
 * Hiding uses a real background tab, never a patched document.hidden getter.
 */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { chromeExecutablePath } from './qa-chrome.mjs';

const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const url = new URL(
  (urlIndex >= 0 ? args[urlIndex + 1] : undefined) ||
    process.env.QA_BASE_URL ||
    'http://localhost:4173',
);
url.searchParams.set('welcome', '0');
const browser = await puppeteer.launch({
  executablePath: chromeExecutablePath(),
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (name, actual, expected) => {
  assert.equal(actual, expected, name);
  console.log(`PASS ${name}: ${actual}`);
};
try {
  const page = await browser.newPage();
  const focus = await page.createCDPSession();
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => window.__gevQaRegisterLayer && window.__godsEyeView?.dataManager,
  );
  await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    window.__qaVisibilityUpdates = 0;
    window.__gevQaRegisterLayer(manager, {
      id: 'qa-document-visibility',
      name: 'Visibility QA',
      updateInterval: 750,
      init() {},
      enable() {},
      disable() {},
      destroy() {},
      async update() {
        window.__qaVisibilityUpdates++;
        return true;
      },
      getStats() {
        return { count: window.__qaVisibilityUpdates };
      },
    });
    await manager.setEnabled('qa-document-visibility', true, { origin: 'qa' });
  });
  const count = () => page.evaluate(() => window.__qaVisibilityUpdates);
  await page.waitForFunction(() => window.__qaVisibilityUpdates >= 3);
  check('periodic updates run while visible', (await count()) >= 3, true);
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  const cover = await browser.newPage();
  await cover.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'hidden');
  const hiddenCount = await count();
  await pause(2200);
  check('hidden tab makes no periodic updates', await count(), hiddenCount);
  check(
    'explicit refresh remains available while hidden',
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.refreshLayer('qa-document-visibility'),
    ),
    true,
  );
  check('explicit hidden refresh runs once', await count(), hiddenCount + 1);
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await page.waitForFunction(
    () =>
      document.visibilityState === 'visible' &&
      window.__qaVisibilityUpdates > 0,
  );
  await pause(200);
  check(
    'resume performs one overdue refresh without a catch-up burst',
    await count(),
    hiddenCount + 2,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled(
      'qa-document-visibility',
      false,
      { origin: 'qa' },
    ),
  );
  const stopped = await count();
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: false });
  await cover.bringToFront();
  await page.waitForFunction(() => document.visibilityState === 'hidden');
  await focus.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  await pause(1100);
  check(
    'disabled layer does not resume on visibility change',
    await count(),
    stopped,
  );
  check(
    'QA layer destroys cleanly',
    await page.evaluate(() =>
      window.__gevQaUnregisterLayer(
        window.__godsEyeView.dataManager,
        'qa-document-visibility',
      ),
    ),
    true,
  );
  console.log('RESULT: 7 passed');
} finally {
  await browser.close();
}
