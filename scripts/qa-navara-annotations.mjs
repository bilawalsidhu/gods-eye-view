#!/usr/bin/env node
import { whenSettled } from './qa/ready.mjs';
// Annotations on both engines, under the strict network policy: the same
// board (a hand-drawn area, a pin in view and a pin on the far side of the
// globe) is drawn on Navara, survives a switch to Cesium and back, and on
// each engine the draped area paints amber pixels on the canvas, the near
// pin's callout shows and the far pin is culled at the horizon.
//
//   node scripts/qa-navara-annotations.mjs http://127.0.0.1:<PORT>/
import assert from 'node:assert/strict';
import fs from 'node:fs';
import sharp from 'sharp';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';

const LAT = 37.7749;
const LON = -122.4194;
const base = localPreview(process.argv[2]);
base.search = '?engine=navara&welcome=0';
base.hash = `v=2&lat=${LAT}&lon=${LON}&alt=7000&heading=0&pitch=-90&roll=0&map=osm&l=`;
const strict = createStrict({ origin: base.origin, layers: ['annotations'] });
const SHOTS = process.env.QA_SHOT_DIR || 'qa-shots/navara-annotations';
fs.mkdirSync(SHOTS, { recursive: true });
// The area: a box around the view centre, clear of the panels.
const RING = [
  [LON - 0.012, LAT - 0.009],
  [LON + 0.012, LAT - 0.009],
  [LON + 0.012, LAT + 0.009],
  [LON - 0.012, LAT + 0.009],
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
    await waitForEngine(page, 'navara');

    /** Amber pixels of the globe canvas alone (the SVG board hidden). */
    const canvasAmber = async () => {
      await page.addStyleTag({
        content: '.gev-screen-whiteboard{visibility:hidden!important}',
      });
      await page.evaluate(() => window.__godsEyeView.requestRender?.('qa'));
      await whenSettled(page);
      const { data, info } = await sharp(
        await page.screenshot({
          clip: { x: 340, y: 180, width: 600, height: 500 },
        }),
      )
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      await page.evaluate(() =>
        document
          .querySelectorAll('style')
          .forEach(
            (style) =>
              style.textContent.includes('gev-screen-whiteboard{visibility') &&
              style.remove(),
          ),
      );
      let amber = 0;
      for (let i = 0; i < data.length; i += info.channels) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r > 150 && g > 90 && g < 225 && b < 150 && r - b > 60 && r - g > 15)
          amber++;
      }
      return amber;
    };
    /** The callout texts the page board shows, and those it hides. */
    const board = () =>
      page.evaluate(() => {
        const out = { shown: [], hidden: [] };
        for (const group of document.querySelectorAll(
          '.gev-screen-whiteboard-svg g.gev-anno',
        )) {
          const text = group.querySelector('.gev-anno-text')?.textContent;
          if (!text) continue;
          const hidden =
            group.style.display === 'none' ||
            getComputedStyle(group).display === 'none';
          (hidden ? out.hidden : out.shown).push(text);
        }
        out.shown.sort();
        out.hidden.sort();
        return out;
      });

    let round = 0;
    const drawn = await page.evaluate(
      async (ring, lat, lon) => {
        const annotations = window.__gevAnnotations;
        window.qaBoard = annotations;
        const result = await annotations.annotate(
          [
            {
              type: 'area',
              manual: true,
              ring,
              label: 'QA Area',
              color: 'amber',
            },
            {
              type: 'pin',
              manual: true,
              latitude: lat + 0.004,
              longitude: lon + 0.006,
              label: 'QA Near',
              color: 'green',
            },
            {
              type: 'pin',
              manual: true,
              latitude: -lat,
              longitude: lon + 180,
              label: 'QA Far',
              color: 'cyan',
            },
          ],
          { persist: true, flyTo: false },
        );
        return {
          drawn: result.drawn,
          attached: annotations.attached,
          handle: window.__godsEyeView.annotations === annotations,
        };
      },
      RING,
      LAT,
      LON,
    );
    await strict.check(
      page,
      'annotations',
      'the board draws three marks on the attached engine and is the debug handle',
      drawn.drawn === 3 && drawn.attached && drawn.handle,
      drawn,
    );

    for (const kind of ['navara', 'cesium', 'navara']) {
      if (
        (await page.evaluate(() => window.__godsEyeView.engine.kind)) !== kind
      ) {
        await strict.switchTo(page, kind);
      }
      await whenSettled(page);
      const state = await page.evaluate(() => ({
        same: window.__gevAnnotations === window.qaBoard,
        count: window.qaBoard.count(),
        attached: window.qaBoard.attached,
        handle: window.__godsEyeView.annotations === window.qaBoard,
      }));
      await strict.check(
        page,
        'annotations',
        'the same session board keeps its three marks and draws on this engine',
        state.same && state.count === 3 && state.attached && state.handle,
        state,
      );
      const seen = await board();
      console.log(kind, 'board', JSON.stringify(seen));
      await strict.check(
        page,
        'annotations',
        'the near callouts show and the far pin is culled at the horizon',
        seen.shown.includes('QA Near') &&
          seen.shown.includes('QA Area') &&
          !seen.shown.includes('QA Far'),
        seen,
      );
      await page.screenshot({
        path: `${SHOTS}/annotations-${kind}-${round}.png`,
      });
      const amber = await canvasAmber();
      // The same view without the marks (hidden from the list).
      const setHidden = (hidden) =>
        page.evaluate((h) => {
          for (const mark of window.qaBoard.list())
            window.qaBoard.setHidden(mark.id, h);
        }, hidden);
      await setHidden(true);
      const bare = await canvasAmber();
      await setHidden(false);
      console.log(kind, 'amber pixels', { bare, amber });
      await strict.check(
        page,
        'annotations',
        'the draped area paints amber on the globe canvas',
        amber - bare > 400,
        { bare, amber },
      );
      round++;
    }

    // Fly-to a mark goes through the engine's camera on Navara.
    const flight = await page.evaluate(async () => {
      const { engine } = window.__godsEyeView;
      const before = engine.camera.height();
      const area = window.qaBoard.list().find((m) => m.label === 'QA Area');
      const ok = window.qaBoard.frame(area.id);
      return { ok, before };
    });
    await whenSettled(page);
    flight.after = await page.evaluate(() =>
      window.__godsEyeView.engine.camera.height(),
    );
    await strict.check(
      page,
      'annotations',
      'framing a mark flies the Navara camera to it',
      flight.ok && Math.abs(flight.after - flight.before) > 100,
      flight,
    );
    // Hidden from the list: the board and the canvas let it go.
    const hidden = await page.evaluate(async () => {
      for (const mark of window.qaBoard.list())
        window.qaBoard.setHidden(mark.id, true);
      return window.qaBoard.list().every((m) => m.hidden);
    });
    await whenSettled(page);
    const afterHide = await board();
    await strict.check(
      page,
      'annotations',
      'hidden marks leave the board',
      hidden && afterHide.shown.length === 0,
      afterHide,
    );
    await page.evaluate(() => window.qaBoard.clear());
    assert.deepEqual(errors, []);
    console.log(
      'PASS annotations drawn, culled and kept across engine switches',
    );
  },
);
