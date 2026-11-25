#!/usr/bin/env node
/**
 * qa-aircraft-views.mjs: screenshots of the aircraft view sheet in the app.
 *
 * Seeds synthetic Military Flights contacts (Flights with `--layer flights`),
 * one row per class and eight courses across. Shots from above, below and
 * several oblique angles show the nose direction, wing shape and underside.
 * The sheet must load, or fail with `--block-sheet` for the glyph fallback.
 *
 * Run:  node scripts/qa-aircraft-views.mjs --url http://localhost:4173 [--out qa-shots/views]
 *         [--layer military|flights] [--block-sheet] [--headful] [--gpu] (default: SwiftShader)
 *         [--orbit [--orbit-step 2] [--orbit-pitch -35]]
 * Needs the dev server (`npm run dev`).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { ICON_VIEWS } from '../src/data/iconSet.js';
import { stubPlanespotters } from './qa-photo-stub.mjs';

const argv = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const APP_URL = opt('--url', 'http://localhost:4173');
const OUT = path.resolve(opt('--out', 'qa-shots/views'));
const HEADFUL = argv.includes('--headful');
// `military` (amber, every class by type code) or `flights` (white, the
// classes an ADS-B emitter category gives).
const LAYER = opt('--layer', 'military');
// Fail the sheet's request: the contacts should draw their flat glyphs.
const BLOCK_SHEET = argv.includes('--block-sheet');
const GPU = argv.includes('--gpu');

// A type code for each icon class (aircraftClass.js).
const CLASSES = [
  ['airliner', 'A320'],
  ['widebody', 'C17'],
  ['quadjet', 'B744'],
  ['turboprop', 'C130'],
  ['light', 'C172'],
  ['glider', 'DISC'],
  ['fastjet', 'F16'],
  ['bizjet', 'GLF4'],
  ['uav', 'Q9'],
  ['helicopter', 'H60'],
];
// The classes a flight's emitter category gives (OpenSky has no type code).
const CATEGORIES = [
  ['airliner', 4],
  ['widebody', 6],
  ['light', 2],
  ['fastjet', 7],
  ['glider', 9],
  ['helicopter', 8],
];
const ROWS = LAYER === 'flights' ? CATEGORIES : CLASSES;
const COURSES = [0, 45, 90, 135, 180, 225, 270, 315];
const CENTRE = { lon: -97.74, lat: 30.3 };
const STEP_DEG = 0.03;
const ALT_FT = 12000;

const contacts = [];
ROWS.forEach(([klass, type], row) =>
  COURSES.forEach((courseDeg, column) =>
    contacts.push({
      hex: `ee${row.toString(16)}${column.toString(16)}00`.slice(0, 6),
      flight: `${klass.slice(0, 4).toUpperCase()}${courseDeg}`,
      t: type,
      klass,
      courseDeg,
      lon: CENTRE.lon + (column - (COURSES.length - 1) / 2) * STEP_DEG,
      lat: CENTRE.lat - (row - (ROWS.length - 1) / 2) * STEP_DEG,
      altFt: ALT_FT,
    }),
  ),
);

// Each shot: where the camera looks from. `heading` is the way it looks
// (degrees clockwise from north), `pitch` down from level, `rangeKm` from
// the grid's centre at the contacts' height.
const SHOTS = [
  { name: '1-above', heading: 0, pitch: -90, rangeKm: 44 },
  { name: '2-tilt30-north', heading: 0, pitch: -60, rangeKm: 46 },
  { name: '3-tilt55-north', heading: 0, pitch: -35, rangeKm: 50 },
  { name: '4-tilt55-east', heading: 90, pitch: -35, rangeKm: 50 },
  { name: '5-tilt55-southwest', heading: 225, pitch: -35, rangeKm: 50 },
  { name: '6-tilt75-north', heading: 0, pitch: -15, rangeKm: 52 },
  { name: '7-below-north', heading: 0, pitch: 12, rangeKm: 15.5 },
];

// `--orbit`: the camera swung round the grid a little at a time, a frame
// each step, to watch the sprites turn from one view to the next.
const ORBIT_STEP_DEG = Number(opt('--orbit-step', 2));
const ORBIT_SHOTS = Array.from(
  { length: Math.floor(90 / ORBIT_STEP_DEG) + 1 },
  (_, i) => ({
    name: `orbit-${String(i).padStart(3, '0')}`,
    heading: i * ORBIT_STEP_DEG,
    pitch: Number(opt('--orbit-pitch', -35)),
    rangeKm: 50,
    settleMs: i === 0 ? 6000 : 900,
  }),
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    args: [
      ...(GPU ? [] : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1500,1000',
    ],
  });
  const errors = [];
  let errorCount = 0;
  const noteError = (text) => {
    errorCount += 1;
    if (errors.length < 20)
      errors.push(
        String(text)
          .slice(0, 500)
          .replace(
            /\p{Cc}/gu,
            (c) => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`,
          ),
      );
  };
  try {
    const page = await browser.newPage();
    await stubPlanespotters(page);
    await page.setViewport({ width: 1500, height: 1000, deviceScaleFactor: 2 });
    page.on('console', (msg) => {
      if (
        msg.type() === 'error' &&
        !/Failed to load resource/i.test(msg.text())
      )
        noteError(msg.text());
    });
    page.on('pageerror', (error) => noteError(`pageerror: ${error.message}`));

    if (BLOCK_SHEET) {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        if (request.isInterceptResolutionHandled()) return;
        if (/\/sprites\/aircraft-views\./.test(request.url())) request.abort();
        else request.continue();
      });
    }
    await page.evaluateOnNewDocument(
      (seed) => {
        const realFetch = window.fetch.bind(window);
        // Each contact flies its course, slowly: a feed whose fixes stand
        // still while claiming a track makes the layers work a heading out
        // of no movement, and the contacts turn north over a run.
        const SPEED_MPS = 6;
        const started = Date.now();
        const at = (c) => {
          const flown = (SPEED_MPS * (Date.now() - started)) / 1000;
          const course = (c.courseDeg * Math.PI) / 180;
          return {
            lat: c.lat + (flown * Math.cos(course)) / 111320,
            lon:
              c.lon +
              (flown * Math.sin(course)) /
                (111320 * Math.cos((c.lat * Math.PI) / 180)),
          };
        };
        const json = (body) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        window.fetch = (input, init) => {
          const url =
            typeof input === 'string' ? input : (input && input.url) || '';
          if (url.includes('/api/openai/hud-summary'))
            return Promise.resolve(json({ summary: 'view QA' }));
          if (url.includes('/api/military/track'))
            return Promise.resolve(
              json({ timestamp: Math.floor(Date.now() / 1000), trace: [] }),
            );
          if (url.includes('/api/military'))
            return Promise.resolve(
              json({
                msg: 'No error',
                now: Date.now(),
                ac: (seed.layer === 'military' ? seed.contacts : []).map(
                  (c) => ({
                    hex: c.hex,
                    flight: c.flight,
                    ...at(c),
                    alt_baro: c.altFt,
                    track: c.courseDeg,
                    gs: SPEED_MPS * 1.9438,
                    t: c.t,
                    r: `QA-${c.hex.slice(-3)}`,
                    ownOp: 'QA',
                    seen_pos: 0,
                  }),
                ),
              }),
            );
          if (url.includes('/api/flights/track'))
            return Promise.resolve(json({ path: [] }));
          if (url.includes('/api/flights') && seed.layer === 'flights') {
            const now = Math.floor(Date.now() / 1000);
            return Promise.resolve(
              json({
                time: now,
                states: seed.contacts.map((c) => [
                  c.hex,
                  c.flight,
                  'QA',
                  now,
                  now,
                  at(c).lon,
                  at(c).lat,
                  c.altFt * 0.3048,
                  false,
                  SPEED_MPS,
                  c.courseDeg,
                  0,
                  null,
                  null,
                  null,
                  false,
                  0,
                  c.t,
                ]),
              }),
            );
          }
          if (url.includes('/api/adsbdb/'))
            return Promise.resolve(json({ found: false }));
          return realFetch(input, init);
        };
      },
      { layer: LAYER, contacts },
    );

    console.log(`Loading ${new URL(APP_URL).origin} ...`);
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      const reason =
        /net::ERR_[A-Z_]+/.exec(String(error?.message))?.[0] ??
        error?.name ??
        'error';
      throw new Error(`could not load ${new URL(APP_URL).origin} (${reason})`);
    }
    await page.waitForFunction(
      () => window.__godsEyeView?.viewer && window.__godsEyeView?.dataManager,
      { timeout: 60000, polling: 200 },
    );
    const seeded = await page.evaluate(async (name) => {
      const { dataManager, viewer } = window.__godsEyeView;
      await dataManager.setEnabled(name, true);
      const layer = dataManager.layers.get(name).module;
      for (let i = 0; i < 4; i++) await layer.update(viewer);
      window.__viewQaDriver = setInterval(() => layer.update(viewer), 8000);
      return layer.getStats().count;
    }, LAYER);
    console.log(`  ${LAYER} contacts: ${seeded}/${contacts.length}`);
    if (seeded !== contacts.length)
      throw new Error(
        `the ${LAYER} layer took ${seeded} of ${contacts.length} contacts`,
      );
    // Past the layer's render delay, so every contact is drawn.
    await sleep(20000);
    // Wait for every set's sheet to settle.
    const settleBy = Date.now() + 120000;
    let views;
    for (;;) {
      views = await page.evaluate((viewsFlag) => {
        const count = { ready: 0, failed: 0, other: 0, rows: 0, fallbacks: 0 };
        function visit(p) {
          if (typeof p.viewsState === 'function' && p._views?.()) {
            const state = p.viewsState();
            if (state === 'ready') count.ready += 1;
            else if (state === 'failed') count.failed += 1;
            else count.other += 1;
            const set = p.set;
            for (let row = 0; row < set.count; row++) {
              if (!set.shown(row) || !(set.flags(row) & viewsFlag)) continue;
              count.rows += 1;
              const slot = set.imageNear(row);
              if (slot >= 0 && p._slots?.[slot]?.z > 0) count.fallbacks += 1;
            }
          }
          if (typeof p.get === 'function')
            for (let i = 0; i < p.length; i++) visit(p.get(i));
        }
        visit(window.__godsEyeView.viewer.scene.primitives);
        return count;
      }, ICON_VIEWS);
      if (
        (views.ready + views.failed > 0 && !views.other) ||
        Date.now() > settleBy
      )
        break;
      await sleep(1000);
    }
    const sets = views.ready + views.failed + views.other;
    console.log(
      `  view sheet: ${views.ready} ready, ${views.failed} failed, ${views.other} other`,
    );
    const expected = BLOCK_SHEET ? views.failed : views.ready;
    if (!sets || expected !== sets)
      throw new Error(
        `View sheet not ${BLOCK_SHEET ? 'failed' : 'ready'} in every set`,
      );
    if (!views.rows) throw new Error('No contact is drawn from the view sheet');
    if (BLOCK_SHEET) {
      console.log(`  fallback glyphs: ${views.fallbacks}/${views.rows} view rows`);
      if (views.fallbacks !== views.rows)
        throw new Error('Not every view row draws its loaded fallback glyph');
    }

    for (const shot of argv.includes('--orbit') ? ORBIT_SHOTS : SHOTS) {
      await page.evaluate(
        ({ shot, centre, altM }) => {
          const { viewer } = window.__godsEyeView;
          const Cartesian3 = viewer.camera.position.constructor;
          const heading = (shot.heading * Math.PI) / 180;
          const pitch = (shot.pitch * Math.PI) / 180;
          const range = shot.rangeKm * 1000;
          // The eye sits `range` back along the way it looks.
          const east = -range * Math.sin(heading) * Math.cos(pitch);
          const north = -range * Math.cos(heading) * Math.cos(pitch);
          const up = -range * Math.sin(pitch);
          const lat = centre.lat + north / 111320;
          const lon =
            centre.lon +
            east / (111320 * Math.cos((centre.lat * Math.PI) / 180));
          viewer.camera.setView({
            destination: Cartesian3.fromDegrees(
              lon,
              lat,
              Math.max(50, altM + up),
            ),
            orientation: { heading, pitch, roll: 0 },
          });
          viewer.scene.requestRender();
        },
        { shot, centre: CENTRE, altM: ALT_FT * 0.3048 },
      );
      await sleep(shot.settleMs ?? 6000);
      // The globe's own canvas, read right after a render: no HUD, dialogs
      // or label overlays in the way.
      const png = await page.evaluate(() => {
        const { viewer } = window.__godsEyeView;
        viewer.scene.render();
        return viewer.scene.canvas.toDataURL('image/png');
      });
      const file = path.join(OUT, `${shot.name}.png`);
      fs.writeFileSync(file, Buffer.from(png.split(',')[1], 'base64'));
      console.log(`  wrote ${file}`);
    }
  } finally {
    await browser.close();
  }
  if (errorCount) {
    console.log(`\nConsole errors (${errorCount}):`);
    for (const error of errors) console.log(`  ${error}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
