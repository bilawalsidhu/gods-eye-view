import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const browser = await puppeteer.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on('request', (request) =>
    request.url() === `${origin}/qa-cctv-discovery`
      ? request.respond({
          contentType: 'text/html',
          body: '<html><body></body></html>',
        })
      : request.continue(),
  );
  await page.goto(`${origin}/qa-cctv-discovery`);
  await page.evaluate(async () => {
    const { CctvControls } = await import('/src/ui/cctvControls.js');
    document.body.innerHTML = await (
      await fetch('/src/ui/templates/layer-panels.html')
    ).text();
    const ids = {
      _cctvPanel: 'cctv-panel',
      _cctvSelect: 'cctv-camera-select',
      _cctvSearch: 'cctv-camera-search',
      _cctvScope: 'cctv-camera-scope',
      _cctvDiscoveryStatus: 'cctv-discovery-status',
      _cctvNextBtn: 'cctv-next-btn',
      _cctvPrevBtn: 'cctv-prev-btn',
      _cctvNearestBtn: 'cctv-nearest-btn',
      _cctvMeta: 'cctv-meta',
    };
    const cameras = [
      {
        id: 'vancouver',
        city: 'Vancouver',
        name: 'Bridge',
        lat: 49,
        lon: -123,
      },
      { id: 'cape', city: 'Cape Town', name: 'Centre', lat: -33.9, lon: 18.4 },
    ];
    window.view = {
      west: 18,
      east: 19,
      south: -34,
      north: -33,
      center: { lat: -33.9, lon: 18.4 },
    };
    window.state = {
      enabled: true,
      cameras,
      activeCameraId: 'vancouver',
      activeCamera: cameras[0],
    };
    window.controls = new CctvControls({
      elements: Object.fromEntries(
        Object.entries(ids).map(([key, id]) => [
          key,
          document.getElementById(id),
        ]),
      ),
      cctv: {
        getUIState: () => window.state,
        selectCamera: (id) => {
          window.selected = id;
          return true;
        },
        focusCamera() {},
      },
      actions: {
        isEnabled: () => true,
        toggleEnabled: async () => true,
        runExplicitFocus: (select) => select(),
        setParams() {},
        setPanelCollapsed() {},
        syncViewport() {},
        readMapView: () => window.view,
        subscribeMapView: (callback) => {
          window.mapMoved = callback;
          return () => {};
        },
      },
    });
    window.controls.connect();
  });
  const options = () =>
    page.$$eval('#cctv-camera-select option', (opts) =>
      opts.map((o) => o.value),
    );
  assert.deepEqual(await options(), ['cape']);
  assert.equal(
    await page.$eval('#cctv-camera-select', (el) => el.selectedIndex),
    -1,
  );
  assert.match(
    await page.$eval('#cctv-meta', (el) => el.textContent),
    /click a camera/,
  );
  await page.type('#cctv-camera-search', 'Vancouver');
  assert.deepEqual(await options(), []);
  await page.select('#cctv-camera-scope', 'all');
  assert.deepEqual(await options(), ['vancouver']);
  await page.select('#cctv-camera-select', 'vancouver');
  assert.equal(await page.evaluate(() => window.selected), 'vancouver');
  await page.$eval('#cctv-camera-search', (el) => {
    el.value = '';
    el.dispatchEvent(new Event('input'));
  });
  await page.select('#cctv-camera-scope', 'view');
  await page.click('#cctv-next-btn');
  assert.equal(await page.evaluate(() => window.selected), 'cape');
  await page.evaluate(() => {
    window.view = { ...window.view, south: 0, north: 1 };
    window.mapMoved();
  });
  assert.deepEqual(await options(), []);
  assert.match(
    await page.$eval('#cctv-discovery-status', (el) => el.textContent),
    /No cameras in map view/,
  );
  assert.equal(await page.$eval('#cctv-next-btn', (el) => el.disabled), true);
  console.log(
    'PASS: real DOM search, scope, selection, local cycling, and map movement',
  );
} finally {
  await browser.close();
}
