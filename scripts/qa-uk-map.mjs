/** UK overlay browser gate. Public-feed fixtures are confined to this new browser. */
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { UK_FEEDS } from '../src/regional/ukCatalog.js';

const args = process.argv.slice(2);
const url = new URL(args[args.indexOf('--url') + 1] || 'http://127.0.0.1:4173');
url.searchParams.set('welcome', '0');
url.hash = 'v=2&lat=54.6&lon=-3.3&alt=1100000&pitch=-90&sc=0&l=';
const browser = await puppeteer.launch({
  headless: true,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
let checks = 0;
const check = (name, condition) => {
  assert.ok(condition, name);
  checks++;
  console.log(`PASS ${name}`);
};
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [],
    requested = new Set();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    let body;
    if (path === '/api/cctv/sources') {
      requested.add('cameras');
      body = {
        sources: [
          {
            id: 'gateshead-qa',
            cityId: 'gateshead',
            city: 'Gateshead',
            name: 'QA camera',
            provider: 'QA fixture',
            lat: 54.96,
            lon: -1.6,
          },
        ],
      };
    } else if (path.startsWith('/api/uk-data/')) {
      const id = path.split('/').pop();
      requested.add(id);
      const i = UK_FEEDS.findIndex((f) => f.id === id);
      body = {
        status:
          id === 'ni-events'
            ? 'unavailable'
            : id === 'sepa-rivers'
              ? 'stale'
              : 'available',
        retrievedAt: '2026-10-14T10:00:00Z',
        message:
          id === 'ni-events' ? 'QA provider outage, not an all-clear' : '',
        rows:
          id === 'ni-events'
            ? []
            : [0, 1].map((n) => ({
                id: `${id}-${n}`,
                name: `QA ${id} ${n}`,
                details: 'Fixture observation',
                time: '2026-10-14T09:00:00Z',
                ...(['ea-floods', 'london-rail'].includes(id)
                  ? {}
                  : { lat: 50.8 + i * 0.65, lon: -5 + (i % 5) + n * 0.12 }),
              })),
      };
    } else if (path === '/api/overpass') requested.add('places');
    if (body)
      void request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body),
      });
    else void request.continue();
  });
  const mapPoints = () =>
    page.evaluate(() => {
      const primitives = window.__godsEyeView.viewer.scene.primitives;
      let count = 0;
      for (let i = 0; i < primitives.length; i++) {
        const p = primitives.get(i);
        if (
          p.constructor.name === 'PointPrimitiveCollection' &&
          p.length &&
          p.get(0).id?.sourceId
        )
          count += p.length;
      }
      return count;
    });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.uk-data-launch', {
    visible: true,
    timeout: 90000,
  });
  check(
    'disabled map layers do not fetch UK data before a user enables them',
    [...requested].every((id) => id === 'cameras'),
  );
  await page.click('.uk-data-launch');
  await page.waitForSelector('.uk-data-results article', { timeout: 30000 });
  await page.click('.uk-data-panel > .uk-data-actions button:first-child');
  await page.waitForFunction(
    () => {
      const text = document.querySelector('.uk-map-summary').textContent;
      return (
        text.startsWith('13 feeds on') &&
        text.includes('0 loading') &&
        text.includes('19 map points')
      );
    },
    { timeout: 45000 },
  );
  check(
    'all registered feeds load together without the nearby-place query',
    requested.size === 13 && !requested.has('places'),
  );
  check(
    'real point collections contain every fixture coordinate, without guessed locations',
    (await mapPoints()) === 19,
  );
  check(
    'outages and original retrieval times remain visible',
    await page.$eval(
      '.uk-map-summary',
      (e) =>
        e.textContent.includes('1 unavailable') &&
        e.textContent.includes('1 previous retrievals') &&
        e.textContent.includes('4 records have no coordinates'),
    ),
  );
  await page.click('.uk-data-panel header button');
  check(
    'closing the browser retains saved map points',
    (await mapPoints()) === 19,
  );
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const target = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer,
      primitives = viewer.scene.primitives;
    for (let i = 0; i < primitives.length; i++) {
      const p = primitives.get(i);
      if (p.constructor.name !== 'PointPrimitiveCollection') continue;
      for (let j = 0; j < p.length; j++) {
        const point = p.get(j);
        if (!point.id?.sourceId) continue;
        const xy = viewer.scene.cartesianToCanvasCoordinates(point.position);
        if (
          !xy ||
          xy.x < 260 ||
          xy.y < 180 ||
          xy.x > innerWidth - 100 ||
          xy.y > innerHeight - 200
        )
          continue;
        if (document.elementFromPoint(xy.x, xy.y)?.tagName !== 'CANVAS')
          continue;
        const picked = viewer.scene.pick(xy)?.id;
        if (picked?.sourceId)
          return {
            x: xy.x,
            y: xy.y,
            sourceId: picked.sourceId,
            name: picked.row.name,
          };
      }
    }
    return null;
  });
  check(
    'a visible point can be picked on the actual Cesium canvas',
    Boolean(target),
  );
  await page.mouse.click(target.x, target.y);
  await page.waitForFunction(
    () => !document.querySelector('.uk-data-panel').hidden,
    { timeout: 10000 },
  );
  check(
    'picking a map point opens its own source and record',
    (await page.$eval('.uk-data-toolbar select', (e) => e.value)) ===
      target.sourceId &&
      (await page.$eval('.uk-data-toolbar input', (e) => e.value)) ===
        target.name,
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.uk-map-badge', {
    visible: true,
    timeout: 90000,
  });
  await page.waitForFunction(
    () =>
      document.querySelector('.uk-map-badge').textContent.includes('19 points'),
    { timeout: 45000 },
  );
  check(
    'saved layers restore on reload with the data browser closed',
    (await page.$eval('.uk-data-panel', (e) => e.hidden)) &&
      (await mapPoints()) === 19,
  );
  await page.click('.uk-map-badge');
  await page.evaluate(() =>
    window.__godsEyeView.viewer.entities.add({ id: 'qa-unrelated-entity' }),
  );
  await page.click('.uk-data-panel > .uk-data-actions button:nth-child(2)');
  check(
    'hiding UK data removes its collections and clears the saved switches',
    (await mapPoints()) === 0 &&
      (await page.evaluate(
        () => localStorage.getItem('gev:uk-map-sources:v1') === '[]',
      )),
  );
  check(
    'hiding UK data preserves unrelated entities',
    await page.evaluate(() =>
      Boolean(
        window.__godsEyeView.viewer.entities.getById('qa-unrelated-entity'),
      ),
    ),
  );
  await page.setViewport({ width: 390, height: 844 });
  check(
    'the source controls fit a phone viewport',
    await page.$eval(
      '.uk-data-panel',
      (e) =>
        e.scrollWidth <= e.clientWidth + 1 &&
        e.getBoundingClientRect().width <= 390,
    ),
  );
  check(
    'map workflows produce no unhandled browser errors',
    errors.length === 0,
  );
  await fs.mkdir('qa-artifacts/uk-map', { recursive: true });
  await page.screenshot({ path: 'qa-artifacts/uk-map/controls.png' });
  console.log(`RESULT: ${checks} passed`);
} finally {
  await browser.close();
}
