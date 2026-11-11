// The app's Bloom on Navara: the Display bloom glows the
// Navara frame (brighter, more at a higher slider), it sits after the
// overlays and before the visual styles, Cesium's dead zone draws nothing,
// turning it off restores the frame exactly, and on Cesium the scene's own
// bloom stage still runs with the engine left alone. Keyless preview under
// the strict default-deny network policy.
//
//   node scripts/qa-navara-bloom.mjs http://127.0.0.1:<PORT>/ [--out=DIR]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  capture,
  checker,
  diff,
  freeze,
  pickStyle,
  saveCapture,
  stats,
  visualPageUrl,
} from './qa/navaraVisual.mjs';

const base = localPreview(process.argv[2]);
const outDir = process.argv
  .find((arg) => arg.startsWith('--out='))
  ?.slice('--out='.length);
const strict = createStrict({ origin: base.origin, layers: [] });
const report = { checks: [] };
const check = checker(report, assert);
const save = (name, pixels) => saveCapture(outDir, name, pixels);
const luma = (s) => 0.299 * s.r + 0.587 * s.g + 0.114 * s.b;

// The Display bloom, as its toggle and slider set it.
const setBloom = (page, enabled, intensityPct) =>
  page.evaluate(
    (enabled, intensityPct) => {
      const a = window.__godsEyeView;
      a.styleManager.setBloom({ enabled, intensityPct });
      return {
        control: a.styleManager.getControlState().bloom,
        engine: a.engine.render.bloom?.() ?? null,
        pipeline: a.engine.pipeline?.() ?? null,
      };
    },
    enabled,
    intensityPct,
  );

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
  await page.goto(visualPageUrl(base.origin, 'navara'), {
    waitUntil: 'domcontentloaded',
  });
  await waitForEngine(page, 'navara');
  await freeze(page);

  const initial = await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    return { bloom: engine.render.bloom(), pipeline: engine.pipeline() };
  });
  check(
    'Navara blooms itself and starts with bloom off',
    initial.bloom.enabled === false && !initial.pipeline?.bloomShown,
    initial,
  );
  const normal = await capture(page);
  save('normal', normal);
  const normalStats = stats(normal);

  const full = await setBloom(page, true, 200);
  check(
    'the slider at 200 reaches the engine at full strength',
    full.engine.enabled === true &&
      full.engine.strength === 1 &&
      full.pipeline.bloomShown === true,
    full,
  );
  const order = full.pipeline.passes ?? [];
  const at = order.indexOf('gevBloom');
  check(
    'bloom runs after the scene and overlays, just before the final copy',
    at >= 0 &&
      order[at + 1] === 'final' &&
      ['toneMapping', 'gevSharpen', 'gevOverlay', 'smaa', 'fxaa'].every(
        (key) => !order.includes(key) || order.indexOf(key) < at,
      ),
    order,
  );
  const glowFull = await capture(page);
  save('bloom-200', glowFull);
  const fullChange = diff(normal, glowFull);
  const fullStats = stats(glowFull);
  check(
    'bloom at 200 glows the frame brighter',
    fullChange.mean > 3 && luma(fullStats) > luma(normalStats) + 2,
    {
      ...fullChange,
      normalLuma: luma(normalStats),
      bloomLuma: luma(fullStats),
    },
  );

  await setBloom(page, true, 100);
  const glowHalf = await capture(page);
  save('bloom-100', glowHalf);
  const halfChange = diff(normal, glowHalf);
  check(
    'a lower slider glows less',
    halfChange.mean > 0.5 && halfChange.mean < fullChange.mean,
    { half: halfChange.mean, full: fullChange.mean },
  );

  const dead = await setBloom(page, true, 10);
  const deadFrame = await capture(page);
  check(
    "Cesium's dead zone: the toggle on, nothing glows",
    dead.engine.enabled === false &&
      dead.pipeline.bloomShown === false &&
      diff(normal, deadFrame).mean === 0,
    { engine: dead.engine, diff: diff(normal, deadFrame) },
  );

  // With a style: bloom first, then the style, then the final copy.
  await setBloom(page, true, 200);
  const styled = await pickStyle(page, 'noir', 'normal');
  const styledOrder = styled.pipeline?.passes ?? [];
  check(
    'bloom runs before the visual styles',
    styledOrder.indexOf('gevBloom') >= 0 &&
      styledOrder.indexOf('gevBloom') + 1 ===
        styledOrder.indexOf('gevStyles') &&
      styledOrder.indexOf('gevStyles') + 1 === styledOrder.indexOf('final'),
    styledOrder,
  );
  await pickStyle(page, 'normal', 'noir');

  const off = await setBloom(page, false, 200);
  const offFrame = await capture(page);
  check(
    'turning bloom off restores the frame',
    off.engine.enabled === false &&
      off.pipeline.bloomShown === false &&
      diff(normal, offFrame).mean === 0,
    { engine: off.engine, diff: diff(normal, offFrame) },
  );

  // Cesium drives its scene bloom stage through the render contract.
  await strict.switchTo(page, 'cesium');
  await freeze(page);
  await setBloom(page, false, 200);
  const cesiumNormal = await capture(page);
  const cesium = await setBloom(page, true, 200);
  const cesiumStage = await page.evaluate(() => {
    const a = window.__godsEyeView;
    const stage = a.viewer?.scene?.postProcessStages?.bloom;
    return {
      setBloom: typeof a.engine.render.setBloom,
      enabled: stage?.enabled ?? null,
      contrast: stage?.uniforms?.contrast ?? null,
    };
  });
  const cesiumGlow = await capture(page);
  save('cesium-bloom-200', cesiumGlow);
  check(
    "Cesium: the engine drives its scene's bloom stage",
    cesium.engine?.enabled === true &&
      cesiumStage.setBloom === 'function' &&
      cesiumStage.enabled !== false &&
      diff(cesiumNormal, cesiumGlow).mean > 1,
    { stage: cesiumStage, diff: diff(cesiumNormal, cesiumGlow) },
  );
  await setBloom(page, false, 200);
  const cesiumBack = diff(cesiumNormal, await capture(page));
  check(
    'Cesium: bloom off restores its frame',
    cesiumBack.mean < 0.5,
    cesiumBack,
  );

  check('no page errors', errors.length === 0, errors);
  if (outDir)
    fs.writeFileSync(
      path.join(outDir, 'bloom.json'),
      JSON.stringify(report, null, 2),
    );
});
