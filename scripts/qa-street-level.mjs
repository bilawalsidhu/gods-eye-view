#!/usr/bin/env node
/**
 * Browser QA for the Street Level layer against a running server:
 * `npm run qa:street-level -- --url http://localhost:4173`.
 *
 * `--fixtures` (CI) answers every *.mapillary.com, KartaView and Panoramax
 * request and the coverage tile route from fixtures, so nothing reaches those
 * providers; the server still needs a (dummy) Mapillary token because the
 * bundle carries it. `--strict` fails on any
 * skip other than "fixtures only". A failed run saves evidence under
 * qa-artifacts/street-level/.
 */
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { tileBounds } from '../src/layers/streetLevel/tileMath.js';
import { encodeCoverageTile } from '../src/layers/streetLevel/providers/mapillary/coverageFixture.mjs';
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
  THUMB_HOST,
  photoImages,
} from './fixtures/street-level/mapillaryGraph.mjs';
import {
  answerKartaViewRequest,
  describeKartaViewCall,
  KV_SEQUENCE_ID,
  kartaViewPhotos,
  resetKartaViewFixture,
} from './fixtures/street-level/kartaView.mjs';
import {
  answerPanoramaxRequest,
  describePanoramaxCall,
  PNX_PARK,
  panoramaxPictures,
  resetPanoramaxFixture,
} from './fixtures/street-level/panoramax.mjs';

const VIEWPORT = { width: 1440, height: 900 };
/** Over downtown Sacramento, above the fixture photo line, looking down. */
const PARK = { lon: PHOTO_LINE.lon, lat: 38.5816, height: 900, pitch: -1.3 };
const DAY_MS = 86_400_000;
/** A Sacramento street with Street View, for the sl=google link step. */
const STREET_VIEW_STREET = Object.freeze({ lon: -121.49372, lat: 38.57986 });
/**
 * What a Street View lookup and load cost: the Maps JS API's
 * SingleImageSearch (the nearest lookup), GetMetadata and the panorama tiles.
 * Script loads are not counted.
 */
const STREET_VIEW_REQUEST =
  /MapsJsInternalService\/(SingleImageSearch|GetMetadata)|GeoPhotoService|streetviewpixels-pa\.googleapis\.com/;

/**
 * Coverage for any street-zoom tile: a grid of 360°/flat, recent/old
 * sequences, plus the photo sequence where PHOTO_LINE crosses the tile.
 * @returns {Uint8Array} empty below z11, which the layer never asks for
 */
function fixtureTile(z, x, y, now = Date.now()) {
  if (z < 11) return new Uint8Array(0);
  const { west, east, south, north } = tileBounds(x, y, z);
  const at = (t, lo, hi) => lo + (hi - lo) * t;
  const margin = (east - west) * 0.05;
  const sequences = [];
  for (let i = 1; i <= 4; i++) {
    const t = i / 5;
    const old = i > 2;
    const lat = at(t, south, north);
    const lon = at(t, west, east);
    sequences.push(
      {
        id: `fx-${z}-${x}-${y}-h${i}`,
        isPano: i % 2 === 0,
        capturedAt: now - (old ? 1100 : 30) * DAY_MS,
        parts: [
          [
            [west + margin, lat],
            [east - margin, lat],
          ],
        ],
      },
      {
        id: `fx-${z}-${x}-${y}-v${i}`,
        isPano: i % 2 === 1,
        capturedAt: now - (old ? 30 : 1100) * DAY_MS,
        parts: [
          [
            [lon, south + margin],
            [lon, north - margin],
          ],
        ],
      },
    );
  }
  const lineSouth = Math.max(PHOTO_LINE.south, south);
  const lineNorth = Math.min(PHOTO_LINE.north, north);
  if (PHOTO_LINE.lon >= west && PHOTO_LINE.lon < east && lineSouth < lineNorth)
    sequences.push({
      id: PHOTO_SEQUENCE_ID,
      isPano: false,
      capturedAt: now - 30 * DAY_MS,
      parts: [
        [
          [PHOTO_LINE.lon, lineSouth],
          [PHOTO_LINE.lon, lineNorth],
        ],
      ],
    });
  return encodeCoverageTile({ x, y, z }, { sequences });
}

/** Fixture answers and call names per keyless provider host. */
const KEYLESS_HOSTS = [
  {
    host: /(^|\.)(kartaview|openstreetcam)\.org$/,
    describe: describeKartaViewCall,
    answer: answerKartaViewRequest,
  },
  {
    host: /^(api\.panoramax\.xyz|panoramax\.openstreetmap\.fr)$/,
    describe: describePanoramaxCall,
    answer: answerPanoramaxRequest,
  },
];

/**
 * Answer the page's Mapillary, KartaView and Panoramax requests from
 * `fixture`, which steps may change mid-run. `configured: undefined` lets the
 * server's real status route answer.
 */
async function serveFixtures(page, fixture) {
  const record = (phase, detail) => {
    fixture.events.push({ at: Date.now(), phase, ...detail });
    if (fixture.events.length > 300) fixture.events.shift();
  };
  const providerPath = (method, address) => {
    return KEYLESS_HOSTS.some(({ host }) => host.test(address.hostname))
      ? `${method} ${address.hostname}${address.pathname}`
      : null;
  };
  for (const phase of ['request', 'requestfinished', 'requestfailed']) {
    page.on(phase, (request) => {
      const path = providerPath(request.method(), new URL(request.url()));
      if (path)
        record(phase, {
          path,
          status: request.response()?.status() ?? null,
          ...(phase === 'requestfailed'
            ? { failure: request.failure()?.errorText }
            : {}),
        });
    });
  }
  // CDP Fetch on just these URLs: page-wide interception stalls Cesium workers.
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*://*.mapillary.com/*' },
      { urlPattern: '*/api/mapillary/*' },
      { urlPattern: '*://api.kartaview.org/*' },
      { urlPattern: '*://cdn.kartaview.org/*' },
      { urlPattern: '*://*.openstreetcam.org/*' },
      { urlPattern: '*://api.panoramax.xyz/*' },
      { urlPattern: '*://panoramax.openstreetmap.fr/*' },
    ],
  });
  const json = (status, payload) => ({
    status,
    contentType: 'application/json',
    body: JSON.stringify(payload),
  });
  const answerFor = (method, address) => {
    if (/(^|\.)mapillary\.com$/.test(address.hostname)) {
      const call = describeCall(method, address);
      const answer = answerMapillaryRequest({
        method,
        url: address.href,
        images: fixture.images,
      });
      fixture.calls.add(call);
      if (!answer.known) fixture.unknown.push(call);
      return answer;
    }
    const keyless = KEYLESS_HOSTS.find(({ host }) =>
      host.test(address.hostname),
    );
    if (keyless) {
      const call = keyless.describe(method, address);
      const answer = keyless.answer({ method, url: address.href });
      fixture.calls.add(call);
      if (!answer.known) fixture.unknown.push(call);
      return answer;
    }
    if (address.pathname === '/api/mapillary/status')
      return fixture.configured === undefined
        ? null
        : json(200, { configured: fixture.configured });
    const tile = address.pathname.match(
      /^\/api\/mapillary\/tiles\/coverage\/(\d+)\/(\d+)\/(\d+)$/,
    );
    if (!tile) return null;
    if (fixture.configured === false)
      return json(503, { error: 'no_key', keyRequired: true });
    if (fixture.rejected)
      return json(403, {
        error: 'Mapillary rejected the access token',
        keyRejected: true,
      });
    const bytes = fixtureTile(...tile.slice(1).map(Number));
    return bytes.length
      ? { status: 200, contentType: 'application/x-protobuf', body: bytes }
      : { status: 204, body: '' };
  };
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const address = new URL(request.url);
    const answer = answerFor(request.method, address);
    const path = providerPath(request.method, address);
    if (path)
      record('intercepted', {
        requestId,
        path,
        status: answer?.status ?? null,
      });
    const done = answer
      ? cdp.send('Fetch.fulfillRequest', {
          requestId,
          responseCode: answer.status,
          responseHeaders: Object.entries({
            ...answer.headers,
            ...(answer.contentType
              ? { 'Content-Type': answer.contentType }
              : {}),
          }).map(([name, value]) => ({ name, value: String(value) })),
          body: Buffer.from(answer.body ?? '').toString('base64'),
        })
      : cdp.send('Fetch.continueRequest', { requestId });
    // A page that navigated or closed meanwhile has no request to answer.
    done
      .then(() => {
        if (path)
          record('answered', {
            requestId,
            path,
            status: answer?.status ?? null,
          });
      })
      .catch((error) => {
        if (path)
          record('interception-ended', {
            requestId,
            path,
            error: String(error.message).replace(/https?:\/\/\S+/g, '[url]'),
          });
      });
  });
}

function newFixture(overrides = {}) {
  return {
    configured: undefined,
    rejected: false,
    images: photoImages(),
    calls: new Set(),
    unknown: [],
    events: [],
    ...overrides,
  };
}

/** Load without the opening so its flight cannot move the camera during
 * the gate's own moves, with the welcome dialog disabled through the app. */
async function boot(page, url) {
  const address = new URL(url);
  address.searchParams.set('intro', '0');
  address.searchParams.set('welcome', '0');
  await page.goto(address.href, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.dataManager), {
    timeout: 150_000,
  });
}

/**
 * Open a share link as a fresh document. Changing only the hash of a live
 * page and reloading races the app's share-link writer, which can put its own
 * state back in the hash before the reload reads it. The page's fixtures (a
 * CDP session on the page) carry over.
 */
async function bootLink(page, link) {
  await page.goto('about:blank');
  await boot(page, link);
}

/** The camera's position in degrees and metres. */
const cameraAt = (page) =>
  page.evaluate(() => {
    const c = window.__godsEyeView.viewer.camera.positionCartographic;
    return {
      lon: (c.longitude * 180) / Math.PI,
      lat: (c.latitude * 180) / Math.PI,
      height: c.height,
    };
  });

/** Run `test(uiState, arg)` in the page until it is true. */
const uiUntil = (page, test, arg = null, timeout = 30_000) =>
  page.waitForFunction(
    `(${test})(window.__godsEyeView.dataManager.layers.get('street-level').module.getUIState(), ${JSON.stringify(arg)})`,
    { timeout, polling: 100 },
  );

/** `id` is the one provider lit. */
const litAlone = (u, id) =>
  u.providers.find((p) => p.id === id)?.on === true &&
  u.providers.filter((p) => p.on).length === 1;

const getUI = (page) =>
  page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('street-level')
      .module.getUIState(),
  );

const LAYER_ROW = '[data-layer-id="street-level"]';
const LAYER_TOGGLE = `${LAYER_ROW} .data-toggle-btn`;
const CONTEXT_PANEL = '#global-context-panel';
const PHOTO_CARD = '#entity-card[data-layer="street-level"]';
const PHOTO_VIEW = `${CONTEXT_PANEL}:not(.collapsed) ${PHOTO_CARD} #sl-viewer-wrap`;
const PHOTO_CLOSE = `${PHOTO_CARD} .entity-card__close`;

// The Data Layers row shows status and provider errors.
const statusIs = async (page, status) => {
  await uiUntil(
    page,
    (u, want) => {
      if (want === 'KEY REQUIRED') return u.keyRequired;
      if (want === 'KEY REJECTED') return u.keyRejected;
      if (want === 'OFF') return !u.enabled;
      return (
        u.enabled && !u.keyRequired && !u.keyRejected && !u.coverage.loading
      );
    },
    status,
  );
  // The row publishes on the next animation frame; a settled provider alone
  // does not prove its visible controls have caught up.
  await page.waitForFunction(
    (want) => {
      const row = document.querySelector('[data-layer-id="street-level"]');
      const button = row?.querySelector('.data-toggle-btn');
      if (!button || button.getAttribute('aria-busy') === 'true') return false;
      const filters = [
        ...row.querySelectorAll('[data-segmented-id="sl-pano"] button'),
      ];
      const info = row.querySelector('.data-toggle-controls-info');
      const alert = row.querySelector(
        '.data-toggle-controls-alert[role="status"]',
      );
      if (want === 'OFF')
        return (
          !button.classList.contains('active') &&
          (!info || info.hidden || !info.textContent) &&
          !alert?.textContent
        );
      if (!button.classList.contains('active') || !filters.length) return false;
      if (want === 'KEY REJECTED')
        return (
          filters.every((item) => item.disabled) &&
          /rejected MAPILLARY_CLIENT_TOKEN/.test(alert?.textContent || '')
        );
      if (want === 'KEY REQUIRED')
        return (
          filters.every((item) => item.disabled) &&
          /MAPILLARY_CLIENT_TOKEN/.test(
            row.textContent +
              [...row.querySelectorAll('[data-chip-id]')]
                .map((item) => item.title)
                .join(' '),
          )
        );
      return filters.every((item) => !item.disabled);
    },
    { timeout: 30_000 },
    status,
  );
};

const panoIs = async (page, value) => {
  await uiUntil(page, (u, want) => u.filter.pano === want, value);
  await page.waitForFunction(
    (want) => {
      const button = document.querySelector(
        `[data-layer-id="street-level"] [data-chip-id="sl-pano-${want}"]`,
      );
      return (
        button?.getAttribute('aria-checked') === 'true' &&
        document.activeElement === button
      );
    },
    { timeout: 10_000 },
    value,
  );
};

const readLayerControls = (page) =>
  page.$eval(LAYER_ROW, (row) => {
    const filters = [
      ...row.querySelectorAll('[data-segmented-id="sl-pano"] button'),
    ];
    const alert = row.querySelector(
      '.data-toggle-controls-alert[role="status"]',
    );
    return {
      active: row
        .querySelector('.data-toggle-btn')
        .classList.contains('active'),
      filtersPresent: filters.length > 0,
      filtersDisabled:
        filters.length > 0 && filters.every((button) => button.disabled),
      error: alert?.textContent || '',
      providerTitles: [
        ...row.querySelectorAll('[data-chip-id^="sl-provider-"]'),
      ].map((button) => button.title),
    };
  });

const waitForCoverage = (page) =>
  uiUntil(
    page,
    (u) =>
      u.enabled &&
      u.coverage.count > 0 &&
      !u.coverage.loading &&
      !u.keyRequired,
    null,
    90_000,
  );

/**
 * Press a panel control through the DOM: the rail animates panel heights, so
 * a pointer aimed from one frame's layout can miss in the next.
 */
const press = (page, selector) =>
  page.$eval(selector, (control) => control.click());

/** Open Data Layers and wait for the Street Level toggle. */
async function openStreetLevelRow(page) {
  const collapsed = await page.$eval('#data-panel', (node) =>
    node.classList.contains('collapsed'),
  );
  if (collapsed) await press(page, '[data-rail-item="data-panel"]');
  await page.waitForSelector(LAYER_TOGGLE, { visible: true, timeout: 10_000 });
}

/** A keyless bundle opens on the first keyless source with live controls. */
async function assertKeylessDefault(page) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('street-level', true, {
      origin: 'user',
    }),
  );
  await uiUntil(page, litAlone, 'kartaview');
  const shown = await readLayerControls(page);
  assert.equal(shown.active, true);
  assert.equal(shown.filtersPresent, true, 'row filters are present');
  assert.equal(shown.filtersDisabled, false, 'row filters stay live');
}

async function assertKeyRequired(page) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('street-level', true, {
      origin: 'user',
    }),
  );
  await statusIs(page, 'KEY REQUIRED');
  const shown = await readLayerControls(page);
  assert.equal(shown.filtersDisabled, true, 'row filters are gated');
  assert.match(
    `${shown.error} ${shown.providerTitles.join(' ')}`,
    /MAPILLARY_CLIENT_TOKEN/,
    'names the key to add',
  );
}

/**
 * Client coordinates of the first thing drawn whose pick id starts with
 * `prefix`, scanning `box` ({x, y, w, h} in canvas pixels; default: a row
 * across the middle) every `step` px; null when nothing matches.
 */
const findPick = (
  page,
  prefix,
  { box = null, step = 3, exclude = null } = {},
) =>
  page.evaluate(
    (want, area, stride, excluded) => {
      const { scene } = window.__godsEyeView.viewer;
      const rect = scene.canvas.getBoundingClientRect();
      const { x, y, w, h } = area || {
        x: 0,
        y: Math.round(rect.height / 2),
        w: rect.width,
        h: 1,
      };
      for (let py = y; py < y + h; py += stride)
        for (let px = x; px < x + w; px += stride) {
          // A drawn item's pick id names its draw set and its own id.
          const picked = scene.pick({ x: px, y: py })?.id;
          const id = typeof picked === 'string' ? picked : picked?.id;
          if (typeof id === 'string' && id.startsWith(want) && id !== excluded)
            return {
              x: rect.left + px,
              y: rect.top + py,
              local: { x: px, y: py },
              id,
            };
        }
      return null;
    },
    prefix,
    box,
    step,
    exclude,
  );

/**
 * `findPick`, retried until a hit or `timeout`: draped lines build in a
 * worker after their tile decoded, so a scan right after LOADING clears can
 * come too early on a slow machine.
 */
async function findPickUntil(
  page,
  prefix,
  { timeout = 30_000, box = null, step, exclude = null } = {},
) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const hit = await findPick(page, prefix, { box, step, exclude });
    if (hit || Date.now() >= deadline) return hit;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** Park the camera at `at`; a late startup flight can move it. */
async function park(page, at = PARK) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const stayed = await page.evaluate(async (at) => {
      const v = window.__godsEyeView.viewer;
      v.camera.cancelFlight?.();
      const C = v.camera.positionCartographic.constructor;
      v.camera.setView({
        destination: v.scene.globe.ellipsoid.cartographicToCartesian(
          C.fromDegrees(at.lon, at.lat, at.height),
        ),
        orientation: { heading: 0, pitch: at.pitch, roll: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const c = v.camera.positionCartographic;
      return (
        Math.abs((c.longitude * 180) / Math.PI - at.lon) < 0.001 &&
        Math.abs((c.latitude * 180) / Math.PI - at.lat) < 0.001
      );
    }, at);
    if (stayed) return;
  }
  throw new Error(`the camera would not stay parked at ${JSON.stringify(at)}`);
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
    defaultViewport: VIEWPORT,
    protocolTimeout: 300_000,
    args:
      process.platform === 'linux'
        ? ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader']
        : [],
  });
  let count = 0;
  const skips = [];
  const skip = (reason, label) => {
    skips.push(reason);
    console.log(`skip (${reason}) ${++count} ${label}`);
  };
  // `fn` may call `skipped(reason)` when a live run has nothing to test.
  const step = async (label, fn) => {
    let reason = null;
    await fn({ skipped: (why) => (reason = why) });
    if (reason) skip(reason, label);
    else console.log(`ok ${++count} ${label}`);
  };
  const fixtureStep = (label, fn) =>
    fixtures ? step(label, fn) : skip('fixtures only', label);
  const errors = [];
  const monitors = [];
  // The layer only warns on listener exceptions, so count those as errors.
  const open = async (name, fixture) => {
    const page = await browser.newPage();
    monitors.push(
      watchPage(page, {
        name,
        errors,
        isError: (text) => /listener error/i.test(text),
      }),
    );
    await hookRenderErrors(page);
    if (fixture) await serveFixtures(page, fixture);
    await boot(page, url);
    const renderer = await page.evaluate(() => {
      const gl = window.__godsEyeView.viewer.scene.context._gl;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        name: gl.getParameter(
          debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER,
        ),
        lost: gl.isContextLost(),
      };
    });
    console.log(`  renderer (${name}): ${JSON.stringify(renderer)}`);
    assert.equal(renderer.lost, false, 'WebGL context remains live');
    if (process.platform === 'darwin')
      assert.doesNotMatch(
        renderer.name,
        /swiftshader|llvmpipe|software/i,
        'macOS QA uses the native GPU',
      );
    return page;
  };
  const collectRenderErrors = async (page, name) =>
    errors.push(
      ...(await readRenderErrors(page)).map(
        (text) => `[${name}] scene.renderError: ${text}`,
      ),
    );

  /**
   * A keyless provider: lighting its chip darkens the others and draws its
   * coverage with its credit; a click on a line opens a photo from it; ×
   * closes it. Leaves that provider lit.
   */
  const keylessProviderStep = ({
    id,
    name,
    at,
    linePrefix,
    box,
    reset,
    check,
  }) =>
    step(
      `${name}: its chip draws keyless coverage and its credit, a line opens its photo, closing its Context card closes it`,
      async ({ skipped }) => {
        reset();
        await park(page, at);
        await press(page, `${LAYER_ROW} [data-chip-id="sl-provider-${id}"]`);
        await uiUntil(page, litAlone, id);
        await waitForCoverage(page);
        await page.waitForFunction(
          (credit) => document.body.innerHTML.includes(credit),
          { timeout: 15_000 },
          `${name}</a> contributors`,
        );
        const area =
          box === 'column'
            ? await page.evaluate(() => {
                const { height, width } =
                  window.__godsEyeView.viewer.scene.canvas.getBoundingClientRect();
                return { x: Math.round(width * 0.3), y: 0, w: 1, h: height };
              })
            : null;
        const line = await findPickUntil(page, linePrefix, { box: area });
        if (!line && !fixtures) return skipped(`no ${name} line in view`);
        assert.ok(line, `a ${name} line in view`);
        await page.mouse.click(line.x, line.y);
        await uiUntil(
          page,
          (u) => (u.street.imageId && !u.street.loading) || u.street.error,
          null,
          90_000,
        );
        const { street } = await getUI(page);
        if (!fixtures && /No street-level imagery/.test(street.error || ''))
          return skipped(`no ${name} photo near the line`);
        assert.equal(street.error, null, `viewer error: ${street.error}`);
        assert.equal(street.providerId, id);
        await page.waitForSelector(PHOTO_VIEW, {
          visible: true,
          timeout: 10_000,
        });
        assert.ok(
          (await page.$eval(
            '#sl-viewer',
            (node) => node.getBoundingClientRect().width,
          )) > 200,
          'photo is visible in its Context card',
        );
        assert.equal(
          await page.$eval('#sl-viewer-wrap', (node) => node.hidden),
          false,
        );
        if (fixtures)
          check(street, line.id.slice(linePrefix.length).split('~')[0]);
        if (fixtures && id === 'panoramax') {
          const photo = panoramaxPictures().find(
            (item) => item.id === street.imageId,
          );
          assert.ok(photo, 'the open image is in the fixture sequence');
          const delta = photo.index + 1 < photo.count ? 1 : -1;
          const target = panoramaxPictures().find(
            (item) =>
              item.sequenceId === photo.sequenceId &&
              item.index === photo.index + delta,
          );
          assert.ok(target, 'the photo has an adjacent fixture image');
          await page.click('#sl-viewer-expand');
          await page.waitForFunction(
            () => document.fullscreenElement?.id === 'sl-viewer-wrap',
          );
          await page.click(
            delta === 1 ? '.sl-photo-step-next' : '.sl-photo-step-prev',
          );
          await uiUntil(
            page,
            (u, wanted) => u.street.imageId === wanted && !u.street.loading,
            target.id,
          );
          assert.equal(
            await page.evaluate(() => document.fullscreenElement?.id),
            'sl-viewer-wrap',
            'stepping keeps the same viewer in native fullscreen',
          );
          await page.evaluate(() => document.exitFullscreen());
          await page.waitForSelector(PHOTO_VIEW, { visible: true });
        }
        await press(page, PHOTO_CLOSE);
        await uiUntil(
          page,
          (u) => !u.street.open && u.sequence.selectedId === null,
        );
        assert.equal(
          await page.$eval('#sl-viewer-wrap', (node) => node.hidden),
          true,
        );
      },
    );
  let page = null;
  const fixture = newFixture();

  try {
    page = await open('main', fixtures && fixture);
    const { configured } = await page.evaluate(() =>
      fetch('/api/mapillary/status').then((res) => res.json()),
    );
    if (fixtures)
      assert.equal(
        configured,
        true,
        'fixture runs need a server started with MAPILLARY_CLIENT_TOKEN (CI uses a dummy one)',
      );

    await openStreetLevelRow(page);
    if (!configured && litAlone(await getUI(page), 'mapillary')) {
      // A keyed bundle behind a server without the token keeps Mapillary.
      await step('keyless server: KEY REQUIRED gates the controls', () =>
        assertKeyRequired(page),
      );
      skip('no Mapillary key', 'the keyed steps');
    } else if (!configured) {
      await step('keyless server: opens on KartaView, not KEY REQUIRED', () =>
        assertKeylessDefault(page),
      );
      await step(
        'keyless server: the MAPILLARY chip explains its key instead of switching',
        async () => {
          await press(
            page,
            `${LAYER_ROW} [data-chip-id="sl-provider-mapillary"]`,
          );
          await new Promise((resolve) => setTimeout(resolve, 500));
          assert.ok(litAlone(await getUI(page), 'kartaview'));
        },
      );
      skip('no Mapillary key', 'the keyed steps');
    } else {
      await park(page);
      await step(
        'enabling draws coverage and the Mapillary credit',
        async () => {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.setEnabled('street-level', true, {
              origin: 'user',
            }),
          );
          await waitForCoverage(page);
          await statusIs(page, 'ON');
          assert.equal((await readLayerControls(page)).filtersDisabled, false);
          await page.waitForFunction(
            () =>
              document.body.innerHTML.includes('Mapillary</a> contributors'),
            { timeout: 15_000 },
          );
        },
      );

      await fixtureStep(
        'a rejected key names its fix, gates filters and clears when switched off',
        async () => {
          fixture.rejected = true;
          await press(page, LAYER_TOGGLE);
          await statusIs(page, 'OFF');
          await press(page, LAYER_TOGGLE);
          await statusIs(page, 'KEY REJECTED');
          const shown = await readLayerControls(page);
          assert.match(shown.error, /rejected MAPILLARY_CLIENT_TOKEN/);
          assert.equal(shown.filtersDisabled, true);
          await press(page, LAYER_TOGGLE);
          await statusIs(page, 'OFF');
          assert.equal(
            (await readLayerControls(page)).error,
            '',
            'no stale error while off',
          );
          fixture.rejected = false;
          await press(page, LAYER_TOGGLE);
          await waitForCoverage(page);
          await statusIs(page, 'ON');
        },
      );

      await park(page);
      await waitForCoverage(page);
      await step(
        'a line selects its sequence and a cone opens its photo in Context',
        async () => {
          const collapsed = await page.$eval(CONTEXT_PANEL, (node) =>
            node.classList.contains('collapsed'),
          );
          if (!collapsed)
            await press(page, '[data-rail-item="global-context-panel"]');
          await page.waitForSelector(`${CONTEXT_PANEL}.collapsed`);
          // Fixtures answer lookups for the photo sequence only.
          const line = await findPickUntil(
            page,
            fixtures ? `mly:seq:${PHOTO_SEQUENCE_ID}` : 'mly:seq:',
          );
          assert.ok(line, 'a sequence line across the middle of the view');
          await page.mouse.click(line.x, line.y);
          await uiUntil(
            page,
            (u) =>
              u.sequence.selectedId &&
              !u.sequence.loading &&
              u.street.open &&
              !u.street.loading,
            null,
            90_000,
          );
          const lineImageId = (await getUI(page)).street.imageId;
          assert.ok(lineImageId, 'the line opened a photo');
          // Cones clamp to the ground: on a slow GPU (CI's SwiftShader) they
          // can take a few frames after the selection to become pickable.
          const cone = await findPickUntil(page, 'mly:img:', {
            exclude: `mly:img:${lineImageId}`,
            box: {
              x: Math.max(0, line.local.x - 150),
              y: Math.max(0, line.local.y - 150),
              w: 300,
              h: 300,
            },
            step: 8,
          });
          assert.ok(
            cone,
            'a cone for a different photo near the selected line',
          );
          const coneImageId = cone.id.slice('mly:img:'.length);
          assert.notEqual(coneImageId, lineImageId);
          await page.mouse.click(cone.x, cone.y);
          await uiUntil(
            page,
            (u, id) =>
              (u.street.imageId === id && !u.street.loading) || u.street.error,
            coneImageId,
            90_000,
          );
          const { street } = await getUI(page);
          assert.equal(street.error, null, `viewer error: ${street.error}`);
          await page.waitForSelector('#sl-viewer .mapillary-dom', {
            timeout: 60_000,
          });
          assert.equal(street.open, true);
          await page.waitForSelector(PHOTO_CARD, { visible: true });
          assert.equal(
            await page.$eval(CONTEXT_PANEL, (node) =>
              node.classList.contains('collapsed'),
            ),
            false,
            'a map photo opens Context on its card',
          );
          if (fixtures) {
            assert.ok(
              fixture.images.some((image) => image.id === street.imageId),
              `fixture photo ${street.imageId}`,
            );
            assert.equal(street.sequenceId, PHOTO_SEQUENCE_ID);
          }
          // Opening selects the photo's sequence, so its cones are drawn.
          await uiUntil(
            page,
            (u) => u.sequence.selectedId === u.street.sequenceId,
          );
        },
      );

      await step(
        'explicitly opening Street Level brings a settled photo back from Pinned',
        async () => {
          const imageId = (await getUI(page)).street.imageId;
          const pin = `${PHOTO_CARD} .entity-card__action--pin`;
          const addedPin = await page.$eval(
            pin,
            (node) => node.getAttribute('aria-pressed') !== 'true',
          );
          if (addedPin) await press(page, pin);
          const viewer = await page.$('#sl-viewer .mapillary-dom');
          assert.ok(viewer, 'the settled provider viewer remains mounted');
          const photoRequests = [];
          const watchPhoto = (request) => {
            const url = new URL(request.url());
            if (
              url.hostname === 'graph.mapillary.com' ||
              (url.hostname === THUMB_HOST &&
                url.pathname.startsWith('/thumb/'))
            )
              photoRequests.push(url.pathname);
          };
          page.on('request', watchPhoto);
          try {
            await press(page, '#context-tab-pinned');
            await page.waitForSelector(
              '#context-tab-pinned[aria-selected="true"]',
            );
            await page.waitForSelector(PHOTO_VIEW, { hidden: true });
            const result = await page.evaluate(() =>
              window.__godsEyeView.voiceCommands.runner('set_panel_open', {
                panelId: 'street-level-panel',
                open: true,
              }),
            );
            assert.equal(result.ok, true, result.error);
            assert.equal(result.panelId, 'global-context-panel');
            // The hidden viewer home also has a width and a loaded provider node.
            // Wait for the real viewer to be placed on the visible photo card.
            await page.waitForSelector(
              '#context-tab-inspect[aria-selected="true"]',
            );
            await page.waitForSelector(`${PHOTO_VIEW} #sl-viewer`, {
              visible: true,
              timeout: 30_000,
            });
            if (fixtures) {
              const capture = fixture.images.find(
                (image) => image.id === imageId,
              )?.capturedAt;
              assert.ok(
                Number.isFinite(capture),
                'the fixture photo has a capture date',
              );
              await page.waitForFunction(
                (selector, timestamp) => {
                  const date = new Intl.DateTimeFormat(
                    document.documentElement.lang || 'en',
                    {
                      year: 'numeric',
                      month: 'short',
                      day: 'numeric',
                      timeZone: 'UTC',
                    },
                  ).format(timestamp);
                  return document
                    .querySelector(selector)
                    ?.textContent.includes(date);
                },
                { timeout: 30_000 },
                `${PHOTO_CARD} .entity-card__source-line`,
                capture,
              );
            }
            const view = await page.$eval(PHOTO_VIEW, (node) => ({
              hidden: node.hidden,
              width: node.querySelector('#sl-viewer').getBoundingClientRect()
                .width,
              link: node.querySelector('#sl-image-link').href,
            }));
            assert.equal(view.hidden, false);
            assert.ok(view.width > 200, `viewer width ${view.width}`);
            assert.match(view.link, /mapillary\.com\/app\/\?pKey=/);
            assert.equal((await getUI(page)).street.imageId, imageId);
            assert.ok(
              await viewer.evaluate(
                (node) =>
                  node === document.querySelector('#sl-viewer .mapillary-dom'),
              ),
              'the same provider viewer returned',
            );
            assert.deepEqual(
              photoRequests,
              [],
              'reopening a settled photo makes no new photo lookup or fixture image request',
            );
          } finally {
            page.off('request', watchPhoto);
            await viewer.dispose();
          }
          if (addedPin) await press(page, pin);
        },
      );

      await step(
        'FIT/FILL keeps native selection, keyboard focus and persistence with a photo open',
        async () => {
          const fill = `${PHOTO_VIEW} [data-sl-render="fill"]`;
          await page.waitForSelector(fill, { visible: true });
          await page.click(fill);
          await uiUntil(page, (u) => u.street.renderMode === 'fill');
          assert.equal(
            await page.evaluate(() =>
              localStorage.getItem('gev:street-level:render-mode'),
            ),
            'fill',
          );
          await page.keyboard.press('Home');
          await uiUntil(page, (u) => u.street.renderMode === 'letterbox');
          assert.deepEqual(
            await page.$eval(
              `${PHOTO_VIEW} [data-sl-render="letterbox"]`,
              (node) => ({
                selected: node.getAttribute('aria-checked'),
                tabIndex: node.tabIndex,
                focused: document.activeElement === node,
              }),
            ),
            { selected: 'true', tabIndex: 0, focused: true },
          );
          await page.keyboard.press('End');
          await uiUntil(page, (u) => u.street.renderMode === 'fill');
        },
      );

      await step(
        'closing the Context card closes the photo and deselects its sequence',
        async () => {
          await press(page, PHOTO_CLOSE);
          await uiUntil(
            page,
            (u) => !u.street.open && u.sequence.selectedId === null,
          );
          assert.equal(
            await page.$eval('#sl-viewer-wrap', (node) => node.hidden),
            true,
          );
        },
      );

      await step(
        'panorama row segments keep arrow navigation, wrapping and focus',
        async () => {
          await page.click(`${LAYER_ROW} [data-chip-id="sl-pano-flat"]`);
          await panoIs(page, 'flat');
          await page.keyboard.press('ArrowRight');
          await panoIs(page, 'all');
          await page.keyboard.press('ArrowLeft');
          await panoIs(page, 'flat');
          await page.keyboard.press('ArrowRight');
          await panoIs(page, 'all');
          assert.equal(
            await page.$eval(
              `${LAYER_ROW} [data-chip-id="sl-pano-all"]`,
              (node) =>
                node === document.activeElement &&
                node.getAttribute('aria-checked') === 'true',
            ),
            true,
          );
          await waitForCoverage(page);
        },
      );

      await keylessProviderStep({
        id: 'kartaview',
        name: 'KartaView',
        at: PARK,
        linePrefix: 'kv:line:',
        // A row across the middle crosses the drive, west of the old street.
        box: null,
        reset: resetKartaViewFixture,
        check: (street) => {
          assert.equal(street.sequenceId, KV_SEQUENCE_ID);
          assert.ok(
            kartaViewPhotos().some((photo) => photo.id === street.imageId),
            `fixture photo ${street.imageId}`,
          );
        },
      });
      await keylessProviderStep({
        id: 'panoramax',
        name: 'Panoramax',
        at: PNX_PARK,
        linePrefix: 'pnx:seq:',
        // The street runs east-west: scan a column left of the middle.
        box: 'column',
        reset: resetPanoramaxFixture,
        check: (street, lineId) => {
          assert.equal(street.sequenceId, lineId, 'the line clicked');
          assert.ok(
            panoramaxPictures().some((photo) => photo.id === street.imageId),
            `fixture picture ${street.imageId}`,
          );
        },
      });
      // Back to Mapillary, where the next page and a reload expect it.
      await press(page, `${LAYER_ROW} [data-chip-id="sl-provider-mapillary"]`);
      await uiUntil(page, litAlone, 'mapillary');
      await park(page);

      const base = url.split('#')[0];
      await fixtureStep(
        'a link to street-level photos (sl=) opens the photo at its point once the link restores',
        async () => {
          const photo = fixture.images[0];
          // The camera sits ~330 m north of the photo: the lookup must use
          // the link's point, not the view centre.
          const cameraLat = Number((photo.lat + 0.003).toFixed(6));
          await bootLink(
            page,
            `${base}#v=2&lat=${cameraLat}&lon=${photo.lon}&alt=600&heading=0&pitch=-60&roll=0&sl=mapillary,${photo.lat},${photo.lon}`,
          );
          await uiUntil(
            page,
            (u) => (u.street.imageId && !u.street.loading) || u.street.error,
            null,
            90_000,
          );
          const { street } = await getUI(page);
          assert.equal(street.error, null, `viewer error: ${street.error}`);
          assert.equal(street.providerId, 'mapillary');
          assert.equal(
            street.imageId,
            photo.id,
            `the photo at the link's point, not the one nearest the camera: ${street.imageId}`,
          );
          assert.equal(
            await page.evaluate(() => location.hash.includes('sl=')),
            false,
            'the rewritten link no longer carries the one-shot request',
          );
        },
      );

      await fixtureStep(
        'the show_street_level action opens the nearest photo at a point without a pointer',
        async () => {
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.closeViewer(),
          );
          const photo = fixture.images[0];
          const result = await page.evaluate(
            (at) =>
              window.__godsEyeView.voiceCommands.runner('show_street_level', {
                latitude: at.lat,
                longitude: at.lon,
                provider: 'mapillary',
                fly: false,
              }),
            { lat: photo.lat, lon: photo.lon },
          );
          assert.equal(
            result.ok,
            true,
            `action failed: ${result.stage} ${result.error}`,
          );
          assert.equal(result.provider, 'mapillary');
          assert.ok(
            fixture.images.some((image) => image.id === result.imageId),
            `a fixture photo opened: ${result.imageId}`,
          );
          assert.match(result.say || '', /^Mapillary at /);
        },
      );

      await step(
        'an sl=google link never loads a photo by itself: keyless it stops at the key, keyed it arms and waits for OPEN',
        async ({ skipped }) => {
          const point = STREET_VIEW_STREET;
          // ~330 m north of the street: a flight would move the camera, and a
          // press that ignored the armed point would open something else.
          const cameraLat = Number((point.lat + 0.003).toFixed(6));
          const googleRequests = [];
          const onRequest = (request) => {
            if (STREET_VIEW_REQUEST.test(request.url()))
              googleRequests.push(request.url());
          };
          page.on('request', onRequest);
          try {
            await bootLink(
              page,
              `${base}#v=2&lat=${cameraLat}&lon=${point.lon}&alt=600&heading=0&pitch=-60&roll=0&map=osm&sl=google,${point.lat},${point.lon}`,
            );
            await page.waitForFunction(
              (want) => {
                const c =
                  window.__godsEyeView.viewer.camera.positionCartographic;
                return Math.abs((c.latitude * 180) / Math.PI - want) < 0.0005;
              },
              { timeout: 60_000 },
              cameraLat,
            );
            const googleKey = await page.evaluate(() =>
              Boolean(window.__GOOGLE_MAPS_API_KEY__),
            );
            if (!googleKey) {
              // Without a key the action stops at the key, before any flight,
              // map switch or source change, and the direct call says why.
              const direct = await page.evaluate(
                (at) =>
                  window.__godsEyeView.voiceCommands.runner(
                    'show_street_level',
                    {
                      latitude: at.lat,
                      longitude: at.lon,
                      provider: 'google',
                      fly: false,
                      autoOpen: false,
                    },
                  ),
                point,
              );
              assert.equal(direct.ok, false);
              assert.equal(
                direct.stage,
                'key',
                `${direct.stage} ${direct.error}`,
              );
              const after = await page.evaluate(() => {
                const m =
                  window.__godsEyeView.dataManager.layers.get(
                    'street-level',
                  ).module;
                const u = m.getUIState();
                return {
                  stack: window.__godsEyeView.mapStackController.getActiveId(),
                  google: m.getParams().google === true,
                  armed: u.street.armed,
                  open: u.street.open,
                };
              });
              assert.deepEqual(
                after,
                { stack: 'osm', google: false, armed: null, open: false },
                'a keyless Street View link changes nothing',
              );
              const still = await cameraAt(page);
              assert.ok(
                Math.abs(still.lat - cameraLat) < 0.0005,
                `the camera did not fly: ${still.lat}`,
              );
              assert.deepEqual(googleRequests, [], 'no Street View request');
              return;
            }
            const photoreal = await page.evaluate(() =>
              window.__godsEyeView.mapStackController.isStackAvailable(
                'photoreal',
              ),
            );
            if (!photoreal) return skipped('no Google 3D');
            await uiUntil(
              page,
              (u) =>
                u.street.armed !== null &&
                u.providers.some((p) => p.id === 'google' && p.on),
              null,
              90_000,
            );
            const waiting = await getUI(page);
            assert.equal(
              waiting.street.open,
              false,
              'nothing open without a click',
            );
            assert.equal(waiting.street.imageId, null);
            assert.deepEqual(
              waiting.street.armed.point,
              { lat: point.lat, lon: point.lon },
              'armed at the link point',
            );
            await openStreetLevelRow(page);
            const beforePress = googleRequests.length;
            assert.equal(
              beforePress,
              0,
              'no Street View request before the press',
            );
            await press(page, `${LAYER_ROW} [data-chip-id="sl-open-nearest"]`);
            await uiUntil(
              page,
              (u) => (u.street.imageId && !u.street.loading) || u.street.error,
              null,
              90_000,
            );
            const { street } = await getUI(page);
            assert.equal(street.error, null, `viewer error: ${street.error}`);
            assert.equal(street.providerId, 'google');
            assert.ok(
              googleRequests.length > beforePress,
              'the press made the Street View request',
            );
            const metres = Math.hypot(
              (street.position.lat - point.lat) * 111_320,
              (street.position.lon - point.lon) *
                111_320 *
                Math.cos((point.lat * Math.PI) / 180),
            );
            assert.ok(
              metres <= 250,
              `within 250 m of the link point: ${Math.round(metres)} m`,
            );
            // Back to Mapillary: the keyless page restores the saved layer
            // and expects its KEY REQUIRED.
            await press(
              page,
              `${LAYER_ROW} [data-chip-id="sl-provider-mapillary"]`,
            );
            await uiUntil(page, litAlone, 'mapillary');
          } finally {
            page.off('request', onRequest);
          }
        },
      );

      await fixtureStep(
        // The fixture bundle carries a token, so this covers a keyless
        // server behind a keyed bundle; the keyless default is checked above.
        'keyless server (second page): KEY REQUIRED gates the controls',
        async () => {
          const keyless = await open(
            'keyless',
            newFixture({ configured: false }),
          );
          await openStreetLevelRow(keyless);
          await assertKeyRequired(keyless);
          await collectRenderErrors(keyless, 'keyless');
          await keyless.close();
        },
      );

      await fixtureStep(
        'every Mapillary, KartaView and Panoramax request was answered from a fixture',
        () => {
          console.log(`  (answered: ${[...fixture.calls].sort().join(' | ')})`);
          assert.deepEqual(fixture.unknown, []);
        },
      );
    }

    await step('no page errors and no Cesium render-loop errors', async () => {
      await collectRenderErrors(page, 'main');
      assert.deepEqual(errors, []);
    });
    if (strict)
      await step('strict: no skips other than "fixtures only"', () =>
        assert.deepEqual(
          skips.filter((reason) => reason !== 'fixtures only'),
          [],
        ),
      );
    console.log(
      `${count} steps: ${count - skips.length} ok, ${skips.length} skipped`,
    );
  } catch (error) {
    if (fixtures)
      console.error(
        `Fixture requests at failure: ${JSON.stringify({ calls: [...fixture.calls], unknown: fixture.unknown, events: fixture.events })}`,
      );
    const dir = await saveFailureArtifacts({
      dir: process.env.QA_ARTIFACTS_DIR || 'qa-artifacts/street-level',
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
