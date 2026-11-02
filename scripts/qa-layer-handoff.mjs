import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';

const url = new URL(process.argv[2]);
if (
  !['localhost', '127.0.0.1'].includes(url.hostname) ||
  ['', '4173', '4185', '4186', '4187', '4188', '4189', '4194'].includes(
    url.port,
  )
)
  throw new Error('Supply an unreserved local keyless preview URL');
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&lat=40.2539&lon=-125.5779&alt=21130&heading=360&pitch=-35&map=sentinel2&l=f&lo=f.e.1_f.t.71be26';
const browser = await puppeteer.launch({
  headless: true,
  args: ['--use-angle=metal', '--enable-gpu'],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(() => {
    const fetch = window.fetch.bind(window);
    window.__flightPolls = 0;
    window.fetch = (input, options) => {
      const path = new URL(input.url ?? input, document.baseURI).pathname;
      const now = Math.floor(Date.now() / 1000);
      if (path === '/api/flights') {
        window.__flightPolls++;
        return Promise.resolve(
          Response.json({
            time: now,
            states: [
              [
                '71be26',
                'GEV123',
                'QA',
                now,
                now,
                -125.5779,
                40.2539,
                9700,
                false,
                200,
                45,
                0,
                null,
                9700,
                null,
                false,
                0,
              ],
            ],
          }),
        );
      }
      if (path === '/api/military')
        return Promise.resolve(Response.json({ now: Date.now(), ac: [] }));
      if (path === '/api/flights/track')
        return Promise.resolve(Response.json({ path: [] }));
      if (path.startsWith('/api/flights/') || path.startsWith('/api/openai/'))
        return Promise.resolve(Response.json({}));
      return fetch(input, options);
    };
  });
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  const ready = (kind) =>
    page.waitForFunction(
      (engine) =>
        window.__godsEyeView?.engine.kind === engine &&
        !document.querySelector('#globe-engine')?.disabled &&
        document.querySelector('#loading-screen.hidden') &&
        !document.querySelector('.engine-switch-frame'),
      { timeout: 90000 },
      kind,
    );
  await ready('navara');
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.waitForSelector('#cockpit-entry', { visible: true });
  await page.click('#cockpit-entry');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.getCockpitState().active,
  );
  await page.evaluate(() => {
    const { dataManager, styleManager, tileset } = window.__godsEyeView;
    if (window.__GOOGLE_MAPS_API_KEY__ || tileset)
      throw Error('Keyless preview required');
    styleManager.cockpitView.setVisionMode('thermal');
    const entry = dataManager.layers.get('flights');
    window.__handoff = {
      dataManager,
      entry,
      timer: entry.intervalId,
      model: entry.module,
      pollCount: window.__flightPolls,
      timestamp: entry.module.getStats().lastUpdate,
      started: Date.now(),
    };
  });
  // Refuse the first Cesium canvas. The application must roll back with the
  // original aircraft still in the cockpit, then allow an ordinary retry.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).includes('webgl')) {
        window.__refusedContext = true;
        throw new Error('QA renderer startup failure');
      }
      return original.call(this, type, ...args);
    };
    window.__restoreContext = () => {
      HTMLCanvasElement.prototype.getContext = original;
    };
  });
  await page.select('#globe-engine', 'cesium');
  await page.waitForFunction(() => window.__refusedContext === true);
  await ready('navara');
  assert.ok(await page.evaluate(() => {
    window.__restoreContext();
    const {dataManager, styleManager} = window.__godsEyeView;
    return new URL(location.href).searchParams.get('engine') === 'navara' &&
      dataManager === window.__handoff.dataManager &&
      dataManager.layers.get('flights') === window.__handoff.entry &&
      styleManager.getCockpitState().active &&
      styleManager.getAircraftTrackingTarget()?.id === '71be26';
  }), 'a failed scene must leave the live session usable');
  console.log('PASS failed renderer rolled back to the same flight and cockpit');

  for (const kind of ['cesium', 'navara']) {
    await page.select('#globe-engine', kind);
    await ready(kind);
    const result = await page.evaluate(() => {
      const { dataManager, engine, styleManager } = window.__godsEyeView;
      const before = window.__handoff;
      const entry = dataManager.layers.get('flights');
      const cockpit = styleManager.getCockpitState();
      return {
        sameOwner:
          before.dataManager === dataManager &&
          before.entry === entry &&
          before.model === entry.module,
        sameTimer:
          before.timer === entry.intervalId && entry.intervalId != null,
        sourcePolls: window.__flightPolls - before.pollCount,
        elapsed: Date.now() - before.started,
        stamp: entry.module.getStats().lastUpdate,
        initialStamp: before.timestamp,
        id: cockpit.subject?.id,
        active: cockpit.active,
        mode: cockpit.visionMode,
        hud: !document.querySelector('#cockpit-hud').hidden,
        drawn: entry.module.qaDrawn().some((row) => row.id === '71be26'),
        height: engine.camera.height(),
      };
    });
    assert.ok(
      result.sameOwner &&
        result.sameTimer &&
        result.active &&
        result.hud &&
        result.drawn,
      JSON.stringify(result),
    );
    assert.equal(result.id, '71be26');
    assert.equal(result.mode, 'thermal');
    if (result.elapsed < 30000) {
      assert.equal(result.sourcePolls, 0);
      assert.equal(result.stamp, result.initialStamp);
    }
    await page.waitForFunction(
      () => Math.abs(window.__godsEyeView.engine.camera.height() - 9700) < 1000,
    );
    console.log(
      `PASS ${kind} cockpit, aircraft, HUD, manager and timer (${result.sourcePolls} polls since entry)`,
    );
  }
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.controlCockpit('exit'),
  );
  await page.waitForFunction(
    () => !window.__godsEyeView.styleManager.getCockpitState().active,
  );
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
