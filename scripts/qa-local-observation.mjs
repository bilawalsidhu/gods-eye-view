/** Isolated synthetic UI gate. No live camera pixels, location or paid API calls. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const value = (flag, fallback) =>
  args.includes(flag) ? args[args.indexOf(flag) + 1] : fallback;
const url = new URL(value('--url', 'http://127.0.0.1:4791'));
if (!['localhost', '127.0.0.1'].includes(url.hostname))
  throw new Error('Use a separate loopback fixture server');
url.searchParams.set('welcome', '0');
const root = path.resolve(value('--output', 'qa-artifacts/local-observation'));
await fs.mkdir(root, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  userDataDir: path.join(root, 'browser-profile'),
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
  ],
  protocolTimeout: 120000,
});
const checks = [],
  errors = [];
let page;
const record = (name) => {
  checks.push(name);
  console.log(`PASS ${name}`);
};
try {
  page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const session = await page.createCDPSession();
  await session.send('Browser.setDownloadBehavior', {
    behavior: 'allow',
    downloadPath: path.join(root, 'downloads'),
  });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'geolocation', {
      configurable: true,
      value: {
        getCurrentPosition(success) {
          setTimeout(
            () =>
              success({
                coords: { latitude: 1.25, longitude: 2.5, accuracy: 20 },
              }),
            100,
          );
        },
      },
    });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        async writeText(text) {
          window.__qaCopied = text;
        },
      },
    });
  });
  const imagery = await fs.readFile(
    new URL(
      '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
      import.meta.url,
    ),
  );
  await page.setRequestInterception(true);
  const fixtureRequest = (req) => {
    const target = new URL(req.url());
    if (
      (target.origin === 'https://services.arcgisonline.com' &&
        /\/tile\/\d+\/\d+\/\d+$/.test(target.pathname)) ||
      (target.origin === 'https://tile.openstreetmap.org' &&
        /\/\d+\/\d+\/\d+\.png$/.test(target.pathname))
    )
      return void req.respond({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: imagery,
      });
    if (
      target.origin === url.origin &&
      target.pathname === '/api/openai/camera-image'
    ) {
      if (req.method() === 'POST') {
        const body = JSON.parse(req.postData());
        assert.equal(body.confirmOriginal, true);
        assert.equal(body.model, 'gpt-6.1-sol');
        assert.match(body.image, /^data:image\/png;base64,/);
        assert.equal(Object.hasOwn(body, 'notes'), false);
        return void req.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            answer:
              'Synthetic test answer: invented blue drawing; no actual vehicle identity.',
          }),
        });
      }
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          available: true,
          model: 'gpt-6.1-sol',
          reasoning: 'high',
          warning: 'Synthetic API fixture; no inference or charge',
          access: 'Fixture only',
        }),
      });
    }
    if (
      target.origin === url.origin &&
      target.pathname === '/api/openai/hud-summary'
    )
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'Synthetic globe ready' }),
      });
    if (
      target.origin === url.origin &&
      target.pathname.startsWith('/api/flights')
    )
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          time: Math.floor(Date.now() / 1000),
          states: [],
        }),
      });
    if (
      target.origin === url.origin &&
      target.pathname.startsWith('/api/military')
    )
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ac: [] }),
      });
    if (
      target.origin === url.origin &&
      target.pathname.startsWith('/api/vessels')
    )
      return void req.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ connected: true, vessels: [], ships: [] }),
      });
    void req.continue();
  };
  page.on('request', fixtureRequest);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      window.__godsEyeView?.viewer &&
      document.querySelector('#desktop-camera-expand'),
    { timeout: 60000 },
  );
  record('application booted in independent profile');
  await page.waitForFunction(
    () => !document.querySelector('#loading-screen') || getComputedStyle(document.querySelector('#loading-screen')).pointerEvents === 'none',
    { timeout: 60000 },
  );
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await page.click('#locate-me-btn');
  await page.waitForFunction(
    () =>
      document.querySelector('#locate-me-status')?.dataset.state === 'ready',
    { timeout: 15000 },
  );
  const params = new URLSearchParams(new URL(page.url()).hash.slice(1));
  assert.equal(params.get('lat'), '0.0000');
  assert.equal(params.get('lon'), '0.0000');
  assert.equal(params.get('alt'), '40000000');
  record(
    'one-shot invented locate excludes device-derived coordinates from hash',
  );
  await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    await manager.setEnabled('cctv', true);
    const layer = manager.layers.get('cctv').module;
    layer.selectCamera('synthetic-1');
  });
  await page.waitForFunction(
    () => document.querySelector('#cctv-frame')?.classList.contains('active'),
    { timeout: 30000 },
  );
  record('synthetic camera frame displayed');
  await page.click('#cctv-refresh-btn');
  await page.waitForFunction(
    () =>
      document.querySelector('#cctv-retry-status')?.dataset.state === 'ready',
    { timeout: 35000 },
  );
  record('Refresh recreates selected camera and settles ready');
  await page.click('#desktop-camera-expand');
  await page.waitForSelector('#mobile-camera-expanded[open]');
  assert.equal(
    await page.$eval(
      '#cctv-panel',
      (el) => !!el.closest('#mobile-camera-expanded'),
    ),
    true,
  );
  assert.equal(
    await page.$eval(
      '#cesium-credits',
      (el) => !!el.closest('#mobile-camera-expanded'),
    ),
    true,
  );
  await page.screenshot({
    path: path.join(root, 'desktop-camera-expanded.png'),
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => !document.querySelector('#mobile-camera-expanded').open,
  );
  record('desktop expansion preserves surface/credits and Escape restores');
  await page.click('#cctv-snapshot-btn');
  await page.waitForSelector('#cctv-snapshot-preview[open]');
  await page.click('[data-action="ask"]');
  await page.type(
    '.snapshot-question',
    'Describe only the invented blue drawing.',
  );
  await page.click('[data-action="send"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('.snapshot-answer')
        ?.textContent.includes('Synthetic test answer'),
    { timeout: 15000 },
  );
  await page.screenshot({ path: path.join(root, 'snapshot-sol-high.png') });
  record(
    'snapshot and explicit original-only Sol/high Q&A work against mock API',
  );
  await page.click('#cctv-snapshot-preview [data-action="close"]');
  await page.close();
  page = await browser.newPage();
  await page.emulate({
    viewport: {
      width: 390,
      height: 844,
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
    },
    userAgent: 'SyntheticMobileQA',
  });
  await page.setRequestInterception(true);
  page.on('request', fixtureRequest);
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() =>
    document.body.classList.contains('mobile-map-first'),
  );
  await page.waitForFunction(
    () => !document.querySelector('#loading-screen') || getComputedStyle(document.querySelector('#loading-screen')).pointerEvents === 'none',
    { timeout: 60000 },
  );
  await page.tap('#mobile-menu-open');
  await page.waitForSelector('#mobile-map-menu[open]');
  await page.screenshot({ path: path.join(root, 'mobile-menu.png') });
  await page.tap('#mobile-menu-close');
  assert.equal(await page.$eval('#mobile-map-menu', (el) => el.open), false);
  record('mobile menu closes and returns to map');
  await page.evaluate(async () => {
    const manager = window.__godsEyeView.dataManager;
    await manager.setEnabled('cctv', true);
    manager.layers.get('cctv').module.selectCamera('synthetic-1');
  });
  await page.waitForFunction(
    () => !document.querySelector('#mobile-camera-return').hidden,
  );
  await page.tap('#mobile-camera-return');
  await page.waitForFunction(() => document.body.classList.contains('mobile-camera-open'));
  await page.screenshot({ path: path.join(root, 'mobile-camera.png') });
  await page.tap('#mobile-camera-fullscreen');
  await page.waitForSelector('#mobile-camera-expanded[open]');
  assert.equal(await page.$eval('#cesium-credits', (el) => !!el.closest('#mobile-camera-expanded')), true);
  await page.screenshot({ path: path.join(root, 'mobile-fullscreen.png') });
  await page.tap('#mobile-camera-fullscreen');
  await page.waitForFunction(() => !document.querySelector('#mobile-camera-expanded').open);
  record('mobile fullscreen or modal fallback preserves credits and returns');
  await page.tap('#cctv-close-btn');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('cctv').module.getUIState()
        .activeCameraId === null,
  );
  record('Close deselects camera without disabling catalog');
  assert.equal(errors.length, 0, JSON.stringify(errors));
  await fs.writeFile(
    path.join(root, 'results.json'),
    JSON.stringify(
      {
        pass: true,
        checks,
        pageErrors: errors,
        fixtureOnly: true,
        browserVersion: await browser.version(),
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (page && !page.isClosed()) {
    await page
      .screenshot({ path: path.join(root, 'failure.png') })
      .catch(() => {});
    await fs
      .writeFile(
        path.join(root, 'failure-dom.json'),
        JSON.stringify(
          await page.evaluate(() => ({
            dialogs: [...document.querySelectorAll('dialog')].map((d) => ({
              id: d.id,
              open: d.open,
            })),
            bodyClasses: document.body.className,
            locate: document.querySelector('#locate-me-status')?.textContent,
            active: document.activeElement?.id,
            width: innerWidth,
          })),
          null,
          2,
        ),
      )
      .catch(() => {});
  }
  await fs.writeFile(
    path.join(root, 'results.json'),
    JSON.stringify(
      {
        pass: false,
        checks,
        pageErrors: errors,
        failure: error.message,
        fixtureOnly: true,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser.close();
}
