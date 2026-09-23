#!/usr/bin/env node
/**
 * qa-ham-repeaters.mjs — headless proof for the Repeaters layer (`ham-repeaters`).
 *
 * Drives the REAL app in headless Chromium against a running dev server and
 * proves the contract the layer actually implements:
 *
 *   (i)    PANEL     — the Repeaters companion panel discloses through the app's
 *                      own `gev:ham-repeaters-panel` event and renders its
 *                      off-state controls.
 *   (ii)   GATE      — enabling above the 1500 km height gate loads nothing:
 *                      no area, no rows, no markers; the layer row carries
 *                      `Fly below 1500 km or press LOAD HERE` (getStats status
 *                      'zoom-in'), the empty list carries the same guidance with
 *                      a full stop, and the area line names the height in the
 *                      numeric `auto-load below 1500 km (now N km)` form.
 *   (iii)  LOAD HERE — the panel button loads around the view centre anyway,
 *                      with the gate still reporting "above": origin 'user',
 *                      reason 'panel', radius from #ham-repeaters-radius.
 *   (iv)   CAMERA    — dropping below the gate over Cologne (50.94 N, 6.96 E)
 *                      auto-loads through camera.moveEnd: origin 'camera', a
 *                      non-zero summary count and rendered list rows, each
 *                      carrying its provenance line.
 *   (v)    FILTERS   — the kind and band selects narrow the visible set without
 *                      refetching: the FM and D-STAR counts partition the loaded
 *                      set, no filter ever exceeds the unfiltered count, and
 *                      markers and list rows follow the filter.
 *   (vi)   SELECT    — clicking the first list row selects that repeater, marks
 *                      the row, and publishes a selection marker whose label
 *                      ends with the row's provenance line.
 *   (vii)  CREDIT    — the HamRig repeater credit is registered and surfaces in
 *                      the "Data attribution" lightbox.
 *
 * Screenshots are written under the gitignored `qa-shots/ham-repeaters/`.
 *
 * Run:  node scripts/qa-ham-repeaters.mjs --url http://localhost:4173
 * Add --fixtures to intercept /api/ham-repeaters/nearby with a deterministic
 * Cologne set (no HamRig traffic, no HAMRIG_ENABLED needed); that mode proves
 * the UI contract, not live-source acceptance.
 *
 * Exits 1 on any FAIL, 2 when the dev server or the repeater route is not
 * usable, 3 on a harness error.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'ham-repeaters');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option(
  '--url',
  process.env.QA_BASE_URL || 'http://localhost:4173',
);
const APP_ORIGIN = new URL(APP_URL).origin;
const HEADFUL = args.includes('--headful');
const FIXTURES = args.includes('--fixtures');

// The Repeaters harness owns this run's pointer gestures; the welcome dialog
// has its own acceptance harness and must not intercept them.
const PAGE_URL = new URL(APP_URL);
PAGE_URL.searchParams.set('welcome', '0');

const REPEATERS_PATH = '/api/ham-repeaters/nearby';
// Cologne: dense FM and D-STAR coverage, and comfortably inland.
const COLOGNE = { lat: 50.94, lon: 6.96 };
const GLOBE_HEIGHT_M = 9_000_000; // well above HEIGHT_GATE_M (1_500_000)
const CLOSE_HEIGHT_M = 60_000; // below the gate, small enough to re-plan radius
const GATE_GUIDANCE = 'Fly below 1500 km or press LOAD HERE';
const PANEL_LIST_LIMIT = 60; // src/ui/hamRepeatersPresentation.js
const GREEN = '\u001b[32m';
const RED = '\u001b[31m';
const RESET = '\u001b[0m';

const chromeCandidates = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  // Prefer puppeteer's pinned Chrome-for-Testing: /Applications auto-updates
  // underneath the harnesses and its software-GL behaviour shifts across majors.
  await puppeteer.executablePath().catch(() => null),
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);
const chrome = chromeCandidates.find((candidate) => {
  try {
    return fs.existsSync(candidate);
  } catch {
    return false;
  }
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const label = ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`;
  console.log(`  [${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}
function section(title) {
  console.log(`\n${title}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll an in-page predicate. This repo's Puppeteer hangs on the default raf
 * polling, so every wait is explicitly `{ polling: 500 }`. A missed condition
 * resolves false so the caller reports a FAIL with the observed state instead
 * of aborting the whole run.
 */
async function waitFor(
  page,
  predicate,
  { timeout = 30_000, args: extra = [] } = {},
) {
  try {
    await page.waitForFunction(predicate, { polling: 500, timeout }, ...extra);
    return true;
  } catch {
    return false;
  }
}

/** Teleport the camera; the intro flight would otherwise clobber the view. */
async function setView(page, lat, lon, heightM) {
  await page.evaluate(
    (la, lo, h) => {
      const gev = window.__godsEyeView;
      const ellipsoid = gev.viewer.scene.globe.ellipsoid;
      const d2r = Math.PI / 180;
      try {
        gev.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      gev.viewer.camera.setView({
        destination: ellipsoid.cartographicToCartesian({
          longitude: lo * d2r,
          latitude: la * d2r,
          height: h,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.scene.requestRender?.();
    },
    lat,
    lon,
    heightM,
  );
}

/** Everything an assertion in this script reads, in one serializable shot. */
async function snapshot(page) {
  return page.evaluate(() => {
    const gev = window.__godsEyeView;
    const viewer = gev?.viewer || null;
    const module =
      gev?.dataManager?.layers?.get('ham-repeaters')?.module || null;
    const raw = module?.getUIState?.() || null;
    const rawStats = module?.getStats?.() || null;
    const rowControls = module?.getRowControls?.() || null;
    const text = (id) =>
      document.getElementById(id)?.textContent?.trim() ?? null;

    const state = raw
      ? {
          enabled: raw.enabled,
          loading: raw.loading,
          error: raw.error,
          stale: raw.stale,
          partial: raw.partial,
          count: raw.count,
          filteredCount: raw.filteredCount,
          itemCount: (raw.items || []).length,
          selectedId: raw.selectedId,
          selected: raw.selected
            ? {
                id: raw.selected.id,
                callsign: raw.selected.callsign,
                kind: raw.selected.kind,
                band: raw.selected.band,
                sourceLabel: raw.selected.sourceLabel,
                confidence: raw.selected.confidence,
              }
            : null,
          filter: { ...raw.filter },
          bands: (raw.filters?.bands || []).map((entry) => entry.id),
          kinds: (raw.filters?.kinds || []).map((entry) => entry.id),
          areaLabel: raw.areaLabel,
          area: raw.area
            ? {
                lat: raw.area.lat,
                lon: raw.area.lon,
                radiusKm: raw.area.radiusKm,
              }
            : null,
          gate: raw.gate ? { ...raw.gate } : null,
          lastLoad: raw.lastLoad ? { ...raw.lastLoad } : null,
          sources: [...(raw.sources || [])],
          presentationActive: raw.presentationActive,
        }
      : null;
    const stats = rawStats
      ? {
          count: rawStats.count,
          countLabel: rawStats.countLabel,
          filtered: rawStats.filtered,
          withinGate: rawStats.withinGate,
          loading: rawStats.loading,
          error: rawStats.error,
          status: rawStats.status ?? null,
          statusMessage: rawStats.statusMessage,
          hasArea: Boolean(rawStats.area),
          sources: [...(rawStats.sources || [])],
        }
      : null;

    let dataSource = null;
    const collection = viewer?.dataSources;
    if (collection) {
      for (let index = 0; index < collection.length; index += 1) {
        const candidate = collection.get(index);
        if (candidate?.name === 'Ham repeaters') {
          dataSource = candidate;
          break;
        }
      }
    }
    const entities = dataSource ? dataSource.entities.values : [];

    const selectedEntity =
      viewer?.entities?.getById?.('ham-repeater:selected') || null;
    let selectedLabel = null;
    const labelText = selectedEntity?.label?.text;
    if (labelText)
      selectedLabel =
        typeof labelText.getValue === 'function'
          ? labelText.getValue(viewer.clock.currentTime)
          : String(labelText);

    const layerRow = document.querySelector('[data-layer-id="ham-repeaters"]');
    const options = (id) =>
      [...(document.getElementById(id)?.options || [])].map(
        (entry) => entry.value,
      );

    return {
      registered: Boolean(module),
      enabled: gev?.dataManager?.isEnabled?.('ham-repeaters') ?? null,
      state,
      stats,
      rowInfo: typeof rowControls?.info === 'string' ? rowControls.info : null,
      rowChips: (rowControls?.chips || []).map((chip) => chip.id),
      panelCollapsed:
        document
          .getElementById('ham-repeaters-panel')
          ?.classList.contains('collapsed') ?? null,
      enableVisible: Boolean(
        document.getElementById('ham-repeaters-enable-btn')?.offsetParent,
      ),
      enableLabel: text('ham-repeaters-enable-btn'),
      enablePressed:
        document
          .getElementById('ham-repeaters-enable-btn')
          ?.getAttribute('aria-pressed') ?? null,
      layerStateChip: text('ham-repeaters-layer-state'),
      summary: text('ham-repeaters-summary'),
      areaLine: text('ham-repeaters-area'),
      emptyNote:
        document
          .querySelector('#ham-repeaters-list .ham-repeaters-list-empty')
          ?.textContent?.trim() ?? null,
      rows: [
        ...document.querySelectorAll('#ham-repeaters-list .ham-repeaters-row'),
      ].map((row) => ({
        id: row.dataset.repeaterId || '',
        selected: row.classList.contains('selected'),
        ariaSelected: row.getAttribute('aria-selected'),
        callsign: row.querySelector('strong')?.textContent || '',
        lead: row.querySelector('.ham-repeaters-row-lead')?.textContent || '',
        tail: row.querySelector('.ham-repeaters-row-tail')?.textContent || '',
        details: row.querySelector('.ham-repeaters-row-sub')?.textContent || '',
        provenance:
          row.querySelector('.ham-repeaters-row-provenance')?.textContent || '',
      })),
      markers: entities.length,
      visibleMarkers: entities.filter((entity) => entity.show !== false).length,
      dataSourceShown: dataSource ? dataSource.show !== false : null,
      selectedLabel,
      layerRowMeta:
        layerRow?.querySelector('.data-toggle-meta')?.textContent?.trim() ??
        null,
      bandValue: document.getElementById('ham-repeaters-band')?.value ?? null,
      kindValue: document.getElementById('ham-repeaters-kind')?.value ?? null,
      bandOptions: options('ham-repeaters-band'),
      kindOptions: options('ham-repeaters-kind'),
      radiusValue:
        document.getElementById('ham-repeaters-radius')?.value ?? null,
      selectsDisabled:
        Boolean(document.getElementById('ham-repeaters-band')?.disabled) ||
        Boolean(document.getElementById('ham-repeaters-kind')?.disabled),
      loadDisabled:
        document.getElementById('ham-repeaters-load-btn')?.disabled ?? null,
    };
  });
}

/**
 * Deterministic broker rows around a search centre (--fixtures only).
 * Shaped exactly like the `/api/ham-repeaters/nearby` payload the browser
 * re-validates: FM and D-STAR across 2 m, 70 cm, 6 m and 23 cm so the kind and
 * band filters both have something real to bite on.
 */
function fixtureRepeaters(lat, lon) {
  const plan = [
    {
      kind: 'FM',
      band: '2m',
      outputHz: 145_600_000,
      offsetHz: -600_000,
      count: 9,
    },
    {
      kind: 'FM',
      band: '70cm',
      outputHz: 438_500_000,
      offsetHz: -7_600_000,
      count: 7,
    },
    {
      kind: 'FM',
      band: '6m',
      outputHz: 51_510_000,
      offsetHz: -600_000,
      count: 2,
    },
    {
      kind: 'D-STAR',
      band: '70cm',
      outputHz: 439_450_000,
      offsetHz: -7_600_000,
      count: 4,
    },
    {
      kind: 'D-STAR',
      band: '23cm',
      outputHz: 1_291_000_000,
      offsetHz: -28_000_000,
      count: 2,
    },
  ];
  const rows = [];
  let index = 0;
  for (const entry of plan) {
    for (let n = 0; n < entry.count; n += 1) {
      // A tight deterministic spiral inside ~20 km, so any radius >= 25 km holds it.
      const angle = (index * 137.5 * Math.PI) / 180;
      const offsetKm = 2 + index * 0.9;
      const dLat = (offsetKm * Math.cos(angle)) / 111.32;
      const dLon =
        (offsetKm * Math.sin(angle)) /
        (111.32 * Math.cos((lat * Math.PI) / 180));
      const dstar = entry.kind === 'D-STAR';
      const outputHz = entry.outputHz + index * 12_500;
      rows.push({
        id: `qa-${dstar ? 'dstar' : 'fm'}-${index}`,
        kind: entry.kind,
        callsign: `DB0Q${String(index).padStart(2, '0')}`,
        outputHz,
        inputHz: outputHz + entry.offsetHz,
        offsetHz: entry.offsetHz,
        band: entry.band,
        toneHz: dstar ? null : 67 + (index % 5) * 6,
        toneBurstHz: null,
        module: dstar ? ['B', 'C'][index % 2] : null,
        city: 'Koeln',
        region: 'Nordrhein-Westfalen',
        country: 'Germany',
        lat: lat + dLat,
        lon: lon + dLon,
        positionPrecise: index % 7 !== 0,
        distanceKm: Math.round(offsetKm * 10) / 10,
        status: index % 11 === 0 ? 'Off-air' : 'On-air',
        statusKnown: true,
        echolink: dstar
          ? null
          : index % 3 === 0
            ? String(600_000 + index)
            : null,
        allstar: null,
        irlp: null,
        wires: null,
        source: dstar ? 'hamrig-dstar' : 'hamrig-fm',
        sourceLabel: dstar
          ? 'dstarinfo.com / ircddb.net via HamRig'
          : 'HamRig FM table (historic import, cross-checked against hearham.com)',
        sourceUrl: 'https://hamrig.com',
        confidence: dstar ? 'reported' : 'unverified',
        recordUpdatedAt: dstar ? '2025-08-19' : '2025-05-06',
      });
      index += 1;
    }
  }
  return rows;
}

async function main() {
  const reachable = await fetch(APP_URL).catch(() => null);
  if (!reachable?.ok) {
    console.error(`Dev server not reachable at ${APP_URL}`);
    process.exit(2);
  }
  if (!FIXTURES) {
    const probeUrl = `${APP_ORIGIN}${REPEATERS_PATH}?lat=${COLOGNE.lat}&lon=${COLOGNE.lon}&radiusKm=50&limit=5&kind=all`;
    const probe = await fetch(probeUrl).catch(() => null);
    if (!probe?.ok) {
      console.error(
        `Repeater route unusable: ${probe ? `HTTP ${probe.status}` : 'no response'} ${probeUrl}`,
      );
      console.error(
        'Set HAMRIG_ENABLED=1 (and HAMRIG_BASE_URL) for the dev server, or re-run with --fixtures.',
      );
      process.exit(2);
    }
  }

  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await puppeteer.launch({
    headless: HEADFUL ? false : 'new',
    ...(chrome ? { executablePath: chrome } : {}),
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      ...(process.platform === 'darwin'
        ? ['--use-angle=metal', '--enable-gpu']
        : ['--use-gl=angle', '--use-angle=swiftshader']),
      '--disable-dev-shm-usage',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--window-size=1440,900',
    ],
  });

  const repeaterRequests = [];
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.setRequestInterception(true);
    page.on('request', (request) => {
      let url;
      try {
        url = new URL(request.url());
      } catch {
        void request.continue();
        return;
      }
      if (url.origin === APP_ORIGIN && url.pathname === REPEATERS_PATH) {
        repeaterRequests.push(url.search);
        if (FIXTURES) {
          const lat = Number(url.searchParams.get('lat'));
          const lon = Number(url.searchParams.get('lon'));
          const band = url.searchParams.get('band');
          const kind = url.searchParams.get('kind') || 'all';
          const limit = Number(url.searchParams.get('limit')) || 200;
          let rows = fixtureRepeaters(lat, lon);
          if (kind === 'fm') rows = rows.filter((row) => row.kind === 'FM');
          else if (kind === 'dstar')
            rows = rows.filter((row) => row.kind === 'D-STAR');
          if (band) rows = rows.filter((row) => row.band === band);
          void request.respond({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              generatedAt: new Date().toISOString(),
              sources: ['hamrig-fm', 'hamrig-dstar'],
              repeaters: rows.slice(0, limit),
              errors: {},
              partial: false,
              stale: false,
            }),
          });
          return;
        }
      }
      // Support endpoints that would otherwise add cost and console noise to a
      // run that is about repeaters.
      if (
        url.origin === APP_ORIGIN &&
        url.pathname === '/api/openai/hud-summary'
      ) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ summary: 'QA globe ready' }),
        });
        return;
      }
      if (
        url.origin === APP_ORIGIN &&
        url.pathname === '/api/google/nearby-places'
      ) {
        void request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ places: [] }),
        });
        return;
      }
      void request.continue();
    });

    const consoleErrors = [];
    const failedResponses = [];
    const cesiumIonFailures = [];
    page.on('console', (message) => {
      if (message.type() !== 'error') return;
      const sourceUrl = message.location()?.url || '';
      consoleErrors.push(
        sourceUrl ? `${message.text()} [${sourceUrl}]` : message.text(),
      );
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (/^https:\/\/api\.cesium\.com\//.test(url))
        cesiumIonFailures.push(
          `${request.failure()?.errorText || 'failed'} ${url}`,
        );
    });
    page.on('response', (response) => {
      if (response.status() >= 500)
        failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
    });

    console.log(
      `\n  qa-ham-repeaters → ${APP_URL}${FIXTURES ? '  (fixtures)' : '  (live)'}\n`,
    );

    // (i) the Repeaters panel
    section('(i) PANEL — the Repeaters companion discloses with its controls');
    await page.goto(PAGE_URL.href, {
      waitUntil: 'domcontentloaded',
      timeout: 60_000,
    });
    const booted = await waitFor(
      page,
      () =>
        Boolean(window.__godsEyeView?.viewer) &&
        Boolean(
          window.__godsEyeView?.dataManager?.layers?.has?.('ham-repeaters'),
        ) &&
        document
          .getElementById('loading-screen')
          ?.classList.contains('hidden') === true,
      { timeout: 90_000 },
    );
    check('app boots with the repeaters layer registered', booted);
    if (!booted)
      throw new Error('App never reported a registered ham-repeaters layer');

    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const ui = window.__godsEyeView.styleManager;
      try {
        window.__godsEyeView.viewer.camera.cancelFlight();
      } catch {
        /* no flight active */
      }
      // Quiet the neighbours so the left stack gives the panel its full height.
      for (const id of [
        'pp-toggles',
        'cctv-panel',
        'radio-panel',
        'global-context-panel',
      ])
        ui.setPanelCollapsed(id, true);
    });
    // The app's own disclosure route, the one the voice tool fires.
    await page.evaluate(() =>
      document.dispatchEvent(
        new CustomEvent('gev:ham-repeaters-panel', {
          detail: { origin: 'qa' },
        }),
      ),
    );
    const disclosed = await waitFor(page, () => {
      const panel = document.getElementById('ham-repeaters-panel');
      const button = document.getElementById('ham-repeaters-enable-btn');
      return Boolean(
        panel && !panel.classList.contains('collapsed') && button?.offsetParent,
      );
    });
    let view = await snapshot(page);
    check(
      'gev:ham-repeaters-panel expands the panel and reveals its controls',
      disclosed && view.panelCollapsed === false && view.enableVisible,
      `collapsed=${view.panelCollapsed} enableVisible=${view.enableVisible}`,
    );
    check(
      'the off-state panel invites LOAD HERE',
      view.layerStateChip === 'OFF' &&
        view.enableLabel === 'ENABLE' &&
        view.enablePressed === 'false' &&
        view.summary === 'Repeaters off — LOAD HERE switches it on' &&
        view.emptyNote ===
          'Enable Repeaters (or press LOAD HERE) for FM and D-STAR repeaters around the view.',
      `chip=${view.layerStateChip} summary=${JSON.stringify(view.summary)}`,
    );
    check(
      'the filter selects offer the documented kinds and bands',
      view.kindOptions.join(',') === 'all,FM,D-STAR' &&
        view.bandOptions.join(',') === 'all,6m,2m,1.25m,70cm,23cm' &&
        view.radiusValue === '100',
      `kinds=${view.kindOptions.join('|')} bands=${view.bandOptions.join('|')} radius=${view.radiusValue}`,
    );

    // (ii) the height gate
    section('(ii) GATE — enabling above 1500 km loads nothing and says why');
    await setView(page, COLOGNE.lat, COLOGNE.lon, GLOBE_HEIGHT_M);
    await page.click('#ham-repeaters-enable-btn');
    const settledAboveGate = await waitFor(
      page,
      () => {
        window.__godsEyeView?.viewer?.scene?.requestRender?.();
        const module =
          window.__godsEyeView?.dataManager?.layers?.get(
            'ham-repeaters',
          )?.module;
        const state = module?.getUIState?.();
        return Boolean(
          state?.enabled &&
          !state.loading &&
          state.presentationActive &&
          Number.isFinite(state.gate?.heightM),
        );
      },
      { timeout: 60_000 },
    );
    view = await snapshot(page);
    check(
      'the layer enables and settles above the gate',
      settledAboveGate &&
        view.enabled === true &&
        view.state?.gate?.withinGate === false,
      `enabled=${view.enabled} gate=${JSON.stringify(view.state?.gate)}`,
    );
    check(
      'nothing is loaded above the gate',
      view.state?.count === 0 &&
        view.state?.area === null &&
        view.state?.lastLoad === null &&
        view.stats?.withinGate === false &&
        repeaterRequests.length === 0,
      `count=${view.state?.count} area=${JSON.stringify(view.state?.area)} requests=${repeaterRequests.length}`,
    );
    check(
      'no markers are drawn above the gate',
      view.markers === 0 &&
        view.visibleMarkers === 0 &&
        view.selectedLabel === null,
      `markers=${view.markers} visible=${view.visibleMarkers}`,
    );
    check(
      `the empty list carries the gate guidance ("${GATE_GUIDANCE}.")`,
      view.emptyNote === `${GATE_GUIDANCE}.` && view.rows.length === 0,
      `note=${JSON.stringify(view.emptyNote)}`,
    );
    check(
      "the layer row reports status 'zoom-in' with the gate guidance",
      view.stats?.status === 'zoom-in' &&
        view.stats?.statusMessage === GATE_GUIDANCE,
      `status=${view.stats?.status} message=${JSON.stringify(view.stats?.statusMessage)}`,
    );
    // The panel's area line carries the numeric form of the same rule; the bare
    // GATE_GUIDANCE string only reaches the layer row and the empty list.
    check(
      'the area line names the gate and the current height',
      /auto-load below 1500 km \(now \d+ km\)/.test(view.areaLine || ''),
      `area=${JSON.stringify(view.areaLine)}`,
    );
    const rowMetaShowsGuidance = await waitFor(
      page,
      (guidance) => {
        const row = document.querySelector('[data-layer-id="ham-repeaters"]');
        return Boolean(
          row
            ?.querySelector('.data-toggle-meta')
            ?.textContent?.includes(guidance),
        );
      },
      { timeout: 15_000, args: [GATE_GUIDANCE] },
    );
    view = await snapshot(page);
    check(
      'the Layers row surfaces the guidance beside the source',
      rowMetaShowsGuidance &&
        (view.layerRowMeta || '').includes('HamRig repeater tables'),
      `meta=${JSON.stringify(view.layerRowMeta)}`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'repeaters-gate-globe.png'),
    });

    // (iii) LOAD HERE beats the gate
    section('(iii) LOAD HERE — the panel button loads above the gate anyway');
    await page.click('#ham-repeaters-load-btn');
    const loadedByButton = await waitFor(
      page,
      () => {
        window.__godsEyeView?.viewer?.scene?.requestRender?.();
        const module =
          window.__godsEyeView?.dataManager?.layers?.get(
            'ham-repeaters',
          )?.module;
        const state = module?.getUIState?.();
        return Boolean(
          state && !state.loading && state.area && state.lastLoad?.at,
        );
      },
      { timeout: 60_000 },
    );
    view = await snapshot(page);
    const forcedCount = view.state?.count ?? 0;
    check(
      'LOAD HERE loads while the camera is still above the gate',
      loadedByButton &&
        forcedCount > 0 &&
        view.state?.gate?.withinGate === false &&
        view.stats?.withinGate === false,
      `count=${forcedCount} withinGate=${view.state?.gate?.withinGate}`,
    );
    check(
      'the forced load is attributed to the panel button',
      view.state?.lastLoad?.origin === 'user' &&
        view.state?.lastLoad?.reason === 'panel' &&
        view.state?.area?.radiusKm === 100 &&
        Math.abs((view.state?.area?.lat ?? 0) - COLOGNE.lat) < 1 &&
        Math.abs((view.state?.area?.lon ?? 0) - COLOGNE.lon) < 1,
      `lastLoad=${JSON.stringify(view.state?.lastLoad)} area=${JSON.stringify(view.state?.area)}`,
    );
    check(
      'the forced load reached the repeater broker',
      repeaterRequests.length >= 1 &&
        /lat=/.test(repeaterRequests.at(-1) || ''),
      `requests=${repeaterRequests.length} last=${repeaterRequests.at(-1)}`,
    );
    check(
      'the area line swaps the guidance for the loaded area',
      (view.areaLine || '').includes('100 km around') &&
        (view.areaLine || '').includes('loaded') &&
        view.stats?.status !== 'zoom-in',
      `area=${JSON.stringify(view.areaLine)} status=${view.stats?.status}`,
    );
    check(
      'every loaded repeater gets a marker',
      view.markers === forcedCount && view.dataSourceShown === true,
      `markers=${view.markers} count=${forcedCount} shown=${view.dataSourceShown}`,
    );

    // (iv) the camera-driven load below the gate
    section('(iv) CAMERA — dropping below the gate over Cologne auto-loads');
    await setView(page, COLOGNE.lat, COLOGNE.lon, CLOSE_HEIGHT_M);
    const autoLoaded = await waitFor(
      page,
      () => {
        // moveEnd only fires from a rendered frame; keep requesting them.
        window.__godsEyeView?.viewer?.scene?.requestRender?.();
        const module =
          window.__godsEyeView?.dataManager?.layers?.get(
            'ham-repeaters',
          )?.module;
        const state = module?.getUIState?.();
        return Boolean(
          state &&
          !state.loading &&
          state.gate?.withinGate === true &&
          state.lastLoad?.origin === 'camera' &&
          state.count > 0,
        );
      },
      { timeout: 90_000 },
    );
    view = await snapshot(page);
    const loadedCount = view.state?.count ?? 0;
    check(
      'camera.moveEnd below the gate loads around the view',
      autoLoaded &&
        view.state?.gate?.withinGate === true &&
        view.state?.lastLoad?.origin === 'camera' &&
        loadedCount > 0,
      `count=${loadedCount} gate=${JSON.stringify(view.state?.gate)} lastLoad=${JSON.stringify(view.state?.lastLoad)}`,
    );
    check(
      'the summary shows a non-zero count',
      loadedCount > 0 &&
        new RegExp(
          `^${view.state?.filteredCount}/${loadedCount} repeaters`,
        ).test(view.summary || ''),
      `summary=${JSON.stringify(view.summary)}`,
    );
    check(
      'the layer-state chip mirrors visible/total',
      view.layerStateChip === `${view.state?.filteredCount}/${loadedCount}`,
      `chip=${view.layerStateChip}`,
    );
    check(
      'the list renders rows, capped at the panel limit',
      view.rows.length > 0 &&
        view.rows.length ===
          Math.min(view.state?.filteredCount ?? 0, PANEL_LIST_LIMIT),
      `rows=${view.rows.length} filtered=${view.state?.filteredCount}`,
    );
    check(
      'every row names its callsign, distance and provenance',
      view.rows.length > 0 &&
        view.rows.every(
          (row) =>
            row.id &&
            /^[A-Z0-9/-]+$/.test(row.callsign) &&
            /km$/.test(row.lead.trim()) &&
            row.provenance.trim().length > 0,
        ),
      `first=${JSON.stringify(view.rows[0])}`,
    );
    check(
      'the rows are ordered nearest first',
      view.rows
        .map((row) => Number.parseFloat(row.lead))
        .every((value, index, all) => index === 0 || all[index - 1] <= value),
      view.rows
        .slice(0, 5)
        .map((row) => row.lead)
        .join(' '),
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'repeaters-cologne.png'),
    });

    // (v) the band and kind filters
    section('(v) FILTERS — kind and band narrow the visible set in place');
    const baselineCount = loadedCount;
    const baselineVisible = view.state?.filteredCount ?? 0;
    check(
      'the unfiltered view shows every loaded repeater',
      view.state?.filter?.kind === 'all' &&
        view.state?.filter?.band === 'all' &&
        baselineVisible === baselineCount &&
        view.selectsDisabled === false,
      `filter=${JSON.stringify(view.state?.filter)} visible=${baselineVisible}/${baselineCount}`,
    );

    /** Apply one select and read back what the whole surface did. */
    async function applyFilter(selectId, value, expect) {
      await page.select(`#${selectId}`, value);
      const applied = await waitFor(
        page,
        (key, wanted) => {
          const module =
            window.__godsEyeView?.dataManager?.layers?.get(
              'ham-repeaters',
            )?.module;
          return module?.getUIState?.()?.filter?.[key] === wanted;
        },
        { timeout: 15_000, args: [expect.key, expect.value] },
      );
      const after = await snapshot(page);
      return {
        applied,
        visible: after.state?.filteredCount ?? -1,
        count: after.state?.count ?? -1,
        markers: after.visibleMarkers,
        rows: after.rows.length,
        filter: after.state?.filter,
        summary: after.summary,
      };
    }

    const fm = await applyFilter('ham-repeaters-kind', 'FM', {
      key: 'kind',
      value: 'FM',
    });
    const dstar = await applyFilter('ham-repeaters-kind', 'D-STAR', {
      key: 'kind',
      value: 'D-STAR',
    });
    await applyFilter('ham-repeaters-kind', 'all', {
      key: 'kind',
      value: 'all',
    });
    const band70 = await applyFilter('ham-repeaters-band', '70cm', {
      key: 'band',
      value: '70cm',
    });
    const band2 = await applyFilter('ham-repeaters-band', '2m', {
      key: 'band',
      value: '2m',
    });
    const samples = [fm, dstar, band70, band2];

    check(
      'both selects apply their filter to the layer',
      samples.every((sample) => sample.applied),
      samples
        .map((sample) => `${JSON.stringify(sample.filter)}=${sample.visible}`)
        .join(' '),
    );
    check(
      'no filter ever exceeds the unfiltered count',
      samples.every(
        (sample) => sample.visible >= 0 && sample.visible <= baselineVisible,
      ),
      `baseline=${baselineVisible} samples=${samples.map((sample) => sample.visible).join(',')}`,
    );
    check(
      'filtering never refetches: the loaded total is untouched',
      samples.every((sample) => sample.count === baselineCount),
      `baseline=${baselineCount} counts=${samples.map((sample) => sample.count).join(',')}`,
    );
    check(
      'FM and D-STAR partition the loaded set',
      fm.visible + dstar.visible === baselineCount,
      `fm=${fm.visible} dstar=${dstar.visible} total=${baselineCount}`,
    );
    check(
      'at least one filter genuinely changes the visible count',
      samples.some((sample) => sample.visible !== baselineVisible),
      samples.map((sample) => sample.visible).join(','),
    );
    check(
      'markers follow the filter',
      samples.every((sample) => sample.markers === sample.visible),
      samples.map((sample) => `${sample.markers}/${sample.visible}`).join(' '),
    );
    check(
      'list rows follow the filter',
      samples.every(
        (sample) => sample.rows === Math.min(sample.visible, PANEL_LIST_LIMIT),
      ),
      samples.map((sample) => `${sample.rows}/${sample.visible}`).join(' '),
    );
    check(
      'the summary reports visible/total while filtered',
      new RegExp(`^${band2.visible}/${baselineCount} repeaters`).test(
        band2.summary || '',
      ),
      `summary=${JSON.stringify(band2.summary)}`,
    );

    await applyFilter('ham-repeaters-band', 'all', {
      key: 'band',
      value: 'all',
    });
    view = await snapshot(page);
    check(
      'clearing the filters restores the full set',
      view.state?.filteredCount === baselineVisible &&
        view.visibleMarkers === baselineVisible,
      `visible=${view.state?.filteredCount} markers=${view.visibleMarkers}`,
    );

    // (vi) selection and provenance
    section(
      '(vi) SELECT — a list row selects its repeater with its provenance',
    );
    const target = view.rows[0];
    await page.click('#ham-repeaters-list .ham-repeaters-row');
    const selected = await waitFor(
      page,
      (id) => {
        window.__godsEyeView?.viewer?.scene?.requestRender?.();
        const module =
          window.__godsEyeView?.dataManager?.layers?.get(
            'ham-repeaters',
          )?.module;
        return module?.getUIState?.()?.selectedId === id;
      },
      { timeout: 20_000, args: [target?.id] },
    );
    view = await snapshot(page);
    const selectedRow = view.rows.find((row) => row.id === target?.id) || null;
    check(
      'clicking the first row selects that repeater',
      selected &&
        view.state?.selectedId === target?.id &&
        view.state?.selected?.callsign === target?.callsign,
      `wanted=${target?.id}/${target?.callsign} got=${view.state?.selectedId}/${view.state?.selected?.callsign}`,
    );
    check(
      'the selected row is marked for assistive technology',
      Boolean(selectedRow?.selected) && selectedRow?.ariaSelected === 'true',
      `selected=${selectedRow?.selected} aria=${selectedRow?.ariaSelected}`,
    );
    check(
      'the row provenance names the source and the confidence',
      Boolean(target?.provenance) &&
        target.provenance.includes(view.state?.selected?.sourceLabel || ' ') &&
        target.provenance.includes(view.state?.selected?.confidence || ' '),
      `provenance=${JSON.stringify(target?.provenance)}`,
    );
    check(
      'the selection marker label ends with the same provenance line',
      typeof view.selectedLabel === 'string' &&
        view.selectedLabel.split('\n').length === 3 &&
        view.selectedLabel.split('\n')[2] === target?.provenance &&
        view.selectedLabel.startsWith(view.state?.selected?.callsign || ' '),
      `label=${JSON.stringify(view.selectedLabel)}`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'repeaters-selection.png'),
    });

    // (vii) attribution
    section('(vii) CREDIT — HamRig appears in the Data attribution popover');
    const credit = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const display = viewer.creditDisplay;
      const registered = (display._staticCredits || []).map(
        (entry) => entry.html || '',
      );
      display.showLightbox();
      viewer.scene.requestRender();
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      const box = document.querySelector('.cesium-credit-lightbox');
      const lightboxText = box?.textContent || '';
      const hrefs = [...(box?.querySelectorAll('a') || [])].map(
        (link) => link.href,
      );
      return {
        registered,
        lightboxText,
        hrefs,
        visible: Boolean(box?.offsetParent),
      };
    });
    check(
      'the HamRig repeater credit is registered',
      credit.registered.some(
        (html) => html.includes('HamRig') && html.includes('Repeaters:'),
      ),
      `${credit.registered.length} static credits`,
    );
    check(
      'the credit names both directories and the directory-data caveat',
      credit.registered.some(
        (html) =>
          html.includes('hearham.com') &&
          html.includes('dstarinfo.com') &&
          html.includes('directory data, not radio coverage'),
      ),
    );
    check(
      'the Data attribution lightbox shows the HamRig credit',
      credit.visible &&
        credit.lightboxText.includes('HamRig') &&
        credit.hrefs.some((href) => href.startsWith('https://hamrig.com')),
      `visible=${credit.visible} hamrigLink=${credit.hrefs.some((href) => href.startsWith('https://hamrig.com'))}`,
    );
    await page.screenshot({
      path: path.join(SHOTS_DIR, 'repeaters-attribution.png'),
    });
    await page.evaluate(() =>
      window.__godsEyeView.viewer.creditDisplay.hideLightbox(),
    );

    // (viii) runtime hygiene
    section('(viii) RUNTIME — the run leaves a clean console');
    await sleep(500);
    const actionable = consoleErrors.filter(
      (message) =>
        !/api\.cesium\.com/.test(message) &&
        !(cesiumIonFailures.length > 0 && /net::ERR_FAILED/.test(message)),
    );
    if (cesiumIonFailures.length > 0)
      console.log(
        `INFO external Cesium ion endpoint unavailable (${cesiumIonFailures.length}); repeater assertions continued against the loaded app`,
      );
    check(
      'runtime console remains clean',
      actionable.length === 0,
      actionable.slice(0, 3).join(' | '),
    );
    check(
      'runtime has no HTTP 5xx responses',
      failedResponses.length === 0,
      failedResponses.slice(0, 3).join(' | '),
    );
  } finally {
    await browser.close();
  }

  const failures = results.filter((result) => !result.ok).length;
  console.log(`\n${'-'.repeat(64)}`);
  console.log(
    `  RESULT: ${results.length - failures} passed, ${failures} failed` +
      `${FIXTURES ? ' (fixtures — UI contract only)' : ''}`,
  );
  console.log(`  Broker requests: ${repeaterRequests.length}`);
  console.log(`  Shots : ${SHOTS_DIR}/repeaters-*.png`);
  console.log(`${'-'.repeat(64)}\n`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(`${RED}Harness error:${RESET}`, error);
  process.exit(3);
});
