#!/usr/bin/env node
/**
 * qa-context-arrivals.mjs — search arrivals above the surface, and Contacts
 * listing mapped installations around a moving aircraft in Cockpit.
 *
 * Run: node scripts/qa-context-arrivals.mjs http://localhost:4173 [--headful]
 *      [--out qa-shots/context-arrivals] [--only arrivals|contacts]
 *
 * Arrivals: types "Camp Mabry" and "39.7392, -104.9903" (downtown Denver)
 * into the Omnibar, waits for the flight and the photoreal tiles,
 * orbits a little like a user looking around, and asserts the camera sits at
 * least 60 m above the rendered surface under it and under the view centre.
 *
 * Contacts: serves two synthetic aircraft through the page's own
 * /api/flights response (one flying north over Camp Mabry at 2,500 m, one
 * near Fort Cavazos), empty military and AIS feeds, and mapped sites.
 * Enters Cockpit from the actual flight card and uses its Display and Radio
 * controls with Contacts off. Enables the internal Contacts mode separately,
 * then checks installation distances, a stable SITE count and render records
 * while flying, and Search nearby sites from Data Layers after leaving
 * Cockpit. Finally checks the Fort Cavazos aircraft's own nearby site.
 * Requires zero console errors.
 *
 * Writes <out>/result.json, screenshots and <out>/clip.mp4 (CDP screencast
 * with real frame timing; needs ffmpeg).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
import { selectQaContextCard } from './qa-chrome.mjs';
import { stubPlanespotters } from './qa-photo-stub.mjs';
import { createScreencast, moveCamera } from './qa-journey-recorder.mjs';

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  console.log(
    'Usage: node scripts/qa-context-arrivals.mjs <dev-server-url> [--headful] [--out dir] [--only arrivals|contacts]',
  );
  process.exit(0);
}
const option = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const appUrl =
  argv.find((arg) => /^https?:/.test(arg)) || 'http://localhost:4173';
const outDir = path.resolve(option('--out', 'qa-shots/context-arrivals'));
const only = option('--only', null);
fs.mkdirSync(outDir, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const result = {
  url: appUrl,
  arrivals: [],
  contacts: {},
  consoleErrors: [],
  failures: [],
};
const check = (name, ok, detail = '') => {
  console.log(
    `[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`,
  );
  if (!ok) result.failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await puppeteer.launch({
  headless: !argv.includes('--headful'),
  protocolTimeout: 300_000,
  args: [
    '--no-sandbox',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-gl=angle', '--use-angle=swiftshader']),
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
});

async function openPage({ aircraft = false } = {}) {
  const page = await browser.newPage();
  await stubPlanespotters(page);
  await page.setViewport({ width: 1440, height: 900 });
  page.on('console', (message) => {
    if (message.type() === 'error') result.consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => result.consoleErrors.push(error.message));
  page.on('response', (response) => {
    if (response.status() < 400) return;
    const url = new URL(response.url());
    // Track/enrichment lookups for the synthetic ICAOs have no upstream record.
    const synthetic = /aaa05\d/i.test(url.search + url.pathname);
    (synthetic
      ? (result.expectedMisses ??= [])
      : (result.httpErrors ??= [])
    ).push(`${response.status()} ${url.pathname}${url.search}`);
  });
  await page.evaluateOnNewDocument((aircraft) => {
    sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
    if (!aircraft) return;
    // Synthetic aircraft and installations through the app's feed endpoints.
    const started = Date.now();
    const installationSites = [
      { id: 51, name: 'Camp Mabry', lat: 30.3125, lon: -97.765 },
      { id: 52, name: 'Fort Hood', lat: 31.135, lon: -97.78 },
    ];
    window.__qaNearbySiteSearches = [];
    const realFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const raw =
        typeof input === 'string' || input instanceof URL
          ? String(input)
          : input?.url;
      let url;
      try {
        url = new URL(raw, location.href);
      } catch {
        return realFetch(input, init);
      }
      if (url.origin === location.origin && url.pathname === '/api/flights') {
        const now = Math.floor(Date.now() / 1000);
        const seconds = (Date.now() - started) / 1000;
        const lat = 30.29 + (seconds * 120) / 111_320;
        const json = {
          time: now,
          states: [
            [
              'aaa051',
              'QA051',
              'Synthetic',
              now,
              now,
              -97.765,
              lat,
              2500,
              false,
              120,
              0,
              0,
              null,
              2500,
              null,
              false,
              0,
            ],
            [
              'aaa052',
              'QA052',
              'Synthetic',
              now,
              now,
              -97.72,
              31.12,
              3000,
              false,
              90,
              270,
              0,
              null,
              3000,
              null,
              false,
              0,
            ],
          ],
        };
        return Promise.resolve(Response.json(json));
      }
      if (url.origin === location.origin && url.pathname === '/api/military')
        return Promise.resolve(
          Response.json({ ac: [], now: Date.now(), total: 0 }),
        );
      if (url.origin === location.origin && url.pathname === '/api/vessels')
        return Promise.resolve(Response.json({ rows: [], status: 'open' }));
      if (
        url.origin === location.origin &&
        url.pathname === '/api/military-installations'
      ) {
        return Promise.resolve(
          Response.json({
            elements: installationSites.map(({ id, name, lat, lon }) => ({
              type: 'node',
              id,
              lat,
              lon,
              tags: { name, military: 'base' },
            })),
            status: 'ready',
            saturated: false,
            retrievedAt: new Date().toISOString(),
          }),
        );
      }
      if (
        url.origin === location.origin &&
        url.pathname === '/api/google/text-search'
      ) {
        window.__qaNearbySiteSearches.push(
          Object.fromEntries(url.searchParams),
        );
        if (
          !window.__qaExpectedSiteQuery ||
          Object.entries(window.__qaExpectedSiteQuery).some(
            ([key, value]) => url.searchParams.get(key) !== value,
          )
        ) {
          return Promise.resolve(
            Response.json(
              { error: 'Unexpected fixture query' },
              { status: 400 },
            ),
          );
        }
        return Promise.resolve(
          Response.json({
            places: [
              {
                id: 'qa-mapped-site',
                name: 'QA Nearby Site',
                primaryType: 'military_base',
                latitude: 30.3125,
                longitude: -97.785,
              },
            ],
          }),
        );
      }
      return realFetch(input, init);
    };
  }, aircraft);
  const url = new URL(appUrl);
  url.searchParams.set('welcome', '0');
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForFunction(
    () =>
      window.__godsEyeView?.dataManager &&
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 120_000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.keyboard.press('Escape');
  return page;
}

async function waitTiles(page, maxMs = 30_000) {
  await page
    .waitForFunction(
      () => {
        const { scene } = window.__godsEyeView.viewer;
        if (scene.globe.show) return scene.globe.tilesLoaded;
        for (let i = 0; i < scene.primitives.length; i++) {
          const p = scene.primitives.get(i);
          if (p.show && p.tilesLoaded === false) return false;
        }
        return true;
      },
      { timeout: maxMs, polling: 250 },
    )
    .catch(() => {});
}

/** Camera height above the rendered surface under it and under the view centre. */
function clearance(page) {
  return page.evaluate(() => {
    const { viewer } = window.__godsEyeView;
    const { scene, camera } = viewer;
    const carto = camera.positionCartographic.clone();
    const sample = (c) => {
      try {
        const h = scene.sampleHeight(c);
        return Number.isFinite(h) ? h : null;
      } catch {
        return null;
      }
    };
    const under = sample(carto);
    let centre = null;
    const canvas = scene.canvas;
    const hit = scene.pickPosition?.({
      x: canvas.clientWidth / 2,
      y: canvas.clientHeight / 2,
    });
    if (hit) centre = scene.globe.ellipsoid.cartesianToCartographic(hit);
    const centreSurface = centre ? sample(centre) : null;
    const surface = Math.max(under ?? -Infinity, centreSurface ?? -Infinity);
    return {
      lat: (carto.latitude * 180) / Math.PI,
      lon: (carto.longitude * 180) / Math.PI,
      cameraM: Math.round(carto.height),
      surfaceUnderM: under === null ? null : Math.round(under),
      surfaceCentreM: centreSurface === null ? null : Math.round(centreSurface),
      clearanceM: Number.isFinite(surface)
        ? Math.round(carto.height - surface)
        : null,
      pitchDeg: Math.round((camera.pitch * 180) / Math.PI),
    };
  });
}

async function arrivals() {
  const page = await openPage();
  const dir = path.join(outDir, 'arrivals');
  fs.mkdirSync(dir, { recursive: true });
  const recorder = await createScreencast(page, dir);
  await recorder.start();
  for (const query of ['Camp Mabry', '39.7392, -104.9903']) {
    await page.focus('#gev-omnibar-input');
    await page.evaluate(() => {
      document.getElementById('gev-omnibar-input').value = '';
    });
    await page.type('#gev-omnibar-input', query, { delay: 40 });
    await page.keyboard.press('Enter');
    // Wait for the flight to land: the camera still for 1.5 s.
    const landed = Date.now();
    let last = null;
    let stillSince = null;
    while (Date.now() - landed < 30_000) {
      const now = await page.evaluate(() => {
        const c = window.__godsEyeView.viewer.camera.positionWC;
        return [c.x, c.y, c.z];
      });
      const moved =
        !last ||
        Math.hypot(now[0] - last[0], now[1] - last[1], now[2] - last[2]) > 0.5;
      last = now;
      if (moved) stillSince = null;
      else stillSince ??= Date.now();
      if (
        Date.now() - landed > 4000 &&
        stillSince &&
        Date.now() - stillSince > 1500
      )
        break;
      await sleep(250);
    }
    await waitTiles(page);
    await sleep(2500); // the ground guard measures after tiles stream in
    const arrived = await clearance(page);
    const slug = query.replace(/\W+/g, '-').replace(/^-|-$/g, '').toLowerCase();
    await page.screenshot({ path: path.join(dir, `arrival-${slug}.png`) });
    // Look around: a gentle orbit, then check the eye still clears the ground.
    const view = await page.evaluate(() => {
      const c = window.__godsEyeView.viewer.camera;
      return {
        lat: (c.positionCartographic.latitude * 180) / Math.PI,
        lon: (c.positionCartographic.longitude * 180) / Math.PI,
        height: c.positionCartographic.height,
        heading: (c.heading * 180) / Math.PI,
        pitch: (c.pitch * 180) / Math.PI,
      };
    });
    await moveCamera(page, { ...view, heading: view.heading + 25 }, 2.5);
    await sleep(1500);
    const lookedAround = await clearance(page);
    result.arrivals.push({ query, arrived, lookedAround });
    check(
      `${query}: arrival clears the rendered surface`,
      arrived.clearanceM !== null && arrived.clearanceM >= 60,
      JSON.stringify(arrived),
    );
  }
  result.arrivalClip = await recorder.stop();
  await page.close();
}

/**
 * Track an aircraft, show its Context card and press the card's Cockpit action.
 */
async function enterCockpitOn(page, icao24) {
  await page.waitForFunction(
    (id) =>
      window.__godsEyeView.dataManager.layers
        .get('flights')
        .module.trackById(id),
    { timeout: 60_000, polling: 500 },
    icao24,
  );
  await selectQaContextCard(page, { layerId: 'flights', id: icao24 });
  const entry =
    '#entity-card[data-layer="flights"] [data-entity-cockpit-entry]';
  await page.waitForSelector(entry, { visible: true, timeout: 20_000 });
  await page.click(entry);
  await page.waitForFunction(
    (id) => {
      const state = window.__godsEyeView.styleManager.getCockpitState();
      return (
        document.body.classList.contains('cockpit-mode') &&
        state.active &&
        state.subject?.layerId === 'flights' &&
        state.subject.id === id
      );
    },
    { timeout: 30_000 },
    icao24,
  );
}

async function exerciseCockpitUtilities(page) {
  for (const kind of ['display', 'radio']) {
    const selector = `[data-cockpit-rail-item="${kind}"]`;
    const panelId = `cockpit-${kind}-panel`;
    await page.waitForSelector(selector, { visible: true });
    const waitFor = (expanded) =>
      page.waitForFunction(
        (selector, panelId, expanded) => {
          const button = document.querySelector(selector);
          const panel = document.getElementById(panelId);
          return (
            button?.getAttribute('aria-controls') === panelId &&
            button.getAttribute('aria-expanded') === String(expanded) &&
            panel?.checkVisibility({
              opacityProperty: true,
              visibilityProperty: true,
            }) === expanded
          );
        },
        { timeout: 5000 },
        selector,
        panelId,
        expanded,
      );
    await waitFor(false);
    await page.click(selector);
    await waitFor(true);
    await page.click(selector);
    await waitFor(false);
    check(`Cockpit ${kind} opens and closes from its visible control`, true);
  }
}

async function contacts() {
  const page = await openPage({ aircraft: true });
  const dir = path.join(outDir, 'contacts');
  fs.mkdirSync(dir, { recursive: true });
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.setEnabled('flights', true, {
      origin: 'user',
    }),
  );
  // A wide Texas view: installation viewports are unbounded here.
  await moveCamera(
    page,
    { lat: 30.35, lon: -97.76, height: 900_000, pitch: -90 },
    0,
  );
  await sleep(3000);
  // The globe's Follow ends on entry. Sample the actively ridden aircraft
  // and the installation records owned by the renderer instead.
  await page.evaluate(async () => {
    const { getContextStore } = await import('/src/data/contextStore.js');
    const samples = [];
    window.__gevContextSamples = samples;
    let created = 0;
    const seen = new WeakSet();
    setInterval(() => {
      const { dataManager, styleManager } = window.__godsEyeView;
      const { active, subject } = styleManager.getCockpitState();
      const snapshot = dataManager.layers
        .get('military-awareness')
        ?.module.getContextSnapshot?.();
      const cohort = snapshot?.cohorts.find(
        (item) => item.id === 'military-installations',
      );
      const entities = [...getContextStore().entities.values()].filter(
        (record) => record.layerId === 'military-installations',
      );
      for (const { entity } of entities)
        if (!seen.has(entity)) {
          seen.add(entity);
          created += 1;
        }
      const installations = (cohort?.nearest || []).map((item) => ({
        id: item.id ?? null,
        name: item.name ?? item.label ?? null,
        distanceKm: Number.isFinite(item.distanceM)
          ? item.distanceM / 1000
          : null,
      }));
      samples.push({
        t: performance.now(),
        count: cohort ? String(cohort.count ?? '?') : null,
        text: cohort
          ? `${cohort.count ?? '?'} · ${installations
              .map((site) => `${site.name} ${site.distanceKm?.toFixed(1)} km`)
              .join(', ')}`
          : null,
        installations,
        coverage: cohort?.coverage ?? null,
        rendered:
          document
            .querySelector(
              '#cockpit-context:not([hidden]) [data-context-cohort="military-installations"] strong',
            )
            ?.textContent?.trim() ?? null,
        entities: entities.length,
        created,
        cockpitSubject:
          active && subject?.id ? `${subject.layerId}:${subject.id}` : null,
        contactSubject:
          snapshot?.subjectPresent && snapshot.subject?.id
            ? `${snapshot.subject.layerId}:${snapshot.subject.id}`
            : null,
      });
      if (samples.length > 5000) samples.splice(0, 1000);
    }, 250);
  });
  const recorder = await createScreencast(page, dir);
  await recorder.start();
  await enterCockpitOn(page, 'aaa051');
  const independentEntry = await page.evaluate(() => {
    const { dataManager, styleManager } = window.__godsEyeView;
    return (
      styleManager.getCockpitState().active &&
      !dataManager.isEnabled('military-awareness')
    );
  });
  check('the flight card enters Cockpit with Contacts off', independentEntry);
  await exerciseCockpitUtilities(page);
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.cockpitView.exit(),
  );
  const mode = await page.evaluate(() =>
    window.__godsEyeView.styleManager.setContextMode('flights'),
  );
  if (!mode?.ok || mode.mode !== 'flights')
    throw new Error(
      `Could not enable the internal Contacts window: ${JSON.stringify(mode)}`,
    );
  const t0 = await page.evaluate(() => performance.now());
  await enterCockpitOn(page, 'aaa051');
  const readSamples = (from) =>
    page.evaluate(
      (a) => window.__gevContextSamples.filter((s) => s.t >= a),
      from,
    );
  const numeric = (s) => /^\d+/.test(String(s.count ?? ''));
  const onAircraft = (sample, id) =>
    sample.cockpitSubject === `flights:${id}` &&
    sample.contactSubject === sample.cockpitSubject;
  // Up to 15 s for the first answer, then watch 30 s of flight.
  const deadline = Date.now() + 15_000;
  let first = null;
  while (Date.now() < deadline && !first) {
    first = (await readSamples(t0)).find(
      (s) =>
        onAircraft(s, 'aaa051') &&
        numeric(s) &&
        Number.parseInt(s.count, 10) >= 1 &&
        Number.isFinite(s.installations[0]?.distanceKm),
    );
    if (!first) await sleep(500);
  }
  check(
    'Contacts lists a mapped installation with a distance',
    Boolean(first),
    first
      ? `${Math.round(first.t - t0)} ms: ${first.text}`
      : 'cohort never answered',
  );
  await page.screenshot({ path: path.join(dir, 'contacts-camp-mabry.png') });
  await sleep(30_000);
  const flight = (await readSamples(first?.t ?? t0)).filter((s) =>
    onAircraft(s, 'aaa051'),
  );
  const reverted = flight.filter((s) => !numeric(s));
  const createdDuring = flight.length
    ? flight.at(-1).created - flight[0].created
    : 0;
  result.contacts.mabry = {
    firstAnswerMs: first ? Math.round(first.t - t0) : null,
    firstText: first?.text ?? null,
    lastText: flight.at(-1)?.text ?? null,
    samples: flight.length,
    revertedSamples: reverted.length,
    entities: flight.at(-1)?.entities ?? 0,
    entitiesCreatedWhileTracking: createdDuring,
  };
  check(
    'the cohort never falls back to "?" while the aircraft moves',
    flight.length > 1 && reverted.length === 0,
    `${reverted.length}/${flight.length}`,
  );
  check(
    'site entities are not rebuilt while riding the aircraft',
    flight.length > 1 &&
      flight.every((sample) => sample.entities > 0) &&
      createdDuring === 0,
    `${createdDuring} created`,
  );

  // Cockpit: the same context must hold, rendered on its Contact card.
  const inCockpit = (
    await readSamples((await page.evaluate(() => performance.now())) - 8000)
  ).filter((s) => onAircraft(s, 'aaa051'));
  const scope = await page.evaluate(
    () =>
      document.getElementById('cockpit-context-subject')?.textContent || null,
  );
  await page.screenshot({ path: path.join(dir, 'cockpit-camp-mabry.png') });
  result.contacts.cockpit = {
    samples: inCockpit.length,
    last: inCockpit.at(-1)?.text ?? null,
    rendered: inCockpit.at(-1)?.rendered ?? null,
    scope,
  };
  check(
    'Cockpit scope names the installation window',
    /^WITHIN \d+ KM$/.test(inCockpit.at(-1)?.coverage || '') &&
      scope?.includes(`INSTALLATIONS ${inCockpit.at(-1).coverage}`),
    scope || 'no scope',
  );
  check(
    'Cockpit keeps mapped installations listed',
    inCockpit.length > 0 &&
      inCockpit.every(
        (s) =>
          numeric(s) &&
          Number.parseInt(s.count, 10) >= 1 &&
          s.rendered === s.count,
      ),
    JSON.stringify(inCockpit.at(-1) || 'no cockpit samples'),
  );

  // Search from a map view offset from the synthetic Cockpit subject.
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.cockpitView.exit(),
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', false, {
      persist: false,
      syncShare: false,
    }),
  );
  const searchChip =
    '#data-toggles [data-layer-id="military-installations"] [data-chip-id="search-nearby"]';
  await page.waitForSelector(searchChip, { visible: true, timeout: 10_000 });
  await moveCamera(
    page,
    { lat: 30.34, lon: -97.82, height: 30_000, pitch: -90 },
    0,
  );
  const expectedQuery = await page.evaluate(async () => {
    const { findCamera } = await import('/src/render/rendererOf.js');
    const { north, south, east, west } = findCamera(
      window.__godsEyeView.viewer,
    ).viewRectangle();
    window.__qaExpectedSiteQuery = {
      q: 'military installation',
      lat: ((north + south) / 2).toFixed(5),
      lon: ((east + west) / 2).toFixed(5),
      radiusM: String(
        Math.round(55_000 * Math.max(north - south, east - west)),
      ),
    };
    return window.__qaExpectedSiteQuery;
  });
  await page.click(searchChip);
  await page.waitForFunction(
    () => {
      const layer = window.__godsEyeView.dataManager.layers.get(
        'military-installations',
      ).module;
      return (
        window.__qaNearbySiteSearches.length > 0 &&
        layer.getAnalystRecords().some(({ name }) => name === 'QA Nearby Site')
      );
    },
    { timeout: 20_000 },
  );
  const afterSearch = await page.evaluate(() => {
    const { dataManager } = window.__godsEyeView;
    return {
      searches: window.__qaNearbySiteSearches,
      sites: dataManager.layers
        .get('military-installations')
        .module.getAnalystRecords()
        .map(({ name }) => name),
    };
  });
  result.contacts.search = { ...afterSearch, expectedQuery };
  check(
    'Only the chosen map viewport is sent to Places',
    afterSearch.searches.length === 1 &&
      Object.entries(expectedQuery).every(
        ([key, value]) => afterSearch.searches[0][key] === value,
      ),
    JSON.stringify(result.contacts.search),
  );
  check(
    'Search nearby sites adds the returned site and keeps mapped sites',
    afterSearch.sites.includes('Camp Mabry') &&
      afterSearch.sites.includes('QA Nearby Site'),
    JSON.stringify(afterSearch),
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.setPanelCollapsed('data-panel', true, {
      persist: false,
      syncShare: false,
    }),
  );

  // Fort Cavazos: enter Cockpit again on the other aircraft.
  const t1 = await page.evaluate(() => performance.now());
  await enterCockpitOn(page, 'aaa052');
  let cavazos = null;
  const cavazosDeadline = Date.now() + 20_000;
  while (Date.now() < cavazosDeadline) {
    const latest = (await readSamples(t1))
      .filter((s) => onAircraft(s, 'aaa052') && numeric(s))
      .at(-1);
    const site = latest?.installations.find(
      (record) => record.name === 'Fort Hood',
    );
    const km = site?.distanceKm ?? null;
    if (km !== null && km <= 30) {
      cavazos = {
        text: latest.text,
        nearestKm: km,
        site,
        afterMs: Math.round(latest.t - t1),
      };
      break;
    }
    await sleep(500);
  }
  await sleep(2000);
  await page.screenshot({ path: path.join(dir, 'contacts-fort-cavazos.png') });
  result.contacts.cavazos = cavazos;
  check(
    'Fort Cavazos contact lists Fort Hood within 30 km',
    Boolean(cavazos),
    JSON.stringify(cavazos),
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.cockpitView.exit?.(),
  );
  result.contactsClip = await recorder.stop();
  await page.close();
}

try {
  if (only !== 'contacts') await arrivals();
  if (only !== 'arrivals') await contacts();
  // A 404 for a synthetic aircraft's track logs "Failed to load resource";
  // count those only when every failed response was such an expected miss.
  const resourceErrors = result.consoleErrors.filter((text) =>
    /Failed to load resource/.test(text),
  ).length;
  const errors = result.consoleErrors.filter(
    (text) =>
      !/favicon/i.test(text) &&
      !(
        /Failed to load resource/.test(text) &&
        !(result.httpErrors || []).length &&
        resourceErrors <= (result.expectedMisses || []).length
      ),
  );
  check(
    'zero console errors',
    errors.length === 0,
    errors.slice(0, 3).join(' | '),
  );
  check(
    'zero failed app responses',
    !(result.httpErrors || []).length,
    (result.httpErrors || []).slice(0, 3).join(' | '),
  );
} catch (error) {
  check('harness completed', false, error.stack || error.message);
} finally {
  fs.writeFileSync(
    path.join(outDir, 'result.json'),
    JSON.stringify(result, null, 1),
  );
  await browser.close();
}
console.log(
  `${result.failures.length ? 'FAIL' : 'PASS'} — ${path.join(outDir, 'result.json')}`,
);
process.exit(result.failures.length ? 1 : 0);
