#!/usr/bin/env node
/**
 * Browser proof of the Directions layer: real chip clicks, real globe clicks,
 * a real route from the real proxy, a real camera flight.
 *
 * Usage: node scripts/qa-directions.mjs [--url http://localhost:4173]
 *        [--shots qa-shots/directions] [--label keyed] [--skip denver]
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const BASE = arg('url', 'http://localhost:4173');
const SHOTS = arg('shots', path.join(ROOT, 'qa-shots', 'directions'));
const LABEL = arg('label', 'keyed');
const SKIP = new Set((arg('skip', '') || '').split(',').filter(Boolean));

await fs.mkdir(SHOTS, { recursive: true });

let failures = 0;
const lines = [];
const check = (name, passed, detail = '') => {
  const text = `[${passed ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`;
  console.log(text);
  lines.push(text);
  if (!passed) failures += 1;
};

const browser = await puppeteer.launch({
  headless: false,
  executablePath:
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  args: [
    '--no-sandbox',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1280,860',
  ],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860 });
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(error.message));
const consoleErrors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') consoleErrors.push(msg.text());
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shot = async (name) => {
  const file = path.join(SHOTS, name);
  await page.screenshot({ path: file, type: 'jpeg', quality: 82 });
  console.log(`  shot: ${file}`);
};

/** Put the camera over a place, instantly, and let the scene settle. */
async function lookAt(lat, lon, height) {
  await page.evaluate(
    (la, lo, h) => {
      const viewer = window.__godsEyeView.viewer;
      const Cartesian3 = viewer.camera.positionWC.constructor;
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: Cartesian3.fromDegrees(lo, la, h),
        orientation: { heading: 0, pitch: -Math.PI / 2.2, roll: 0 },
      });
    },
    lat,
    lon,
    height,
  );
}

/** Canvas position of a lon/lat on the rendered surface, or null. */
const screenAt = (lat, lon) =>
  page.evaluate(
    (la, lo) => {
      const viewer = window.__godsEyeView.viewer;
      const scene = viewer.scene;
      const Cartesian3 = viewer.camera.positionWC.constructor;
      const Cartographic = viewer.camera.positionCartographic.constructor;
      const carto = Cartographic.fromDegrees(lo, la);
      let ground = scene.globe?.getHeight?.(carto);
      if (!Number.isFinite(ground)) ground = 0;
      const world = Cartesian3.fromDegrees(lo, la, ground);
      const win = scene.cartesianToCanvasCoordinates(world);
      if (!win || !Number.isFinite(win.x)) return null;
      const x = Math.round(win.x);
      const y = Math.round(win.y);
      if (x < 40 || y < 40 || x > 1240 || y > 820) return null;
      return { x, y };
    },
    lat,
    lon,
  );

const layerState = () =>
  page.evaluate(() => {
    const gev = window.__godsEyeView;
    const manager = gev.dataManager;
    const module = manager.layers.get('directions').module;
    const row = document.querySelector(
      '#data-toggles [data-layer-id="directions"]',
    );
    const controls = module.getRowControls();
    const viewer = gev.viewer;
    const entities = [...viewer.entities.values];
    const routeEntities = entities.filter(
      (entity) => String(entity.id) === 'directions:route',
    );
    const listNodes = row
      ? [...row.querySelectorAll('.data-row-list-item')]
      : [];
    return {
      stats: module.getStats(),
      chips: controls.chips.map((chip) => ({
        id: chip.id,
        label: chip.label,
        active: !!chip.active,
        disabled: !!chip.disabled,
      })),
      listCount: controls.list?.items?.length || 0,
      listText: (controls.list?.items || []).map((item) => item.text),
      domList: listNodes.map((node) => node.textContent),
      domAllButtons: listNodes.every((node) => node.tagName === 'BUTTON'),
      domInOl:
        listNodes.length > 0 &&
        listNodes[0].closest('ol')?.classList.contains('data-row-list'),
      domCurrent: listNodes.findIndex((node) =>
        node.classList.contains('current'),
      ),
      routeEntities: routeEntities.length,
      routePositions:
        routeEntities[0]?.polyline?.positions?.getValue?.(
          viewer.clock.currentTime,
        )?.length || 0,
      markerCount: entities.filter((entity) =>
        String(entity.id).startsWith('directions:marker:'),
      ).length,
      pointerOwner: window.__gevQa.pointerOwner(),
      cameraMotion: window.__gevQa.getActiveCameraMotion(),
    };
  });

const clickChip = async (chipId) => {
  const clicked = await page.evaluate((id) => {
    const row = document.querySelector(
      '#data-toggles [data-layer-id="directions"]',
    );
    const button = row?.querySelector(`button[data-chip-id="${id}"]`);
    if (!button || button.disabled) return false;
    button.click();
    return true;
  }, chipId);
  await sleep(150);
  return clicked;
};

const setMode = async (mode) => {
  await clickChip(`mode-${mode}`);
};

const waitForRoute = () =>
  page.waitForFunction(
    () =>
      window.__godsEyeView.dataManager.layers
        .get('directions')
        .module.getStats().count > 0,
    { timeout: 40000 },
  );

const waitForMode = (word) =>
  page.waitForFunction(
    (w) =>
      window.__godsEyeView.dataManager.layers
        .get('directions')
        .module.getStats()
        .coverage?.endsWith(w),
    { timeout: 40000 },
    word,
  );

const cameraPose = () =>
  page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionWC;
    return { x: c.x, y: c.y, z: c.z };
  });
const poseDelta = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

/** Place A and B by clicking the globe. Returns whether both landed. */
async function placeEndpoints(a, b) {
  await clickChip('set-a');
  const atA = await screenAt(a.lat, a.lon);
  if (!atA) return false;
  await page.mouse.click(atA.x, atA.y);
  await sleep(700);
  await clickChip('set-b');
  const atB = await screenAt(b.lat, b.lon);
  if (!atB) return false;
  await page.mouse.click(atB.x, atB.y);
  return true;
}

try {
  await page.goto(`${BASE}/?welcome=0`, {
    waitUntil: 'domcontentloaded',
    timeout: 90000,
  });
  await page.waitForFunction(() => window.__godsEyeView?.dataManager, {
    timeout: 90000,
  });
  // Two module reads the assertions need. Both are the app's OWN module
  // instances (Vite serves one copy), so this observes rather than simulates.
  await page.evaluate(async () => {
    const [own, verbs] = await Promise.all([
      import('/src/data/inputOwnership.js'),
      import('/src/cameraVerbs.js'),
    ]);
    window.__gevQa = {
      pointerOwner: own.pointerOwner,
      claimPointer: own.claimPointer,
      releasePointer: own.releasePointer,
      getActiveCameraMotion: verbs.getActiveCameraMotion,
    };
  });
  await sleep(3000);

  // ── 1. Open the DATA LAYERS panel, then toggle the row on. ──────────────
  const opened = await page.evaluate(() => {
    const panel = document.getElementById('data-panel');
    if (!panel) return false;
    if (panel.classList.contains('collapsed')) {
      panel
        .querySelector('.panel-collapse-btn[data-collapse-target="data-panel"]')
        ?.click();
    }
    return !document
      .getElementById('data-panel')
      .classList.contains('collapsed');
  });
  await sleep(700);
  check('the DATA LAYERS panel opens from its own header control', opened);
  const toggled = await page.evaluate(() => {
    const row = document.querySelector(
      '#data-toggles [data-layer-id="directions"]',
    );
    const button = row?.querySelector('.data-toggle-btn');
    if (!button) return false;
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  });
  await sleep(1200);
  check(
    'the Directions row is in the Data Layers panel and toggles on',
    toggled,
  );
  let state = await layerState();
  check(
    'the row guides the operator before anything is placed',
    /SET A/.test(state.stats.coverage || ''),
    state.stats.coverage,
  );

  // ── 1b. The routing service's attribution is on screen, with the link its
  //        usage policy asks for. ────────────────────────────────────────────
  const credit = await page.evaluate(async () => {
    const anchor = [...document.querySelectorAll('a')].find((a) =>
      /data attribution/i.test(a.textContent),
    );
    anchor?.click();
    await new Promise((resolve) => setTimeout(resolve, 900));
    const text = document.body.innerText;
    const html = document.body.innerHTML;
    const open = /Data provided by/i.test(text);
    const entry = [...document.querySelectorAll('li')].find((node) =>
      /OSRM on the FOSSGIS servers/i.test(node.textContent),
    );
    entry?.scrollIntoView({ block: 'center' });
    return {
      open,
      routing: /OSRM on the FOSSGIS servers/i.test(text),
      osm: /OpenStreetMap contributors/i.test(text),
      fixTheMap: /openstreetmap\.org\/fixthemap/.test(html),
    };
  });
  check('the Data attribution popover opens', credit.open);
  check('it credits the routing service', credit.routing);
  check('it credits OpenStreetMap contributors', credit.osm);
  check(
    'it carries the "fix the map" link the usage policy asks for',
    credit.fixTheMap,
  );
  await shot(`04-${LABEL}-attribution.jpg`);
  await page.evaluate(() => {
    const close = [...document.querySelectorAll('a, button')].find(
      (node) => node.className && /close/i.test(String(node.className)),
    );
    close?.click();
  });
  await sleep(500);

  // ── 2. Place A on the Ferry Building, B in Golden Gate Park. ─────────────
  const FERRY = { lat: 37.7955, lon: -122.3937 };
  const GGPARK = { lat: 37.7694, lon: -122.4862 };
  await lookAt(37.782, -122.44, 16000);
  await sleep(5000);

  await clickChip('set-a');
  state = await layerState();
  check(
    'arming SET A claims the shared pointer',
    state.pointerOwner === 'directions',
    `owner=${state.pointerOwner}`,
  );
  check(
    'the armed chip tells the operator to click the map',
    state.chips.find((chip) => chip.id === 'set-a')?.label === 'CLICK MAP',
  );

  let at = await screenAt(FERRY.lat, FERRY.lon);
  check('the Ferry Building is on screen', !!at, JSON.stringify(at));
  await page.mouse.click(at.x, at.y);
  await sleep(800);
  state = await layerState();
  check(
    'placing A releases the pointer claim',
    state.pointerOwner === null,
    `owner=${state.pointerOwner}`,
  );
  check('A is marked on the globe', state.markerCount === 1);

  // A handler bound to the canvas AFTER this layer's own sees the same click.
  // That is every ambient selection handler in the app, and it is the one that
  // used to place B and deselect whatever was under it in the same gesture.
  await page.evaluate(() => {
    window.__gevQaLateHandler = [];
    const canvas = window.__godsEyeView.viewer.scene.canvas;
    canvas.addEventListener('pointerup', () => {
      window.__gevQaLateHandler.push(window.__gevQa.pointerOwner());
    });
  });

  await clickChip('set-b');
  at = await screenAt(GGPARK.lat, GGPARK.lon);
  check('Golden Gate Park is on screen', !!at, JSON.stringify(at));
  await page.mouse.click(at.x, at.y);
  const lateOwners = await page.evaluate(() => window.__gevQaLateHandler);
  check(
    'a handler later in the same click still sees the pointer as taken',
    lateOwners.length > 0 &&
      lateOwners.every((owner) => owner === 'directions'),
    `saw ${JSON.stringify(lateOwners)}`,
  );
  await waitForRoute();
  await sleep(2000);
  state = await layerState();
  check(
    'once that click is over, the pointer claim is returned',
    state.pointerOwner === null,
    `owner=${state.pointerOwner}`,
  );
  check('a route polyline is drawn', state.routeEntities === 1);
  check(
    'the route follows streets rather than a straight line',
    state.routePositions >= 50,
    `${state.routePositions} vertices`,
  );
  check(
    'the turn-by-turn list has at least 10 steps',
    state.listCount >= 10,
    `${state.listCount} steps`,
  );
  check(
    'the list renders in the panel as an ordered list of focusable buttons',
    state.domList.length === state.listCount &&
      state.domAllButtons &&
      state.domInOl,
    `${state.domList.length} rendered, ol=${state.domInOl}, buttons=${state.domAllButtons}`,
  );
  check(
    'the rendered list is in route order',
    state.domList.every((text, index) => text.includes(state.listText[index])),
  );
  const driveSummary = state.stats.coverage;
  check(
    'the row summarises distance, time and mode',
    /·.*·\s*Drive$/.test(driveSummary || ''),
    driveSummary,
  );
  const focused = await page.evaluate(() => {
    const row = document.querySelector(
      '#data-toggles [data-layer-id="directions"]',
    );
    const items = row.querySelectorAll('.data-row-list-item');
    items[2]?.focus();
    const active = document.activeElement === items[2];
    items[2]?.click();
    return { active, tabIndex: items[2]?.tabIndex };
  });
  await sleep(600);
  const afterListClick = await layerState();
  check(
    'a list row takes keyboard focus and selects its maneuver',
    focused.active && afterListClick.stats.count > 0,
    `focused=${focused.active}`,
  );
  await shot(`01-${LABEL}-sf-route-and-list.jpg`);

  // ── 3. Switch profile; the route changes. ────────────────────────────────
  await setMode('foot');
  await waitForMode('Walk');
  const walk = await layerState();
  check(
    'WALK reroutes and the summary follows',
    walk.stats.coverage !== driveSummary,
    walk.stats.coverage,
  );
  check(
    'the walking route is its own route',
    walk.listCount !== state.listCount || walk.stats.coverage !== driveSummary,
    `drive ${state.listCount} steps vs walk ${walk.listCount}`,
  );
  await setMode('bike');
  await waitForMode('Bike');
  const bike = await layerState();
  check(
    'BIKE reroutes as well',
    /Bike$/.test(bike.stats.coverage),
    bike.stats.coverage,
  );
  await setMode('car');
  await waitForMode('Drive');

  // ── 4. Swap endpoints. ──────────────────────────────────────────────────
  const beforeSwap = await layerState();
  await clickChip('swap');
  await sleep(3500);
  const afterSwap = await layerState();
  check(
    'SWAP reverses the route',
    afterSwap.routeEntities === 1 &&
      afterSwap.listText[0] !== beforeSwap.listText[0],
    `"${beforeSwap.listText[0]}" -> "${afterSwap.listText[0]}"`,
  );
  await clickChip('swap');
  await sleep(3500);

  // ── 5. Three rapid reroutes leave exactly one route. ─────────────────────
  await page.evaluate(() => {
    const manager = window.__godsEyeView.dataManager;
    manager.setLayerParams('directions', { mode: 'foot' }, { origin: 'user' });
    manager.setLayerParams('directions', { mode: 'bike' }, { origin: 'user' });
    manager.setLayerParams('directions', { mode: 'car' }, { origin: 'user' });
  });
  await sleep(6000);
  const rapid = await layerState();
  check(
    'three rapid reroutes leave exactly one route',
    rapid.routeEntities === 1,
    `${rapid.routeEntities} route entities`,
  );
  check(
    'the surviving route is the last one asked for',
    /Drive$/.test(rapid.stats.coverage || ''),
    rapid.stats.coverage,
  );

  // ── 6. What the row says for each shape the proxy can answer with.
  //
  // These stub the proxy's RESPONSE, so they test this layer's handling of it
  // and nothing about the proxy itself. What the proxy actually answers for a
  // routing-service rate limit, a redirect, an over-long route and a full
  // outbound queue is covered where it can be observed — the provider tests in
  // src/tooling/placeProviders.test.mjs. The bodies below are the ones those
  // tests pin, so the two halves meet. ─────────────────────────────────────
  const cdp = await page.target().createCDPSession();
  let stub = null;
  cdp.on('Fetch.requestPaused', async ({ requestId }) => {
    if (!stub) {
      await cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
      return;
    }
    if (stub.hold) return; // never answer: the client's own timeout must fire
    await cdp
      .send('Fetch.fulfillRequest', {
        requestId,
        responseCode: stub.status,
        responseHeaders: [
          { name: 'Content-Type', value: 'application/json' },
          ...(stub.status === 429 ? [{ name: 'Retry-After', value: '5' }] : []),
        ],
        body: Buffer.from(stub.body).toString('base64'),
      })
      .catch(() => {});
  });
  await cdp.send('Fetch.enable', {
    patterns: [{ urlPattern: '*/api/route*', requestStage: 'Request' }],
  });

  const reroute = async () => {
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setLayerParams(
        'directions',
        { mode: 'foot' },
        { origin: 'user' },
      ),
    );
  };
  const failCases = [
    {
      name: 'no route found',
      stub: { status: 200, body: '{"ok":false,"error":"no route found"}' },
      wait: 3500,
      expect: /No route found between A and B/,
    },
    {
      // The exact body the proxy sends when the routing service rate-limits
      // US (pinned by the provider test of the same name).
      name: 'the routing service rate-limited us (429)',
      stub: {
        status: 429,
        body: '{"ok":false,"error":"routing service is rate limited"}',
      },
      wait: 3500,
      expect: /routing service is rate limited/i,
    },
    {
      // And when our own outbound queue is full.
      name: 'our own outbound queue is full (429)',
      stub: {
        status: 429,
        body: '{"ok":false,"error":"routing busy — too many routes at once"}',
      },
      wait: 3500,
      expect: /routing busy/i,
    },
    {
      name: 'upstream never answers (timeout)',
      stub: { hold: true },
      wait: 19000,
      expect: /Routing timed out/,
    },
  ];
  for (const failCase of failCases) {
    stub = failCase.stub;
    await reroute();
    await sleep(failCase.wait);
    const failed = await layerState();
    check(
      `the row reports "${failCase.name}" honestly`,
      failCase.expect.test(failed.stats.error || ''),
      failed.stats.error,
    );
    check(
      `"${failCase.name}" leaves no straight line drawn as a route`,
      failed.routeEntities === 0,
    );
    // Back to a real route before the next case.
    stub = null;
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setLayerParams(
        'directions',
        { mode: 'car' },
        { origin: 'user' },
      ),
    );
    await waitForRoute();
    await sleep(1200);
  }
  await cdp.send('Fetch.disable').catch(() => {});

  // ── 7. FLY, a mid-flight frame, and a cancel that actually stops it. ─────
  const beforeFly = await cameraPose();
  check('the FLY chip is offered once a route exists', await clickChip('fly'));
  await sleep(3000);
  const flying = await layerState();
  const midFly = await cameraPose();
  check(
    'FLY starts a route flight',
    flying.cameraMotion?.kind === 'route',
    JSON.stringify(flying.cameraMotion),
  );
  check(
    'the camera actually moved',
    poseDelta(beforeFly, midFly) > 50,
    `${Math.round(poseDelta(beforeFly, midFly))} m`,
  );
  check(
    'the list highlights the step being flown',
    flying.domCurrent >= 0,
    `dom index ${flying.domCurrent}`,
  );
  await shot(`02-${LABEL}-mid-flight.jpg`);

  // A reroute replaces the route the dolly is flying; the dolly has to land
  // first rather than keep flying a route that no longer exists.
  await setMode('foot');
  await sleep(1200);
  const afterReroute = await layerState();
  check(
    'changing profile mid-flight lands the flight it replaced',
    afterReroute.cameraMotion === null,
    JSON.stringify(afterReroute.cameraMotion),
  );
  await waitForMode('Walk');
  await setMode('car');
  await waitForMode('Drive');
  await sleep(800);
  check('FLY is offered again after the reroute', await clickChip('fly'));
  await sleep(2000);

  await clickChip('clear');
  await sleep(500);
  const stopped = await cameraPose();
  await sleep(3000);
  const later = await cameraPose();
  const afterClear = await layerState();
  check(
    'CLEAR mid-flight stops the flight it started',
    afterClear.cameraMotion === null,
    JSON.stringify(afterClear.cameraMotion),
  );
  check(
    'no later frame moves the camera again',
    poseDelta(stopped, later) < 5,
    `${poseDelta(stopped, later).toFixed(2)} m drift`,
  );
  check(
    'CLEAR removes the route and both markers',
    afterClear.routeEntities === 0 && afterClear.markerCount === 0,
  );
  check(
    'CLEAR leaves the pointer free',
    afterClear.pointerOwner === null,
    `owner=${afterClear.pointerOwner}`,
  );

  // ── 8. A tool holding the pointer blocks placement, and says so. ─────────
  await page.evaluate(() => {
    // A claim answers with a lease; the release takes that lease back.
    window.__gevQaDrawLease = window.__gevQa.claimPointer('draw');
  });
  await clickChip('set-a');
  const blocked = await layerState();
  check(
    "another tool's pointer claim is never stolen",
    blocked.pointerOwner === 'draw',
    `owner=${blocked.pointerOwner}`,
  );
  check(
    'nothing is armed, and the row says why the click would do nothing',
    blocked.chips.find((chip) => chip.id === 'set-a')?.active === false &&
      /Another map tool/.test(blocked.stats.error || ''),
    blocked.stats.error,
  );
  // The row is not where the operator is looking after pressing a chip, so the
  // refusal also has to reach the app's toast (owner field test).
  const toast = await page.evaluate(() => {
    const node = document.getElementById('toast');
    return {
      text: node?.textContent || '',
      visible: !!node?.classList.contains('visible'),
    };
  });
  check(
    'the refusal reaches the app toast, naming the tool and how to leave it',
    /Draw is active/.test(toast.text) && /then set A/.test(toast.text),
    JSON.stringify(toast.text),
  );
  check('and that toast is actually on screen', toast.visible);
  await shot(`05-${LABEL}-pointer-blocked-toast.jpg`);
  const released = await page.evaluate(() =>
    window.__gevQa.releasePointer(window.__gevQaDrawLease),
  );
  check('and it gets the pointer back when it lets go', released);

  // ── 9. Denver: maneuver dots sit on the ground, not at sea level. ────────
  if (!SKIP.has('denver')) {
    await lookAt(39.744, -104.999, 7000);
    await sleep(6000);
    const placed = await placeEndpoints(
      { lat: 39.7392, lon: -104.9903 },
      { lat: 39.7487, lon: -105.0077 },
    );
    check('both Denver endpoints are on screen', placed);
    if (placed) {
      await waitForRoute();
      // Let the shared ground-floor cells warm and the dots re-anchor.
      await sleep(9000);
      const denver = await page.evaluate(() => {
        const viewer = window.__godsEyeView.viewer;
        const Cartographic = viewer.camera.positionCartographic.constructor;
        const scene = viewer.scene;
        let collection = null;
        for (let i = 0; i < scene.primitives.length; i += 1) {
          const primitive = scene.primitives.get(i);
          if (
            primitive &&
            typeof primitive.get === 'function' &&
            primitive.length > 0 &&
            String(primitive.get(0)?.id || '').startsWith('directions:step:')
          ) {
            collection = primitive;
            break;
          }
        }
        if (!collection) return { dots: 0, shown: 0, heights: [] };
        const heights = [];
        for (let i = 0; i < collection.length; i += 1) {
          const point = collection.get(i);
          if (!point.show) continue;
          heights.push(Cartographic.fromCartesian(point.position).height);
        }
        return { dots: collection.length, shown: heights.length, heights };
      });
      check('Denver has maneuver dots', denver.dots > 0, `${denver.dots} dots`);
      check(
        'every Denver dot resolved its ground cell — none left hidden',
        denver.dots > 0 && denver.shown === denver.dots,
        `${denver.shown} of ${denver.dots} shown`,
      );
      // Denver's ground is ~1.58-1.65 km ellipsoidal (~1.6 km orthometric plus
      // the local geoid separation). A dot left at a few metres would fail this
      // by a kilometre and a half.
      check(
        'every Denver dot is anchored on the ground, not at sea level',
        denver.dots > 0 &&
          denver.heights.length === denver.dots &&
          denver.heights.every((h) => h > 1400 && h < 1900),
        `heights ${denver.heights.map((h) => Math.round(h)).join(', ')}`,
      );
      await shot(`03-${LABEL}-denver-markers.jpg`);
    }
  }

  // ── 10. Disable: nothing is left behind. ────────────────────────────────
  const { beforeDisable, directionsBeforeDisable } = await page.evaluate(() => {
    const entities = [...window.__godsEyeView.viewer.entities.values];
    return {
      beforeDisable: entities.length,
      directionsBeforeDisable: entities.filter((entity) =>
        String(entity.id).startsWith('directions:'),
      ).length,
    };
  });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('directions', false, {
      origin: 'user',
    }),
  );
  await sleep(1500);
  const off = await page.evaluate(() => {
    const gev = window.__godsEyeView;
    const viewer = gev.viewer;
    const left = [...viewer.entities.values].filter((entity) =>
      String(entity.id).startsWith('directions:'),
    );
    let shownDots = 0;
    for (let i = 0; i < viewer.scene.primitives.length; i += 1) {
      const primitive = viewer.scene.primitives.get(i);
      if (
        primitive &&
        typeof primitive.get === 'function' &&
        primitive.length > 0 &&
        String(primitive.get(0)?.id || '').startsWith('directions:step:')
      ) {
        shownDots = primitive.show ? primitive.length : 0;
      }
    }
    const row = document.querySelector(
      '#data-toggles [data-layer-id="directions"]',
    );
    return {
      entities: left.length,
      shownDots,
      controlsHidden:
        row?.querySelector('.data-toggle-controls')?.hidden === true,
      listHidden: row?.querySelector('.data-row-list')?.hidden === true,
      pointerOwner: window.__gevQa.pointerOwner(),
      motion: window.__gevQa.getActiveCameraMotion(),
      totalEntities: viewer.entities.values.length,
    };
  });
  check(
    'disabling removes every Directions entity',
    off.entities === 0,
    `${off.entities} left`,
  );
  check('disabling hides the maneuver dots', off.shownDots === 0);
  check(
    'disabling hides the chips and the turn list',
    off.controlsHidden && off.listHidden,
    `controls=${off.controlsHidden} list=${off.listHidden}`,
  );
  check(
    'disabling leaves the pointer free',
    off.pointerOwner === null,
    `owner=${off.pointerOwner}`,
  );
  check('disabling leaves no camera motion running', off.motion === null);
  check(
    'exactly the Directions entities went away, and nothing else did',
    off.totalEntities === beforeDisable - directionsBeforeDisable,
    `${beforeDisable} total (${directionsBeforeDisable} ours) -> ${off.totalEntities}`,
  );

  check(
    'no uncaught page errors',
    pageErrors.length === 0,
    pageErrors.join(' | '),
  );
  const realConsoleErrors = consoleErrors.filter(
    (text) =>
      !/Failed to load resource|net::ERR|favicon|429|ERR_ABORTED|status of 4/i.test(
        text,
      ),
  );
  check(
    'no unexpected console errors',
    realConsoleErrors.length === 0,
    realConsoleErrors.slice(0, 3).join(' | '),
  );
} catch (error) {
  check('harness completed', false, error?.stack || String(error));
  await shot(`99-${LABEL}-failure.jpg`).catch(() => {});
} finally {
  await browser.close();
  await fs.writeFile(
    path.join(SHOTS, `qa-directions-${LABEL}.log`),
    `${lines.join('\n')}\n${failures} failure(s)\n`,
  );
  console.log(`\n${failures} failure(s)`);
  process.exit(failures ? 1 : 0);
}
