#!/usr/bin/env node
import {
  boundPageEvaluations,
  reportTransitVisibility,
  restoreRetainedTransit,
  sampleTransitPixels,
  readTransitFleetStyle,
} from './qa-transit-browser.mjs';
import {
  BOSTON,
  chooseLiveCities,
  selectStyle,
  detectOn,
} from './qa-transit-controls.mjs';
import { runFleetBudgets, runBostonMatrix } from './qa-transit-scenes.mjs';
/**
 * Browser proof for the Transit layer against a running app.
 *
 *   npm run qa:transit                       (defaults to http://localhost:4173)
 *   QA_BASE_URL=http://localhost:4305 node scripts/qa-transit.mjs
 *
 * Drives the real layer toggle and the real CONTEXT chooser, watches the real
 * /api/transit traffic, proves vehicles move between polls in the SCENE (not
 * just in the JSON), captures street-level shots in two cities, and proves that
 * turning the layer off stops every request and leaves nothing rendered.
 *
 * Screenshots land in the gitignored qa-shots/ directory unless QA_SHOTS says
 * otherwise. Needs a running server; the feeds are keyless, so a keyless boot
 * exercises the same paths.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import puppeteer from 'puppeteer';
import { createTransitHistory } from '../server/providers/transitHistory.js';
import { DETECTION_THEME_MAP } from '../src/overlays/worldOverlayTokens.js';
import { transitModeTier } from '../src/data/transitPresetStyle.js';

import {
  reduceAnchor,
  reduceScenario,
  reduceSensorContrast,
  reduceScriptedMotion,
  reduceMotion,
  reduceFleet,
} from '../src/layers/transit/qaMetrics.js';

const BASE = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOTS = process.env.QA_SHOTS || 'qa-shots/transit';
const TAG = process.env.QA_TAG || 'keyed';
/** Which sections to run: all, or a comma list of cities,playback,disable,context. */
const SECTIONS = new Set((process.env.QA_SECTIONS || 'all').split(','));
const runs = (section) => SECTIONS.has('all') || SECTIONS.has(section);
const CITIES = chooseLiveCities();

let failures = 0;
let unexercised = 0;
/**
 * A check has three outcomes. PASS and FAIL are what they say. UNEXERCISED
 * means the run could not put the claim to the test — a parked fleet has no
 * motion to judge — and it is reported as its own word rather than as a
 * pass, because a pass that proved nothing is how a broken interpolation
 * sailed through this harness once.
 */
const check = (
  name,
  passed,
  detail = '',
  { unexercised: idle = false } = {},
) => {
  const word = idle ? 'UNEXERCISED' : passed ? 'PASS' : 'FAIL';
  console.log(`[${word}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (idle) {
    unexercised += 1;
    failures += 1;
  } else if (!passed) failures += 1;
};
const renderingSource = await readFile(
  new URL('../src/layers/transit/rendering.js', import.meta.url),
  'utf8',
);
const frameSource = renderingSource
  .split('function onPreRender()')[1]
  .split('const occluder')[0];
check(
  'frame pass does not scan the fleet or copy the moving set',
  !/_vehicles\.values|\[\.\.\.state\._moving\]/.test(frameSource),
);
const palette = {
  bus: '#5EF08A',
  tram: '#FFC24A',
  subway: '#FF4538',
  rail: '#D9A6FF',
  ferry: '#5FD6FF',
  unknown: '#D8DDE5',
};
check(
  'all preset bracket themes preserve the six mode colours',
  Object.values(DETECTION_THEME_MAP).every((theme) =>
    Object.entries(palette).every(
      ([mode, color]) =>
        theme.tiers[transitModeTier(mode)].toUpperCase() === color,
    ),
  ),
);
check(
  'all required sections enabled',
  SECTIONS.has('all'),
  'Partial runs are diagnostic and cannot pass acceptance.',
);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Hex → [r,g,b]. */
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgbDistance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/**
 * Rendered pixels of the scene and of the detection surface around each
 * visible transit sprite: centre and darkest/brightest ring luma from the
 * WebGL canvas (the app preserves its drawing buffer), and the dominant
 * opaque colour painted on the detection surface in a bracket-sized window.
 * Sprites closer than 44 px to another sprite are skipped so a ring is not
 * read off a neighbour.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<{key:string, mode:string, centre:number, ringMin:number, ringMax:number, bracket:number[]|null, x:number, y:number}>>}
 */
const sampleRendered = (page) => sampleTransitPixels(page, palette);

/**
 * The rendered position of every VISIBLE transit billboard, read back through
 * Cesium. Visible only: off-screen vehicles take their newest fix directly, so
 * including them would let hidden vehicles snapping stand in for motion a
 * person can see.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<{key: string, lat: number, lon: number}>>}
 */
/**
 * Window-space position and billboard rotation of every visible transit
 * sprite. Orientation is a screen-space claim, so it has to be checked in
 * screen space.
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array<{key: string, x: number, y: number, rotation: number}>>}
 */
async function sampleScreen(page) {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest();
    const scene = app.viewer.scene;
    const canvas = scene.canvas;
    // The app exposes no `window.Cesium`, so the projection is done here in
    // plain numbers: Cesium matrices are column-major arrays of 16 doubles,
    // and window coordinates are the standard clip -> NDC -> viewport walk.
    const view = scene.camera.viewMatrix;
    const proj = scene.camera.frustum.projectionMatrix;
    const mul = (m, v) => [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
      m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
    ];
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const out = [];
    for (const entry of state._vehicles.values()) {
      if (!entry.marker || entry.marker.show === false) continue;
      const p = entry.marker.position;
      const clip = mul(proj, mul(view, [p.x, p.y, p.z, 1]));
      if (!(clip[3] > 0)) continue;
      const ndcX = clip[0] / clip[3];
      const ndcY = clip[1] / clip[3];
      out.push({
        entityCount: app.viewer.entities.values.length,
        key: entry.key,
        x: (ndcX * 0.5 + 0.5) * width,
        y: (1 - (ndcY * 0.5 + 0.5)) * height,
        rotation: entry.marker.rotation,
        pollSeq: entry.pollSeq,
        segment:
          entry.from && entry.to ? `${entry.from.t}-${entry.to.t}` : null,
      });
      if (out.length >= 200) break;
    }
    return out;
  });
}

async function sampleVisible(page) {
  return page.evaluate(() => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest();
    const Cartographic = app.viewer.camera.positionCartographic.constructor;
    return [...state._vehicles.values()]
      .filter((entry) => entry.marker && entry.marker.show !== false)
      .slice(0, 200)
      .map((entry) => {
        const carto = Cartographic.fromCartesian(entry.marker.position);
        return {
          key: entry.key,
          lat: (carto.latitude * 180) / Math.PI,
          lon: (carto.longitude * 180) / Math.PI,
          gliding: state._moving.has(entry),
          // Which poll and which displayed segment this reading belongs to:
          // two readings that straddle a poll or a segment change are not
          // evidence about interpolation, whatever the elapsed time says.
          pollSeq: entry.pollSeq,
          segment:
            entry.from && entry.to ? `${entry.from.t}-${entry.to.t}` : null,
        };
      });
  });
}

// Accelerate the storage clock without collecting a live feed in the background.
const historyProbe = createTransitHistory({
  sweep: false,
  storage: { bytes: 0, keys: 0, stores: new Set() },
  limits: { feedBytes: 128000, processBytes: 128000 },
});
const retainedSizes = [];
for (let now = 0; now <= 7200000; now += 15000) {
  historyProbe.ingest(
    { id: 'probe', historyRetention: true, defaultMode: 'bus' },
    Array.from({ length: 12 }, (_, i) => ({
      id: String(i),
      timestamp: now / 1000,
      lat: 42,
      lon: -71,
    })),
    now,
  );
  if (now >= 900000)
    retainedSizes.push(historyProbe.diagnostics().allocatedBytes);
}
check(
  'two-hour proxy history allocation plateaus',
  Math.max(...retainedSizes) === Math.min(...retainedSizes) &&
    Math.max(...retainedSizes) <= 128000,
  `${retainedSizes.length} warmed samples, ${Math.max(...retainedSizes)} allocated bytes`,
);
historyProbe.clear();
await mkdir(SHOTS, { recursive: true });

const browser = await puppeteer.launch({
  headless: false,
  protocolTimeout: 150000,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1920,1080',
    '--enable-precise-memory-info',
  ],
});
const page = await browser.newPage();
boundPageEvaluations(page);
await page.setViewport({ width: 1920, height: 1080 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('console', (message) => {
  if (message.text().startsWith('TRANSIT_SAMPLER')) console.log(message.text());
});
const transitRequests = [];
page.on('request', (request) => {
  if (request.url().includes('/api/transit')) {
    transitRequests.push({ at: Date.now(), url: request.url() });
  }
});

const shot = (name, caption) =>
  page
    .screenshot({ path: `${SHOTS}/${name}`, type: 'jpeg', quality: 82 })
    .then(() => {
      console.log(`  shot ${name} — ${caption}`);
    });

const view = (city) =>
  `${BASE}/?welcome=0#lat=${city.lat}&lon=${city.lon}&alt=600&heading=${city.heading}&pitch=-45`;

try {
  await page.goto(view(BOSTON), { waitUntil: 'domcontentloaded' });
  // Ready when the catalog is registered and its rows exist. (The manager's
  // private panel handle moved into a presentation facade; waiting on it here
  // was waiting for something that no longer exists.)
  await page.waitForFunction(
    () =>
      Boolean(window.__godsEyeView?.dataManager?.layers?.size) &&
      Boolean(document.querySelector('[data-layer-id="transit"]')),
    { timeout: 90_000 },
  );
  await wait(6_000);

  // The Data Layers panel starts collapsed; a user opens it before toggling.
  const expanded = await page.$eval(
    '#data-panel .panel-collapse-btn',
    (button) => {
      if (button.getAttribute('aria-expanded') === 'true') return true;
      button.click();
      return false;
    },
  );
  if (!expanded) await wait(800);
  check(
    'the Data Layers panel opens from its own header button',
    await page.$eval(
      '#data-panel .panel-collapse-btn',
      (b) => b.getAttribute('aria-expanded') === 'true',
    ),
  );

  // Record what the layer hands the shared overlay host, so the card check can
  // quote the operator's own words rather than assert an internal key was set.
  await page.evaluate(() => {
    window.__gevTransitCards = new Map();
    const layer = window.__godsEyeView.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest();
    const host = state.DEFAULT_OVERLAY_HOST;
    layer._setTransitOverlayHostForTest({
      setEntries(sourceId, entries, options) {
        for (const entry of entries || []) {
          window.__gevTransitCards.set(entry.id, {
            title: entry.title,
            details: entry.details,
          });
        }
        return host.setEntries(sourceId, entries, options);
      },
      setVisible: host.setVisible,
      clearSource(sourceId) {
        window.__gevTransitCards.clear();
        return host.clearSource(sourceId);
      },
    });
  });

  const row = '[data-layer-id="transit"]';
  const hasRow = await page.$(row);
  check('the Transit layer has a row in the layer panel', Boolean(hasRow));
  await page.$eval(row, (element) =>
    element.scrollIntoView({ block: 'center' }),
  );
  await wait(400);
  const before = transitRequests.length;
  await page.click(`${row} .data-toggle-btn`);
  await page.waitForFunction(
    () => window.__godsEyeView.dataManager.isEnabled('transit'),
    { timeout: 20_000 },
  );
  check(
    'clicking the row button enables the layer and starts real traffic',
    transitRequests.length > before,
    `${transitRequests.length - before} request(s)`,
  );

  await page.evaluate(() => {
    window.__transitRenderErrors = [];
    window.__godsEyeView.viewer.scene.renderError.addEventListener(
      (scene, error) => window.__transitRenderErrors.push(error.message),
    );
  });
  for (const city of runs('cities') ? CITIES : []) {
    console.log(`\n== ${city.label} ==`);
    // City-wide first: enough altitude to see the fleet as a fleet.
    await page.evaluate((c) => {
      const camera = window.__godsEyeView.viewer.camera;
      const Cartographic = camera.positionCartographic.constructor;
      camera.setView({
        destination: Cartographic.toCartesian(
          Cartographic.fromDegrees(c.lon, c.lat - 0.03, 3_500),
        ),
        orientation: { heading: 0, pitch: (-40 * Math.PI) / 180, roll: 0 },
      });
    }, city);
    await page.waitForFunction(
      () =>
        (window.__godsEyeView.dataManager.layers
          .get('transit')
          .module.getStats().count || 0) > 0,
      { timeout: 90_000 },
    );
    await wait(9_000);
    const fleet = await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('transit').module;
      return {
        count: layer._transitStateForTest()._vehicles.size,
        stats: layer.getStats(),
      };
    });
    check(
      `${city.label}: vehicles are rendered`,
      fleet.count >= 20,
      `${fleet.count} vehicles, coverage "${fleet.stats.coverage}"`,
    );
    await shot(
      `${TAG}-${city.id}-00-fleet.jpg`,
      `${city.label} from 3.5 km — ${fleet.count} vehicles across the metro`,
    );

    // Street level: 600 m up, 45 degrees down, framed on a real vehicle so the
    // shot shows what a user sees when they drop in on one.
    const framed = await page.evaluate((c) => {
      const app = window.__godsEyeView;
      const camera = app.viewer.camera;
      const Cartographic = camera.positionCartographic.constructor;
      const state = app.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      let best = null;
      for (const entry of state._vehicles.values()) {
        const d = Math.hypot(entry.to.lat - c.lat, entry.to.lon - c.lon);
        if (!best || d < best.d)
          best = { d, lat: entry.to.lat, lon: entry.to.lon, key: entry.key };
      }
      if (!best) return null;
      // Camera 600 m back along the heading, 600 m up, looking 45 degrees down:
      // the vehicle lands in the middle of the frame.
      const heading = (c.heading * Math.PI) / 180;
      const lat = best.lat - (600 * Math.cos(heading)) / 111_320;
      const lon =
        best.lon -
        (600 * Math.sin(heading)) /
          (111_320 * Math.cos((best.lat * Math.PI) / 180));
      camera.setView({
        destination: Cartographic.toCartesian(
          Cartographic.fromDegrees(lon, lat, 600),
        ),
        orientation: { heading, pitch: (-45 * Math.PI) / 180, roll: 0 },
      });
      return best;
    }, city);
    check(
      `${city.label}: a vehicle to fly to`,
      Boolean(framed),
      framed?.key || 'none',
    );
    await wait(9_000);

    const first = await page.evaluate(() => {
      const app = window.__godsEyeView;
      const layer = app.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest();
      const Cartographic = app.viewer.camera.positionCartographic.constructor;
      return {
        count: state._vehicles.size,
        stats: layer.getStats(),
        // The RENDERED primitive position, read back through Cesium — not the
        // fix the layer is aiming at. A layer that never moved a point would
        // still show two different `entry.to` values, so comparing those would
        // prove the data changed, not that anything on screen did.
        // VISIBLE markers only. Off-screen vehicles take their newest fix
        // directly — that is the whole point of the view gate — so sampling
        // them would let a layer whose visible interpolation is broken pass
        // this check on the strength of hidden vehicles snapping.
        sample: [...state._vehicles.values()]
          .filter((entry) => entry.marker && entry.marker.show !== false)
          .slice(0, 200)
          .map((entry) => {
            const carto = Cartographic.fromCartesian(entry.marker.position);
            return {
              key: entry.key,
              lat: (carto.latitude * 180) / Math.PI,
              lon: (carto.longitude * 180) / Math.PI,
            };
          }),
      };
    });

    // Click a vehicle that is actually on screen, recomputing its position
    // immediately before each attempt — these dots are gliding.
    let selected = null;
    for (let attempt = 0; attempt < 6 && !selected; attempt += 1) {
      const target = await page.evaluate((skip) => {
        const app = window.__godsEyeView;
        const state = app.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
        const scene = app.viewer.scene;
        const seen = [];
        for (const entry of state._vehicles.values()) {
          const screen = scene.cartesianToCanvasCoordinates(
            entry.marker.position,
          );
          if (
            screen &&
            screen.x > 360 &&
            screen.x < scene.canvas.clientWidth - 120 &&
            screen.y > 120 &&
            screen.y < scene.canvas.clientHeight - 160
          ) {
            seen.push({
              key: entry.key,
              x: Math.round(screen.x),
              y: Math.round(screen.y),
            });
          }
        }
        return seen[skip] || null;
      }, attempt);
      if (!target) break;
      await page.mouse.click(target.x, target.y);
      await wait(900);
      selected = await page.evaluate(() => {
        const app = window.__godsEyeView;
        const key = app.dataManager.layers
          .get('transit')
          .module._transitStateForTest()._selectedKey;
        if (!key) return null;
        // A selected key is bookkeeping. The claim is that the user SEES a
        // card, and these cards are painted onto the shared overlay CANVAS
        // rather than built from DOM nodes — so the proof is the operator's own
        // words the layer published, plus pixels that actually landed there.
        const published = window.__gevTransitCards?.get(key) || null;
        const canvas = document.getElementById('world-overlay-canvas');
        let painted = 0;
        if (canvas?.width) {
          const context = canvas.getContext('2d', { willReadFrequently: true });
          const pixels = context.getImageData(
            0,
            0,
            canvas.width,
            canvas.height,
          ).data;
          for (let i = 3; i < pixels.length; i += 64) {
            if (pixels[i] > 8) painted += 1;
          }
        }
        return { key, published, painted };
      });
      if (selected && (!selected.published || selected.painted === 0)) {
        selected = null;
      }
    }
    const cardLines = selected
      ? [selected.published.title, ...(selected.published.details || [])]
      : [];
    check(
      `${city.label}: clicking a vehicle raises a card with its details on screen`,
      cardLines.length >= 3 &&
        /Route |Vehicle /.test(cardLines[0] || '') &&
        cardLines.some((line) => /Reported /.test(line)) &&
        selected.painted > 0,
      selected
        ? `${selected.key} — "${cardLines.slice(0, 4).join(' / ')}" over ${selected.painted} painted overlay samples`
        : 'no vehicle card became visible',
    );
    // DETECT is on by default at DENSE. Prove the overlay actually boxes and
    // labels transit contacts rather than ignoring them, which is what the
    // owner found: the layer drew dots and the sensor overlay looked past them.
    const detect = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const layer = gev.dataManager.layers.get('transit').module;
      const objects = layer.getDetectableObjects({ maxCount: 200 });
      const button = document.getElementById('detection-toggle');
      return {
        mode: (button?.textContent || '').replace(/\s+/g, ' ').trim(),
        count: objects.length,
        sample: objects.slice(0, 3).map((o) => `${o.id}/${o.metric || ''}`),
        types: [...new Set(objects.map((o) => o.type))],
        labelled: objects.filter((o) => o.id && o.metric).length,
        skipped: objects.filter((o) => o.skipLabel).length,
      };
    });
    // What the host DOES with these is pinned by the detection-host unit test,
    // which drives the real painter and reads the route and mode back off the
    // canvas. Here the claim is narrower and fully attributable: the layer
    // offers DETECT properly formed contacts, which is precisely what it used
    // to offer none of.
    check(
      `${city.label}: the layer offers DETECT real contacts, not bare dots`,
      detect.count > 0 &&
        detect.types.length === 1 &&
        detect.types[0] === 'VEH' &&
        detect.labelled === detect.count,
      `${detect.count} contacts, all labelled, e.g. ${detect.sample.join(', ')} (DETECT ${detect.mode})`,
    );

    // The glyphs themselves: modes must not all be one shape.
    const sprites = await page.evaluate(() => {
      const state = window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      const images = new Map();
      for (const entry of state._vehicles.values()) {
        if (!entry.marker?.show) continue;
        // Compare the WHOLE data URI: every glyph shares a long base64 prefix,
        // so a truncated comparison says they are all the same picture.
        images.set(entry.mode, String(entry.marker.image || ''));
      }
      return {
        modes: [...images.keys()],
        distinct: new Set(images.values()).size,
        glyphBytes: [...images.values()].map((uri) => uri.length),
        billboards: [...state._vehicles.values()].filter((e) => e.marker)
          .length,
        shown: state._shownCount,
      };
    });
    check(
      `${city.label}: vehicles draw as mode sprites, not plain dots`,
      sprites.distinct === sprites.modes.length && sprites.modes.length > 0,
      `${sprites.modes.join(', ')} → ${sprites.distinct} distinct glyph(s) of sizes ${sprites.glyphBytes.join('/')}; ${sprites.shown} shown of ${sprites.billboards}`,
    );

    await shot(
      `${TAG}-${city.id}-01-vehicles.jpg`,
      `${city.label} at 600 m, 45° pitch — ${first.count} vehicles in the layer, selected card on the one in frame`,
    );

    // ---- Rendered appearance under the sensor presets (first active live city) --------
    // In-scene sprites pass through the post-FX chain; what matters is what
    // reaches the screen. DETECT on, then each preset the owner tested:
    // pixels of the sprite core and its ring from the WebGL canvas, the
    // colour painted for its bracket on the detection surface, and one
    // screenshot per preset for the diary.
    if (city.id === CITIES[0].id) {
      console.log('\n== rendered appearance ==');
      const profile = await detectOn(page);
      check(
        'DETECT reaches the dense profile through its own button',
        profile === 'DENSE',
        profile,
      );
      const themeFor = (style) =>
        DETECTION_THEME_MAP[style] || DETECTION_THEME_MAP._default;
      const presets = [
        { name: 'normal', style: 'normal', params: {}, hot: null },
        {
          name: 'thermal-whot',
          style: 'thermal',
          params: { 'WHOT/BHOT': 0, Ironbow: 0 },
          hot: 'white',
        },
        {
          name: 'thermal-bhot',
          style: 'thermal',
          params: { 'WHOT/BHOT': 1, Ironbow: 0 },
          hot: 'black',
        },
        {
          name: 'thermal-ironbow',
          style: 'thermal',
          params: { 'WHOT/BHOT': 0, Ironbow: 1 },
          hot: 'white',
        },
        {
          name: 'surveillance',
          style: 'surveillance',
          params: {},
          hot: 'white',
        },
        { name: 'noir', style: 'noir', params: {}, hot: 'white' },
        { name: 'retro', style: 'retro', params: {}, hot: null },
      ];
      await selectStyle(page, 'normal');
      const baseline = await page.evaluate(readTransitFleetStyle, {
        resetSelection: true,
      });
      for (const preset of presets) {
        const how = await selectStyle(page, preset.style, preset.params);
        await wait(1_200);
        const styling = await page.evaluate(() =>
          window.__godsEyeView.dataManager.layers
            .get('transit')
            .module._transitStylingForTest(),
        );
        const rendered = await sampleRendered(page);
        await shot(
          `${TAG}-boston-style-${preset.name}.jpg`,
          `${city.label} at street level under ${preset.name}, DETECT on — ${rendered.length} isolated sprites sampled (style set via ${how})`,
        );
        const modes = new Set(rendered.map((r) => r.mode));
        if (preset.hot) {
          const contrast = reduceSensorContrast(
            rendered,
            preset.hot,
            preset.style,
          );
          check(
            `${preset.name}: sprite cores have the expected sensor contrast`,
            contrast.pass,
            JSON.stringify(contrast),
            { unexercised: rendered.length < 6 },
          );
          check(
            `${preset.name}: the layer styled its sprites for ${preset.style}`,
            styling.stylePreset === preset.style,
            JSON.stringify(styling),
          );
        }
        // Brackets: the detection surface paints each contact in its tier
        // colour, which must be the mode's colour for this theme.
        const theme = themeFor(preset.style);
        const matched = rendered.filter(
          (r) =>
            r.bracket &&
            rgbDistance(
              r.bracket,
              rgbOf(theme.tiers[transitModeTier(r.mode)]),
            ) < 48,
        );
        const byMode = new Map();
        for (const r of rendered) if (r.bracket) byMode.set(r.mode, r.bracket);
        const modeColours = [...byMode.values()];
        let distinct = true;
        for (let i = 0; i < modeColours.length; i += 1)
          for (let j = i + 1; j < modeColours.length; j += 1)
            if (rgbDistance(modeColours[i], modeColours[j]) < 40)
              distinct = false;
        check(
          `${preset.name}: brackets carry the mode colour (${[...modes].join(', ') || 'no modes'})`,
          rendered.length >= 6 &&
            matched.length >= Math.ceil(rendered.length * 0.75) &&
            (byMode.size < 2 || distinct),
          rendered.length === 0
            ? 'no isolated sprite in frame to sample'
            : `${matched.length} of ${rendered.length} within tolerance of their tier; ${byMode.size} mode(s) painted${byMode.size >= 2 ? (distinct ? ', distinguishable' : ', NOT distinguishable') : ''}; misses=${JSON.stringify(
                rendered
                  .filter((r) => !matched.includes(r))
                  .map((r) => ({
                    key: r.key,
                    sampled: r.bracket,
                    tier: transitModeTier(r.mode),
                    expected: rgbOf(theme.tiers[transitModeTier(r.mode)]),
                  })),
              )}`,
          { unexercised: rendered.length < 6 },
        );
        const clickTarget = rendered[0];
        if (clickTarget) {
          await page.mouse.click(clickTarget.x, clickTarget.y);
          await wait(100);
          const picked = await page.evaluate((key) => {
            const state = window.__godsEyeView.dataManager.layers
              .get('transit')
              .module._transitStateForTest();
            return {
              selected: state._selectedKey === key,
              pickOwner: state._lastPickForTest,
            };
          }, clickTarget.key);
          check(
            `${preset.name}: mouse click selects the displayed sprite`,
            picked.selected,
            JSON.stringify(picked),
          );
          await page.keyboard.press('Escape');
        } else
          check(
            `${preset.name}: mouse click selects the displayed sprite`,
            false,
            'No verified unobscured sprite',
            { unexercised: true },
          );
        check(
          `${preset.name}: the icon raster cache stays bounded`,
          styling.iconCacheSize <= 6 * 2 * 3,
          `${styling.iconCacheSize} rasters`,
        );
      }
      // Selection under FLIR keeps the sprite white; leaving FLIR restores it.
      await selectStyle(page, 'thermal', { 'WHOT/BHOT': 0, Ironbow: 0 });
      const target = (await sampleRendered(page))[0];
      if (target) {
        await page.mouse.click(target.x, target.y);
        await wait(800);
        const underFlir = await page.evaluate((key) => {
          const layer =
            window.__godsEyeView.dataManager.layers.get('transit').module;
          const state = layer._transitStateForTest();
          const entry = state._vehicles.get(key);
          return {
            selected: state._selectedKey === key,
            color: entry?.marker.color.toCssColorString(),
            width: entry?.marker.width,
            pickOwner: (() => {
              const p = window.__godsEyeView.viewer.scene.pick(
                entry.marker.computeScreenSpacePosition(
                  window.__godsEyeView.viewer.scene,
                ),
              );
              return {
                id: typeof p?.id === 'string' ? p.id : null,
                primitiveId:
                  typeof p?.primitive?.id === 'string' ? p.primitive.id : null,
                collection:
                  entry.markerCollection === state._animatedMarkers
                    ? 'animated'
                    : 'stationary',
              };
            })(),
          };
        }, target.key);
        check(
          'clicking a sprite under FLIR selects it and keeps it white-hot',
          underFlir.selected && underFlir.color === 'rgb(255,255,255)',
          JSON.stringify(underFlir),
        );
        await page.keyboard.press('Escape');
        await wait(500);
      } else {
        check(
          'clicking a sprite under FLIR selects it and keeps it white-hot',
          false,
          'no isolated sprite to click',
          { unexercised: true },
        );
      }
      await selectStyle(page, 'normal');
      const restored = await page.evaluate(readTransitFleetStyle, {
        key: baseline?.key,
      });
      check(
        'returning to normal restores the shipped sprite exactly',
        Boolean(restored && baseline) &&
          !restored.selected &&
          !baseline.selected &&
          restored.color === baseline.color &&
          restored.width === baseline.width &&
          restored.image === baseline.image,
        restored && baseline
          ? `${baseline.key}: selected ${baseline.selected}→${restored.selected}, ${baseline.color}/${baseline.width}px → ${restored.color}/${restored.width}px; raster equal ${baseline.image === restored.image}`
          : 'the baseline vehicle left the fleet',
        { unexercised: !(restored && baseline) },
      );
    }

    // Motion acceptance uses known report-time playback even when live fleets park.
    await selectStyle(page, 'normal');
    await page.evaluate((city) => {
      const app = window.__godsEyeView,
        camera = app.viewer.camera;
      const C = camera.positionCartographic.constructor;
      camera.setView({
        destination: C.toCartesian(C.fromDegrees(city.lon, city.lat, 600)),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, city);
    await wait(2000);
    await page.evaluate(
      (city) =>
        window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._loadTransitFleetForTest(16, city, 25),
      city,
    );
    await wait(1000);
    const motionFirst = await sampleVisible(page);
    await wait(30_000);
    const second = await page.evaluate(() => {
      const app = window.__godsEyeView;
      const layer = app.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest();
      const Cartographic = app.viewer.camera.positionCartographic.constructor;
      return {
        count: state._vehicles.size,
        // The RENDERED primitive position, read back through Cesium — not the
        // fix the layer is aiming at. A layer that never moved a point would
        // still show two different `entry.to` values, so comparing those would
        // prove the data changed, not that anything on screen did.
        // VISIBLE markers only. Off-screen vehicles take their newest fix
        // directly — that is the whole point of the view gate — so sampling
        // them would let a layer whose visible interpolation is broken pass
        // this check on the strength of hidden vehicles snapping.
        sample: [...state._vehicles.values()]
          .filter((entry) => entry.marker && entry.marker.show !== false)
          .slice(0, 200)
          .map((entry) => {
            const carto = Cartographic.fromCartesian(entry.marker.position);
            return {
              key: entry.key,
              lat: (carto.latitude * 180) / Math.PI,
              lon: (carto.longitude * 180) / Math.PI,
            };
          }),
      };
    });
    const beforeById = new Map(motionFirst.map((v) => [v.key, v]));
    let moved = 0;
    let matched = 0;
    for (const v of second.sample) {
      const was = beforeById.get(v.key);
      if (!was) continue;
      matched += 1;
      const dLat = (v.lat - was.lat) * 111_320;
      const dLon =
        (v.lon - was.lon) * 111_320 * Math.cos((v.lat * Math.PI) / 180);
      if (Math.hypot(dLat, dLon) > 5) moved += 1;
    }
    check(
      `${city.label} deterministic fixture: the same vehicles are still drawn 30 s later, in new places`,
      matched >= 5 && moved >= 3,
      `${matched} same visible ids, ${moved} whose RENDERED point moved more than 5 m`,
    );

    // Between polls, not across them. Positions changing over thirty seconds
    // only proves new data arrived; a layer that snapped every fifteen seconds
    // and drew nothing in between would pass that. Two reads two seconds apart
    // fall inside one poll interval, so anything that moves is being
    // INTERPOLATED on screen.
    const glideA = await sampleVisible(page);
    await wait(2_000);
    const glideB = await sampleVisible(page);
    const glideBefore = new Map(glideA.map((v) => [v.key, v]));
    let glided = 0;
    let glideMatched = 0;
    let straddled = 0;
    // Only vehicles the LAYER says are mid-segment can testify here, and only
    // readings from the SAME poll and the same displayed segment: a pair that
    // straddles a poll could have snapped, and would pass as motion.
    let claimed = 0;
    for (const v of glideB) {
      const was = glideBefore.get(v.key);
      if (!was) continue;
      glideMatched += 1;
      if (!(was.gliding || v.gliding)) continue;
      if (was.pollSeq !== v.pollSeq || was.segment !== v.segment) {
        straddled += 1;
        continue;
      }
      claimed += 1;
      const dLat = (v.lat - was.lat) * 111_320;
      const dLon =
        (v.lon - was.lon) * 111_320 * Math.cos((v.lat * Math.PI) / 180);
      if (Math.hypot(dLat, dLon) > 1) glided += 1;
    }
    check(
      `${city.label} deterministic fixture: a vehicle the layer says is mid-segment moves on screen between polls`,
      claimed > 0 && glided >= 1,
      claimed === 0
        ? `nothing was mid-segment inside one poll across ${glideMatched} visible vehicles (${straddled} pairs straddled a poll)`
        : `${glided} of ${claimed} mid-segment vehicles moved within one poll and one segment (${straddled} straddling pairs discarded)`,
      { unexercised: claimed === 0 },
    );

    // Orientation, measured the only way that settles it: where the sprite
    // points against where the sprite actually travelled on screen. The
    // projection is perspective-exact, so an off-centre vehicle at an oblique
    // pitch must agree too — that is precisely the case the orthographic
    // approximation got wrong by twenty-odd degrees.
    //
    // Only sprites that visibly moved can testify, and a keyless Austin view
    // holds a handful of them; the floor is what that view can honestly
    // supply, and the accuracy bar does the work.
    const headingA = await sampleScreen(page);
    await wait(6_000);
    const headingB = await sampleScreen(page);
    const wasById = new Map(headingA.map((v) => [v.key, v]));
    let aimed = 0;
    let checked = 0;
    let worstDeg = 0;
    for (const now of headingB) {
      const was = wasById.get(now.key);
      if (!was) continue;
      // A poll in between could have placed it; that is not travel.
      if (was.pollSeq !== now.pollSeq) continue;
      const dx = now.x - was.x;
      const dy = now.y - was.y;
      // Only vehicles that visibly travelled can testify about direction.
      if (Math.hypot(dx, dy) < 6) continue;
      checked += 1;
      // The sprite is authored nose-up and rotated CCW, so at rotation r its
      // nose points along (-sin r, -cos r) in window coordinates.
      const noseX = -Math.sin(now.rotation);
      const noseY = -Math.cos(now.rotation);
      const travel = Math.hypot(dx, dy);
      const cosErr = (noseX * dx + noseY * dy) / travel;
      const errDeg =
        (Math.acos(Math.max(-1, Math.min(1, cosErr))) * 180) / Math.PI;
      if (errDeg <= 35) aimed += 1;
      else worstDeg = Math.max(worstDeg, errDeg);
    }
    check(
      `${city.label} deterministic fixture: sprites point the way they are travelling on screen`,
      checked > 0 && aimed >= Math.ceil(checked * 0.8),
      checked === 0
        ? 'no sprite travelled far enough on screen inside one poll to testify'
        : `${aimed} of ${checked} moving sprites within 35° of their screen travel` +
            (worstDeg ? `, worst miss ${Math.round(worstDeg)}°` : ''),
      { unexercised: checked === 0 },
    );

    await shot(
      `${TAG}-${city.id}-02-thirty-seconds-later.jpg`,
      `${city.label} deterministic fixture 30 s later — ${second.count} vehicles, ${moved}/${matched} moved`,
    );
  }

  check(
    'vehicle selection never raises a Cesium render error',
    (await page.evaluate(() => window.__transitRenderErrors || [])).length ===
      0,
    JSON.stringify(
      await page.evaluate(() => window.__transitRenderErrors || []),
    ),
  );

  if (runs('history')) {
    console.log('\n== retained history reload ==');
    const recovery = await browser.newPage();
    boundPageEvaluations(recovery);
    try {
      await recovery.goto(view(BOSTON), { waitUntil: 'domcontentloaded' });
      await recovery.waitForFunction(
        () => window.__godsEyeView?.dataManager?.layers?.has('transit'),
        { timeout: 90000 },
      );
      // Leave enough time for two snapshots, priming and reload in one minute.
      if (Date.now() % 60000 > 20000)
        await wait(60000 - (Date.now() % 60000) + 50);
      const first = await recovery.evaluate(async () =>
        (
          await fetch('/api/transit/vehicles/mbta', {
            signal: AbortSignal.timeout(10000),
          })
        ).json(),
      );
      await wait(16000);
      const retained = await recovery.evaluate(async (prior) => {
        const current = await (
          await fetch('/api/transit/vehicles/mbta', {
            signal: AbortSignal.timeout(10000),
          })
        ).json();
        const candidates = current.vehicles.filter((v) =>
          prior.vehicles.some((p) => p.id === v.id),
        );
        // Prime the newest fixes from this exact feed, not evenly spaced stale IDs.
        const primedAt = Date.now();
        const picked = candidates
          .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
          .slice(0, 12);
        const histories = await Promise.all(
          picked.map(async (vehicle) => {
            const response = await fetch(
              `/api/transit/trail/mbta/${encodeURIComponent(vehicle.id)}`,
              { signal: AbortSignal.timeout(10000) },
            );
            if (!response.ok)
              throw new Error(`Trail prime HTTP ${response.status}`);
            return response.json();
          }),
        );
        return histories
          .filter((history) => history.fixes?.length >= 2)
          .map((history) => ({ ...history, feedId: 'mbta', primedAt }));
      }, first);
      await recovery.reload({ waitUntil: 'domcontentloaded' });
      await recovery.waitForFunction(
        () => window.__godsEyeView?.dataManager?.layers?.has('transit'),
        { timeout: 90000 },
      );
      await recovery.evaluate(() => {
        window.__transitRenderErrors = [];
        window.__godsEyeView.viewer.scene.renderError.addEventListener(
          (scene, error) => window.__transitRenderErrors.push(error.message),
        );
      });
      const restored = await recovery.evaluate(
        restoreRetainedTransit,
        retained,
      );
      if (restored.key) {
        await recovery.waitForFunction(
          () =>
            !window.__godsEyeView.dataManager.layers
              .get('transit')
              .module._transitPartsForTest()
              .trails.requestDiagnostics().pending,
          { timeout: 20000 },
        );
        await wait(4000);
        const proof = await recovery.evaluate(
          ({ key, oldest }) => {
            const layer =
              window.__godsEyeView.dataManager.layers.get('transit').module;
            const entry = layer._transitStateForTest()._vehicles.get(key),
              parts = layer._transitPartsForTest();
            if (!entry) return { gone: true };
            const segments = entry.trailSegments?.length || 0;
            const renderErrors = window.__transitRenderErrors || [];
            const count = entry.track.count,
              restoredOldest = entry.fixes[0].t;
            const before = parts.trails.requestDiagnostics().abortCount;
            parts.selection.selectVehicle(key);
            parts.selection.clearSelection();
            return {
              count,
              segments,
              renderErrors,
              restoredOldest,
              oldest,
              aborted: parts.trails.requestDiagnostics().abortCount > before,
            };
          },
          { key: restored.key, oldest: restored.oldest },
        );
        check(
          'reload restores observed history and selection churn aborts its request',
          proof.count >= 2 &&
            proof.restoredOldest <= proof.oldest &&
            proof.aborted,
          proof.gone
            ? 'Selected primed vehicle left during recovery'
            : JSON.stringify(proof),
          { unexercised: proof.gone === true },
        );
        if (!proof.gone)
          check(
            'reloaded MBTA trail prepares geometry without a Cesium render error',
            proof.segments > 0 && proof.renderErrors.length === 0,
            JSON.stringify(proof),
            {
              unexercised:
                proof.segments === 0 && proof.renderErrors.length === 0,
            },
          );
      } else
        check('reload restores observed history', false, restored.error, {
          unexercised: restored.unexercised === true,
        });
    } finally {
      await recovery.close();
      await page.bringToFront();
    }
  }

  // ---- Deterministic playback and card anchor (synthetic feed) -----------
  // The live feeds prove the layer against reality; they cannot prove it
  // against a script. For the next two minutes the MBTA response is replaced
  // at the network layer by six scripted vehicles near the Boston view —
  // straight travel, a corner, a genuine stop, a ninety-second silence, a
  // late packet and a feed that only refreshes every thirty seconds — and
  // every rendered frame is sampled.
  if (runs('playback')) {
    console.log('\n== deterministic playback ==');
    await page.evaluate((c) => {
      const camera = window.__godsEyeView.viewer.camera;
      const Cartographic = camera.positionCartographic.constructor;
      camera.setView({
        destination: Cartographic.toCartesian(
          Cartographic.fromDegrees(c.lon, c.lat + 0.005, 2400),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    }, BOSTON);
    await page.evaluate(() => {
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._setTransitFixtureFloorsForTest(
          ['straight', 'corner', 'stop', 'gap', 'late', 'dup'].map(
            (id) => `mbta:sim-${id}`,
          ),
          20,
        );
    });
    const ORIGIN = { lat: BOSTON.lat, lon: BOSTON.lon };
    const M_LAT = 1 / 111_320;
    const M_LON = 1 / (111_320 * Math.cos((ORIGIN.lat * Math.PI) / 180));
    const at = (eastM, northM) => ({
      lat: ORIGIN.lat + northM * M_LAT,
      lon: ORIGIN.lon + eastM * M_LON,
    });
    const simStart = Date.now();
    const reportTime = (elapsedS, cadenceS) =>
      Math.floor(elapsedS / cadenceS) * cadenceS;
    const SIM = {
      straight: { speed: 10 },
      corner: { speed: 8, turnAt: 60 },
      stop: { speed: 8, stopFrom: 30, stopTo: 75 },
      gap: { speed: 6, silentFrom: 40, silentTo: 130 },
      late: { speed: 8, lateFrom: 50, lateTo: 60 },
      dup: { speed: 8, cadence: 30 },
    };
    const synthetic = (nowMs) => {
      const elapsed = (nowMs - simStart) / 1000;
      const vehicles = [];
      const push = (id, pos, tS) =>
        vehicles.push({
          id,
          lat: pos.lat,
          lon: pos.lon,
          bearing: null,
          speedMps: null,
          timestamp: Math.round(simStart / 1000 + tS),
          timestampSource: 'vehicle',
          routeId: id.toUpperCase(),
          tripId: null,
          directionId: null,
          label: null,
          stopId: null,
          status: null,
          occupancy: null,
        });
      {
        const t = reportTime(elapsed, 10);
        push('sim-straight', at(-220, SIM.straight.speed * t), t);
      }
      {
        const t = reportTime(elapsed, 10);
        const n = Math.min(t, SIM.corner.turnAt) * SIM.corner.speed;
        const e = Math.max(0, t - SIM.corner.turnAt) * SIM.corner.speed;
        push('sim-corner', at(110 + e, n), t);
      }
      {
        const t = reportTime(elapsed, 10);
        const moved =
          t <= SIM.stop.stopFrom
            ? t
            : t <= SIM.stop.stopTo
              ? SIM.stop.stopFrom
              : SIM.stop.stopFrom + (t - SIM.stop.stopTo);
        push('sim-stop', at(-110, moved * SIM.stop.speed), t);
      }
      {
        const t0 = reportTime(elapsed, 10);
        const t =
          t0 >= SIM.gap.silentFrom && t0 < SIM.gap.silentTo
            ? SIM.gap.silentFrom
            : t0;
        push('sim-gap', at(220, t * SIM.gap.speed), t);
      }
      {
        const t0 = reportTime(elapsed, 10);
        const t =
          elapsed >= SIM.late.lateFrom && elapsed < SIM.late.lateTo
            ? t0 - 30
            : t0;
        push('sim-late', at(330, t * SIM.late.speed), t);
      }
      {
        const t = reportTime(elapsed, SIM.dup.cadence);
        push('sim-dup', at(-330, t * SIM.dup.speed), t);
      }
      return {
        feedId: 'mbta',
        name: 'MBTA',
        fetchedAt: nowMs,
        feedTimestamp: null,
        version: '2.0',
        entityCount: vehicles.length,
        truncated: false,
        count: vehicles.length,
        vehicles,
      };
    };
    let intercepting = true;
    await page.setRequestInterception(true);
    const onRequest = (request) => {
      if (
        intercepting &&
        request.url().includes('/api/transit/vehicles/mbta')
      ) {
        const now = Date.now();
        request.respond({
          status: 200,
          contentType: 'application/json',
          headers: { 'x-transit-contact': String(now) },
          body: JSON.stringify(synthetic(now)),
        });
        return;
      }
      request.continue();
    };
    page.on('request', onRequest);
    // Wait for the scripted fleet to replace the live one.
    await page.waitForFunction(
      () => {
        const state = window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
        return state._vehicles.has('mbta:sim-straight');
      },
      { timeout: 60_000 },
    );
    const simState = () =>
      page.evaluate(() => {
        const state = window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
        const now = Date.now();
        return ['straight', 'corner', 'stop', 'gap', 'late', 'dup']
          .map((k) => {
            const e = state._vehicles.get(`mbta:sim-${k}`);
            if (!e) return `${k}:absent`;
            return `${k}:${e.marker ? (e.marker.show === false ? 'hidden' : 'shown') : 'nomarker'}/lag${((now - e.playT) / 1000).toFixed(0)}/${state._moving.has(e) ? 'mv' : 'idle'}/fx${e.fixes.length}/r${e.resets || 0}`;
          })
          .join(' ');
      });
    console.log(`  scripted fleet before trace: ${await simState()}`);
    await reportTransitVisibility(page, 'scripted visibility before trace');
    // Sample every rendered frame for two minutes.
    const trace = await page.evaluate(
      (durationMs) =>
        new Promise((resolve) => {
          const app = window.__godsEyeView;
          const layer = app.dataManager.layers.get('transit').module;
          const state = layer._transitStateForTest();
          const Cartographic =
            app.viewer.camera.positionCartographic.constructor;
          const keys = [
            'sim-straight',
            'sim-corner',
            'sim-stop',
            'sim-gap',
            'sim-late',
            'sim-dup',
          ].map((k) => `mbta:${k}`);
          const out = Object.fromEntries(keys.map((k) => [k, []]));
          const words = Object.fromEntries(keys.map((k) => [k, []]));
          const t0 = performance.now();
          let lastWordAt = -1e9;
          let remove;
          const timer = setTimeout(() => {
            remove?.();
            resolve({ out, words });
          }, durationMs + 1000);
          const tick = () => {
            const now = performance.now();
            const wall = Date.now();
            for (const key of keys) {
              const entry = state._vehicles.get(key);
              if (!entry?.marker?.show) continue;
              const carto = Cartographic.fromCartesian(entry.marker.position);
              out[key].push([
                now - t0,
                (carto.latitude * 180) / Math.PI,
                (carto.longitude * 180) / Math.PI,
                entry.playT,
                entry.resets || 0,
                state._moving.has(entry) ? 1 : 0,
                entry.courseDeg,
                wall,
                entry.track.count,
                entry.sample.segmentSpeedMps,
                entry.sample.fromSeq,
                entry.marker.position.x,
                entry.marker.position.y,
                entry.marker.position.z,
                entry.sample.toSeq,
                entry.sample.phase,
                entry.clocks.monoNowMs,
              ]);
            }
            if (now - lastWordAt > 1_000) {
              lastWordAt = now;
              for (const contact of layer.getDetectableObjects()) {
                if (words[contact.sourceId])
                  words[contact.sourceId].push([now - t0, contact.metric]);
              }
            }
            if (now - t0 >= durationMs) {
              clearTimeout(timer);
              remove();
              resolve({ out, words });
            }
          };
          remove = app.viewer.scene.postRender.addEventListener(tick);
        }),
      120_000,
    );
    console.log(`  scripted fleet after trace: ${await simState()}`);
    await reportTransitVisibility(page, 'scripted visibility after trace');
    const metres = (a, b) =>
      Math.hypot(
        (b[1] - a[1]) * 111_320,
        (b[2] - a[2]) * 111_320 * Math.cos((a[1] * Math.PI) / 180),
      );
    const judge = (key) => reduceScenario(trace, key);
    // Preserve every frame and both bracket ends; never join moving rows across a hold.
    const speedEvidence = Object.entries(trace.out).map(([key, rows]) => ({
      key,
      ...reduceScriptedMotion(key, rows),
    }));
    await writeFile(
      `${SHOTS}/${TAG}-scripted-frames.json`,
      JSON.stringify(trace),
    );
    for (const evidence of speedEvidence)
      check(
        `${evidence.key}: ordinary postRender frames follow the displayed segment within 2%`,
        evidence.pass,
        JSON.stringify(evidence),
      );
    const scenarioCheck = (name, conditions, detail) =>
      check(
        name,
        Object.values(conditions).every(Boolean),
        `${detail}; conditions=${JSON.stringify(conditions)}; failed=${JSON.stringify(Object.keys(conditions).filter((k) => !conditions[k]))}`,
      );
    const straight = judge('straight');
    scenarioCheck(
      'straight travel is played back continuously at its own speed',
      {
        'straight.rows > 3_000': straight.rows > 3_000,
        'straight.total > 300': straight.total > 300,
        'straight.moved > straight.rows * 0.4':
          straight.moved > straight.rows * 0.4,
        'straight.worstJump <= SIM.straight.speed * 1.02 + 0.1':
          straight.worstJump <= SIM.straight.speed * 1.02 + 0.1,
        'straight.speedWorst >= SIM.straight.speed * 0.98':
          straight.speedWorst >= SIM.straight.speed * 0.98,
        'straight.speedWorst <= SIM.straight.speed * 1.02':
          straight.speedWorst <= SIM.straight.speed * 1.02,
        'straight.wallFaster === 0': straight.wallFaster === 0,
        'straight.resets === 0': straight.resets === 0,
      },
      `${straight.rows} frames (${straight.keys}), ${straight.total.toFixed(0)} m drawn, ${straight.moved} moving frames, worst per-frame ${straight.worstJump.toFixed(1)} m/s, peak segment speed ${straight.speedWorst.toFixed(2)} m/s vs ${SIM.straight.speed}, ${straight.wallFaster} frames faster than real time, ${straight.resets} resets`,
    );
    scenarioCheck(
      'the display lag is bounded and never below the feed floor',
      {
        'straight.lagValid': straight.lagValid,
        'straight.lagMin >= 24': straight.lagMin >= 24,
        'straight.lagMax <= 215': straight.lagMax <= 215,
      },
      `lag ${straight.lagMin.toFixed(1)}–${straight.lagMax.toFixed(1)} s`,
    );
    const corner = judge('corner');
    const cornerRows = trace.out['mbta:sim-corner'] || [];
    const courseLate = cornerRows
      .slice(-300)
      .map((r) => r[6])
      .filter(Number.isFinite);
    const courseEarly = cornerRows
      .filter((r) => r[5] === 1)
      .slice(0, 300)
      .map((r) => r[6])
      .filter(Number.isFinite);
    const mean = (xs) =>
      xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : NaN;
    scenarioCheck(
      'a corner is turned on the displayed segment: north first, east once the turn is played',
      {
        'courseEarly.length > 0': courseEarly.length > 0,
        'courseLate.length > 0': courseLate.length > 0,
        'Math.abs(mean(courseEarly)) < 12': Math.abs(mean(courseEarly)) < 12,
        'Math.abs(mean(courseLate) - 90) < 15':
          Math.abs(mean(courseLate) - 90) < 15,
        'corner.worstJump <= SIM.corner.speed * 1.5 + 2':
          corner.worstJump <= SIM.corner.speed * 1.5 + 2,
        'corner.resets === 0': corner.resets === 0,
      },
      `early course ${mean(courseEarly).toFixed(1)}°, late course ${mean(courseLate).toFixed(1)}°, worst per-frame ${corner.worstJump.toFixed(1)} m/s`,
    );
    const stopWords = (trace.words['mbta:sim-stop'] || []).map((w) => w[1]);
    const stopRows = trace.out['mbta:sim-stop'] || [];
    const stopStill = stopRows.filter(
      (r, i) => i > 0 && metres(stopRows[i - 1], r) < 0.01,
    ).length;
    scenarioCheck(
      'a genuine stop reads STOPPED while the marker stands still, then moves on',
      {
        'stopWords.some((w) => /STOPPED/.test(w))': stopWords.some((w) =>
          /STOPPED/.test(w),
        ),
        'stopStill > 600': stopStill > 600,
        "judge('stop').total > 200": judge('stop').total > 200,
        "judge('stop').resets === 0": judge('stop').resets === 0,
      },
      `words seen: ${[...new Set(stopWords)].join(' | ')}; ${stopStill} still frames; ${judge('stop').total.toFixed(0)} m drawn`,
    );
    const gap = judge('gap');
    scenarioCheck(
      'a ninety-second silence holds at the newest fix — no extrapolation, no reset — and resumes',
      {
        'gap.resets === 0': gap.resets === 0,
        'gap.worstJump <= SIM.gap.speed * 1.5 + 2':
          gap.worstJump <= SIM.gap.speed * 1.5 + 2,
        'gap.total > 100': gap.total > 100,
      },
      `${gap.total.toFixed(0)} m drawn, worst per-frame ${gap.worstJump.toFixed(1)} m/s, ${gap.resets} resets`,
    );
    const late = judge('late');
    scenarioCheck(
      'a late packet is refused: no backward motion, no reset',
      {
        'late.backwards === 0': late.backwards === 0,
        'late.resets === 0': late.resets === 0,
        'late.total > 200': late.total > 200,
      },
      `${late.backwards} backward frames, ${late.resets} resets, ${late.total.toFixed(0)} m drawn`,
    );
    const dup = judge('dup');
    scenarioCheck(
      'a feed that refreshes every thirty seconds plays at the fix speed, not in bursts',
      {
        'dup.speedWorst <= SIM.dup.speed * 1.06':
          dup.speedWorst <= SIM.dup.speed * 1.06,
        'dup.worstJump <= SIM.dup.speed * 1.5 + 2':
          dup.worstJump <= SIM.dup.speed * 1.5 + 2,
        'dup.total > 200': dup.total > 200,
        'dup.resets === 0': dup.resets === 0,
      },
      `peak segment speed ${dup.speedWorst.toFixed(2)} m/s vs ${SIM.dup.speed}, worst per-frame ${dup.worstJump.toFixed(1)} m/s, ${dup.total.toFixed(0)} m drawn`,
    );

    // ---- Card anchor synchronisation ---------------------------------------
    console.log('\n== card anchor ==');
    await page.evaluate(() => {
      const app = window.__godsEyeView,
        camera = app.viewer.camera;
      const entry = app.dataManager.layers
        .get('transit')
        .module._transitStateForTest()
        ._vehicles.get('mbta:sim-straight');
      if (!entry) return;
      const C = camera.positionCartographic.constructor;
      const at = C.fromCartesian(entry.marker.position);
      at.height = 600;
      camera.setView({
        destination: C.toCartesian(at),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await wait(1500);
    await reportTransitVisibility(page, 'scripted visibility before click');
    const target = await page.evaluate(() => {
      const app = window.__godsEyeView;
      const layer = app.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest();
      const entry = state._vehicles.get('mbta:sim-straight');
      if (!entry?.marker?.show) return null;
      const scene = app.viewer.scene;
      const canvas = scene.canvas;
      const view = scene.camera.viewMatrix;
      const proj = scene.camera.frustum.projectionMatrix;
      const mul = (m, v) => [
        m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
        m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
        m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
        m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
      ];
      const p = entry.marker.position;
      const clip = mul(proj, mul(view, [p.x, p.y, p.z, 1]));
      const x = ((clip[0] / clip[3]) * 0.5 + 0.5) * canvas.clientWidth;
      const y = (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) * canvas.clientHeight;
      if (
        !(clip[3] > 0) ||
        x < 0 ||
        y < 0 ||
        x >= canvas.clientWidth ||
        y >= canvas.clientHeight
      )
        return null;
      const picked = scene.pick({ x, y });
      return {
        entityCount: app.viewer.entities.values.length,
        key: entry.key,
        x,
        y,
        pickKey: picked?.id ?? picked?.primitive?.id ?? null,
      };
    });
    let anchor = null;
    if (target) {
      check(
        'the scripted sprite owns its screen-space pick',
        target.pickKey === target.key,
        JSON.stringify(target),
      );
      await page.mouse.click(target.x, target.y);
      await wait(600);
      anchor = await page.evaluate(
        async (key, durationMs) => {
          const overlay = await import('/src/overlays/worldOverlay.js');
          const app = window.__godsEyeView;
          const layer = app.dataManager.layers.get('transit').module;
          const state = layer._transitStateForTest();
          if (state._selectedKey !== key) return { selected: false };
          const scene = app.viewer.scene;
          const canvas = scene.canvas;
          const mul = (m, v) => [
            m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
            m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
            m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
            m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3],
          ];
          const frames = [];
          const publicationsBefore = state._cardPublications || 0;
          let headSamples = 0,
            headErrorPx = 0,
            bodyMutation = 0,
            previousTrail = null;
          const entityCount = app.viewer.entities.values.length;
          return new Promise((resolve) => {
            const t0 = performance.now();
            const tick = () => {
              const entry = state._vehicles.get(key);
              const rect = overlay.getOverlayPaintRect('transit-selected', key);
              if (entry?.marker) {
                const view = scene.camera.viewMatrix;
                const proj = scene.camera.frustum.projectionMatrix;
                const p = entry.marker.position;
                const clip = mul(proj, mul(view, [p.x, p.y, p.z, 1]));
                frames.push({
                  t: performance.now() - t0,
                  mx: ((clip[0] / clip[3]) * 0.5 + 0.5) * canvas.clientWidth,
                  my:
                    (1 - ((clip[1] / clip[3]) * 0.5 + 0.5)) *
                    canvas.clientHeight,
                  markerVisible: entry.marker.show !== false,
                  worldFinite: [p.x, p.y, p.z].every(Number.isFinite),
                  cardPresent: !!rect,
                  surfaceReady: entry.surfaceReady,
                  ax: rect?.anchorX ?? null,
                  ay: rect?.anchorY ?? null,
                  poll: entry.pollSeq,
                  moving: state._moving.has(entry) ? 1 : 0,
                });
              }
              const trail = layer._transitPartsForTest().trails.diagnostics();
              if (trail && entry?.marker) {
                if (
                  previousTrail &&
                  previousTrail.revision === trail.revision &&
                  previousTrail.body !== trail.body
                )
                  bodyMutation++;
                previousTrail = trail;
                if (trail.head.show && trail.head.positions.length) {
                  const project = (p) => {
                    const clip = mul(
                      scene.camera.frustum.projectionMatrix,
                      mul(scene.camera.viewMatrix, [p.x, p.y, p.z, 1]),
                    );
                    return [
                      ((clip[0] / clip[3]) * canvas.clientWidth) / 2,
                      ((clip[1] / clip[3]) * canvas.clientHeight) / 2,
                    ];
                  };
                  const h = project(trail.head.positions.at(-1)),
                    m = project(entry.marker.position);
                  headErrorPx = Math.max(
                    headErrorPx,
                    Math.hypot(h[0] - m[0], h[1] - m[1]),
                  );
                  headSamples++;
                }
              }
              if (performance.now() - t0 >= durationMs) finish();
            };
            let remove;
            const finish = () => {
              clearTimeout(timer);
              remove?.();
              resolve({
                selected: true,
                frames,
                textPublishes:
                  (state._cardPublications || 0) - publicationsBefore,
                headSamples,
                headErrorPx,
                bodyMutation,
                entityCount,
              });
            };
            const timer = setTimeout(finish, durationMs + 1000);
            remove = scene.postRender.addEventListener(tick);
          });
        },
        target.key,
        20_000,
      );
    }
    check(
      'selected trail head stays within 1 CSS px of the marker, without entity additions or body rebuilds between revisions',
      anchor?.selected &&
        anchor.headSamples > 30 &&
        anchor.headErrorPx <= 1 &&
        anchor.bodyMutation === 0 &&
        anchor.entityCount === target.entityCount,
      JSON.stringify({
        headSamples: anchor?.headSamples,
        errorPx: anchor?.headErrorPx,
        bodyMutation: anchor?.bodyMutation,
      }),
    );
    if (anchor?.selected) {
      await writeFile(
        `${SHOTS}/${TAG}-anchor-frames.json`,
        JSON.stringify(anchor.frames),
      );
      const evidence = reduceAnchor(anchor.frames);
      check(
        'actual painted host anchor stays within 1 CSS px of the marker',
        evidence.pass,
        JSON.stringify(evidence),
      );
      check(
        'card text publication stays throttled while the anchor runs at frame rate',
        anchor.textPublishes > 0 && anchor.textPublishes <= 20_000 / 250 + 3,
        `${anchor.textPublishes} text publications in 20 s`,
      );
    } else {
      check(
        'the card anchor moves in lockstep with the sprite on every frame, across polls and a settle',
        false,
        target
          ? 'the click did not select the scripted vehicle'
          : 'no scripted vehicle on screen',
        { unexercised: true },
      );
    }
    // Removal: the scripted vehicle leaves the feed; after two missed polls its
    // card must go with it.
    intercepting = false;
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._setTransitFixtureFloorsForTest([], null),
    );
    page.off('request', onRequest);
    await page.setRequestInterception(false);
    await page
      .waitForFunction(
        () => {
          const state = window.__godsEyeView.dataManager.layers
            .get('transit')
            .module._transitStateForTest();
          return !state._vehicles.has('mbta:sim-straight');
        },
        { timeout: 60_000 },
      )
      .catch(() => {});
    const afterRemoval = await page.evaluate(() => {
      const state = window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      return {
        gone: !state._vehicles.has('mbta:sim-straight'),
        selected: state._selectedKey,
      };
    });
    check(
      'a removed vehicle takes its card with it',
      afterRemoval.gone && afterRemoval.selected !== 'mbta:sim-straight',
      JSON.stringify(afterRemoval),
    );
    await page.evaluate((c) => {
      const camera = window.__godsEyeView.viewer.camera;
      const Cartographic = camera.positionCartographic.constructor;
      camera.setView({
        destination: Cartographic.toCartesian(
          Cartographic.fromDegrees(c.lon, c.lat, 600),
        ),
        orientation: {
          heading: (c.heading * Math.PI) / 180,
          pitch: (-45 * Math.PI) / 180,
          roll: 0,
        },
      });
    }, CITIES.at(-1));
    await wait(4_000);
  }

  const sceneQA = {
    page,
    check,
    wait,
    shots: SHOTS,
    tag: TAG,
    detectOn,
    selectStyle,
    sampleRendered,
  };
  if (runs('budgets')) await runFleetBudgets(sceneQA);
  if (runs('matrix')) await runBostonMatrix(sceneQA);

  // Turning it off must stop the traffic and leave nothing behind.
  console.log('\n== disable ==');
  await page.$eval(row, (element) =>
    element.scrollIntoView({ block: 'center' }),
  );
  await page.click(`${row} .data-toggle-btn`);
  await page.waitForFunction(
    () => !window.__godsEyeView.dataManager.isEnabled('transit'),
    { timeout: 20_000 },
  );
  const afterDisable = transitRequests.length;
  const teardown = await page.evaluate(() => {
    const layer = window.__godsEyeView.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest();
    return {
      vehicles: state._vehicles.size,
      primitives:
        (state._markers?.length || 0) + (state._animatedMarkers?.length || 0),
      visible: state._visible.size,
      moving: state._moving.size,
      detect: state._detectCache,
      timers: [
        state._visibilityTimer,
        state._maintenanceTimer,
        state._floorTimer,
        state._cameraDebounceTimer,
      ],
      trailPending: layer._transitPartsForTest().trails.requestDiagnostics()
        .pending,
      shown: state._markers ? state._markers.show : null,
      inFlight: state._inFlight.size,
      activeFeeds: state._activeFeeds.size,
      holds: window.__godsEyeView.getRenderGovernorDiagnostics().holds,
    };
  });
  check(
    'disable leaves no vehicles and no point primitives',
    teardown.vehicles === 0 &&
      teardown.primitives === 0 &&
      teardown.visible === 0 &&
      teardown.moving === 0 &&
      teardown.detect === null &&
      teardown.timers.every((t) => t === null) &&
      !teardown.trailPending &&
      !teardown.holds.includes('transit'),
    JSON.stringify(teardown),
  );
  await shot(
    `${TAG}-disabled.jpg`,
    'Transit off — same view, nothing rendered',
  );
  await wait(25_000);
  check(
    'no further transit requests after disable',
    transitRequests.length === afterDisable,
    `${transitRequests.length - afterDisable} request(s) in 25 s`,
  );

  // ---- Context modes -------------------------------------------------------
  console.log('\n== context modes ==');
  // The CONTEXT panel starts collapsed; a user expands it before choosing a mode.
  await page.$eval(
    '[data-collapse-target="global-context-panel"]',
    (button) => {
      if (button.getAttribute('aria-expanded') !== 'true') button.click();
    },
  );
  await wait(1_200);
  check(
    'the CONTEXT panel opens from its own header button',
    await page.$eval(
      '[data-collapse-target="global-context-panel"]',
      (b) => b.getAttribute('aria-expanded') === 'true',
    ),
  );

  const isOn = () =>
    page.evaluate(() => window.__godsEyeView.dataManager.isEnabled('transit'));
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('transit', true, {
      origin: 'user',
    }),
  );
  await wait(6_000);
  check('transit is on before entering a Context mode', await isOn());

  // CONTACTS
  await page.click('#global-context-flights-btn');
  await wait(18_000);
  const inContacts = {
    transit: await isOn(),
    vehicles: await page.evaluate(
      () =>
        window.__godsEyeView.dataManager.layers.get('transit').module.getStats()
          .count,
    ),
  };
  // Contacts is not a passive overlay: it puts every non-dependency layer away
  // for the duration, Transit included, and gives it back on exit.
  check(
    'Contacts puts Transit away for the duration',
    inContacts.transit === false && inContacts.vehicles === 0,
    JSON.stringify(inContacts),
  );
  await page.click('#global-context-flights-btn');
  await wait(12_000);
  check('leaving Contacts restores Transit', await isOn());

  // SPACE MISSIONS
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('transit', false, {
      origin: 'user',
    }),
  );
  await wait(2_000);
  await page.click('#global-context-missions-btn');
  await wait(20_000);
  const blocked = await page.evaluate(async () => {
    const settled = await window.__godsEyeView.dataManager.setEnabled(
      'transit',
      true,
      { origin: 'user' },
    );
    return {
      settled,
      enabled: window.__godsEyeView.dataManager.isEnabled('transit'),
    };
  });
  check(
    'Space Missions refuses to enable Transit while it isolates replay data',
    blocked.enabled === false,
    JSON.stringify(blocked),
  );
  await page.click('#global-context-missions-btn');
  await wait(12_000);
  check(
    'leaving Space Missions leaves Transit off, as it was on entry',
    (await isOn()) === false,
  );

  check(
    'no uncaught page errors',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );
  console.log(
    `\ntotal /api/transit requests this run: ${transitRequests.length}`,
  );
  check(
    'scripted selections never raise a Cesium render error',
    (await page.evaluate(() => window.__transitRenderErrors || [])).length ===
      0,
    JSON.stringify(
      await page.evaluate(() => window.__transitRenderErrors || []),
    ),
  );
} catch (error) {
  check(
    'browser harness completed within its bounded waits',
    false,
    error.stack || error.message,
  );
} finally {
  await browser.close();
}
console.log(
  failures
    ? `HARNESS: FAIL (${failures} failed, ${unexercised} unexercised)`
    : `HARNESS: PASS (${unexercised} unexercised)`,
);
process.exit(failures || unexercised ? 1 : 0);
