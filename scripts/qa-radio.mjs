#!/usr/bin/env node
// Cesium-only probes: native flight interception and entity sentinels verify Cesium camera ownership.
import { evaluateWithGeo } from './qa/geometry.mjs';
/**
 * Deterministic browser proof for the Radio companion layer.
 *
 * Intercepts Radio endpoints with a 750-station fixture, supplies fixed
 * satellite/context support responses, and stubs the
 * browser media `play()` primitive. It proves marker scale/culling, dynamic
 * station-tag filtering, first-click selection, direct-action-only playback, panel/Context
 * independence, restoration without autoplay, responsive UI, and a clean
 * console. Screenshots are written under the gitignored `qa-shots/radio/`.
 *
 * Run: node scripts/qa-radio.mjs --url http://localhost:4193
 */
import { whenSettled, whenFramesDrawn } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stations } from './fixtures/layers/radio.mjs';
import { isExpectedPreviewSetupError } from './qa-browserEvidence.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'qa-shots', 'radio');
const args = process.argv.slice(2);
const option = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const APP_URL = option('--url', process.env.QA_BASE_URL);
if (!APP_URL) throw new Error('Radio QA requires an explicit --url or QA_BASE_URL');
const APP_ORIGIN = new URL(APP_URL).origin;
const expectedPreviewErrors = [];
// Radio owns this harness's keyboard and pointer actions; the welcome dialog
// has its own acceptance harness and must not intercept those gestures.
const RADIO_URL = new URL(APP_URL);
RADIO_URL.searchParams.set('welcome', '0');
const HEADFUL = args.includes('--headful');



const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  const label = ok ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
  console.log(`  [${label}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Radio lives only inside Context; a user reaches its controls by expanding
// Context and then Radio. Returns the prior collapse state so a step can put
// the panels back for the scenarios that follow.
async function revealRadioControls(page, targetId) {
  const prior = await page.evaluate(async (id) => {
    const manager = window.__godsEyeView.styleManager;
    const collapsed = (panelId) => document.getElementById(panelId).classList.contains('collapsed');
    const state = { context: collapsed('global-context-panel'), radio: collapsed('radio-panel') };
    manager.setPanelCollapsed('global-context-panel', false, { explicit: true });
    manager.setPanelCollapsed('radio-panel', false, { explicit: true });
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    document.getElementById(id).scrollIntoView({ block: 'nearest' });
    return state;
  }, targetId);
  await page.waitForSelector(`#${targetId}`, { visible: true });
  return prior;
}

async function restoreRadioPanels(page, prior) {
  await page.evaluate(({ context, radio }) => {
    const manager = window.__godsEyeView.styleManager;
    manager.setPanelCollapsed('radio-panel', radio);
    manager.setPanelCollapsed('global-context-panel', context);
  }, prior);
}

// Native pick buffers and clustered overlay entries settle on rendered frames,
// not on wall-clock sleeps, particularly with software rendering.
async function settleRadioFrames(page) {
  await page.evaluate(() => new Promise((resolve, reject) => {
    let remaining = 4;
    const timeout = setTimeout(() => { remove(); reject(new Error('Radio rendered-frame deadline exceeded')); }, 10_000);
    const remove = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
      if (--remaining === 0) { remove(); clearTimeout(timeout); resolve(); }
      else requestAnimationFrame(() => window.__godsEyeView.engine.render.request());
    });
    window.__godsEyeView.engine.render.request();
  }));
}


async function main() {
  const response = await fetch(APP_URL).catch(() => null);
  if (!response?.ok) {
    console.error(`Dev server not reachable at ${APP_URL}`);
    process.exit(2);
  }
  fs.mkdirSync(SHOTS_DIR, { recursive: true });
  const browser = await launchBrowser({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...(process.platform === 'darwin' ? ['--enable-gpu'] : []), '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--window-size=1440,900'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluateOnNewDocument(() => {
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextPlay = false;
      window.__qaRadioDelayNextFailure = false;
      window.__qaRadioFailNextPlay = false;
      HTMLMediaElement.prototype.play = function play() {
        window.__qaRadioPlayCalls.push(this.src);
        if (window.__qaRadioDelayNextPlay) {
          window.__qaRadioDelayNextPlay = false;
          return new Promise((resolve) => {
            window.__qaReleaseRadioPlay = () => {
              this.dispatchEvent(new Event('playing'));
              resolve();
              delete window.__qaReleaseRadioPlay;
            };
          });
        }
        if (window.__qaRadioDelayNextFailure) {
          window.__qaRadioDelayNextFailure = false;
          return new Promise((resolve, reject) => {
            window.__qaRejectRadioPlay = () => {
              reject(new DOMException('QA delayed broadcaster failure', 'NotSupportedError'));
              delete window.__qaRejectRadioPlay;
            };
          });
        }
        if (window.__qaRadioFailNextPlay) {
          window.__qaRadioFailNextPlay = false;
          return Promise.reject(new DOMException('QA silent broadcaster', 'NotSupportedError'));
        }
        if (this.src.endsWith('/330.mp3') && !window.__qaRadioFailedNearest) {
          window.__qaRadioFailedNearest = true;
          return Promise.reject(new DOMException('QA broadcaster unavailable', 'NotSupportedError'));
        }
        queueMicrotask(() => this.dispatchEvent(new Event('playing')));
        return Promise.resolve();
      };
    });
    // What Radio draws, read through the globe contract (the layer draws
    // engine.movers point and sprite sets, src/layers/radio/render/display.js;
    // there are no Radio Entities, data sources or Cesium clusters any more):
    // set counts from engine.movers.list(), and what is drawn at a point
    // from engine.picker.drillPick (each instance's pickId).
    await page.evaluateOnNewDocument((fixture) => {
      const SETS = ['radio-stations', 'radio-clusters', 'radio-selected', 'radio-bracket'];
      const byId = new Map(fixture.map(([id, lat, lon]) => [id, { lat, lon }]));
      const engine = () => window.__godsEyeView.engine;
      // WGS84 geodetic → Earth-fixed metres.
      const world = (lat, lon, height = 0) => {
        const a = 6378137;
        const e2 = 6.69437999014e-3;
        const phi = (lat * Math.PI) / 180;
        const lambda = (lon * Math.PI) / 180;
        const n = a / Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
        return {
          x: (n + height) * Math.cos(phi) * Math.cos(lambda),
          y: (n + height) * Math.cos(phi) * Math.sin(lambda),
          z: (n * (1 - e2) + height) * Math.sin(phi),
        };
      };
      const api = {
        world,
        stationPosition(id, height = 2.5) {
          const station = byId.get(String(id).replace(/^radio:(selected:)?/, ''));
          return station ? world(station.lat, station.lon, height) : null;
        },
        // Instance counts of the Radio mover sets ({} while none exist).
        counts() {
          const counts = {};
          for (const set of engine().movers.list())
            if (SETS.includes(set.id)) counts[set.id] = set.count;
          return counts;
        },
        anyDrawn() {
          return Object.values(api.counts()).some((count) => count > 0);
        },
        // A world position's canvas point, or null off the canvas.
        canvasPoint(position) {
          const e = engine();
          const screen = position && e.projector.worldToWindow(position);
          if (!screen || !Number.isFinite(screen.x) || !Number.isFinite(screen.y)) return null;
          const rect = e.host.canvas.getBoundingClientRect();
          const point = { x: screen.x, y: screen.y };
          if (point.x < 0 || point.y < 0 || point.x > rect.width || point.y > rect.height) return null;
          return point;
        },
        // The picks at a canvas point: { id, owner } of what the engine drew there.
        picksAt(point, limit = 16) {
          if (!point) return [];
          return (engine().picker.drillPick(point, limit) || []).map((picked) => ({
            id: picked?.id == null ? null : String(picked.id),
            owner: picked?.owner ?? null,
          }));
        },
        // The pick id written to the selected marker, while its set is live.
        selectedMarkerId() {
          if (api.counts()['radio-selected'] !== 1) return null;
          const item = window.__qaRadioInstances?.get('radio-selected')?.[0];
          return item?.pickId ?? null;
        },
        // The station ids a pick finds at each fixture station's canvas
        // point: { front, back } split by whether the station is in front of
        // the horizon. A station culled behind the globe must not be picked.
        drawnStations(limit = 4) {
          const e = engine();
          const front = new Set();
          const back = new Set();
          for (const [id] of byId) {
            const position = api.stationPosition(id);
            const point = api.canvasPoint(position);
            if (!point) continue;
            const ids = new Set(api.picksAt(point, limit).map((pick) => pick.id));
            if (!ids.has(`radio:${id}`)) continue;
            (e.projector.horizonVisible(position) ? front : back).add(id);
          }
          return { front: [...front], back: [...back] };
        },
        // Renders frames until the engine has drawn `count` of them.
        frames(count = 2) {
          const e = engine();
          return new Promise((resolve) => {
            let left = count;
            const timeout = setTimeout(() => { remove(); resolve(); }, 3_000);
            const remove = e.frames.postRender.addEventListener(() => {
              if (--left > 0) return void e.render.request('qa-radio');
              remove();
              clearTimeout(timeout);
              resolve();
            });
            e.render.request('qa-radio');
          });
        },
      };
      window.__qaRadioDrawn = api;
    }, stations.map(({ id, lat, lon }) => [id, lat, lon]));
    await page.setRequestInterception(true);
    let catalogDegraded = false;
    let catalogStations = stations;
    let catalogGeneration = 1;
    let catalogResponseDelayMs = 0;
    page.on('request', (request) => {
      const url = new URL(request.url());

      // Radio QA uses keyless maps; an optional Google token is not offered.
      if (request.method() === 'GET' && url.origin === APP_ORIGIN
        && url.pathname === '/api/google/tiles-token') {
        request.respond({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }

    // These scenarios exercise Context lifecycle and keyboard ownership, not
    // live orbit accuracy. Reuse the tracking suite's fixed element sets so
    // CelesTrak outages cannot invalidate an otherwise clean UI run.
    if (url.origin === APP_ORIGIN
      && ['/api/celestrak/active', '/api/celestrak/starlink'].includes(url.pathname)) {
      const dense = url.pathname.endsWith('/starlink');
      request.respond({
        status: 200,
        contentType: 'text/plain',
        body: (dense ? [
          'STARLINK-1007',
          '1 44713U 19074A   24001.50000000  .00016717  00000-0  10270-3 0  9004',
          '2 44713  53.0000 247.4627 0006703 130.5360 325.0288 15.06000000 12345',
        ] : [
          'ISS (ZARYA)',
          '1 25544U 98067A   24001.50000000  .00016717  00000-0  10270-3 0  9004',
          '2 25544  51.6416 247.4627 0006703 130.5360 325.0288 15.49814310 12345',
        ]).join('\n') + '\n',
      });
      return;
    }
      if (url.origin === APP_ORIGIN && url.pathname === '/api/radio/stations') {
        const response = {
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            stations: catalogStations,
            updatedAt: new Date().toISOString(),
            stale: false,
            degraded: catalogDegraded,
            acceptedGeneration: catalogGeneration,
            catalogInstance: 'qa-harness-instance',
          }),
        };
        const delayMs = catalogResponseDelayMs;
        catalogResponseDelayMs = 0;
        if (delayMs > 0) setTimeout(() => void request.respond(response), delayMs);
        else void request.respond(response);
        return;
      }
      if (url.origin === APP_ORIGIN && /^\/api\/radio\/click\/[^/]+$/.test(url.pathname)) {
        request.respond({ status: 204 });
        return;
      }
      if (url.origin === APP_ORIGIN && url.pathname === '/api/openai/hud-summary') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ summary: 'QA globe ready' }),
        });
        return;
      }
      if (url.origin === APP_ORIGIN && url.pathname === '/api/vessels') {
        request.respond({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            rows: [],
            source: 'AISStream QA',
            status: 'open',
            error: null,
            refreshing: false,
            newestPositionAt: null,
            lastMessageAt: null,
          }),
        });
        return;
      }
      request.continue();
    });
    const consoleErrors = [];
    const failedResponses = [];
    const externalCesiumEndpointFailures = [];
    page.on('console', (message) => {
      if (isExpectedPreviewSetupError(message, { preview: args.includes('--preview'), baseUrl: APP_URL })) {
        expectedPreviewErrors.push('/api/setup/status: 404');
        return;
      }
      if (message.type() === 'error') {
        const sourceUrl = message.location()?.url || '';
        consoleErrors.push(sourceUrl ? `${message.text()} [${sourceUrl}]` : message.text());
      }
    });
    page.on('pageerror', (error) => consoleErrors.push(error.message));
    page.on('requestfailed', (request) => {
      const url = request.url();
      if (/^https:\/\/api\.cesium\.com\/v1\/assets\/1\/endpoint(?:\?|$)/.test(url)) {
        externalCesiumEndpointFailures.push(`${request.failure()?.errorText || 'request failed'} ${url}`);
      }
    });
    page.on('response', (response) => {
      if (response.status() >= 500) {
        failedResponses.push(`HTTP ${response.status()} ${response.url()}`);
      }
    });

    await page.goto(RADIO_URL.href, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForFunction(() => window.__godsEyeView?.dataManager, { timeout: 60_000 });
    await whenSettled(page);
    await page.waitForFunction(() => window.__godsEyeView?.styleManager?._dataManager?.layers?.has('radio'), { timeout: 60_000 });
    await whenSettled(page);
    await page.waitForFunction(() => (
      typeof window.__gevQaRegisterLayer === 'function'
      && typeof window.__gevQaUnregisterLayer === 'function'
    ));
    await page.evaluate(() => {
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.styleManager.setPanelCollapsed('pp-toggles', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('cctv-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', true);
    });

    await page.evaluate(() => {
      const movers = window.__godsEyeView.engine.movers;
      const create = movers.createSet.bind(movers);
      window.__qaRadioInstances = new Map();
      movers.createSet = (options) => {
        const set = create(options);
        if (!options.id.startsWith('radio-')) return set;
        const items = [];
        window.__qaRadioInstances.set(options.id, items);
        const write = set.set.bind(set);
        set.set = (index, fields) => {
          write(index, fields);
          items[index] = { ...items[index], ...fields };
        };
        return set;
      };
    });
    const enablePanels = await revealRadioControls(page, 'radio-enable-btn');
    const enableStartedAt = Date.now();
    await page.click('#radio-enable-btn');
    await page.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.enabled && !state.loading && state.stationCount === 750;
    });
    const enableElapsedMs = Date.now() - enableStartedAt;
    // Later scenarios start from the collapsed rail this step began with.
    await restoreRadioPanels(page, enablePanels);
    const initial = await page.evaluate(() => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const state = module.getUIState();
      const context = document.getElementById('global-context-panel');
      const radio = document.getElementById('radio-panel');
      return {
        state,
        plays: window.__qaRadioPlayCalls.length,
        panelExpanded: !radio.classList.contains('collapsed'),
        contextExpanded: !context.classList.contains('collapsed'),
        nestedInContext: context.contains(radio),
        filterOptions: document.getElementById('radio-filter').options.length,
        filterPalette: Array.from(document.getElementById('radio-filter').options).map((entry) => ({
          id: entry.value,
          label: entry.textContent,
          color: entry.dataset.radioColor,
        })),
        enablePressed: document.getElementById('radio-enable-btn').getAttribute('aria-pressed'),
        fullPlayEnabled: !document.getElementById('radio-play-btn').disabled,
        fullPlayLabel: document.getElementById('radio-play-btn').getAttribute('aria-label'),
        tunerVisible: !document.getElementById('radio-tuner').hidden,
        tunerCount: window.__godsEyeView.styleManager._radioControls._radioTunerStations.length,
        tunerLabel: document.getElementById('radio-tuner-band-label').textContent,
      };
    });
    check('750-station catalog renders within the browser budget', initial.state.stationCount === 750 && enableElapsedMs < 5000, `${enableElapsedMs}ms`);
    check('enable does not autoplay', initial.plays === 0 && initial.state.audioState === 'stopped');
    check(
      'Radio power control reflects the layer manager after the panels collapse again',
      initial.enablePressed === 'true',
    );
    check('dynamic canonical and genre categories reach the UI', initial.filterOptions >= 10, `${initial.filterOptions} options`);
    const musicOption = initial.filterPalette.find((entry) => entry.id === 'music');
    const newsOption = initial.filterPalette.find((entry) => entry.id === 'news');
    check(
      'station-tag options show category-colored circles before their labels',
      initial.filterPalette.every((entry) => entry.label.startsWith('● '))
        && musicOption?.color === '#54d17a'
        && newsOption?.color === '#44adff',
      JSON.stringify({ musicOption, newsOption }),
    );
    check('All is the initial Radio filter', initial.state.filter === 'all' && initial.state.filteredCount === 750, `${initial.state.filteredCount} stations`);
    check(
      'the default All filter exposes a draggable directory tuner band',
      initial.tunerVisible && initial.tunerCount === 750 && initial.tunerLabel === 'DIRECTORY BAND',
      JSON.stringify({ visible: initial.tunerVisible, count: initial.tunerCount, label: initial.tunerLabel }),
    );
    const uncertainPresentation = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const entry = gev.dataManager.layers.get('radio');
      const module = entry.module;
      const stationId = module.getTunerStations(1)[0]?.id || null;
      const selectedBefore = module.getUIState().selected?.id || null;
      const playsBefore = window.__qaRadioPlayCalls.length;
      const camera = gev.viewer.camera;
      const originalFlyTo = window.__godsEyeView.engine.camera.flyTo;
      const flyToCalls = [];
      camera.flyTo = (options) => flyToCalls.push(options);
      const beganTuning = module.beginTuning();
      module.setTuningStatic(false);
      entry.lifecycleUncertain = true;
      module.setLifecyclePresentation({
        lifecycleState: 'enabled',
        enabled: true,
        uncertain: true,
      });
      gev.dataManager.refreshLayerStats();
      const staticResult = module.setTuningStatic(true);
      const filterBefore = module.getUIState().filter;
      const filterControl = document.getElementById('radio-filter');
      const originalPinned = style._radioControls._radioTunerBandPinnedForNavigation;
      const originalPool = style._radioControls._radioTunerPool;
      style._radioControls._radioTunerBandPinnedForNavigation = true;
      filterControl.value = filterBefore === 'news' ? 'all' : 'news';
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const rejectedUIFilter = {
        moduleFilter: module.getUIState().filter,
        controlFilter: filterControl.value,
        pinned: style._radioControls._radioTunerBandPinnedForNavigation,
        poolIdentityPreserved: style._radioControls._radioTunerPool === originalPool,
      };
      style._radioControls._radioTunerBandPinnedForNavigation = originalPinned;
      style._radioControls._radioTunerPool = originalPool;
      const filterResult = module.setFilter('news');
      const toggleResult = await module.togglePlayback({ origin: 'user' });
      const directSelect = module.selectStation(stationId, {
        autoplay: true,
        origin: 'voice',
      });
      const directPlay = await module.play({ origin: 'voice' });
      const directCycle = module.cycleStation(1, {
        autoplay: false,
        rotate: true,
        stationIds: module.getTunerStations(3).map(({ id }) => id),
      });
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const result = {
        presentationActive: module.getUIState().presentationActive,
        markerSourceVisible: window.__qaRadioDrawn.anyDrawn(),
        tunerHidden: document.getElementById('radio-tuner').hidden,
        filterDisabled: document.getElementById('radio-filter').disabled,
        prevDisabled: document.getElementById('radio-prev-btn').disabled,
        playDisabled: document.getElementById('radio-play-btn').disabled,
        volumeDisabled: document.getElementById('radio-volume').disabled,
        fullLabel: document.getElementById('radio-enable-btn').getAttribute('aria-label'),
        fullText: document.getElementById('radio-enable-btn').textContent,
        layerState: document.getElementById('radio-layer-state').textContent,
        playbackMessage: document.getElementById('radio-playback-state').textContent,
        dataRailText: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.textContent,
        dataRailState: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.dataset.feedState,
        dataRailLabel: document.querySelector('[data-layer-id="radio"] .data-toggle-btn')?.getAttribute('aria-label'),
        dataRailMeta: document.querySelector('[data-layer-id="radio"] .data-toggle-meta')?.textContent,
        directSelect,
        directPlay,
        directCycle,
        beganTuning,
        staticResult,
        tuningActive: module.getUIState().tuningActive,
        tuningStatic: module.getUIState().tuningStatic,
        filterBefore,
        rejectedUIFilter,
        filterResult,
        filterAfter: module.getUIState().filter,
        toggleResult,
        flyToCalls: flyToCalls.length,
        selectedBefore,
        selectedAfter: module.getUIState().selected?.id || null,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      entry.lifecycleUncertain = false;
      module.setLifecyclePresentation({
        lifecycleState: 'enabled',
        enabled: true,
        uncertain: false,
      });
      gev.dataManager.refreshLayerStats();
      module.cancelTuning();
      camera.flyTo = originalFlyTo;
      return result;
    });
    check(
      'uncertain settled-ON Radio remains hidden and inert until manager reconciliation',
      uncertainPresentation.presentationActive === false
        && uncertainPresentation.markerSourceVisible === false
        && uncertainPresentation.tunerHidden
        && uncertainPresentation.filterDisabled
        && uncertainPresentation.prevDisabled
        && uncertainPresentation.playDisabled
        && uncertainPresentation.volumeDisabled
        && /uncertain/i.test(uncertainPresentation.fullLabel)
        && uncertainPresentation.fullText === 'RECONCILE'
        && uncertainPresentation.layerState === 'UNCERTAIN'
        && /uncertain/i.test(uncertainPresentation.playbackMessage)
        && uncertainPresentation.dataRailText === 'UNCERTAIN'
        && uncertainPresentation.dataRailState === 'uncertain'
        && /uncertain/i.test(uncertainPresentation.dataRailLabel)
        && /uncertain/i.test(uncertainPresentation.dataRailMeta)
        && uncertainPresentation.directSelect === false
        && uncertainPresentation.directPlay === false
        && uncertainPresentation.directCycle === false
        && uncertainPresentation.beganTuning
        && uncertainPresentation.staticResult === false
        && uncertainPresentation.tuningActive
        && uncertainPresentation.tuningStatic === false
        && uncertainPresentation.filterResult === false
        && uncertainPresentation.filterAfter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.moduleFilter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.controlFilter === uncertainPresentation.filterBefore
        && uncertainPresentation.rejectedUIFilter.pinned
        && uncertainPresentation.rejectedUIFilter.poolIdentityPreserved
        && uncertainPresentation.toggleResult === false
        && uncertainPresentation.flyToCalls === 0
        && uncertainPresentation.selectedAfter === uncertainPresentation.selectedBefore
        && uncertainPresentation.playDelta === 0,
      JSON.stringify(uncertainPresentation),
    );
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const module = gev.dataManager.layers.get('radio').module;
      const originalDisable = module.disable.bind(module);
      module.disable = async (...args) => {
        window.__qaRadioDisableStarted = true;
        await new Promise((resolve) => { window.__qaReleaseRadioDisable = resolve; });
        module.disable = originalDisable;
        return originalDisable(...args);
      };
      window.__qaRadioDisablePromise = gev.dataManager.setEnabled('radio', false, { origin: 'qa-setup' });
    });
    await page.waitForFunction(() => window.__qaRadioDisableStarted === true);
    const disablingPresentation = await page.evaluate(() => ({
      manager: window.__godsEyeView.dataManager.getLayerLifecycleState('radio'),
      presentationActive: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().presentationActive,
      markerSourceVisible: window.__qaRadioDrawn.anyDrawn(),
      full: document.getElementById('radio-enable-btn').textContent,
      layerState: document.getElementById('radio-layer-state').textContent,
      message: document.getElementById('radio-playback-state').textContent,
      stopDisabled: document.getElementById('radio-stop-btn').disabled,
      volumeDisabled: document.getElementById('radio-volume').disabled,
    }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'lifecycle-disabling.png') });
    check(
      'Radio teardown exposes DISABLING while settled visibility remains ON',
      disablingPresentation.manager.enabled === true
        && disablingPresentation.manager.lifecycleState === 'disabling'
        && disablingPresentation.presentationActive === false
        && disablingPresentation.markerSourceVisible === false
        && disablingPresentation.full === 'DISABLING'
        && disablingPresentation.layerState === 'DISABLING'
        && /disabling/i.test(disablingPresentation.message)
        && disablingPresentation.stopDisabled
        && disablingPresentation.volumeDisabled,
      JSON.stringify(disablingPresentation),
    );
    await page.evaluate(async () => {
      window.__qaReleaseRadioDisable();
      await window.__qaRadioDisablePromise;
      delete window.__qaReleaseRadioDisable;
      delete window.__qaRadioDisablePromise;
      delete window.__qaRadioDisableStarted;
    });
    const explicitRevealBefore = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      gev.styleManager.setPanelCollapsed('global-context-panel', false);
      gev.styleManager.setPanelCollapsed('radio-panel', false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const radio = document.getElementById('radio-panel');
      scroller.scrollTop = Math.max(0, radio.offsetTop - scroller.clientHeight + 70);
      const camera = window.__godsEyeView.engine.camera.pose().position;
      return {
        scrollTop: scroller.scrollTop,
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        plays: window.__qaRadioPlayCalls.length,
      };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'explicit-enable-before.png') });
    // A warm accepted catalog makes re-enable legitimately synchronous: there
    // may be no station request for the interception delay below to hold. Gate
    // the real module enable boundary instead so the manager's ENABLING state
    // is observed deterministically without slowing production behavior.
    await page.evaluate(() => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const originalEnable = radio.enable;
      let release;
      const gate = new Promise((resolve) => { release = resolve; });
      radio.enable = async function qaGatedRadioEnable(...args) {
        await gate;
        return originalEnable.apply(this, args);
      };
      window.__qaReleaseRadioEnable = () => release();
      window.__qaRestoreRadioEnable = () => { radio.enable = originalEnable; };
    });
    await page.focus('#radio-enable-btn');
    await page.click('#radio-enable-btn');
    await page.waitForFunction(() => (
      window.__godsEyeView.dataManager.getLayerLifecycleState('radio')?.lifecycleState === 'enabling'
    ));
    const enablingPresentation = await page.evaluate(() => ({
      manager: window.__godsEyeView.dataManager.getLayerLifecycleState('radio'),
      presentationActive: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().presentationActive,
      markerSourceVisible: window.__qaRadioDrawn.anyDrawn(),
      full: document.getElementById('radio-enable-btn').textContent,
      layerState: document.getElementById('radio-layer-state').textContent,
      message: document.getElementById('radio-playback-state').textContent,
      tunerHidden: document.getElementById('radio-tuner').hidden,
      stopDisabled: document.getElementById('radio-stop-btn').disabled,
      volumeDisabled: document.getElementById('radio-volume').disabled,
    }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'lifecycle-enabling.png') });
    check(
      'Radio activation exposes ENABLING while settled visibility remains OFF',
      enablingPresentation.manager.enabled === false
        && enablingPresentation.manager.lifecycleState === 'enabling'
        && enablingPresentation.presentationActive === false
        && enablingPresentation.markerSourceVisible === false
        && enablingPresentation.full === 'ENABLING'
        && enablingPresentation.layerState === 'ENABLING'
        && /enabling/i.test(enablingPresentation.message)
        && enablingPresentation.tunerHidden
        && enablingPresentation.stopDisabled
        && enablingPresentation.volumeDisabled,
      JSON.stringify(enablingPresentation),
    );
    await page.evaluate(() => window.__qaReleaseRadioEnable?.());
    await page.waitForFunction(() => window.__godsEyeView.dataManager.isEnabled('radio'));
    await page.evaluate(() => window.__qaRestoreRadioEnable?.());
    await page.waitForFunction(() => {
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const viewport = scroller.getBoundingClientRect();
      const directory = document.querySelector('#radio-panel .radio-directory-row').getBoundingClientRect();
      const play = document.getElementById('radio-play-btn').getBoundingClientRect();
      return directory.top >= viewport.top && directory.bottom <= viewport.bottom
        && play.top >= viewport.top && play.bottom <= viewport.bottom;
    }, { timeout: 10_000 });
    const explicitRevealAfter = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const viewport = scroller.getBoundingClientRect();
      const directory = document.querySelector('#radio-panel .radio-directory-row').getBoundingClientRect();
      const play = document.getElementById('radio-play-btn').getBoundingClientRect();
      const camera = window.__godsEyeView.engine.camera.pose().position;
      return {
        scrollTop: scroller.scrollTop,
        pageY: window.scrollY,
        camera: { x: camera.x, y: camera.y, z: camera.z },
        directoryVisible: directory.top >= viewport.top && directory.bottom <= viewport.bottom,
        playVisible: play.top >= viewport.top && play.bottom <= viewport.bottom,
        focusId: document.activeElement?.id,
        plays: window.__qaRadioPlayCalls.length,
        audioState: gev.dataManager.layers.get('radio').module.getUIState().audioState,
      };
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'explicit-enable-after.png') });
    const revealCameraDelta = Math.hypot(
      explicitRevealAfter.camera.x - explicitRevealBefore.camera.x,
      explicitRevealAfter.camera.y - explicitRevealBefore.camera.y,
      explicitRevealAfter.camera.z - explicitRevealBefore.camera.z,
    );
    check(
      'expanded Radio Enable reveals the directory and Play inside Context without autoplay or focus/camera theft',
      explicitRevealAfter.scrollTop > explicitRevealBefore.scrollTop
        && explicitRevealAfter.directoryVisible && explicitRevealAfter.playVisible
        && explicitRevealAfter.focusId === 'radio-enable-btn'
        && explicitRevealAfter.pageY === explicitRevealBefore.pageY
        && revealCameraDelta < 0.01
        && explicitRevealAfter.plays === explicitRevealBefore.plays
        && explicitRevealAfter.audioState === 'stopped',
      JSON.stringify({ before: explicitRevealBefore, after: explicitRevealAfter, cameraDelta: revealCameraDelta }),
    );
    await page.evaluate(() => {
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', true);
    });
    const singletonViews = [];
    const singletonViewSpecs = [
      { category: 'news', lon: -174 },
      { category: 'public-safety', lon: -138 },
      { category: 'weather', lon: -150 },
      { category: 'all', lon: -174 },
    ];
    for (const spec of singletonViewSpecs) {
      await page.select('#radio-filter', spec.category);
      for (const view of [
        { name: 'global', height: 24_200_000, limit: 16 },
        { name: 'near', height: 500_000, limit: 32 },
      ]) {
        await evaluateWithGeo(page, async (qaGeo, { lon, height }) => {
          window.__godsEyeView.engine.camera.cancelFlight();
          window.__godsEyeView.engine.camera.setView({
            destination: qaGeo.cartographic.toCartesian({
              longitude: lon * Math.PI / 180,
              latitude: 6 * Math.PI / 180,
              height,
            }),
            orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
          });
          window.__godsEyeView.engine.render.request();
        }, { lon: spec.lon, height: view.height });
        await whenFramesDrawn(page);
        await settleRadioFrames(page);
        const sample = await page.evaluate(async () => {
          const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
          const drawn = window.__qaRadioDrawn;
          const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
          return new Promise((resolve) => {
            let removePostRender = null;
            const finish = () => {
              removePostRender?.();
              const overlay = radio.getOverlayDiagnostics();
              const paintedSingletonIds = overlay.singletonIds.filter((entryId) => Boolean(getOverlayPaintRect('radio', entryId)));
              const pickableSingletonIds = paintedSingletonIds.filter((entryId) => {
                const rect = getOverlayPaintRect('radio', entryId);
                const anchor = drawn.canvasPoint(rect?.entry?.position);
                if (!anchor) return false;
                return drawn.picksAt(anchor, 16)
                  .some((picked) => picked.id === `radio:${entryId.slice('station:'.length)}`);
              });
              resolve({
                overlay,
                host: getWorldOverlayDiagnostics(),
                paintedSingletonIds,
                pickableSingletonIds,
                // Radio draws no text on the globe itself: no engine line or
                // label belongs to it (the old check counted native entity labels).
                radioLines: window.__godsEyeView.engine.lines.list().filter((line) => /^radio/.test(line.id)).length,
              });
            };
            const timeout = setTimeout(finish, 500);
            removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
              clearTimeout(timeout);
              finish();
            });
            window.__godsEyeView.engine.render.request();
          });
        });
        singletonViews.push({ ...spec, ...view, ...sample });
        await page.screenshot({
          path: path.join(SHOTS_DIR, `singleton-${spec.category}-${view.name}.png`),
        });
      }
    }
    const sparseSingletonViews = singletonViews.filter((sample) => sample.category !== 'all');
    check(
      'sparse Radio filters paint bounded individual labels through the shared ambient lane',
      sparseSingletonViews.every((sample) => (
        sample.overlay.singletonIds.length > 0
        && sample.overlay.singletonIds.length <= sample.limit
        && sample.paintedSingletonIds.length > 0
        && sample.pickableSingletonIds.length === sample.paintedSingletonIds.length
        && sample.host.entriesBySource?.radio === sample.overlay.entryCount
      )),
      JSON.stringify(sparseSingletonViews.map((sample) => ({
        category: sample.category,
        view: sample.name,
        singletonCount: sample.overlay.singletonIds.length,
        painted: sample.paintedSingletonIds.length,
        pickable: sample.pickableSingletonIds.length,
      }))),
    );
    check(
      'Radio label allocation stays bounded with no globe-drawn Radio text across sparse and All views',
      singletonViews.every((sample) => (
        sample.overlay.entryCount <= 65
        && sample.radioLines === 0
        && sample.host.paintedBySource?.radio > 0
      )),
      JSON.stringify(singletonViews.map((sample) => ({
        category: sample.category,
        view: sample.name,
        entries: sample.overlay.entryCount,
        radioLines: sample.radioLines,
        painted: sample.host.paintedBySource?.radio,
      }))),
    );
    const userFacingFailures = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const styleManager = gev.styleManager;
      const dataManager = gev.dataManager;
      const unhandled = [];
      const onUnhandled = (event) => {
        unhandled.push(String(event.reason?.message || event.reason || 'unknown'));
        event.preventDefault();
      };
      window.addEventListener('unhandledrejection', onUnhandled);
      const originalToggle = dataManager.toggle;
      const originalSetEnabled = dataManager.setEnabled;
      const originalRestoreEnabledLayerIds = dataManager.restoreEnabledLayerIds;
      const originalIsEnabled = dataManager.isEnabled;
      const originalIsEffectivelyEnabled = dataManager.isEffectivelyEnabled;
      const originalClear = styleManager._contextControls._clearLayersOutsideContextMode;
      const originalCapture = styleManager._contextControls._captureContextSessionSnapshot;
      const originalContextMode = styleManager._contextControls._contextMode;
      const originalSnapshot = styleManager._contextControls._contextSessionSnapshot;
      const originalShowToast = styleManager._showToast;
      const installations = dataManager.layers.get('military-installations')?.module;
      const originalSearchNearby = installations?.searchNearby;
      try {
        dataManager.setEnabled = async () => false;
        document.getElementById('radio-enable-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const semanticFalseMessage = document.getElementById('toast').textContent;

        const enabled = new Set();
        styleManager._contextControls._captureContextSessionSnapshot = () => {};
        const runContextFailure = async (mode, phase, outcome) => {
          enabled.clear();
          enabled.add('local-datacenters');
          styleManager._contextControls._contextMode = null;
          styleManager._contextControls._contextSessionSnapshot = {
            enabledLayerIds: new Set(enabled),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          let failureUsed = false;
          const entryLayerId = mode === 'flights' ? 'military-awareness' : 'rocket-launches';
          dataManager.setEnabled = async (layerId, shouldEnable) => {
            const failsIsolation = phase === 'isolation' && layerId === 'local-datacenters' && !shouldEnable;
            const failsActivation = phase === 'activation' && layerId === entryLayerId && shouldEnable;
            if (!failureUsed && (failsIsolation || failsActivation)) {
              failureUsed = true;
              if (outcome === 'reject') throw new Error(`QA ${phase} rejection`);
              return false;
            }
            shouldEnable ? enabled.add(layerId) : enabled.delete(layerId);
            return true;
          };
          const result = await styleManager._runUserFacingContextAction(
            () => styleManager._contextControls._selectContextMode(mode),
            `${mode} QA transition failed`,
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
          return {
            mode,
            phase,
            outcome,
            result,
            visibleMode: styleManager._contextControls._contextMode,
            snapshotCleared: styleManager._contextControls._contextSessionSnapshot === null,
            priorLayerRestored: enabled.has('local-datacenters'),
            entryEnabled: enabled.has(entryLayerId),
            flightsButtonDisabled: document.getElementById('global-context-flights-btn').disabled,
            missionsButtonDisabled: document.getElementById('global-context-missions-btn').disabled,
            message: document.getElementById('toast').textContent,
          };
        };
        dataManager.isEnabled = (layerId) => enabled.has(layerId);
        // The fake manager model must answer the effective-visibility accessor
        // the isolation loop consults, or real entries (all disabled) leak in.
        dataManager.isEffectivelyEnabled = (layerId) => enabled.has(layerId);
        dataManager.restoreEnabledLayerIds = async (enabledLayerIds, { excludeLayerIds = [] } = {}) => {
          const target = new Set(enabledLayerIds || []);
          const excluded = new Set(excludeLayerIds || []);
          const layerIds = new Set([...enabled, ...target]);
          for (const candidateId of layerIds) {
            if (excluded.has(candidateId)) continue;
            const restored = await dataManager.setEnabled(candidateId, target.has(candidateId));
            if (restored === false) {
              throw new Error(`Failed to restore layer "${candidateId}" visibility`);
            }
          }
        };
        const contextFailures = [];
        for (const mode of ['flights', 'space-missions']) {
          for (const phase of ['isolation', 'activation']) {
            for (const outcome of ['false', 'reject']) {
              contextFailures.push(await runContextFailure(mode, phase, outcome));
            }
          }
        }

        const directEntryFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          for (const outcome of ['false', 'reject']) {
            enabled.clear();
            enabled.add('local-datacenters');
            styleManager._contextControls._contextMode = null;
            styleManager._contextControls._contextSessionSnapshot = {
              enabledLayerIds: new Set(enabled),
              userAdded: new Set(),
              userRemoved: new Set(),
              params: {},
            };
            let failureUsed = false;
            const toastMessages = [];
            styleManager._showToast = (message) => {
              toastMessages.push(message);
              originalShowToast.call(styleManager, message);
            };
            dataManager.setEnabled = async (candidateId, shouldEnable, options = {}) => {
              if (!failureUsed && candidateId === 'local-datacenters' && !shouldEnable) {
                failureUsed = true;
                styleManager._contextControls._handleContextLayerChange({
                  type: 'visibility-failed',
                  layerId: candidateId,
                  enabled: shouldEnable,
                  notificationToken: options.notificationToken,
                  origin: 'user',
                });
                if (outcome === 'reject') throw new Error('QA direct isolation rejection');
                return false;
              }
              shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
              return true;
            };
            const reason = await dataManager._visibilityBlockReason({
              type: 'visibility-will-change',
              layerId,
              enabled: true,
              origin: 'user',
            });
            styleManager._contextControls._handleContextLayerChange({
              type: 'visibility-blocked',
              layerId,
              enabled: true,
              origin: 'user',
              reason,
            });
            const priorLayerRestored = enabled.has('local-datacenters');
            const retryReason = await dataManager._visibilityBlockReason({
              type: 'visibility-will-change',
              layerId,
              enabled: true,
              origin: 'user',
            });
            directEntryFailures.push({
              layerId,
              outcome,
              reason,
              retryReason,
              toastMessages,
              mode: styleManager._contextControls._contextMode,
              snapshotCleared: styleManager._contextControls._contextSessionSnapshot === null,
              priorLayerRestored,
              modeChanging: styleManager._contextControls._contextModeChanging,
            });
          }
        }
        styleManager._showToast = originalShowToast;

        const directActivationFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          enabled.clear();
          styleManager._contextControls._contextMode = null;
          styleManager._contextControls._contextSessionSnapshot = {
            enabledLayerIds: new Set(['local-datacenters']),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          dataManager.setEnabled = async (candidateId, shouldEnable) => {
            shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
            return true;
          };
          styleManager._contextControls._handleContextLayerChange({
            type: 'visibility-failed',
            layerId,
            enabled: true,
            origin: 'user',
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          directActivationFailures.push({
            layerId,
            mode: styleManager._contextControls._contextMode,
            snapshotCleared: styleManager._contextControls._contextSessionSnapshot === null,
            priorLayerRestored: enabled.has('local-datacenters'),
            failedLayerDisabled: !enabled.has(layerId),
          });
        }

        const directActivationRollbackFailures = [];
        for (const layerId of ['military-awareness', 'rocket-launches']) {
          enabled.clear();
          styleManager._contextControls._contextMode = null;
          styleManager._contextControls._contextSessionSnapshot = {
            enabledLayerIds: new Set(['local-datacenters']),
            userAdded: new Set(),
            userRemoved: new Set(),
            params: {},
          };
          const toastMessages = [];
          const showToastBeforeRollbackFailure = styleManager._showToast;
          styleManager._showToast = (message) => {
            toastMessages.push(message);
            showToastBeforeRollbackFailure.call(styleManager, message);
          };
          dataManager.setEnabled = async (candidateId, shouldEnable) => {
            if (candidateId === 'local-datacenters' && shouldEnable) return false;
            shouldEnable ? enabled.add(candidateId) : enabled.delete(candidateId);
            return true;
          };
          styleManager._contextControls._handleContextLayerChange({
            type: 'visibility-failed',
            layerId,
            enabled: true,
            origin: 'user',
          });
          await new Promise((resolve) => setTimeout(resolve, 50));
          styleManager._showToast = showToastBeforeRollbackFailure;
          directActivationRollbackFailures.push({
            layerId,
            toastMessages,
            retryRetained: styleManager._contextControls._contextSessionSnapshot?.enabledLayerIds?.has('local-datacenters') === true,
          });
        }

        const contextExitFailures = [];
        dataManager.setEnabled = originalSetEnabled;
        dataManager.restoreEnabledLayerIds = originalRestoreEnabledLayerIds;
        dataManager.isEnabled = originalIsEnabled;
        dataManager.isEffectivelyEnabled = originalIsEffectivelyEnabled;
        for (const outcome of ['false', 'reject']) {
          const layerId = `qa-context-exit-${outcome}`;
          let enableOutcome = outcome;
          const toastMessages = [];
          const qaLayer = {
            id: layerId,
            name: `QA Context exit ${outcome}`,
            updateInterval: -1,
            init: async () => true,
            enable: async () => {
              if (enableOutcome === 'reject') throw new Error(`QA Context exit ${outcome}`);
              return enableOutcome !== 'false';
            },
            disable: async () => true,
            update: async () => true,
            destroy: async () => true,
            getStats: () => ({}),
          };
          window.__gevQaRegisterLayer(dataManager, qaLayer);
          try {
            const enabledBeforeExit = dataManager.getEnabledLayerIds();
            styleManager._contextControls._contextMode = 'flights';
            styleManager._contextControls._contextSessionSnapshot = {
              enabledLayerIds: new Set([...enabledBeforeExit, layerId]),
              userAdded: new Set(),
              userRemoved: new Set(),
              params: {},
            };
            styleManager._showToast = (message) => {
              toastMessages.push(message);
              originalShowToast.call(styleManager, message);
            };
            const unhandledBefore = unhandled.length;
            const result = await styleManager._runUserFacingContextAction(
              (notificationToken) => styleManager._contextControls._deactivateContextForLayerChange({ notificationToken }),
              `QA Context exit ${outcome} surfaced once`,
            );
            const retainedForRetry = styleManager._contextControls._contextSessionSnapshot?.enabledLayerIds?.has(layerId) === true;
            enableOutcome = 'success';
            const retryResult = await styleManager._runUserFacingContextAction(
              (notificationToken) => styleManager._contextControls._deactivateContextForLayerChange({ notificationToken }),
              `QA Context exit ${outcome} retry failed`,
            );
            contextExitFailures.push({
              outcome,
              result,
              retryResult: retryResult ?? true,
              toastMessages,
              unhandledDelta: unhandled.length - unhandledBefore,
              retainedForRetry,
              mode: styleManager._contextControls._contextMode,
              modeChanging: styleManager._contextControls._contextModeChanging,
              snapshotClearedAfterRetry: styleManager._contextControls._contextSessionSnapshot === null,
              enabledAfterRetry: dataManager.isEnabled(layerId),
              toastRole: document.getElementById('toast').getAttribute('role'),
              toastLive: document.getElementById('toast').getAttribute('aria-live'),
              toastAtomic: document.getElementById('toast').getAttribute('aria-atomic'),
            });
          } finally {
            styleManager._showToast = originalShowToast;
            await window.__gevQaUnregisterLayer(dataManager, layerId);
          }
        }

        const unrelatedLayerId = 'qa-unrelated-manager-failure';
        const unrelatedToastMessages = [];
        let releasePendingAction = null;
        window.__gevQaRegisterLayer(dataManager, {
          id: unrelatedLayerId,
          name: 'QA unrelated manager failure',
          updateInterval: -1,
          init: async () => true,
          enable: async () => false,
          disable: async () => true,
          update: async () => true,
          destroy: async () => true,
          getStats: () => ({}),
        });
        styleManager._showToast = (message) => {
          unrelatedToastMessages.push(message);
          originalShowToast.call(styleManager, message);
        };
        const pendingAction = styleManager._runUserFacingContextAction(() => (
          new Promise((resolve) => { releasePendingAction = resolve; })
        ));
        while (!releasePendingAction) await new Promise((resolve) => setTimeout(resolve, 0));
        const unrelatedResult = await dataManager.setEnabled(unrelatedLayerId, true);
        releasePendingAction(true);
        await pendingAction;
        styleManager._showToast = originalShowToast;
        await window.__gevQaUnregisterLayer(dataManager, unrelatedLayerId);
        const unrelatedManagerFailure = {
          result: unrelatedResult,
          toastMessages: unrelatedToastMessages,
        };

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) return false;
          return true;
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationFalseMessage = document.getElementById('toast').textContent;
        const installationFalseReleased = document.getElementById('installations-search-btn').getAttribute('aria-busy') === 'false';

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) {
            throw new Error('QA installation enable rejection');
          }
          return true;
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationEnableRejectionMessage = document.getElementById('toast').textContent;
        const installationEnableRejectionReleased = document.getElementById('installations-search-btn').getAttribute('aria-busy') === 'false';

        dataManager.setEnabled = async (layerId, shouldEnable) => {
          if (layerId === 'military-installations' && shouldEnable) enabled.add(layerId);
          return true;
        };
        if (installations) installations.searchNearby = async () => {
          throw new Error('QA installation search rejection');
        };
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationRejectionMessage = document.getElementById('toast').textContent;
        const installationRejectionReleased = document.getElementById('installations-search-btn').getAttribute('aria-busy') === 'false';

        if (installations) installations.searchNearby = async () => false;
        document.getElementById('installations-search-btn').click();
        await new Promise((resolve) => setTimeout(resolve, 50));
        const installationSearchFalseMessage = document.getElementById('toast').textContent;
        const installationSearchFalseReleased = document.getElementById('installations-search-btn').getAttribute('aria-busy') === 'false';
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          semanticFalseMessage,
          contextFailures,
          directEntryFailures,
          directActivationFailures,
          directActivationRollbackFailures,
          contextExitFailures,
          unrelatedManagerFailure,
          installationFalseMessage,
          installationFalseReleased,
          installationEnableRejectionMessage,
          installationEnableRejectionReleased,
          installationRejectionMessage,
          installationRejectionReleased,
          installationSearchFalseMessage,
          installationSearchFalseReleased,
          unhandled,
        };
      } finally {
        dataManager.toggle = originalToggle;
        dataManager.setEnabled = originalSetEnabled;
        dataManager.restoreEnabledLayerIds = originalRestoreEnabledLayerIds;
        dataManager.isEnabled = originalIsEnabled;
        dataManager.isEffectivelyEnabled = originalIsEffectivelyEnabled;
        styleManager._contextControls._clearLayersOutsideContextMode = originalClear;
        styleManager._contextControls._captureContextSessionSnapshot = originalCapture;
        styleManager._contextControls._contextMode = originalContextMode;
        styleManager._contextControls._contextSessionSnapshot = originalSnapshot;
        styleManager._showToast = originalShowToast;
        if (installations) installations.searchNearby = originalSearchNearby;
        window.removeEventListener('unhandledrejection', onUnhandled);
      }
    });
    check(
      'user-facing chip, real Context entry rollback, and installation Search failures settle safely',
      userFacingFailures.semanticFalseMessage === 'Radio could not stop cleanly'
        && userFacingFailures.contextFailures.length === 8
        && userFacingFailures.contextFailures.every((failure) => (
          failure.result === false
          && failure.visibleMode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && !failure.entryEnabled
          && !failure.flightsButtonDisabled
          && !failure.missionsButtonDisabled
          && failure.message.includes('QA transition failed')
        ))
        && userFacingFailures.directEntryFailures.length === 4
        && userFacingFailures.directEntryFailures.every((failure) => (
          failure.reason.includes('could not start')
          && failure.retryReason === null
          && failure.toastMessages.length === 1
          && failure.toastMessages[0] === failure.reason
          && failure.mode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && !failure.modeChanging
        ))
        && userFacingFailures.directActivationFailures.length === 2
        && userFacingFailures.directActivationFailures.every((failure) => (
          failure.mode === null
          && failure.snapshotCleared
          && failure.priorLayerRestored
          && failure.failedLayerDisabled
        ))
        && userFacingFailures.directActivationRollbackFailures.length === 2
        && userFacingFailures.directActivationRollbackFailures.every((failure) => (
          failure.toastMessages.length === 1
          && failure.toastMessages[0] === `${failure.layerId} could not start cleanly`
          && failure.retryRetained
        ))
        && userFacingFailures.contextExitFailures.length === 2
        && userFacingFailures.contextExitFailures.every((failure) => (
          failure.result === false
          && failure.retryResult === true
          && failure.toastMessages.length === 1
          && failure.toastMessages[0].includes('surfaced once')
          && failure.unhandledDelta === 0
          && failure.retainedForRetry
          && failure.mode === null
          && !failure.modeChanging
          && failure.snapshotClearedAfterRetry
          && failure.enabledAfterRetry
          && failure.toastRole === 'status'
          && failure.toastLive === 'polite'
          && failure.toastAtomic === 'true'
        ))
        && userFacingFailures.unrelatedManagerFailure.result === false
        && userFacingFailures.unrelatedManagerFailure.toastMessages.length === 1
        && userFacingFailures.unrelatedManagerFailure.toastMessages[0].includes('qa-unrelated-manager-failure could not start cleanly')
        && userFacingFailures.installationFalseMessage.includes('could not be refreshed')
        && userFacingFailures.installationFalseReleased
        && userFacingFailures.installationEnableRejectionMessage.includes('could not be refreshed')
        && userFacingFailures.installationEnableRejectionReleased
        && userFacingFailures.installationRejectionMessage.includes('could not be refreshed')
        && userFacingFailures.installationRejectionReleased
        && userFacingFailures.installationSearchFalseMessage.includes('could not be refreshed')
        && userFacingFailures.installationSearchFalseReleased
        && userFacingFailures.unhandled.length === 0,
      JSON.stringify(userFacingFailures),
    );
    catalogDegraded = true;
    const degradedCatalog = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      await radio.update();
      return {
        state: radio.getUIState(),
        message: document.getElementById('radio-playback-state').textContent,
      };
    });
    check(
      'degraded Radio catalog remains usable and is labeled explicitly',
      degradedCatalog.state.stationCount === 750
        && degradedCatalog.state.degraded === true
        && degradedCatalog.state.stale === false
        && degradedCatalog.message.includes('degraded directory'),
      JSON.stringify(degradedCatalog),
    );
    catalogDegraded = false;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    await page.select('#radio-filter', 'all');
    const allPalette = await page.evaluate(() => {
      const colorFor = (index) => {
        const id = `radio:00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`;
        const station = window.__qaRadioInstances.get('radio-stations')?.find(item => item.pickId === id);
        return station?.color?.slice(0, 3).map(value => Math.round(value * 255)) ?? null;
      };
      return { news: colorFor(0), talk: colorFor(1), music: colorFor(7) };
    });
    check(
      'All stations use distinct category marker colors and Music is green',
      JSON.stringify(allPalette.news) !== JSON.stringify(allPalette.music)
        && JSON.stringify(allPalette.talk) !== JSON.stringify(allPalette.music)
        && allPalette.music?.[1] > allPalette.music?.[0]
        && allPalette.music?.[1] > allPalette.music?.[2],
      JSON.stringify(allPalette),
    );
    const clusterBadge = await evaluateWithGeo(page, async (qaGeo) => {
      const drawn = window.__qaRadioDrawn;
      const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      // Start from another view, so the clusters at the view below are a new
      // cohort the host must solve (the old check forced one by switching
      // Cesium's clustering off and on).
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: 68 * Math.PI / 180,
          latitude: 7 * Math.PI / 180,
          height: 24_200_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await drawn.frames(3);
      const baselineSolveRevision = getWorldOverlayDiagnostics().solveRevision;
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: -98 * Math.PI / 180,
          latitude: 38 * Math.PI / 180,
          height: 18_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      window.__godsEyeView.engine.render.request();
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      // The layer clusters on screen itself now (render/display.js,
      // ../screenClusters.js) into the radio-clusters point set; the cluster
      // text is a shared-host overlay entry. There is no Cesium cluster
      // label or point to read: a painted cluster entry's anchor must pick
      // a radio-clusters instance instead.
      let painted = null;
      for (let attempt = 0; attempt < 20 && !painted?.rect; attempt += 1) {
        painted = await new Promise((done) => {
          let removePostRender = null;
          const timeout = setTimeout(() => {
            removePostRender?.();
            done({ rect: null, host: getWorldOverlayDiagnostics() });
          }, 150);
          removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            clearTimeout(timeout);
            removePostRender();
            const host = getWorldOverlayDiagnostics();
            let match = null;
            for (const entryId of radio.getOverlayDiagnostics().clusterIds) {
              const rect = getOverlayPaintRect('radio', entryId);
              if (rect) match = { entryId, rect };
            }
            done({
              expectedEntryId: match?.entryId || null,
              rect: match ? { x: match.rect.x, y: match.rect.y, w: match.rect.w, h: match.rect.h } : null,
              position: match?.rect?.entry?.position || null,
              host,
            });
          });
          window.__godsEyeView.engine.render.request();
        });
      }
      const position = typeof painted?.position === 'function' ? painted.position() : painted?.position;
      const anchor = drawn.canvasPoint(position);
      const clusterPick = drawn.picksAt(anchor, 16).find((picked) => picked.owner === 'radio-clusters') || null;
      return {
        drawn: drawn.counts(),
        clusterPick,
        radioLines: window.__godsEyeView.engine.lines.list().filter((line) => /^radio/.test(line.id)).length,
        baselineSolveRevision,
        expectedEntryId: painted?.expectedEntryId || null,
        rect: painted?.rect || null,
        source: radio.getOverlayDiagnostics(),
        host: painted?.host || getWorldOverlayDiagnostics(),
      };
    });
    check(
      'Radio cluster text is native-free and painted through the bounded shared host',
      clusterBadge?.drawn?.['radio-clusters'] > 0
        && clusterBadge?.radioLines === 0
        && /^radio:/.test(clusterBadge?.clusterPick?.id || '')
        && clusterBadge?.source?.clusterTexts?.some((text) => /^\d+\s+[A-Z]/.test(text))
        && clusterBadge?.source?.entryCount <= 65
        && clusterBadge?.host?.entriesBySource?.radio === clusterBadge?.source?.entryCount
        && clusterBadge?.host?.solveRevision > clusterBadge?.baselineSolveRevision
        && clusterBadge?.rect?.w > 0
        && clusterBadge?.rect?.h > 0,
      JSON.stringify(clusterBadge),
    );
    await evaluateWithGeo(page, async (qaGeo) => {
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: 68 * Math.PI / 180,
          latitude: 7 * Math.PI / 180,
          height: 24_200_000,
        }),
        orientation: { heading: 15 * Math.PI / 180, pitch: -Math.PI / 2, roll: 0 },
      });
      window.__godsEyeView.engine.render.request();
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    await settleRadioFrames(page);
    const highGlobalClusterLabels = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const ellipsoid = qaGeo.ellipsoid.WGS84;
      const { getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      const { distanceFade } = await import('/src/overlays/worldOverlayDraw.js');
      const source = radio.getOverlayDiagnostics();
      const cameraPosition = window.__godsEyeView.engine.camera.pose().position;
      const cameraRadius = Math.hypot(cameraPosition.x, cameraPosition.y, cameraPosition.z);
      const horizonDistance = Math.sqrt(Math.max(
        0,
        cameraRadius * cameraRadius - ellipsoid.maximumRadius * ellipsoid.maximumRadius,
      ));
      // The cluster points are the radio-clusters mover set; pick at each
      // painted cluster entry's anchor (nearest the centre first) and accept
      // only a radio-clusters instance.
      const drawn = window.__qaRadioDrawn;
      const { getPaintRect: getOverlayPaintRect } = window.__gevWorldOverlay;
      let clusterPoint = null;
      const width = window.__godsEyeView.engine.host.canvas.clientWidth;
      const height = window.__godsEyeView.engine.host.canvas.clientHeight;
      const anchors = source.clusterIds
        .map((entryId) => getOverlayPaintRect('radio', entryId)?.entry?.position)
        .map((position) => drawn.canvasPoint(typeof position === 'function' ? position() : position))
        .filter(Boolean)
        .sort((a, b) => Math.hypot(a.x - width / 2, a.y - height / 2) - Math.hypot(b.x - width / 2, b.y - height / 2));
      if (anchors.length) {
        const pick = drawn.picksAt(anchors[0], 16).find((picked) => picked.owner === 'radio-clusters');
        clusterPoint = {
          drawn: drawn.counts()['radio-clusters'] ?? 0,
          pickable: Boolean(pick),
        };
      }
      return {
        source,
        host: getWorldOverlayDiagnostics(),
        altitude: window.__godsEyeView.engine.camera.pose().cartographic.height,
        horizonDistance,
        horizonDistanceAlpha: distanceFade(horizonDistance, { maxDistance: 50_000_000 }),
        clusterPoint,
      };
    });
    check(
      'All-filter cluster labels remain visible at a 24,200 km global view',
      highGlobalClusterLabels.altitude > 24_000_000
        && highGlobalClusterLabels.source.clusterIds.length > 0
        && highGlobalClusterLabels.host.projectedCount > 0
        && highGlobalClusterLabels.host.paintedBySource?.radio > 0
        && highGlobalClusterLabels.horizonDistanceAlpha === 1
        && highGlobalClusterLabels.clusterPoint?.drawn > 0
        && highGlobalClusterLabels.clusterPoint?.pickable,
      JSON.stringify(highGlobalClusterLabels),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'high-global-all-labels.png') });
    const clusterContinuity = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      const paintedClusters = () => new Promise((resolve) => {
        let removePostRender = null;
        const timeout = setTimeout(() => {
          removePostRender?.();
          resolve({ clusters: [], fadingCount: -1, host: null, source: null });
        }, 500);
        removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
          clearTimeout(timeout);
          removePostRender();
          const source = radio.getOverlayDiagnostics();
          const host = getWorldOverlayDiagnostics();
          const clusters = source.clusterIds.map((entryId, index) => {
            const rect = getOverlayPaintRect('radio', entryId);
            return rect ? {
              entryId,
              text: source.clusterTexts[index],
              stateless: rect.entry?.stateless === true,
              edgeFade: rect.entry?.edgeFade,
            } : null;
          }).filter(Boolean);
          resolve({
            clusters,
            fadingCount: host.fadingCount,
            host,
            source,
          });
        });
        window.__godsEyeView.engine.render.request();
      });
      const longitudes = [-25, -24, -23, -22, -23, -24, -25];
      const samples = [];
      for (const longitude of longitudes) {
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: longitude * Math.PI / 180,
            latitude: 38 * Math.PI / 180,
            height: 10_000_000,
          }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        window.__godsEyeView.engine.render.request();
        for (const delay of [50, 100, 200, 350]) {
          await new Promise((resolve) => setTimeout(resolve, delay));
          samples.push({ longitude, delay, ...(await paintedClusters()) });
        }
      }
      let retainedAcrossSteps = 0;
      let countChangingRetained = 0;
      const settled = samples.filter((sample) => sample.delay === 350);
      for (let index = 1; index < settled.length; index += 1) {
        const previous = new Map(settled[index - 1].clusters.map((cluster) => [cluster.entryId, cluster.text]));
        for (const cluster of settled[index].clusters) {
          if (!previous.has(cluster.entryId)) continue;
          retainedAcrossSteps += 1;
          if (previous.get(cluster.entryId) !== cluster.text) countChangingRetained += 1;
        }
      }
      return {
        sampleCount: samples.length,
        paintedSamples: samples.filter((sample) => sample.clusters.length > 0).length,
        unpaintedProjectedSamples: samples.filter((sample) => (
          sample.clusters.length === 0 && (sample.host?.projectedCount || 0) > 0
        )).length,
        emptySamples: samples.filter((sample) => sample.clusters.length === 0).map((sample) => ({
          longitude: sample.longitude,
          delay: sample.delay,
          sourceEntries: sample.source?.entryCount,
          hostCandidates: sample.host?.candidateCount,
          hostProjected: sample.host?.projectedCount,
          hostPainted: sample.host?.paintedCount,
          hostFading: sample.host?.fadingCount,
        })),
        fadingSamples: samples.filter((sample) => sample.fadingCount !== 0).map((sample) => ({
          longitude: sample.longitude,
          delay: sample.delay,
          fadingCount: sample.fadingCount,
        })),
        allHardOpacity: samples.every((sample) => sample.clusters.every(
          (cluster) => cluster.stateless && cluster.edgeFade === 'none',
        )),
        retainedAcrossSteps,
        countChangingRetained,
      };
    });
    check(
      'Radio cluster badges remain hard-opacity through one-degree forward/reverse count changes',
      clusterContinuity.sampleCount === 28
        && clusterContinuity.paintedSamples > 0
        && clusterContinuity.unpaintedProjectedSamples === 0
        && clusterContinuity.allHardOpacity
        && clusterContinuity.retainedAcrossSteps > 0
        && clusterContinuity.countChangingRetained > 0,
      JSON.stringify(clusterContinuity),
    );
    const directoryRefreshContinuity = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const before = radio.getOverlayDiagnostics().clusterMemberships;
      await radio.update();
      window.__godsEyeView.engine.render.request();
      await new Promise((resolve) => setTimeout(resolve, 900));
      const after = radio.getOverlayDiagnostics().clusterMemberships;
      const beforeByMembership = new Map(before.map((entry) => [entry.membershipId, entry.entryId]));
      const unchanged = after.filter((entry) => beforeByMembership.has(entry.membershipId));
      return {
        beforeCount: before.length,
        afterCount: after.length,
        unchangedCount: unchanged.length,
        retainedCount: unchanged.filter((entry) => beforeByMembership.get(entry.membershipId) === entry.entryId).length,
      };
    });
    check(
      'unchanged directory refresh membership retains cluster overlay identity',
      directoryRefreshContinuity.beforeCount > 0
        && directoryRefreshContinuity.unchangedCount > 0
        && directoryRefreshContinuity.retainedCount === directoryRefreshContinuity.unchangedCount,
      JSON.stringify(directoryRefreshContinuity),
    );
    await page.select('#radio-filter', 'news');
    check('enabled Radio stays nested in Context and leaves both panels collapsed', !initial.panelExpanded && !initial.contextExpanded && initial.nestedInContext);
    check('full Play is available before a station is selected', !initial.state.selected && initial.fullPlayEnabled && initial.fullPlayLabel === 'Play nearest radio station');

    const multiExpandedPanelLayout = await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const ids = ['data-panel', 'scene-panel', 'pp-toggles', 'cctv-panel', 'global-context-panel'];
      const prior = {
        panels: Object.fromEntries(ids.map((id) => {
          const panel = document.getElementById(id);
          return [id, {
            className: panel.className,
            style: panel.getAttribute('style'),
            ariaHidden: panel.getAttribute('aria-hidden'),
          }];
        })),
        stacks: Object.fromEntries(['left-panel-stack', 'right-context-rail'].map((id) => {
          const stack = document.getElementById(id);
          return [id, {
            className: stack.className,
            style: stack.getAttribute('style'),
            dataset: { ...stack.dataset },
          }];
        })),
        preferredLeftPanelId: manager._panelLayout._leftStackPreferredPanelId,
        preferredRightPanelId: manager._panelLayout._rightStackPreferredPanelId,
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        focusId: document.activeElement?.id || null,
        storage: Object.fromEntries(Object.entries(localStorage)),
      };
      const setPanelThroughInstalledControl = (id, collapsed) => {
        const panel = document.getElementById(id);
        if (panel.classList.contains('collapsed') === collapsed) return;
        panel.querySelector(`[data-collapse-target="${id}"]`)?.click();
      };
      let result;
      try {
        manager.hud.setMode('off');
        setPanelThroughInstalledControl('data-panel', true);
        setPanelThroughInstalledControl('scene-panel', true);
        setPanelThroughInstalledControl('data-panel', false);
        setPanelThroughInstalledControl('scene-panel', false);
        manager.setPanelCollapsed('global-context-panel', false, { explicit: true });
        manager.setPanelCollapsed('pp-toggles', false, { explicit: true });
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();

        const left = document.getElementById('left-panel-stack');
        const right = document.getElementById('right-context-rail');
        const leftRect = left.getBoundingClientRect();
        const rightRect = right.getBoundingClientRect();
        const leftExpanded = ['data-panel', 'scene-panel'].map((id) => (
          document.getElementById(id).getBoundingClientRect()
        ));
        const rightExpanded = ['pp-toggles', 'global-context-panel'].map((id) => (
          document.getElementById(id).getBoundingClientRect()
        ));
        result = {
          independentLeft: ['data-panel', 'scene-panel'].every((id) => (
            !document.getElementById(id).classList.contains('collapsed')
          )),
          independentRight: ['pp-toggles', 'global-context-panel'].every((id) => (
            !document.getElementById(id).classList.contains('collapsed')
          )),
          leftCountsAllExpanded: left.dataset.expandedCount === '2',
          rightCountsAllExpanded: right.dataset.expandedCount === '2',
          leftInsideCorridor: leftExpanded.every((rect) => (
            rect.top >= leftRect.top - 1 && rect.bottom <= leftRect.bottom + 1
          )),
          rightInsideCorridor: rightExpanded.every((rect) => (
            rect.top >= rightRect.top - 1 && rect.bottom <= rightRect.bottom + 1
          )),
          internalScrollOwned: getComputedStyle(document.querySelector('#data-panel .data-toggle-list')).overflowY === 'auto'
            && getComputedStyle(document.querySelector('#scene-panel .scene-panel-inner')).overflowY === 'auto'
            && getComputedStyle(document.querySelector('#global-context-panel .global-context-panel-inner')).overflowY === 'auto',
        };

        manager._setHudVariant('tactical');
        manager.hud.setMode('on');
        manager._updateHudButtonState();
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();
        const dataPanel = document.getElementById('data-panel');
        const scenePanel = document.getElementById('scene-panel');
        const contextPanel = document.getElementById('global-context-panel');
        result.tacticalAutoCollapse = {
          latestOpenedPanel: manager._panelLayout._leftStackPreferredPanelId,
          scenesExpanded: !scenePanel.classList.contains('collapsed'),
          dataCollapsed: dataPanel.classList.contains('layout-auto-collapsed'),
          dataHiddenWhileScenesOwnsLane: dataPanel.getBoundingClientRect().height === 0
            && dataPanel.getAttribute('aria-hidden') === 'true',
          dataAriaExpanded: dataPanel.querySelector('[data-collapse-target="data-panel"]')?.getAttribute('aria-expanded'),
          displayExpanded: !document.getElementById('pp-toggles').classList.contains('collapsed'),
          contextCollapsed: contextPanel.classList.contains('layout-auto-collapsed'),
          contextHiddenWhileDisplayOwnsLane: contextPanel.getBoundingClientRect().height === 0
            && contextPanel.getAttribute('aria-hidden') === 'true',
          contextAriaExpanded: contextPanel.querySelector('[data-collapse-target="global-context-panel"]')?.getAttribute('aria-expanded'),
        };

        manager.setPanelCollapsed('scene-panel', true);
        manager.setPanelCollapsed('pp-toggles', true);
        await new Promise((resolve) => setTimeout(resolve, 360));
        manager._syncLeftPanelAdaptiveLayout();
        manager._syncRightPanelAdaptiveLayout();
        result.tacticalAutoRestore = {
          dataExpanded: !dataPanel.classList.contains('collapsed'),
          dataAutoMarkerCleared: !dataPanel.classList.contains('layout-auto-collapsed'),
          dataAriaExpanded: dataPanel.querySelector('[data-collapse-target="data-panel"]')?.getAttribute('aria-expanded'),
          contextExpanded: !contextPanel.classList.contains('collapsed'),
          contextAutoMarkerCleared: !contextPanel.classList.contains('layout-auto-collapsed'),
          contextAriaExpanded: contextPanel.querySelector('[data-collapse-target="global-context-panel"]')?.getAttribute('aria-expanded'),
        };

        manager.setPanelCollapsed('global-context-panel', true);
        manager.setPanelCollapsed('cctv-panel', true);
        manager.setPanelCollapsed('pp-toggles', false);
        await new Promise((resolve) => setTimeout(resolve, 240));
        manager._syncRightPanelAdaptiveLayout();
        const displayPanel = document.getElementById('pp-toggles');
        const cctvPanel = document.getElementById('cctv-panel');
        result.tacticalDisplayExclusive = {
          railExclusive: right.classList.contains('layout-exclusive'),
          displayExpanded: !displayPanel.classList.contains('collapsed'),
          cctvHidden: cctvPanel.getBoundingClientRect().height === 0
            && cctvPanel.getAttribute('aria-hidden') === 'true',
          contextHidden: contextPanel.getBoundingClientRect().height === 0
            && contextPanel.getAttribute('aria-hidden') === 'true',
        };
      } finally {
        manager._setHudVariant(prior.hudVariant);
        manager.hud.setMode(prior.hudMode);
        manager._updateHudButtonState();
        await new Promise((resolve) => setTimeout(resolve, 320));
        if (manager._panelLayout._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._leftStackLayoutFrame);
          manager._panelLayout._leftStackLayoutFrame = null;
        }
        if (manager._panelLayout._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._rightStackLayoutFrame);
          manager._panelLayout._rightStackLayoutFrame = null;
        }
        for (const [id, state] of Object.entries(prior.panels)) {
          const panel = document.getElementById(id);
          panel.className = state.className;
          if (state.style === null) panel.removeAttribute('style');
          else panel.setAttribute('style', state.style);
          if (state.ariaHidden === null) panel.removeAttribute('aria-hidden');
          else panel.setAttribute('aria-hidden', state.ariaHidden);
          // The restored classes are the panel's state again.
          const has = (name) => panel.classList.contains(name);
          manager._presentPanel(panel, {
            collapsed: has('collapsed'),
            pinned: has('dock-pinned'),
            pinnedTop: has('dock-pinned-top'),
            auto: has('layout-auto-collapsed') ? 'layout' : has('accordion-collapsed') ? 'accordion' : null,
          });
        }
        for (const [id, state] of Object.entries(prior.stacks)) {
          const stack = document.getElementById(id);
          stack.className = state.className;
          if (state.style === null) stack.removeAttribute('style');
          else stack.setAttribute('style', state.style);
          for (const key of Object.keys(stack.dataset)) delete stack.dataset[key];
          Object.assign(stack.dataset, state.dataset);
        }
        manager._panelLayout._leftStackPreferredPanelId = prior.preferredLeftPanelId;
        manager._panelLayout._rightStackPreferredPanelId = prior.preferredRightPanelId;
        localStorage.clear();
        for (const [key, value] of Object.entries(prior.storage)) localStorage.setItem(key, value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        if (manager._panelLayout._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._leftStackLayoutFrame);
          manager._panelLayout._leftStackLayoutFrame = null;
        }
        if (manager._panelLayout._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._rightStackLayoutFrame);
          manager._panelLayout._rightStackLayoutFrame = null;
        }
        // Disclosure restoration can wake the installed layout observers. Let
        // those observers settle, then restore the captured stack presentation
        // once more so this synthetic scenario cannot leak derived lane state
        // into the Radio interactions that follow.
        for (const [id, state] of Object.entries(prior.stacks)) {
          const stack = document.getElementById(id);
          stack.className = state.className;
          if (state.style === null) stack.removeAttribute('style');
          else stack.setAttribute('style', state.style);
          for (const key of Object.keys(stack.dataset)) delete stack.dataset[key];
          Object.assign(stack.dataset, state.dataset);
        }
        prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
        const panelsRestored = Object.entries(prior.panels).every(([id, state]) => {
          const panel = document.getElementById(id);
          return panel.className === state.className
            && panel.getAttribute('style') === state.style
            && panel.getAttribute('aria-hidden') === state.ariaHidden;
        });
        const stacksRestored = Object.entries(prior.stacks).every(([id, state]) => {
          const stack = document.getElementById(id);
          return stack.className === state.className
            && stack.getAttribute('style') === state.style
            && JSON.stringify({ ...stack.dataset }) === JSON.stringify(state.dataset);
        });
        result.restoreDetails = {
          panelsRestored,
          stacksRestored,
          preferredPanelRestored: manager._panelLayout._leftStackPreferredPanelId === prior.preferredLeftPanelId,
          preferredRightPanelRestored: manager._panelLayout._rightStackPreferredPanelId === prior.preferredRightPanelId,
          hudModeRestored: manager.hud.getMode() === prior.hudMode,
          hudVariantRestored: manager.hud.getVariant() === prior.hudVariant,
          storageRestored: JSON.stringify(Object.fromEntries(Object.entries(localStorage))) === JSON.stringify(prior.storage),
          focusRestored: !prior.focusId || document.activeElement?.id === prior.focusId,
        };
        result.restoredExactly = Object.values(result.restoreDetails).every(Boolean);
      }

      return result;
    });
    check(
      'HUD-off desktop lanes keep Data plus Scenes and Display plus Context expanded inside the viewport corridor',
      multiExpandedPanelLayout.independentLeft
        && multiExpandedPanelLayout.independentRight
        && multiExpandedPanelLayout.leftCountsAllExpanded
        && multiExpandedPanelLayout.rightCountsAllExpanded
        && multiExpandedPanelLayout.leftInsideCorridor
        && multiExpandedPanelLayout.rightInsideCorridor
        && multiExpandedPanelLayout.internalScrollOwned
        && multiExpandedPanelLayout.restoredExactly,
      JSON.stringify(multiExpandedPanelLayout),
    );
    check(
      'HUD-off to Tactical preserves the latest-opened Scenes panel and hides its collapsed Data competitor',
      multiExpandedPanelLayout.tacticalAutoCollapse.latestOpenedPanel === 'scene-panel'
        && multiExpandedPanelLayout.tacticalAutoCollapse.scenesExpanded
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataCollapsed
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataHiddenWhileScenesOwnsLane
        && multiExpandedPanelLayout.tacticalAutoCollapse.dataAriaExpanded === 'false'
        && multiExpandedPanelLayout.tacticalAutoCollapse.displayExpanded
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextCollapsed
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextHiddenWhileDisplayOwnsLane
        && multiExpandedPanelLayout.tacticalAutoCollapse.contextAriaExpanded === 'false',
      JSON.stringify(multiExpandedPanelLayout.tacticalAutoCollapse),
    );
    check(
      'closing Tactical lane owners restores eligible temporary siblings without changing disclosure truth',
      multiExpandedPanelLayout.tacticalAutoRestore.dataExpanded
        && multiExpandedPanelLayout.tacticalAutoRestore.dataAutoMarkerCleared
        && multiExpandedPanelLayout.tacticalAutoRestore.dataAriaExpanded === 'true'
        && multiExpandedPanelLayout.tacticalAutoRestore.contextExpanded
        && multiExpandedPanelLayout.tacticalAutoRestore.contextAutoMarkerCleared
        && multiExpandedPanelLayout.tacticalAutoRestore.contextAriaExpanded === 'true',
      JSON.stringify(multiExpandedPanelLayout.tacticalAutoRestore),
    );
    check(
      'Tactical Display hides ordinary collapsed CCTV and Context launchers',
      Object.values(multiExpandedPanelLayout.tacticalDisplayExclusive).every(Boolean),
      JSON.stringify(multiExpandedPanelLayout.tacticalDisplayExclusive),
    );
    const parameterizedDisplayScroll = await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      const display = document.getElementById('pp-toggles');
      const parameters = document.getElementById('param-slider-panel');
      const prior = {
        style: manager.activeStyle,
        displayCollapsed: display.classList.contains('collapsed'),
        contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
        cctvCollapsed: document.getElementById('cctv-panel').classList.contains('collapsed'),
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        focusId: document.activeElement?.id || null,
      };
      const waitForLayout = async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
      const cases = [];

      manager.setPanelCollapsed('global-context-panel', true);
      manager.setPanelCollapsed('cctv-panel', true);
      manager.setPanelCollapsed('pp-toggles', false);
      manager.setStyle('thermal', { applyPreset: false });

      for (const state of [
        { name: 'tactical', visible: true, variant: 'tactical' },
        { name: 'minimal', visible: true, variant: 'minimal' },
        { name: 'hud-off', visible: false, variant: 'minimal' },
      ]) {
        manager._setHudVariant(state.variant);
        manager.hud.setMode(state.visible ? 'on' : 'off');
        manager._updateHudButtonState();
        await waitForLayout();
        manager._syncRightPanelAdaptiveLayout();
        display.scrollTop = Math.max(1, display.scrollHeight - display.clientHeight);
        const before = display.scrollTop;
        manager._syncRightPanelAdaptiveLayout();
        const lastSlider = document.querySelector('#param-sliders .param-slider-row:last-child input');
        lastSlider.focus({ preventScroll: true });
        lastSlider.scrollIntoView({ block: 'nearest' });
        const displayRect = display.getBoundingClientRect();
        const sliderRect = lastSlider.getBoundingClientRect();
        cases.push({
          name: state.name,
          before,
          after: display.scrollTop,
          finalRowReachable: sliderRect.top >= displayRect.top - 1
            && sliderRect.bottom <= displayRect.bottom + 1,
          displayOwnsScroll: getComputedStyle(display).overflowY === 'auto',
          parametersDoNotTrapScroll: getComputedStyle(parameters).overflowY === 'visible',
          parameterRows: document.querySelectorAll('#param-sliders .param-slider-row').length,
        });
      }

      manager.setStyle(prior.style, { applyPreset: false });
      manager.setPanelCollapsed('pp-toggles', prior.displayCollapsed);
      manager.setPanelCollapsed('global-context-panel', prior.contextCollapsed);
      manager.setPanelCollapsed('cctv-panel', prior.cctvCollapsed);
      manager._setHudVariant(prior.hudVariant);
      manager.hud.setMode(prior.hudMode);
      manager._updateHudButtonState();
      prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
      return cases;
    });
    check(
      'parameterized Display remains scrollable through Tactical, Minimal, and HUD Off layout passes',
      parameterizedDisplayScroll.every((state) => (
        state.parameterRows >= 5
          && state.before > 0
          && state.after > 0
          && state.finalRowReachable
          && state.displayOwnsScroll
          && state.parametersDoNotTrapScroll
      )),
      JSON.stringify(parameterizedDisplayScroll),
    );
    const cockpitCompactControls = await page.evaluate(async () => {
      const hud = document.getElementById('cockpit-hud');
      const signal = document.getElementById('cockpit-signal-stream');
      const display = document.getElementById('cockpit-display-toggle-btn');
      const radio = document.getElementById('cockpit-radio-toggle-btn');
      const hudToggle = document.getElementById('hud-toggle');
      const hudLayout = document.getElementById('hud-layout-select');
      const detectionToggle = document.getElementById('detection-toggle');
      const models3dToggle = document.getElementById('models3d-toggle');
      const models3dAll = document.getElementById('models3d-mode-all');
      const scene = document.getElementById('scene-panel');
      const dataPanel = document.getElementById('data-panel');
      const manager = window.__godsEyeView.styleManager;
      // This block validates portaled DOM controls, while qa-cockpit-utility
      // owns the real tracked-aircraft camera session. Hold the frame update so
      // the intentionally synthetic Cockpit shell is not auto-exited mid-check.
      const realCockpitUpdate = manager.cockpitView.update;
      const intelHud = document.getElementById('intel-hud');
      const priorHudTransition = intelHud.style.getPropertyValue('transition');
      const priorHudTransitionPriority = intelHud.style.getPropertyPriority('transition');
      const waitForLayout = async () => {
        await new Promise((resolve) => setTimeout(resolve, 320));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
      const waitForHudSettle = async () => {
        await new Promise((resolve) => setTimeout(resolve, 560));
        // Let panel changes settle. qa-cockpit-utility covers scheduling with
        // the real tracked-aircraft controller; this synthetic shell pauses it.
        intelHud.getBoundingClientRect();
        // This fixture pauses the controller update. Run its actual layout
        // methods against the settled HUD, then measure both unchanged lanes.
        manager.cockpitView.syncContextLayout();
        manager.cockpitView.syncSignalLayout();
        manager._syncLeftPanelAdaptiveLayout();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      };
      const prior = {
        cockpit: document.body.classList.contains('cockpit-mode'),
        cockpitActive: manager.cockpitView.active,
        bodyClassName: document.body.className,
        contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
        hudHidden: hud.hidden,
        signalHidden: signal.hidden,
        dataCollapsed: dataPanel.classList.contains('collapsed'),
        mapStack: manager.mapStackController?.getActiveId(),
        hudMode: manager.hud.getMode(),
        hudVariant: manager.hud.getVariant(),
        displayExpanded: display.getAttribute('aria-expanded') === 'true',
        radioExpanded: radio.getAttribute('aria-expanded') === 'true',
        focusId: document.activeElement?.id || null,
        detectionMode: manager.getDetectionState().detectionMode,
        models3dEnabled: manager._models3dEnabled,
        models3dMode: manager._models3dMode,
        preferredLeftPanelId: manager._panelLayout._leftStackPreferredPanelId,
        panels: Object.fromEntries([
          'data-panel',
          'global-context-panel',
        ].map((id) => {
          const panel = document.getElementById(id);
          return [id, {
            className: panel.className,
            style: panel.getAttribute('style'),
            ariaHidden: panel.getAttribute('aria-hidden'),
          }];
        })),
        storage: Object.fromEntries(Object.entries(localStorage)),
        utilityTop: hud.style.getPropertyValue('--cockpit-utility-top'),
      };
      let result = {};
      try {
        manager.cockpitView.update = () => {};
        // This block measures settled panel geometry, not fade timing. The
        // synthetic paused controller cannot advance layout during a HUD fade.
        intelHud.style.setProperty('transition', 'none', 'important');
        document.body.classList.add('cockpit-mode');
      manager.cockpitView.active = true;
      manager._setCockpitDisplayPortalActive(true);
      hud.hidden = false;
      signal.hidden = false;
      manager._presentPanel(dataPanel, { collapsed: false });
      window.__godsEyeView.styleManager._syncLeftPanelAdaptiveLayout();
      window.__godsEyeView.styleManager.cockpitView.syncSignalLayout();
      if (display.getAttribute('aria-expanded') === 'true') display.click();
      display.click();
      manager._setHudVariant('tactical');
      manager.hud.setMode('on');
      manager._updateHudButtonState();
      await waitForHudSettle();

      const layoutSteps = [];
      // The two Cockpit lanes are solved independently: the accordion against
      // left-lane obstacles, the Display/Radio strip against the REC readout
      // and the briefing card it shares the right margin with. Record both
      // sets of inputs so each lane is asserted on its own terms.
      const visibleRect = (selector) => {
        const element = document.querySelector(selector);
        if (!element || element.hidden) return null;
        for (let node = element; node; node = node.parentElement) {
          const style = getComputedStyle(node);
          if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
            return null;
          }
        }
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 ? rect : null;
      };
      const recordLayoutStep = () => {
        const dataRect = dataPanel.getBoundingClientRect();
        const utilityRect = document.getElementById('cockpit-utility-controls').getBoundingClientRect();
        const displayRect = display.closest('.cockpit-utility-control').getBoundingClientRect();
        const toplineRect = document.querySelector('#cockpit-hud .cockpit-topline').getBoundingClientRect();
        const recRect = visibleRect('#intel-hud .hud-top-right');
        const creditsRect = visibleRect('#cesium-credits .cesium-credit-textContainer');
      // Left-lane surfaces an expanded Cockpit panel must remain clear of.
        const passableTops = ['#cockpit-context', '#intel-hud .hud-bottom-left']
          .map((selector) => visibleRect(selector))
          .filter((rect) => rect && rect.right > dataRect.left && rect.left < dataRect.right)
          .map((rect) => rect.top);
        const stack = document.getElementById('left-panel-stack');
        layoutSteps.push({
          hud: manager.hud.visible ? manager.hud.getVariant().toUpperCase() : 'OFF',
          dataTop: dataRect.top,
          dataBottom: dataRect.bottom,
          // The corridor the engine committed, independent of how tall the
          // panel's own content happens to be.
          layoutBottom: window.innerHeight * (Number(stack.dataset.safeBottomPct) || 0) / 100,
          safeGap: window.innerHeight * 0.012,
          displayTop: displayRect.top,
          utilityTop: utilityRect.top,
          utilityBottom: utilityRect.bottom,
          utilityHeight: utilityRect.height,
          toplineBottom: toplineRect.bottom,
          recBottom: recRect ? recRect.bottom : 0,
          signalTop: signal.getBoundingClientRect().top,
          creditsTop: creditsRect ? creditsRect.top : null,
          passableTop: passableTops.length ? Math.min(...passableTops) : null,
          minTop: Math.max(96, window.innerHeight * 0.12),
          layoutMode: document.getElementById('left-panel-stack').dataset.layoutMode,
        });
      };
      // Both lanes are measured against the settled HUD variant.
      for (let index = 0; index < 5; index += 1) {
        recordLayoutStep();
        if (index < 4) {
          // Off and back on in Minimal, so the toggle must restore a
          // non-default layout before the cycle returns to Tactical.
          if (index === 1 || index === 2) {
            hudToggle.click();
          } else {
            hudLayout.value = index === 0 ? 'minimal' : 'tactical';
            hudLayout.dispatchEvent(new Event('change', { bubbles: true }));
          }
          await waitForHudSettle();
        }
      }

      // Cockpit's CONTACT card shares the accordion's lane. This synthetic
      // shell has no tracked contact, so reveal the card to prove an expanded
      // panel stops above it while its internally scrolled controls stay live.
      const contextCard = document.getElementById('cockpit-context');
      const contextWasHidden = contextCard.hidden;
      contextCard.hidden = false;
      // Expand the panel the same way this block already does at entry, so the
      // portaled Display groups measured further down keep their DOM home.
      manager._presentPanel(dataPanel, { collapsed: false, auto: null });
      manager._syncLeftPanelAdaptiveLayout();
      await waitForLayout();
      const panelRect = dataPanel.getBoundingClientRect();
      const contextRect = contextCard.getBoundingClientRect();
      const contactClearancePx = contextRect.top - panelRect.bottom;
      const clearsContextCard = contactClearancePx >= -0.5;
      const probe = document.elementFromPoint(
        Math.max(panelRect.left, contextRect.left) + 8,
        Math.max(panelRect.top, contextRect.top) + 6,
      );
      const contextOwnsItsLane = !probe?.closest('#data-panel');
      // A layer toggle must remain reachable and live from inside Cockpit.
      // Prefer a bundled layer so the proof needs no external network.
      const toggleList = dataPanel.querySelector('.data-toggle-list');
      const toggleRows = [...toggleList.querySelectorAll('.data-toggle-row')]
        .filter((row) => row.querySelector('.data-toggle-btn'));
      const toggleRow = toggleRows.find((row) => String(row.dataset.layerId).startsWith('local-'))
        || toggleRows.find((row) => !/flight|military|vessel|ais|radio/i.test(row.dataset.layerId || ''));
      toggleRow?.scrollIntoView({ block: 'center' });
      await waitForLayout();
      const toggleLayerId = toggleRow?.dataset.layerId || null;
      const toggleButton = toggleRow?.querySelector('.data-toggle-btn');
      const toggleButtonRect = toggleButton?.getBoundingClientRect();
      const listRect = toggleList.getBoundingClientRect();
      const toggleInsideScroller = Boolean(toggleButtonRect
        && toggleButtonRect.top >= listRect.top - 1
        && toggleButtonRect.bottom <= listRect.bottom + 1);
      const toggleReachable = Boolean(toggleButtonRect && toggleRow.contains(
        document.elementFromPoint(
          toggleButtonRect.left + toggleButtonRect.width / 2,
          toggleButtonRect.top + toggleButtonRect.height / 2,
        ),
      ));
      const toggleBefore = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) : null;
      toggleButton?.click();
      await waitForLayout();
      const toggleAfter = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) : null;
      toggleButton?.click();
      await waitForLayout();
      const toggleRestored = toggleLayerId
        ? window.__godsEyeView.dataManager.isEnabled(toggleLayerId) === toggleBefore : false;
      const cockpitPanelInteraction = {
        toggleLayerId,
        contactClearancePx,
        clearsContextCard,
        contextOwnsItsLane,
        toggleInsideScroller,
        toggleReachable,
        toggleBefore,
        toggleAfter,
        toggleRestored,
        listScrolls: toggleList.scrollHeight > toggleList.clientHeight,
        panelHeight: Math.round(panelRect.height),
      };
      contextCard.hidden = contextWasHidden;
      // Restoring the layer destroys it, and a layer teardown during a Context
      // session legitimately exits Cockpit (ui.js subscribeBeforeDestroy). Re-
      // establish this block's synthetic shell exactly as it was entered, so
      // the portaled-control checks below keep their precondition.
      document.body.classList.add('cockpit-mode');
      manager.cockpitView.active = true;
      hud.hidden = false;
      signal.hidden = false;
      manager._setCockpitDisplayPortalActive(true);
      manager._setCockpitDisclosure('display', true);
      await waitForLayout();

      manager._setModels3dMode('proximity');
      manager._setModels3dEnabled(false);
      const models3dSteps = [];
      for (let index = 0; index < 3; index += 1) {
        if (index === 0 || index === 2) models3dToggle.click();
        else models3dAll.click();
        const flightsParams = manager._dataManager.getLayerParams('flights');
        const militaryParams = manager._dataManager.getLayerParams('military');
        models3dSteps.push({
          label: manager._models3dEnabled ? manager._models3dMode.toUpperCase() : 'OFF',
          flightsEnabled: flightsParams.models3d,
          flightsMode: flightsParams.models3dMode,
          militaryEnabled: militaryParams.models3d,
          militaryMode: militaryParams.models3dMode,
        });
      }

      manager.cockpitView.syncSignalLayout();
      const displayOpened = display.getAttribute('aria-expanded') === 'true'
        && !document.getElementById('cockpit-display-panel').hidden;
      const sharedDisplayControlsPortaled = [hudToggle, detectionToggle, models3dToggle]
        .every((control) => control.closest('.pp-toggle-group')?.parentElement
          ?.closest('#cockpit-display-panel'));
      display.click();
      await waitForLayout();

      manager.cockpitView.syncSignalLayout();
      radio.click();
      await waitForLayout();
      const radioOpened = radio.getAttribute('aria-expanded') === 'true'
        && !document.getElementById('cockpit-radio-panel').hidden;
      const mutuallyExclusive = display.getAttribute('aria-expanded') === 'false';
      radio.click();
      await waitForLayout();

      manager.cockpitView.syncSignalLayout();
      radio.click();
      await waitForLayout();

      const radioNavigationAvailable = [
        document.getElementById('cockpit-radio-prev-btn'),
        document.getElementById('cockpit-radio-next-btn'),
      ].every((button) => button?.isConnected && !button.disabled);
      const detailsExcluded = !document.querySelector(
        '#cockpit-radio-panel #radio-filter, #cockpit-radio-panel #radio-tuner',
      );
      const scenesHidden = getComputedStyle(scene).display === 'none';
      radio.click();

      manager.setPanelCollapsed('data-panel', true);
      await waitForLayout();
      const utility = document.getElementById('cockpit-utility-controls');
      const photorealAvailable = manager.mapStackController?.getStacks()
        .some((stack) => stack.id === 'photoreal' && stack.available);
      let mapProviderUtilityStable = true;
      if (photorealAvailable) {
        await manager._setMapStack('photoreal', { syncShare: false });
        await waitForLayout();
        const stableTop = utility.getBoundingClientRect().top;
        const transitionTops = [];
        let sampling = true;
        let sampleFrame = null;
        const sampleTop = () => {
          if (!sampling) return;
          transitionTops.push(utility.getBoundingClientRect().top);
          sampleFrame = requestAnimationFrame(sampleTop);
        };
        sampleFrame = requestAnimationFrame(sampleTop);
        await manager._setMapStack('osm', { syncShare: false });
        await waitForLayout();
        sampling = false;
        cancelAnimationFrame(sampleFrame);
        mapProviderUtilityStable = transitionTops.length > 1
          && transitionTops.every((top) => Math.abs(top - stableTop) < 1);
      }
      result = {
        cockpitPanelInteraction,
        layoutSteps,
        displayOpened,
        sharedDisplayControlsPortaled,
        radioOpened,
        mutuallyExclusive,
        radioNavigationAvailable,
        detailsExcluded,
        scenesHidden,
        mapProviderUtilityStable,
        hudInteractionsExact: layoutSteps.map((step) => step.hud).join('>')
          === 'TACTICAL>MINIMAL>OFF>MINIMAL>TACTICAL',
        // The accordion clears the topline, Cockpit cards, and Cesium credits
        // across every HUD layout. Its list owns any overflow internally.
        leftLaneClearAcrossHudCycle: layoutSteps.every((step) => (
          step.dataTop >= step.toplineBottom
          && (step.creditsTop === null || step.dataBottom <= step.creditsTop)
          && (step.passableTop === null || step.dataBottom <= step.passableTop + 0.5)
        )),
        // The strip is solved from ITS margin — under the REC readout, clamped
        // clear of the briefing card, never above the viewport ceiling — and
        // never from whatever corridor the accordion happened to commit.
        rightStripClearAcrossHudCycle: layoutSteps.every((step) => {
          const anchored = Math.max(step.minTop, step.recBottom + 12);
          const expected = Math.max(
            step.minTop,
            Math.min(anchored, step.signalTop - 8 - step.utilityHeight),
          );
          return step.displayTop >= step.toplineBottom
            && step.utilityBottom <= step.signalTop - 7.9
            && Math.abs(step.utilityTop - expected) < 0.6;
        }),
        models3dInteractionsExact: models3dSteps.map((step) => step.label).join('>')
          === 'PROXIMITY>ALL>OFF',
        models3dLayersSynchronized: models3dSteps.every((step, index) => {
          const expectedEnabled = index < 2;
          const expectedMode = index === 0 ? 'proximity' : 'all';
          return step.flightsEnabled === expectedEnabled
            && step.militaryEnabled === expectedEnabled
            && step.flightsMode === expectedMode
            && step.militaryMode === expectedMode;
        }),
      };
      } finally {
        if (prior.mapStack) await manager._setMapStack(prior.mapStack, { syncShare: false });
        manager._setDetectionMode(prior.detectionMode);
        manager._setModels3dMode(prior.models3dMode);
        manager._setModels3dEnabled(prior.models3dEnabled);
        manager._setHudVariant(prior.hudVariant);
        manager.hud.setMode(prior.hudMode);
        if (priorHudTransition) intelHud.style.setProperty('transition', priorHudTransition, priorHudTransitionPriority);
        else intelHud.style.removeProperty('transition');
        manager._updateHudButtonState();
        manager.cockpitView.active = prior.cockpitActive;
        manager.cockpitView.update = realCockpitUpdate;
        manager.setPanelCollapsed('data-panel', prior.dataCollapsed);
        document.body.className = prior.bodyClassName;
        manager._setCockpitDisplayPortalActive(prior.cockpit);
        manager.setPanelCollapsed('global-context-panel', prior.contextCollapsed);
        if (display.getAttribute('aria-expanded') !== String(prior.displayExpanded)) display.click();
        if (radio.getAttribute('aria-expanded') !== String(prior.radioExpanded)) radio.click();
        hud.hidden = prior.hudHidden;
        signal.hidden = prior.signalHidden;
        if (prior.utilityTop) hud.style.setProperty('--cockpit-utility-top', prior.utilityTop);
        else hud.style.removeProperty('--cockpit-utility-top');
        await waitForLayout();
        if (manager._panelLayout._leftStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._leftStackLayoutFrame);
          manager._panelLayout._leftStackLayoutFrame = null;
        }
        if (manager._panelLayout._rightStackLayoutFrame !== null) {
          cancelAnimationFrame(manager._panelLayout._rightStackLayoutFrame);
          manager._panelLayout._rightStackLayoutFrame = null;
        }
        for (const [id, state] of Object.entries(prior.panels)) {
          const panel = document.getElementById(id);
          panel.className = state.className;
          if (state.style === null) panel.removeAttribute('style');
          else panel.setAttribute('style', state.style);
          if (state.ariaHidden === null) panel.removeAttribute('aria-hidden');
          else panel.setAttribute('aria-hidden', state.ariaHidden);
          // The restored classes are the panel's state again.
          const has = (name) => panel.classList.contains(name);
          manager._presentPanel(panel, {
            collapsed: has('collapsed'),
            pinned: has('dock-pinned'),
            pinnedTop: has('dock-pinned-top'),
            auto: has('layout-auto-collapsed') ? 'layout' : has('accordion-collapsed') ? 'accordion' : null,
          });
        }
        manager._panelLayout._leftStackPreferredPanelId = prior.preferredLeftPanelId;
        localStorage.clear();
        for (const [key, value] of Object.entries(prior.storage)) localStorage.setItem(key, value);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        prior.focusId && document.getElementById(prior.focusId)?.focus({ preventScroll: true });
        result.restoredExactly = document.body.className === prior.bodyClassName
          && manager.cockpitView.active === prior.cockpitActive
          && manager.cockpitView.update === realCockpitUpdate
          && dataPanel.classList.contains('collapsed') === prior.dataCollapsed
          && document.getElementById('global-context-panel').classList.contains('collapsed') === prior.contextCollapsed
          && display.getAttribute('aria-expanded') === String(prior.displayExpanded)
          && radio.getAttribute('aria-expanded') === String(prior.radioExpanded)
          && hud.hidden === prior.hudHidden
          && signal.hidden === prior.signalHidden
          && intelHud.style.getPropertyValue('transition') === priorHudTransition
          && intelHud.style.getPropertyPriority('transition') === priorHudTransitionPriority
          && manager.hud.getMode() === prior.hudMode
          && manager.hud.getVariant() === prior.hudVariant
          && Object.entries(prior.panels).every(([id, state]) => {
            const panel = document.getElementById(id);
            return panel.className === state.className
              && panel.getAttribute('style') === state.style
              && panel.getAttribute('aria-hidden') === state.ariaHidden;
          })
          && manager._panelLayout._leftStackPreferredPanelId === prior.preferredLeftPanelId
          && JSON.stringify(Object.fromEntries(Object.entries(localStorage))) === JSON.stringify(prior.storage)
          && (!prior.focusId || document.activeElement?.id === prior.focusId);
      }
      return result;
    });
    check(
      'Cockpit portals the standard focused Display groups and keeps compact-only Radio',
      cockpitCompactControls.displayOpened
        && cockpitCompactControls.sharedDisplayControlsPortaled
        && cockpitCompactControls.radioOpened
        && cockpitCompactControls.mutuallyExclusive
        && cockpitCompactControls.radioNavigationAvailable
        && cockpitCompactControls.detailsExcluded
        && cockpitCompactControls.scenesHidden
        && cockpitCompactControls.mapProviderUtilityStable
        && cockpitCompactControls.hudInteractionsExact
        && cockpitCompactControls.leftLaneClearAcrossHudCycle
        && cockpitCompactControls.rightStripClearAcrossHudCycle
        && cockpitCompactControls.models3dInteractionsExact
        && cockpitCompactControls.models3dLayersSynchronized
        && cockpitCompactControls.restoredExactly,
      JSON.stringify(cockpitCompactControls),
    );
    check(
      'an expanded Cockpit left panel stops above CONTACT and still toggles layers',
      cockpitCompactControls.cockpitPanelInteraction?.clearsContextCard
        && cockpitCompactControls.cockpitPanelInteraction.contextOwnsItsLane
        && cockpitCompactControls.cockpitPanelInteraction.toggleInsideScroller
        && cockpitCompactControls.cockpitPanelInteraction.toggleReachable
        && cockpitCompactControls.cockpitPanelInteraction.toggleBefore
          !== cockpitCompactControls.cockpitPanelInteraction.toggleAfter
        && cockpitCompactControls.cockpitPanelInteraction.toggleRestored,
      JSON.stringify(cockpitCompactControls.cockpitPanelInteraction),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'compact.png') });

    const firstPlayPrecondition = await page.evaluate(() => (
      window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id || null
    ));
    check('first Play scenario starts without a leaked Radio selection', firstPlayPrecondition === null,
      `selected=${firstPlayPrecondition}`);
    await page.select('#radio-filter', 'all');
    await page.evaluate(() => {
      const camera = window.__godsEyeView.viewer.camera;
      window.__qaFirstPlayFlyToCalls = [];
      window.__qaFirstPlayOriginalFlyTo = window.__godsEyeView.engine.camera.flyTo;
      camera.flyTo = (options) => window.__qaFirstPlayFlyToCalls.push(options);
    });
    const firstPlayPanels = await revealRadioControls(page, 'radio-play-btn');
    await page.focus('#radio-play-btn');
    await page.click('#radio-play-btn');
    await page.waitForFunction(() => {
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return state.audioState === 'playing' || state.audioState === 'error';
    });
    await restoreRadioPanels(page, firstPlayPanels);
    const postMicroDragPlayback = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('radio').module;
      let state = mod.getUIState();
      if (state.audioState !== 'playing') {
        await mod.play({ origin: 'user' });
        state = mod.getUIState();
      }
      return { audioState: state.audioState, selectedId: state.selected?.id || null };
    });
    check('micro-drag release leaves the selected station playable',
      postMicroDragPlayback.audioState === 'playing', JSON.stringify(postMicroDragPlayback));
    const firstPlay = await page.evaluate(() => {
      const module = window.__godsEyeView.dataManager.layers.get('radio').module;
      const state = module.getUIState();
      const camera = window.__godsEyeView.viewer.camera;
      const result = {
        state,
        calls: [...window.__qaRadioPlayCalls],
        flyToCalls: window.__qaFirstPlayFlyToCalls.length,
      };
      camera.flyTo = window.__qaFirstPlayOriginalFlyTo;
      delete window.__qaFirstPlayOriginalFlyTo;
      module.stopPlayback();
      return result;
    });
    check(
      'first Play selects a viewport-ranked station from All and starts its stream',
      Boolean(firstPlay.state.selected?.id) && firstPlay.state.filter === 'all'
        && firstPlay.state.audioState === 'playing' && firstPlay.calls.length >= 1,
      JSON.stringify({ selected: firstPlay.state.selected?.id, calls: firstPlay.calls }),
    );
    check('first Play never moves the camera', firstPlay.flyToCalls === 0, `${firstPlay.flyToCalls} flyTo calls`);

    await page.select('#radio-filter', 'news');
    await evaluateWithGeo(page, async (qaGeo) => {
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: -98 * Math.PI / 180,
          latitude: 38 * Math.PI / 180,
          height: 18_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await whenFramesDrawn(page);
    await settleRadioFrames(page);
    const newsClusterTarget = await page.evaluate(() => {
      // A drawn cluster: a painted cluster entry whose anchor picks a
      // radio-clusters instance. Its pickId names the cluster's first
      // station, which a click on it plays.
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const drawn = window.__qaRadioDrawn;
      const { getPaintRect: getOverlayPaintRect } = window.__gevWorldOverlay;
      const { clusterIds } = radio.getOverlayDiagnostics();
      for (const entryId of clusterIds) {
        const position = getOverlayPaintRect('radio', entryId)?.entry?.position;
        const canvasPoint = drawn.canvasPoint(typeof position === 'function' ? position() : position);
        if (!canvasPoint) continue;
        const pick = drawn.picksAt(canvasPoint, 16).find((picked) => picked.owner === 'radio-clusters');
        if (!pick) continue;
        return {
          x: canvasPoint.x,
          y: canvasPoint.y,
          firstId: pick.id.replace(/^radio:/, ''),
          pointIds: [pick.id],
        };
      }
      return { missing: true, clusterIds, drawn: drawn.counts() };
    });
    if (!newsClusterTarget.missing) {
      await page.mouse.click(newsClusterTarget.x, newsClusterTarget.y);
      await page.waitForFunction((stationId) => {
        const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
        return state.selected?.id === stationId && state.audioState === 'playing';
      }, {}, newsClusterTarget.firstId);
    }
    const newsClusterClick = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      gev.dataManager.layers.get('radio').module.stopPlayback();
      return { selectedId: state.selected?.id, audioState: state.audioState };
    });
    check(
      'clicking a News cluster dot plays its first station',
      newsClusterTarget?.pointIds?.length > 0
        && newsClusterClick.selectedId === newsClusterTarget.firstId
        && newsClusterClick.audioState === 'playing',
      JSON.stringify({ target: newsClusterTarget, result: newsClusterClick }),
    );

    await page.select('#radio-filter', 'weather');
    await whenFramesDrawn(page);
    const weatherCluster = await page.evaluate(() => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      return { texts: radio.getOverlayDiagnostics().clusterTexts };
    });
    check(
      'Weather / Emergency view labels its cluster callouts WEATHER',
      weatherCluster.texts.length > 0 && weatherCluster.texts.every((text) => /^\d+ WEATHER$/.test(text)),
      JSON.stringify(weatherCluster),
    );
    await page.select('#radio-filter', 'news');

    await page.$eval('#radio-volume', (input) => {
      input.value = '35';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const radioVolume = await page.evaluate(() => ({
      volume: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().volume,
      full: document.getElementById('radio-volume').value,
      label: document.getElementById('radio-volume-value').textContent,
    }));
    check(
      'full Radio volume drives the Radio player state',
      Math.abs(radioVolume.volume - 0.35) < 0.001 && radioVolume.full === '35' && radioVolume.label === '35%',
      JSON.stringify(radioVolume),
    );

    const voicePause = await page.evaluate(async () => {
      const filter = document.getElementById('radio-filter');
      const firstOption = filter?.options?.[0] || null;
      await window.__godsEyeView.dataManager.layers.get('radio').module.play();
      const startedAt = performance.now();
      window.__godsEyeView.voiceCommands.setStatus('connecting', 'QA voice connect');
      const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
      return {
        ...state,
        transitionMs: performance.now() - startedAt,
        categoryOptionPreserved: firstOption === filter?.options?.[0],
      };
    });
    check(
      'voice activation immediately pauses Radio without changing the user volume',
      voicePause.audioState === 'paused' && Math.abs(voicePause.volume - 0.35) < 0.001,
      JSON.stringify({ audioState: voicePause.audioState, user: voicePause.volume }),
    );
    check(
      'voice pause preserves Radio category DOM instead of rebuilding the dropdown',
      voicePause.categoryOptionPreserved,
      `${voicePause.transitionMs.toFixed(1)}ms transition`,
    );
    const idleHorizonScans = await page.evaluate(async () => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      window.__godsEyeView.engine.camera.cancelFlight();
      await new Promise((resolve) => setTimeout(resolve, 350));
      const positionBefore = {
        x: window.__godsEyeView.engine.camera.pose().position.x,
        y: window.__godsEyeView.engine.camera.pose().position.y,
        z: window.__godsEyeView.engine.camera.pose().position.z,
      };
      const before = radio.getStats().horizonScans;
      await new Promise((resolve) => setTimeout(resolve, 850));
      const dx = window.__godsEyeView.engine.camera.pose().position.x - positionBefore.x;
      const dy = window.__godsEyeView.engine.camera.pose().position.y - positionBefore.y;
      const dz = window.__godsEyeView.engine.camera.pose().position.z - positionBefore.z;
      return {
        before,
        after: radio.getStats().horizonScans,
        cameraDeltaM: Math.hypot(dx, dy, dz),
      };
    });
    check(
      'stationary Radio view skips repeated 750-marker horizon scans',
      idleHorizonScans.after === idleHorizonScans.before,
      JSON.stringify(idleHorizonScans),
    );
    const idleVoice = await page.evaluate(() => {
      const voice = window.__godsEyeView.voiceCommands;
      voice.setMicrophoneEnabled(true);
      voice.setStatus('listening', 'QA standby');
      voice.setVoiceSpeaker('idle');
      return window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
    });
    check(
      'idle voice never auto-resumes a station paused for voice',
      idleVoice.audioState === 'paused',
      idleVoice.audioState,
    );
    const manualPlayTarget = await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', false);
      manager.setPanelCollapsed('radio-panel', false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const button = document.getElementById('radio-play-btn');
      button.scrollIntoView({ block: 'nearest' });
      const rect = button.getBoundingClientRect();
      const style = getComputedStyle(button);
      return {
        visible: !button.hidden
          && style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) > 0
          && rect.width > 0
          && rect.height > 0,
        enabled: !button.disabled,
        rect: { width: rect.width, height: rect.height },
      };
    });
    check(
      'manual voice takeover targets the visible full Radio Play control',
      manualPlayTarget.visible && manualPlayTarget.enabled,
      JSON.stringify(manualPlayTarget),
    );
    if (manualPlayTarget.visible && manualPlayTarget.enabled) {
      await page.click('#radio-play-btn');
      await page.waitForFunction(() => (
        window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing'
        && window.__godsEyeView.voiceCommands.status === 'idle'
      ));
    }
    const manualTakeover = await page.evaluate(() => ({
      audioState: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState,
      voiceStatus: window.__godsEyeView.voiceCommands.status,
      voiceDucked: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().voiceDucked,
    }));
    check(
      'confirmed manual Radio Play closes active voice and preserves playback',
      manualTakeover.audioState === 'playing'
        && manualTakeover.voiceStatus === 'idle'
        && !manualTakeover.voiceDucked,
      JSON.stringify(manualTakeover),
    );
    await page.evaluate(() => window.__godsEyeView.voiceCommands.setStatus('listening', 'QA standby'));
    const explicitResume = await page.evaluate(async () => {
      const voice = window.__godsEyeView.voiceCommands;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      await radio.play();
      const beforeSpace = radio.getUIState().audioState;
      // Simulate an already-started hold-Space session; click-started open mic
      // deliberately ignores Space takeover, and short taps never claim voice.
      // The provider facade forwards reads, not writes. Set the mounted
      // controller's input owner; assigning on the facade only shadows it.
      const controller = voice.session.adapter.controller;
      const priorPushToTalkMode = controller.pushToTalkMode;
      controller.pushToTalkMode = true;
      document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'Space', key: ' ' }));
      await new Promise((resolve) => setTimeout(resolve, 700));
      const afterSpace = radio.getUIState().audioState;
      document.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, code: 'Space', key: ' ' }));
      controller.pushToTalkMode = priorPushToTalkMode;
      await radio.play();
      voice.setVoiceSpeaker('ai');
      return { beforeSpace, afterSpace, afterAi: radio.getUIState().audioState };
    });
    check(
      'holding Space and assistant speech each pause an explicitly resumed station',
      explicitResume.beforeSpace === 'playing' && explicitResume.afterSpace === 'paused' && explicitResume.afterAi === 'paused',
      JSON.stringify(explicitResume),
    );
    await page.evaluate(() => window.__godsEyeView.voiceCommands.setStatus('idle', 'QA complete'));
    await page.evaluate(async () => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', false);
      manager.setPanelCollapsed('radio-panel', false);
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.waitForFunction(() => {
      const tuner = document.getElementById('radio-tuner');
      const slider = document.getElementById('radio-tuner-slider');
      return !tuner.hidden
        && tuner.getBoundingClientRect().width > 0
        && slider.getBoundingClientRect().width > 0;
    });

    const horizon = await evaluateWithGeo(page, async (qaGeo) => {
      const drawn = window.__qaRadioDrawn;
      // What is drawn, through the engine's picks at every fixture station's
      // canvas point: a station behind the globe projects onto the canvas
      // too (the point sets draw without a depth test), so a pick of one
      // there means it was not culled.
      const setView = (lon, lat = 0) => {
        window.__godsEyeView.engine.camera.cancelFlight();
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({ longitude: lon * Math.PI / 180, latitude: lat * Math.PI / 180, height: 2_000_000 }),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
        window.__godsEyeView.engine.render.request();
      };
      setView(-54);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await drawn.frames(3);
      const front = drawn.drawnStations();
      setView(180, -2);
      await new Promise((resolve) => setTimeout(resolve, 500));
      await drawn.frames(3);
      const back = drawn.drawnStations();
      const frontSet = new Set(front.front);
      return {
        front: front.front.length,
        back: back.front.length,
        farSidePicked: front.back.length + back.back.length,
        changed: back.front.some((id) => !frontSet.has(id)),
      };
    });
    check(
      'far-side markers are horizon culled',
      horizon.front > 0 && horizon.front < 750 && horizon.back > 0 && horizon.back < 750 && horizon.farSidePicked === 0,
      `${horizon.front}/${horizon.back} drawn in front, ${horizon.farSidePicked} picked behind the globe`,
    );
    check('horizon visibility follows camera hemisphere', horizon.changed);

    await page.select('#radio-filter', 'all');
    const absoluteTuner = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const tunerRect = document.getElementById('radio-tuner').getBoundingClientRect();
      const dialRect = document.querySelector('.radio-tuner-dial').getBoundingClientRect();
      const sliderRect = slider.getBoundingClientRect();
      const panelRect = document.querySelector('.radio-panel-inner').getBoundingClientRect();
      const count = style._radioControls._radioTunerStations.length;
      const usable = sliderRect.width - 14;
      const xFor = (coordinate) => sliderRect.left + 7 + usable * coordinate / Math.max(1, count - 1);
      const pointer = (type, x, pointerId = 71) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'mouse',
        clientX: x,
        clientY: sliderRect.top + sliderRect.height / 2,
        buttons: type === 'pointerup' || type === 'pointercancel' ? 0 : 1,
      }));
      const snapshot = () => {
        const markerId = window.__qaRadioDrawn.selectedMarkerId();
        return {
          slot: Number(slider.value),
          markerId,
          ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
          needleX: document.getElementById('radio-tuner-needle').getBoundingClientRect().left,
          ticks: Array.from(document.querySelectorAll('.radio-tuner-tick')).map((tick) => ({
            index: Number(tick.dataset.stationIndex),
            x: tick.getBoundingClientRect().left,
          })),
        };
      };
      const playsBefore = window.__qaRadioPlayCalls.length;
      const frozenSignature = style._radioControls._radioTunerBandSignature;
      // The tuner renders from the Radio store; let Vue patch before reading.
      const rendered = () => Promise.resolve();
      pointer('pointerdown', xFor(0));
      await rendered();
      const left = snapshot();
      const centerCoordinate = (count - 1) / 2;
      pointer('pointermove', xFor(centerCoordinate));
      await rendered();
      const center = snapshot();
      pointer('pointermove', xFor(centerCoordinate + 2));
      await rendered();
      const shifted = snapshot();
      pointer('pointermove', xFor(count - 1));
      await rendered();
      const right = snapshot();
      const shiftedByIndex = new Map(shifted.ticks.map((tick) => [tick.index, tick.x]));
      const sharedTick = center.ticks.find((tick) => shiftedByIndex.has(tick.index));
      const tapeDelta = sharedTick ? shiftedByIndex.get(sharedTick.index) - sharedTick.x : null;
      const needleDelta = shifted.needleX - center.needleX;
      pointer('pointercancel', xFor(count - 1));
      const state = radio.getUIState();
      return {
        visible: !document.getElementById('radio-tuner').hidden,
        stationCount: count,
        sliderMax: Number(slider.max),
        bandFrozen: style._radioControls._radioTunerBandSignature === frozenSignature,
        left,
        center,
        shifted,
        right,
        leftExpectedId: style._radioControls._radioTunerStations[0]?.id || null,
        centerExpectedId: style._radioControls._radioTunerStations[Math.floor(centerCoordinate + 0.5)]?.id || null,
        rightExpectedId: style._radioControls._radioTunerStations[count - 1]?.id || null,
        centerExpected: Math.floor(centerCoordinate + 0.5),
        tapeDelta,
        needleDelta,
        maxTickCount: Math.max(left.ticks.length, center.ticks.length, shifted.ticks.length, right.ticks.length),
        noPreviewPlay: window.__qaRadioPlayCalls.length === playsBefore,
        tuningActiveAfterCancel: state.tuningActive,
        tuningStaticAfterCancel: state.tuningStatic,
        contained: tunerRect.left >= panelRect.left && tunerRect.right <= panelRect.right
          && dialRect.left >= tunerRect.left && dialRect.right <= tunerRect.right
          && sliderRect.left >= dialRect.left && sliderRect.right <= dialRect.right,
      };
    });
    check(
      'All maps the complete directory to real left, center, and right station snap points',
      absoluteTuner.visible && absoluteTuner.stationCount === 750 && absoluteTuner.sliderMax === 749
        && absoluteTuner.left.slot === 0
        && absoluteTuner.left.markerId === `radio:selected:${absoluteTuner.leftExpectedId}`
        && absoluteTuner.center.slot === absoluteTuner.centerExpected
        && absoluteTuner.center.markerId === `radio:selected:${absoluteTuner.centerExpectedId}`
        && absoluteTuner.right.slot === absoluteTuner.stationCount - 1
        && absoluteTuner.right.markerId === `radio:selected:${absoluteTuner.rightExpectedId}`
        && absoluteTuner.bandFrozen && absoluteTuner.noPreviewPlay
        && !absoluteTuner.tuningActiveAfterCancel && !absoluteTuner.tuningStaticAfterCancel
        && absoluteTuner.contained,
      JSON.stringify(absoluteTuner),
    );
    check(
      'the bounded virtual tape moves left faster than the needle moves right',
      absoluteTuner.maxTickCount > 0 && absoluteTuner.maxTickCount < 100
        && absoluteTuner.needleDelta > 0 && absoluteTuner.tapeDelta < 0
        && Math.abs(absoluteTuner.tapeDelta) >= absoluteTuner.needleDelta * 4,
      JSON.stringify({
        maxTickCount: absoluteTuner.maxTickCount,
        needleDelta: absoluteTuner.needleDelta,
        tapeDelta: absoluteTuner.tapeDelta,
      }),
    );
    const tunerCancelRestore = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      // Capture a fresh gesture's complete presentation anchor before moving
      // to a different absolute directory station.
      const beforeStations = [...style._radioControls._radioTunerStations];
      const sliderRect = slider.getBoundingClientRect();
      const xFor = (index) => sliderRect.left + 7
        + (sliderRect.width - 14) * index / Math.max(1, beforeStations.length - 1);
      const pointer = (type, index, pointerId = 52) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: sliderRect.top + sliderRect.height / 2,
        buttons: type === 'pointercancel' || type === 'pointerup' ? 0 : 1,
      }));
      const camera = gev.viewer.camera;
      const originalFlyTo = window.__godsEyeView.engine.camera.flyTo;
      const flyToCalls = [];
      camera.flyTo = (options) => flyToCalls.push(options);
      const before = {
        signature: style._radioControls._radioTunerBandSignature,
        ids: beforeStations.map((station) => station.id),
        slot: Number(slider.value),
        selectedId: radio.getUIState().selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
      };
      const targetIndex = before.slot < beforeStations.length - 2 ? before.slot + 2 : before.slot - 2;
      pointer('pointerdown', before.slot);
      pointer('pointermove', targetIndex);
      // The tuner renders from the Radio store; let Vue patch before reading.
      await Promise.resolve();
      const shiftedSlot = Number(slider.value);
      const previewBeforeCancel = window.__qaRadioDrawn.selectedMarkerId();
      const flyToCallsBeforeCancel = flyToCalls.length;
      pointer('pointercancel', targetIndex);
      await Promise.resolve();
      const afterStations = style._radioControls._radioTunerStations;
      const afterState = radio.getUIState();
      const after = {
        signature: style._radioControls._radioTunerBandSignature,
        ids: afterStations.map((station) => station.id),
        slot: Number(slider.value),
        selectedId: afterState.selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
        previewId: null,
        tuningActive: afterState.tuningActive,
      };
      const flyToCallsAfterCancel = flyToCalls.length;
      const previewId = window.__qaRadioDrawn.selectedMarkerId();
      after.previewId = previewId;
      const filterControl = document.getElementById('radio-filter');
      const changedFilter = afterState.filter === 'news' ? 'all' : 'news';
      const changedFilterSnapshot = radio.getAcceptedCatalogSnapshot();
      const changedFilterPlays = window.__qaRadioPlayCalls.length;
      const changedFilterCameraMoves = flyToCalls.length;
      filterControl.value = changedFilter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const changedFilterState = radio.getUIState();
      // The marker is an instance of the radio-selected set: whether the
      // layer rebuilt it is not observable through the contract (the old
      // check compared Entity objects), only which station it is drawn on.
      const changedFilterEntity = window.__qaRadioDrawn.selectedMarkerId();
      const changedFilterCleanup = {
        filter: changedFilterState.filter,
        restoredStationId: changedFilterState.tuningRestoredStationId,
        selectedId: changedFilterState.selected?.id || null,
        entityId: changedFilterEntity,
        snapshotPreserved: radio.getAcceptedCatalogSnapshot() === changedFilterSnapshot,
        playDelta: window.__qaRadioPlayCalls.length - changedFilterPlays,
        cameraDelta: flyToCalls.length - changedFilterCameraMoves,
      };
      const sameFilterBegan = radio.beginTuning();
      const sameFilterCancelled = radio.cancelTuning();
      const sameFilterRestoredState = radio.getUIState();
      const sameFilterSnapshot = radio.getAcceptedCatalogSnapshot();
      const sameFilterPlays = window.__qaRadioPlayCalls.length;
      const sameFilterCameraMoves = flyToCalls.length;
      filterControl.value = sameFilterRestoredState.filter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      const sameFilterState = radio.getUIState();
      const sameFilterEntity = window.__qaRadioDrawn.selectedMarkerId();
      const sameFilterCleanup = {
        began: sameFilterBegan,
        cancelled: sameFilterCancelled,
        restoredBefore: sameFilterRestoredState.tuningRestoredStationId,
        restoredAfter: sameFilterState.tuningRestoredStationId,
        filter: sameFilterState.filter,
        selectedId: sameFilterState.selected?.id || null,
        entityId: sameFilterEntity,
        snapshotPreserved: radio.getAcceptedCatalogSnapshot() === sameFilterSnapshot,
        playDelta: window.__qaRadioPlayCalls.length - sameFilterPlays,
        cameraDelta: flyToCalls.length - sameFilterCameraMoves,
      };
      filterControl.value = afterState.filter;
      filterControl.dispatchEvent(new Event('change', { bubbles: true }));
      camera.flyTo = originalFlyTo;
      return {
        before,
        targetIndex,
        shiftedSlot,
        previewBeforeCancel,
        flyToCallsBeforeCancel,
        flyToCallsAfterCancel,
        changedFilter,
        changedFilterCleanup,
        sameFilterCleanup,
        after,
        identityRestored: afterStations.length === beforeStations.length
          && afterStations.every((station, index) => station === beforeStations[index]),
      };
    });
    check(
      'pointer cancel restores the exact pre-drag full-directory tuner anchor without playback',
      tunerCancelRestore.shiftedSlot === tunerCancelRestore.targetIndex
        && tunerCancelRestore.after.signature === tunerCancelRestore.before.signature
        && JSON.stringify(tunerCancelRestore.after.ids) === JSON.stringify(tunerCancelRestore.before.ids)
        && tunerCancelRestore.after.slot === tunerCancelRestore.before.slot
        && tunerCancelRestore.after.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.after.plays === tunerCancelRestore.before.plays
        && tunerCancelRestore.previewBeforeCancel !== `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.flyToCallsBeforeCancel > 0
        && tunerCancelRestore.flyToCallsAfterCancel === tunerCancelRestore.flyToCallsBeforeCancel
        && tunerCancelRestore.after.previewId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && !tunerCancelRestore.after.tuningActive
        && tunerCancelRestore.identityRestored,
      JSON.stringify(tunerCancelRestore),
    );
    check(
      'accepted changed-filter action clears the cancel-restored marker onto the selection without side effects',
      tunerCancelRestore.changedFilterCleanup.filter === tunerCancelRestore.changedFilter
        && tunerCancelRestore.changedFilterCleanup.restoredStationId === null
        && tunerCancelRestore.changedFilterCleanup.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.changedFilterCleanup.entityId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.changedFilterCleanup.snapshotPreserved
        && tunerCancelRestore.changedFilterCleanup.playDelta === 0
        && tunerCancelRestore.changedFilterCleanup.cameraDelta === 0,
      JSON.stringify(tunerCancelRestore.changedFilterCleanup),
    );
    check(
      'accepted same-filter action clears the cancel-restored marker onto the selection without side effects',
      tunerCancelRestore.sameFilterCleanup.began
        && tunerCancelRestore.sameFilterCleanup.cancelled
        && tunerCancelRestore.sameFilterCleanup.restoredBefore === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.sameFilterCleanup.restoredAfter === null
        && tunerCancelRestore.sameFilterCleanup.filter === tunerCancelRestore.changedFilter
        && tunerCancelRestore.sameFilterCleanup.selectedId === tunerCancelRestore.before.selectedId
        && tunerCancelRestore.sameFilterCleanup.entityId === `radio:selected:${tunerCancelRestore.before.selectedId}`
        && tunerCancelRestore.sameFilterCleanup.snapshotPreserved
        && tunerCancelRestore.sameFilterCleanup.playDelta === 0
        && tunerCancelRestore.sameFilterCleanup.cameraDelta === 0,
      JSON.stringify(tunerCancelRestore.sameFilterCleanup),
    );
    const tunerRefreshTarget = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const stations = gev.styleManager._radioControls._radioTunerStations;
      const targetIndex = 1;
      const rect = slider.getBoundingClientRect();
      const clientX = rect.left + 7 + (rect.width - 14) * targetIndex / Math.max(1, stations.length - 1);
      slider.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
        buttons: 1,
      }));
      const station = stations[targetIndex];
      return {
        id: station.id,
        name: station.name,
        clientX,
        clientY: rect.top + rect.height / 2,
        generation: gev.dataManager.layers.get('radio').module.getUIState().tuningCatalogGeneration,
        plays: window.__qaRadioPlayCalls.length,
      };
    });
    catalogStations = stations.map((station) => (
      station.id === tunerRefreshTarget.id
        ? { ...station, name: `${station.name} B`, streamUrl: `${station.streamUrl}?generation=b` }
        : station
    ));
    catalogGeneration = 2;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    const tunerRefreshRelease = await page.evaluate(async (target) => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const displayedBeforeRelease = document.getElementById('radio-tuner-station').textContent;
      const frozenGeneration = gev.dataManager.layers.get('radio').module.getUIState().tuningCatalogGeneration;
      slider.dispatchEvent(new PointerEvent('pointerup', {
        bubbles: true,
        pointerId: 51,
        pointerType: 'mouse',
        clientX: target.clientX,
        clientY: target.clientY,
      }));
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      // The playback line renders from the Radio store once Vue flushes.
      const message = await Promise.resolve().then(
        () => document.getElementById('radio-playback-state').textContent,
      );
      return {
        displayedBeforeRelease,
        frozenGeneration,
        unavailableId: state.tuningUnavailableStationId,
        selectedId: state.selected?.id || null,
        plays: window.__qaRadioPlayCalls.length,
        value: document.getElementById('radio-tuner-value').textContent,
        stationText: document.getElementById('radio-tuner-station').textContent,
        message,
        targetId: target.id,
      };
    }, tunerRefreshTarget);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tuner-refresh-unavailable.png') });
    check(
      'mid-drag catalog replacement keeps generation A visible and reports release unavailable',
      tunerRefreshTarget.generation === 1
        && tunerRefreshRelease.frozenGeneration === 1
        && tunerRefreshRelease.displayedBeforeRelease === tunerRefreshTarget.name
        && tunerRefreshRelease.unavailableId === tunerRefreshTarget.id
        && tunerRefreshRelease.selectedId !== tunerRefreshTarget.id
        && tunerRefreshRelease.plays === tunerRefreshTarget.plays
        && tunerRefreshRelease.value === 'OFF AIR'
        && tunerRefreshRelease.stationText === 'STATION UNAVAILABLE'
        && /unavailable after directory refresh/i.test(tunerRefreshRelease.message),
      JSON.stringify(tunerRefreshRelease),
    );
    catalogStations = stations;
    catalogGeneration = 3;
    await page.evaluate(async () => {
      await window.__godsEyeView.dataManager.layers.get('radio').module.update();
    });
    const tunerDirectRelease = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const needle = document.getElementById('radio-tuner-needle');
      const startSlot = Number(slider.value);
      const max = Number(slider.max);
      const direction = startSlot < max ? 1 : -1;
      const targetIndex = startSlot + direction;
      const targetId = gev.styleManager._radioControls._radioTunerStations[targetIndex]?.id || null;
      const rect = slider.getBoundingClientRect();
      const xFor = (index) => rect.left + 7 + (rect.width - 14) * index / Math.max(1, max);
      const pointer = (type, index) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 41,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: rect.top + rect.height / 2,
        buttons: type === 'pointerup' ? 0 : 1,
      }));
      const playsBefore = window.__qaRadioPlayCalls.length;
      pointer('pointerdown', startSlot);
      pointer('pointermove', targetIndex);
      const previewPlays = window.__qaRadioPlayCalls.length;
      pointer('pointerup', targetIndex);
      // The tuner renders from the Radio store; sample once Vue has patched.
      await Promise.resolve();
      const samples = [needle.getBoundingClientRect().left];
      await new Promise((resolve) => requestAnimationFrame(resolve));
      samples.push(needle.getBoundingClientRect().left);
      await new Promise((resolve) => setTimeout(resolve, 60));
      samples.push(needle.getBoundingClientRect().left);
      await new Promise((resolve) => setTimeout(resolve, 180));
      samples.push(needle.getBoundingClientRect().left);
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        direction,
        targetId,
        selectedId: state.selected?.id || null,
        sliderSlot: Number(slider.value),
        expectedSlot: targetIndex,
        previewPlayDelta: previewPlays - playsBefore,
        commitPlayDelta: window.__qaRadioPlayCalls.length - playsBefore,
        audioState: state.audioState,
        tuningStatic: state.tuningStatic,
        samples,
        spread: Math.max(...samples) - Math.min(...samples),
      };
    });
    check(
      'from a stopped Radio, pointer release only selects the nearest station, silently and without a needle sweep',
      tunerDirectRelease.targetId
        && tunerDirectRelease.selectedId === tunerDirectRelease.targetId
        && tunerDirectRelease.sliderSlot === tunerDirectRelease.expectedSlot
        && tunerDirectRelease.previewPlayDelta === 0
        && tunerDirectRelease.commitPlayDelta === 0
        && tunerDirectRelease.audioState === 'stopped'
        && !tunerDirectRelease.tuningStatic
        && tunerDirectRelease.spread < 0.5,
      JSON.stringify(tunerDirectRelease),
    );
    // The release plays only if a stream was active when the drag began.
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.togglePlayback({ origin: 'user' }));
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    // Earlier cases scroll and resize the directory. Bring the physical drag
    // target back into its scroller before deriving viewport mouse coordinates.
    await page.$eval('#radio-tuner-slider', (slider) => slider.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await page.waitForFunction(() => {
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const x = rect.left + 7 + (rect.width - 14) * Number(slider.value) / Math.max(1, Number(slider.max));
      return document.elementFromPoint(x, rect.top + rect.height / 2) === slider;
    });
    const tunerCommitTarget = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const targetIndex = 11;
      slider.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, pointerId: 1 }));
      const station = gev.styleManager._radioControls._radioTunerStations[targetIndex];
      const rect = slider.getBoundingClientRect();
      const currentRatio = Number(slider.value) / Math.max(1, Number(slider.max));
      window.__qaRadioDelayNextPlay = true;
      return {
        id: station.id,
        targetIndex,
        count: gev.styleManager._radioControls._radioTunerStations.length,
        frozenSignature: gev.styleManager._radioControls._radioTunerBandSignature,
        startX: rect.left + 7 + (rect.width - 14) * currentRatio,
        targetX: rect.left + 7 + (rect.width - 14) * targetIndex
          / Math.max(1, gev.styleManager._radioControls._radioTunerStations.length - 1),
        y: rect.top + rect.height / 2,
      };
    });
    await page.mouse.move(tunerCommitTarget.startX, tunerCommitTarget.y);
    await page.mouse.down();
    await page.mouse.move(tunerCommitTarget.targetX, tunerCommitTarget.y, { steps: 12 });
    await page.mouse.up();
    await whenFramesDrawn(page);
    const tunerCommit = await page.evaluate((target) => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const state = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        id: target.id,
        audioState: state.audioState,
        tuningStatic: state.tuningStatic,
        awaiting: state.tuningAwaitingStationId,
        signatureStable: gev.styleManager._radioControls._radioTunerBandSignature === target.frozenSignature,
        selectedIndex: gev.styleManager._radioControls._radioTunerStations.findIndex((item) => item.id === state.selected?.id),
        sliderSlot: Number(slider.value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        pinned: gev.styleManager._radioControls._radioTunerBandPinnedForNavigation,
      };
    }, tunerCommitTarget);
    check(
      'tuner release keeps channel 12 pinned while its broadcaster connects',
      tunerCommit.audioState === 'loading' && tunerCommit.tuningStatic && tunerCommit.awaiting === tunerCommit.id
        && tunerCommit.signatureStable && tunerCommit.selectedIndex === 11
        && tunerCommit.sliderSlot === 11
        && Math.abs(tunerCommit.ratio - 11 / Math.max(1, tunerCommitTarget.count - 1)) < 0.0001
        && tunerCommit.pinned,
      JSON.stringify(tunerCommit),
    );
    await page.evaluate(() => window.__qaReleaseRadioPlay());
    await page.waitForFunction(
      (id) => {
        const state = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState();
        return state.selected?.id === id && state.audioState === 'playing' && !state.tuningActive && !state.tuningStatic;
      },
      {},
      tunerCommit.id,
    );
    const broadcastIndicator = await page.evaluate(() => ({
      active: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
      innerOpacity: getComputedStyle(document.querySelector('#title-bar .title-logo'), '::before').opacity,
      outerOpacity: getComputedStyle(document.querySelector('#title-bar .title-logo'), '::after').opacity,
    }));
    check('actual broadcaster playback fades out the tuner static', true, tunerCommit.id);
    check(
      'confirmed playback shows two restrained broadcast waves above the main logo',
      broadcastIndicator.active
        && Number(broadcastIndicator.innerOpacity) > 0 && Number(broadcastIndicator.innerOpacity) <= 0.28
        && Number(broadcastIndicator.outerOpacity) > 0 && Number(broadcastIndicator.outerOpacity) <= 0.17,
      JSON.stringify(broadcastIndicator),
    );
    const microDragStart = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const ratio = Number(slider.value) / Math.max(1, Number(slider.max));
      return {
        x: rect.left + 7 + (rect.width - 14) * ratio,
        y: rect.top + rect.height / 2,
        ratio,
        usableWidth: rect.width - 14,
        signature: style._radioControls._radioTunerBandSignature,
      };
    });
    const microDragSamples = [];
    await page.mouse.move(microDragStart.x, microDragStart.y);
    await page.mouse.down();
    for (const delta of [1, 2, 10]) {
      await page.mouse.move(microDragStart.x + delta, microDragStart.y);
      await sleep(80);
      microDragSamples.push(await page.evaluate((pixelDelta) => {
        const style = window.__godsEyeView.styleManager;
        const slider = document.getElementById('radio-tuner-slider');
        return {
          pixelDelta,
          slot: Number(slider.value),
          ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
          signature: style._radioControls._radioTunerBandSignature,
        };
      }, delta));
    }
    await page.mouse.move(microDragStart.x, microDragStart.y);
    await page.mouse.up();
    await page.screenshot({ path: path.join(SHOTS_DIR, 'tuner-micro-drag.png') });
    const microDragPlayback = await page.evaluate(async () => {
      const mod = window.__godsEyeView.dataManager.layers.get('radio').module;
      const deadline = Date.now() + 2_000;
      let state = mod.getUIState();
      while (state.audioState === 'loading' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        state = mod.getUIState();
      }
      if (state.audioState !== 'playing') {
        await mod.play({ origin: 'user' });
        state = mod.getUIState();
      }
      return { audioState: state.audioState, selectedId: state.selected?.id || null };
    });
    check(
      'native micro-drag leaves the selected station playable',
      microDragPlayback.audioState === 'playing' && Boolean(microDragPlayback.selectedId),
      JSON.stringify(microDragPlayback),
    );
    check(
      'native 1px, 2px, and 10px tuner moves stay monotonic on one frozen strip',
      microDragSamples.every((sample) => sample.signature === microDragStart.signature
        && Math.abs(sample.ratio - (microDragStart.ratio + sample.pixelDelta / microDragStart.usableWidth)) < 0.002)
        && microDragSamples.every((sample, index) => index === 0
          || (sample.slot >= microDragSamples[index - 1].slot
            && sample.ratio >= microDragSamples[index - 1].ratio)),
      JSON.stringify(microDragSamples),
    );
    const viewportTuner = await evaluateWithGeo(page, async (qaGeo, selectedId) => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const before = {
        signature: style._radioControls._radioTunerBandSignature,
        ids: style._radioControls._radioTunerStations.map((station) => station.id),
        selectedIndex: style._radioControls._radioTunerStations.findIndex((station) => station.id === selectedId),
        needle: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
      };
      const current = window.__godsEyeView.engine.camera.pose().cartographic;
      const oppositeLongitude = ((current.longitude + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
      window.__godsEyeView.engine.host.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: oppositeLongitude,
          latitude: -current.latitude,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      gev.viewer.camera.changed.raiseEvent();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const stations = gev.styleManager._radioControls._radioTunerStations;
      const selectedIndex = stations.findIndex((station) => station.id === selectedId);
      return {
        before,
        signature: style._radioControls._radioTunerBandSignature,
        ids: stations.map((station) => station.id),
        count: stations.length,
        selectedIndex,
        needle: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
      };
    }, tunerCommit.id);
    check(
      'globe rotation leaves the catalog/filter directory order and absolute needle unchanged',
      viewportTuner.count === 750
        && viewportTuner.signature === viewportTuner.before.signature
        && JSON.stringify(viewportTuner.ids) === JSON.stringify(viewportTuner.before.ids)
        && viewportTuner.selectedIndex === viewportTuner.before.selectedIndex
        && Math.abs(viewportTuner.needle - viewportTuner.before.needle) < 0.0001,
      JSON.stringify(viewportTuner),
    );
    const nextNeedleBefore = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const selectedId = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id;
      const selectedIndex = style._radioControls._radioTunerStations.findIndex((station) => station.id === selectedId);
      const selectedPoolIndex = style._radioControls._radioTunerPool.findIndex((station) => station.id === selectedId);
      const expectedPoolIndex = (selectedPoolIndex + 1) % style._radioControls._radioTunerPool.length;
      return {
        signature: style._radioControls._radioTunerBandSignature,
        selectedIndex,
        count: style._radioControls._radioTunerStations.length,
        expectedId: style._radioControls._radioTunerPool[expectedPoolIndex]?.id || null,
      };
    });
    await page.$eval('#radio-next-btn', (button) => button.click());
    await whenFramesDrawn(page);
    const nextNeedleAfter = await page.evaluate(() => {
      const style = window.__godsEyeView.styleManager;
      const selectedId = window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id;
      const selectedIndex = style._radioControls._radioTunerStations.findIndex((station) => station.id === selectedId);
      return {
        signature: style._radioControls._radioTunerBandSignature,
        selectedId,
        selectedIndex,
        count: style._radioControls._radioTunerStations.length,
        sliderSlot: Number(document.getElementById('radio-tuner-slider').value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        pinned: style._radioControls._radioTunerBandPinnedForNavigation,
      };
    });
    check(
      'Next advances one absolute station and keeps the needle on its full-directory index',
      nextNeedleAfter.selectedId === nextNeedleBefore.expectedId
        && nextNeedleAfter.signature === nextNeedleBefore.signature
        && nextNeedleAfter.count === nextNeedleBefore.count
        && nextNeedleAfter.sliderSlot === nextNeedleAfter.selectedIndex
        && Math.abs(nextNeedleAfter.ratio
          - nextNeedleAfter.selectedIndex / Math.max(1, nextNeedleAfter.count - 1)) < 0.0001,
      JSON.stringify({ before: nextNeedleBefore, after: nextNeedleAfter }),
    );
    const tunerKeyboard = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const key = (type, value) => slider.dispatchEvent(new KeyboardEvent(type, {
        bubbles: true,
        cancelable: true,
        key: value,
      }));
      const markerId = () => window.__qaRadioDrawn.selectedMarkerId();
      const startIndex = Number(slider.value);
      const expectedIndex = Math.min(style._radioControls._radioTunerStations.length - 1, startIndex + 1);
      const expectedId = style._radioControls._radioTunerStations[expectedIndex]?.id || null;
      const playsBefore = window.__qaRadioPlayCalls.length;
      key('keydown', 'ArrowRight');
      const preview = {
        slot: Number(slider.value),
        markerId: markerId(),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      key('keyup', 'ArrowRight');
      const committed = {
        selectedId: radio.getUIState().selected?.id || null,
        slot: Number(slider.value),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - playsBefore,
      };
      const committedPlays = window.__qaRadioPlayCalls.length;
      key('keydown', 'ArrowRight');
      key('keydown', 'Escape');
      const cancelled = {
        selectedId: radio.getUIState().selected?.id || null,
        slot: Number(slider.value),
        tuningActive: radio.getUIState().tuningActive,
        playDelta: window.__qaRadioPlayCalls.length - committedPlays,
      };
      const count = style._radioControls._radioTunerStations.length;
      const pageStep = Math.max(1, Math.round((count - 1) / 10));
      const previewAndCancel = (value, expectedSlot) => {
        const beforePlays = window.__qaRadioPlayCalls.length;
        key('keydown', value);
        const result = {
          key: value,
          slot: Number(slider.value),
          expectedSlot,
          playDelta: window.__qaRadioPlayCalls.length - beforePlays,
        };
        key('keydown', 'Escape');
        result.restoredSlot = Number(slider.value);
        result.cancelPlayDelta = window.__qaRadioPlayCalls.length - beforePlays;
        return result;
      };
      const base = committed.slot;
      const navigation = [
        previewAndCancel('Home', 0),
        previewAndCancel('End', count - 1),
        previewAndCancel('PageUp', Math.min(count - 1, base + pageStep)),
        previewAndCancel('PageDown', Math.max(0, base - pageStep)),
      ];
      return { startIndex, expectedIndex, expectedId, preview, committed, cancelled, navigation,
        panelStayedOpen: !document.getElementById('radio-panel').classList.contains('collapsed') };
    });
    check(
      'keyboard preview is silent, key release commits once, and Escape restores the committed station',
      tunerKeyboard.preview.slot === tunerKeyboard.expectedIndex
        && tunerKeyboard.preview.markerId === `radio:selected:${tunerKeyboard.expectedId}`
        && tunerKeyboard.preview.tuningActive && tunerKeyboard.preview.playDelta === 0
        && tunerKeyboard.committed.selectedId === tunerKeyboard.expectedId
        && tunerKeyboard.committed.slot === tunerKeyboard.expectedIndex
        && !tunerKeyboard.committed.tuningActive && tunerKeyboard.committed.playDelta === 1
        && tunerKeyboard.cancelled.selectedId === tunerKeyboard.expectedId
        && tunerKeyboard.cancelled.slot === tunerKeyboard.expectedIndex
        && !tunerKeyboard.cancelled.tuningActive && tunerKeyboard.cancelled.playDelta === 0
        && tunerKeyboard.panelStayedOpen,
      JSON.stringify(tunerKeyboard),
    );
    check(
      'Home, End, PageUp, and PageDown preview their absolute targets and cancel without playback',
      tunerKeyboard.navigation.every((sample) => sample.slot === sample.expectedSlot
        && sample.restoredSlot === tunerKeyboard.expectedIndex
        && sample.playDelta === 0 && sample.cancelPlayDelta === 0),
      JSON.stringify(tunerKeyboard.navigation),
    );
    await page.select('#radio-filter', 'news');
    const filteredTunerCenter = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const style = gev.styleManager;
      const radio = gev.dataManager.layers.get('radio').module;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const count = style._radioControls._radioTunerStations.length;
      const centerIndex = Math.floor((count - 1) / 2 + 0.5);
      const clientX = rect.left + rect.width / 2;
      slider.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true,
        pointerId: 88,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
        buttons: 1,
      }));
      const preview = {
        filter: radio.getUIState().filter,
        filteredCount: radio.getUIState().filteredCount,
        count,
        centerIndex,
        slot: Number(slider.value),
        ratio: Number(document.getElementById('radio-tuner').style.getPropertyValue('--radio-tuner-ratio')),
        markerId: window.__qaRadioDrawn.selectedMarkerId(),
        expectedId: style._radioControls._radioTunerStations[centerIndex]?.id || null,
      };
      slider.dispatchEvent(new PointerEvent('pointercancel', {
        bubbles: true,
        pointerId: 88,
        pointerType: 'mouse',
        clientX,
        clientY: rect.top + rect.height / 2,
      }));
      return preview;
    });
    check(
      'filtered-directory center means half of the currently available station total',
      filteredTunerCenter.filter === 'news'
        && filteredTunerCenter.count === filteredTunerCenter.filteredCount
        && filteredTunerCenter.count > 1 && filteredTunerCenter.count < 750
        && filteredTunerCenter.slot === filteredTunerCenter.centerIndex
        && Math.abs(filteredTunerCenter.ratio - 0.5) < 0.0001
        && filteredTunerCenter.markerId === `radio:selected:${filteredTunerCenter.expectedId}`,
      JSON.stringify(filteredTunerCenter),
    );
    await page.select('#radio-filter', 'all');
    const fullPoolNavigation = await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const radio = gev.dataManager.layers.get('radio').module;
      const pool = gev.styleManager._radioControls._radioTunerPool;
      const ids = pool.map((station) => station.id);
      const selectWithoutPlayback = (index) => radio.selectStation(ids[index], {
        autoplay: false,
        focus: false,
        origin: 'programmatic',
      });
      selectWithoutPlayback(40);
      radio.cycleStation(1, { stationIds: ids, autoplay: false });
      const afterForty = radio.getUIState().selected?.id || null;
      selectWithoutPlayback(0);
      radio.cycleStation(-1, { stationIds: ids, autoplay: false });
      const afterPreviousWrap = radio.getUIState().selected?.id || null;
      selectWithoutPlayback(ids.length - 1);
      radio.cycleStation(1, { stationIds: ids, autoplay: false });
      const afterNextWrap = radio.getUIState().selected?.id || null;
      return {
        poolLength: ids.length,
        afterForty,
        expectedAfterForty: ids[41],
        afterPreviousWrap,
        expectedPreviousWrap: ids.at(-1),
        afterNextWrap,
        expectedNextWrap: ids[0],
      };
    });
    check(
      'Previous and Next traverse beyond channel 40 and wrap across the complete tuner pool',
      fullPoolNavigation.poolLength > 41
        && fullPoolNavigation.afterForty === fullPoolNavigation.expectedAfterForty
        && fullPoolNavigation.afterPreviousWrap === fullPoolNavigation.expectedPreviousWrap
        && fullPoolNavigation.afterNextWrap === fullPoolNavigation.expectedNextWrap,
      JSON.stringify(fullPoolNavigation),
    );
    await evaluateWithGeo(page, async (qaGeo) => {
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    await whenFramesDrawn(page);
    // Next left the Radio stopped; a release plays only from an active stream.
    await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.togglePlayback({ origin: 'user' }));
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    const failedTuner = await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      const slider = document.getElementById('radio-tuner-slider');
      const rect = slider.getBoundingClientRect();
      const count = gev.styleManager._radioControls._radioTunerStations.length;
      const current = Number(slider.value);
      const target = Math.min(count - 1, current + 4);
      const xFor = (index) => rect.left + 7 + (rect.width - 14) * index / Math.max(1, count - 1);
      const pointer = (type, index) => slider.dispatchEvent(new PointerEvent(type, {
        bubbles: true,
        pointerId: 2,
        pointerType: 'mouse',
        clientX: xFor(index),
        clientY: rect.top + rect.height / 2,
        buttons: type === 'pointerup' ? 0 : 1,
      }));
      window.__qaRadioFailNextPlay = true;
      pointer('pointerdown', current);
      pointer('pointermove', target);
      pointer('pointerup', target);
      await new Promise((resolve) => setTimeout(resolve));
      const failed = gev.dataManager.layers.get('radio').module.getUIState();
      gev.dataManager.layers.get('radio').module.stopPlayback();
      const stopped = gev.dataManager.layers.get('radio').module.getUIState();
      return {
        failed: {
          audioState: failed.audioState,
          tuningStatic: failed.tuningStatic,
          awaiting: failed.tuningAwaitingStationId,
          broadcasting: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
        },
        stopped: {
          tuningStatic: stopped.tuningStatic,
          awaiting: stopped.tuningAwaitingStationId,
          broadcasting: document.getElementById('title-bar').classList.contains('radio-broadcasting'),
        },
      };
    });
    check(
      'failed tuner stations retain the audible static hint until Stop',
      failedTuner.failed.audioState === 'error' && failedTuner.failed.tuningStatic && failedTuner.failed.awaiting
        && !failedTuner.failed.broadcasting && !failedTuner.stopped.tuningStatic
        && !failedTuner.stopped.awaiting && !failedTuner.stopped.broadcasting,
      JSON.stringify(failedTuner),
    );
    await page.select('#radio-filter', 'news');

    const markerTarget = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const drawn = window.__qaRadioDrawn;
      // Radio clusters on screen in its own display now (no Cesium
      // clustering to switch off); at this 500 km view the News stations
      // are hundreds of pixels apart, so none cluster.
      const selectedId = radio.getUIState().selected?.id || null;
      if (selectedId) {
        radio.selectStation(selectedId, {
          autoplay: false,
          focus: false,
          origin: 'programmatic',
        });
      }
      window.__godsEyeView.engine.camera.cancelFlight();
      const markerView = {
        destination: qaGeo.cartographic.toCartesian({
          longitude: -174 * Math.PI / 180,
          latitude: 6 * Math.PI / 180,
          height: 500_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      };
      window.__godsEyeView.engine.camera.setView(markerView);
      await new Promise((resolve) => {
        let removePostRender = null;
        removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
          removePostRender?.();
          resolve();
        });
        window.__godsEyeView.engine.render.request();
      });
      radio.setFilter('news');
      window.__godsEyeView.engine.render.request();
      await new Promise((resolve) => setTimeout(resolve, 500));
      const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      return new Promise((resolve) => {
        let removePostRender = null;
        let timeout = null;
        let lastObservation = null;
        const finish = (result) => {
          clearTimeout(timeout);
          removePostRender?.();
          resolve(result);
        };
        const probe = () => {
          const camera = window.__godsEyeView.engine.camera.pose().cartographic;
          const longitude = camera.longitude * 180 / Math.PI;
          const latitude = camera.latitude * 180 / Math.PI;
          if (Math.abs(longitude + 174) > 0.5 || Math.abs(latitude - 6) > 0.5) {
            window.__godsEyeView.engine.camera.cancelFlight();
            window.__godsEyeView.engine.camera.setView(markerView);
            window.__godsEyeView.engine.render.request();
            return;
          }
          const diagnostics = radio.getOverlayDiagnostics();
          const singletonIds = new Set(diagnostics.singletonIds);
          // A singleton label painted on the shared host whose station point
          // a pick at the label's anchor finds (the station's own pickId).
          let pickableSingletonCount = 0;
          let paintedSingletonCount = 0;
          for (const overlayId of singletonIds) {
            const id = overlayId.slice('station:'.length);
            const paintRect = getOverlayPaintRect('radio', overlayId);
            if (!paintRect) continue;
            paintedSingletonCount += 1;
            const canvas = drawn.canvasPoint(paintRect.entry?.position);
            const pickable = drawn.picksAt(canvas, 16)
              .some((picked) => picked.owner === 'radio-stations' && picked.id === `radio:${id}`);
            if (pickable) pickableSingletonCount += 1;
            if (pickable && canvas.x > 300 && canvas.x < 1100 && canvas.y > 100 && canvas.y < 800) {
              finish({
                found: true,
                id,
                x: canvas.x,
                y: canvas.y,
                pickable,
                labelPainted: true,
                singletonTexts: diagnostics.singletonTexts,
              });
              return;
            }
          }
          lastObservation = {
            found: false,
            filter: radio.getUIState().filter,
            drawn: drawn.counts(),
            pickableSingletonCount,
            paintedSingletonCount,
            singletonIds: diagnostics.singletonIds,
            singletonTexts: diagnostics.singletonTexts,
            clusterIds: diagnostics.clusterIds,
            overlayEntryCount: diagnostics.entryCount,
            worldOverlay: getWorldOverlayDiagnostics(),
            camera: {
              longitude: window.__godsEyeView.engine.camera.pose().cartographic.longitude * 180 / Math.PI,
              latitude: window.__godsEyeView.engine.camera.pose().cartographic.latitude * 180 / Math.PI,
              height: window.__godsEyeView.engine.camera.pose().cartographic.height,
            },
          };
          window.__godsEyeView.engine.render.request();
        };
        timeout = setTimeout(() => finish(lastObservation || { found: false, reason: 'no post-render probe' }), 8000);
        removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(probe);
        window.__godsEyeView.engine.render.request();
      });
    });
    check('Radio exposes a visible marker for click-tolerance QA', markerTarget?.found === true, JSON.stringify(markerTarget));
    check(
      'the directly pickable singleton point has painted shared-host text',
      markerTarget?.labelPainted && markerTarget?.pickable,
      JSON.stringify(markerTarget),
    );
    check(
      'ambient Radio globe labels use compact frequency-first text',
      markerTarget?.singletonTexts?.includes('100.3 FM — The River')
        && markerTarget.singletonTexts.every((text) => text.length <= 30),
      JSON.stringify(markerTarget?.singletonTexts),
    );
    if (markerTarget?.found) {
      await page.mouse.click(markerTarget.x + 6, markerTarget.y);
      await page.waitForFunction(
        (id) => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id === id,
        {},
        markerTarget.id,
      );
      const offsetSelected = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id);
      check('an offset click within 8px reliably selects the intended Radio dot', offsetSelected === markerTarget.id, offsetSelected);
    }

    await evaluateWithGeo(page, async (qaGeo) => {
      const gev = window.__godsEyeView;
      const radio = gev.dataManager.layers.get('radio').module;
      window.__godsEyeView.engine.camera.cancelFlight();
      window.__godsEyeView.engine.host.canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 1 }));
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      radio.stopPlayback();
      // Next plays only while a stream is active, so start from a playing station.
      radio.selectStation('00000000-0000-4000-8000-000000000001', { autoplay: true, focus: false });
    });
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    await page.evaluate(() => {
      const gev = window.__godsEyeView;
      const camera = gev.viewer.camera;
      const radio = gev.dataManager.layers.get('radio').module;
      const pool = gev.styleManager._radioControls._radioTunerPool;
      const selectedIndex = pool.findIndex((station) => station.id === radio.getUIState().selected?.id);
      window.__qaRadioExpectedPrimary = pool[(selectedIndex + 1) % pool.length];
      window.__qaRadioExpectedFallback = pool[(selectedIndex + 2) % pool.length];
      window.__qaRadioPlayCalls = [];
      window.__qaRadioFailedNearest = false;
      window.__qaRadioDelayNextFailure = true;
      window.__qaRadioFlyToCalls = [];
      window.__qaRadioOriginalFlyTo = window.__godsEyeView.engine.camera.flyTo;
      window.__qaRadioCameraHeight = window.__godsEyeView.engine.camera.pose().cartographic.height;
      camera.flyTo = (options) => window.__qaRadioFlyToCalls.push(options);
      gev.dataManager.layers.get('flights').enabled = true;
    });
    await whenFramesDrawn(page);
    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', false);
      manager.setPanelCollapsed('radio-panel', false);
    });
    await page.waitForSelector('#radio-next-btn', { visible: true });
    await page.evaluate(() => {
      window.__qaRadioCameraHeight = window.__godsEyeView.engine.camera.pose().cartographic.height;
    });
    const radioOnlyNextDispatched = await page.evaluate(() => {
      const button = document.getElementById('radio-next-btn');
      if (!button) return false;
      button.click();
      return true;
    });
    if (!radioOnlyNextDispatched) throw new Error('Radio next button unavailable');
    await page.waitForFunction(() => typeof window.__qaRejectRadioPlay === 'function');
    await evaluateWithGeo(page, async (qaGeo) => {
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: 2_400_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      window.__qaRejectRadioPlay();
    });
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    const playing = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const { getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      const flightTargets = window.__qaRadioFlyToCalls.map(({ destination }) => {
        const position = qaGeo.cartographic.fromCartesian(destination);
        return {
          lat: position.latitude * 180 / Math.PI,
          lon: position.longitude * 180 / Math.PI,
          height: position.height,
        };
      });
      return {
      state: radio.getUIState(),
      calls: [...window.__qaRadioPlayCalls],
      flyToCalls: window.__qaRadioFlyToCalls.length,
      flightTargets,
      cameraHeight: window.__qaRadioCameraHeight,
      playLabel: document.getElementById('radio-play-btn').getAttribute('aria-label'),
      // The point and bracket sizes are the display's set options
      // (render/style.js), which the movers do not list; what is drawn is
      // one selected point and one bracket sprite on the selection.
      drawn: window.__qaRadioDrawn.counts(),
      selectedMarkerId: window.__qaRadioDrawn.selectedMarkerId(),
      overlay: radio.getOverlayDiagnostics(),
      host: getWorldOverlayDiagnostics(),
      expectedPrimary: window.__qaRadioExpectedPrimary,
      expectedFallback: window.__qaRadioExpectedFallback,
    };
    });
    check(
      'Radio Next follows stable directory order and retries its next available station',
      playing.state.selected?.id === playing.expectedFallback?.id
        && playing.calls[0] === playing.expectedPrimary?.streamUrl
        && playing.calls[1] === playing.expectedFallback?.streamUrl,
      JSON.stringify({
        selected: playing.state.selected?.id,
        calls: playing.calls,
        primary: playing.expectedPrimary?.id,
        fallback: playing.expectedFallback?.id,
      }),
    );
    check('Radio next is explicit playback and updates play/pause state', playing.calls.length === 2 && playing.playLabel.startsWith('Pause'));
    check(
      'Radio next rotates toward its station without changing zoom, including fallback',
      playing.flyToCalls === 2
        && Math.abs(playing.flightTargets[0]?.lat - playing.expectedPrimary?.lat) < 0.001
        && Math.abs(playing.flightTargets[0]?.lon - playing.expectedPrimary?.lon) < 0.001
        && Math.abs(playing.flightTargets[1]?.lat - playing.expectedFallback?.lat) < 0.001
        && Math.abs(playing.flightTargets[1]?.lon - playing.expectedFallback?.lon) < 0.001
        && playing.flightTargets.every((target) => Math.abs(target.height - playing.cameraHeight) < 1),
      JSON.stringify({ calls: playing.flyToCalls, targets: playing.flightTargets, cameraHeight: playing.cameraHeight }),
    );
    const trackedRadioControls = await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const run = async (ownerPrefix, buttonId) => {
        const owner = viewer.entities.add({
          id: `qa:${ownerPrefix}:radio-camera-owner`,
          position: window.__godsEyeView.engine.camera.pose().position,
        });
        owner.gevTrackedId = `${ownerPrefix}:qa-radio-camera-owner`;
        viewer.trackedEntity = owner;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const beforeStationId = radio.getUIState().selected?.id || null;
        const beforeFlyToCalls = window.__qaRadioFlyToCalls.length;
        document.getElementById(buttonId)?.click();
        await new Promise((resolve) => setTimeout(resolve));
        const result = {
          ownerPrefix,
          buttonId,
          beforeStationId,
          afterStationId: radio.getUIState().selected?.id || null,
          flyToDelta: window.__qaRadioFlyToCalls.length - beforeFlyToCalls,
          trackedIdentityPreserved: viewer.trackedEntity === owner,
          trackedId: window.__godsEyeView.engine.camera.following()?.label?.id || null,
        };
        viewer.trackedEntity = undefined;
        viewer.entities.remove(owner);
        return result;
      };
      return [
        await run('flights', 'radio-next-btn'),
        await run('military', 'radio-prev-btn'),
      ];
    });
    check(
      'full Radio Next and Prev navigation preserve Flights/Military camera ownership',
      trackedRadioControls.every((sample) => sample.afterStationId
        && sample.afterStationId !== sample.beforeStationId
        && sample.flyToDelta === 0
        && sample.trackedIdentityPreserved
        && sample.trackedId === `${sample.ownerPrefix}:qa-radio-camera-owner`),
      JSON.stringify(trackedRadioControls),
    );

    const delayedTrackingStart = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      viewer.trackedEntity = undefined;
      window.__qaRadioDelayNextFailure = true;
      const beforeFlyToCalls = window.__qaRadioFlyToCalls.length;
      document.getElementById('radio-next-btn')?.click();
      return { beforeFlyToCalls };
    });
    await page.waitForFunction(() => typeof window.__qaRejectRadioPlay === 'function');
    const delayedTrackingOwner = await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      const owner = viewer.entities.add({
        id: 'qa:flights:delayed-radio-fallback-owner',
        position: window.__godsEyeView.engine.camera.pose().position,
      });
      owner.gevTrackedId = 'flights:qa-delayed-radio-fallback-owner';
      viewer.trackedEntity = owner;
      window.__qaDelayedRadioTrackingOwner = owner;
      window.__qaRejectRadioPlay();
      return owner.gevTrackedId;
    });
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    const delayedFallbackOwnership = await page.evaluate((beforeFlyToCalls) => {
      const viewer = window.__godsEyeView.viewer;
      const owner = window.__qaDelayedRadioTrackingOwner;
      const result = {
        flyToDelta: window.__qaRadioFlyToCalls.length - beforeFlyToCalls,
        trackedIdentityPreserved: viewer.trackedEntity === owner,
        trackedId: window.__godsEyeView.engine.camera.following()?.label?.id || null,
        selectedId: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().selected?.id || null,
      };
      viewer.trackedEntity = undefined;
      viewer.entities.remove(owner);
      delete window.__qaDelayedRadioTrackingOwner;
      return result;
    }, delayedTrackingStart.beforeFlyToCalls);
    check(
      'a delayed Radio fallback yields when Flights acquires the camera after the initial rotation',
      delayedFallbackOwnership.flyToDelta === 1
        && delayedFallbackOwnership.trackedIdentityPreserved
        && delayedFallbackOwnership.trackedId === delayedTrackingOwner
        && Boolean(delayedFallbackOwnership.selectedId),
      JSON.stringify(delayedFallbackOwnership),
    );
    await evaluateWithGeo(page, async (qaGeo) => {
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: Math.PI,
          latitude: -2 * Math.PI / 180,
          height: window.__qaRadioCameraHeight,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
    });
    check(
      'the current station carries a four-corner selection bracket',
      playing.drawn['radio-selected'] === 1
        && playing.drawn['radio-bracket'] === 1
        && playing.selectedMarkerId === `radio:selected:${playing.state.selected?.id}`,
      JSON.stringify({ drawn: playing.drawn, marker: playing.selectedMarkerId }),
    );
    check(
      'selected-station text is published to the protected shared-host lane',
      playing.overlay.selectedCount === 1
        && playing.host.entriesBySource?.radio === playing.overlay.entryCount,
      JSON.stringify({ overlay: playing.overlay, host: playing.host.entriesBySource }),
    );
    const closeSelectedText = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const selected = radio.getUIState().selected;
      window.__qaRadioVisualView = {
        position: window.__godsEyeView.engine.camera.pose().position,
        direction: window.__godsEyeView.engine.camera.pose().direction,
        up: window.__godsEyeView.engine.camera.pose().up,
      };
      const destination = qaGeo.cartographic.toCartesian({
        longitude: selected.lon * Math.PI / 180,
        latitude: selected.lat * Math.PI / 180,
        height: 5_000,
      });
      window.__godsEyeView.engine.camera.setView({
        destination,
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      // The selected point is drawn when a pick at its anchor finds its
      // pickId (the old check read the Entity's show).
      const drawn = window.__qaRadioDrawn;
      const selectedShown = () => drawn
        .picksAt(drawn.canvasPoint(drawn.stationPosition(selected.id, 5)), 8)
        .some((picked) => picked.owner === 'radio-selected' && picked.id === `radio:selected:${selected.id}`);
      const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      const expectedEntryId = `selected:${selected.id}`;
      let painted = null;
      let shown = false;
      // Radio's horizon pass reveals the selected point on its own timer
      // after the camera jump, so a stationary view waits for both to settle.
      for (
        let attempt = 0;
        attempt < 20 && !(painted?.rect && shown);
        attempt += 1
      ) {
        painted = await new Promise((resolve) => {
          let removePostRender = null;
          const timeout = setTimeout(() => {
            removePostRender?.();
            resolve({ rect: null, host: getWorldOverlayDiagnostics() });
          }, 150);
          removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            clearTimeout(timeout);
            removePostRender();
            const rect = getOverlayPaintRect('radio', expectedEntryId);
            resolve({
              rect: rect ? { x: rect.x, y: rect.y, w: rect.w, h: rect.h } : null,
              host: getWorldOverlayDiagnostics(),
            });
          });
          window.__godsEyeView.engine.render.request();
        });
        shown = selectedShown();
      }
      return {
        expectedEntryId,
        rect: painted?.rect || null,
        host: painted?.host || getWorldOverlayDiagnostics(),
        selectedEntityShow: shown,
        cameraHeight: window.__godsEyeView.engine.camera.pose().cartographic.height,
      };
    });
    check(
      'selected shared-host text remains in the paint pipeline in a close stationary view',
      closeSelectedText?.rect?.w > 0
        && closeSelectedText?.rect?.h > 0
        && closeSelectedText?.selectedEntityShow === true,
      JSON.stringify(closeSelectedText),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-desktop.png') });
    const highGlobalSelectedText = await evaluateWithGeo(page, async (qaGeo) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      const selected = radio.getUIState().selected;
      window.__godsEyeView.engine.camera.setView({
        destination: qaGeo.cartographic.toCartesian({
          longitude: (selected.lon + 10) * Math.PI / 180,
          latitude: selected.lat * Math.PI / 180,
          height: 5_000_000,
        }),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const drawn = window.__qaRadioDrawn;
      const { getPaintRect: getOverlayPaintRect, getDiagnostics: getWorldOverlayDiagnostics } = window.__gevWorldOverlay;
      const expectedEntryId = `selected:${selected.id}`;
      let rect = null;
      for (let attempt = 0; attempt < 20 && !rect; attempt += 1) {
        rect = await new Promise((resolve) => {
          let removePostRender = null;
          const timeout = setTimeout(() => {
            removePostRender?.();
            resolve(null);
          }, 150);
          removePostRender = window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            clearTimeout(timeout);
            removePostRender();
            const painted = getOverlayPaintRect('radio', expectedEntryId);
            resolve(painted ? {
              x: painted.x,
              y: painted.y,
              w: painted.w,
              h: painted.h,
            } : null);
          });
          window.__godsEyeView.engine.render.request();
        });
      }
      // The selected point and its bracket are instances of the
      // radio-selected and radio-bracket mover sets, both picked as
      // `radio:selected:<id>`; the pick at the point's anchor is the check.
      const pickId = `radio:selected:${selected.id}`;
      const entityPosition = drawn.stationPosition(selected.id, 5);
      const entityAnchor = drawn.canvasPoint(entityPosition);
      let selectedNativePick = null;
      let selectedPointPick = null;
      let selectedBillboardPick = null;
      // Retry on the STRICT anchor: waiting only for "any pick" let the
      // bracket satisfy the loop while the point anchor was still missing.
      for (let attempt = 0; entityAnchor && attempt < 8 && !selectedPointPick; attempt += 1) {
        const picks = drawn.picksAt(entityAnchor, 16);
        selectedNativePick = picks.find((picked) => picked.id === pickId);
        selectedPointPick = picks.find((picked) => picked.id === pickId && picked.owner === 'radio-selected');
        selectedBillboardPick = picks.find((picked) => picked.id === pickId && picked.owner === 'radio-bracket');
        if (!selectedPointPick) await drawn.frames(1);
      }
      const counts = drawn.counts();
      return {
        rect,
        selectedNativePickable: Boolean(selectedNativePick),
        selectedPointPickable: Boolean(selectedPointPick),
        selectedBillboardPickable: Boolean(selectedBillboardPick),
        selectedEntityShow: Boolean(selectedPointPick),
        selectedBracketVisible: counts['radio-bracket'] === 1,
        entityAnchor: entityAnchor ? { x: entityAnchor.x, y: entityAnchor.y } : null,
        entityDistance: entityPosition
          ? Math.hypot(
            window.__godsEyeView.engine.camera.pose().position.x - entityPosition.x,
            window.__godsEyeView.engine.camera.pose().position.y - entityPosition.y,
            window.__godsEyeView.engine.camera.pose().position.z - entityPosition.z,
          )
          : null,
        overlay: radio.getOverlayDiagnostics(),
        host: getWorldOverlayDiagnostics(),
        cameraHeight: window.__godsEyeView.engine.camera.pose().cartographic.height,
      };
    });
    check(
      'selected label, bracket, and native pick anchor share the supported high-global range',
      highGlobalSelectedText.cameraHeight > 4_800_000
        && highGlobalSelectedText.rect?.w > 0
        && highGlobalSelectedText.rect?.h > 0
        && highGlobalSelectedText.selectedEntityShow === true
        && highGlobalSelectedText.selectedBracketVisible
        // The POINT anchor is the invariant: it is what stays pickable out to
        // the 50,000 km band (the display's distance cut; the movers list no
        // per-set distance, so the old 50,000 km distance-condition read is
        // gone). Accepting any pick let the co-located bracket keep this
        // green after the point anchor regressed.
        //
        // `selectedBillboardPickable` is reported for diagnostics but NOT
        // asserted.
        && highGlobalSelectedText.selectedPointPickable
        && highGlobalSelectedText.selectedNativePickable,
      JSON.stringify(highGlobalSelectedText),
    );
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-high-global.png') });
    await page.setViewport({ width: 560, height: 760, deviceScaleFactor: 1 });
    await page.evaluate(async () => {
      const viewer = window.__godsEyeView.viewer;
      window.__godsEyeView.styleManager.toggleCleanView(true);
      viewer.resize();
      window.__godsEyeView.engine.render.request();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    await page.screenshot({ path: path.join(SHOTS_DIR, 'selected-label-mobile.png') });
    await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
    await page.evaluate(() => {
      const viewer = window.__godsEyeView.viewer;
      window.__godsEyeView.styleManager.toggleCleanView(false);
      viewer.resize();
      window.__godsEyeView.engine.render.request();
    });
    await page.evaluate(() => {
      const view = window.__qaRadioVisualView;
      window.__godsEyeView.engine.camera.setView({
        destination: view.position,
        orientation: { direction: view.direction, up: view.up },
      });
      delete window.__qaRadioVisualView;
      window.__godsEyeView.engine.render.request();
    });
    await whenFramesDrawn(page);

    await page.evaluate(() => {
      window.__qaRadioFlyToCalls = [];
      window.__godsEyeView.dataManager.layers.get('flights').enabled = false;
    });
    const radioOnlyNextClicked = await page.evaluate(() => {
      const button = document.getElementById('radio-next-btn');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    });
    check(
      'Radio-only next control remains available after responsive visual checks',
      radioOnlyNextClicked,
      `clicked=${radioOnlyNextClicked}`,
    );
    const radioOnlyFocusCalls = await evaluateWithGeo(page, async (qaGeo) => {
      const calls = window.__qaRadioFlyToCalls.length;
      const heights = window.__qaRadioFlyToCalls.map((options) => (
        qaGeo.cartographic.fromCartesian(options.destination).height
      ));
      window.__godsEyeView.viewer.camera.flyTo = window.__qaRadioOriginalFlyTo;
      delete window.__qaRadioOriginalFlyTo;
      return { calls, heights, cameraHeight: window.__qaRadioCameraHeight };
    });
    check(
      'Radio-only next advances the tuner and rotates without changing zoom',
      radioOnlyFocusCalls.calls === 1
        && radioOnlyFocusCalls.heights.every((height) => Math.abs(height - radioOnlyFocusCalls.cameraHeight) < 1),
      JSON.stringify(radioOnlyFocusCalls),
    );

    const stagedGlobeNavigation = await evaluateWithGeo(page, async (qaGeo) => {
      const gev = window.__godsEyeView;
      const viewer = gev.viewer;
      const camera = viewer.camera;
      const radio = gev.dataManager.layers.get('radio').module;
      const stationIds = radio.getTunerStations(3).map((station) => station.id);
      if (stationIds.length < 3) throw new Error('Radio recenter QA requires three visible stations');
      const originalFlyTo = window.__godsEyeView.engine.camera.flyTo;
      const calls = [];
      camera.flyTo = (options) => calls.push(options);
      const setCamera = (height, pitchDegrees, headingDegrees = 38) => {
        window.__godsEyeView.engine.camera.setView({
          destination: qaGeo.cartographic.toCartesian({
            longitude: -133.9483 * Math.PI / 180,
            latitude: 23.4741 * Math.PI / 180,
            height,
          }),
          orientation: {
            heading: headingDegrees * Math.PI / 180,
            pitch: pitchDegrees * Math.PI / 180,
            roll: 0,
          },
        });
        window.__godsEyeView.engine.render.request();
      };
      const completeFlight = (index) => {
        const flight = calls[index];
        window.__godsEyeView.engine.camera.setView({
          destination: flight.destination,
          orientation: flight.orientation,
        });
        flight.complete?.();
      };
      const describe = (flight) => {
        const cartographic = qaGeo.cartographic.fromCartesian(flight.destination);
        return {
          lat: cartographic.latitude * 180 / Math.PI,
          lon: cartographic.longitude * 180 / Math.PI,
          height: cartographic.height,
          heading: flight.orientation?.heading,
          pitch: flight.orientation?.pitch,
          roll: flight.orientation?.roll,
          duration: flight.duration,
          eased: Boolean(flight.easingFunction),
        };
      };

      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const partialInitialCalls = calls.length;
      const recenter = describe(calls[0]);
      completeFlight(0);
      const partialAfterRecenterCalls = calls.length;
      const selectedAfterRecenter = radio.getUIState().selected;
      const stationFocus = describe(calls[1]);

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const owner = viewer.entities.add({
        id: 'qa:flights:radio-recenter-stage-owner',
        position: window.__godsEyeView.engine.camera.pose().position,
      });
      owner.gevTrackedId = 'flights:qa-radio-recenter-stage-owner';
      viewer.trackedEntity = owner;
      completeFlight(0);
      const trackingBetweenStagesCalls = calls.length;
      const trackingIdentityPreserved = viewer.trackedEntity === owner;
      viewer.trackedEntity = undefined;
      viewer.entities.remove(owner);

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.selectStation(stationIds[2], { autoplay: false, focus: false });
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const staleRecenter = calls[0];
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const latestRecenterIndex = calls.length - 1;
      staleRecenter.complete?.();
      const callsAfterStaleCompletion = calls.length;
      completeFlight(latestRecenterIndex);
      const latestSelected = radio.getUIState().selected;
      const latestFocus = describe(calls.at(-1));

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const directSelectionStaleRecenter = calls[0];
      const directSelectionId = stationIds.find((id) => id !== radio.getUIState().selected.id);
      radio.selectStation(directSelectionId, { autoplay: false, focus: false, origin: 'user' });
      const directSelectionCalls = calls.length;
      directSelectionStaleRecenter.complete?.();
      const directSelectionCallsAfterStale = calls.length;
      const directSelectionSelectedId = radio.getUIState().selected.id;

      calls.length = 0;
      setCamera(2_915_647, -40);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const voiceSelectionStaleRecenter = calls[0];
      const voiceSelectionId = stationIds.find((id) => id !== radio.getUIState().selected.id);
      const voiceSelection = radio.selectRequestedStation({
        stationQuery: voiceSelectionId,
      }, { autoplay: false, origin: 'voice' });
      const voiceSelectionCalls = calls.length;
      voiceSelectionStaleRecenter.complete?.();
      const voiceSelectionCallsAfterStale = calls.length;
      const voiceSelectionSelectedId = radio.getUIState().selected.id;
      radio.selectStation(latestSelected.id, { autoplay: false, focus: false });

      calls.length = 0;
      setCamera(97_488_500, -40, 119);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const extremeRecenter = describe(calls[0]);
      completeFlight(0);
      const extremeFocus = describe(calls[1]);

      calls.length = 0;
      setCamera(5_000, -35, 15);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const localDirect = describe(calls[0]);
      const localDirectCalls = calls.length;

      calls.length = 0;
      setCamera(12_000_000, -90, 15);
      radio.cycleStation(1, { rotate: true, autoplay: false, stationIds });
      const centeredDirect = describe(calls[0]);
      const centeredDirectCalls = calls.length;

      camera.flyTo = originalFlyTo;
      return {
        partialInitialCalls,
        partialAfterRecenterCalls,
        recenter,
        stationFocus,
        selectedAfterRecenter,
        trackingBetweenStagesCalls,
        trackingIdentityPreserved,
        latestRecenterIndex,
        callsAfterStaleCompletion,
        latestSelected,
        latestFocus,
        directSelectionId,
        directSelectionCalls,
        directSelectionCallsAfterStale,
        directSelectionSelectedId,
        voiceSelectionId,
        voiceSelectionMatchedId: voiceSelection?.id || null,
        voiceSelectionCalls,
        voiceSelectionCallsAfterStale,
        voiceSelectionSelectedId,
        extremeRecenter,
        extremeFocus,
        localDirectCalls,
        localDirect,
        centeredDirectCalls,
        centeredDirect,
      };
    });
    check(
      'a below-center closer globe animates back to center before station focus',
      stagedGlobeNavigation.partialInitialCalls === 1
        && stagedGlobeNavigation.partialAfterRecenterCalls === 2
        && Math.abs(stagedGlobeNavigation.recenter.height - 2_915_647) < 1
        && stagedGlobeNavigation.recenter.heading === 0
        && Math.abs(stagedGlobeNavigation.recenter.pitch + Math.PI / 2) < 1e-9
        && stagedGlobeNavigation.recenter.roll === 0
        && stagedGlobeNavigation.recenter.duration >= 0.65
        && stagedGlobeNavigation.recenter.eased
        && Math.abs(stagedGlobeNavigation.stationFocus.height - 2_915_647) < 1
        && Math.abs(stagedGlobeNavigation.stationFocus.lat - stagedGlobeNavigation.selectedAfterRecenter.lat) < 0.001
        && Math.abs(stagedGlobeNavigation.stationFocus.lon - stagedGlobeNavigation.selectedAfterRecenter.lon) < 0.001
        && Math.abs(stagedGlobeNavigation.stationFocus.pitch + Math.PI / 2) < 1e-9,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'tracking acquired during Radio recenter suppresses the station-focus stage',
      stagedGlobeNavigation.trackingBetweenStagesCalls === 1
        && stagedGlobeNavigation.trackingIdentityPreserved,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer Radio action makes the older recenter callback inert and owns the final focus',
      stagedGlobeNavigation.latestRecenterIndex === 1
        && stagedGlobeNavigation.callsAfterStaleCompletion === 2
        && Math.abs(stagedGlobeNavigation.latestFocus.lat - stagedGlobeNavigation.latestSelected.lat) < 0.001
        && Math.abs(stagedGlobeNavigation.latestFocus.lon - stagedGlobeNavigation.latestSelected.lon) < 0.001,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer direct station selection invalidates an older staged Radio recenter',
      stagedGlobeNavigation.directSelectionCalls === 1
        && stagedGlobeNavigation.directSelectionCallsAfterStale === 1
        && stagedGlobeNavigation.directSelectionSelectedId === stagedGlobeNavigation.directSelectionId,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'a newer voice station selection remains non-moving after an older recenter completes',
      stagedGlobeNavigation.voiceSelectionCalls === 1
        && stagedGlobeNavigation.voiceSelectionCallsAfterStale === 1
        && stagedGlobeNavigation.voiceSelectionMatchedId === stagedGlobeNavigation.voiceSelectionId
        && stagedGlobeNavigation.voiceSelectionSelectedId === stagedGlobeNavigation.voiceSelectionId,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'extreme zoom-out recovery caps the north-up full-globe frame',
      Math.abs(stagedGlobeNavigation.extremeRecenter.height - 13_000_000) < 1
        && stagedGlobeNavigation.extremeRecenter.heading === 0
        && Math.abs(stagedGlobeNavigation.extremeRecenter.pitch + Math.PI / 2) < 1e-9
        && stagedGlobeNavigation.extremeRecenter.roll === 0
        && Math.abs(stagedGlobeNavigation.extremeFocus.height - 13_000_000) < 1,
      JSON.stringify(stagedGlobeNavigation),
    );
    check(
      'local and already-centered globe views keep the single-stage direct path',
      stagedGlobeNavigation.localDirectCalls === 1
        && stagedGlobeNavigation.centeredDirectCalls === 1
        && Math.abs(stagedGlobeNavigation.localDirect.pitch + 35 * Math.PI / 180) < 1e-9
        && Math.abs(stagedGlobeNavigation.centeredDirect.pitch + Math.PI / 2) < 1e-9,
      JSON.stringify(stagedGlobeNavigation),
    );

    await page.evaluate(() => {
      window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', true);
      window.__godsEyeView.styleManager.setPanelCollapsed('global-context-panel', false);
    });
    const companion = await page.evaluate(() => ({
      radioEnabled: window.__godsEyeView.dataManager.isEnabled('radio'),
      state: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState,
      radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
      contextCollapsed: document.getElementById('global-context-panel').classList.contains('collapsed'),
      nested: document.getElementById('global-context-panel').contains(document.getElementById('radio-panel')),
    }));
    check(
      'expanding Context preserves playback and the user-selected detailed Radio disclosure',
      companion.radioEnabled && companion.state === 'playing'
        && companion.radioCollapsed && !companion.contextCollapsed && companion.nested,
    );

    await page.evaluate(() => {
      const manager = window.__godsEyeView.styleManager;
      manager.setPanelCollapsed('global-context-panel', false);
      manager.setPanelCollapsed('radio-panel', false);
    });
    await page.waitForFunction(() => !document.getElementById('radio-panel').classList.contains('collapsed'));

    await page.click('#global-context-flights-btn');
    await page.waitForFunction(() => !document.getElementById('context-flights-view').hidden);
    const companionStack = await page.evaluate(() => {
      const contextView = document.getElementById('context-flights-view');
      const awareness = document.getElementById('military-awareness-panel');
      const radio = document.getElementById('radio-panel');
      const scroller = document.querySelector('#global-context-panel .global-context-panel-inner');
      const awarenessRect = awareness.getBoundingClientRect();
      const radioRect = radio.getBoundingClientRect();
      return {
        contactsNaturalHeight: contextView.clientHeight === contextView.scrollHeight,
        radioNaturalHeight: radio.clientHeight === radio.scrollHeight,
        separated: awarenessRect.bottom <= radioRect.top,
        scrollable: scroller.scrollHeight > scroller.clientHeight,
      };
    });
    check(
      'expanded Contacts and Radio remain separated in the shared Context scroller',
      companionStack.contactsNaturalHeight && companionStack.radioNaturalHeight
        && companionStack.separated && companionStack.scrollable,
      JSON.stringify(companionStack),
    );

    await page.select('#radio-filter', 'talk');
    const filtered = await page.evaluate(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState());
    check('filter changes markers/navigation without stopping the selected stream', filtered.filteredCount === 75 && filtered.audioState === 'playing' && filtered.selectedIndex === -1, `${filtered.filteredCount} matches`);

    const playsBeforeRestore = await page.evaluate(() => window.__qaRadioPlayCalls.length);
    await page.evaluate(async () => {
      const gev = window.__godsEyeView;
      await gev.dataManager.setEnabled('radio', false);
      await gev.dataManager.setEnabled('radio', true);
    });
    const restored = await page.evaluate(() => ({
      state: window.__godsEyeView.dataManager.layers.get('radio').module.getUIState(),
      plays: window.__qaRadioPlayCalls.length,
      radioCollapsed: document.getElementById('radio-panel').classList.contains('collapsed'),
    }));
    check(
      'programmatic/preset-style restoration does not autoplay and leaves idle Radio collapsed',
      restored.state.enabled && restored.state.audioState === 'stopped'
        && restored.plays === playsBeforeRestore && restored.radioCollapsed,
      JSON.stringify(restored),
    );

    await page.evaluate(() => window.__godsEyeView.styleManager.setPanelCollapsed('radio-panel', false));
    await whenFramesDrawn(page);
    await page.screenshot({ path: path.join(SHOTS_DIR, 'desktop.png') });
    const desktop = await page.$eval('#radio-panel', (element) => {
      const rect = element.getBoundingClientRect();
      const contextRect = element.closest('#global-context-panel').getBoundingClientRect();
      const tunerRect = element.querySelector('.radio-tuner').getBoundingClientRect();
      const innerRect = element.querySelector('.radio-panel-inner').getBoundingClientRect();
      return {
        left: contextRect.left,
        right: contextRect.right,
        top: contextRect.top,
        bottom: contextRect.bottom,
        width: contextRect.width,
        radioInside: rect.left >= contextRect.left && rect.right <= contextRect.right,
        tunerInside: tunerRect.left >= innerRect.left && tunerRect.right <= innerRect.right,
      };
    });
    check('desktop Context host keeps Radio and its tuner contained', desktop.left >= 0 && desktop.right <= 1440 && desktop.top >= 0 && desktop.bottom <= 900 && desktop.radioInside && desktop.tunerInside, JSON.stringify(desktop));

    await page.click('#radio-play-btn');
    await page.waitForFunction(() => window.__godsEyeView.dataManager.layers.get('radio').module.getUIState().audioState === 'playing');
    await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
    await whenFramesDrawn(page);
    await page.$eval('#radio-panel', (element) => element.scrollIntoView({ block: 'nearest' }));
    await page.screenshot({ path: path.join(SHOTS_DIR, 'mobile.png') });
    const mobile = await page.$eval('#radio-panel', (element) => {
      const rect = element.getBoundingClientRect();
      const context = element.closest('#global-context-panel');
      const contextRect = context.getBoundingClientRect();
      const scroller = context.querySelector('.global-context-panel-inner');
      const logo = document.querySelector('#title-bar .title-logo');
      const logoRect = logo.getBoundingClientRect();
      const tunerRect = element.querySelector('.radio-tuner').getBoundingClientRect();
      const innerRect = element.querySelector('.radio-panel-inner').getBoundingClientRect();
      return {
        left: contextRect.left,
        right: contextRect.right,
        top: contextRect.top,
        bottom: contextRect.bottom,
        width: contextRect.width,
        radioWidth: rect.width,
        radioVisible: rect.bottom > contextRect.top && rect.top < contextRect.bottom,
        scrollable: scroller.scrollHeight >= scroller.clientHeight,
        broadcastVisible: Number(getComputedStyle(logo, '::before').opacity) > 0
          && Number(getComputedStyle(logo, '::after').opacity) > 0,
        broadcastInsideViewport: logoRect.left >= 0 && logoRect.right <= innerWidth && logoRect.top - 15 >= 0,
        tunerInside: tunerRect.left >= innerRect.left && tunerRect.right <= innerRect.right
          && tunerRect.left >= 0 && tunerRect.right <= innerWidth,
      };
    });
    check('mobile Context host is full-width and keeps the tuner contained', mobile.left >= 0 && mobile.right <= 390 && mobile.width >= 350 && mobile.radioWidth < mobile.width && mobile.radioVisible && mobile.scrollable && mobile.tunerInside, JSON.stringify(mobile));
    check('mobile playing state keeps both broadcast waves visible and on-screen', mobile.broadcastVisible && mobile.broadcastInsideViewport, JSON.stringify(mobile));
    await page.click('#radio-stop-btn');
    const actionableConsoleErrors = [...consoleErrors];
    const externalFontFailures = [];
    for (let i = actionableConsoleErrors.length - 1; i >= 0; i -= 1) {
      const entry = actionableConsoleErrors[i];
      if (entry.includes('Failed to load resource: the server responded with a status of 404')
        && entry.includes('[https://fonts.gstatic.com/')) {
        externalFontFailures.push(...actionableConsoleErrors.splice(i, 1));
      }
    }
    if (externalFontFailures.length > 0) {
      console.log(`INFO external Google Fonts resource unavailable (${externalFontFailures.length}); Radio assertions continued with the local fallback font`);
    }
    if (externalCesiumEndpointFailures.length > 0) {
      const requestEventIndex = actionableConsoleErrors.findIndex((entry) => (
        entry.startsWith('[object RequestErrorEvent]')
        && entry.includes('/node_modules/.vite/deps/cesium.js')
      ));
      if (requestEventIndex >= 0) actionableConsoleErrors.splice(requestEventIndex, 1);
      for (let i = actionableConsoleErrors.length - 1; i >= 0; i -= 1) {
        if (actionableConsoleErrors[i].includes('api.cesium.com/v1/assets/1/endpoint')
          && actionableConsoleErrors[i].includes('net::ERR_FAILED')) {
          actionableConsoleErrors.splice(i, 1);
        }
      }
      console.log(`INFO external Cesium ion asset endpoint unavailable (${externalCesiumEndpointFailures.length}); Radio assertions continued against the loaded app`);
    }
    check(
      'runtime console remains clean',
      actionableConsoleErrors.length === 0,
      actionableConsoleErrors.slice(0, 3).join(' | '),
    );
    check(
      'runtime has no HTTP 5xx responses',
      failedResponses.length === 0,
      failedResponses.slice(0, 3).join(' | '),
    );
  } finally {
    await closeBrowser(browser);
  }

  const failures = results.filter((result) => !result.ok).length;
  const reportPath = option('--report');
  if (reportPath) fs.writeFileSync(reportPath, JSON.stringify({ pass: failures === 0, checks: results, expectedPreviewErrors }, null, 2) + '\n');
  console.log(`\nRadio QA: ${results.length - failures}/${results.length} passed`);
  console.log(`RESULT: ${results.length - failures} passed, ${failures} failed, 0 skipped`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
