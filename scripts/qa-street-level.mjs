#!/usr/bin/env node
/**
 * Browser QA for the Street Level layer against a running server. Run with
 * `npm run qa:street-level -- --url http://localhost:4173`.
 *
 * `--fixtures` (the CI mode) answers every *.mapillary.com request from
 * fixtures, so nothing reaches Mapillary. The server still needs a token
 * because the bundle carries it; CI uses a dummy one. Fixture runs also stage
 * a rejected key and a keyless second server.
 *
 * `--strict` fails on any skip not in STRICT_ALLOWED_SKIPS. A failed run saves
 * evidence under qa-artifacts/street-level/.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { LAYER_STATE_REGISTRY } from '../src/data/layerState.js';
import { tileBounds } from '../src/layers/streetLevel/tileMath.js';
import { encodeCoverageTile } from '../src/layers/streetLevel/providers/mapillary/coverageFixture.mjs';
import { COVERAGE_MOVE_DEBOUNCE_MS } from '../src/layers/streetLevel/providers/mapillary/policy.js';
import {
  hookRenderErrors,
  readRenderErrors,
  saveFailureArtifacts,
  watchPage,
} from './qa-browserEvidence.mjs';
import {
  answerMapillaryRequest,
  describeCall,
  PHOTO_LINE,
  PHOTO_SEQUENCE_ID,
  photoImages,
} from './fixtures/street-level/mapillaryGraph.mjs';

const PANEL_ID = 'street-level-panel';

/** Where a failed run leaves its screenshots and logs. */
export const ARTIFACT_DIR = 'qa-artifacts/street-level';

export const VIEWPORTS = Object.freeze([
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
]);

/** Providers the layer registers: one legend swatch each, plus "Selected". */
export const EXPECTED_PROVIDERS = Object.freeze(['mapillary']);

/**
 * Skips no setup can avoid: live runs cannot stage fixture-only cases.
 * `no Mapillary key` is not accepted: CI's dummy token runs the keyed flow,
 * so a keyless strict run means that wiring broke.
 */
export const STRICT_ALLOWED_SKIPS = Object.freeze(['fixtures only']);

export function strictViolations(skips) {
  return skips.filter((skip) => !STRICT_ALLOWED_SKIPS.includes(skip.reason));
}

const STREET_LEVEL_TOKEN = LAYER_STATE_REGISTRY.find(
  (entry) => entry.id === 'street-level',
).token;

/** The Street Level panel's token in the share link's `ui` panel state. */
export const PANEL_UI_TOKEN = 't';

/** Right-rail order once the layout controller has run. */
export const RAIL_ORDER = Object.freeze([
  'pp-toggles',
  'cctv-panel',
  'weather-panel',
  'recent-imagery-panel',
  'street-level-panel',
  'global-context-panel',
]);

/** Over downtown Sacramento, looking north and down. */
export const PARK = Object.freeze({
  lon: -121.4944,
  lat: 38.5816,
  height: 900,
  pitch: -1.3,
});

export function isCollapsed(classList) {
  return [...classList].includes('collapsed');
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const DAY_MS = 86_400_000;

/**
 * Deterministic coverage for any tile: a grid of mixed 360°/flat, new/old
 * sequences plus the photo sequence (PHOTO_LINE), or a few overview points.
 * @returns {Uint8Array} empty for zooms that carry nothing
 */
export function fixtureTile(z, x, y, now = Date.now()) {
  const tile = { x, y, z };
  const { west, east, south, north } = tileBounds(x, y, z);
  const at = (t, lo, hi) => lo + (hi - lo) * t;
  if (z <= 5)
    return encodeCoverageTile(tile, {
      overview: [0.25, 0.5, 0.75].map((t, i) => ({
        id: `fx-${z}-${x}-${y}-o${i}`,
        lon: at(t, west, east),
        lat: at(t, south, north),
        isPano: i === 1,
        capturedAt: now - 30 * DAY_MS,
      })),
    });
  if (z < 11) return new Uint8Array(0);
  const margin = (east - west) * 0.05;
  const sequences = [];
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const old = i > 2;
    sequences.push({
      id: `fx-${z}-${x}-${y}-h${i}`,
      isPano: i % 2 === 0,
      capturedAt: now - (old ? 1100 : 30) * DAY_MS,
      parts: [
        [
          [west + margin, at(t, south, north)],
          [east - margin, at(t, south, north)],
        ],
      ],
    });
    sequences.push({
      id: `fx-${z}-${x}-${y}-v${i}`,
      isPano: i % 2 === 1,
      capturedAt: now - (old ? 30 : 1100) * DAY_MS,
      parts: [
        [
          [at(t, west, east), south + margin],
          [at(t, west, east), north - margin],
        ],
      ],
    });
  }
  const photoSouth = Math.max(PHOTO_LINE.south, south);
  const photoNorth = Math.min(PHOTO_LINE.north, north);
  if (
    PHOTO_LINE.lon >= west &&
    PHOTO_LINE.lon < east &&
    photoSouth < photoNorth
  )
    sequences.push({
      id: PHOTO_SEQUENCE_ID,
      isPano: false,
      capturedAt: now - 30 * DAY_MS,
      parts: [
        [
          [PHOTO_LINE.lon, photoSouth],
          [PHOTO_LINE.lon, photoNorth],
        ],
      ],
    });
  return encodeCoverageTile(tile, { sequences });
}

/**
 * Ask the real status route from Node, outside the page's interception, so a
 * server that never registered it fails even in fixture runs. Node sends no
 * Origin, so the same-site gate admits it.
 * @returns {Promise<{configured: boolean}>}
 */
export async function assertRealStatusRoute(url, fetchImpl = fetch) {
  const route = new URL('/api/mapillary/status', url).href;
  let response;
  try {
    response = await fetchImpl(route, {
      headers: { Accept: 'application/json' },
    });
  } catch (error) {
    throw new Error(`${route} is unreachable: ${error?.message || error}`, {
      cause: error,
    });
  }
  const type = response.headers.get('content-type') || '';
  const text = await response.text();
  assert.equal(
    response.status,
    200,
    `${route} must be the server's Mapillary route (HTTP ${response.status}: ${text.slice(0, 120)})`,
  );
  assert.match(type, /application\/json/, `${route} answers JSON, not ${type}`);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    assert.fail(`${route} answered unparseable JSON: ${text.slice(0, 120)}`);
  }
  assert.equal(
    typeof body?.configured,
    'boolean',
    `${route} reports a boolean \`configured\`: ${text.slice(0, 120)}`,
  );
  return body;
}

/**
 * Answer the page's Mapillary requests from `fixture`, which steps may change
 * mid-run. `configured: undefined` lets the server's real status route answer.
 * @param {{configured?: boolean, tiles: 'ok'|'rejected', tileRequests: number, images: Array<object>, calls: Set<string>, unknown: Array<string>}} fixture
 */
export async function serveFixtures(page, fixture) {
  // CDP Fetch on just these URLs: Puppeteer's page-wide interception stalls
  // Cesium's worker scripts, leaving nothing to click.
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*://*.mapillary.com/*' },
      { urlPattern: '*/api/mapillary/*' },
    ],
  });
  const fulfil = (requestId, { status, headers = {}, contentType, body }) =>
    cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: status,
      responseHeaders: Object.entries({
        ...headers,
        ...(contentType ? { 'Content-Type': contentType } : {}),
      }).map(([name, value]) => ({ name, value: String(value) })),
      body: Buffer.from(body ?? '').toString('base64'),
    });
  const json = (status, payload) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const address = new URL(request.url);
    const method = request.method;
    let answer = null;
    if (/(^|\.)mapillary\.com$/.test(address.hostname)) {
      const call = describeCall(method, address);
      answer = answerMapillaryRequest({
        method,
        url: request.url,
        images: fixture.images,
      });
      fixture.calls.add(call);
      if (!answer.known) fixture.unknown.push(call);
    } else if (
      address.pathname === '/api/mapillary/status' &&
      fixture.configured !== undefined
    ) {
      answer = json(200, { configured: fixture.configured });
    } else {
      const tile = address.pathname.match(
        /^\/api\/mapillary\/tiles\/coverage\/(\d+)\/(\d+)\/(\d+)$/,
      );
      if (tile) {
        fixture.tileRequests++;
        if (fixture.configured === false)
          answer = json(503, { error: 'no_key', keyRequired: true });
        else if (fixture.tiles === 'rejected')
          answer = json(403, {
            error: 'Mapillary rejected the access token',
            keyRejected: true,
          });
        else {
          const bytes = fixtureTile(
            Number(tile[1]),
            Number(tile[2]),
            Number(tile[3]),
          );
          answer = bytes.length
            ? {
                status: 200,
                contentType: 'application/x-protobuf',
                body: Buffer.from(bytes),
              }
            : { status: 204, body: '' };
        }
      }
    }
    const done = answer
      ? fulfil(requestId, answer)
      : cdp.send('Fetch.continueRequest', { requestId });
    // A page that navigated or closed meanwhile has no request to answer.
    done.catch(() => {});
  });
}

export function newFixture(overrides = {}) {
  return {
    configured: undefined,
    tiles: 'ok',
    tileRequests: 0,
    images: photoImages(),
    calls: new Set(),
    unknown: [],
    ...overrides,
  };
}

/** Wait for `fn` in the page; false (not a throw) when it does not come true. */
async function settle(page, fn, arg, { timeout = 10_000 } = {}) {
  try {
    await page.waitForFunction(fn, { timeout, polling: 100 }, arg);
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

async function clearFirstRun(page) {
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.dataManager), {
    timeout: 150_000,
  });
  await page.evaluate(() =>
    document.querySelector('.first-run-explore')?.click(),
  );
  await settle(
    page,
    () => !document.querySelector('.first-run-explore'),
    null,
    {
      timeout: 3_000,
    },
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      '#first-run-launcher, [class*=first-run]',
    ))
      el.remove();
  });
}

/**
 * Best effort: wait until the panel's box has held still for `stillMs`, so a
 * point read from it does not move before the press.
 */
async function waitForStill(
  page,
  panelId,
  { stillMs = 300, timeout = 5000 } = {},
) {
  try {
    await page.waitForFunction(
      (id, ms) => {
        const r = document.getElementById(id).getBoundingClientRect();
        const box = [r.left, r.top, r.width, r.height].map(Math.round).join();
        const now = performance.now();
        if (window.__qaStillBox !== box) {
          window.__qaStillBox = box;
          window.__qaStillSince = now;
        }
        return now - window.__qaStillSince >= ms;
      },
      { polling: 100, timeout },
      panelId,
      stillMs,
    );
    return true;
  } catch (error) {
    if (error?.name !== 'TimeoutError') throw error;
    return false;
  }
}

/**
 * Click a panel control once the panel holds still and the control is what
 * lies under its centre: the rail animates panel heights, so a point read
 * once can miss by the time the pointer goes down.
 */
async function clickPanelControl(page, selector, { timeout = 5_000 } = {}) {
  await waitForStill(page, PANEL_ID);
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await page.$eval(selector, (el) => {
      el.scrollIntoView({ block: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      const top = document.elementFromPoint(x, y);
      return {
        x,
        y,
        ok: Boolean(top && (top === el || el.contains(top))),
        target: top
          ? `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}`
          : 'nothing',
      };
    });
    if (hit.ok) return page.mouse.click(hit.x, hit.y);
    if (Date.now() > deadline)
      throw new Error(`${selector} is covered by ${hit.target}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Load the app and clear the first-run dialog. */
export async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await clearFirstRun(page);
}

function readPanel(page) {
  return page.evaluate(() => {
    const el = document.getElementById('street-level-panel');
    const rail = document.getElementById('right-context-rail');
    const box = el.getBoundingClientRect();
    return {
      order: rail ? [...rail.children].map((child) => child.id) : [],
      classes: [...el.classList],
      width: Math.round(box.width),
      right: Math.round(box.right),
      status: document.getElementById('sl-status').textContent,
      controlsDisabled: document.getElementById('sl-controls').disabled,
      bodyDisplay: getComputedStyle(document.getElementById('sl-body')).display,
    };
  });
}

/** Wait until Street Level is on, drawn, settled and not key-gated. */
function waitForCoverage(page, { timeout = 90_000 } = {}) {
  return page.waitForFunction(
    () => {
      const dm = window.__godsEyeView.dataManager;
      const u = dm.layers.get('street-level').module.getUIState();
      return (
        dm.isEnabled('street-level') &&
        u.coverage.count > 0 &&
        !u.coverage.loading &&
        !u.keyRequired
      );
    },
    { timeout },
  );
}

async function assertKeylessGate(page) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('street-level', true, {
      origin: 'user',
    }),
  );
  await page.waitForFunction(
    () => document.getElementById('sl-status').textContent === 'KEY REQUIRED',
    { timeout: 30_000 },
  );
  const info = await readPanel(page);
  assert.equal(info.controlsDisabled, true);
  assert.equal(info.status, 'KEY REQUIRED');
  const hint = await page.$eval('#sl-error', (node) => ({
    hidden: node.hidden,
    text: node.textContent,
  }));
  assert.equal(hint.hidden, false, 'the panel says how to add the key');
  assert.match(hint.text, /MAPILLARY_CLIENT_TOKEN/);
}

/**
 * Runs in the page. Find a point where a real click picks `prefix` + `id` (any
 * id when null), searched around `points` ([lon, lat]), the aimed billboards,
 * or else a grid mid-screen. Only points where the canvas is topmost count.
 * @returns {{x: number, y: number, id: string}|null} client coordinates
 */
export function findPickPoint({
  prefix,
  id,
  points,
  billboardIds,
  billboardPrefix = null,
}) {
  const viewer = window.__godsEyeView.viewer;
  const scene = viewer.scene;
  const canvas = scene.canvas;
  const rect = canvas.getBoundingClientRect();
  const Cartographic = viewer.camera.positionCartographic.constructor;
  let Cartesian2 = null;
  const windowPoint = (x, y) => (Cartesian2 ? new Cartesian2(x, y) : { x, y });
  const wanted = (picked) => {
    const pid =
      typeof picked?.id === 'string' ? picked.id : (picked?.id?.id ?? null);
    if (typeof pid !== 'string' || !pid.startsWith(prefix)) return null;
    const rest = pid.slice(prefix.length).split('~')[0];
    return id === null || rest === id ? rest : null;
  };
  const tryAt = (x, y) => {
    if (x < 2 || y < 2 || x > rect.width - 2 || y > rect.height - 2)
      return null;
    const top = document.elementFromPoint(rect.left + x, rect.top + y);
    if (top !== canvas) return null;
    const hit = wanted(scene.pick(windowPoint(x, y)));
    return hit ? { x: rect.left + x, y: rect.top + y, id: hit } : null;
  };
  const centres = [];
  const aimed = (billboardId) =>
    typeof billboardId === 'string' &&
    ((billboardIds || []).includes(billboardId) ||
      (billboardPrefix !== null && billboardId.startsWith(billboardPrefix)));
  if ((billboardIds && billboardIds.length) || billboardPrefix !== null) {
    for (let i = 0; i < scene.primitives.length; i++) {
      const collection = scene.primitives.get(i);
      if (typeof collection?.get !== 'function' || !collection.length) continue;
      for (let j = 0; j < collection.length; j++) {
        const billboard = collection.get(j);
        if (!aimed(billboard?.id) || !billboard.show) continue;
        const at = billboard.computeScreenSpacePosition?.(scene);
        if (at) {
          Cartesian2 ??= at.constructor;
          centres.push([at.x, at.y]);
        }
      }
    }
  }
  for (const [lon, lat] of points || []) {
    const at = scene.cartesianToCanvasCoordinates(
      scene.globe.ellipsoid.cartographicToCartesian(
        Cartographic.fromDegrees(lon, lat, 0),
      ),
    );
    if (at) {
      Cartesian2 ??= at.constructor;
      centres.push([at.x, at.y]);
    }
  }
  for (const [cx, cy] of centres)
    for (let r = 0; r <= 16; r += 2)
      for (const [dx, dy] of [
        [0, 0],
        [r, 0],
        [-r, 0],
        [0, r],
        [0, -r],
      ]) {
        const hit = tryAt(cx + dx, cy + dy);
        if (hit) return hit;
      }
  if (points || billboardIds) return null;
  for (let y = rect.height * 0.25; y < rect.height * 0.8; y += 18)
    for (let x = rect.width * 0.25; x < rect.width * 0.7; x += 6) {
      const hit = tryAt(x, y);
      if (hit) return hit;
    }
  return null;
}

async function main() {
  const { default: puppeteer } = await import('puppeteer');
  const args = process.argv.slice(2);
  const urlIndex = args.indexOf('--url');
  const url = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';
  const fixtures = args.includes('--fixtures');
  const strict = args.includes('--strict');
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath()),
    defaultViewport: VIEWPORTS[0],
    protocolTimeout: 300_000,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  let count = 0;
  const skips = [];
  /** `fn` gets `skip(reason)`: the step runs what it can but reports a skip. */
  const step = async (label, fn) => {
    let skipped = null;
    const result = await fn({
      skip: (reason) => {
        skipped = reason;
      },
    });
    count++;
    if (skipped) {
      skips.push({ reason: skipped, label });
      console.log(`skip (${skipped}) ${count} ${label}`);
    } else console.log(`ok ${count} ${label}`);
    return result;
  };
  /** A step this mode cannot run at all. */
  const skipStep = (reason, label) => step(label, ({ skip }) => skip(reason));
  const errors = [];
  const monitors = [];
  /** The layer only warns on listener exceptions, so count those as errors. */
  const watch = async (page, name) => {
    monitors.push(
      watchPage(page, {
        name,
        errors,
        isError: (text) => /listener error/i.test(text),
      }),
    );
    await hookRenderErrors(page);
  };
  const renderErrorsSeen = [];
  try {
    await step(
      'the server registers the real Mapillary status route',
      async () => {
        const real = await assertRealStatusRoute(url);
        console.log(`  (server status: configured=${real.configured})`);
        if (fixtures)
          assert.equal(
            real.configured,
            true,
            'fixture runs need a server started with MAPILLARY_CLIENT_TOKEN (CI uses a dummy, non-secret one): the browser bundle carries the token, and without it no photo can open',
          );
      },
    );
    const page = await browser.newPage();
    const fixture = newFixture();
    await watch(page, 'main');
    if (fixtures) await serveFixtures(page, fixture);
    await boot(page, url);
    const panel = () => readPanel(page);
    const status = await page.evaluate(() =>
      fetch('/api/mapillary/status').then((res) => res.json()),
    );
    for (const viewport of VIEWPORTS) {
      await page.setViewport(viewport);
      await step(
        `panel is a collapsed right-rail strip at ${viewport.width}×${viewport.height}`,
        async () => {
          await settle(
            page,
            (width) => {
              const box = document
                .getElementById('street-level-panel')
                .getBoundingClientRect();
              return box.width <= 200 && box.right <= width;
            },
            viewport.width,
          );
          const info = await panel();
          assert.deepEqual(info.order, RAIL_ORDER);
          assert.ok(isCollapsed(info.classes));
          assert.equal(info.bodyDisplay, 'none');
          assert.ok(info.width <= 200 && info.right <= viewport.width);
        },
      );
    }
    await page.setViewport(VIEWPORTS[0]);
    const expandStrip = async (target = page) => {
      await target.click(
        '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
      );
      await settle(
        target,
        () =>
          getComputedStyle(document.getElementById('sl-body')).display ===
          'flex',
      );
    };
    await expandStrip();
    await step(
      'expanding the strip shows the body and the legend',
      async () => {
        const info = await panel();
        assert.ok(!isCollapsed(info.classes));
        assert.equal(info.bodyDisplay, 'flex');
        // One swatch per source plus "Selected".
        assert.equal(
          await page.evaluate(
            () => document.querySelectorAll('#sl-legend li').length,
          ),
          EXPECTED_PROVIDERS.length + 1,
        );
      },
    );
    if (!status.configured) {
      await step(
        'keyless install gates the controls and reports KEY REQUIRED',
        () => assertKeylessGate(page),
      );
      await skipStep(
        'no Mapillary key',
        'the keyed steps (coverage, filters, photos, panel window)',
      );
      console.log(
        'keyless run complete (no MAPILLARY_CLIENT_TOKEN on the server)',
      );
    } else {
      await keyedSteps();
    }
    await step('no page errors and no Cesium render-loop errors', async () => {
      renderErrorsSeen.push(
        ...(await readRenderErrors(page)).map(
          (text) => `[main] scene.renderError: ${text}`,
        ),
      );
      assert.deepEqual([...errors, ...renderErrorsSeen], []);
    });
    if (strict)
      await step('strict: no skips beyond the documented ones', () => {
        assert.deepEqual(
          strictViolations(skips),
          [],
          `--strict accepts only skips for: ${STRICT_ALLOWED_SKIPS.join(', ')}`,
        );
      });
    console.log(
      `${count} steps: ${count - skips.length} ok, ${skips.length} skipped`,
    );

    async function keyedSteps() {
      // A late startup flight only shows itself by moving the camera, so park
      // and check it stays put rather than reading a state.
      const park = async () => {
        for (let attempt = 0; attempt < 6; attempt++) {
          await page.evaluate((at) => {
            const v = window.__godsEyeView.viewer;
            v.camera.cancelFlight?.();
            const C = v.camera.positionCartographic.constructor;
            v.camera.setView({
              destination: v.scene.globe.ellipsoid.cartographicToCartesian(
                C.fromDegrees(at.lon, at.lat, at.height),
              ),
              orientation: { heading: 0, pitch: at.pitch, roll: 0 },
            });
          }, PARK);
          await sleep(1500);
          const stable = await page.evaluate((at) => {
            const c = window.__godsEyeView.viewer.camera.positionCartographic;
            return (
              Math.abs((c.longitude * 180) / Math.PI - at.lon) < 0.001 &&
              Math.abs((c.latitude * 180) / Math.PI - at.lat) < 0.001
            );
          }, PARK);
          if (stable) return;
        }
      };
      await park();
      await step(
        'enabling draws coverage and registers the on-globe credit',
        async () => {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.setEnabled('street-level', true, {
              origin: 'user',
            }),
          );
          await waitForCoverage(page);
          const info = await panel();
          assert.equal(info.controlsDisabled, false);
          // Cesium paints on-screen credits a frame or two after they register.
          await page.waitForFunction(
            () =>
              document.body.innerHTML.includes('Mapillary</a> contributors'),
            { timeout: 15_000 },
          );
        },
      );
      const ui = () =>
        page.evaluate(() =>
          window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.getUIState(),
        );
      /** `test(u, arg)` runs in the page, so it must be self-contained. */
      const uiUntil = (test, arg = null, options) =>
        settle(
          page,
          `(${test})(window.__godsEyeView.dataManager.layers.get('street-level').module.getUIState(), ${JSON.stringify(arg)})`,
          undefined,
          options,
        );
      const stacks = {
        active: () =>
          page.evaluate(() =>
            window.__godsEyeView.mapStackController.getActiveId(),
          ),
        set: async (id) => {
          await page.evaluate(
            (stackId) =>
              window.__godsEyeView.mapStackController.setStack(stackId),
            id,
          );
          await settle(
            page,
            (stackId) =>
              window.__godsEyeView.mapStackController.getActiveId() === stackId,
            id,
          );
        },
      };
      await step(
        'the header ON/OFF pill switches the layer off and on',
        async () => {
          assert.equal(
            await page.$eval('#sl-status', (node) =>
              [
                node.tagName,
                node.textContent,
                node.getAttribute('aria-pressed'),
              ].join(':'),
            ),
            'BUTTON:ON:true',
          );
          await clickPanelControl(page, '#sl-status');
          await page.waitForFunction(
            () => !window.__godsEyeView.dataManager.isEnabled('street-level'),
            { timeout: 15_000 },
          );
          await page.waitForFunction(
            () => document.getElementById('sl-status').textContent === 'OFF',
            { timeout: 5_000 },
          );
          assert.equal((await ui()).coverage.count, 0);
          await clickPanelControl(page, '#sl-status');
          await waitForCoverage(page);
          assert.equal(
            await page.$eval('#sl-status', (node) =>
              node.getAttribute('aria-pressed'),
            ),
            'true',
          );
        },
      );
      await step(
        'the 360° filter keeps at most the unfiltered sequence count',
        async () => {
          const before = (await ui()).coverage.count;
          await clickPanelControl(page, '[data-sl-pano="pano"]');
          await uiUntil((u) => u.filter.pano === 'pano' && !u.coverage.loading);
          const after = (await ui()).coverage.count;
          assert.ok(after <= before, `${after} ≤ ${before}`);
          // The fixtures hold flat sequences too, so the filter must drop some.
          if (fixtures) assert.ok(after < before, `${after} < ${before}`);
          assert.equal((await ui()).filter.pano, 'pano');
          // The click is a user params request, so the share link records it
          // under Street Level's share token, whatever the ledger assigned.
          await page.waitForFunction(
            (option) =>
              (new URLSearchParams(location.hash.slice(1)).get('lo') || '')
                .split('_')
                .includes(option),
            { timeout: 10_000 },
            `${STREET_LEVEL_TOKEN}.p.p`,
          );
          await clickPanelControl(page, '[data-sl-pano="all"]');
          await uiUntil(
            (u, n) => u.filter.pano === 'all' && u.coverage.count === n,
            before,
          );
          assert.equal((await ui()).coverage.count, before);
        },
      );
      await step(
        'the SINCE slider narrows coverage and names its cut-off date',
        async () => {
          const before = (await ui()).coverage.count;
          const setStop = (index) =>
            page.$eval(
              '#sl-since',
              (input, value) => {
                input.value = String(value);
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              },
              index,
            );
          await setStop(5);
          await uiUntil((u) => u.filter.sinceDays === 365);
          const narrowed = await ui();
          assert.equal(narrowed.filter.sinceDays, 365);
          if (fixtures)
            assert.ok(
              narrowed.coverage.count < before,
              `fixtures hold older sequences: ${narrowed.coverage.count} < ${before}`,
            );
          assert.ok(
            narrowed.coverage.count <= before,
            `${narrowed.coverage.count} ≤ ${before}`,
          );
          await settle(page, () =>
            /^LAST YEAR/.test(
              document.getElementById('sl-since-label').textContent,
            ),
          );
          assert.match(
            await page.$eval('#sl-since-label', (node) => node.textContent),
            /^LAST YEAR · SINCE \d{4}-\d{2}-\d{2}$/,
          );
          await setStop(0);
          await uiUntil((u) => u.filter.sinceDays === 0);
          await settle(
            page,
            () =>
              document.getElementById('sl-since-label').textContent ===
              'ANY DATE',
          );
          assert.equal((await ui()).filter.sinceDays, 0);
          assert.equal(
            await page.$eval('#sl-since-label', (node) => node.textContent),
            'ANY DATE',
          );
        },
      );
      await step(
        'the MapillaryJS viewer loads ahead of the first photo',
        async () => {
          // Catches a broken dynamic import before the first click would.
          await page.waitForSelector(
            '#sl-viewer.mapillary-viewer .mapillary-dom',
            { timeout: 60_000 },
          );
        },
      );
      const statusText = (text) =>
        page.waitForFunction(
          (expected) =>
            document.getElementById('sl-status').textContent === expected,
          { timeout: 30_000 },
          text,
        );
      const panTo = (lon, lat) =>
        page.evaluate(
          (at) => {
            const v = window.__godsEyeView.viewer;
            const C = v.camera.positionCartographic.constructor;
            v.camera.setView({
              destination: v.scene.globe.ellipsoid.cartographicToCartesian(
                C.fromDegrees(at.lon, at.lat, 900),
              ),
              orientation: { heading: 0, pitch: -1.3, roll: 0 },
            });
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.refreshCoverage();
          },
          { lon, lat },
        );
      /** Wait until no tile request has arrived for `quietMs`. */
      const tileRequestsQuiet = async (quietMs, timeout = 30_000) => {
        const start = Date.now();
        let last = fixture.tileRequests;
        let since = Date.now();
        while (Date.now() - start < timeout) {
          await sleep(100);
          if (fixture.tileRequests !== last) {
            last = fixture.tileRequests;
            since = Date.now();
          } else if (Date.now() - since >= quietMs) return last;
        }
        return last;
      };
      const QUIET_MS = 2 * COVERAGE_MOVE_DEBOUNCE_MS + 200;
      if (fixtures)
        await step(
          'a key Mapillary rejects reads KEY REJECTED, stops asking (a pan that asks while accepted asks nothing while rejected), and clears when switched off',
          async () => {
            // Positive control: with the key accepted, the same pan-and-wait
            // the rejected half uses does see new tile requests.
            await tileRequestsQuiet(QUIET_MS);
            const idle = fixture.tileRequests;
            await panTo(-121.46, 38.6);
            const asked = await tileRequestsQuiet(QUIET_MS);
            assert.ok(
              asked > idle,
              `a pan while accepted requests tiles (${idle} → ${asked})`,
            );
            fixture.tiles = 'rejected';
            await clickPanelControl(page, '#sl-status');
            await statusText('OFF');
            await clickPanelControl(page, '#sl-status');
            await statusText('KEY REJECTED');
            const shown = await page.evaluate(() => ({
              error: document.getElementById('sl-error').textContent,
              errorHidden: document.getElementById('sl-error').hidden,
              controls: document.getElementById('sl-controls').disabled,
            }));
            assert.match(shown.error, /rejected MAPILLARY_CLIENT_TOKEN/);
            assert.equal(shown.errorHidden, false);
            assert.equal(shown.controls, true);
            // Panning asks for nothing more: the verdict holds for every tile.
            const rejectedAt = await tileRequestsQuiet(QUIET_MS);
            await panTo(-121.42, 38.63);
            const after = await tileRequestsQuiet(QUIET_MS);
            assert.equal(after, rejectedAt, 'no tile requests while rejected');
            // Off clears the message; with a good key it comes back as ON.
            await clickPanelControl(page, '#sl-status');
            await statusText('OFF');
            assert.equal(
              await page.$eval(
                '#sl-error',
                (node) => node.hidden || !node.textContent,
              ),
              true,
              'no stale error while the layer is off',
            );
            fixture.tiles = 'ok';
            await clickPanelControl(page, '#sl-status');
            await waitForCoverage(page);
            await statusText('ON');
          },
        );
      else
        await skipStep(
          'fixtures only',
          'a key Mapillary rejects reads KEY REJECTED and stops asking',
        );

      const fixtureIds = new Map(
        fixture.images.map((image, index) => [image.id, { ...image, index }]),
      );
      const waitForImage = (id = null) =>
        page.waitForFunction(
          (want) => {
            const s = window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.getUIState().street;
            return (
              (s.imageId && !s.loading && (!want || s.imageId === want)) ||
              s.error
            );
          },
          { timeout: 90_000 },
          id,
        );
      const openById = async (id) => {
        await page.evaluate((imageId) => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openImage('mapillary', imageId);
        }, id);
        await waitForImage(id);
        const street = (await ui()).street;
        assert.equal(street.error, null, `viewer error: ${street.error}`);
        return street;
      };

      await park();
      await waitForCoverage(page);
      await step(
        'a click on a coverage line selects its sequence and draws its cones',
        async () => {
          const original = await stacks.active();
          // Draped lines on flat imagery: the line is where it is drawn.
          await stacks.set('esri-imagery');
          await waitForCoverage(page);
          const target = fixtures ? PHOTO_SEQUENCE_ID : null;
          const along = Array.from({ length: 9 }, (_, i) => [
            PHOTO_LINE.lon,
            PHOTO_LINE.south +
              ((i + 2) / 13) * (PHOTO_LINE.north - PHOTO_LINE.south),
          ]);
          // Ground primitives are built over a few frames: poll for a pick.
          const handle = await page.waitForFunction(
            findPickPoint,
            { timeout: 30_000, polling: 250 },
            {
              prefix: 'mly:seq:',
              id: target,
              points: fixtures ? along : null,
              billboardIds: null,
            },
          );
          const at = await handle.jsonValue();
          await page.mouse.click(at.x, at.y);
          const selected = await uiUntil(
            (u, id) =>
              u.sequence.selectedId === id &&
              !u.sequence.loading &&
              u.sequence.images > 0,
            at.id,
            { timeout: 30_000 },
          );
          const sequence = (await ui()).sequence;
          assert.ok(
            selected,
            `the click at ${Math.round(at.x)},${Math.round(at.y)} on ${at.id} selected it: ${JSON.stringify(sequence)}`,
          );
          if (fixtures)
            assert.equal(sequence.images, fixture.images.length, 'every photo');
          // The cones are on the globe: one of them picks as an image.
          const cone = await page.waitForFunction(
            findPickPoint,
            { timeout: 15_000, polling: 250 },
            {
              prefix: 'mly:img:',
              id: null,
              points: fixtures
                ? fixture.images.map((image) => [image.lon, image.lat])
                : null,
              billboardIds: null,
              // Live: the cones' positions are only known from the globe.
              billboardPrefix: fixtures ? null : 'mly:img:',
            },
          );
          assert.ok(await cone.jsonValue(), 'an image cone is pickable');
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.clearSequence(),
          );
          await uiUntil((u) => u.sequence.selectedId === null);
          await stacks.set(original);
        },
      );

      let firstImageId = null;
      await park();
      await waitForCoverage(page);
      await step(
        'opening the nearest image shows the viewer with a caption',
        async () => {
          // Fire and forget: the open can outlive one CDP call, so poll instead.
          await page.evaluate(() => {
            void window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.openNearest();
          });
          await waitForImage();
          const street = (await ui()).street;
          assert.equal(street.error, null, `viewer error: ${street.error}`);
          // Some images carry no creator name; the date/bearing side always fills.
          const filled = await settle(
            page,
            () =>
              document.getElementById('sl-image-when').textContent.trim()
                .length > 0,
            null,
            { timeout: 30_000 },
          );
          if (!filled) {
            const dump = await page.evaluate(() => {
              const u = window.__godsEyeView.dataManager.layers
                .get('street-level')
                .module.getUIState();
              return {
                street: u.street,
                captionNodes:
                  document.querySelectorAll('#sl-image-when').length,
                captionNow:
                  document.getElementById('sl-image-when').textContent,
                wrapHidden: document.getElementById('sl-viewer-wrap').hidden,
                collapsed: document
                  .getElementById('street-level-panel')
                  .classList.contains('collapsed'),
              };
            });
            throw new Error(`caption never filled: ${JSON.stringify(dump)}`);
          }
          const view = await page.evaluate(() => ({
            hidden: document.getElementById('sl-viewer-wrap').hidden,
            when: document.getElementById('sl-image-when').textContent.trim(),
            link: document.getElementById('sl-image-link').textContent.trim(),
            href: document.getElementById('sl-image-link').href,
            width: Math.round(
              document.getElementById('sl-viewer').getBoundingClientRect()
                .width,
            ),
          }));
          assert.equal(view.hidden, false);
          assert.ok(view.width > 200);
          assert.ok(view.when.length > 0, 'caption shows the capture date');
          assert.equal(street.providerId, 'mapillary');
          firstImageId = street.imageId;
          assert.equal(view.link, 'MAPILLARY ↗');
          if (fixtures) {
            const known = fixtureIds.get(street.imageId);
            assert.ok(known, `a fixture photo opened (${street.imageId})`);
            assert.equal(street.isPano, known.isPano, 'pano flag from the ent');
            assert.equal(street.sequenceId, PHOTO_SEQUENCE_ID);
          }
          const fit = await page.evaluate(() => {
            const inner = document.querySelector('.street-level-panel-inner');
            const box = inner.getBoundingClientRect();
            const wrap = document
              .getElementById('sl-viewer-wrap')
              .getBoundingClientRect();
            return {
              scrollTop: inner.scrollTop,
              top: wrap.top - box.top,
              overflowBottom: wrap.bottom - box.bottom,
            };
          });
          assert.equal(fit.scrollTop, 0, 'panel not scrolled');
          assert.ok(
            fit.top >= 0 && fit.top < 80,
            `viewer right under the header (${fit.top}px)`,
          );
          assert.ok(
            fit.overflowBottom <= 1,
            `whole viewer visible (${fit.overflowBottom}px cut)`,
          );
          assert.match(view.href, /mapillary\.com\/app\/\?pKey=/);
          // The open selects the photo's sequence: its cones are drawn.
          assert.ok(
            await uiUntil(
              (u) => u.sequence.selectedId === u.street.sequenceId,
              null,
              { timeout: 30_000 },
            ),
            'the open photo’s sequence is selected',
          );
        },
      );
      if (fixtures)
        await step(
          'a click on a neighbouring cone steps the viewer to that photo (360° and flat)',
          async () => {
            // Let the framing flight land, so the cone does not move under the click.
            await settle(
              page,
              () => !window.__godsEyeView.viewer.camera._currentFlight,
              null,
              { timeout: 10_000 },
            );
            await uiUntil((u) => u.sequence.images > 0 && !u.sequence.loading);
            const current = fixtureIds.get(firstImageId);
            const neighbour = [1, -1, 2, -2, 4, -4]
              .map((offset) => fixture.images[current.index + offset])
              .find((image) => image && image.isPano !== current.isPano);
            assert.ok(neighbour, 'a neighbour of the other camera type');
            const handle = await page.waitForFunction(
              findPickPoint,
              { timeout: 15_000, polling: 250 },
              {
                prefix: 'mly:img:',
                id: neighbour.id,
                points: null,
                billboardIds: [`mly:img:${neighbour.id}`],
              },
            );
            const at = await handle.jsonValue();
            await page.mouse.click(at.x, at.y);
            await waitForImage(neighbour.id);
            const street = (await ui()).street;
            assert.equal(street.error, null);
            assert.equal(street.imageId, neighbour.id, 'stepped to the cone');
            assert.equal(street.isPano, neighbour.isPano);
            assert.notEqual(street.isPano, current.isPano, 'both kinds shown');
            await openById(firstImageId);
          },
        );
      else
        await skipStep(
          'fixtures only',
          'a click on a neighbouring cone steps the viewer to that photo',
        );
      await park();
      await step(
        'closing a photo stops the framing flight toward it',
        async () => {
          // Opening frames the photo with a 1.6 s camera flight; closing right
          // away must cancel it, leaving the camera where it was.
          const result = await page.evaluate(async (id) => {
            const v = window.__godsEyeView.viewer;
            const module =
              window.__godsEyeView.dataManager.layers.get(
                'street-level',
              ).module;
            const opened = await module.openImage('mapillary', id);
            const flying = Boolean(v.camera._currentFlight);
            const from = v.camera.positionCartographic.clone();
            module.closeViewer();
            const stillFlying = Boolean(v.camera._currentFlight);
            const frames = (n) =>
              new Promise((resolve) => {
                const tick = () =>
                  --n <= 0 ? resolve() : requestAnimationFrame(tick);
                requestAnimationFrame(tick);
              });
            await frames(20);
            const to = v.camera.positionCartographic;
            return {
              opened,
              flying,
              stillFlying,
              moved: Math.hypot(
                (to.longitude - from.longitude) * 6_371_000,
                (to.latitude - from.latitude) * 6_371_000,
                to.height - from.height,
              ),
              height: to.height,
            };
          }, firstImageId);
          assert.equal(result.opened, true, 'the photo opened');
          assert.equal(result.flying, true, 'opening started a framing flight');
          assert.equal(result.stillFlying, false, 'closing cancelled it');
          assert.ok(
            result.moved < 0.5,
            `the camera stopped where it was (moved ${result.moved.toFixed(2)} m)`,
          );
          assert.ok(
            result.height > PARK.height / 2,
            `the camera never reached the photo (${Math.round(result.height)} m up)`,
          );
          assert.equal((await ui()).street.open, false);
        },
      );
      await step(
        '× closes the image and deselects it on the globe',
        async () => {
          await openById(firstImageId);
          await clickPanelControl(page, '#sl-viewer-close');
          await uiUntil(
            (u) => !u.street.open && u.sequence.selectedId === null,
          );
          const after = await ui();
          assert.equal(after.street.open, false);
          assert.equal(after.sequence.selectedId, null);
        },
      );
      await step('on a phone the whole photo fits in the panel', async () => {
        // Width alone drives the phone layout; toggling isMobile would reload.
        await page.setViewport({ width: 390, height: 844 });
        await settle(page, () => innerWidth === 390);
        if (
          await page.$eval('#street-level-panel', (node) =>
            node.classList.contains('collapsed'),
          )
        )
          await expandStrip();
        await openById(firstImageId);
        const measure = () =>
          page.evaluate(() => {
            const inner = document
              .querySelector('.street-level-panel-inner')
              .getBoundingClientRect();
            const meta = document
              .getElementById('sl-image-meta')
              .getBoundingClientRect();
            const viewer = document
              .getElementById('sl-viewer')
              .getBoundingClientRect();
            return {
              cut: Math.round(meta.bottom - inner.bottom),
              top: Math.round(viewer.top - inner.top),
              height: Math.round(viewer.height),
              overflowX: document.documentElement.scrollWidth > innerWidth,
            };
          });
        // The panel settles its phone layout over a frame or two.
        await settle(page, () => {
          const inner = document
            .querySelector('.street-level-panel-inner')
            .getBoundingClientRect();
          const meta = document
            .getElementById('sl-image-meta')
            .getBoundingClientRect();
          return (
            meta.bottom - inner.bottom <= 1 &&
            document.getElementById('sl-viewer').getBoundingClientRect()
              .height >= 100
          );
        });
        const fit = await measure();
        assert.ok(fit.cut <= 1, `photo and caption fit (${fit.cut}px cut)`);
        assert.ok(fit.height >= 100, `viewer stays usable (${fit.height}px)`);
        assert.equal(fit.overflowX, false, 'no sideways scroll');
        await page.setViewport(VIEWPORTS[0]);
        await settle(page, (width) => innerWidth === width, VIEWPORTS[0].width);
      });
      await step(
        'a reload with the layer on keeps a collapsed panel collapsed, and the share link carries its ui token',
        async () => {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.closeViewer(),
          );
          // Press through the DOM: a toast over the button must not make this
          // step about pointer aim.
          await page.$eval(
            '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
            (button) => {
              const panel = document.getElementById('street-level-panel');
              if (!panel.classList.contains('collapsed')) button.click();
            },
          );
          assert.ok(
            await settle(page, () =>
              document
                .getElementById('street-level-panel')
                .classList.contains('collapsed'),
            ),
            'the panel collapsed',
          );
          const shared = (collapsed) =>
            settle(
              page,
              (assignment) =>
                (new URLSearchParams(location.hash.slice(1)).get('ui') || '')
                  .split('_')
                  .includes(assignment),
              `${PANEL_UI_TOKEN}.c.${collapsed ? '1' : '0'}`,
            );
          assert.ok(
            await shared(true),
            `the share link records the collapsed panel as ui ${PANEL_UI_TOKEN}.c.1: ${await page.evaluate(() => location.hash)}`,
          );
          await page.reload({ waitUntil: 'domcontentloaded' });
          await clearFirstRun(page);
          await waitForCoverage(page);
          // The panel would open on the enable transition, before coverage.
          const after = await page.evaluate(() => ({
            enabled: window.__godsEyeView.dataManager.isEnabled('street-level'),
            collapsed: document
              .getElementById('street-level-panel')
              .classList.contains('collapsed'),
          }));
          assert.deepEqual(
            after,
            { enabled: true, collapsed: true },
            'the restored layer did not reopen the panel',
          );
          assert.ok(await shared(true), 'still shared as collapsed');
        },
      );
      if (fixtures)
        await step(
          'keyless install (a second page, no key on the server) gates the controls and reports KEY REQUIRED',
          async () => {
            const keyless = await browser.newPage();
            await keyless.setViewport(VIEWPORTS[0]);
            await watch(keyless, 'keyless');
            await serveFixtures(keyless, newFixture({ configured: false }));
            await boot(keyless, url);
            await expandStrip(keyless);
            await assertKeylessGate(keyless);
            renderErrorsSeen.push(
              ...(await readRenderErrors(keyless)).map(
                (text) => `[keyless] scene.renderError: ${text}`,
              ),
            );
            await keyless.close();
          },
        );
      else
        await skipStep(
          'fixtures only',
          'keyless install (a second page) reports KEY REQUIRED',
        );
      if (fixtures)
        await step(
          'every Mapillary request was answered from a fixture',
          () => {
            console.log(
              `  (answered: ${[...fixture.calls].sort().join(' | ')})`,
            );
            assert.deepEqual(fixture.unknown, [], 'no unanswered call');
          },
        );
    }
  } catch (error) {
    const dir = await saveFailureArtifacts({
      dir: ARTIFACT_DIR,
      browser,
      monitors,
      error,
    }).catch(() => null);
    if (dir) console.error(`failure evidence saved in ${dir}/`);
    throw error;
  } finally {
    await browser.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
