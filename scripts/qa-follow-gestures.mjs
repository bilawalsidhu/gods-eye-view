#!/usr/bin/env node
// Real single-event follow gestures, compared against Cesium with fresh contexts.
import puppeteer from 'puppeteer';
import { redact } from './qa-browserEvidence.mjs';
import fs from 'node:fs';
import path from 'node:path';
const argument = (name) =>
  process.argv
    .find((value) => value.startsWith(`--${name}=`))
    ?.slice(name.length + 3);
const base = argument('base-url');
if (
  !base ||
  [4173, 4185, 4186, 4187, 4188, 4189].includes(Number(new URL(base).port))
)
  throw new Error('Supply an unreserved --base-url');
const out = path.resolve(
  argument('out') ?? 'qa-artifacts/w1-follow-gestures.json',
);
fs.mkdirSync(path.dirname(out), { recursive: true });
const result = {};
const errors = [];
// Native trackedEntity retains user offsets across re-tracking. A fresh
// browser per direction isolates the input step from that legacy restoration.
for (const [kind, dx] of [
  ['cesium', 640],
  ['cesium', -640],
  ['navara', 640],
  ['navara', -640],
]) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-angle=metal'],
  });
  try {
    const page = await browser.newPage();
    page.on('pageerror', (error) =>
      errors.push(redact(`${kind} dx=${dx}: ${error.message}`)),
    );
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() =>
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed'),
    );
    const url = new URL(base);
    url.searchParams.set('engine', kind);
    url.searchParams.set('qaFeed', 'flights:synthetic:100');
    await page.goto(url.href, {
      waitUntil: 'domcontentloaded',
      timeout: 180000,
    });
    await page.waitForFunction(() => Boolean(window.__godsEyeView?.layers), {
      timeout: 180000,
    });
    await new Promise((r) => setTimeout(r, 8000));
    const id = await page.evaluate(async (expected) => {
      const app = window.__godsEyeView;
      if (app.engine.kind !== expected)
        throw new Error('Unexpected globe engine');
      app.styleManager.orbitController.stop();
      app.engine.camera.cancelFlight();
      for (const [id] of app.dataManager.layers)
        if (app.dataManager.isEnabled(id)) await app.layers.disable(id);
      await app.layers.enable('flights');
      if (app.viewer)
        app.viewer.scene.screenSpaceCameraController.inertiaSpin = 0;
      const { appClock } = await import('/src/time/clock.js');
      appClock.freeze(Date.now());
      return app.layers.objects('flights', 100)[0].id;
    }, kind);
    const heading = () =>
      page.evaluate(async () => {
        const geo = await import('/src/geo/index.js');
        const app = window.__godsEyeView;
        const target = app.dataManager.layers
          .get('flights')
          .module.getTrackedSubject().position;
        const frame = geo.transforms.eastNorthUpToFixedFrame(target);
        const inverse = geo.matrix4.inverseTransformation(
          frame,
          geo.matrix4.create(),
        );
        const p = geo.matrix4.multiplyByPoint(
          inverse,
          app.engine.camera.pose().position,
          geo.cartesian3.create(),
        );
        return Math.atan2(p.x, p.y);
      });
    result[kind] ??= [];
    {
      await page.keyboard.press('Escape');
      await page.evaluate(async (id) => {
        await window.__godsEyeView.dataManager.layers
          .get('flights')
          .module.trackById(id);
      }, id);
      await new Promise((r) => setTimeout(r, 3500));
      const before = await heading();
      const x = dx > 0 ? 180 : 900;
      await page.mouse.move(x, 650);
      await new Promise((r) => setTimeout(r, 500));
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, 100));
      await page.mouse.move(x + dx, 650, { steps: 1 });
      await new Promise((r) => setTimeout(r, 250));
      await page.mouse.up();
      await new Promise((r) => setTimeout(r, 250));
      const after = await heading();
      const delta =
        (Math.atan2(Math.sin(after - before), Math.cos(after - before)) * 180) /
        Math.PI;
      result[kind].push({
        dx,
        delta,
        before: (before * 180) / Math.PI,
        after: (after * 180) / Math.PI,
      });
    }
  } finally {
    await browser.close();
  }
}
for (let i = 0; i < 2; i++) {
  const a = result.cesium[i].delta,
    b = result.navara[i].delta;
  if (
    !Number.isFinite(a) ||
    !Number.isFinite(b) ||
    Math.abs(
      (Math.atan2(
        Math.sin(((a - b) * Math.PI) / 180),
        Math.cos(((a - b) * Math.PI) / 180),
      ) *
        180) /
        Math.PI,
    ) > 0.1
  )
    errors.push(`dx=${result.cesium[i].dx}`);
}
result.errors = errors;
fs.writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exitCode = errors.length ? 1 : 0;
