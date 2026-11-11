#!/usr/bin/env node
import { whenSettled } from './qa/ready.mjs';
// The DISPLAY scope mask and the celestial ring on Navara, under the strict
// network policy: at city altitude the mask canvas sits in the engine's
// container with an opaque outside, the screen's edge goes dark with the
// scope on and shows the map with it off, and the ring overlay draws; the
// same holds after a switch to Cesium and back.
//
//   node scripts/qa-navara-scope.mjs http://127.0.0.1:<PORT>/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { fromDegrees } from '../src/geo/cartesian3.js';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';

const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0';
base.hash =
  'v=2&lat=37.7749&lon=-122.4194&alt=3000&heading=0&pitch=-90&roll=0&map=osm&l=';
const strict = createStrict({
  origin: base.origin,
  layers: ['scope-mask', 'celestial-ring'],
});
const SHOTS = process.env.QA_SHOT_DIR || 'qa-shots/navara-scope';
fs.mkdirSync(SHOTS, { recursive: true });

// The screen's right edge below the rail: outside the keyhole, clear of UI.
const GLOBE = fromDegrees(-122.4194, 37.7749, 20_000_000);
const CITY = fromDegrees(-122.4194, 37.7749, 3000);
const EDGE = { x: 1250, y: 560, width: 26, height: 90 };

await strict.run(
  {
    args: [
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
    ],
  },
  async (browser) => {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 860 });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(base.href);
    await waitForEngine(page, 'navara');
    const edgeLuminance = async () => {
      await whenSettled(page);
      const { data, info } = await sharp(await page.screenshot({ clip: EDGE }))
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let sum = 0;
      for (let i = 0; i < data.length; i += info.channels)
        sum += 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      return sum / (data.length / info.channels);
    };
    // DISPLAY ▸ Scope, as its checkbox sends it.
    const setScope = async (enabled) => {
      const found = await page.evaluate((on) => {
        const toggle = document.getElementById('scope-toggle');
        if (!toggle) return false;
        toggle.checked = on;
        toggle.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      }, enabled);
      assert.ok(found, 'the DISPLAY scope toggle');
    };

    for (const [round, kind] of ['navara', 'cesium', 'navara'].entries()) {
      if (
        (await page.evaluate(() => window.__godsEyeView.engine.kind)) !== kind
      ) {
        await strict.switchTo(page, kind);
      }
      await whenSettled(page);
      const mask = await page.evaluate(() => {
        const canvas = document.getElementById('scope-mask');
        const { engine } = window.__godsEyeView;
        const context = canvas?.getContext('2d');
        const corner = context?.getImageData(2, 2, 1, 1).data;
        const middle = context?.getImageData(
          Math.round(canvas.width / 2),
          Math.round(canvas.height / 2),
          1,
          1,
        ).data;
        return {
          exists: Boolean(canvas),
          inContainer: canvas?.parentElement === engine.host.container,
          count: document.querySelectorAll('#scope-mask').length,
          height: Math.round(engine.camera.height()),
          cornerAlpha: corner?.[3],
          middleAlpha: middle?.[3],
        };
      });
      await page.screenshot({ path: `${SHOTS}/${kind}-${round}-scope.png` });
      const on = await edgeLuminance();
      await setScope(false);
      const off = await edgeLuminance();
      const cleared = await page.evaluate(
        () =>
          document
            .getElementById('scope-mask')
            ?.getContext('2d')
            .getImageData(2, 2, 1, 1).data[3],
      );
      await setScope(true);
      console.log(kind, JSON.stringify({ mask, on, off, cleared }));
      await strict.check(
        page,
        'scope-mask',
        'one scope canvas in the engine container, opaque outside and clear inside at city altitude',
        mask.exists &&
          mask.inContainer &&
          mask.count === 1 &&
          mask.cornerAlpha === 255 &&
          mask.middleAlpha === 0,
        mask,
      );
      await strict.check(
        page,
        'scope-mask',
        'the screen edge is dark with the scope on and shows the map with it off',
        on < 12 && off > on + 30 && cleared === 0,
        { on, off, cleared },
      );
      // The ring is a full-globe view: up to the whole Earth, ring on.
      await page.evaluate((destination) => {
        const { engine, styleManager } = window.__godsEyeView;
        engine.camera.setView({ destination });
        styleManager.setCelestialRingEnabled(true);
      }, GLOBE);
      await whenSettled(page);
      const ring = await page.evaluate(() => {
        const overlay = document.getElementById('celestial-ring-overlay');
        const canvases = [...(overlay?.querySelectorAll('canvas') ?? [])];
        return {
          exists: Boolean(overlay),
          disabled: overlay?.classList.contains('disabled') ?? null,
          visible: overlay?.classList.contains('visible') ?? null,
          updates: Number(overlay?.dataset.ephemerisUpdates ?? 0),
          canvases: canvases.map((c) => [c.width, c.height]),
        };
      });
      await page.screenshot({ path: `${SHOTS}/${kind}-${round}-ring.png` });
      console.log(kind, 'ring', JSON.stringify(ring));
      await strict.check(
        page,
        'celestial-ring',
        'at full-globe altitude the celestial ring draws its sun and moon',
        ring.exists &&
          ring.disabled === false &&
          ring.visible === true &&
          ring.updates >= 1 &&
          ring.canvases.length === 2 &&
          ring.canvases.every(([w, h]) => w > 0 && h > 0),
        ring,
      );
      // Back down to the city for the next engine.
      await page.evaluate((destination) => {
        const { engine, styleManager } = window.__godsEyeView;
        styleManager.setCelestialRingEnabled(false);
        engine.camera.setView({ destination });
      }, CITY);
      await whenSettled(page);
    }
    assert.deepEqual(errors, []);
    console.log('PASS scope mask and celestial ring on both engines');
  },
);
