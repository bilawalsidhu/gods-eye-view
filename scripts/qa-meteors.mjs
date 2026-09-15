import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const url = process.env.GEV_QA_URL || 'http://127.0.0.1:4173';
const output = 'qa-shots/meteors';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  args: [
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
try {
  await page.setViewport({ width: 1440, height: 1000, deviceScaleFactor: 1 });
  let feedMode = 'live';
  await page.setRequestInterception(true);
  page.on('request', (req) =>
    req.interceptResolutionState().action === 'disabled'
      ? undefined
      : req.url().endsWith('/api/meteors') && feedMode !== 'live'
        ? req.respond({
            status: feedMode === 'empty' ? 200 : 502,
            contentType: 'application/json',
            body:
              feedMode === 'empty'
                ? JSON.stringify({
                    records: [],
                    totalCount: 0,
                    generatedAt: Date.now(),
                    fetchedAt: Date.now(),
                    stale: false,
                    limited: false,
                    rejectedCount: 0,
                    timeFrom: null,
                    timeTo: null,
                  })
                : '{}',
          })
        : req.continue(),
  );
  await page.goto(`${url}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 60000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 60000,
  });
  await new Promise((resolve) => setTimeout(resolve, 4000));
  feedMode = 'fail';
  await page.$eval('[data-layer-id="meteors"] .data-toggle-btn', (el) =>
    el.click(),
  );
  await page.waitForFunction(() => {
    const entry = window.__godsEyeView.dataManager.layers.get('meteors');
    return entry.enabled && entry.module.getStats().error;
  });
  assert.equal(await page.$eval('.gev-meteor-card', (el) => el.hidden), false);
  assert.match(
    await page.$eval('.meteor-overview', (el) => el.textContent),
    /temporarily unavailable/,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('meteors', false, {
      origin: 'user',
    }),
  );
  feedMode = 'live';
  await page.setRequestInterception(false);
  await page.$eval('[data-layer-id="meteors"] .data-toggle-btn', (el) =>
    el.click(),
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers.get('meteors').module.getStats()
        .count > 0,
    { timeout: 60000 },
  );
  const stats = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers.get('meteors').module.getStats(),
  );
  assert.ok(stats.count > 0, JSON.stringify(stats));
  assert.equal(stats.error, null, 'retry clears the acquisition error');
  await page.waitForSelector(
    '.gev-meteor-card:not([hidden]) .meteor-overview:not([hidden])',
  );
  assert.match(
    await page.$eval('.meteor-overview', (el) => el.textContent),
    /not live/,
  );
  assert.equal(
    await page.$$eval('.meteor-event', (els) => els.length),
    Math.min(4, stats.count),
  );
  await page.screenshot({ path: `${output}/overview.png` });
  await page.click('.meteor-primary');
  await page.waitForSelector('.meteor-detail:not([hidden])');
  await new Promise((resolve) => setTimeout(resolve, 3500));
  assert.match(
    await page.$eval('.gev-meteor-card', (el) => el.textContent),
    /Global Meteor|GLOBAL METEOR/,
  );
  assert.match(
    await page.$eval('.gev-meteor-card', (el) => el.textContent),
    /WGS84/,
  );
  await page.screenshot({ path: `${output}/desktop.png` });
  const shareUrl = page.url();

  // A real click must select the fitted atmospheric geometry, not the ground below it.
  const geometry = await page.evaluate(async () => {
    const { viewer } = window.__godsEyeView;
    const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
    const source = viewer.dataSources.getByName('meteors')[0];
    const entity = source.entities.values.find(
      (e) => e.polyline.width.getValue() === 5,
    );
    const positions = entity.polyline.positions.getValue();
    const p = Cesium.Cartesian3.midpoint(
      positions[0],
      positions[1],
      new Cesium.Cartesian3(),
    );
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(
      viewer.scene,
      p,
    );
    return {
      heights: positions.map(
        (v) => Cesium.Cartographic.fromCartesian(v).height,
      ),
      arcType: entity.polyline.arcType.getValue(),
      x: screen.x,
      y: screen.y,
      id: entity.id.slice(7),
      records: source.entities.values.filter((e) => e.id.startsWith('meteor:'))
        .length,
      shown: source.entities.values.filter(
        (e) => e.id.startsWith('meteor:') && e.show,
      ).length,
      annotations: source.entities.values.filter((e) =>
        e.id.startsWith('meteor-guide-'),
      ).length,
    };
  });
  assert.ok(
    geometry.heights.every((h) => h > 1000),
    'must not clamp to ground',
  );
  assert.equal(geometry.arcType, 0, 'straight fitted segment, no geodesic arc');
  assert.equal(geometry.shown, 1, 'exploration isolates one observation');
  assert.equal(geometry.annotations, 2, 'endpoint altitude guides are present');
  await page.click('.meteor-close');
  assert.equal(await page.$eval('.meteor-detail', (el) => el.hidden), true);
  // Wait for Cesium to apply the selection style before sending a real click.
  const pickedPoint = await page.waitForFunction(
    async (id) => {
      const { viewer } = window.__godsEyeView;
      const Cesium = await import('/node_modules/cesium/Build/Cesium/index.js');
      const entity = viewer.dataSources
        .getByName('meteors')[0]
        .entities.getById(`meteor:${id}`);
      const positions = entity.polyline.positions.getValue();
      const midpoint = Cesium.Cartesian3.midpoint(
        positions[0],
        positions[1],
        new Cesium.Cartesian3(),
      );
      const point = Cesium.SceneTransforms.worldToWindowCoordinates(
        viewer.scene,
        midpoint,
      );
      viewer.scene.requestRender();
      if (!point) return false;
      const picked = viewer.scene.pick(point);
      return picked?.id?.id === `meteor:${id}`
        ? { x: point.x, y: point.y }
        : false;
    },
    { timeout: 15000, polling: 100 },
    geometry.id,
  );
  const clickPoint = await pickedPoint.jsonValue();
  await page.mouse.click(Math.round(clickPoint.x), Math.round(clickPoint.y), {
    delay: 60,
  });
  await page.waitForSelector('.meteor-detail:not([hidden])');
  assert.equal(
    await page.$eval('.meteor-id', (el) => el.textContent),
    geometry.id,
  );

  await page.click('.meteor-play');
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(
    await page.evaluate(
      () =>
        !!window.__godsEyeView.viewer.dataSources
          .getByName('meteors')[0]
          .entities.getById('meteor-replay-dot'),
    ),
    true,
  );
  await page.click('.meteor-play');
  await page.$eval('.meteor-progress', (el) => {
    el.value = '500';
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const scrub = await page.evaluate(async () => {
    const C = await import('/node_modules/cesium/Build/Cesium/index.js');
    const source =
      window.__godsEyeView.viewer.dataSources.getByName('meteors')[0];
    const e = source.entities.values.find(
      (e) => e.id.startsWith('meteor:') && e.polyline.width.getValue() === 5,
    );
    const positions = e.polyline.positions.getValue();
    return C.Cartesian3.distance(
      C.Cartesian3.midpoint(...positions, new C.Cartesian3()),
      source.entities.getById('meteor-replay-dot').position.getValue(),
    );
  });
  assert.ok(
    scrub < 0.01,
    'scrubbing to halfway places the meteor at the fitted midpoint',
  );
  await page.screenshot({ path: `${output}/replay.png` });
  assert.equal(
    await page.evaluate(async () =>
      (await import('/src/renderGovernor.js'))
        .getRenderGovernorDiagnostics()
        .holds.includes('meteor-replay'),
    ),
    false,
  );
  await page.click('.meteor-play');
  await page.waitForFunction(
    () => document.querySelector('.meteor-progress').value === '1000',
    { timeout: 12000 },
  );
  assert.equal(
    await page.evaluate(async () =>
      (await import('/src/renderGovernor.js'))
        .getRenderGovernorDiagnostics()
        .holds.includes('meteor-replay'),
    ),
    false,
  );
  await page.$eval('.meteor-context input', (el) => el.click());
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources
          .getByName('meteors')[0]
          .entities.values.filter((e) => e.id.startsWith('meteor:') && e.show)
          .length,
    ),
    stats.count,
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('meteors', false, {
      origin: 'user',
    }),
  );
  assert.equal(await page.$eval('.gev-meteor-card', (el) => el.hidden), true);
  assert.equal(
    await page.evaluate(
      () =>
        !!window.__godsEyeView.viewer.dataSources
          .getByName('meteors')[0]
          .entities.getById('meteor-replay-dot'),
    ),
    false,
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.dataManager.setEnabled('meteors', true, { origin: 'user' });
    app.dataManager.layers
      .get('meteors')
      .module.getRowControls()
      .chips[0].onClick();
  });
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  assert.equal(
    await page.$eval('.gev-meteor-card', (el) => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.bottom <= innerHeight;
    }),
    true,
  );
  await page.screenshot({ path: `${output}/mobile.png` });
  await page.click('.meteor-minimize');
  assert.equal(
    await page.$eval('.meteor-minimize', (el) =>
      el.getAttribute('aria-expanded'),
    ),
    'false',
  );
  assert.ok(
    await page.$eval(
      '.gev-meteor-card',
      (el) => el.getBoundingClientRect().height < 100,
    ),
  );
  await page.click('.meteor-minimize');

  // A failed refresh must retain the last accepted data and visibly mark it stale.
  await page.setRequestInterception(true);
  feedMode = 'fail';
  const failure = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('meteors').module;
    const before = layer.getStats().count;
    await layer.update(app.viewer);
    return { before, ...layer.getStats() };
  });
  assert.equal(failure.count, failure.before);
  assert.equal(failure.stale, true);
  assert.match(
    await page.$eval('.meteor-status', (el) => el.textContent),
    /STALE/,
  );
  feedMode = 'empty';
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('meteors')
      .module.update(window.__godsEyeView.viewer),
  );
  assert.match(
    await page.$eval('.meteor-overview', (el) => el.textContent),
    /No reconstructed meteors/,
  );
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.viewer.dataSources.getByName('meteors')[0].entities
          .values.length,
    ),
    0,
  );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify({
      status: 'passed',
      liveTrajectories: stats.count,
      geometry,
      failureRetained: failure.count,
      shareUrl,
      screenshots: output,
    }),
  );
} catch (error) {
  console.error('Page errors:', errors);
  throw error;
} finally {
  await browser.close();
}
