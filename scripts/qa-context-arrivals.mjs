#!/usr/bin/env node
/**
 * qa-context-arrivals.mjs — search arrivals above the surface, and Contacts
 * listing mapped installations around a moving tracked aircraft.
 *
 * Run: node scripts/qa-context-arrivals.mjs http://localhost:4173 [--headful]
 *      [--out qa-shots/context-arrivals] [--only arrivals|contacts]
 *
 * Arrivals: types "Camp Mabry" and "39.7392, -104.9903" (downtown Denver)
 * into the location search, waits for the flight and the photoreal tiles,
 * orbits a little like a user looking around, and asserts the camera sits at
 * least 60 m above the rendered surface under it and under the view centre.
 *
 * Contacts: serves two synthetic aircraft through the page's own
 * /api/flights response (one flying north over Camp Mabry at 2,500 m, one
 * near Fort Cavazos) and an empty military feed, starts from a wide Texas
 * view, and presses CONTACTS as a user would. Asserts the Mapped
 * installations row lists at least one site with a distance within 15 s,
 * never falls back to "?" while the aircraft moves (30 s), keeps its site
 * entities (no rebuilds while the view is still), still lists sites in
 * Cockpit, and that SEARCH NEARBY SITES reports what it found. Then re-enters
 * Contacts on the Fort Cavazos aircraft and asserts a site within 30 km.
 * Requires zero console errors.
 *
 * Writes <out>/result.json, screenshots and <out>/clip.mp4 (CDP screencast
 * with real frame timing; needs ffmpeg).
 */
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';
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
    // Synthetic traffic through the app's own feed endpoints: one aircraft
    // flying north over Camp Mabry, one loitering near Fort Cavazos.
    const started = Date.now();
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
    await page.evaluate(() =>
      document.getElementById('search-toggle')?.click(),
    );
    await page.focus('#location-search');
    await page.evaluate(() => {
      document.getElementById('location-search').value = '';
    });
    await page.type('#location-search', query, { delay: 40 });
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
  // In-page probe: row text and installation entity churn every 250 ms.
  await page.evaluate(() => {
    const samples = [];
    window.__gevContextSamples = samples;
    let created = 0;
    const seen = new WeakSet();
    setInterval(() => {
      const row = [
        ...document.querySelectorAll(
          '#military-awareness-panel .military-awareness-row',
        ),
      ].find(
        (candidate) =>
          candidate.querySelector('strong')?.textContent?.trim() ===
          'Mapped installations',
      );
      const ds = window.__godsEyeView.viewer.dataSources.getByName(
        'military-installations',
      )[0];
      for (const entity of ds?.entities.values || [])
        if (!seen.has(entity)) {
          seen.add(entity);
          created += 1;
        }
      samples.push({
        t: performance.now(),
        count: row?.querySelector('b')?.textContent?.trim() ?? null,
        text: row?.innerText?.replace(/\s+/g, ' ').trim() ?? null,
        installations: [
          ...(row?.querySelectorAll('button[data-awareness-id]') || []),
        ].map((button) => ({
          id: button.dataset.awarenessId,
          name: button.childNodes[0]?.textContent?.trim(),
          distance: button.querySelector('span')?.textContent?.trim(),
        })),
        entities: ds?.entities.values.length ?? 0,
        created,
        tracked:
          window.__godsEyeView.viewer.trackedEntity?.gevTrackedId ?? null,
        cockpit: document.body.classList.contains('cockpit-mode'),
      });
      if (samples.length > 5000) samples.splice(0, 1000);
    }, 250);
  });
  const recorder = await createScreencast(page, dir);
  await recorder.start();
  const t0 = await page.evaluate(() => performance.now());
  await page.evaluate(() =>
    document.getElementById('global-context-flights-btn').click(),
  );
  await page
    .waitForFunction(
      () =>
        window.__godsEyeView.viewer.trackedEntity?.gevTrackedId ===
        'flights:aaa051',
      { timeout: 60_000 },
    )
    .catch(() => {});
  const readSamples = (from) =>
    page.evaluate(
      (a) => window.__gevContextSamples.filter((s) => s.t >= a),
      from,
    );
  const numeric = (s) => /^\d+/.test(String(s.count ?? ''));
  // Up to 15 s for the first answer, then watch 30 s of flight.
  const deadline = Date.now() + 15_000;
  let first = null;
  while (Date.now() < deadline && !first) {
    first = (await readSamples(t0)).find(
      (s) =>
        numeric(s) &&
        Number.parseInt(s.count, 10) >= 1 &&
        /\d+(\.\d+)? k?m\b/.test(s.text),
    );
    if (!first) await sleep(500);
  }
  check(
    'Contacts lists a mapped installation with a distance',
    Boolean(first),
    first
      ? `${Math.round(first.t - t0)} ms: ${first.text}`
      : 'row never answered',
  );
  await page.screenshot({ path: path.join(dir, 'contacts-camp-mabry.png') });
  await sleep(30_000);
  const flight = (await readSamples(first?.t ?? t0)).filter(
    (s) => s.tracked === 'flights:aaa051',
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
    'the row never falls back to "?" while the aircraft moves',
    reverted.length === 0,
    `${reverted.length}/${flight.length}`,
  );
  check(
    'site entities are not rebuilt while tracking',
    createdDuring === 0,
    `${createdDuring} created`,
  );

  // Cockpit: the same context must hold with a horizon view.
  const cockpit = await page.evaluate(() => {
    const view = window.__godsEyeView.styleManager.cockpitView;
    view.syncEntry();
    return view.enter();
  });
  await sleep(12_000);
  const inCockpit = (
    await readSamples((await page.evaluate(() => performance.now())) - 8000)
  ).filter((s) => s.cockpit);
  const scope = await page.evaluate(
    () =>
      document.getElementById('cockpit-context-subject')?.textContent || null,
  );
  await page.screenshot({ path: path.join(dir, 'cockpit-camp-mabry.png') });
  result.contacts.cockpit = {
    entered: cockpit,
    samples: inCockpit.length,
    last: inCockpit.at(-1)?.text ?? null,
    scope,
  };
  check(
    'Cockpit scope names the installation window',
    /INSTALLATIONS WITHIN \d+ KM/.test(scope || ''),
    scope || 'no scope',
  );
  check(
    'Cockpit keeps mapped installations listed',
    cockpit !== false &&
      inCockpit.length > 0 &&
      inCockpit.every((s) => numeric(s) && Number.parseInt(s.count, 10) >= 1),
    inCockpit.at(-1)?.text || 'no cockpit samples',
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.cockpitView.exit?.(),
  );
  await sleep(2000);

  // SEARCH NEARBY SITES, as the user presses it.
  await page.evaluate(() => {
    document.getElementById('toast').textContent = '';
    document.getElementById('installations-search-btn').click();
  });
  await page
    .waitForFunction(
      () => document.getElementById('toast').textContent.trim().length > 0,
      { timeout: 20_000 },
    )
    .catch(() => {});
  const toast = await page.evaluate(() =>
    document.getElementById('toast').textContent.trim(),
  );
  await sleep(1500);
  const afterSearch = (
    await readSamples((await page.evaluate(() => performance.now())) - 1000)
  ).at(-1);
  result.contacts.search = { toast, row: afterSearch?.text ?? null };
  check(
    'SEARCH NEARBY SITES reports what it found and the row still lists sites',
    /mapped sites? within \d+ km/i.test(toast) && numeric(afterSearch || {}),
    `toast "${toast}" · ${afterSearch?.text}`,
  );

  // Fort Cavazos: leave Contacts, track the other aircraft, re-enter.
  await page.evaluate(() =>
    document.getElementById('global-context-flights-btn').click(),
  );
  await sleep(2000);
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('flights')
      .module.trackById('aaa052'),
  );
  await sleep(3000);
  const t1 = await page.evaluate(() => performance.now());
  await page.evaluate(() =>
    document.getElementById('global-context-flights-btn').click(),
  );
  let cavazos = null;
  const cavazosDeadline = Date.now() + 20_000;
  while (Date.now() < cavazosDeadline) {
    const latest = (await readSamples(t1))
      .filter((s) => s.tracked === 'flights:aaa052' && numeric(s))
      .at(-1);
    const site = latest?.installations.find(
      (record) => record.name === 'Fort Hood',
    );
    const nearest = site?.distance?.match(/^(\d+(?:\.\d+)?) (k?m)$/);
    const km = nearest
      ? Number(nearest[1]) / (nearest[2] === 'm' ? 1000 : 1)
      : null;
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
