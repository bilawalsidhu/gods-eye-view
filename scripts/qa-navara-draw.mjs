#!/usr/bin/env node
import { waitForEngine } from './qa-strict-harness.mjs';
import { whenSettled } from './qa/ready.mjs';
// UTILITIES ▸ Draw on Navara under the strict network policy, with real
// clicks and keys: Draw takes the pointer, clicks on the globe are vertices
// with a live rubber band, a double click finishes an area that paints on
// the canvas and joins the session board, Enter finishes a line, Escape
// cancels a sketch and then leaves Draw, and a switch to Cesium in the
// middle of a sketch ends it (the pointer is free, shape and colour kept);
// the shapes drawn on either engine stay on the board and draw on both.
//
//   node scripts/qa-navara-draw.mjs http://127.0.0.1:<PORT>/
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import { createStrict, localPreview } from './qa-strict-harness.mjs';

const VIEW = { lat: 37.7749, lon: -122.4194, alt: 6000 };
const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0';
base.hash = `v=2&lat=${VIEW.lat}&lon=${VIEW.lon}&alt=${VIEW.alt}&heading=0&pitch=-90&roll=0&map=osm&l=`;
const strict = createStrict({ origin: base.origin, layers: ['draw'] });
const SHOTS = process.env.QA_SHOT_DIR || 'qa-shots/navara-draw';
fs.mkdirSync(SHOTS, { recursive: true });
// An area's corners, clear of the open UTILITIES panel and the rails.
const AREA = [
  [560, 330],
  [760, 330],
  [760, 500],
  [560, 500],
];

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
    const ready = async (kind) => {
      await waitForEngine(page, kind);
      await page.waitForFunction(() => window.__gevDrawTool?.attached);
      await page.evaluate(
        () => window.__godsEyeView.styleManager.initialRestorePromise,
      );
    };
    await ready('navara');
    await assertKeylessPreview(page);
    const tool = () =>
      page.evaluate(() => {
        const draw = window.__gevDrawTool;
        return {
          active: draw.active,
          shape: draw.shape,
          color: draw.color,
          vertices: draw.session?.vertices.length ?? null,
          board: window.__gevAnnotations.count(),
          attached: window.__gevAnnotations.attached,
          diagnostics: draw.diagnostics(),
          band:
            window.__godsEyeView.engine.lines
              ?.list?.()
              .find(({ id }) => id === 'gev-draw-preview') ?? null,
        };
      });
    /** Amber pixels of the globe canvas alone (the SVG board hidden). */
    const amber = async () => {
      await page.addStyleTag({
        content: '.gev-screen-whiteboard{visibility:hidden!important}',
      });
      await whenSettled(page);
      const { data, info } = await sharp(
        await page.screenshot({
          clip: { x: 520, y: 300, width: 280, height: 230 },
        }),
      )
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      await page.evaluate(() =>
        document.querySelectorAll('style').forEach((style) => {
          if (style.textContent.includes('gev-screen-whiteboard{visibility'))
            style.remove();
        }),
      );
      let n = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 150 && g > 90 && g < 225 && b < 150 && r - b > 60 && r - g > 15)
          n++;
      }
      return n;
    };
    const openUtilities = () =>
      page.evaluate(() => {
        const panel = document.getElementById('utilities-panel');
        if (panel?.classList.contains('collapsed'))
          document
            .querySelector(
              '.panel-collapse-btn[data-collapse-target="utilities-panel"]',
            )
            ?.click();
      });
    const drawShape = async (shape, points, finish) => {
      await page.evaluate((s) => {
        window.__gevDrawTool.setShape(s);
        window.__gevDrawTool.setColor('amber');
      }, shape);
      for (const [x, y] of points) {
        await page.mouse.click(x, y);
        await whenSettled(page);
      }
      await finish();
      await whenSettled(page);
    };

    await openUtilities();
    await page.waitForSelector('#draw-toggle', { visible: true });
    const bare = await amber();
    await page.click('#draw-toggle');
    await page.waitForFunction(() => window.__gevDrawTool.active);
    const on = await page.evaluate(() => ({
      owner: document.body.classList.contains('gev-drawing'),
    }));
    // Three corners, then the rubber band to the fourth under the pointer.
    await page.evaluate(() => {
      window.__gevDrawTool.setShape('area');
      window.__gevDrawTool.setColor('amber');
    });
    // Each click is a vertex (the rubber band under the pointer never
    // swallows one).
    for (const [index, [x, y]] of AREA.slice(0, 3).entries()) {
      await page.mouse.click(x, y);
      await page.waitForFunction(
        (n) => window.__gevDrawTool.session?.vertices.length === n,
        { timeout: 3000 },
        index + 1,
      );
      await whenSettled(page);
    }
    await page.mouse.move(...AREA[3]);
    await whenSettled(page);
    const sketch = await tool();
    await page.screenshot({ path: `${SHOTS}/navara-sketch.png` });
    await strict.check(
      page,
      'draw',
      'Draw takes the pointer; clicks on the globe are vertices with a live rubber band',
      on.owner &&
        sketch.active &&
        sketch.vertices === 3 &&
        sketch.diagnostics.sceneHandler &&
        sketch.band?.shown === true,
      sketch,
    );
    await page.mouse.click(AREA[3][0], AREA[3][1], { count: 2 });
    await page.waitForFunction(() => window.__gevAnnotations.count() === 1, {
      timeout: 10000,
    });
    await whenSettled(page);
    const drawn = await amber();
    await page.screenshot({ path: `${SHOTS}/navara-area.png` });
    const area = await page.evaluate(() =>
      window.__gevAnnotations.list().map((m) => [m.type, m.color, m.manual]),
    );
    await strict.check(
      page,
      'draw',
      'a double click finishes the area: it joins the board and paints amber on Navara',
      area.length === 1 && area[0][0] === 'area' && drawn - bare > 1500,
      { area, bare, drawn },
    );
    // Enter finishes a line.
    await drawShape(
      'line',
      [
        [600, 560],
        [760, 600],
      ],
      () => page.keyboard.press('Enter'),
    );
    const lines = await page.evaluate(() =>
      window.__gevAnnotations.list().map((m) => m.type),
    );
    await strict.check(
      page,
      'draw',
      'Enter on the map finishes a line',
      lines.length === 2 && lines.includes('route'),
      { lines },
    );
    // Escape: the sketch, then Draw itself.
    await page.evaluate(() => window.__gevDrawTool.setShape('line'));
    await page.mouse.click(620, 360);
    await page.mouse.click(700, 380);
    const before = await tool();
    await page.keyboard.press('Escape');
    const cancelled = await tool();
    await page.keyboard.press('Escape');
    const left = await tool();
    await strict.check(
      page,
      'draw',
      'Escape cancels the sketch, then leaves Draw and gives the pointer back',
      before.vertices === 2 &&
        cancelled.active &&
        cancelled.vertices === 0 &&
        !left.active &&
        !left.diagnostics.sceneHandler &&
        left.diagnostics.pointerOwner == null &&
        left.band?.shown !== true,
      { before, cancelled, left },
    );
    assert.equal(left.board, 2, 'Escape keeps the finished shapes');

    // A switch to Cesium in the middle of a sketch.
    await page.click('#draw-toggle');
    await page.waitForFunction(() => window.__gevDrawTool.active);
    await page.evaluate(() => {
      window.__gevDrawTool.setShape('line');
      window.__gevDrawTool.setColor('green');
    });
    await page.mouse.click(620, 360);
    await page.mouse.click(700, 380);
    assert.equal((await tool()).vertices, 2);
    await strict.pick(page, 'cesium');
    await ready('cesium');
    await whenSettled(page);
    const switched = await tool();
    await page.screenshot({ path: `${SHOTS}/cesium-after-switch.png` });
    await strict.check(
      page,
      'draw',
      'a switch mid-sketch ends the sketch, frees the pointer and keeps shape, colour and the board',
      !switched.active &&
        switched.vertices === null &&
        switched.diagnostics.pointerOwner == null &&
        switched.shape === 'line' &&
        switched.color === 'green' &&
        switched.board === 2 &&
        switched.attached,
      switched,
    );
    // Draw on Cesium too, with the same clicks.
    await openUtilities();
    await page.click('#draw-toggle');
    await page.waitForFunction(() => window.__gevDrawTool.active);
    await drawShape(
      'line',
      [
        [600, 420],
        [760, 450],
      ],
      () => page.keyboard.press('Enter'),
    );
    await page.keyboard.press('Escape');
    const onCesium = await tool();
    await strict.check(
      page,
      'draw',
      'a shape drawn on Cesium joins the same board',
      onCesium.board === 3 && !onCesium.active,
      onCesium,
    );
    await strict.pick(page, 'navara');
    await ready('navara');
    await whenSettled(page);
    const back = await tool();
    const backAmber = await amber();
    await page.screenshot({ path: `${SHOTS}/navara-back.png` });
    await strict.check(
      page,
      'draw',
      'back on Navara the three shapes are on the board and the area paints again',
      back.board === 3 && back.attached && backAmber - bare > 1500,
      { board: back.board, bare, backAmber },
    );
    await page.evaluate(() => window.__gevAnnotations.clear());
    assert.deepEqual(errors, []);
    console.log('PASS Draw on Navara with real clicks and keys');
  },
);
