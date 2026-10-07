#!/usr/bin/env node
/**
 * Browser QA for the Street Level layer against a running server:
 * `npm run qa:street-level -- --url http://localhost:4173`.
 *
 * `--fixtures` (CI) answers every *.mapillary.com request and the coverage
 * tile route from fixtures, so nothing reaches Mapillary; the server still
 * needs a (dummy) token because the bundle carries it. `--strict` fails on any
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
  photoImages,
} from './fixtures/street-level/mapillaryGraph.mjs';

const VIEWPORT = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
/** Over downtown Sacramento, above the fixture photo line, looking down. */
const PARK = { lon: PHOTO_LINE.lon, lat: 38.5816, height: 900, pitch: -1.3 };
const DAY_MS = 86_400_000;

/**
 * Coverage for any street-zoom tile: a grid of 360°/flat, recent/old
 * sequences, plus the photo sequence where PHOTO_LINE crosses the tile.
 * @returns {Uint8Array} empty below z11, which the layer never asks for
 */
export function fixtureTile(z, x, y, now = Date.now()) {
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

/**
 * Answer the page's Mapillary requests from `fixture`, which steps may change
 * mid-run. `configured: undefined` lets the server's real status route answer.
 */
async function serveFixtures(page, fixture) {
  // CDP Fetch on just these URLs: page-wide interception stalls Cesium workers.
  const cdp = await page.createCDPSession();
  await cdp.send('Fetch.enable', {
    patterns: [
      { urlPattern: '*://*.mapillary.com/*' },
      { urlPattern: '*/api/mapillary/*' },
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
    const answer = answerFor(request.method, new URL(request.url));
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
    done.catch(() => {});
  });
}

function newFixture(overrides = {}) {
  return {
    configured: undefined,
    rejected: false,
    images: photoImages(),
    calls: new Set(),
    unknown: [],
    ...overrides,
  };
}

/** Load the app and dismiss the first-run dialog. */
async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.dataManager), {
    timeout: 150_000,
  });
  await page.evaluate(() =>
    document.querySelector('.first-run-explore')?.click(),
  );
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(
      '#first-run-launcher, [class*=first-run]',
    ))
      el.remove();
  });
}

/** Run `test(uiState, arg)` in the page until it is true. */
const uiUntil = (page, test, arg = null, timeout = 30_000) =>
  page.waitForFunction(
    `(${test})(window.__godsEyeView.dataManager.layers.get('street-level').module.getUIState(), ${JSON.stringify(arg)})`,
    { timeout, polling: 100 },
  );

const getUI = (page) =>
  page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('street-level')
      .module.getUIState(),
  );

const statusIs = (page, text) =>
  page.waitForFunction(
    (want) => document.getElementById('sl-status').textContent === want,
    { timeout: 30_000 },
    text,
  );

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

/** Expand the strip; a panel state stored by an earlier page may have done so. */
async function expandPanel(page) {
  const collapsed = await page.$eval('#street-level-panel', (node) =>
    node.classList.contains('collapsed'),
  );
  if (collapsed)
    await press(
      page,
      '.panel-collapse-btn[data-collapse-target="street-level-panel"]',
    );
  await page.waitForFunction(
    () =>
      getComputedStyle(document.getElementById('sl-body')).display === 'flex',
    { timeout: 10_000 },
  );
}

async function assertKeyRequired(page) {
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('street-level', true, {
      origin: 'user',
    }),
  );
  await statusIs(page, 'KEY REQUIRED');
  const shown = await page.evaluate(() => ({
    disabled: document.getElementById('sl-controls').disabled,
    hint: document.getElementById('sl-error').hidden
      ? ''
      : document.getElementById('sl-error').textContent,
  }));
  assert.equal(shown.disabled, true, 'controls are gated');
  assert.match(shown.hint, /MAPILLARY_CLIENT_TOKEN/, 'names the key to add');
}

/** Park the camera over the photo line; a late startup flight can move it. */
async function park(page) {
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
    }, PARK);
    if (stayed) return;
  }
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
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
  });
  let count = 0;
  const skips = [];
  const step = async (label, fn) => {
    await fn();
    console.log(`ok ${++count} ${label}`);
  };
  const skip = (reason, label) => {
    skips.push(reason);
    console.log(`skip (${reason}) ${++count} ${label}`);
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
    return page;
  };
  const collectRenderErrors = async (page, name) =>
    errors.push(
      ...(await readRenderErrors(page)).map(
        (text) => `[${name}] scene.renderError: ${text}`,
      ),
    );

  try {
    const fixture = newFixture();
    const page = await open('main', fixtures && fixture);
    const { configured } = await page.evaluate(() =>
      fetch('/api/mapillary/status').then((res) => res.json()),
    );
    if (fixtures)
      assert.equal(
        configured,
        true,
        'fixture runs need a server started with MAPILLARY_CLIENT_TOKEN (CI uses a dummy one)',
      );

    await step('the panel starts as a collapsed right-rail strip', async () => {
      const box = await page.evaluate(() => {
        const panel = document.getElementById('street-level-panel');
        const r = panel.getBoundingClientRect();
        return {
          collapsed: panel.classList.contains('collapsed'),
          inRail: panel.parentElement.id === 'right-context-rail',
          body: getComputedStyle(document.getElementById('sl-body')).display,
          width: r.width,
          right: r.right,
        };
      });
      assert.equal(box.collapsed, true);
      assert.equal(box.inRail, true);
      assert.equal(box.body, 'none');
      assert.ok(box.width <= 200 && box.right <= VIEWPORT.width);
    });

    await step('expanding the strip shows the body and legend', async () => {
      await expandPanel(page);
      assert.equal(
        await page.$$eval('#sl-legend li', (items) => items.length),
        2,
        'Mapillary and Selected',
      );
    });

    if (!configured) {
      await step('keyless server: KEY REQUIRED gates the controls', () =>
        assertKeyRequired(page),
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
          assert.equal(
            await page.$eval('#sl-controls', (node) => node.disabled),
            false,
          );
          await page.waitForFunction(
            () =>
              document.body.innerHTML.includes('Mapillary</a> contributors'),
            { timeout: 15_000 },
          );
        },
      );

      await step('the header pill switches the layer off and on', async () => {
        await press(page, '#sl-status');
        await statusIs(page, 'OFF');
        assert.equal(
          await page.evaluate(() =>
            window.__godsEyeView.dataManager.isEnabled('street-level'),
          ),
          false,
        );
        assert.equal((await getUI(page)).coverage.count, 0);
        await press(page, '#sl-status');
        await waitForCoverage(page);
        await statusIs(page, 'ON');
      });

      await step('the 360° filter narrows coverage', async () => {
        const before = (await getUI(page)).coverage.count;
        await press(page, '[data-sl-pano="pano"]');
        await uiUntil(
          page,
          (u) => u.filter.pano === 'pano' && !u.coverage.loading,
        );
        const after = (await getUI(page)).coverage.count;
        // Fixtures hold flat sequences too, so the filter must drop some.
        assert.ok(
          fixtures ? after < before : after <= before,
          `${after} vs ${before}`,
        );
        await press(page, '[data-sl-pano="all"]');
        await uiUntil(
          page,
          (u, n) => u.filter.pano === 'all' && u.coverage.count === n,
          before,
        );
      });

      await step(
        'the SINCE slider narrows coverage and names its cut-off',
        async () => {
          const before = (await getUI(page)).coverage.count;
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
          await uiUntil(
            page,
            (u) => u.filter.sinceDays === 365 && !u.coverage.loading,
          );
          const after = (await getUI(page)).coverage.count;
          assert.ok(
            fixtures ? after < before : after <= before,
            `${after} vs ${before}`,
          );
          assert.match(
            await page.$eval('#sl-since-label', (node) => node.textContent),
            /^LAST YEAR · SINCE \d{4}-\d{2}-\d{2}$/,
          );
          await setStop(0);
          await uiUntil(
            page,
            (u, n) => u.filter.sinceDays === 0 && u.coverage.count === n,
            before,
          );
        },
      );

      await fixtureStep(
        'a rejected key reads KEY REJECTED and clears when switched off',
        async () => {
          fixture.rejected = true;
          await press(page, '#sl-status');
          await statusIs(page, 'OFF');
          await press(page, '#sl-status');
          await statusIs(page, 'KEY REJECTED');
          const shown = await page.evaluate(() => ({
            error: document.getElementById('sl-error').textContent,
            hidden: document.getElementById('sl-error').hidden,
            disabled: document.getElementById('sl-controls').disabled,
          }));
          assert.match(shown.error, /rejected MAPILLARY_CLIENT_TOKEN/);
          assert.equal(shown.hidden, false);
          assert.equal(shown.disabled, true);
          await press(page, '#sl-status');
          await statusIs(page, 'OFF');
          assert.equal(
            await page.$eval(
              '#sl-error',
              (node) => node.hidden || !node.textContent,
            ),
            true,
            'no stale error while off',
          );
          fixture.rejected = false;
          await press(page, '#sl-status');
          await waitForCoverage(page);
          await statusIs(page, 'ON');
        },
      );

      let imageId = null;
      await park(page);
      await waitForCoverage(page);
      await step(
        'the viewer loads and the nearest photo opens with a caption',
        async () => {
          await page.evaluate(() => {
            // Fire and forget: the open can outlive one CDP call.
            void window.__godsEyeView.dataManager.layers
              .get('street-level')
              .module.openNearest();
          });
          await uiUntil(
            page,
            (u) => (u.street.imageId && !u.street.loading) || u.street.error,
            null,
            90_000,
          );
          const { street } = await getUI(page);
          assert.equal(street.error, null, `viewer error: ${street.error}`);
          imageId = street.imageId;
          await page.waitForSelector('#sl-viewer .mapillary-dom', {
            timeout: 60_000,
          });
          await page.waitForFunction(
            () =>
              document.getElementById('sl-image-when').textContent.trim()
                .length > 0,
            { timeout: 30_000 },
          );
          const view = await page.evaluate(() => ({
            hidden: document.getElementById('sl-viewer-wrap').hidden,
            width: document.getElementById('sl-viewer').getBoundingClientRect()
              .width,
            link: document.getElementById('sl-image-link').href,
          }));
          assert.equal(view.hidden, false);
          assert.ok(view.width > 200, `viewer width ${view.width}`);
          assert.match(view.link, /mapillary\.com\/app\/\?pKey=/);
          if (fixtures) {
            assert.ok(
              fixture.images.some((image) => image.id === imageId),
              `fixture photo ${imageId}`,
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

      await step('× closes the photo and deselects its sequence', async () => {
        await press(page, '#sl-viewer-close');
        await uiUntil(
          page,
          (u) => !u.street.open && u.sequence.selectedId === null,
        );
        assert.equal(
          await page.$eval('#sl-viewer-wrap', (node) => node.hidden),
          true,
        );
      });

      await step('on a phone the whole photo fits in the panel', async () => {
        // Width alone drives the phone layout; toggling isMobile would reload.
        await page.setViewport(PHONE);
        await page.waitForFunction((w) => innerWidth === w, {}, PHONE.width);
        await expandPanel(page);
        await page.evaluate((id) => {
          void window.__godsEyeView.dataManager.layers
            .get('street-level')
            .module.openImage(id);
        }, imageId);
        await uiUntil(
          page,
          (u, id) => u.street.imageId === id && !u.street.loading,
          imageId,
          60_000,
        );
        // The panel settles its phone layout over a frame or two.
        const fits = () => {
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
            height: Math.round(viewer.height),
            overflowX: document.documentElement.scrollWidth > innerWidth,
          };
        };
        await page
          .waitForFunction(
            `(${fits})().cut <= 1 && (${fits})().height >= 100`,
            { timeout: 10_000 },
          )
          .catch(() => {});
        const fit = await page.evaluate(fits);
        assert.ok(fit.cut <= 1, `photo and caption fit (${fit.cut}px cut)`);
        assert.ok(fit.height >= 100, `viewer stays usable (${fit.height}px)`);
        assert.equal(fit.overflowX, false, 'no sideways scroll');
        await page.setViewport(VIEWPORT);
      });

      await fixtureStep(
        'keyless server (second page): KEY REQUIRED gates the controls',
        async () => {
          const keyless = await open(
            'keyless',
            newFixture({ configured: false }),
          );
          await expandPanel(keyless);
          await assertKeyRequired(keyless);
          await collectRenderErrors(keyless, 'keyless');
          await keyless.close();
        },
      );

      await fixtureStep(
        'every Mapillary request was answered from a fixture',
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
    const dir = await saveFailureArtifacts({
      dir: 'qa-artifacts/street-level',
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
