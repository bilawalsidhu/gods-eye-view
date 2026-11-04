// Display-only AIS filtering through live row controls and the right-side app.
// QA_BASE_URL=http://localhost:4173 node scripts/qa-vessel-filters.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';

const output = process.env.QA_OUTPUT_DIR || '/tmp/gev-vessel-filters';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({ headless: true });
const results = [];
try {
  const page = await browser.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewport({ width: 1440, height: 950 });
  await page.goto(
    `${process.env.QA_BASE_URL || 'http://localhost:4173'}/?welcome=0#v=2&lat=51.93&lon=4.05&alt=500000&pitch=-90&style=normal&hud=minimal&hv=1&dm=OFF&map=osm&l=`,
    { waitUntil: 'domcontentloaded', timeout: 90000 },
  );
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 90000 },
  );
  const availability = (enabled) =>
    page.waitForFunction(
      (value) =>
        document.getElementById('vessel-panel').hidden === !value &&
        Boolean(document.querySelector('[data-rail-item="vessel-panel"]')) ===
          value,
      {},
      enabled,
    );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled) await app.dataManager.setEnabled(id, false);
  });
  await availability(false);
  await page.evaluate(async () => {
    const app = window.__godsEyeView,
      layer = app.dataManager.layers.get('ais-live-vessels').module;
    layer.update = async () => {};
    await app.dataManager.setEnabled('ais-live-vessels', true);
    app.dataManager.setLayerParams('ais-live-vessels', {
      displayFilters: {
        types: ['CARGO', 'TANKER', 'PASSENGER'],
        minSpeedKn: 0,
        maxSpeedKn: 50,
        declutterEnabled: true,
        underwayOnly: false,
        typeFilterEnabled: false,
        speedFilterEnabled: false,
      },
    });
    app.styleManager.beginLocationNavigation();
    app.viewer.camera.cancelFlight();
    app.viewer.camera.setView({
      destination: app.viewer.camera.position.constructor.fromDegrees(
        4.05,
        51.93,
        500000,
      ),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const types = [71, 80, 30, 35],
      speeds = [0, 10, 20, 30];
    const fixture = Array.from({ length: 400 }, (_, i) => ({
      mmsi: String(990200000 + i),
      name: `QA BOAT ${String(i).padStart(4, '0')}`,
      type: types[i % 4],
      speed: speeds[i % 4],
      lat: 51.93 + (Math.floor(i / 20) - 10) * 0.02,
      lon: 4.05 + ((i % 20) - 10) * 0.02,
      destination: 'ROTTERDAM',
      imo: String(9000000 + i),
      course: 0,
      heading: 0,
    }));
    const result = layer.__focusEvidence.setVessels(fixture);
    if (!result.ok || result.count !== 400) throw new Error('Fixture failed');
    app.styleManager.setPanelCollapsed('data-panel', false, {
      explicit: true,
      persist: false,
    });
    app.viewer.scene.requestRender();
  });
  await availability(true);
  const count = () =>
    page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.__focusEvidence.snapshot()
          .filter((row) => row.show).length,
    );
  const waitCount = async (expected) => {
    await page.waitForFunction(
      (n) =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.__focusEvidence.snapshot()
          .filter((row) => row.show).length === n,
      { timeout: 20000 },
      expected,
    );
    results.push({ expected, actual: await count() });
  };
  await page.waitForFunction(() => {
    const rows = window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.__focusEvidence.snapshot();
    return (
      rows.length === 400 &&
      rows.filter((row) => row.show).length > 0 &&
      rows.filter((row) => row.show).length < 100
    );
  });
  const automatic = await count();
  const chip = (id) =>
    `[data-layer-id="ais-live-vessels"] [data-chip-id="vessel-${id}"]`;
  assert.equal(
    await page.$$eval(
      '[data-layer-id="ais-live-vessels"] [data-chip-id^="vessel-"]',
      (nodes) => nodes.length,
    ),
    5,
  );
  await page.click(chip('declutter'));
  await waitCount(400);
  await page.click(chip('underway'));
  await waitCount(300);
  await page.click(chip('underway'));
  await waitCount(400);
  await page.click(chip('types'));
  await waitCount(200);
  await page.click(chip('types'));
  await waitCount(400);
  await page.click(chip('list'));
  await page.waitForSelector('#vessel-panel:not(.collapsed)');
  await page.waitForFunction(() => {
    const body = document.querySelector('.vessel-panel-body');
    return body.clientHeight > 0 && body.scrollHeight > body.clientHeight;
  });
  await page.click('#vessel-speed-enabled');
  const input = (selector, value) =>
    page.$eval(
      selector,
      (element, text) => {
        element.value = text;
        element.dispatchEvent(new Event('change', { bubbles: true }));
      },
      value,
    );
  await input('#vessel-min-speed', '5');
  await input('#vessel-max-speed', '15');
  await waitCount(100);
  await page.click(chip('speed'));
  await waitCount(400);
  await page.click(chip('speed'));
  await waitCount(100);
  await page.click('#vessel-speed-enabled');
  await waitCount(400);
  await page.click('#vessel-type-enabled');
  await waitCount(200);
  await page.$$eval('[data-vessel-type]', (nodes) => {
    for (const input of nodes) if (input.checked) input.click();
  });
  await waitCount(0);
  await page.click('[data-vessel-type="FISHING"]');
  await waitCount(100);
  await page.click('#vessel-type-enabled');
  await waitCount(400);
  await page.click('#vessel-declutter');
  await waitCount(automatic);
  const roster = await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('ais-live-vessels')
      .module.getVesselList(),
  );
  assert.equal(roster.total, 400);
  assert.equal(roster.matching, 400);
  assert.equal(roster.rows.length, 50);
  assert.equal(roster.pages, 8);
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getAnalystRecords({ limit: 1000 }).length,
    ),
    400,
  );
  await page.mouse.move(700, 200);
  await page.screenshot({ path: `${output}/filters.png` });
  const hidden = await page.evaluate(() => {
    const layer =
      window.__godsEyeView.dataManager.layers.get('ais-live-vessels').module;
    return layer.__focusEvidence.snapshot().find((row) => !row.show).id;
  });
  await page.$eval('#vessel-search', (node) => node.scrollIntoView());
  await page.type('#vessel-search', hidden);
  await page.waitForSelector(`[data-vessel-id="${hidden}"]`);
  await page.click(`[data-vessel-id="${hidden}"]`);
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers
        .get('ais-live-vessels')
        .module.getSelectedInfo()?.mmsi === id,
    {},
    hidden,
  );
  assert.ok(
    await page.evaluate(
      (id) =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.__focusEvidence.snapshot()
          .find((row) => row.id === id).show,
      hidden,
    ),
  );
  await page.screenshot({ path: `${output}/search.png` });
  const prefs = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('gev:vessel-display-filters:v1'))[
        'ais-live-vessels'
      ],
  );
  assert.equal(prefs.types[0], 'FISHING');
  assert.equal(prefs.minSpeedKn, 5);
  assert.equal(prefs.maxSpeedKn, 15);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('ais-live-vessels', false),
  );
  await availability(false);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('ais-live-vessels', true),
  );
  await availability(true);
  assert.equal(
    await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers
          .get('ais-live-vessels')
          .module.getParams().displayFilters.types[0],
    ),
    'FISHING',
  );
  assert.deepEqual(errors, []);
  const report = {
    automatic,
    retained: 400,
    results,
    hiddenSelection: hidden,
    availability: 'off/on/off/on verified',
    errors,
  };
  await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  // Chromium can exit while inherited stdio keeps Puppeteer's close pending.
  // Bound teardown without swallowing an assertion failure from the test body.
  let timeout;
  try {
    await Promise.race([
      browser.close(),
      new Promise((resolve) => {
        timeout = setTimeout(resolve, 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
    await browser.disconnect();
    const child = browser.process();
    if (child?.exitCode === null) child.kill('SIGKILL');
    for (const pipe of child?.stdio || []) pipe?.destroy?.();
  }
}
