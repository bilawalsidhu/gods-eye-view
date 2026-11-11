#!/usr/bin/env node
// Cesium-only probes: the stock input action and DataSource counts verify Cesium input restoration.
import { evaluateWithGeo } from './qa/geometry.mjs';
/** Rendered acceptance for UTILITIES ▸ Draw: real clicks, real keys, real teardown. */
import { whenSettled, whenTilesLoaded } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { chromeExecutablePath } from './qa-chrome.mjs';

const BASE_URL = process.env.QA_BASE_URL || 'http://localhost:4173';
const SHOT_DIR = process.env.QA_SHOT_DIR || 'qa-shots/draw';
const SHOT_PREFIX = process.env.QA_SHOT_PREFIX || '';
const HEADFUL = process.env.QA_HEADFUL === '1';
// A dense, recognisable grid: neighbourhood blocks to enclose and a straight
// road to trace along.
const VIEW = {
  lon: -122.4194,
  lat: 37.7749,
  height: 900,
  heading: 0,
  pitch: -85,
};

const browser = await launchBrowser({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    ...(HEADFUL ? ['--window-size=1280,860'] : []),
    ...(process.platform === 'darwin' ? ['--enable-gpu'] : []),
  ],
});
const page = await browser.newPage();
// Daylight over San Francisco: the amber-pixel checks count the drawn mark,
// and the globe's night side shows warm city lights the count would include.
await page.evaluateOnNewDocument(() => {
  const offset = Date.UTC(2026, 5, 15, 20, 0) - Date.now();
  const RealDate = Date;
  globalThis.Date = class ShiftedDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(RealDate.now() + offset);
      else super(...args);
    }
    static now() {
      return RealDate.now() + offset;
    }
  };
});
const errors = [];
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
let failures = 0;
function check(name, passed, detail = '') {
  console.log(
    `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!passed) failures++;
}
fs.mkdirSync(SHOT_DIR, { recursive: true });
const shot = (name) =>
  page.screenshot({
    path: path.join(SHOT_DIR, `${SHOT_PREFIX}${name}.jpg`),
    type: 'jpeg',
    quality: 82,
  });

/** A clip of the globe canvas, clear of the panels on every side. */
const CANVAS_CLIP = { x: 340, y: 200, width: 560, height: 380 };

// Clear of the open UTILITIES panel (x 100–380), whose own amber swatch
// dims when its row's shape is hidden.
const LINE_CLIP = { x: 390, y: 200, width: 510, height: 380 };
/** The canvas clip as a PNG, for comparing two moments of the same view. */
const canvasShot = () =>
  page.screenshot({ clip: LINE_CLIP, type: 'png', encoding: 'base64' });

/**
 * Amber pixels in one shot that are not amber in another of the same view:
 * a mark's own pixels, apart from imagery and panels that both shots share.
 */
function amberOnlyIn(shotA, shotB) {
  return page.evaluate(
    async (a, b) => {
      const pixels = async (base64) => {
        const bitmap = await createImageBitmap(
          await (await fetch(`data:image/png;base64,${base64}`)).blob(),
        );
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
        const context = canvas.getContext('2d');
        context.drawImage(bitmap, 0, 0);
        return context.getImageData(0, 0, bitmap.width, bitmap.height).data;
      };
      const amber = (d, i) =>
        d[i] > 150 &&
        d[i + 1] > 90 &&
        d[i + 1] < 220 &&
        d[i + 2] < 130 &&
        d[i] - d[i + 2] > 70 &&
        d[i] - d[i + 1] > 20;
      const [da, db] = [await pixels(a), await pixels(b)];
      let only = 0;
      for (let i = 0; i < da.length; i += 4)
        if (amber(da, i) && !amber(db, i)) only += 1;
      return only;
    },
    shotA,
    shotB,
  );
}

/**
 * How many amber pixels the clip contains. The drawn area's stroke and fill are
 * the only amber in this scene, so the count going UP after a shape is finished
 * is the shape actually painting — which is what CESIUM_3D_TILE-only
 * classification failed to do on a keyless boot while still reporting a mark on
 * the board. Decoding happens in the page because Node here has no image
 * decoder.
 */
async function amberPixels() {
  const shot64 = await page.screenshot({
    clip: CANVAS_CLIP,
    type: 'png',
    encoding: 'base64',
  });
  return page.evaluate(async (base64) => {
    const bitmap = await createImageBitmap(
      await (await fetch(`data:image/png;base64,${base64}`)).blob(),
    );
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
    let amber = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Warm and saturated: the amber mark (#ffb547) blended over imagery.
      if (r > 150 && g > 90 && g < 220 && b < 130 && r - b > 70 && r - g > 20)
        amber += 1;
    }
    return amber;
  }, shot64);
}

/**
 * Press Enter as the person drawing does — with the map focused, not a button.
 * Enter on a focused control means "press this control", so the tool ignores it
 * there; the harness has to move focus the way a user would before using the
 * finish key.
 */
async function pressFinish() {
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.keyboard.press('Enter');
}

/** One click on the globe canvas, the way a person makes one. */
async function clickWorld(x, y, options = {}) {
  await page.mouse.click(x, y, options);
  await whenSettled(page);
}

const drawState = () =>
  page.evaluate(() => {
    const tool = window.__gevDrawTool;
    return {
      ...tool.diagnostics(),
      shape: tool.shape,
      vertices: tool.session?.vertices?.length ?? null,
      hint: document.getElementById('draw-hint')?.textContent || '',
      marks: window.__gevAnnotations.count(),
    };
  });

const marks = () =>
  page.evaluate(() =>
    window.__gevAnnotations.list().map((mark) => ({
      type: mark.type,
      label: mark.label,
      color: mark.color,
      source: mark.source ?? null,
    })),
  );

/** Wait until the board has settled at `expected` marks (annotate is async). */
async function waitForMarks(expected, timeout = 15_000) {
  try {
    await page.waitForFunction(
      (want) => window.__gevAnnotations.count() === want,
      { timeout },
      expected,
    );
    return true;
  } catch {
    return false;
  }
}

try {
  await page.setViewport({ width: 1280, height: 860 });
  // The view in the address too: the boot flight lands there instead of
  // flying away from the view set below once deferred init runs.
  await page.goto(
    `${BASE_URL}/?welcome=0#v=2&lat=${VIEW.lat}&lon=${VIEW.lon}&alt=${VIEW.height}&heading=${VIEW.heading}&pitch=${VIEW.pitch}`,
    { waitUntil: 'domcontentloaded' },
  );
  await page.waitForFunction(
    () => window.__gevDrawTool && window.__gevAnnotations,
    { timeout: 90_000 },
  );
  await whenSettled(page);
  await evaluateWithGeo(
    page,
    async (qaGeo, view) => {
      window.__godsEyeView.engine.camera.cancelFlight?.();
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: (view.lon * Math.PI) / 180,
          latitude: (view.lat * Math.PI) / 180,
          height: view.height,
        }),
        orientation: {
          heading: (view.heading * Math.PI) / 180,
          pitch: (view.pitch * Math.PI) / 180,
          roll: 0,
        },
      });
      window.__godsEyeView.engine.render.request();
    },
    VIEW,
  );
  const settled = await whenTilesLoaded(page, { timeoutMs: 90_000 }).then(
    () => true,
    () => false,
  );
  check('visible tile content settles before drawing', settled);

  // UTILITIES starts collapsed on a first run: open it the way a user does.
  await page.evaluate(() => {
    const panel = document.getElementById('utilities-panel');
    if (panel?.classList.contains('collapsed'))
      document
        .querySelector(
          '.panel-collapse-btn[data-collapse-target="utilities-panel"]',
        )
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('draw-toggle')?.getBoundingClientRect().width > 0,
    { timeout: 10_000 },
  );
  check(
    'the Draw control is in the UTILITIES panel and starts off',
    await page.evaluate(() => {
      const toggle = document.getElementById('draw-toggle');
      return (
        toggle?.getAttribute('aria-pressed') === 'false' &&
        !document.getElementById('draw-mode-row')?.classList.contains('visible')
      );
    }),
  );

  // The viewer's OWN click actions, captured before the tool ever runs. Both
  // must be absent while drawing and back — as the SAME functions — after.
  await page.evaluate(() => {
    const Cesium = window.__CESIUM__;
    const stock = window.__godsEyeView.viewer.screenSpaceEventHandler;
    window.__qaStock = {
      click:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null,
      double:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
        null,
    };
  });
  const stockActions = () =>
    page.evaluate(() => {
      const Cesium = window.__CESIUM__;
      const stock = window.__godsEyeView.viewer.screenSpaceEventHandler;
      const live = {
        click:
          stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null,
        double:
          stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
          null,
      };
      return {
        clickPresent: Boolean(live.click),
        doublePresent: Boolean(live.double),
        clickIsOriginal: live.click === window.__qaStock.click,
        doubleIsOriginal: live.double === window.__qaStock.double,
        hadClick: Boolean(window.__qaStock.click),
        hadDouble: Boolean(window.__qaStock.double),
      };
    });

  // ── enable / disable cycles leave nothing behind ────────────────────────
  const before = await drawState();
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.click('#draw-toggle');
    await whenSettled(page);
    await page.click('#draw-toggle');
    await whenSettled(page);
  }
  const after = await drawState();
  check(
    'three enable/disable cycles add no listener, handler or preview data source',
    after.domListeners === before.domListeners &&
      after.previewDataSources === 0 &&
      before.previewDataSources === 0 &&
      after.sceneHandler === false &&
      after.pointerOwner === null,
    `listeners ${before.domListeners}→${after.domListeners}, previews ${after.previewDataSources}, ` +
      `handler ${after.sceneHandler}, owner ${after.pointerOwner}`,
  );

  // ── the viewer's own click actions are borrowed, then given back ────────
  await page.click('#draw-toggle');
  const duringDraw = await stockActions();
  check(
    "Cesium's own selecting click and tracking double-click are both borrowed while drawing",
    duringDraw.clickPresent === false && duringDraw.doublePresent === false,
    `click present ${duringDraw.clickPresent}, double present ${duringDraw.doublePresent} ` +
      `(viewer had click ${duringDraw.hadClick}, double ${duringDraw.hadDouble})`,
  );
  await page.click('#draw-toggle');
  const afterDraw = await stockActions();
  check(
    'and both are restored as the SAME functions, not replacements',
    afterDraw.clickPresent === duringDraw.hadClick &&
      afterDraw.doublePresent === duringDraw.hadDouble &&
      afterDraw.clickIsOriginal &&
      afterDraw.doubleIsOriginal,
    JSON.stringify(afterDraw),
  );

  // ── a pin, finished with Enter ──────────────────────────────────────────
  await page.click('#draw-toggle');
  await page.click('.pp-mode-btn[data-shape="pin"]');
  await clickWorld(520, 330);
  check(
    'the pointer is claimed while a session is open',
    (await drawState()).pointerOwner === 'draw',
  );
  await page.keyboard.press('Enter');
  check(
    'a pin placed by mouse and finished with Enter lands on the board',
    await waitForMarks(1),
  );

  // ── a line along a road, with Backspace ─────────────────────────────────
  await page.click('.pp-mode-btn[data-shape="line"]');
  // Clear of the open UTILITIES panel, which sits beside the left rail.
  await clickWorld(420, 300);
  await clickWorld(470, 380);
  await clickWorld(600, 470);
  const beforeBackspace = (await drawState()).vertices;
  await page.keyboard.press('Backspace');
  await whenSettled(page);
  const afterBackspace = (await drawState()).vertices;
  check(
    'Backspace removes the last vertex only',
    beforeBackspace === 3 && afterBackspace === 2,
    `${beforeBackspace} → ${afterBackspace}`,
  );
  await clickWorld(640, 500);
  await page.keyboard.press('Enter');
  check('a line finished with Enter lands on the board', await waitForMarks(2));
  const lineMark = (await marks()).find((mark) => mark.type === 'route');
  check(
    'a drawn line reports its length and never a travel time',
    Boolean(lineMark) &&
      /\d/.test(lineMark.label) &&
      !/min|walk|drive/i.test(lineMark.label),
    lineMark?.label,
  );
  await shot('02-line-along-a-road');

  // ── an area, coloured and labelled, finished with a double-click ────────
  await page.click('.pp-mode-btn[data-shape="area"]');
  await page.click('.draw-color[data-color="amber"]');
  const amberBefore = await amberPixels();
  await clickWorld(400, 280);
  await clickWorld(700, 290);
  await clickWorld(720, 520);
  await clickWorld(410, 500);
  const areaVertices = (await drawState()).vertices;
  check(
    'four clicks on the globe are four vertices',
    areaVertices === 4,
    `${areaVertices} vertices`,
  );
  await page.mouse.click(410, 500, { count: 2 });
  const areaLanded = await waitForMarks(3);
  await whenSettled(page);
  const afterDoubleClick = await page.evaluate(() =>
    window.__gevAnnotations.count(),
  );
  check('an area finished by double-click lands on the board', areaLanded);
  check(
    'a double-click finishes the shape exactly once',
    afterDoubleClick === 3,
    `${afterDoubleClick} marks`,
  );
  // ── each drawn shape gets a row: named, recoloured, hidden from there ──
  const rowIds = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('#draw-mark-list [data-mark-id]')].map(
        (row) => row.dataset.markId,
      ),
    );
  const ids = await rowIds();
  check('every drawn shape has a row under Draw', ids.length === 3, ids);
  const areaId = ids[2];
  const rowControl = (id, control) =>
    `#draw-mark-list [data-mark-id="${id}"] [data-control="${control}"]`;
  await page.click(rowControl(areaId, 'name'));
  await page.keyboard.type('Civic Center block');
  await page.keyboard.press('Enter');
  await whenSettled(page);
  const areaMark = (await marks()).find(
    (mark) => mark.label === 'Civic Center block',
  );
  check(
    'the name typed in its row and the colour picked before drawing are what is drawn',
    areaMark?.color === 'amber',
    JSON.stringify(areaMark),
  );
  check(
    'naming a shape keeps Draw on and the shape in progress untouched',
    (await drawState()).active === true,
  );
  await whenSettled(page);
  const amberAfter = await amberPixels();
  check(
    'the finished area actually PAINTS — amber pixels appear on this surface',
    amberAfter - amberBefore > 500,
    `${amberBefore} → ${amberAfter} amber pixels (+${amberAfter - amberBefore})`,
  );
  await shot('01-area-with-label');

  // ── the row's own controls: recolour, hide and show, fly to ─────────────
  const markState = (id) =>
    page.evaluate((id) => {
      const mark = window.__gevAnnotations.list().find((m) => m.id === id);
      return (
        mark && { color: mark.color, hidden: mark.hidden, alpha: mark.alpha }
      );
    }, id);
  // Wait for a mark to reach a state rather than for a fixed time.
  const markReaches = (id, want) =>
    page
      .waitForFunction(
        (id, want) => {
          const mark = window.__gevAnnotations.list().find((m) => m.id === id);
          return (
            mark &&
            Object.entries(want).every(([key, value]) => mark[key] === value)
          );
        },
        { timeout: 10_000 },
        id,
        want,
      )
      .then(
        () => true,
        () => false,
      );
  await page.click(rowControl(areaId, 'swatch'));
  await page.click(rowControl(areaId, 'color-green'));
  await markReaches(areaId, { color: 'green' });
  check(
    'a colour picked in the row recolours that shape',
    (await markState(areaId))?.color === 'green',
  );
  await page.click(rowControl(areaId, 'toggle'));
  await markReaches(areaId, { hidden: true, alpha: 0 });
  const hidden = await markState(areaId);
  check(
    'hiding a shape keeps it on the board but draws it at zero alpha',
    hidden?.hidden === true && hidden.alpha === 0,
    JSON.stringify(hidden),
  );
  await page.click(rowControl(areaId, 'toggle'));
  check(
    'showing it again brings it straight back',
    await markReaches(areaId, { hidden: false, alpha: 1 }),
  );
  // Fly-to frames the line by its whole path: once the flight settles, the
  // middle of the line sits near the middle of the view.
  await page.click(rowControl(ids[1], 'fly'));
  await whenSettled(page).catch(() => {});
  await whenSettled(page);
  const framed = await evaluateWithGeo(
    page,
    async (qaGeo, id) => {
      // No Cesium global in the page: borrow Cartesian3 from a live object.
      const Cartesian3 = qaGeo.cartesian3;
      const mark = window.__gevAnnotations.list().find((m) => m.id === id);
      const lons = mark.path.map((p) => p.lon);
      const lats = mark.path.map((p) => p.lat);
      const middle = Cartesian3.fromDegrees(
        (Math.min(...lons) + Math.max(...lons)) / 2,
        (Math.min(...lats) + Math.max(...lats)) / 2,
      );
      const at = window.__godsEyeView.engine.projector.worldToWindow(middle);
      const canvas = window.__godsEyeView.engine.host.canvas;
      return (
        at && {
          dx: Math.abs(at.x - canvas.clientWidth / 2) / canvas.clientWidth,
          dy: Math.abs(at.y - canvas.clientHeight / 2) / canvas.clientHeight,
        }
      );
    },
    ids[1],
  );
  check(
    'fly to frames that shape: its middle is near the middle of the view',
    Boolean(framed) && framed.dx < 0.2 && framed.dy < 0.2,
    JSON.stringify(framed),
  );

  // ── a hidden Line leaves the globe: its flowing stroke keeps its own
  // colour, so the check is the pixels, not the mark's state ─────────────
  const lineId = ids[1];
  await page.click(rowControl(lineId, 'swatch'));
  await page.click(rowControl(lineId, 'color-amber'));
  await markReaches(lineId, { color: 'amber', alpha: 1 });
  await whenSettled(page);
  const shown = await canvasShot();
  await page.click(rowControl(lineId, 'toggle'));
  await markReaches(lineId, { hidden: true, alpha: 0 });
  await whenSettled(page);
  const hiddenShot = await canvasShot();
  // Amber the shown line had and the hidden one lost; amber that appears
  // only once it is hidden is noise, and must stay small beside it.
  const gone = await amberOnlyIn(shown, hiddenShot);
  const noise = await amberOnlyIn(hiddenShot, shown);
  check(
    'a hidden Line is no longer painted',
    gone > 40 && noise < gone * 0.2,
    `${gone} amber pixels went with the line, ${noise} appeared`,
  );
  await page.click(rowControl(lineId, 'toggle'));
  await whenSettled(page);
  const back = await amberOnlyIn(await canvasShot(), hiddenShot);
  check(
    'and paints again when shown',
    back > gone * 0.5,
    `${back} of ${gone} line pixels back`,
  );
  await shot('03-pins-and-shapes');

  // ── Escape cancels the shape, a second Escape leaves draw mode ──────────
  await page.evaluate(() => window.__gevDrawTool.cancel());
  await clickWorld(500, 300);
  await clickWorld(560, 340);
  check('a new shape is in progress', (await drawState()).vertices === 2);
  await page.keyboard.press('Escape');
  await whenSettled(page);
  const afterFirstEscape = await drawState();
  check(
    'Escape cancels the shape in progress and stays in draw mode',
    afterFirstEscape.vertices === 0 && afterFirstEscape.active === true,
    `vertices ${afterFirstEscape.vertices}, active ${afterFirstEscape.active}`,
  );
  await page.keyboard.press('Escape');
  await whenSettled(page);
  const afterSecondEscape = await drawState();
  check(
    'a second Escape leaves draw mode and gives the pointer back',
    afterSecondEscape.active === false &&
      afterSecondEscape.pointerOwner === null &&
      afterSecondEscape.sceneHandler === false,
    JSON.stringify(afterSecondEscape),
  );
  check(
    'cancelling never removes a mark already on the board',
    afterSecondEscape.marks === 3,
    `${afterSecondEscape.marks} marks`,
  );
  await page.click(rowControl(ids[0], 'remove'));
  await waitForMarks(2);
  check(
    'remove in a row takes that one shape off the board and out of the list',
    (await rowIds()).join() === ids.slice(1).join(),
  );

  // ── a click that would select something selects nothing while drawing ───
  const target = await findClickableTarget();
  check(
    'a selectable layer entity is on screen to test click ownership against',
    Boolean(target),
    target
      ? `${target.layer} at ${target.x},${target.y}`
      : 'no CCTV camera or bundled site could be reached — the ownership case cannot be proved',
  );
  if (target) {
    // Layers select through their own state now, not the viewer's
    // selectedEntity: a CCTV marker makes its camera the active one, a data
    // centre selects its record in the shared context store.
    const isSelected = (spot) =>
      page.evaluate((spot) => {
        if (spot.kind === 'cctv')
          return (
            window.__godsEyeView.dataManager.layers
              .get('cctv')
              ?.module?.getUIState?.()?.activeCameraId === spot.id
          );
        return window.__gevContextStore?.selectedEntityId === spot.id;
      }, spot);
    // Clear the selection (another camera active; no context selection), as
    // the old check cleared the viewer's selectedEntity.
    const deselect = (spot) =>
      page.evaluate((spot) => {
        if (spot.kind === 'cctv') {
          const module =
            window.__godsEyeView.dataManager.layers.get('cctv')?.module;
          const other = (module?.getUIState?.()?.cameras || []).find(
            (camera) => camera.id !== spot.id,
          );
          if (other) module.selectCamera(other.id);
        } else if (window.__gevContextStore)
          window.__gevContextStore.selectedEntityId = null;
      }, spot);
    await deselect(target);
    await clickWorld(target.x, target.y, { settle: 900 });
    const selectedNormally = await isSelected(target);
    check(
      `clicking a ${target.layer} selects it when nothing owns the pointer`,
      selectedNormally,
    );
    await deselect(target);
    await page.click('#draw-toggle');
    await page.click('.pp-mode-btn[data-shape="area"]');
    await clickWorld(target.x, target.y, { settle: 900 });
    const whileDrawing = await drawState();
    const selectedWhileDrawing = await isSelected(target);
    check(
      `clicking the same ${target.layer} while drawing adds a vertex and selects nothing`,
      whileDrawing.vertices === 1 && selectedWhileDrawing === false,
      `vertices ${whileDrawing.vertices}, selected ${selectedWhileDrawing}`,
    );
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    await whenSettled(page);
  }

  // ── what a reload actually does ─────────────────────────────────────────
  const beforeReload = await page.evaluate(() =>
    window.__gevAnnotations.count(),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__gevAnnotations, {
    timeout: 90_000,
  });
  await whenSettled(page);
  const afterReload = await page.evaluate(() =>
    window.__gevAnnotations.count(),
  );
  check(
    'a reload starts an empty board — marks live for the session, not across reloads',
    beforeReload > 0 && afterReload === 0,
    `${beforeReload} before, ${afterReload} after`,
  );

  // ── Clear wipes the board ───────────────────────────────────────────────
  await page.evaluate(() => {
    const panel = document.getElementById('utilities-panel');
    if (panel?.classList.contains('collapsed'))
      document
        .querySelector(
          '.panel-collapse-btn[data-collapse-target="utilities-panel"]',
        )
        ?.click();
  });
  await page.waitForFunction(
    () =>
      document.getElementById('draw-toggle')?.getBoundingClientRect().width > 0,
    { timeout: 10_000 },
  );
  // The reload built a new page context: re-capture the viewer's own click
  // actions so the identity comparisons below still mean something.
  await page.evaluate(() => {
    const Cesium = window.__CESIUM__;
    const stock = window.__godsEyeView.viewer.screenSpaceEventHandler;
    window.__qaStock = {
      click:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) || null,
      double:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ||
        null,
    };
  });
  // The reload restores the view in the address (the clicked CCTV camera's
  // flight left a low, near-horizontal view there) with a boot flight that can
  // land after a setView: set the view until it holds.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await evaluateWithGeo(
      page,
      async (qaGeo, view) => {
        window.__godsEyeView.engine.camera.cancelFlight?.();
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: (view.lon * Math.PI) / 180,
            latitude: (view.lat * Math.PI) / 180,
            height: view.height,
          }),
          orientation: {
            heading: 0,
            pitch: (view.pitch * Math.PI) / 180,
            roll: 0,
          },
        });
      },
      VIEW,
    );
    await whenSettled(page);
    const held = await page.evaluate((view) => {
      const carto = window.__godsEyeView.engine.camera.pose().cartographic;
      return (
        Math.abs((carto.latitude * 180) / Math.PI - view.lat) < 0.01 &&
        Math.abs((carto.longitude * 180) / Math.PI - view.lon) < 0.01 &&
        Math.abs(carto.height - view.height) < view.height * 0.2
      );
    }, VIEW);
    if (held) break;
  }
  await page.click('#draw-toggle');
  await page.click('.pp-mode-btn[data-shape="area"]');
  await clickWorld(420, 280);
  await clickWorld(700, 300);
  await clickWorld(660, 520);
  await pressFinish();
  const drewAgain = await waitForMarks(1);
  check('a shape can be drawn again after a reload', drewAgain);

  // Enter belongs to whatever the keyboard is on. With Clear focused it must
  // PRESS CLEAR — the shape in progress goes, and so does the mark already on
  // the board — and it must NOT quietly finish a second shape.
  await clickWorld(430, 300);
  await clickWorld(690, 320);
  await clickWorld(670, 500);
  const beforeButtonEnter = await drawState();
  await page.focus('#draw-clear');
  await page.keyboard.press('Enter');
  await whenSettled(page);
  const afterButtonEnter = await drawState();
  check(
    'Enter on a keyboard-focused button activates the button, it does not finish the shape',
    beforeButtonEnter.vertices === 3 &&
      beforeButtonEnter.marks === 1 &&
      afterButtonEnter.marks === 0 &&
      afterButtonEnter.vertices === 0,
    `before ${beforeButtonEnter.vertices} vertices / ${beforeButtonEnter.marks} marks, ` +
      `after ${afterButtonEnter.vertices} / ${afterButtonEnter.marks} ` +
      '(a finish would have made it 2 marks)',
  );

  // Put one back so the Clear BUTTON check below has something to remove.
  await clickWorld(420, 280);
  await clickWorld(700, 300);
  await clickWorld(660, 520);
  await pressFinish();
  check(
    'a shape can be drawn after the board was cleared from the keyboard',
    await waitForMarks(1),
  );
  await page.click('#draw-clear');
  await whenSettled(page);
  const cleared = await drawState();
  check(
    'Clear removes every mark from the board',
    cleared.marks === 0,
    `${cleared.marks} marks left`,
  );
  await shot('04-after-clear');

  // ── a shape that describes nothing is refused, not placed ───────────────
  const degenerateVertices = await page.evaluate(() => {
    const tool = window.__gevDrawTool;
    tool.cancel();
    // Three points on one line, placed through the same addVertex the clicks use.
    tool.addVertex(-122.42, 37.77);
    tool.addVertex(-122.42, 37.771);
    tool.addVertex(-122.42, 37.772);
    return tool.session?.vertices?.length ?? null;
  });
  check(
    'three collinear vertices are accepted into the session',
    degenerateVertices === 3,
    `${degenerateVertices} vertices`,
  );
  await pressFinish();
  await whenSettled(page);
  const degenerate = await drawState();
  check(
    'three points in a line are refused with a reason, not placed',
    degenerate.marks === 0 && /in a line/.test(degenerate.hint),
    `${degenerate.marks} marks, hint "${degenerate.hint}"`,
  );

  // ── a shape drawn across the antimeridian lands where it was drawn ──────
  await evaluateWithGeo(page, async (qaGeo) => {
    window.__godsEyeView.engine.camera.cancelFlight?.();
    window.__godsEyeView.engine.camera.setView({
      destination: qaGeo.cartographic.toCartesian({
        longitude: (179.9995 * Math.PI) / 180,
        latitude: 0,
        height: 3000,
      }),
      orientation: { heading: 0, pitch: (-88 * Math.PI) / 180, roll: 0 },
    });
    window.__godsEyeView.engine.render.request();
  });
  await whenSettled(page);
  await page.evaluate(() => {
    const tool = window.__gevDrawTool;
    tool.cancel();
    tool.setShape('area');
    // A ~200 m square straddling 180.
    tool.addVertex(179.999, -0.001);
    tool.addVertex(-179.999, -0.001);
    tool.addVertex(-179.999, 0.001);
    tool.addVertex(179.999, 0.001);
  });
  await pressFinish();
  const datelineLanded = await waitForMarks(1);
  const datelineAnchor = await page.evaluate(() => {
    const mark = window.__gevAnnotations.list()[0];
    return mark ? { lon: mark.anchor?.lon, lat: mark.anchor?.lat } : null;
  });
  check(
    'a shape drawn across the antimeridian anchors there, not on the Greenwich meridian',
    datelineLanded &&
      datelineAnchor &&
      Math.abs(Math.abs(datelineAnchor.lon) - 180) < 0.1 &&
      Math.abs(datelineAnchor.lat) < 0.1,
    JSON.stringify(datelineAnchor),
  );
  await page.evaluate(() => window.__gevAnnotations.clear());

  await page.click('#draw-toggle');
  await whenSettled(page);
  const finalState = await drawState();
  check(
    'leaving draw mode gives back the pointer, the handler and the double-click',
    finalState.active === false &&
      finalState.pointerOwner === null &&
      finalState.sceneHandler === false &&
      finalState.previewDataSources === 0,
    JSON.stringify(finalState),
  );
  // ── destroy(): the shell disposing the tool leaves nothing behind ───────
  const beforeDestroy = await page.evaluate(
    () => window.__godsEyeView.viewer.dataSources.length,
  );
  await page.click('#draw-toggle'); // destroy from an ACTIVE session: the harder case
  await whenSettled(page);
  const destroyed = await page.evaluate(async () => {
    const tool = window.__gevDrawTool;
    const wasActive = tool.active;
    await tool.destroy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const Cesium = window.__CESIUM__;
    const viewer = window.__godsEyeView.viewer;
    const stock = viewer.screenSpaceEventHandler;
    let previews = 0;
    for (let i = 0; i < viewer.dataSources.length; i += 1)
      if (viewer.dataSources.get(i)?.name === 'gev-draw-preview') previews += 1;
    return {
      wasActive,
      diagnostics: tool.diagnostics(),
      previews,
      dataSources: viewer.dataSources.length,
      handleGone: window.__gevDrawTool === undefined,
      clickRestored:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_CLICK) ===
        window.__qaStock.click,
      doubleRestored:
        stock.getInputAction(Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK) ===
        window.__qaStock.double,
      drawingClass: document.body.classList.contains('gev-drawing'),
    };
  });
  check(
    'destroy() from an active session releases the pointer, handler and listeners',
    destroyed.wasActive === true &&
      destroyed.diagnostics.destroyed === true &&
      destroyed.diagnostics.pointerOwner === null &&
      destroyed.diagnostics.sceneHandler === false &&
      destroyed.diagnostics.domListeners === 0 &&
      destroyed.drawingClass === false,
    JSON.stringify(destroyed.diagnostics),
  );
  check(
    'destroy() leaves no preview data source and gives the window handle back',
    destroyed.previews === 0 &&
      destroyed.dataSources === beforeDestroy &&
      destroyed.handleGone,
    `previews ${destroyed.previews}, dataSources ${beforeDestroy} → ${destroyed.dataSources}, handle gone ${destroyed.handleGone}`,
  );
  check(
    "destroy() returns Cesium's own click actions",
    destroyed.clickRestored && destroyed.doubleRestored,
    `click ${destroyed.clickRestored}, double ${destroyed.doubleRestored}`,
  );

  check(
    'no uncaught page errors across the run',
    errors.length === 0,
    errors.join(' | '),
  );
} finally {
  await closeBrowser(browser);
}
console.log(`RESULT: ${failures} failures`);
process.exitCode = failures ? 1 : 0;

/**
 * Find something on screen that a layer would select on click, so the ownership
 * guard can be proved against a real selection rather than a stub. Bundled
 * infrastructure first (no network, works keyless); CCTV cameras if they are up.
 */
async function findClickableTarget() {
  // CCTV first: it is the layer the brief names, and it goes through the shared
  // tracking click gesture that flights and military use too.
  const camera = await page
    .evaluate(async () => {
      const manager = window.__godsEyeView.dataManager;
      await manager.setEnabled('cctv', true, { origin: 'user' });
      const module = manager.layers.get('cctv')?.module;
      if (!module?.getUIState) return null;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        const cameras = module.getUIState()?.cameras || [];
        const found = cameras.find((entry) => {
          const lat = entry.lat ?? entry.latitude;
          const lon = entry.lon ?? entry.longitude;
          return Number.isFinite(lat) && Number.isFinite(lon);
        });
        if (found)
          return {
            id: found.id,
            lat: found.lat ?? found.latitude,
            lon: found.lon ?? found.longitude,
          };
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    })
    .catch(() => null);

  if (camera) {
    await evaluateWithGeo(
      page,
      async (qaGeo, spot) => {
        window.__godsEyeView.engine.camera.cancelFlight?.();
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: (spot.lon * Math.PI) / 180,
            latitude: (spot.lat * Math.PI) / 180,
            height: 600,
          }),
          orientation: { heading: 0, pitch: (-80 * Math.PI) / 180, roll: 0 },
        });
        window.__godsEyeView.engine.render.request();
      },
      camera,
    );
    await whenSettled(page);
    const spot = await onScreen(['cctv']);
    if (spot) return { ...spot, kind: 'cctv', layer: 'CCTV camera' };
  }

  // Bundled infrastructure as the keyless fallback: a different guarded handler,
  // the same shared claim, and always present without a key. The layer
  // registers each site in the shared context store with its coordinates.
  const site = await page
    .evaluate(async () => {
      await window.__godsEyeView.dataManager.setEnabled(
        'local-datacenters',
        true,
        {
          origin: 'user',
        },
      );
      for (let attempt = 0; attempt < 40; attempt += 1) {
        for (const record of window.__gevContextStore?.entities.values() ??
          []) {
          if (record.layerId !== 'local-datacenters') continue;
          if (
            Number.isFinite(record.latitude) &&
            Number.isFinite(record.longitude)
          )
            return { lon: record.longitude, lat: record.latitude };
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      return null;
    })
    .catch(() => null);
  if (!site) return null;
  await evaluateWithGeo(
    page,
    async (qaGeo, spot) => {
      window.__godsEyeView.engine.camera.cancelFlight?.();
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: (spot.lon * Math.PI) / 180,
          latitude: (spot.lat * Math.PI) / 180,
          height: 2500,
        }),
        orientation: { heading: 0, pitch: (-88 * Math.PI) / 180, roll: 0 },
      });
      window.__godsEyeView.engine.render.request();
    },
    site,
  );
  await whenSettled(page);
  const spot = await onScreen([
    'local-datacenters-tips',
    'local-datacenters-pins',
  ]);
  return spot ? { ...spot, kind: 'context', layer: 'data centre' } : null;
}

/**
 * Canvas coordinates of a spot clear of the side panels where the engine's
 * pick returns an instance of one of the mover sets `owners` (layers draw
 * through engine.movers; a pick reports the set as `owner` and the instance's
 * pickId as `id`). Picking, not projecting, proves the spot is clickable: an
 * instance beyond the horizon or behind a building does not count.
 */
async function onScreen(owners, timeout = 20_000) {
  return page
    .waitForFunction(
      (wanted) => {
        const { engine } = window.__godsEyeView;
        const sets = engine.movers
          .list()
          .filter((set) => wanted.includes(set.id) && set.count > 0);
        if (!sets.length) return false;
        for (let y = 190; y < 600; y += 20) {
          for (let x = 310; x < 900; x += 20) {
            const hit = engine.picker.pick({ x, y });
            if (hit && wanted.includes(hit.owner) && hit.id != null)
              return { x, y, id: String(hit.id) };
          }
        }
        return false;
      },
      { timeout, polling: 1000 },
      owners,
    )
    .then(
      (handle) => handle.jsonValue(),
      () => null,
    );
}
