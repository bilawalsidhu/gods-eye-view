#!/usr/bin/env node
/** Rendered acceptance for style transitions and effect-state ownership. */
import fs from 'node:fs';
import puppeteer from 'puppeteer';

const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
let failures = 0;
function check(name, passed) {
  console.log(`[${passed ? 'PASS' : 'FAIL'}] ${name}`);
  if (!passed) failures++;
}
try {
  await page.setViewport({ width: 1440, height: 900 });
  const url = new URL(process.env.QA_BASE_URL || 'http://127.0.0.1:4173');
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.styleManager?._visualEffects &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 60_000 },
  );
  await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.scene.tweens?.removeAll?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (-97.7431 * Math.PI) / 180,
        latitude: (30.2568 * Math.PI) / 180,
        height: 1200,
      }),
      orientation: { heading: 0, pitch: -0.85, roll: 0 },
    });
    viewer.scene.requestRender();
  });
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  const settled = await page
    .waitForFunction(
      () => {
        const primitives = window.__godsEyeView.viewer.scene.primitives;
        for (let i = 0; i < primitives.length; i++) {
          const primitive = primitives.get(i);
          if (
            typeof primitive.tilesLoaded === 'boolean' &&
            !primitive.tilesLoaded
          )
            return false;
        }
        return true;
      },
      { timeout: 60_000 },
    )
    .then(
      () => true,
      () => false,
    );
  check('visible tile content settles before visual captures', settled);
  fs.mkdirSync('qa-shots/visual-effects', { recursive: true });
  for (const style of [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
    'snow',
    'normal',
  ]) {
    await page.evaluate(
      (name) => window.__godsEyeView.styleManager.setStyle(name),
      style,
    );
    await page.waitForFunction(
      () => window.__godsEyeView.styleManager.transitions.size === 0,
      { timeout: 10_000 },
    );
    const state = await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const effects = manager._visualEffects;
      const visible = Object.entries(effects.stages)
        .filter(([, stage]) => stage.enabled)
        .map(([name]) => name);
      const animated = Object.values(effects.stages).some(
        (stage) =>
          stage.enabled &&
          stage.uniforms.time !== undefined &&
          stage.uniforms.intensity > 0.001,
      );
      return {
        active: manager.activeStyle,
        visible,
        clock: effects.frameId !== null,
        animated,
      };
    });
    check(
      `${style}: only the selected style remains visible`,
      state.active === style &&
        JSON.stringify(state.visible) ===
          JSON.stringify(style === 'normal' ? [] : [style]),
    );
    check(
      `${style}: the animation clock follows visible animated stages`,
      state.clock === state.animated,
    );
    if (['normal', 'surveillance', 'thermal'].includes(style)) {
      await page.screenshot({ path: `qa-shots/visual-effects/${style}.png` });
      if (style === 'surveillance')
        await page.evaluate(() =>
          window.__godsEyeView.viewer.camera.lookRight(0.2),
        );
    }
  }
  await page.evaluate(() => {
    const manager = window.__godsEyeView.styleManager;
    manager.setStyle('noir');
    manager.setStyle('retro');
    manager.setStyle('normal');
  });
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.transitions.size === 0,
    { timeout: 10_000 },
  );
  check(
    'rapid switches settle to Normal without an old style or clock',
    await page.evaluate(() => {
      const effects = window.__godsEyeView.styleManager._visualEffects;
      return (
        effects.frameId === null &&
        Object.values(effects.stages).every((stage) => !stage.enabled)
      );
    }),
  );
  check(
    'bloom actions, effect state and saved snapshot agree',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const result = manager.setBloom({ enabled: true, intensityPct: 98 });
      const snapshot = manager.getVisualState();
      return (
        result.ok &&
        result.bloom.intensityPct === 98 &&
        snapshot.bloom.intensity === 98 &&
        manager._visualEffects.bloomIntensity === 98 &&
        manager._bloomStage.enabled
      );
    }),
  );
  check(
    'sharpen actions, effect state and saved snapshot agree',
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      const result = manager.setSharpen({ enabled: true, intensityPct: 61 });
      return (
        result.ok &&
        result.sharpen.intensityPct === 61 &&
        manager.getVisualState().sharpen.intensity === 61 &&
        manager._visualEffects.sharpenIntensity === 0.61 &&
        Math.abs(manager._sharpenStage.uniforms.amount - 1.32) < 1e-9
      );
    }),
  );
  await page.setViewport({ width: 620, height: 900 });
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setPanelCollapsed('pp-toggles', false, {
      persist: false,
      syncShare: false,
    }),
  );
  await page.screenshot({ path: 'qa-shots/visual-effects/narrow.png' });
  const teardown = await page.evaluate(async () => {
    const manager = window.__godsEyeView.styleManager;
    const effects = manager._visualEffects;
    manager.setStyle('retro');
    const owned = [...Object.values(effects.stages), effects.sharpenStage];
    const collection = manager.viewer.scene.postProcessStages;
    const previousBloom = effects.previousBloom;
    const pending = manager.dispose();
    const stoppedBeforeAwait =
      effects.stopped &&
      effects.frameId === null &&
      effects.transitions.size === 0;
    await pending;
    return {
      stoppedBeforeAwait,
      removed: owned.every((stage) => !collection.contains(stage)),
      restored:
        effects.bloomStage.enabled === previousBloom.enabled &&
        Object.entries(previousBloom.uniforms).every(
          ([name, value]) => effects.bloomStage.uniforms[name] === value,
        ),
    };
  });
  check(
    'UI teardown stops effect animation before its first await',
    teardown.stoppedBeforeAwait,
  );
  check(
    'UI teardown removes owned stages and restores borrowed bloom',
    teardown.removed && teardown.restored,
  );
  check(
    'effects do not introduce uncaught browser errors',
    errors.length === 0,
  );
  if (errors.length) console.log(JSON.stringify(errors));
} finally {
  await browser.close();
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;
