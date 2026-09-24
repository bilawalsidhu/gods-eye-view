#!/usr/bin/env node
/**
 * Rendered acceptance for DATA ▸ Recent Imagery against the real NASA
 * endpoints (CMR catalog, GIBS tiles, Worldview snapshots): the rail panel,
 * USE VIEW and the live preview, the three modes (IMAGE, VS BASEMAP, A / B)
 * with their pins, the divider and the Esri surface on Google 3D, Escape
 * order, the oversized-view refusal and ZOOM IN, CLEAR, the share link,
 * map-switch rebind (a manual switch to Google 3D keeps the imagery on
 * Esri), CCTV stability at 900 and 700 px, scroll preservation, a
 * layout-shift measurement across every transition, and disable.
 *
 * Run: start the app (`./scripts/dev-fresh.sh`) and
 *   node scripts/qa-recent-imagery.mjs
 * Env: QA_BASE_URL (default http://localhost:4173), QA_SHOT_DIR (default
 * qa-shots/recent-imagery), QA_HEADFUL=1. Every wait is bounded. Without
 * network access to NASA the run skips with exit code 0.
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOT_DIR = process.env.QA_SHOT_DIR || 'qa-shots/recent-imagery';
const HEADFUL = process.env.QA_HEADFUL === '1';
const STEP_TIMEOUT = 20_000;
const AUSTIN = { lon: -97.74, lat: 30.27, height: 12_000 };
const PANEL = '#recent-imagery-panel';

async function networkAvailable() {
  try {
    const response = await fetch(
      'https://cmr.earthdata.nasa.gov/search/collections.json?page_size=1',
      { signal: AbortSignal.timeout(8_000) },
    );
    return response.ok;
  } catch {
    return false;
  }
}

if (!(await networkAvailable())) {
  console.log(
    'SKIP: cmr.earthdata.nasa.gov is unreachable — the live Recent Imagery gate needs network access.',
  );
  process.exit(0);
}

const browser = await puppeteer.launch({
  headless: !HEADFUL,
  ...(HEADFUL
    ? {
        executablePath:
          '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(HEADFUL ? ['--window-size=1280,860'] : []),
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
  ],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
let failures = 0;
let checks = 0;
function check(name, passed, detail = '') {
  checks += 1;
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shots = [];
const shot = async (name) => {
  const file = path.join(SHOT_DIR, `${name}.jpg`);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  shots.push(file);
};
const panelShot = async (name) => {
  const panel = await page.$(PANEL);
  if (!panel) return;
  const file = path.join(SHOT_DIR, `${name}.png`);
  await panel.screenshot({ path: file });
  shots.push(file);
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Poll a page predicate; false on timeout instead of throwing. */
async function until(fn, arg, timeout = STEP_TIMEOUT) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 250 }, arg);
    return true;
  } catch {
    return false;
  }
}

/**
 * Page-side helpers every predicate can use: the layer handle, GIBS layers
 * per host with their split directions, and whether a header is on screen.
 */
function installPageHelpers() {
  window.__riQa = {
    layer: () => window.__gevRecentImagery.layer,
    snap: () => window.__gevRecentImagery.layer.getSnapshot(),
    owned: () => window.__gevRecentImagery.layer.diagnostics().ownedCount,
    gibs(collection) {
      const out = [];
      for (let i = 0; i < (collection?.length || 0); i += 1) {
        const layer = collection.get(i);
        if (
          String(layer?.imageryProvider?.url || '').includes(
            'earthdata.nasa.gov',
          )
        )
          out.push(layer.splitDirection);
      }
      return out;
    },
    hosts() {
      const gev = window.__godsEyeView;
      const globe = this.gibs(gev.viewer.imageryLayers);
      const tileset = this.gibs(gev.tileset?.imageryLayers);
      return {
        globe: globe.length,
        tileset: tileset.length,
        splits: [...globe, ...tileset],
        globeShown: gev.viewer.scene.globe.show,
      };
    },
    splitShown() {
      const line = document.getElementById('recent-imagery-split-line');
      return Boolean(line && !line.hidden);
    },
    headerOnScreen(id) {
      const element = document.getElementById(id);
      const header =
        element?.querySelector('.panel-header, .pp-header-row') || element;
      const rect = header?.getBoundingClientRect();
      return rect
        ? rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
        : false;
    },
    activeStack: () =>
      window.__godsEyeView.mapStackController?.getActiveId?.() ?? null,
  };
}

const state = () =>
  page.evaluate(() => {
    const qa = window.__riQa;
    const snapshot = qa.snap();
    const gev = window.__godsEyeView;
    const split = document.getElementById('recent-imagery-split-line');
    const text = (id) => document.getElementById(id)?.textContent || '';
    const hosts = qa.hosts();
    return {
      box: snapshot.box,
      boxError: snapshot.boxError,
      mode: snapshot.mode,
      candidates: snapshot.candidates.map((c) => ({
        key: c.key,
        drapable: c.drapable,
      })),
      focus: snapshot.focus?.key || null,
      pinA: snapshot.pins.a.key,
      pinB: snapshot.pins.b.key,
      preview: snapshot.preview.key,
      shown: snapshot.shown,
      notice: snapshot.notice,
      comparison: snapshot.comparison,
      borrowedEsri: snapshot.borrowedEsri,
      error: snapshot.error,
      diagnostics: qa.layer().diagnostics(),
      cards: document.querySelectorAll('#recent-imagery-panel .ri-card').length,
      panelHidden: document.getElementById('recent-imagery-panel')?.hidden,
      noticeText: text('ri-notice-text'),
      hintText: text('ri-hint'),
      rowA: text('ri-slot-a'),
      rowB: text('ri-slot-b'),
      splitVisible: Boolean(
        split && !split.hidden && split.getBoundingClientRect().height > 0,
      ),
      splitLabels: split
        ? [
            split.querySelector('span.before')?.textContent,
            split.querySelector('span.after')?.textContent,
          ]
        : null,
      splitLeft: split ? split.getBoundingClientRect().left : null,
      splitPosition: gev.viewer.scene.splitPosition,
      canvasWidth: gev.viewer.scene.canvas.clientWidth,
      activeStack: qa.activeStack(),
      gibsOnGlobe: hosts.globe,
      gibsOnTileset: hosts.tileset,
      gibsSplits: hosts.splits,
    };
  });
const hostsDetail = (s) =>
  `owned=${s.diagnostics.ownedCount} host=${s.diagnostics.host} globe=${s.gibsOnGlobe} tileset=${s.gibsOnTileset} splits=${s.gibsSplits}`;

/** Put the camera straight down over a point at a height, no flight. */
const setView = (view) =>
  page.evaluate((target) => {
    const viewer = window.__godsEyeView.viewer;
    viewer.camera.cancelFlight?.();
    viewer.scene.tweens?.removeAll?.();
    viewer.camera.setView({
      destination: viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (target.lon * Math.PI) / 180,
        latitude: (target.lat * Math.PI) / 180,
        height: target.height,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    viewer.scene.requestRender();
  }, view);

/** Ground width of the camera's view rectangle, in km (0 without one). */
const viewWidthKm = () =>
  page.evaluate(() => {
    const rect = window.__godsEyeView.viewer.camera.computeViewRectangle?.();
    if (!rect) return 0;
    const lat = (rect.south + rect.north) / 2;
    return Math.abs(rect.east - rect.west) * 6371 * Math.cos(lat);
  });

const click = (selector) =>
  page.evaluate((target) => {
    const button = document.querySelector(target);
    if (!button || button.disabled || button.hidden) return false;
    button.click();
    return true;
  }, selector);
const clickAction = (id) => click(`${PANEL} [data-action-id="${id}"]`);
const clickMode = (mode) => click(`${PANEL} .ri-mode-btn[data-mode="${mode}"]`);
const focusStrip = () =>
  page.evaluate(() =>
    document.getElementById('ri-strip')?.focus({ preventScroll: true }),
  );
const pressOnStrip = async (key) => {
  await focusStrip();
  await page.keyboard.press(key);
};

/** Average colour of the canvas centre — the inside of a centred 10 km box. */
async function probe() {
  const base64 = await page.screenshot({
    clip: { x: 540, y: 330, width: 200, height: 200 },
    type: 'png',
    encoding: 'base64',
  });
  return page.evaluate(async (data) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${data}`)).blob(),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const pixels = context.getImageData(0, 0, bitmap.width, bitmap.height).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4)
      for (let c = 0; c < 3; c += 1) sum[c] += pixels[i + c];
    return sum.map((value) => Math.round(value / (pixels.length / 4)));
  }, base64);
}

const tilesSettled = () =>
  until(() => {
    const gev = window.__godsEyeView;
    if (gev.viewer.scene.globe.show) return gev.viewer.scene.globe.tilesLoaded;
    return !gev.tileset || gev.tileset.tilesLoaded;
  });
const backOnPhotoreal = () =>
  until(() => window.__riQa.activeStack() === 'photoreal');
const onEsri = () =>
  until(() => window.__riQa.activeStack() === 'esri-imagery');
const ownedIs = (count) =>
  until((n) => window.__riQa.owned() === n, count, 10_000);

// ── layout-shift measurement ────────────────────────────────────────────────
const CONTROLS = {
  'select-box': `${PANEL} [data-action-id="select-box"]`,
  'use-view': `${PANEL} [data-action-id="use-view"]`,
  clear: `${PANEL} [data-action-id="clear"]`,
  notice: '#ri-notice',
  'zoom-in': '#ri-zoom-in',
  strip: '#ri-strip',
  hint: '#ri-hint',
  'mode-image': `${PANEL} .ri-mode-btn[data-mode="image"]`,
  'mode-basemap': `${PANEL} .ri-mode-btn[data-mode="basemap"]`,
  'mode-ab': `${PANEL} .ri-mode-btn[data-mode="ab"]`,
  'row-a': '#ri-slot-a',
  'row-b': '#ri-slot-b',
  'unpin-a': '#ri-unpin-a',
  'unpin-b': '#ri-unpin-b',
  opacity: '#ri-opacity',
  swap: '#ri-swap',
  'export-a': `${PANEL} [data-action-id="export-a"]`,
  'export-b': `${PANEL} [data-action-id="export-b"]`,
  details: '#ri-details .rail-card-header',
};
const measure = () =>
  page.evaluate((controls) => {
    const body = document.getElementById('recent-imagery-panel-body');
    const out = { bodyScroll: body?.scrollTop ?? null, rects: {} };
    for (const [name, selector] of Object.entries(controls)) {
      const rect = document.querySelector(selector)?.getBoundingClientRect();
      out.rects[name] = rect
        ? [rect.left, rect.top, rect.width, rect.height].map(
            (v) => Math.round(v * 10) / 10,
          )
        : null;
    }
    return out;
  }, CONTROLS);
let layoutBaseline = null;
/** Every control's rect matches the baseline within 1 px. */
async function checkLayout(label) {
  await wait(150);
  const now = await measure();
  if (!layoutBaseline) {
    layoutBaseline = now;
    check(
      `layout baseline recorded (${label})`,
      Object.values(now.rects).every(Boolean),
      JSON.stringify(now.rects),
    );
    return;
  }
  const moved = Object.entries(now.rects).filter(([name, rect]) => {
    const base = layoutBaseline.rects[name];
    return (
      !rect || !base || rect.some((value, i) => Math.abs(value - base[i]) > 1)
    );
  });
  check(
    `no control moves: ${label}`,
    moved.length === 0,
    moved
      .map(
        ([name, rect]) =>
          `${name} ${JSON.stringify(layoutBaseline.rects[name])}→${JSON.stringify(rect)}`,
      )
      .join(' '),
  );
}

try {
  await page.setViewport({ width: 1280, height: 860 });
  await page.goto(`${BASE_URL}/?welcome=0`, { waitUntil: 'domcontentloaded' });
  const booted = await until(
    () =>
      window.__gevRecentImagery &&
      window.__godsEyeView &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    null,
    90_000,
  );
  check('the app boots with the Recent Imagery handle', booted);
  if (!booted) throw new Error('boot timeout');
  await page.evaluate(installPageHelpers);

  await setView(AUSTIN);
  await tilesSettled();
  const initialStack = await page.evaluate(() => window.__riQa.activeStack());
  const photoreal = initialStack === 'photoreal';
  console.log(`initial map stack: ${initialStack}`);
  const onPhotorealOnly = (name, passed, detail) =>
    photoreal
      ? check(name, passed, detail)
      : console.log(`[SKIP] ${name} — the boot stack is ${initialStack}`);

  // ── enable: the panel in the rail, per the rail readout pattern ─────────
  const layerToggle = '[data-layer-id="recent-imagery"] .data-toggle-btn';
  check(
    'the data panel carries a Recent Imagery toggle',
    await click(layerToggle),
  );
  check(
    'the layer enables from its toggle',
    await until(() =>
      window.__godsEyeView.dataManager.isEnabled('recent-imagery'),
    ),
  );
  check(
    'the panel appears on the right rail once enabled',
    await until(
      () => document.getElementById('recent-imagery-panel')?.hidden === false,
    ),
  );
  const railPlacement = await page.evaluate(() => {
    const rail = document.getElementById('right-context-rail');
    const panel = document.getElementById('recent-imagery-panel');
    const body = document.getElementById('recent-imagery-panel-body');
    const order = [...rail.children].map((child) => child.id);
    const at = (id) => order.indexOf(id);
    return {
      inRail: panel?.parentElement === rail,
      beforeContext: at('recent-imagery-panel') < at('global-context-panel'),
      afterWeather: at('weather-panel') < at('recent-imagery-panel'),
      collapsed: panel?.classList.contains('collapsed'),
      scroller: body?.hasAttribute('data-rail-scroller'),
      readoutInBody: body?.firstElementChild?.classList.contains(
        'recent-imagery-readout',
      ),
      body: body?.offsetHeight,
      title: panel?.querySelector('.panel-title')?.textContent,
      order,
    };
  });
  check(
    'the panel sits in the rail after WEATHER and before CONTEXT, expanded on first appearance',
    railPlacement.inRail &&
      railPlacement.beforeContext &&
      railPlacement.afterWeather &&
      railPlacement.collapsed === false &&
      railPlacement.body > 0,
    JSON.stringify(railPlacement),
  );
  check(
    'the body is a rail scroller holding the readout, under a RECENT IMAGERY header',
    railPlacement.scroller &&
      railPlacement.readoutInBody &&
      railPlacement.title === 'RECENT IMAGERY',
    JSON.stringify(railPlacement),
  );
  const listOf = (selector, key) =>
    page.evaluate(
      (sel, field) =>
        [...document.querySelectorAll(sel)]
          .map((node) => node.dataset[field] || node.id)
          .join(','),
      selector,
      key,
    );
  check(
    'the data-panel row carries only the two source chips',
    (await listOf(
      '[data-layer-id="recent-imagery"] .data-toggle-chip',
      'chipId',
    )) === 'hls,viirs',
  );
  const actionIds = await listOf(
    `${PANEL} .ri-actions-row [data-action-id]`,
    'actionId',
  );
  check(
    'the actions row holds SELECT BOX, USE VIEW and CLEAR',
    actionIds === 'select-box,use-view,clear',
    actionIds,
  );
  const blocks = await listOf(`${PANEL} .recent-imagery-readout > *`, 'none');
  check(
    'the body is the fixed stack: actions, notice, strip, hint, selection, controls, details',
    blocks ===
      'ri-actions,ri-notice,ri-strip,ri-hint,ri-selection,ri-controls,ri-details',
    blocks,
  );
  let current = await state();
  check(
    'before a box: CLEAR is disabled, the hint says what to do, IMAGE is the mode',
    (await page.evaluate(
      () =>
        document.querySelector('#recent-imagery-panel [data-action-id="clear"]')
          ?.disabled,
    )) === true &&
      current.hintText === 'Select a box or use the view' &&
      current.mode === 'image',
    `${current.hintText} ${current.mode}`,
  );
  await checkLayout('empty');
  await panelShot('01-enabled-panel');

  // ── USE VIEW at 12 km: days and the live preview ────────────────────────
  const beforeColour = await probe();
  const viewKm = await viewWidthKm();
  check('USE VIEW is clickable', await clickAction('use-view'));
  const searched = await until(() => {
    const snapshot = window.__riQa.snap();
    return !snapshot.searching && snapshot.candidates.length > 0;
  });
  current = await state();
  check(
    `USE VIEW at 12 km (${viewKm.toFixed(1)} km wide) sets a box and the catalog returns days within 20 s`,
    searched && Boolean(current.box),
    `${current.candidates.length} candidates, error=${current.error} boxError=${current.boxError}`,
  );
  check(
    'the strip renders one card per day',
    current.cards === current.candidates.length && current.cards > 0,
    `${current.cards} cards`,
  );
  const countText = await page.evaluate(
    () => document.getElementById('recent-imagery-panel-count')?.textContent,
  );
  check(
    'the header count reads the day count',
    /^\d+ DAYS?$/.test(countText),
    countText,
  );
  const startHere = await page.evaluate(() =>
    [...document.querySelectorAll('#recent-imagery-panel .ri-card-start')]
      .filter((node) => !node.hidden)
      .map((node) => node.closest('.ri-card').dataset.key),
  );
  check(
    'exactly one card wears START HERE',
    startHere.length === 1,
    startHere.join(','),
  );
  check(
    'the START HERE day previews on its own',
    await until(() => {
      const snap = window.__riQa.snap();
      return (
        Boolean(snap.preview.key) &&
        snap.preview.slot === 'a' &&
        window.__riQa.owned() === 1
      );
    }),
  );
  current = await state();
  check(
    'row A reads the previewed day, row B reads the basemap',
    /^IMAGE.+ · preview×$/.test(current.rowA) && current.rowB === 'VSBasemap×',
    `${current.rowA} | ${current.rowB}`,
  );
  onPhotorealOnly(
    'on Google 3D a shown image borrows the Esri surface',
    await onEsri(),
  );
  const esriNote = await until(
    () =>
      document.getElementById('ri-notice-text')?.textContent ===
      'Imagery on Esri · Google 3D returns when cleared',
    undefined,
    5_000,
  );
  current = await state();
  onPhotorealOnly(
    'the notice says the imagery is on Esri until cleared',
    esriNote,
    current.noticeText,
  );
  check(
    'one owned imagery layer on the globe, no divider',
    current.diagnostics.ownedCount === 1 &&
      current.gibsOnGlobe + current.gibsOnTileset === 1 &&
      !current.splitVisible,
    hostsDetail(current),
  );
  check(
    'at least one thumbnail settles (present/empty/error)',
    await until(() =>
      window.__riQa
        .snap()
        .candidates.some((c) => c.thumbnail.status !== 'unknown'),
    ),
  );
  await tilesSettled();
  let changedColour = null;
  for (let deadline = Date.now() + STEP_TIMEOUT; Date.now() < deadline;) {
    const colour = await probe();
    if (Math.hypot(...colour.map((c, i) => c - beforeColour[i])) > 6) {
      changedColour = colour;
      break;
    }
    await page.evaluate(() =>
      window.__godsEyeView.viewer.scene.requestRender(),
    );
    await wait(1000);
  }
  check(
    'the rendered frame inside the box changes once the preview drapes',
    Boolean(changedColour),
    `before=${beforeColour} after=${changedColour || (await probe())}`,
  );
  await checkLayout('preview');
  await shot('02-preview');
  await panelShot('02-preview-panel');

  // ── arrow keys: the preview follows the focus ───────────────────────────
  await until(() => {
    const snap = window.__riQa.snap();
    return snap.candidates.some(
      (c) => c.key !== snap.preview.key && c.drapable,
    );
  });
  current = await state();
  const targetIndex = current.candidates.findIndex(
    (c) => c.key !== current.preview && c.drapable,
  );
  check(
    'a present day other than the preview is reachable',
    targetIndex >= 0,
    String(targetIndex),
  );
  const targetKey = current.candidates[targetIndex]?.key;
  await focusStrip();
  await page.keyboard.press('Home');
  for (let i = 0; i < targetIndex; i += 1)
    await page.keyboard.press('ArrowRight');
  const pressedAt = Date.now();
  check(
    'arrow keys move focus at once',
    await until(
      (key) => window.__riQa.snap().focus?.key === key,
      targetKey,
      2_000,
    ),
    targetKey,
  );
  const followed = await until(
    (key) => window.__riQa.snap().preview.key === key,
    targetKey,
    1_500,
  );
  const elapsed = Date.now() - pressedAt;
  check(
    'the focused present day previews within 1 s',
    followed && elapsed <= 1_250,
    `preview after ${elapsed} ms`,
  );
  current = await state();
  check(
    'still a single owned layer while scrubbing',
    current.diagnostics.ownedCount === 1,
    hostsDetail(current),
  );
  const flag = await page.evaluate(
    (key) =>
      document.querySelector(
        `#recent-imagery-panel .ri-card[data-key="${key}"] .ri-card-flag`,
      )?.textContent,
    targetKey,
  );
  check('the previewed card wears PREVIEW', flag === 'PREVIEW', flag);

  // ── IMAGE: S pins the focused day; focus no longer moves the map ────────
  await pressOnStrip('s');
  current = await state();
  check(
    'S pins the focused day and its SHOW chip lights',
    current.pinA === targetKey &&
      (await page.evaluate(
        (key) =>
          document
            .querySelector(
              `#recent-imagery-panel .ri-card[data-key="${key}"] .ri-chip[data-slot="a"]`,
            )
            ?.getAttribute('aria-pressed'),
        targetKey,
      )) === 'true',
    current.pinA,
  );
  check(
    'row A reads the pinned day without "preview"',
    /^IMAGE.+×$/.test(current.rowA) && !/preview/.test(current.rowA),
    current.rowA,
  );
  await checkLayout('pinned');
  await page.keyboard.press(targetIndex > 0 ? 'ArrowLeft' : 'ArrowRight');
  await wait(700);
  current = await state();
  check(
    'with the image pinned, focus moves without changing the map',
    current.focus !== targetKey && current.shown.a === targetKey,
    `focus=${current.focus} shown=${current.shown.a}`,
  );
  await page.evaluate(() => {
    const slider = document.getElementById('ri-opacity');
    slider.value = '60';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  });
  current = await state();
  check(
    'OPACITY sets the draped alpha',
    Math.abs((await page.evaluate(() => window.__riQa.snap().alpha)) - 0.6) <
      1e-9,
  );
  await checkLayout('opacity');

  // ── VS BASEMAP: the pinned day swipes against the basemap ───────────────
  check('VS BASEMAP is one click', await clickMode('basemap'));
  const basemapSwipe = await until(
    () =>
      window.__riQa.snap().shown.swipe === 'basemap' &&
      window.__riQa.splitShown(),
  );
  current = await state();
  check(
    'VS BASEMAP shows the divider, labelled IMAGE / BASEMAP',
    basemapSwipe &&
      JSON.stringify(current.splitLabels) === '["IMAGE","BASEMAP"]',
    JSON.stringify(current.splitLabels),
  );
  check(
    'the image is on the left and the basemap on the right: one layer, split LEFT',
    current.diagnostics.ownedCount === 1 &&
      JSON.stringify(current.gibsSplits) === '[-1]',
    hostsDetail(current),
  );
  check(
    'the divider starts centred',
    Math.abs(current.splitPosition - 0.5) < 0.01 &&
      Math.abs(current.splitLeft - current.canvasWidth / 2) <= 2,
    `splitPosition=${current.splitPosition} left=${current.splitLeft} canvas=${current.canvasWidth}`,
  );
  check(
    'row B reads the basemap, lit',
    current.rowB === 'VSBasemap×' &&
      (await page.evaluate(() =>
        document.getElementById('ri-slot-b').classList.contains('lit'),
      )),
    current.rowB,
  );
  onPhotorealOnly(
    'the swipe runs on Esri',
    current.activeStack === 'esri-imagery',
    current.activeStack,
  );
  check(
    'the hint says SWAP trades the sides (VS BASEMAP)',
    current.hintText === 'Drag the divider · SWAP trades sides',
    current.hintText,
  );
  await checkLayout('vs basemap');
  await tilesSettled();
  await shot('03-vs-basemap');
  await panelShot('03-vs-basemap-panel');

  // ── A / B: pin A, preview then pin B, swipe, SWAP, unpin ────────────────
  check('A / B is one click', await clickMode('ab'));
  current = await state();
  check(
    'A / B keeps the pin as A and waits for B',
    current.mode === 'ab' &&
      current.pinA === targetKey &&
      !current.splitVisible &&
      /^A.+×$/.test(current.rowA) &&
      current.rowB === 'BNot set×',
    `${current.rowA} | ${current.rowB}`,
  );
  const chipLabels = await page.evaluate(
    (key) =>
      [
        ...document.querySelectorAll(
          `#recent-imagery-panel .ri-card[data-key="${key}"] .ri-chip`,
        ),
      ].map((chip) => chip.textContent),
    targetKey,
  );
  check(
    'the cards now carry A and B chips',
    JSON.stringify(chipLabels) === '["A","B"]',
    JSON.stringify(chipLabels),
  );
  await checkLayout('A / B, A pinned');
  const secondIndex = (await state()).candidates.findIndex(
    (c) => c.key !== targetKey && c.drapable,
  );
  const secondKey = current.candidates[secondIndex]?.key;
  await focusStrip();
  await page.keyboard.press('Home');
  for (let i = 0; i < secondIndex; i += 1)
    await page.keyboard.press('ArrowRight');
  check(
    'arrows preview the other day as B against A',
    await until(
      (key) => {
        const snap = window.__riQa.snap();
        return snap.preview.key === key && snap.preview.slot === 'b';
      },
      secondKey,
      3_000,
    ),
    secondKey,
  );
  await page.keyboard.press('b');
  const abSwipe = await until(
    (key) =>
      window.__riQa.snap().pins.b.key === key &&
      window.__riQa.snap().shown.swipe === 'ab' &&
      window.__riQa.splitShown(),
    secondKey,
  );
  current = await state();
  check(
    'B pins the second day and the divider reads A / B',
    abSwipe && JSON.stringify(current.splitLabels) === '["A","B"]',
    JSON.stringify(current.splitLabels),
  );
  check(
    'two owned layers: A left, B right',
    current.diagnostics.ownedCount === 2 &&
      JSON.stringify([...current.gibsSplits].sort()) === '[-1,1]',
    hostsDetail(current),
  );
  check(
    'the divider recentres for the new comparison',
    Math.abs(current.splitPosition - 0.5) < 0.01,
    String(current.splitPosition),
  );
  check(
    'row B reads the pinned day',
    /^B.+×$/.test(current.rowB) && !/Not set/.test(current.rowB),
    current.rowB,
  );
  onPhotorealOnly(
    'the A / B swipe runs on Esri',
    current.activeStack === 'esri-imagery',
    current.activeStack,
  );
  check(
    'the hint says SWAP trades the sides (A / B)',
    current.hintText === 'Drag the divider · SWAP trades sides',
    current.hintText,
  );
  await checkLayout('A / B, both pinned');
  await tilesSettled();
  await shot('04-ab');
  await panelShot('04-ab-panel');
  // SWAP trades the sides (Space is push-to-talk, so no key does this).
  const splitBeforeSwap = current.splitPosition;
  check('SWAP is one click while the swipe is live', await click('#ri-swap'));
  const swapped = await until(
    () =>
      window.__riQa.snap().swapped === true &&
      document.querySelector('#recent-imagery-split-line span.before')
        ?.textContent === 'B',
  );
  current = await state();
  check(
    'SWAP trades the divider labels to B / A and keeps the divider where it was',
    swapped &&
      JSON.stringify(current.splitLabels) === '["B","A"]' &&
      JSON.stringify([...current.gibsSplits].sort()) === '[-1,1]' &&
      Math.abs(current.splitPosition - splitBeforeSwap) < 0.01,
    `${JSON.stringify(current.splitLabels)} ${hostsDetail(current)} split=${current.splitPosition}`,
  );
  await checkLayout('A / B, swapped');
  check('SWAP again is one click', await click('#ri-swap'));
  const restored = await until(
    () =>
      window.__riQa.snap().swapped === false &&
      document.querySelector('#recent-imagery-split-line span.before')
        ?.textContent === 'A',
  );
  current = await state();
  check(
    'SWAP again restores A / B',
    restored && JSON.stringify(current.splitLabels) === '["A","B"]',
    JSON.stringify(current.splitLabels),
  );
  check('B unpins from its ×', await click('#ri-unpin-b'));
  const singleA = await until(
    () =>
      window.__riQa.owned() === 1 &&
      !document.getElementById('recent-imagery-split-line'),
  );
  current = await state();
  check(
    'unpinning B drops its layer at once: A alone, no divider',
    singleA && current.shown.a === targetKey && !current.shown.b,
    hostsDetail(current),
  );
  check(
    'without a swipe SWAP keeps its slot, disabled and invisible',
    await page.evaluate(() => {
      const swap = document.getElementById('ri-swap');
      return Boolean(
        swap?.disabled &&
        swap.classList.contains('is-reserved') &&
        getComputedStyle(swap).visibility === 'hidden',
      );
    }),
  );
  onPhotorealOnly(
    'A alone stays on Esri',
    current.activeStack === 'esri-imagery',
    current.activeStack,
  );
  await checkLayout('B unpinned');
  check('A unpins from its ×', await click('#ri-unpin-a'));
  check('with nothing shown, no layer remains', await ownedIs(0));
  onPhotorealOnly(
    'with nothing shown, Google 3D comes back',
    await backOnPhotoreal(),
  );
  await checkLayout('A unpinned');

  // ── the share link carries the pins and the mode ────────────────────────
  await clickMode('basemap');
  await pressOnStrip('a');
  const shared = await until(
    () => {
      const params = new URLSearchParams(window.location.hash.slice(1));
      const layers = (params.get('l') || '').split('.');
      const options = params.get('lo') || '';
      return (
        layers.includes('1') &&
        /(^|_)1\.a\.[SLV]\d{8}/.test(options) &&
        /(^|_)1\.m\.1(_|$)/.test(options) &&
        /(^|_)1\.w\.-?\d+/.test(options)
      );
    },
    undefined,
    8_000,
  );
  check(
    'the share link carries the layer, the box, the pin and the mode',
    shared,
    await page.evaluate(() => window.location.hash.slice(0, 400)),
  );

  // ── Escape order: preview, then the box tool ────────────────────────────
  await click('#ri-unpin-a');
  await clickMode('image');
  await ownedIs(0);
  await focusStrip();
  await page.keyboard.press('ArrowRight');
  check(
    'a focus move previews again',
    await until(
      () => Boolean(window.__riQa.snap().preview.key),
      undefined,
      5_000,
    ),
  );
  check(
    'SELECT BOX arms the box tool',
    (await clickAction('select-box')) &&
      (await until(() => window.__gevRecentImagery.tool.isActive())),
  );
  await page.keyboard.press('Escape');
  const escapedPreview = await until(
    () => !window.__riQa.snap().preview.key,
    undefined,
    3_000,
  );
  const stillArmed = await page.evaluate(() =>
    window.__gevRecentImagery.tool.isActive(),
  );
  check(
    'Escape clears the preview first and leaves SELECT BOX armed',
    escapedPreview && stillArmed,
    `preview cleared=${escapedPreview} toolActive=${stillArmed}`,
  );
  await page.keyboard.press('Escape');
  check(
    'the next Escape cancels the box tool',
    await until(() => !window.__gevRecentImagery.tool.isActive()),
  );
  onPhotorealOnly(
    'with the preview cleared Google 3D comes back',
    await backOnPhotoreal(),
  );

  // ── oversized USE VIEW → refusal in the notice line ─────────────────────
  let refusalWidth = 0;
  for (const height of [400_000, 900_000, 1_800_000]) {
    await setView({ ...AUSTIN, height });
    await wait(300);
    refusalWidth = await viewWidthKm();
    if (refusalWidth > 1_100) break;
  }
  const boxBefore = JSON.stringify((await state()).box);
  await clickAction('use-view');
  const refused = await until(
    () =>
      /^View is/.test(
        document.getElementById('ri-notice-text')?.textContent || '',
      ),
    undefined,
    5_000,
  );
  current = await state();
  check(
    `an oversized USE VIEW (${Math.round(refusalWidth)} km) is refused in the notice line`,
    refused &&
      /^View is [\d,]+ km wide · limit 1,000 km$/.test(current.noticeText),
    current.noticeText,
  );
  check(
    'the hint says to zoom in or draw a smaller box',
    current.hintText === 'Zoom in or draw a smaller box',
    current.hintText,
  );
  check('the refusal keeps the box', JSON.stringify(current.box) === boxBefore);
  const refusalLine = await page.evaluate(() => {
    const text = document.getElementById('ri-notice-text');
    const chip = document.getElementById('ri-zoom-in');
    const line = document.getElementById('ri-notice').getBoundingClientRect();
    const rect = chip.getBoundingClientRect();
    return {
      fits: text.scrollWidth <= text.clientWidth,
      scrollWidth: text.scrollWidth,
      clientWidth: text.clientWidth,
      chipVisible:
        getComputedStyle(chip).visibility === 'visible' &&
        !chip.disabled &&
        rect.width > 0,
      chipAtEnd: Math.abs(rect.right - line.right) <= 1,
      lineHeight: line.height,
    };
  });
  check(
    'the refusal fits the notice line without an ellipsis',
    refusalLine.fits,
    JSON.stringify(refusalLine),
  );
  check(
    'ZOOM IN shows at the right end of the notice line, which keeps its height',
    refusalLine.chipVisible &&
      refusalLine.chipAtEnd &&
      Math.abs(refusalLine.lineHeight - 14) <= 0.5,
    JSON.stringify(refusalLine),
  );
  await checkLayout('refused');
  await panelShot('05-refused-panel');
  // ZOOM IN: straight down to the height whose view is 400 km wide.
  const fitHeight = await page.evaluate(() => {
    const viewer = window.__godsEyeView.viewer;
    const canvas = viewer.scene.canvas;
    const halfWidth =
      Math.tan(viewer.camera.frustum.fovy / 2) *
      (canvas.clientWidth / canvas.clientHeight);
    return Math.min(400, Math.max(5, 400 / (2 * halfWidth))) * 1000;
  });
  check('ZOOM IN is clickable', await click('#ri-zoom-in'));
  const zoomed = await until(
    (target) =>
      Math.abs(
        window.__godsEyeView.viewer.camera.positionCartographic.height - target,
      ) <=
      target * 0.01,
    fitHeight,
    2_000,
  );
  const zoomedHeight = await page.evaluate(
    () => window.__godsEyeView.viewer.camera.positionCartographic.height,
  );
  check(
    `ZOOM IN flies to ${Math.round(fitHeight / 1000)} km within 2 s`,
    zoomed,
    `height=${Math.round(zoomedHeight)} target=${Math.round(fitHeight)}`,
  );
  await tilesSettled();
  const fittedWidth = await viewWidthKm();
  await clickAction('use-view');
  const fitted = await until(
    () => {
      const snap = window.__riQa.snap();
      return Boolean(snap.box) && !snap.boxError && !snap.zoomToFit;
    },
    undefined,
    5_000,
  );
  current = await state();
  check(
    `the next USE VIEW (${Math.round(fittedWidth)} km) succeeds and ZOOM IN is reserved again`,
    fitted &&
      (await page.evaluate(() =>
        document.getElementById('ri-zoom-in').classList.contains('is-reserved'),
      )),
    `boxError=${current.boxError} notice=${current.noticeText}`,
  );
  await checkLayout('fitted');

  // ── CLEAR ────────────────────────────────────────────────────────────────
  await setView(AUSTIN);
  await pressOnStrip('ArrowRight');
  await until(() => window.__riQa.owned() === 1, undefined, 5_000);
  await clickAction('clear');
  const clearedAll = await until(() => {
    const snap = window.__riQa.snap();
    return (
      !snap.box &&
      !snap.pins.a.key &&
      !snap.pins.b.key &&
      !snap.preview.key &&
      window.__riQa.owned() === 0
    );
  });
  current = await state();
  check(
    'CLEAR empties the box, the pins and the preview',
    clearedAll && current.noticeText === 'Box and images cleared',
    `box=${JSON.stringify(current.box)} owned=${current.diagnostics.ownedCount} notice=${current.noticeText}`,
  );
  onPhotorealOnly('CLEAR hands Google 3D back', await backOnPhotoreal());
  await wait(1_500);
  onPhotorealOnly(
    'after CLEAR the layer does not take Esri again',
    (await page.evaluate(() => window.__riQa.activeStack())) === 'photoreal',
  );
  await checkLayout('cleared');

  // ── map-switch rebind ───────────────────────────────────────────────────
  await tilesSettled();
  await page.evaluate(
    (view) => window.__riQa.layer().boxFromPinAt(view.lon, view.lat),
    AUSTIN,
  );
  const redraped = await until(() => {
    const snap = window.__riQa.snap();
    return (
      !snap.searching &&
      Boolean(snap.preview.key) &&
      window.__riQa.owned() === 1
    );
  });
  check('a 10 km box previews the START HERE day again', redraped);
  const stacks = await page.evaluate(() =>
    window.__godsEyeView.mapStackController
      .getStacks()
      .filter((s) => s.available)
      .map((s) => s.id),
  );
  const setStack = (id) =>
    page.evaluate(
      (stack) => window.__godsEyeView.mapStackController.setStack(stack),
      id,
    );
  /** Wait for the one GIBS drape to sit on the given host only. */
  const drapeOn = (host) =>
    until(
      (where) => {
        const hosts = window.__riQa.hosts();
        return where === 'globe'
          ? hosts.globeShown && hosts.globe === 1 && hosts.tileset === 0
          : !hosts.globeShown && hosts.globe === 0 && hosts.tileset === 1;
      },
      host,
      10_000,
    );
  if (photoreal && stacks.includes('esri-imagery')) {
    check('the preview sits on the Esri globe', await drapeOn('globe'));
    // While a day is shown the imagery keeps Esri: a manual switch to
    // Google 3D is answered at once with a new lease.
    await setStack('photoreal');
    const kept = (await onEsri()) && (await drapeOn('globe'));
    current = await state();
    check(
      'switching to Google 3D by hand while a day is shown keeps the imagery on the Esri globe',
      kept && current.diagnostics.host === 'globe',
      `${hostsDetail(current)} stack=${current.activeStack}`,
    );
    check(
      'the notice says the imagery stays on Esri until CLEAR, and fits',
      current.noticeText === 'Imagery stays on Esri · CLEAR to use Google 3D' &&
        (await page.evaluate(() => {
          const text = document.getElementById('ri-notice-text');
          return text.scrollWidth <= text.clientWidth;
        })),
      current.noticeText,
    );
    await wait(1_500);
    check(
      'Esri holds after the re-lease: no switch loop',
      (await page.evaluate(() => window.__riQa.activeStack())) ===
        'esri-imagery',
    );
    // The divider survives a manual switch too.
    await clickMode('basemap');
    await until(() => window.__riQa.splitShown(), undefined, 10_000);
    await setStack('photoreal');
    const dividerKept =
      (await onEsri()) &&
      (await until(
        () =>
          window.__riQa.splitShown() && window.__riQa.snap().comparison.active,
        undefined,
        10_000,
      ));
    current = await state();
    check(
      'a manual switch to Google 3D during VS BASEMAP keeps the divider',
      dividerKept &&
        current.shown.swipe === 'basemap' &&
        !current.comparison.suspended,
      `${hostsDetail(current)} stack=${current.activeStack} comparison=${JSON.stringify(current.comparison)}`,
    );
    await tilesSettled();
    await shot('06-google-3d-kept-on-esri');
    await clickMode('image');
    await until(() => !window.__riQa.splitShown(), undefined, 5_000);
  } else {
    const other = stacks.find(
      (id) => id !== initialStack && id !== 'photoreal',
    );
    if (other) {
      await setStack(other);
      check(
        `switching to ${other} keeps the drape on the globe`,
        await drapeOn('globe'),
      );
      await setStack(initialStack);
    } else {
      console.log('[SKIP] map-switch rebind — no second map stack available');
    }
  }

  // ── collapse / expand, CCTV stability, DISPLAY + CONTEXT reachable ──────
  /** Click a panel's collapse button; resolves to whether it is expanded. */
  const togglePanel = (id) =>
    page.evaluate((panelId) => {
      const button = document.querySelector(
        `.panel-collapse-btn[data-collapse-target="${panelId}"]`,
      );
      if (!button) return null;
      button.click();
      return !document.getElementById(panelId)?.classList.contains('collapsed');
    }, id);
  const imageryPanel = 'recent-imagery-panel';
  const collapsedNow = (await togglePanel(imageryPanel)) === false;
  await wait(400);
  const headerOnly = await page.evaluate(() => ({
    panel: document.getElementById('recent-imagery-panel')?.offsetHeight,
    body: document.getElementById('recent-imagery-panel-body')?.offsetHeight,
  }));
  check(
    'collapsing the panel leaves a header bar only',
    collapsedNow &&
      headerOnly.body === 0 &&
      headerOnly.panel > 0 &&
      headerOnly.panel <= 80,
    JSON.stringify(headerOnly),
  );
  const expandedAgain = await togglePanel(imageryPanel);
  await wait(400);
  const bodyBack = await page.evaluate(
    () => document.getElementById('recent-imagery-panel-body')?.offsetHeight,
  );
  check(
    'expanding the panel brings the body back',
    expandedAgain === true && bodyBack > 0,
    `body=${bodyBack}`,
  );

  /** Sample both panel heights for 2 s; settled = the tail never changes. */
  const settledHeights = async () => {
    const samples = [];
    for (let i = 0; i < 20; i += 1) {
      samples.push(
        await page.evaluate(() => ({
          imagery: document.getElementById('recent-imagery-panel')
            ?.offsetHeight,
          cctv: document.getElementById('cctv-panel')?.offsetHeight,
        })),
      );
      await wait(100);
    }
    const tail = (key) => new Set(samples.slice(8).map((s) => s[key]));
    return {
      settled: tail('imagery').size === 1 && tail('cctv').size === 1,
      detail: `imagery=${samples.map((s) => s.imagery).join(',')} cctv=${samples.map((s) => s.cctv).join(',')}`,
    };
  };
  const railFit = () =>
    page.evaluate(() => {
      const px = (element) =>
        parseFloat(
          element?.style.getPropertyValue('--right-panel-allocated-height'),
        );
      const cctv = document.getElementById('cctv-panel');
      const imagery = document.getElementById('recent-imagery-panel');
      const rail = document.getElementById('right-context-rail');
      // Reachable: its header is on screen, or the rail's exclusive policy
      // (an expanded panel under the tactical HUD) hid it while collapsed.
      const reach = (id) => {
        const element = document.getElementById(id);
        return (
          window.__riQa.headerOnScreen(id) ||
          (rail?.classList.contains('layout-exclusive') &&
            element?.classList.contains('collapsed') &&
            element.getBoundingClientRect().height === 0)
        );
      };
      return {
        cctvRendered: cctv?.offsetHeight ?? null,
        cctvAllocated: px(cctv),
        imageryRendered: imagery?.offsetHeight ?? null,
        imageryAllocated: px(imagery),
        imageryCollapsed: Boolean(imagery?.classList.contains('collapsed')),
        imageryDisplay: imagery ? getComputedStyle(imagery).display : null,
        focus: rail?.classList.contains('layout-focus'),
        exclusive: rail?.classList.contains('layout-exclusive'),
        display: reach('pp-toggles'),
        context: reach('global-context-panel'),
      };
    });
  for (const height of [900, 700]) {
    const at = `(${height} px viewport)`;
    await page.setViewport({ width: 1280, height });
    await wait(600);
    check(
      `the CCTV panel expands from its launcher ${at}`,
      (await togglePanel('cctv-panel')) === true,
    );
    const expanded = await settledHeights();
    check(
      `the imagery and CCTV panel heights settle with CCTV expanded ${at}`,
      expanded.settled,
      expanded.detail,
    );
    const fit = await railFit();
    check(
      `CCTV renders at its allocated height beside the imagery panel ${at}`,
      !fit.focus ||
        (Number.isFinite(fit.cctvAllocated) &&
          Math.abs(fit.cctvRendered - fit.cctvAllocated) <= 2),
      JSON.stringify(fit),
    );
    // A collapsed panel has no allocation, so it is judged on its own terms:
    // the exclusive rail (one expanded panel) hides it outright, otherwise it
    // is a header bar. An expanded panel must have been allocated a height.
    const imageryFits = fit.imageryCollapsed
      ? fit.exclusive
        ? fit.imageryRendered === 0 && fit.imageryDisplay === 'none'
        : fit.imageryRendered > 0 && fit.imageryRendered <= 80
      : !fit.focus ||
        (Number.isFinite(fit.imageryAllocated) &&
          fit.imageryRendered <= fit.imageryAllocated + 2);
    check(
      `the imagery panel stays within its allocation, or takes no room when the exclusive rail hides it collapsed ${at}`,
      imageryFits,
      JSON.stringify(fit),
    );
    check(
      `DISPLAY and CONTEXT stay reachable ${at}`,
      fit.display && fit.context,
      JSON.stringify(fit),
    );
    await shot(`07-cctv-expanded-${height}`);
    check(
      `the CCTV panel collapses again ${at}`,
      (await togglePanel('cctv-panel')) === false,
    );
    const collapsed = await settledHeights();
    check(
      `the panel heights settle with CCTV collapsed ${at}`,
      collapsed.settled,
      collapsed.detail,
    );
    const imageryExpanded = await page.evaluate(
      () =>
        !document
          .getElementById('recent-imagery-panel')
          ?.classList.contains('collapsed'),
    );
    if (imageryExpanded) await togglePanel(imageryPanel);
    await wait(400);
    const onScreen = await page.evaluate(() =>
      Object.fromEntries(
        [
          'pp-toggles',
          'global-context-panel',
          'recent-imagery-panel',
          'cctv-panel',
        ].map((id) => [id, window.__riQa.headerOnScreen(id)]),
      ),
    );
    check(
      `DISPLAY, CONTEXT, CCTV and the imagery header are all on screen once everything is collapsed ${at}`,
      Object.values(onScreen).every(Boolean),
      JSON.stringify(onScreen),
    );
    await togglePanel(imageryPanel);
    await wait(400);
  }

  // ── scroll preservation (700 px viewport, body scrollable) ───────────────
  await page.evaluate(() => {
    const header = document.querySelector('#ri-details .rail-card-header');
    if (header?.getAttribute('aria-expanded') !== 'true') header?.click();
  });
  await wait(300);
  const bodyScroll = () =>
    page.evaluate(() => {
      const body = document.getElementById('recent-imagery-panel-body');
      return {
        top: body.scrollTop,
        max: body.scrollHeight - body.clientHeight,
      };
    });
  const start = await page.evaluate(() => {
    const body = document.getElementById('recent-imagery-panel-body');
    const max = body.scrollHeight - body.clientHeight;
    if (max > 0) body.scrollTop = Math.round(max / 2);
    return { max, top: body.scrollTop };
  });
  check(
    'with DETAILS open at 700 px the body scrolls',
    start.max > 0,
    JSON.stringify(start),
  );
  if (start.max > 0) {
    await page.evaluate(() => {
      const layer = window.__riQa.layer();
      layer.setAlpha(0.9);
      layer.setToolActive(true);
      layer.setToolActive(false);
    });
    await wait(300);
    const afterNotify = await bodyScroll();
    check(
      'the body scroll position survives alpha and state notifications',
      Math.abs(afterNotify.top - start.top) <= 1,
      `before=${start.top} after=${afterNotify.top}`,
    );
    await focusStrip();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await wait(600);
    const afterArrows = await bodyScroll();
    check(
      'the body scroll position survives arrow navigation',
      Math.abs(afterArrows.top - start.top) <= 1,
      `before=${start.top} after=${JSON.stringify(afterArrows)}`,
    );
    await shot('08-scrolled');
  }
  await page.setViewport({ width: 1280, height: 860 });

  // ── disable ───────────────────────────────────────────────────────────────
  await click(layerToggle);
  check(
    'the layer disables from its toggle',
    await until(
      () => !window.__godsEyeView.dataManager.isEnabled('recent-imagery'),
    ),
  );
  const cleared = await until(() => {
    const hosts = window.__riQa.hosts();
    return (
      window.__riQa.owned() === 0 &&
      hosts.globe + hosts.tileset === 0 &&
      !document.getElementById('recent-imagery-split-line')
    );
  });
  current = await state();
  check(
    'disabling leaves zero owned layers and no split line',
    cleared,
    `${hostsDetail(current)} split=${current.splitVisible}`,
  );
  check('the panel hides when the layer is off', current.panelHidden === true);
  onPhotorealOnly('disabling hands Google 3D back', await backOnPhotoreal());
  await wait(1_500);
  onPhotorealOnly(
    'disabled, the layer never takes Esri again',
    (await page.evaluate(() => window.__riQa.activeStack())) === 'photoreal',
  );
  await shot('09-disabled');

  check(
    'no page errors during the run',
    errors.length === 0,
    errors.join(' | '),
  );
} catch (error) {
  check(
    'run completed',
    false,
    error?.stack || error?.message || String(error),
  );
} finally {
  await browser.close();
}
console.log(`shots: ${shots.join(', ')}`);
console.log(`RESULT: ${checks} checks, ${failures} failures`);
process.exitCode = failures ? 1 : 0;
