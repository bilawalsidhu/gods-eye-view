#!/usr/bin/env node
/** Real application chrome, fixture agent API; no paid calls or microphone.
 * Run on #1331 alone and on a temporary merge with #1429. --record-before
 * records geometry/hit tests without requiring the fixes. Keyboard coverage
 * simulates a visualViewport reduction; it does not certify a physical OS IME.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { createServer } from 'vite';
import puppeteer from 'puppeteer';

const before = process.argv.includes('--record-before');
const landscapeShell = process.argv.includes('--landscape-shell');
const sizes = process.argv.includes('--portrait-only')
  ? [
      [390, 844],
      [320, 568],
    ]
  : [
      [844, 390],
      [932, 430],
      [390, 844],
      [320, 568],
      [1280, 800],
    ];
const artifacts = 'qa-artifacts/agent-phone';
await fs.mkdir(artifacts, { recursive: true });
const server = await createServer({
  cacheDir: `${artifacts}/vite-cache`,
  server: { host: '127.0.0.1', port: 0, hmr: false },
});
let browser;
const results = [];
try {
  await server.listen();
  browser = await puppeteer.launch({
    headless: 'shell',
    pipe: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--enable-unsafe-swiftshader',
    ],
  });
  const page = await browser.newPage();
  page.on('pageerror', (error) =>
    console.error('Application error:', error.message),
  );
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    let payload;
    if (url.pathname === '/api/agent/config')
      payload = {
        providers: [
          {
            id: 'chatgpt',
            label: 'Fixture',
            authType: 'oauth',
            configured: true,
          },
        ],
        defaultProvider: 'chatgpt',
      };
    if (url.pathname === '/api/agent/chatgpt/status')
      payload = {
        active: 'fixture',
        binding: 'fixture',
        configured: true,
        accounts: [
          { id: 'fixture', label: 'fixture@example.test', signedIn: true },
        ],
      };
    if (url.pathname === '/api/agent/models')
      payload = {
        binding: 'fixture',
        models: [{ id: 'fixture', label: 'Scripted model' }],
      };
    if (payload)
      return request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(payload),
      });
    // No accidental inference, OAuth or audio requests in this layout gate.
    if (url.pathname === '/api/agent/command') return request.abort();
    return request.continue();
  });
  await page.evaluateOnNewDocument(() =>
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
  );
  async function geometry() {
    return page.evaluate(() => {
      const rect = (selector) => {
        const el = document.querySelector(selector);
        if (
          !el ||
          !el.getClientRects().length ||
          getComputedStyle(el).display === 'none'
        )
          return null;
        const r = el.getBoundingClientRect();
        return {
          left: r.left,
          top: r.top,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      const hit = (selector) => {
        const el = document.querySelector(selector),
          r = el?.getBoundingClientRect();
        return (
          !!r &&
          el.contains(
            document.elementFromPoint(
              r.left + r.width / 2,
              r.top + r.height / 2,
            ),
          )
        );
      };
      return {
        mobile: document.body.classList.contains('mobile-shell'),
        chip: rect('#agent-console-chip'),
        chipHit: hit('#agent-console-chip'),
        credits: [
          ...document.querySelectorAll(
            '#cesium-credits .cesium-credit-logoContainer, #cesium-credits .cesium-credit-textContainer, #cesium-credits .cesium-credit-expand-link',
          ),
        ].map((el) => {
          const r = el.getBoundingClientRect();
          return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
        }),
        tab: rect('#mobile-tab-bar'),
        dialog: rect('#agent-console[open]'),
        input: rect('#agent-input'),
        inputHit: hit('#agent-input'),
        closeHit: hit('#agent-console-close'),
        voice: rect('#gev-voice-button'),
        voiceHit: hit('#gev-voice-button'),
        settingsHit: hit('.gev-voice-settings-button'),
        providerHit: hit('#gev-voice-provider'),
        provider: rect('.gev-voice-provider-field'),
        settings: rect('.gev-voice-settings-button'),
        scrollWidth: document.querySelector('#agent-console').scrollWidth,
        clientWidth: document.querySelector('#agent-console').clientWidth,
      };
    });
  }
  for (const [width, height] of sizes) {
    await page.setViewport({ width, height });
    await page.goto(server.resolvedUrls.local[0] + '?welcome=0', {
      waitUntil: 'domcontentloaded',
    });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.viewer &&
        document.querySelector('#agent-console-chip:not([hidden])'),
      { timeout: 90000 },
    );
    await page.waitForFunction(() => {
      const loading = document.querySelector('#loading-screen');
      return loading && getComputedStyle(loading).opacity === '0';
    });
    // Layout checks use the real mounted app, with its continuous globe draw
    // loop paused to avoid spending software-GPU time on unrelated map frames.
    await page.evaluate(() => {
      window.__godsEyeView.viewer.useDefaultRenderLoop = false;
    });
    await new Promise((r) => setTimeout(r, 300));
    const closed = await geometry();
    if (landscapeShell && [844, 932].includes(width))
      assert.ok(closed.mobile, '#1429 landscape shell active');
    await page.screenshot({
      path: `${artifacts}/${before ? 'before' : 'after'}-${width}x${height}-closed.png`,
    });
    // Pointer click, never DOM .click(): this reproduces tab-bar interception.
    await page.click('#agent-console-chip');
    const openedByPointer = await page.$eval('#agent-console', (el) => el.open);
    if (!openedByPointer) {
      // Diagnostic only, to inspect the remaining window bugs after obstruction.
      await page.evaluate(() =>
        document.querySelector('#agent-console-chip').click(),
      );
    }
    await page.waitForFunction(
      () => !document.querySelector('#agent-input').disabled,
    );
    const opened = await geometry();
    await page.screenshot({
      path: `${artifacts}/${before ? 'before' : 'after'}-${width}x${height}-open.png`,
    });
    // Force the existing minimum-size path and inspect actual content layout.
    const grip = await page.$('#agent-console .agent-resize-grip');
    const gripRect = await grip.boundingBox();
    await page.mouse.move(gripRect.x + 7, gripRect.y + 7);
    await page.mouse.down();
    await page.mouse.move(
      gripRect.x + 7 + 320 - opened.dialog.width,
      gripRect.y + 7 + 220 - opened.dialog.height,
      { steps: 8 },
    );
    await page.mouse.up();
    const minimum = await geometry();
    await page.screenshot({
      path: `${artifacts}/${before ? 'before' : 'after'}-${width}x${height}-minimum.png`,
    });
    results.push({ width, height, closed, openedByPointer, opened, minimum });
    if (!before) {
      for (const credit of closed.credits)
        assert.ok(
          !(
            closed.chip.left < credit.right &&
            closed.chip.right > credit.left &&
            closed.chip.top < credit.bottom &&
            closed.chip.bottom > credit.top
          ),
          'launcher clears attribution',
        );
      assert.ok(
        closed.chipHit && openedByPointer,
        `${width}×${height}: pointer opens COMMAND`,
      );
      assert.ok(
        opened.inputHit && opened.closeHit,
        `${width}×${height}: input and close reachable`,
      );
      assert.ok(
        opened.dialog.left >= 0 &&
          opened.dialog.right <= width &&
          opened.dialog.bottom <= (closed.tab?.top ?? height),
        `${width}×${height}: console clears tabs`,
      );
      assert.ok(
        minimum.input.bottom <= minimum.dialog.bottom &&
          minimum.closeHit &&
          minimum.inputHit &&
          minimum.scrollWidth <= minimum.clientWidth + 3,
        `${width}×${height}: minimum geometry fits controls`,
      );
    }
    if (!before && closed.mobile) {
      assert.ok(
        opened.voiceHit && opened.providerHit && opened.settingsHit,
        'voice controls remain reachable',
      );
      await page.click('.gev-voice-settings-button');
      assert.equal(
        await page.$eval('.gev-voice-settings-button', (el) =>
          el.getAttribute('aria-expanded'),
        ),
        'true',
        'voice settings open alongside COMMAND',
      );
      await page.click('.gev-voice-settings-button');
      for (const sheet of ['layers', 'cameras', 'context', 'search', 'more']) {
        await page.click(
          `.mobile-tab[data-mobile-sheet="${sheet}"] .mobile-tab-label`,
        );
        assert.equal(
          await page.evaluate(() => document.body.dataset.mobileSheet),
          sheet,
          'tabs remain operable alongside COMMAND',
        );
        await page.click(
          `.mobile-tab[data-mobile-sheet="${sheet}"] .mobile-tab-label`,
        );
      }
      // Insets are simulated explicitly; actual env() values are device-owned.
      await page.evaluate(() => {
        for (const [side, value] of [
          ['left', 44],
          ['right', 44],
          ['bottom', 21],
        ]) {
          document.body.style.setProperty(
            '--mobile-' + side + '-inset',
            value + 'px',
          );
          document
            .querySelector('#agent-console')
            .style.setProperty('--agent-safe-' + side, value + 'px');
        }
        window.dispatchEvent(new Event('resize'));
      });
      const safe = await geometry();
      for (const credit of safe.credits)
        assert.ok(
          !(
            safe.chip.left < credit.right &&
            safe.chip.right > credit.left &&
            safe.chip.top < credit.bottom &&
            safe.chip.bottom > credit.top
          ),
          'safe-area launcher clears attribution',
        );
      assert.ok(
        safe.dialog.left >= 44 && safe.dialog.right <= width - 44,
        'safe-area window bounds',
      );
      assert.ok(
        safe.chip.left >= 44 && safe.chip.bottom <= safe.tab.top,
        'safe-area launcher clears tabs',
      );
      // Touch-focus the input; emulate only the viewport signal from an IME.
      await page.click('#agent-input');
      await page.type('#agent-input', 'layout fixture');
      assert.equal(
        await page.$eval('#agent-input', (el) => el.value),
        'layout fixture',
      );
      await page.evaluate(() => {
        window.qaRealViewport = window.visualViewport;
        Object.defineProperty(window, 'visualViewport', {
          configurable: true,
          value: window.qaRealViewport,
        });
        for (const [key, value] of Object.entries({
          height: 190,
          offsetTop: 20,
        }))
          Object.defineProperty(window.qaRealViewport, key, {
            configurable: true,
            value,
          });
        window.qaRealViewport.dispatchEvent(new Event('resize'));
      });
      const keyboard = await geometry();
      assert.ok(
        keyboard.dialog.top >= 20 &&
          keyboard.dialog.bottom <= 210 &&
          keyboard.inputHit &&
          keyboard.closeHit,
        'visual viewport keyboard reduction keeps input and dismissal reachable',
      );
      await page.screenshot({
        path: `${artifacts}/after-${width}x${height}-keyboard.png`,
      });
      await page.evaluate(() => {
        delete window.qaRealViewport.height;
        delete window.qaRealViewport.offsetTop;
        window.qaRealViewport.dispatchEvent(new Event('resize'));
      });
      const restored = await geometry();
      assert.deepEqual(
        restored.dialog,
        safe.dialog,
        'keyboard dismissal restores geometry',
      );
      results.at(-1).safe = safe;
      results.at(-1).keyboard = keyboard;
    }
    await page.click('#agent-console-close');
    if (!before) {
      assert.ok(await page.$eval('#agent-console', (el) => !el.open));
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        'agent-console-chip',
      );
    }
    console.log(`${before ? 'RECORDED' : 'PASS'} ${width}×${height}`);
  }
} finally {
  await fs.writeFile(
    `${artifacts}/${before ? 'before' : 'after'}-results.json`,
    JSON.stringify(results, null, 2),
  );
  await browser?.close();
  await server.close();
}
console.log(
  `${before ? 'RECORDED' : 'PASS'} ${results.length} application viewports`,
);
