import { assertKeylessPreview } from '../qa-strict-harness.mjs';
// Shared by the Navara visual QA scenarios (qa-navara-visual-styles,
// qa-navara-bloom, qa-navara-sonar, qa-navara-cockpit-clouds): read the
// engine canvas, compare frames, settle a still view, follow a style
// crossfade.

import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DAYTIME, shiftTime } from './time.mjs';

/** A still view over Austin, no layers, OSM imagery. */
export const STILL_VIEW =
  'v=2&lat=30.2672&lon=-97.7431&alt=20000&heading=0&pitch=-70&map=osm&l=';

/**
 * Before the app loads: the page's Date runs from `utc` on, so the look's
 * sun (and with it the frame's brightness, which the bloom threshold and
 * the styles' signatures read) does not follow the time of day the
 * scenario happens to run at. Default: Austin early afternoon.
 */
export function pinDaytime(page, utc = DAYTIME) {
  return page.evaluateOnNewDocument(shiftTime, utc);
}

/** The keyless page on `engine` with the still view (and `extra` hash). */
export const visualPageUrl = (origin, engine, extra = '', view = STILL_VIEW) =>
  `${origin}/?engine=${engine}&welcome=0&look=cinematic#${view}${extra}`;

/** A check that logs, records into `report` and asserts. */
export function checker(report, assert) {
  return (name, pass, detail) => {
    report.checks.push({ name, pass: Boolean(pass), detail });
    console.log(
      pass ? 'PASS' : 'FAIL',
      name,
      detail ? JSON.stringify(detail) : '',
    );
    assert.ok(pass, `${name} ${JSON.stringify(detail)}`);
  };
}

// The engine canvas as drawn, downscaled to 160×100 RGBA in the page, read
// inside the engine's postRender (Cesium keeps no drawing buffer after it).
export async function capture(page) {
  return page.evaluate(async () => {
    const { engine } = window.__godsEyeView;
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 100;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    await new Promise((resolve) => {
      const off = engine.frames.postRender.addEventListener(() => {
        off();
        ctx.drawImage(engine.host.canvas, 0, 0, 160, 100);
        resolve();
      });
      engine.render.request('qa-visual-styles');
    });
    return Array.from(ctx.getImageData(0, 0, 160, 100).data);
  });
}

export function stats(pixels) {
  let r = 0,
    g = 0,
    b = 0,
    saturation = 0;
  const histogram = new Array(16).fill(0);
  const count = pixels.length / 4;
  for (let i = 0; i < pixels.length; i += 4) {
    const [pr, pg, pb] = [pixels[i], pixels[i + 1], pixels[i + 2]];
    r += pr;
    g += pg;
    b += pb;
    saturation += Math.max(pr, pg, pb) - Math.min(pr, pg, pb);
    histogram[
      Math.min(15, Math.floor((0.299 * pr + 0.587 * pg + 0.114 * pb) / 16))
    ]++;
  }
  // The vignette: the corners' luma over the centre's (160×100 capture).
  const luma = (x0, y0) => {
    let sum = 0;
    for (let y = y0; y < y0 + 10; y++)
      for (let x = x0; x < x0 + 16; x++) {
        const i = (y * 160 + x) * 4;
        sum +=
          0.299 * pixels[i] + 0.587 * pixels[i + 1] + 0.114 * pixels[i + 2];
      }
    return sum / 160;
  };
  const corners = (luma(0, 0) + luma(144, 0) + luma(0, 90) + luma(144, 90)) / 4;
  return {
    vignette: corners / Math.max(1, luma(72, 45)),
    r: r / count,
    g: g / count,
    b: b / count,
    saturation: saturation / count,
    histogram: histogram.map((n) => n / count),
  };
}

export function diff(a, b) {
  let sum = 0;
  let changed = 0;
  for (let i = 0; i < a.length; i += 4) {
    const d =
      Math.abs(a[i] - b[i]) +
      Math.abs(a[i + 1] - b[i + 1]) +
      Math.abs(a[i + 2] - b[i + 2]);
    sum += d / 3;
    if (d / 3 > 8) changed++;
  }
  const count = a.length / 4;
  return { mean: sum / count, changedShare: changed / count };
}

// Histogram distance (half the L1 of two normalised histograms, 0..1).
export const histogramShift = (a, b) =>
  a.histogram.reduce(
    (sum, value, i) => sum + Math.abs(value - b.histogram[i]),
    0,
  ) / 2;

export async function freeze(page) {
  await assertKeylessPreview(page);
  await page.evaluate(async () => {
    const a = window.__godsEyeView;

    a.styleManager.orbitController.stop();
    a.engine.camera.cancelFlight();
    a.styleManager._setDetectionMode?.('OFF');
    for (const [id, row] of a.dataManager.layers)
      if (row.enabled) await a.dataManager.setEnabled(id, false);
  });
  await page.waitForFunction(
    () => window.__godsEyeView.engine.surface.tilesLoaded(),
    { timeout: 90000, polling: 250 },
  );
  await new Promise((resolve) => setTimeout(resolve, 2500));
}

// Picks a style the way the style keys do, then follows the crossfade on
// the engine every frame until VisualEffects has no transition left.
export async function pickStyle(page, name, previous) {
  return page.evaluate(
    async (name, previous) => {
      const a = window.__godsEyeView;
      const render = a.engine.render;
      const drawn = typeof render.setStyle === 'function';
      const intensity = (style) =>
        !style || style === 'normal'
          ? 0
          : drawn
            ? render.style(style).intensity
            : a.styleManager.stages[style].uniforms.intensity;
      const samples = [];
      const started = performance.now();
      a.styleManager.setStyle(name, { userInitiated: true });
      while (performance.now() - started < 3000) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
        samples.push([intensity(previous), intensity(name)]);
        if (a.styleManager.transitions.size === 0) break;
      }
      return {
        ms: performance.now() - started,
        pending: a.styleManager.transitions.size,
        samples,
        active: a.styleManager.activeStyle,
        intensities: drawn
          ? Object.fromEntries(
              render.visualStyles.map((style) => [
                style,
                render.style(style).intensity,
              ]),
            )
          : null,
        pipeline: a.engine.pipeline?.() ?? null,
      };
    },
    name,
    previous,
  );
}

export const saveCapture = (outDir, name, pixels) => {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  void sharp(Buffer.from(pixels), {
    raw: { width: 160, height: 100, channels: 4 },
  })
    .png()
    .toFile(path.join(outDir, `${name}.png`));
  fs.writeFileSync(
    path.join(outDir, `${name}.json`),
    JSON.stringify(stats(pixels)),
  );
};
