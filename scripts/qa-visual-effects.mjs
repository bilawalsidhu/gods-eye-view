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
async function tilesSettled(timeout) {
  return page
    .waitForFunction(
      () => {
        const { globe, primitives } = window.__godsEyeView.viewer.scene;
        if (globe.show && !globe.tilesLoaded) return false;
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
      { timeout },
    )
    .then(
      () => true,
      () => false,
    );
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
  check(
    'visible tile content settles before visual captures',
    await tilesSettled(60_000),
  );
  fs.mkdirSync('qa-shots/visual-effects', { recursive: true });
  // Draws a second on a still scene: NVG and FLIR step at 15 Hz, CRT holds
  // the loop, the others draw nothing by themselves.
  const RATES = {
    surveillance: [8, 25],
    thermal: [8, 25],
    retro: [25, Infinity],
  };
  for (const style of [
    'normal',
    'retro',
    'surveillance',
    'thermal',
    'anime',
    'noir',
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
      return { active: manager.activeStyle, visible };
    });
    check(
      `${style}: only the selected style remains visible`,
      state.active === style &&
        JSON.stringify(state.visible) ===
          JSON.stringify(style === 'normal' ? [] : [style]),
    );
    if (!(await tilesSettled(30_000)))
      throw new Error(
        `${style}: tile loading did not settle before frame sampling`,
      );
    const draws = await page.evaluate(async () => {
      const scene = window.__godsEyeView.viewer.scene;
      let n = 0;
      const off = scene.postRender.addEventListener(() => (n += 1));
      // Overlay layout can briefly request extra frames on a still scene.
      const samples = [];
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        samples.push(n);
        n = 0;
      }
      off();
      return Math.min(...samples);
    });
    const [low, high] = RATES[style] ?? [0, 5];
    check(
      `${style}: the renderer draws ${low}-${high} frames a second on a still scene (${draws})`,
      draws >= low && draws <= high,
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
      const states = [];
      const unsubscribe = manager.subscribeShareState((value) =>
        states.push(value),
      );
      const result = manager.setBloom({ enabled: true, intensityPct: 98 });
      unsubscribe();
      const published = states.at(-1);
      const snapshot = manager.getVisualState();
      return (
        states[0].initial &&
        states.length > 1 &&
        Object.isFrozen(published.state.options) &&
        published.state.bloomEnabled &&
        published.state.options.bloomIntensity === 98 &&
        result.ok &&
        result.bloom.intensityPct === 98 &&
        snapshot.bloom.intensity === 98 &&
        manager._visualEffects.bloomIntensity === 98 &&
        window.__godsEyeView.viewer.scene.postProcessStages.bloom.enabled
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
        Math.abs(
          window.__godsEyeView.viewer.scene.postProcessStages.getStageByName(
            'effects_sharpen',
          ).uniforms.amount - 1.32,
        ) < 1e-9
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
    const collection = window.__godsEyeView.viewer.scene.postProcessStages;
    const owned = Object.keys(effects.stages).map((name) =>
      collection.getStageByName(`effects_style_${name}`),
    );
    const pending = manager.dispose();
    const stoppedBeforeAwait =
      effects.stopped &&
      effects.frameId === null &&
      effects.transitions.size === 0;
    await pending;
    return {
      stoppedBeforeAwait,
      removed:
        owned.every(Boolean) &&
        Object.keys(effects.stages).every(
          (name) => !collection.getStageByName(`effects_style_${name}`),
        ),
      // The renderer gives the scene's bloom back when it goes.
      restored:
        !collection.bloom.enabled &&
        !collection.getStageByName('effects_sharpen')?.enabled,
    };
  });
  check(
    'UI teardown stops effect animation before its first await',
    teardown.stoppedBeforeAwait,
  );
  check(
    'UI teardown removes its styles and turns bloom and sharpen off',
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
