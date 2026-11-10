// The app's visual styles on Navara: each of CRT, NVG, FLIR,
// Anime and Noir filters the Navara frame (pixels and a style-specific
// signature against Normal), switching styles crossfades (both styles drawn
// at once mid-way, the fade completes), Normal restores the frame, the
// retired Snow opens on Normal, a link's style opens on Navara, and on
// Cesium the styles still run as Cesium post stages with the engine left
// alone. Keyless preview under the strict default-deny network policy.
//
//   node scripts/qa-navara-visual-styles.mjs http://127.0.0.1:<PORT>/ [--out=DIR]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  STILL_VIEW,
  capture,
  checker,
  diff,
  freeze,
  histogramShift,
  pickStyle,
  saveCapture,
  stats,
  visualPageUrl,
} from './qa/navaraVisual.mjs';

const base = localPreview(process.argv[2]);
const outDir = process.argv
  .find((arg) => arg.startsWith('--out='))
  ?.slice('--out='.length);
const STYLES = ['retro', 'surveillance', 'thermal', 'anime', 'noir'];
const URL_NAMES = { retro: 'crt', surveillance: 'nvg', thermal: 'flir' };
const pageUrl = (engine, extra = '') =>
  visualPageUrl(base.origin, engine, extra, STILL_VIEW);

const strict = createStrict({ origin: base.origin, layers: [] });
const report = { checks: [] };
const check = checker(report, assert);

const save = (name, pixels) => saveCapture(outDir, name, pixels);

await strict.run({}, async (browser) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // The same sun on every run: the frame's brightness decides what blooms
  // and what each style's signature reads.
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
  });
  await page.setViewport({ width: 1280, height: 800 });
  await page.goto(pageUrl('navara'), { waitUntil: 'domcontentloaded' });
  await waitForEngine(page, 'navara');
  await freeze(page);

  const capabilities = await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    return {
      styles: engine.render.visualStyles,
      pipeline: engine.pipeline(),
    };
  });
  check(
    'Navara draws every app style itself',
    JSON.stringify(capabilities.styles) === JSON.stringify(STYLES),
    capabilities,
  );
  check(
    'no style pass shows on Normal',
    capabilities.pipeline?.shown === false,
    capabilities.pipeline,
  );

  // The military styles' presets set sharpening and detection (as on
  // Cesium); Normal keeps them, so they are put back before comparing.
  const display = await page.evaluate(
    () => window.__godsEyeView.styleManager.getControlState().sharpen,
  );
  const normal = await capture(page);
  const normalAgain = await capture(page);
  const noise = diff(normal, normalAgain);
  check('Normal is a still frame to compare against', noise.mean < 0.5, noise);
  save('normal', normal);
  const normalStats = stats(normal);

  let previous = 'normal';
  for (const name of STYLES) {
    const fade = await pickStyle(page, name, previous);
    check(
      `${name}: the crossfade completes`,
      fade.pending === 0 && fade.ms < 1500 && fade.active === name,
      { ms: fade.ms, pending: fade.pending },
    );
    const between = fade.samples.filter(
      ([, next]) => next > 0.02 && next < 0.98,
    );
    check(
      `${name}: the engine fades it in over several frames`,
      between.length >= 1,
      { frames: fade.samples.length, between: between.length },
    );
    if (previous !== 'normal') {
      const both = fade.samples.filter(
        ([out, next]) => out > 0.05 && out < 0.95 && next > 0.05 && next < 0.95,
      );
      check(
        `${name}: ${previous} and ${name} draw together mid-crossfade`,
        both.length >= 1,
        { both: both.length },
      );
    }
    const others = Object.entries(fade.intensities).filter(
      ([style, value]) => style !== name && value !== 0,
    );
    check(
      `${name}: alone at full intensity once settled`,
      fade.intensities[name] === 1 && others.length === 0,
      fade.intensities,
    );
    const order = fade.pipeline?.passes ?? [];
    const at = order.indexOf('gevStyles');
    check(
      `${name}: the style pass shows, last before the final copy and after the overlays`,
      fade.pipeline?.shown === true &&
        at >= 0 &&
        order[at + 1] === 'final' &&
        ['toneMapping', 'gevSharpen', 'gevOverlay', 'smaa', 'fxaa'].every(
          (key) => !order.includes(key) || order.indexOf(key) < at,
        ),
      fade.pipeline,
    );
    const pixels = await capture(page);
    save(name, pixels);
    const styled = stats(pixels);
    const change = diff(normal, pixels);
    const shift = histogramShift(normalStats, styled);
    check(
      `${name}: the frame changes against Normal`,
      change.mean > 6 && change.changedShare > 0.25,
      { ...change, histogramShift: shift },
    );
    const signature = {
      // Night vision: phosphor green over red and blue.
      surveillance: styled.g > styled.r * 1.3 && styled.g > styled.b * 1.3,
      // FLIR white-hot (palette 0): grey.
      thermal: styled.saturation < normalStats.saturation * 0.5,
      // Noir: greyer, with a slight sepia, and vignetted corners.
      noir:
        styled.saturation < normalStats.saturation &&
        styled.vignette < normalStats.vignette * 0.85,
      // Anime: cel bands, more saturated.
      anime: styled.saturation > normalStats.saturation * 1.05 || shift > 0.05,
      // CRT: pixelated, dithered, scanlined.
      retro: shift > 0.05 || change.mean > 12,
    }[name];
    check(`${name}: the style's own look`, signature, {
      normal: {
        r: normalStats.r,
        g: normalStats.g,
        b: normalStats.b,
        saturation: normalStats.saturation,
        vignette: normalStats.vignette,
      },
      styled: {
        r: styled.r,
        g: styled.g,
        b: styled.b,
        saturation: styled.saturation,
        vignette: styled.vignette,
      },
      histogramShift: shift,
    });
    previous = name;
  }

  // A style parameter reaches the Navara pass (FLIR's Ironbow palette).
  await pickStyle(page, 'thermal', previous);
  previous = 'thermal';
  const grey = await capture(page);
  const ironbow = await page.evaluate(() => {
    const a = window.__godsEyeView;
    a.styleManager.stages.thermal.uniforms.palette = 1;
    return a.engine.render.style('thermal').uniforms.palette;
  });
  const coloured = await capture(page);
  check(
    'FLIR Ironbow reaches the engine and colours the frame',
    ironbow === 1 && stats(coloured).saturation > stats(grey).saturation + 10,
    {
      grey: stats(grey).saturation,
      ironbow: stats(coloured).saturation,
    },
  );
  await page.evaluate(() => {
    window.__godsEyeView.styleManager.stages.thermal.uniforms.palette = 0;
  });

  const back = await pickStyle(page, 'normal', previous);
  check(
    'Normal: every style back at 0 and the pass hidden',
    Object.values(back.intensities).every((v) => v === 0) &&
      back.pipeline?.shown === false,
    back,
  );
  await page.evaluate((sharpen) => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setDetectionMode?.('OFF');
    styleManager.setSharpen(sharpen);
  }, display);
  const restored = await capture(page);
  save('normal-restored', restored);
  const residue = diff(normal, restored);
  check(
    'Normal restores the frame',
    residue.mean < 1 && residue.changedShare < 0.01,
    residue,
  );

  // The retired Snow opens on Normal; a link's style opens on Navara.
  await page.goto(pageUrl('navara', '&style=snow'), {
    waitUntil: 'domcontentloaded',
  });
  await waitForEngine(page, 'navara');
  const snow = await page.evaluate(() => {
    const a = window.__godsEyeView;
    return {
      active: a.styleManager.activeStyle,
      intensities: a.engine.render.visualStyles.map(
        (s) => a.engine.render.style(s).intensity,
      ),
    };
  });
  check(
    'style=snow opens on Normal',
    snow.active === 'normal' && snow.intensities.every((v) => v === 0),
    snow,
  );
  await page.goto(pageUrl('navara', `&style=${URL_NAMES.thermal}`), {
    waitUntil: 'domcontentloaded',
  });
  await waitForEngine(page, 'navara');
  await page.waitForFunction(
    () => window.__godsEyeView.engine.render.style('thermal').intensity === 1,
    { timeout: 10000, polling: 50 },
  );
  check('a FLIR link opens filtered on Navara', true);

  // Cesium keeps its own post stages; its engine draws no styles. The
  // switch is real input on the picker, in the same document.
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setStyle('normal'),
  );
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.transitions.size === 0,
  );
  await strict.switchTo(page, 'cesium');
  await freeze(page);
  // The address may still carry the FLIR link: Normal first.
  await pickStyle(page, 'normal', 'thermal');
  await page.evaluate((sharpen) => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setDetectionMode?.('OFF');
    styleManager.setSharpen(sharpen);
  }, display);
  const cesiumNormal = await capture(page);
  const cesium = await pickStyle(page, 'thermal', 'normal');
  const cesiumState = await page.evaluate(() => {
    const a = window.__godsEyeView;
    const stage = a.styleManager.stages.thermal;
    return {
      setStyle: typeof a.engine.render.setStyle,
      stageName: stage.name,
      enabled: stage.enabled,
      intensity: stage.uniforms.intensity,
      inScene: a.engine.render.style('thermal').intensity > 0,
    };
  });
  const cesiumThermal = await capture(page);
  save('cesium-normal', cesiumNormal);
  save('cesium-thermal', cesiumThermal);
  if (outDir)
    await page.screenshot({
      path: path.join(outDir, 'cesium-thermal-page.png'),
    });
  check(
    'Cesium: the engine owns the FLIR post stage',
    cesium.pending === 0 &&
      cesiumState.setStyle === 'function' &&
      cesiumState.enabled === true &&
      cesiumState.intensity === 1 &&
      cesiumState.inScene !== false,
    cesiumState,
  );
  const cesiumChange = diff(cesiumNormal, cesiumThermal);
  check('Cesium: FLIR changes its frame', cesiumChange.mean > 6, cesiumChange);
  await pickStyle(page, 'normal', 'thermal');
  await page.evaluate((sharpen) => {
    const { styleManager } = window.__godsEyeView;
    styleManager._setDetectionMode?.('OFF');
    styleManager.setSharpen(sharpen);
  }, display);
  const cesiumBack = diff(cesiumNormal, await capture(page));
  check('Cesium: Normal restores its frame', cesiumBack.mean < 1.5, cesiumBack);

  check('no page errors', errors.length === 0, errors);
  if (outDir)
    fs.writeFileSync(
      path.join(outDir, 'visual-styles.json'),
      JSON.stringify(report, null, 2),
    );
});
