#!/usr/bin/env node
/**
 * Data Library live gate. Run against this candidate's dev or preview server:
 *
 *   npm run qa:data-library -- --url http://localhost:4173
 *
 * Every upstream a library entry names is answered from fixtures in the
 * browser (EONET, the EIA ArcGIS pages, the GIBS tiles and the proxied
 * volcano route), so the gate is deterministic and offline apart from the
 * app itself. It drives the real panel and dialog: Browse opens a modal,
 * Add registers a layer under the Library heading and switches it on, the
 * share link carries `lib=`, a reload restores the selection, Escape and
 * clean view close the dialog, and Remove destroys the layer.
 */
import assert from 'node:assert/strict';

const { default: puppeteer } = await import('puppeteer');
const args = process.argv.slice(2);
const urlIndex = args.indexOf('--url');
const base = urlIndex >= 0 ? args[urlIndex + 1] : 'http://localhost:4173';

const point = (lon, lat, properties) => ({
  type: 'Feature',
  geometry: { type: 'Point', coordinates: [lon, lat] },
  properties,
});
const collection = (features, extra = {}) =>
  JSON.stringify({ type: 'FeatureCollection', features, ...extra });
// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

const seen = {
  eonet: 0,
  arcgisPages: [],
  tiles: 0,
  proxied: 0,
  structureBoxes: [],
};
function fixtureFor(url) {
  const cors = { 'Access-Control-Allow-Origin': '*' };
  if (url.hostname === 'eonet.gsfc.nasa.gov') {
    seen.eonet += 1;
    return {
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: collection([
        point(-120, 38, {
          title: 'Fixture Fire',
          date: '2026-10-20T00:00:00Z',
        }),
        point(140, 35, {
          title: 'Fixture Storm',
          date: '2026-10-19T00:00:00Z',
        }),
      ]),
    };
  }
  if (
    url.hostname === 'services2.arcgis.com' &&
    url.pathname.includes('USA_Structures')
  ) {
    seen.structureBoxes.push(url.searchParams.get('geometry'));
    const square = (lon, lat) => ({
      type: 'Feature',
      geometry: {
        type: 'Polygon',
        coordinates: [
          [
            [lon, lat],
            [lon + 0.0004, lat],
            [lon + 0.0004, lat + 0.0003],
            [lon, lat + 0.0003],
            [lon, lat],
          ],
        ],
      },
      properties: { OCC_CLS: 'Government', HEIGHT: 30 },
    });
    return {
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: collection([
        square(-77.035, 38.892),
        square(-77.03, 38.893),
        square(-77.025, 38.894),
      ]),
    };
  }
  if (url.hostname === 'services2.arcgis.com') {
    const offset = Number(url.searchParams.get('resultOffset'));
    seen.arcgisPages.push(offset);
    const features =
      offset === 0
        ? [
            point(-118.9, 47.9, { Plant_Name: 'Fixture Dam', Total_MW: 6809 }),
            point(-112.9, 33.4, {
              Plant_Name: 'Fixture Nuclear',
              Total_MW: 3937,
            }),
          ]
        : [point(-97.6, 28.8, { Plant_Name: 'Fixture Coast', Total_MW: 2560 })];
    return {
      status: 200,
      headers: cors,
      contentType: 'application/json',
      body: collection(features, {
        properties: { exceededTransferLimit: offset === 0 },
      }),
    };
  }
  if (url.hostname === 'gibs.earthdata.nasa.gov') {
    seen.tiles += 1;
    return { status: 200, headers: cors, contentType: 'image/png', body: PNG };
  }
  if (url.pathname === '/api/library/data/gvp-holocene-volcanoes') {
    seen.proxied += 1;
    return {
      status: 200,
      contentType: 'application/json',
      body: collection([
        point(-121.76, 46.85, { name: 'Fixture Volcano', __gevDetails: [] }),
      ]),
    };
  }
  return null;
}

const browser = await puppeteer.launch({
  headless: true,
  executablePath:
    process.env.PUPPETEER_EXECUTABLE_PATH || (await puppeteer.executablePath()),
  defaultViewport: { width: 1440, height: 900 },
  protocolTimeout: 300_000,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader'],
});
const errors = [];
let count = 0;
const step = async (label, fn) => {
  await fn();
  console.log(`ok ${++count} ${label}`);
};

async function open(page, hash = '') {
  await page.goto(`${base}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () =>
      window.__gevDataLibrary?.library.ready &&
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180_000 },
  );
}

const libraryRows = (page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('#data-toggles [data-library-entry]')].map(
      (row) => ({
        id: row.dataset.libraryEntry,
        on: row.querySelector('.data-toggle-btn')?.classList.contains('active'),
        count: row.querySelector('.data-count')?.textContent,
      }),
    ),
  );

try {
  const page = await browser.newPage();
  page.on('console', (message) => {
    if (message.type() === 'error' && /Library|library/.test(message.text()))
      errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const fixture = fixtureFor(new URL(request.url()));
    if (fixture) request.respond(fixture);
    else request.continue();
  });
  await page.evaluateOnNewDocument(() => {
    try {
      // Start empty once; the reload step needs what this run stored.
      if (!sessionStorage.getItem('qa-data-library')) {
        localStorage.removeItem('gev:library:v1');
        sessionStorage.setItem('qa-data-library', '1');
      }
      // Skip the first-run chooser (src/firstRunExperience.js).
      localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    } catch {
      /* storage may be blocked; the gate still runs */
    }
  });
  await open(page);

  await step(
    'the panel offers Browse and lists no library layer by default',
    async () => {
      assert.deepEqual(await libraryRows(page), []);
      const hidden = await page.$eval(
        '#data-library-browse',
        (node) => node.hidden,
      );
      assert.equal(hidden, false);
    },
  );

  await step(
    'Browse opens a labelled modal with addable entries first and packs last',
    async () => {
      await page.evaluate(() => {
        document.getElementById('data-panel')?.classList.remove('collapsed');
        document.getElementById('data-library-browse').click();
      });
      const dialog = await page.$eval('#data-library', (node) => ({
        open: node.open,
        modal: node.matches(':modal'),
        title: document.getElementById(node.getAttribute('aria-labelledby'))
          ?.textContent,
        focus: document.activeElement?.type,
        order: [...node.querySelectorAll('.data-library-item')].map(
          (item) => item.dataset.libraryId,
        ),
      }));
      assert.equal(dialog.open, true);
      assert.equal(dialog.modal, true);
      assert.equal(dialog.title, 'DATA LIBRARY');
      assert.equal(dialog.focus, 'search');
      assert.ok(dialog.order.at(-1).startsWith('cctv-'), dialog.order.join());
      assert.ok(!dialog.order[0].startsWith('cctv-'));
    },
  );

  await step(
    'a pack explains the operator switch instead of offering Add',
    async () => {
      const pack = await page.$eval(
        '#data-library .data-library-item[data-library-id="cctv-nyc-dot"]',
        (item) => ({
          action: Boolean(item.querySelector('.data-library-action')),
          reason: item.querySelector('.data-library-reason')?.textContent,
        }),
      );
      assert.equal(pack.action, false);
      assert.match(pack.reason, /CCTV_NYC_ENABLED=1/);
    },
  );

  for (const [id, expected] of [
    ['nasa-eonet-events', '2'],
    ['eia-power-plants', '3'],
    ['gvp-holocene-volcanoes', '1'],
    ['nasa-black-marble', 'DRAPED'],
  ])
    await step(
      `Add ${id} registers it under Library and switches it on`,
      async () => {
        await page.click(
          `#data-library button[data-library-id="${id}"][data-library-action="add"]`,
        );
        await page.waitForFunction(
          (layerId, text) => {
            const row = document.querySelector(
              `#data-toggles [data-layer-id="${layerId}"]`,
            );
            return (
              row
                ?.querySelector('.data-toggle-btn')
                ?.classList.contains('active') &&
              row.querySelector('.data-count')?.textContent === text
            );
          },
          { timeout: 60_000 },
          `lib-${id}`,
          expected,
        );
      },
    );

  await step(
    'the fixtures were reached the way each manifest says',
    async () => {
      assert.ok(seen.eonet >= 1);
      assert.deepEqual(seen.arcgisPages.slice(0, 2), [0, 2]);
      assert.ok(seen.proxied >= 1);
      const draped = await page.evaluate(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('lib-nasa-black-marble')
            .module.getDiagnostics().draped,
      );
      assert.equal(draped, true);
      // Imagery requests tiles on the following frames, not on enable.
      for (let waited = 0; seen.tiles === 0 && waited < 30_000; waited += 250)
        await new Promise((resolve) => setTimeout(resolve, 250));
      assert.ok(seen.tiles >= 1, 'the drape requested its tiles');
      const headings = await page.$$eval(
        '#data-toggles .data-layer-group-heading',
        (nodes) => nodes.map((node) => node.textContent),
      );
      assert.equal(headings.at(-1), 'Library');
    },
  );

  await step(
    'the stats strip sits above the intro and counts what is on the map',
    async () => {
      await page.waitForFunction(
        () =>
          document.querySelector(
            '[data-stat="features"] .data-library-stat-value',
          )?.textContent === '6',
        { timeout: 15_000 },
      );
      const strip = await page.evaluate(() => {
        const stats = document.querySelector(
          '#data-library .data-library-stats',
        );
        const read = (id) =>
          [...document.querySelectorAll(`[data-stat="${id}"] dd`)].map(
            (node) => node.textContent,
          );
        return {
          beforeIntro:
            stats?.nextElementSibling?.classList.contains('data-library-intro'),
          label: stats?.getAttribute('aria-label'),
          entries: read('entries'),
          added: read('added'),
          features: read('features'),
        };
      });
      assert.equal(strip.beforeIntro, true);
      assert.equal(strip.label, 'Data Library at a glance');
      // Counted from the shipped catalog, so a new entry does not break this.
      const kinds = await page.evaluate(() => {
        const counts = { dataset: 0, tiles: 0, pack: 0 };
        for (const { entry } of window.__gevDataLibrary.library.list())
          counts[entry.kind] += 1;
        return counts;
      });
      assert.deepEqual(strip.entries, [
        String(kinds.dataset + kinds.tiles + kinds.pack),
        `${kinds.dataset} datasets · ${kinds.tiles} tile layers · ${kinds.pack} packs`,
      ]);
      assert.deepEqual(strip.added, ['4', '4 on the map']);
      // Fixtures: 2 EONET events, 3 power plants, 1 volcano.
      assert.deepEqual(strip.features, ['6', 'from 3 datasets']);
    },
  );

  await step('the share link carries lib= with the ledger tokens', async () => {
    await page.waitForFunction(
      () => /(?:^|&)lib=00\.02\.01\.03(?:&|$)/.test(location.hash.slice(1)),
      { timeout: 15_000 },
    );
  });

  await step(
    'Escape closes the dialog and returns focus to Browse',
    async () => {
      await page.focus('#data-library input[type="search"]');
      await page.keyboard.press('Escape');
      const state = await page.evaluate(() => ({
        open: document.getElementById('data-library').open,
        focus: document.activeElement?.id,
      }));
      assert.deepEqual(state, { open: false, focus: 'data-library-browse' });
    },
  );

  await step('clean view closes an open dialog', async () => {
    const open = await page.evaluate(async () => {
      window.__gevDataLibrary.browser.open();
      document.body.classList.add('ui-clean-view');
      await new Promise((resolve) => setTimeout(resolve, 50));
      const result = document.getElementById('data-library').open;
      document.body.classList.remove('ui-clean-view');
      return result;
    });
    assert.equal(open, false);
  });

  await step(
    'a reload restores the added entries and what was on',
    async () => {
      await page.evaluate(() => {
        document
          .querySelector(
            '#data-toggles [data-layer-id="lib-gvp-holocene-volcanoes"] .data-toggle-btn',
          )
          .click();
      });
      await page.waitForFunction(
        () =>
          JSON.parse(localStorage.getItem('gev:library:v1')).on.length === 3,
      );
      await open(page, '');
      await page.waitForFunction(
        () =>
          document.querySelectorAll('#data-toggles [data-library-entry]')
            .length === 4,
        { timeout: 60_000 },
      );
      const rows = await libraryRows(page);
      assert.deepEqual(rows.map(({ id, on }) => [id, on]).sort(), [
        ['eia-power-plants', true],
        ['gvp-holocene-volcanoes', false],
        ['nasa-black-marble', true],
        ['nasa-eonet-events', true],
      ]);
    },
  );

  const cameraCenter = () =>
    page.evaluate(() => {
      const { camera } = window.__godsEyeView.viewer;
      const carto = camera.positionCartographic;
      return {
        lon: (carto.longitude * 180) / Math.PI,
        lat: (carto.latitude * 180) / Math.PI,
        height: carto.height,
      };
    });
  const waitForFlight = () =>
    page.waitForFunction(
      () => !window.__godsEyeView.viewer.camera._currentFlight,
      { timeout: 30_000, polling: 200 },
    );

  await step(
    'Zoom to layer on the row works while off: it switches on and flies',
    async () => {
      const chip =
        '#data-toggles [data-layer-id="lib-eia-power-plants"] [data-chip-id="zoom"]';
      await page.evaluate(() =>
        document.getElementById('data-panel')?.classList.remove('collapsed'),
      );
      // The icons work while the layer is off; Zoom switches it back on.
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled(
          'lib-eia-power-plants',
          false,
          { origin: 'user' },
        ),
      );
      await page.waitForSelector(chip, { visible: true, timeout: 30_000 });
      await page.evaluate(
        (selector) => document.querySelector(selector).click(),
        chip,
      );
      await page.waitForFunction(
        () =>
          window.__godsEyeView.dataManager.isEnabled('lib-eia-power-plants'),
        { timeout: 30_000 },
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await waitForFlight();
      const center = await cameraCenter();
      // Fixture plants span -118.9…-97.6 °E and 28.8…47.9 °N.
      assert.ok(center.lon > -125 && center.lon < -90, JSON.stringify(center));
      assert.ok(center.lat > 22 && center.lat < 55, JSON.stringify(center));
    },
  );

  await step(
    'ZOOM in the dialog closes it and flies to that entry',
    async () => {
      await page.evaluate(() => window.__gevDataLibrary.browser.open());
      const zoom =
        '#data-library button[data-library-id="gvp-holocene-volcanoes"][data-library-action="zoom"]';
      assert.ok(await page.$(zoom), 'Zoom is offered for an entry that is off');
      await page.click(
        '#data-library button[data-library-id="nasa-eonet-events"][data-library-action="zoom"]',
      );
      const open = await page.$eval('#data-library', (node) => node.open);
      assert.equal(open, false);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await waitForFlight();
      const center = await cameraCenter();
      // Fixture events at (-120, 38) and (140, 35): the frame sits between them.
      assert.ok(center.lat > 20 && center.lat < 55, JSON.stringify(center));
    },
  );

  await step('Remove destroys the layer and forgets it', async () => {
    await page.evaluate(() => window.__gevDataLibrary.browser.open());
    await page.click(
      '#data-library button[data-library-id="nasa-black-marble"][data-library-action="remove"]',
    );
    await page.waitForFunction(
      () =>
        !document.querySelector(
          '#data-toggles [data-layer-id="lib-nasa-black-marble"]',
        ) &&
        !window.__godsEyeView.dataManager.layers.has('lib-nasa-black-marble'),
      { timeout: 30_000 },
    );
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gev:library:v1')),
    );
    assert.equal(stored.added.includes('nasa-black-marble'), false);
  });

  await step(
    'the row delete icon removes that entry, even while it is off',
    async () => {
      await page.evaluate(() => {
        window.__gevDataLibrary.browser.close();
        document.getElementById('data-panel')?.classList.remove('collapsed');
      });
      const chip =
        '#data-toggles [data-layer-id="lib-eia-power-plants"] [data-chip-id="remove"]';
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled(
          'lib-eia-power-plants',
          false,
          { origin: 'user' },
        ),
      );
      await page.waitForSelector(chip, { visible: true, timeout: 30_000 });
      const label = await page.$eval(chip, (node) => ({
        name: node.getAttribute('aria-label'),
        glyph: node.textContent,
        pressed: node.getAttribute('aria-pressed'),
      }));
      assert.deepEqual(label, {
        name: 'Remove from Data Layers',
        glyph: 'delete',
        pressed: null,
      });
      await page.evaluate(
        (selector) => document.querySelector(selector).click(),
        chip,
      );
      await page.waitForFunction(
        () =>
          !window.__godsEyeView.dataManager.layers.has(
            'lib-eia-power-plants',
          ) &&
          !document.querySelector(
            '#data-toggles [data-layer-id="lib-eia-power-plants"]',
          ),
        { timeout: 30_000 },
      );
    },
  );

  await step(
    'a view-bounded layer asks to zoom in, then loads only what is in view',
    async () => {
      await page.evaluate(() =>
        window.__gevDataLibrary.library.add('fema-usa-structures'),
      );
      const row = '#data-toggles [data-layer-id="lib-fema-usa-structures"]';
      await page.waitForFunction(
        (selector) =>
          /zoom in to load this layer/.test(
            document.querySelector(`${selector} .data-toggle-meta`)
              ?.textContent || '',
          ),
        { timeout: 30_000 },
        row,
      );
      assert.equal(seen.structureBoxes.length, 0, 'nothing loads from orbit');
      await page.evaluate(() =>
        window.__gevDataLibrary.library.zoom('fema-usa-structures'),
      );
      await page.waitForFunction(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('lib-fema-usa-structures')
            .module.getDiagnostics().count === 3,
        { timeout: 60_000, polling: 250 },
      );
      const altitude = (await cameraCenter()).height;
      assert.ok(altitude <= 4000, `landed at ${Math.round(altitude)} m`);
      const [west, south, east, north] = seen.structureBoxes
        .at(-1)
        .split(',')
        .map(Number);
      assert.ok(east - west < 0.2 && north - south < 0.2, 'a view-sized box');
      assert.ok(
        west < -77.03 && east > -77.03 && south < 38.893 && north > 38.893,
      );
      // Climbing back out clears the buildings and shows the guidance again.
      await page.evaluate(() => {
        const { viewer, requestRender } = window.__godsEyeView;
        viewer.camera.zoomOut(60_000);
        requestRender?.('qa-data-library');
      });
      await page.waitForFunction(
        () =>
          window.__godsEyeView.dataManager.layers
            .get('lib-fema-usa-structures')
            .module.getDiagnostics().tooHigh,
        { timeout: 30_000, polling: 250 },
      );
    },
  );

  await step('Remove all asks twice, then clears the library', async () => {
    await page.evaluate(() => window.__gevDataLibrary.browser.open());
    await page.click('#data-library .data-library-reset');
    const armed = await page.$eval(
      '#data-library .data-library-reset',
      (node) => ({
        text: node.textContent,
        armed: node.classList.contains('is-armed'),
      }),
    );
    assert.equal(armed.armed, true);
    assert.match(armed.text, /CONFIRM/);
    assert.ok(
      (await page.$$('#data-toggles [data-library-entry]')).length > 0,
      'one press removes nothing',
    );
    await page.click('#data-library .data-library-reset');
    await page.waitForFunction(
      () =>
        !document.querySelector('#data-toggles [data-library-entry]') &&
        document.querySelector('#data-library .data-library-reset').hidden,
      { timeout: 30_000 },
    );
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('gev:library:v1')),
    );
    assert.deepEqual(stored, { added: [], on: [] });
  });

  const onIds = (target) =>
    target.evaluate(() =>
      window.__gevDataLibrary.library
        .list()
        .filter((row) => row.on)
        .map((row) => row.entry.id)
        .sort(),
    );

  await step(
    'a copied /share link opens the same library layers in a clean browser',
    async () => {
      await page.evaluate(async () => {
        const { library } = window.__gevDataLibrary;
        await library.add('nasa-eonet-events');
        await library.add('nasa-black-marble');
      });
      await page.waitForFunction(
        () => /(?:^|&)lib=00\.03(?:&|$)/.test(location.hash.slice(1)),
        { timeout: 15_000 },
      );
      const href = await page.evaluate(() =>
        window.__gevDataLibrary.buildShareLink(),
      );
      assert.match(new URL(href).pathname, /\/share\//);
      // A separate profile: nothing stored, nothing added.
      const context = await browser.createBrowserContext();
      try {
        const recipient = await context.newPage();
        await recipient.setRequestInterception(true);
        recipient.on('request', (request) => {
          const fixture = fixtureFor(new URL(request.url()));
          if (fixture) request.respond(fixture);
          else request.continue();
        });
        await recipient.evaluateOnNewDocument(() => {
          try {
            localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
          } catch {
            /* the gate still runs */
          }
        });
        await recipient.goto(href, { waitUntil: 'domcontentloaded' });
        await recipient.waitForFunction(
          () => window.__gevDataLibrary?.library.ready,
          { timeout: 180_000 },
        );
        await recipient.waitForFunction(
          () =>
            window.__gevDataLibrary.library.list().filter((row) => row.on)
              .length === 2,
          { timeout: 60_000 },
        );
        assert.deepEqual(await onIds(recipient), [
          'nasa-black-marble',
          'nasa-eonet-events',
        ]);
      } finally {
        await context.close();
      }
    },
  );

  await step(
    'a share opened in the same tab switches library layers on and off',
    async () => {
      const navigate = (lib) =>
        page.evaluate((value) => {
          const params = new URLSearchParams(location.hash.slice(1));
          params.set('lat', String(Number(params.get('lat')) + 1));
          if (value === null) params.delete('lib');
          else params.set('lib', value);
          location.hash = params.toString();
        }, lib);
      await navigate('00');
      await page.waitForFunction(
        () => {
          const on = window.__gevDataLibrary.library
            .list()
            .filter((row) => row.on)
            .map((row) => row.entry.id);
          return on.length === 1 && on[0] === 'nasa-eonet-events';
        },
        { timeout: 30_000 },
      );
      // A share with every library layer off: the added ones stay listed, off.
      await navigate(null);
      await page.waitForFunction(
        () => window.__gevDataLibrary.library.list().every((row) => !row.on),
        { timeout: 30_000 },
      );
      assert.deepEqual(
        (await libraryRows(page)).map(({ id, on }) => [id, on]).sort(),
        [
          ['nasa-black-marble', false],
          ['nasa-eonet-events', false],
        ],
      );
    },
  );

  assert.deepEqual(errors, [], 'no library errors on the page');
  console.log(`# ${count} passed`);
} finally {
  await browser.close();
}
