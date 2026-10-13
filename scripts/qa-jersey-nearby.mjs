#!/usr/bin/env node
/** Real standalone phone layout proof. Run against a keyless local QA server. */
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://127.0.0.1:4185';
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-dev-shm-usage',
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') console.log('browser:', msg.text().slice(0, 400));
});
page.on('pageerror', (e) => errors.push(e.message));
try {
  await page.setViewport({
    width: 390,
    height: 844,
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  await browser
    .defaultBrowserContext()
    .overridePermissions(origin, ['geolocation']);
  await page.setGeolocation({
    latitude: 49.185,
    longitude: -2.107,
    accuracy: 10,
  });
  await page.goto(
    origin + '/#v=2&lat=49.185&lon=-2.107&alt=1800&pitch=-70&map=esri-imagery',
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForSelector('#gev-jersey-nearby', { timeout: 60000 });
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gev-mobile-nearby')
        ?.textContent.includes('Your location'),
    { timeout: 30000 },
  );
  assert.equal(
    await page.$$eval(
      '[aria-label="Jersey parish or whole island"] option',
      (nodes) => nodes.length,
    ),
    14,
  );
  await page.select(
    'select[aria-label="Jersey parish or whole island"]',
    'St Helier',
  );
  await page.click('button[aria-label="Parking"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gev-jersey-cards')
        ?.textContent.includes('Parking · nearest results'),
    { timeout: 30000 },
  );
  const count = await page.evaluate(
    () =>
      window.__godsEyeView.viewer.dataSources.getByName('Jersey parking')[0]
        .entities.values.length,
  );
  assert.ok(count > 0, 'Parking map markers');
  await page.click('button[aria-label="Close Around you"]');
  assert.equal(
    await page.evaluate(() =>
      document
        .querySelector('#gev-mobile-nearby')
        .hasAttribute('data-gev-mobile-open'),
    ),
    false,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources.getByName('Jersey parking')[0]
          .entities.values.length,
    ),
    count,
    'Dismiss retains enabled map markers',
  );
  await page.click('#gev-mobile-nav [data-panel="gev-mobile-nearby"]');
  await page.click('button[aria-label="Parking"]');
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources.getByName('Jersey parking')[0]
          .entities.values.length,
    ),
    0,
    'Off clears markers',
  );
  await page.click('button[aria-label="Transport"]');
  await page.waitForFunction(
    () =>
      window.__godsEyeView.viewer.dataSources.getByName(
        'Jersey live transport',
      )[0].entities.values.length > 0,
    { timeout: 30000 },
  );
  await page.click('button[aria-label="Roadworks"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gev-jersey-cards')
        ?.textContent.includes('Roadworks · nearest results'),
    { timeout: 30000 },
  );
  await page.select(
    'select[aria-label="Jersey parish or whole island"]',
    'all',
  );
  assert.equal(
    await page.$eval('select[aria-label="Nearby radius"]', (el) => el.value),
    '50000',
  );
  await page.click('button[aria-label="Weather"]');
  await page.waitForFunction(
    () =>
      document
        .querySelector('#gev-jersey-cards')
        ?.textContent.includes('Jersey weather'),
    { timeout: 30000 },
  );
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    open: document.querySelectorAll('[data-gev-mobile-open]').length,
    nav: getComputedStyle(document.querySelector('#gev-mobile-nav')).display,
  }));
  assert.equal(layout.overflow, false, 'No sideways page overflow');
  assert.equal(layout.open, 1);
  assert.equal(layout.nav, 'grid');
  await mkdir('qa-shots', { recursive: true });
  await page.screenshot({ path: 'qa-shots/jersey-phone-nearby.png' });
  await page.setViewport({
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
  });
  await page.waitForFunction(
    () => !document.body.classList.contains('gev-mobile-ui'),
  );
  assert.equal(
    await page.$eval(
      '#gev-mobile-nearby',
      (el) => getComputedStyle(el).display,
    ),
    'none',
    'Desktop custom sheet stays hidden',
  );
  const serious = errors.filter(
    (e) => !e.includes('Failed to fetch') && !e.includes('NetworkError'),
  );
  assert.deepEqual(serious, []);
  console.log(
    JSON.stringify({
      pass: true,
      parkingMarkers: count,
      layout,
      screenshot: 'qa-shots/jersey-phone-nearby.png',
      checks: [
        'GPS',
        '12 parishes',
        'toggle on/off',
        'dismiss retains layers',
        'live transport',
        'roadworks',
        'weather',
        'island-wide',
        'phone layout',
        'desktop unchanged',
      ],
    }),
  );
} catch (error) {
  console.log('page errors:', JSON.stringify(errors));
  console.log(
    await page.evaluate(() => ({
      ready: !!window.__godsEyeView,
      cesium: !!window.Cesium,
      body: document.body.innerText.slice(0, 600),
      mobile: !!document.querySelector('#gev-mobile-nav'),
    })),
  );
  await mkdir('qa-shots', { recursive: true });
  await page.screenshot({ path: 'qa-shots/jersey-phone-failure.png' });
  throw error;
} finally {
  await browser.close();
}
