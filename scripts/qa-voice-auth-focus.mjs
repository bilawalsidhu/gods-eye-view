#!/usr/bin/env node
/**
 * Check auth-mode keyboard focus with the real settings template and controls.
 * Run: node --test --test-reporter=spec scripts/qa-voice-auth-focus.mjs
 * Sign-in responses are fixtures. No credentials or live login are used.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { after, before, test } from 'node:test';
import puppeteer from 'puppeteer';

const root = new URL('../', import.meta.url);
const template = await readFile(
  new URL('src/ui/templates/provider-settings.html', root),
  'utf8',
);
const assets = new Set([
  '/src/keySetup.js',
  '/src/voice/cloudVoiceAuth.js',
  '/src/ui/surfaceKeyboard.js',
  '/src/ui/styles/provider-settings.css',
]);
const observations = [];
let server;
let browser;
let origin;

before(async () => {
  server = createServer(async (req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    if (pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(`<!doctype html><html><head><meta charset="utf-8">
        <title>Voice auth keyboard focus test</title>
        <link rel="stylesheet" href="/src/ui/styles/provider-settings.css">
        </head><body>${template}</body></html>`);
      return;
    }
    if (!assets.has(pathname)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    try {
      res.setHeader(
        'Content-Type',
        pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
      );
      res.end(await readFile(new URL(pathname.slice(1), root)));
    } catch {
      res.statusCode = 500;
      res.end('Could not load the test asset');
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (existsSync(chrome) ? chrome : await puppeteer.executablePath()),
  });
});

after(async () => {
  await browser?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  const output = new URL('.gev-logs/voice-auth-focus/', root);
  await mkdir(output, { recursive: true });
  await writeFile(
    new URL('results.json', output),
    `${JSON.stringify(observations, null, 2)}\n`,
  );
});

const scenarios = [
  {
    name: 'OAuth to API key',
    initial: 'oauth',
    expected: 'api-key',
    flow: 'unused',
  },
  {
    name: 'API key to existing OAuth',
    initial: 'api-key',
    expected: 'oauth',
    flow: 'existing',
  },
  {
    name: 'API key to OAuth ready at login launch',
    initial: 'api-key',
    expected: 'oauth',
    flow: 'login-ready',
  },
  {
    name: 'API key to OAuth ready after polling',
    initial: 'api-key',
    expected: 'oauth',
    flow: 'poll-ready',
  },
];

async function mountSettings(page, scenario) {
  await page.goto(`${origin}/?setup=1`, {
    waitUntil: 'domcontentloaded',
  });
  await page.evaluate(async ({ initial, flow }) => {
    localStorage.clear();
    localStorage.setItem('godsEyeView.voice.cloudAuth', initial);
    window.__focusTestCalls = [];
    let statusReads = 0;
    const fetchImpl = async (url) => {
      window.__focusTestCalls.push(url);
      let payload;
      let status = 200;
      if (url === '/api/setup/status') {
        payload = {
          setCount: 0,
          total: 1,
          keys: [
            {
              id: 'openai',
              title: 'OPENAI',
              tier: 'metered',
              set: false,
              unlocks: 'Voice control',
              envVars: ['OPENAI_API_KEY'],
              getUrl: 'https://example.invalid/',
            },
          ],
        };
      } else if (url === '/api/realtime/oauth-status') {
        statusReads += 1;
        if (flow === 'deferred') {
          return await new Promise((resolve) => {
            window.__resolveOAuthStatus = (available) =>
              resolve(
                new Response(
                  JSON.stringify({ available, error: 'Fixture failure' }),
                  {
                    status: available ? 200 : 503,
                  },
                ),
              );
          });
        }
        payload = {
          available:
            flow === 'existing' || (flow === 'poll-ready' && statusReads > 1),
        };
      } else if (url === '/api/realtime/oauth-login') {
        const available = flow === 'login-ready';
        status = available ? 200 : 202;
        payload = { available, pending: !available, started: !available };
      } else {
        throw new Error(`Unexpected request: ${url}`);
      }
      return new Response(JSON.stringify(payload), { status });
    };
    const { initKeySetup } = await import('/src/keySetup.js');
    window.__focusTestSettings = await initKeySetup({ fetchImpl });
  }, scenario);
  await page.waitForFunction(
    () =>
      document.getElementById('key-setup').classList.contains('visible') &&
      document.activeElement.matches('input[data-env-var]'),
  );
}

for (const scenario of scenarios) {
  for (const key of ['Enter', 'Space', 'Mouse click']) {
    test(`${scenario.name} keeps keyboard focus after ${key}`, async (t) => {
      const page = await browser.newPage();
      try {
        await mountSettings(page, scenario);

        if (key !== 'Mouse click') {
          // Tab from the initial key field to the real auth button.
          await page.keyboard.press('Tab');
          assert.equal(
            await page.evaluate(() =>
              document.activeElement.matches('[data-cloud-voice-auth-toggle]'),
            ),
            true,
            'Keyboard navigation must reach the auth toggle before activation',
          );
        }
        await page.evaluate(() => {
          const toggle = document.querySelector(
            '[data-cloud-voice-auth-toggle]',
          );
          window.__originalFocusToggle = toggle;
          window.__focusAtActivation = null;
          toggle.addEventListener(
            'click',
            () => {
              window.__focusAtActivation = document.activeElement === toggle;
            },
            { capture: true, once: true },
          );
        });
        if (key === 'Mouse click') {
          await page.waitForFunction(
            () =>
              getComputedStyle(document.getElementById('key-setup')).opacity ===
              '1',
          );
          await page.click('[data-cloud-voice-auth-toggle]');
        } else {
          await page.keyboard.press(key);
        }
        await page.waitForFunction(
          (expected) =>
            localStorage.getItem('godsEyeView.voice.cloudAuth') === expected &&
            !document.querySelector('[data-cloud-voice-auth-toggle]')
              .disabled &&
            document
              .querySelector('[data-cloud-voice-auth-toggle]')
              .getAttribute('aria-disabled') !== 'true',
          {},
          scenario.expected,
        );
        const selection = await page.evaluate(() => ({
          focusOnToggleAtActivation: window.__focusAtActivation,
          focusOnToggle:
            document.activeElement ===
            document.querySelector('[data-cloud-voice-auth-toggle]'),
          activeTag: document.activeElement.tagName,
          originalToggleConnected: window.__originalFocusToggle.isConnected,
          requests: window.__focusTestCalls,
        }));
        await page.keyboard.press('Tab');
        const nextTab = await page.evaluate(() => ({
          focusOnSave: document.activeElement.matches('[data-key-setup-apply]'),
          activeLabel:
            document.activeElement.getAttribute('aria-label') ||
            document.activeElement.textContent.trim(),
        }));
        const observed = { scenario: scenario.name, key, selection, nextTab };
        observations.push(observed);
        t.diagnostic(JSON.stringify(observed));
        assert.equal(
          selection.focusOnToggle,
          true,
          'Auth selection must keep focus on its usable toggle',
        );
        assert.equal(
          nextTab.focusOnSave,
          true,
          'Tab must continue to SAVE KEYS rather than restart at Close',
        );
      } finally {
        await page.close();
      }
    });
  }
}

for (const available of [true, false]) {
  test(`pending OAuth ${available ? 'success' : 'failure'} blocks repeats without moving focus or losing a key draft`, async () => {
    const page = await browser.newPage();
    try {
      await mountSettings(page, { initial: 'api-key', flow: 'deferred' });
      await page.type('input[data-env-var]', 'test-draft-only');
      await page.keyboard.press('Tab');
      await page.keyboard.press('Enter');
      await page.waitForFunction(
        () => typeof window.__resolveOAuthStatus === 'function',
      );
      assert.equal(
        await page.evaluate(() =>
          document.activeElement.matches('[data-cloud-voice-auth-toggle]'),
        ),
        true,
      );
      await page.keyboard.press('Enter');
      await page.keyboard.press('Space');
      assert.equal(
        await page.evaluate(
          () =>
            window.__focusTestCalls.filter(
              (url) => url === '/api/realtime/oauth-status',
            ).length,
        ),
        1,
      );
      await page.keyboard.press('Tab');
      assert.equal(
        await page.evaluate(() =>
          document.activeElement.matches('[data-key-setup-apply]'),
        ),
        true,
      );
      await page.evaluate(
        (available) => window.__resolveOAuthStatus(available),
        available,
      );
      await page.waitForFunction(
        () =>
          document
            .querySelector('[data-cloud-voice-auth-toggle]')
            .getAttribute('aria-disabled') === 'false',
      );
      const observed = await page.evaluate(() => ({
        mode: localStorage.getItem('godsEyeView.voice.cloudAuth'),
        focusOnSave: document.activeElement.matches('[data-key-setup-apply]'),
        draft: document.querySelector('input[data-env-var]').value,
        requests: window.__focusTestCalls,
      }));
      observations.push({ scenario: 'pending OAuth', available, observed });
      assert.equal(observed.mode, available ? 'oauth' : 'api-key');
      assert.equal(
        observed.focusOnSave,
        true,
        'Completing a request must not take focus from another control',
      );
      assert.equal(observed.draft, 'test-draft-only');
    } finally {
      await page.close();
    }
  });
}
