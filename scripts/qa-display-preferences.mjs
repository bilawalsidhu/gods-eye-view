/** Browser acceptance for locally saved Display choices across fresh starts. */
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';
import { mkdir, writeFile } from 'node:fs/promises';

const base = process.env.QA_BASE_URL || 'http://127.0.0.1:4187';
const output = process.env.QA_SCREENSHOT_DIR || 'qa-shots/display-preferences';
await mkdir(output, { recursive: true });
const browser = await puppeteer.launch({
  headless: true,
  args:
    process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const load = async (suffix = '') => {
    await page.goto(`${base}/?welcome=0${suffix}`, {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.styleManager &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 60000 },
    );
  };
  const state = () =>
    page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      return {
        hud: manager.hud.getVariant(),
        sonar: manager.getControlState().hud.sonar,
        visual: manager.getVisualState(),
        saved: JSON.parse(localStorage.getItem('gev:display-preferences:v1')),
        imagery: Array.from(
          { length: manager.viewer.imageryLayers.length },
          (_, i) =>
            manager.viewer.imageryLayers.get(i).imageryProvider.url || '',
        ),
      };
    });
  console.log('Loading display preferences test');
  await load();
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setHudLayout('cyber'),
  );
  await page.click('.gev-panel-rail--right button');
  await page.waitForSelector('#cyber-sonar-toggle', { visible: true });
  if ((await state()).sonar.enabled) await page.click('#cyber-sonar-toggle');
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setCyberSonar({ rings: 5, rangePct: 80, sectorDeg: 30 });
    manager.setBloom({ enabled: true, intensityPct: 32 });
    manager.setDetection({ enabled: false, densityPct: 25 });
  });
  const before = await state();
  assert.equal(before.saved.sonar.enabled, false);
  assert.equal(before.saved.hudVariant, 'cyber');
  await load();
  console.log('Reloaded display preferences');
  const after = await state();
  assert.equal(after.hud, 'cyber');
  assert.equal(after.sonar.enabled, false);
  assert.equal(after.sonar.rings, 5);
  assert.equal(after.sonar.rangePct, 80);
  assert.equal(after.visual.bloom.enabled, true);
  assert.equal(after.visual.bloom.intensity, before.visual.bloom.intensity);
  assert.equal(after.visual.detection.mode, 'OFF');
  assert.equal(after.visual.detection.density, 25);
  await page.screenshot({ path: `${output}/restored-display.png` });
  await page.evaluate(() =>
    window.__godsEyeView.styleManager._setMapStack('osm'),
  );
  await load();
  await page.waitForFunction(
    () =>
      window.__godsEyeView.styleManager.mapStackController.getActiveId() ===
      'osm',
    { timeout: 60000 },
  );
  await load('#lat=40&lon=-75&alt=150000&hud=cyber&map=osm&style=normal');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.hud.getVariant() === 'cyber',
    { timeout: 15000 },
  );
  assert.equal((await state()).sonar.enabled, false);
  const result = {
    passed: true,
    before,
    after,
    errors,
  };
  await writeFile(`${output}/result.json`, JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      passed: true,
      errors,
    }),
  );
} finally {
  await browser.close();
}
