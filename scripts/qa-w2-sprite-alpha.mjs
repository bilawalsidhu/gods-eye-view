#!/usr/bin/env node
// Isolated native-stage diagnostic: real mover sprites and production
// FIRMS glow artwork, with an independent encoded-alpha swatch oracle.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import sharp from 'sharp';
import { watchW1Page } from './qa-browserEvidence.mjs';
import { FIRMS_EPOCH_MS } from './fixtures/w2/firms.mjs';
const arg = (k) =>
  process.argv.find((v) => v.startsWith(`--${k}=`))?.slice(k.length + 3);
const base = arg('base-url');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply unreserved dev URL');
const out = path.resolve(
  arg('out') ?? 'qa-artifacts/w2/firms/sprite-alpha-initial.json',
);
await fs.mkdir(path.dirname(out), { recursive: true });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const report = {
  stage:
    'isolated native-stage sprite diagnostic; full FIRMS acceptance separate',
  checks: [],
  browserErrors: [],
  captures: {},
  driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
};
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: !!pass, detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
try {
  for (const engine of ['cesium', 'navara']) {
    const context = await browser.createBrowserContext();
    try {
      const page = await context.newPage();
      await blockPaidQaMaps(page);
      await page.setViewport({ width: 1280, height: 800 });
      watchW1Page(page, report, {
        name: engine,
        baseUrl: base,
        preview: process.argv.includes('--preview'),
      });
      await page.evaluateOnNewDocument(() =>
        localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
      );
      const url = new URL(base);
      url.searchParams.set('engine', engine);
      url.searchParams.set('look', 'minimal');
      await page.goto(url.href, {
        waitUntil: 'domcontentloaded',
        timeout: 180000,
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView?.layers &&
          document
            .getElementById('loading-screen')
            ?.classList.contains('hidden'),
        { timeout: 180000 },
      );
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
      const effectState = await page.evaluate(async (epoch) => {
        const a = window.__godsEyeView,
          g = await import('/src/geo/index.js');
        a.styleManager.orbitController.stop();
        const beforeEffects = {
          bloom: a.styleManager.bloomEnabled,
          sharpen: a.styleManager.sharpenEnabled,
        };
        a.styleManager._setBloomEnabled(false);
        a.styleManager._setSharpenEnabled(false);
        const effectState = {
          before: beforeEffects,
          after: {
            bloom: a.styleManager.bloomEnabled,
            sharpen: a.styleManager.sharpenEnabled,
          },
          nativeBloom: a.viewer?.scene.postProcessStages.bloom.enabled ?? null,
          nativeHdr: a.viewer?.scene.highDynamicRange ?? null,
        };

        a.engine.camera.cancelFlight();
        for (const [id] of a.dataManager.layers)
          if (a.dataManager.isEnabled(id)) await a.layers.disable(id);
        (await import('/src/time/clock.js')).appClock.freeze(epoch);
        (await import('/src/data/detection.js')).setMode('OFF');
        if (a.viewer)
          a.viewer.clock.currentTime =
            a.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
        a.engine.camera.setView({
          destination: g.cartesian3.fromDegrees(-123, 37.77, 100000),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        const canvas = a.engine.host.canvas,
          style = document.createElement('style');
        style.textContent = '.alpha-hidden{visibility:hidden!important}';
        document.head.append(style);
        for (const e of document.body.querySelectorAll('*'))
          if (e !== canvas && !e.contains(canvas))
            e.classList.add('alpha-hidden');
        let since = null;
        const start = performance.now();
        while (performance.now() - start < 90000) {
          if (a.engine.surface.tilesLoaded()) since ??= performance.now();
          else since = null;
          if (since !== null && performance.now() - since > 1500)
            return effectState;
          a.engine.render.request('alpha-settle');
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('Alpha background did not settle');
      }, FIRMS_EPOCH_MS);
      await new Promise((r) => setTimeout(r, 2500));
      report.captures[engine] = {};
      (report.effectPreconditions ??= {})[engine] = effectState;
      for (const kind of [
        'opaque',
        'grey',
        'purple',
        'alpha',
        'glow',
        'tinted-grey',
        'tinted-purple-alpha',
      ]) {
        const state = await page.evaluate(async (kind) => {
          const a = window.__godsEyeView,
            g = await import('/src/geo/index.js');
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 56;
          const ctx = canvas.getContext('2d');
          if (kind === 'glow') {
            const { createFirmsHelpers } =
              await import('/src/layers/firms/index.js');
            const helpers = createFirmsHelpers({
              services: { anchors: { fireAnchorHeight: () => 5 } },
            });
            const image = new Image();
            image.src = helpers.glowSprite(
              helpers.detectionColorStop({ frp: 999, confidence: 0.9 }),
              28,
            );
            await image.decode();
            ctx.drawImage(image, 0, 0);
          } else {
            ctx.fillStyle =
              kind === 'grey'
                ? 'rgb(128,128,128)'
                : kind === 'purple'
                  ? 'rgb(128,64,192)'
                  : kind === 'opaque'
                    ? 'rgba(255,0,0,1)'
                    : 'rgba(255,0,0,0.3)';
            ctx.fillRect(0, 0, 56, 56);
          }
          const tint =
            kind === 'tinted-grey'
              ? [128 / 255, 128 / 255, 128 / 255, 1]
              : kind === 'tinted-purple-alpha'
                ? [192 / 255, 64 / 255, 128 / 255, 77 / 255]
                : [1, 1, 1, 1];
          if (kind.startsWith('tinted-')) {
            ctx.clearRect(0, 0, 56, 56);
            ctx.fillStyle = 'white';
            ctx.fillRect(0, 0, 56, 56);
          }
          const position = g.cartesian3.fromDegrees(-123, 37.77, 5);
          const set = a.engine.movers.createSet({
            id: 'firms-alpha-' + kind,
            kind: 'sprite',
            sharpen: true,
            capacity: 1,
            order: 1,
            depthTest: 'always',
            pickable: false,
            sprite: {
              atlas: { canvas, cells: { image: [0, 0, 1, 1] } },
              sizePx: 56,
            },
          });
          set.set(0, {
            position,
            cell: 'image',
            scale: 1,
            color: tint,
            show: true,
          });
          set.setCount(1);
          set.commit();
          window.__firmsAlphaSet = set;
          const readyStarted = performance.now();
          while (!set.ready() && performance.now() - readyStarted < 10000) {
            a.engine.render.request('alpha-texture-ready');
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
          if (!set.ready())
            throw new Error('Sprite texture did not become ready');
          const screen = a.engine.projector.worldToWindow(position);
          return {
            screen: { x: screen.x, y: screen.y },
            sourceCenter: [...ctx.getImageData(28, 28, 1, 1).data],
            tint,
            count: set.count(),
          };
        }, kind);
        await new Promise((r) => setTimeout(r, 1000));
        const on = await page.screenshot({
          path: out.replace(/\.json$/, `-${engine}-${kind}-on.png`),
        });
        await page.evaluate(() => {
          window.__firmsAlphaSet.setCount(0);
          window.__firmsAlphaSet.commit();
          window.__godsEyeView.engine.render.request('alpha-off');
        });
        await new Promise((r) => setTimeout(r, 500));
        const off = await page.screenshot({
          path: out.replace(/\.json$/, `-${engine}-${kind}-off.png`),
        });
        const [a, b] = await Promise.all(
          [on, off].map((buffer) =>
            sharp(buffer).removeAlpha().raw().toBuffer(),
          ),
        );
        const pixel = (buffer, x, y) => [
          ...buffer.subarray((y * 1280 + x) * 3, (y * 1280 + x) * 3 + 3),
        ];
        const x = Math.floor(state.screen.x),
          y = Math.floor(state.screen.y),
          centerOn = pixel(a, x, y),
          centerOff = pixel(b, x, y);
        const alpha = (state.sourceCenter[3] / 255) * state.tint[3];
        // Tinted controls use a white atlas, keeping their known encoded
        // source color independent of the material conversion implementation.
        const sourceRgb = state.sourceCenter
          .slice(0, 3)
          .map((v, c) => v * state.tint[c]);
        const encoded = centerOff.map((v, c) =>
          Math.round(v * (1 - alpha) + sourceRgb[c] * alpha),
        );
        const linear = (v) =>
          v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        const display = (v) =>
          v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
        const linearBlend = centerOff.map((v, c) =>
          Math.round(
            display(
              linear(v / 255) * (1 - alpha) +
                linear(sourceRgb[c] / 255) * alpha,
            ) * 255,
          ),
        );
        const encodedError = Math.max(
            ...centerOn.map((v, c) => Math.abs(v - encoded[c])),
          ),
          linearError = Math.max(
            ...centerOn.map((v, c) => Math.abs(v - linearBlend[c])),
          );
        const delta = Math.max(
          ...centerOn.map((v, c) => Math.abs(v - centerOff[c])),
        );
        report.captures[engine][kind] = {
          ...state,
          on: centerOn,
          off: centerOff,
          encodedPrediction: encoded,
          linearPrediction: linearBlend,
          encodedError,
          linearError,
          delta,
          onSha256: sha(on),
          offSha256: sha(off),
        };
        check(
          `${engine}/${kind}: actual nonempty visible sprite`,
          delta > 16 && Number.isFinite(state.screen.x),
          report.captures[engine][kind],
        );
        if (kind !== 'glow')
          check(
            `${engine}/${kind}: native display-space RGB/alpha`,
            encodedError <= 3,
            report.captures[engine][kind],
          );
        await page.evaluate(() => {
          window.__firmsAlphaSet.destroy();
          delete window.__firmsAlphaSet;
        });
      }
    } finally {
      await context.close();
    }
  }
} catch (error) {
  check('scenario completes', false, error.message);
} finally {
  await browser.close();
}
check(
  'strict observed pages',
  report.browserErrors.length === 0,
  report.browserErrors,
);
report.pass = report.checks.length === 27 && report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log('RESULT', report.pass);
process.exitCode = report.pass ? 0 : 1;
