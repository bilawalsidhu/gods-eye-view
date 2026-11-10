#!/usr/bin/env node
import { chromeExecutablePath } from './qa-chrome.mjs';
// Cesium-only probes: native entity, DataSource and primitive counts independently audit Cesium ownership.
import { whenSettled, whenFramesDrawn } from './qa/ready.mjs';
/**
 * Phase 0 world-overlay baseline harness.
 *
 * The harness intentionally measures the current implementation without
 * importing or changing application modules. Each scene gets a fresh page,
 * enables its layers through DataLayerManager.toggle(), waits for layer data,
 * then samples five seconds of scripted camera motion and five seconds at rest.
 *
 * Usage:
 *   node scripts/qa-overlay-baseline.mjs
 *   node scripts/qa-overlay-baseline.mjs --scene datacenters
 *   node scripts/qa-overlay-baseline.mjs --scene cctv-street,detection-50
 *   node scripts/qa-overlay-baseline.mjs --json /tmp/overlay-baseline.json
 *   node scripts/qa-overlay-baseline.mjs --screenshots-dir /tmp/overlay-shots
 *   node scripts/qa-overlay-baseline.mjs --hardware-gpu --headful
 *   node scripts/qa-overlay-baseline.mjs --dist-dir /tmp/gev-dist
 *   node scripts/qa-overlay-baseline.mjs --engine=navara
 *
 * Engine-neutral: the camera and frames go through the globe engine and the
 * layers through the public engine and data manager surfaces.
 * A scene whose layers the engine does not have is SKIPPED. The inventory
 * counts the globe contract's sets (movers, lines, ground, imagery) on both
 * engines; on Cesium it also counts what is left of Entities, LabelGraphics
 * and primitives (none of them a layer's own any more).
 */

import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fromDegrees } from '../src/geo/cartesian3.js';

const CHROME_EXECUTABLE = chromeExecutablePath();
const DEFAULT_URL = 'http://localhost:4176';
const VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const SAMPLE_MS = 5_000;
const BETWEEN_PHASE_SETTLE_MS = 1_000;
const DEFAULT_SETTLE_MS = 3_000;
const LAYER_WAIT_MS = 60_000;
const KNOWN_OVERLAY_CANVASES = new Set([
  'world-overlay-canvas',
  'tracked-readout',
  'firms-labels',
  'vessel-labels',
  'cctv-cards',
]);

const SCENES = Object.freeze([
  { id: 'datacenters', layers: ['local-datacenters'], camera: [-98, 38, 6_000_000, 0, -Math.PI / 2] },
  { id: 'dams', layers: ['local-dams'], camera: [-98, 38, 6_000_000, 0, -Math.PI / 2] },
  { id: 'datacenters+dams', layers: ['local-datacenters', 'local-dams'], camera: [-98, 38, 6_000_000, 0, -Math.PI / 2] },
  { id: 'submarine-cables', layers: ['telegeography-submarine-cables'], camera: [-20, 12, 11_000_000, 0, -Math.PI / 2] },
  { id: 'cctv-street', layers: ['cctv'], cctvHeightM: 1_500 },
  { id: 'cctv-city', layers: ['cctv'], cctvHeightM: 6_000 },
  { id: 'cctv-high', layers: ['cctv'], cctvHeightM: 12_000 },
  { id: 'firms', layers: ['local-firms'], camera: [-110, 45, 5_000_000, 0, -Math.PI / 2] },
  { id: 'vessels', layers: ['ais-live-vessels'], camera: [4.05, 51.93, 18_000, 0.3, -1.25] },
  { id: 'detection-25', layers: ['flights', 'satellites'], detectionDensity: 25, camera: [-98, 38, 2_500_000, 0, -Math.PI / 2] },
  { id: 'detection-50', layers: ['flights', 'satellites'], detectionDensity: 50, camera: [-98, 38, 2_500_000, 0, -Math.PI / 2] },
  { id: 'detection-100', layers: ['flights', 'satellites'], detectionDensity: 100, camera: [-98, 38, 2_500_000, 0, -Math.PI / 2] },
  { id: 'tracked-civil-aircraft', layers: ['flights'], trackedFlight: true, camera: [-98, 38, 2_500_000, 0, -Math.PI / 2] },
  { id: 'missions-selected', layers: ['rocket-launches'], missionSelected: true, camera: [0, 15, 18_000_000, 0, -Math.PI / 2] },
  { id: 'cockpit-mode', layers: ['flights'], trackedFlight: true, cockpit: true, camera: [-98, 38, 2_500_000, 0, -Math.PI / 2] },
]);

const SCENE_ALIASES = Object.freeze({
  'datacenters-dams': 'datacenters+dams',
  cables: 'submarine-cables',
  'tracked-civil': 'tracked-civil-aircraft',
  missions: 'missions-selected',
  cockpit: 'cockpit-mode',
});

const argv = process.argv.slice(2);

function getOpt(name, fallback = null) {
  const index = argv.indexOf(name);
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
}

function hasFlag(name) {
  return argv.includes(name);
}

function selectedScenes() {
  const raw = getOpt('--scene');
  if (!raw) return [...SCENES];
  const requested = raw.split(',').map((value) => value.trim()).filter(Boolean);
  const selected = [];
  for (const requestedId of requested) {
    const id = SCENE_ALIASES[requestedId] || requestedId;
    const scene = SCENES.find((candidate) => candidate.id === id);
    if (!scene) {
      throw new Error(`Unknown scene '${requestedId}'. Available: ${SCENES.map((candidate) => candidate.id).join(', ')}`);
    }
    selected.push(scene);
  }
  return selected;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return ({
    '.css': 'text/css',
    '.gif': 'image/gif',
    '.html': 'text/html',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.ktx2': 'image/ktx2',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
  })[extension] || 'application/octet-stream';
}

async function installStaticDist(page, distDir) {
  if (!distDir) return;
  const root = path.resolve(distDir);
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    try {
      if (url.origin === new URL(APP_URL).origin) {
        if (url.pathname.startsWith('/api/')) {
          await request.respond({
            status: 503,
            contentType: 'application/json',
            body: JSON.stringify({ error: 'offline_dist_capture', message: 'Dev-server proxies unavailable' }),
          });
          return;
        }
        const relativePath = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
        const filePath = path.resolve(root, relativePath);
        if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
          await request.respond({ status: 403, body: 'Forbidden' });
          return;
        }
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          await request.respond({ status: 404, body: 'Not found' });
          return;
        }
        await request.respond({
          status: 200,
          contentType: contentType(filePath),
          body: fs.readFileSync(filePath),
        });
        return;
      }
      if (url.hostname === 'tile.googleapis.com' && url.pathname.includes('/3dtiles/')) {
        await request.respond({
          status: 403,
          contentType: 'application/json',
          body: JSON.stringify({ error: { message: 'Offline dist capture: Google tiles unavailable' } }),
        });
        return;
      }
      await request.continue();
    } catch {
      try { await request.abort(); } catch { /* request already resolved */ }
    }
  });
}

async function installDeterministicDevEndpoints(page) {
  if (DIST_DIR) return;
  await page.setRequestInterception(true);
  page.on('request', async (request) => {
    const url = new URL(request.url());
    if (url.origin !== new URL(APP_URL).origin) {
      await request.continue();
      return;
    }
    if (url.pathname === '/api/openai/hud-summary') {
      await request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ summary: 'QA globe ready' }),
      });
      return;
    }
    if (url.pathname === '/api/vessels') {
      await request.respond({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'connected', rows: [], lastMessageAt: null }),
      });
      return;
    }
    await request.continue();
  });
}

function round(value, digits = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1));
  return sorted[index];
}

function summarizeFrameIntervals(intervals) {
  const usable = intervals.filter((value) => Number.isFinite(value) && value > 0);
  if (!usable.length) {
    return { samples: 0, meanMs: null, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  }
  const mean = usable.reduce((sum, value) => sum + value, 0) / usable.length;
  return {
    samples: usable.length,
    meanMs: round(mean),
    p50Ms: round(percentile(usable, 0.50)),
    p95Ms: round(percentile(usable, 0.95)),
    p99Ms: round(percentile(usable, 0.99)),
    maxMs: round(Math.max(...usable)),
  };
}

function numericDelta(after, before, key) {
  return (after?.totals?.[key] || 0) - (before?.totals?.[key] || 0);
}

function inventoryDelta(before, after) {
  return {
    moverInstances: numericDelta(after, before, 'moverInstances'),
    lines: numericDelta(after, before, 'lines'),
    groundItems: numericDelta(after, before, 'groundItems'),
    imageryLayers: numericDelta(after, before, 'imageryLayers'),
    // Cesium only: what is left of Entities and primitives.
    ...(after?.totals?.entities === undefined ? {} : {
      entities: numericDelta(after, before, 'entities'),
      labelGraphics: numericDelta(after, before, 'labelGraphics'),
      nonemptyLabelText: numericDelta(after, before, 'nonemptyLabelText'),
      emptyLabelText: numericDelta(after, before, 'emptyLabelText'),
      shownLabelGraphics: numericDelta(after, before, 'shownLabelGraphics'),
      primitiveLabels: numericDelta(after, before, 'primitiveLabels'),
      primitiveBillboards: numericDelta(after, before, 'primitiveBillboards'),
      primitivePoints: numericDelta(after, before, 'primitivePoints'),
    }),
  };
}

function printContext(context) {
  console.log('\nWorld Overlay Phase 0 Baseline');
  console.log(`  URL        : ${context.url}`);
  console.log(`  Machine    : ${context.machine.hostname} · ${context.machine.platform} ${context.machine.release} · ${context.machine.arch}`);
  console.log(`  CPU / RAM  : ${context.machine.cpuModel} · ${context.machine.logicalCpuCount} logical · ${context.machine.totalMemoryGiB} GiB`);
  console.log(`  Browser    : ${context.browser.version}`);
  console.log(`  User agent : ${context.browser.userAgent}`);
  console.log(`  Viewport   : ${context.viewport.width}×${context.viewport.height} CSS px · DPR ${context.viewport.dpr}`);
  console.log(`  WebGL      : ${context.browser.webglVendor} · ${context.browser.webglRenderer}`);
  console.log(`  Capture    : ${context.captureMode}`);
  console.log(context.gpuMode === 'hardware'
    ? '  Timing note: hardware-GPU run; retain the renderer string with every comparison.\n'
    : '  Timing note: SwiftShader absolute FPS is non-representative; compare motion/rest and before/after only.\n');
}

function printScene(result) {
  const tag = result.status === 'ok' ? 'OK' : result.status === 'skipped' ? 'SKIP' : 'ERROR';
  console.log(`[${tag}] ${result.scene}`);
  if (result.reason) console.log(`  reason      : ${result.reason}`);
  for (const activation of result.layerActivations || []) {
    const delta = activation.delta;
    console.log(`  toggle ${activation.layerId.padEnd(31)} movers ${String(delta.moverInstances).padStart(6)} · lines ${String(delta.lines).padStart(5)} · ground ${String(delta.groundItems).padStart(6)} · imagery ${String(delta.imageryLayers).padStart(2)}${delta.entities === undefined ? '' : ` · entities ${String(delta.entities).padStart(6)} · LabelGraphics ${String(delta.labelGraphics).padStart(6)}`}`);
  }
  if (result.entityInventory) {
    const totals = result.entityInventory.totals;
    console.log(`  scene total : mover sets ${totals.moverSets} · instances ${totals.moverInstances} · lines ${totals.lines} · ground sets ${totals.groundSets} (${totals.groundItems} items) · imagery ${totals.imageryLayers}`);
    if (totals.entities !== undefined)
      console.log(`  Cesium      : entities ${totals.entities} · LabelGraphics ${totals.labelGraphics} (${totals.shownLabelGraphics} show=true) · primitive labels ${totals.primitiveLabels}`);
  }
  for (const phaseName of ['motion', 'rest']) {
    const phase = result.samples?.[phaseName];
    if (!phase) continue;
    const frame = phase.frameTime;
    console.log(`  ${phaseName.padEnd(6)} frame: n=${frame.samples} mean=${frame.meanMs} ms p50=${frame.p50Ms} ms p95=${frame.p95Ms} ms p99=${frame.p99Ms} ms`);
    for (const canvas of phase.canvases || []) {
      console.log(`    ${canvas.id.padEnd(18)} frames≈${String(canvas.clearRectCalls).padStart(4)} fillText=${String(canvas.fillTextCalls).padStart(5)} drawImage=${String(canvas.drawImageCalls).padStart(5)} 2D-sync=${String(canvas.totalSyncMs).padStart(8)} ms`);
    }
  }
  const detection = result.samples?.rest?.detectionDiagnostics;
  if (detection) {
    console.log(`  detection   : observations=${detection.observationCount ?? 'n/a'} candidates=${detection.candidateCount ?? 'n/a'} visible=${detection.visibleCount ?? 'n/a'} selected=${detection.selectedCount ?? 'n/a'} solve=${round(detection.solveMs)} ms paint=${round(detection.paintMs)} ms`);
  }
  const exposed = result.samples?.rest?.exposedCounts;
  if (exposed && Object.values(exposed).some((value) => value != null)) {
    console.log(`  exposed     : CCTV cards=${exposed.cctvOwnedEntries ?? 'n/a'}/${exposed.cctvEntryLimit ?? 'n/a'} · FIRMS objects=${exposed.firmsSourceObjects ?? 'n/a'} · vessel objects=${exposed.vesselSourceObjects ?? 'n/a'}`);
  }
  console.log('');
}

async function installPageInstrumentation(page) {
  await page.evaluateOnNewDocument(() => {
    const trackedMethods = [
      'arc', 'arcTo', 'beginPath', 'clearRect', 'closePath', 'drawImage', 'fill',
      'fillRect', 'fillText', 'lineTo', 'measureText', 'moveTo', 'quadraticCurveTo',
      'rect', 'resetTransform', 'restore', 'rotate', 'roundRect', 'save', 'scale',
      'setTransform', 'stroke', 'strokeRect', 'strokeText', 'translate',
    ];
    const metrics = new Map();
    const metricFor = (canvas) => {
      const id = canvas?.id || '(anonymous-canvas)';
      let metric = metrics.get(id);
      if (!metric) {
        metric = { id, calls: 0, totalSyncMs: 0, maxSyncMs: 0, methods: {} };
        metrics.set(id, metric);
      }
      return metric;
    };
    const proto = globalThis.CanvasRenderingContext2D?.prototype;
    if (proto) {
      for (const method of trackedMethods) {
        const original = proto[method];
        if (typeof original !== 'function' || original.__gevBaselineWrapped) continue;
        const wrapped = function(...args) {
          const startedAt = performance.now();
          try {
            return Reflect.apply(original, this, args);
          } finally {
            const elapsed = performance.now() - startedAt;
            const metric = metricFor(this.canvas);
            metric.calls++;
            metric.totalSyncMs += elapsed;
            metric.maxSyncMs = Math.max(metric.maxSyncMs, elapsed);
            const methodMetric = metric.methods[method] || (metric.methods[method] = { calls: 0, totalSyncMs: 0 });
            methodMetric.calls++;
            methodMetric.totalSyncMs += elapsed;
          }
        };
        Object.defineProperty(wrapped, '__gevBaselineWrapped', { value: true });
        try { proto[method] = wrapped; } catch { /* A non-writable method stays uninstrumented. */ }
      }
    }
    globalThis.__overlayBaselineInstrumentation = {
      reset() { metrics.clear(); },
      snapshot() {
        return Array.from(metrics.values()).map((metric) => ({
          id: metric.id,
          calls: metric.calls,
          totalSyncMs: metric.totalSyncMs,
          maxSyncMs: metric.maxSyncMs,
          methods: JSON.parse(JSON.stringify(metric.methods)),
        }));
      },
    };
  });
}

async function waitForApp(page) {
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(
    () => Boolean(window.__godsEyeView?.engine && window.__godsEyeView?.dataManager),
    { timeout: 60_000 },
  );
  await whenSettled(page);
  await page.evaluate(() => {
    const { engine } = window.__godsEyeView;
    try { engine.camera.cancelFlight(); } catch { /* no flight */ }
  });
  await whenFramesDrawn(page);
}

async function setCamera(page, camera) {
  if (!camera) return;
  await page.evaluate(([destination, heading, pitch]) => {
    const { engine } = window.__godsEyeView;
    engine.camera.cancelFlight();
    engine.camera.setView({
      destination,
      orientation: { heading, pitch, roll: 0 },
    });
    engine.render.request('qa-overlay-baseline');
  }, [fromDegrees(...camera.slice(0, 3)), ...camera.slice(3)]);
}

async function readLayerState(page, layerId) {
  return page.evaluate((id) => {
    const manager = window.__godsEyeView.dataManager;
    const entry = manager.layers.get(id);
    if (!entry) return null;
    let stats = {};
    try { stats = entry.initialized ? entry.module.getStats?.() || {} : {}; } catch (error) { stats = { error: error.message }; }
    return { enabled: entry.enabled, initialized: entry.initialized, stats };
  }, layerId);
}

async function waitForLayer(page, layerId) {
  const dataBearing = new Set([
    'local-datacenters', 'local-dams', 'telegeography-submarine-cables', 'cctv',
    'local-firms', 'ais-live-vessels', 'flights', 'satellites', 'rocket-launches',
  ]);
  if (!dataBearing.has(layerId)) return readLayerState(page, layerId);
  try {
    await page.waitForFunction((id) => {
      const entry = window.__godsEyeView?.dataManager?.layers?.get(id);
      if (!entry?.enabled || !entry.initialized) return false;
      let stats;
      try { stats = entry.module.getStats?.() || {}; } catch { return false; }
      if (stats.loading === true) return false;
      if (stats.error) return true;
      return Number(stats.count || 0) > 0;
    }, { timeout: LAYER_WAIT_MS, polling: 250 }, layerId);
  } catch {
    // The caller records the final state and decides whether live-data absence
    // makes the specialized scene skippable.
  }
  return readLayerState(page, layerId);
}

async function readEntityInventory(page) {
  return page.evaluate(() => {
    const { viewer, engine } = window.__godsEyeView;
    // What the layers draw, on either engine: the globe contract's sets
    // (layers own no Cesium Entities, DataSources or primitives any more).
    const movers = engine.movers.list();
    const lines = engine.lines.list();
    const ground = engine.ground.list();
    const imagery = engine.imagery.list();
    const contract = {
      moverSets: movers.length,
      moverInstances: movers.reduce((sum, set) => sum + set.count, 0),
      lines: lines.filter((line) => line.shown).length,
      groundSets: ground.length,
      groundItems: ground.reduce((sum, set) => sum + (set.shown ? set.count : 0), 0),
      imageryLayers: imagery.filter((layer) => layer.shown).length,
    };
    const contractCollections = [
      ...movers.map((set) => ({ scope: 'movers', ...set })),
      ...ground.map((set) => ({ scope: 'ground', ...set })),
      ...imagery.map((layer) => ({ scope: 'imagery', ...layer })),
    ];
    // Without a Cesium viewer (Navara): the contract sets only.
    if (!viewer) {
      return {
        totals: contract,
        collections: contractCollections,
        primitiveTypes: {},
      };
    }
    const time = viewer.clock.currentTime;
    const collections = [...contractCollections];
    const totals = {
      ...contract,
      entities: 0,
      labelGraphics: 0,
      shownLabelGraphics: 0,
      nonemptyLabelText: 0,
      emptyLabelText: 0,
      primitiveLabels: 0,
      primitiveBillboards: 0,
      primitivePoints: 0,
      scenePrimitives: 0,
    };

    const propertyValue = (property, fallback) => {
      if (property == null) return fallback;
      try {
        return typeof property.getValue === 'function' ? property.getValue(time) : property;
      } catch {
        return fallback;
      }
    };
    const labelGroup = (entityId) => {
      const id = String(entityId || '');
      if (id.startsWith('rocket-launch:')) return 'mission-anchor';
      if (id.startsWith('rocket-satellite:')) return 'mission-live-or-estimated';
      if (id.startsWith('rocket-orbit-label:')) return 'mission-orbit';
      if (id.startsWith('rocket-reentry-label:')) return 'mission-reentry';
      if (id.startsWith('cctv-')) return 'cctv';
      return id.includes(':') ? id.split(':', 1)[0] : '(other)';
    };
    const addCollection = (scope, name, entityCollection, collectionShown = true) => {
      const entities = Array.from(entityCollection?.values || []);
      let labelGraphics = 0;
      let shownLabelGraphics = 0;
      let nonemptyLabelText = 0;
      let emptyLabelText = 0;
      const labelGroups = {};
      for (const entity of entities) {
        if (!entity?.label) continue;
        labelGraphics++;
        const text = String(propertyValue(entity.label.text, '') || '');
        if (text) nonemptyLabelText++;
        else emptyLabelText++;
        const entityShown = entity.show !== false && collectionShown;
        const labelShown = Boolean(propertyValue(entity.label.show, true));
        if (entityShown && labelShown) shownLabelGraphics++;
        const group = labelGroup(entity.id);
        labelGroups[group] = (labelGroups[group] || 0) + 1;
      }
      const row = {
        scope,
        name,
        entities: entities.length,
        labelGraphics,
        shownLabelGraphics,
        nonemptyLabelText,
        emptyLabelText,
        labelGroups,
      };
      collections.push(row);
      totals.entities += row.entities;
      totals.labelGraphics += row.labelGraphics;
      totals.shownLabelGraphics += row.shownLabelGraphics;
      totals.nonemptyLabelText += row.nonemptyLabelText;
      totals.emptyLabelText += row.emptyLabelText;
    };

    addCollection('viewer', 'viewer.entities', viewer.entities, true);
    for (let index = 0; index < viewer.dataSources.length; index++) {
      const dataSource = viewer.dataSources.get(index);
      addCollection('dataSource', dataSource.name || `dataSource:${index}`, dataSource.entities, dataSource.show !== false);
    }

    const primitiveTypes = {};
    const seen = new Set();
    const visitPrimitiveCollection = (collection, depth = 0) => {
      if (!collection || depth > 5 || seen.has(collection)) return;
      seen.add(collection);
      const length = Number(collection.length || 0);
      for (let index = 0; index < length; index++) {
        let primitive;
        try { primitive = collection.get(index); } catch { primitive = null; }
        if (!primitive || seen.has(primitive)) continue;
        const type = primitive.constructor?.name || '(anonymous)';
        primitiveTypes[type] = (primitiveTypes[type] || 0) + 1;
        totals.scenePrimitives++;
        if (Array.isArray(primitive._labels)) totals.primitiveLabels += primitive._labels.length;
        if (Array.isArray(primitive._billboards)) totals.primitiveBillboards += primitive._billboards.length;
        if (Array.isArray(primitive._pointPrimitives)) totals.primitivePoints += primitive._pointPrimitives.length;
        if (typeof primitive.length === 'number' && typeof primitive.get === 'function') {
          visitPrimitiveCollection(primitive, depth + 1);
        }
      }
    };
    visitPrimitiveCollection(viewer.scene.primitives);

    return { totals, collections, primitiveTypes };
  });
}

async function activateLayers(page, layerIds) {
  const activations = [];
  for (const layerId of layerIds) {
    const before = await readEntityInventory(page);
    const toggleResult = await page.evaluate(async (id) => {
      const manager = window.__godsEyeView.dataManager;
      if (!manager.layers.has(id)) return { error: `unregistered layer: ${id}` };
      if (!manager.isEnabled(id)) await manager.toggle(id);
      return { enabled: manager.isEnabled(id) };
    }, layerId);
    const state = await waitForLayer(page, layerId);
    const after = await readEntityInventory(page);
    activations.push({
      layerId,
      toggleResult,
      state,
      delta: inventoryDelta(before, after),
      collectionsAdded: after.collections.filter((row) => !before.collections.some((prior) => prior.scope === row.scope && prior.name === row.name)),
    });
  }
  return activations;
}

async function prepareCctv(page, heightM) {
  const camera = await page.evaluate((height) => {
    const layer = window.__godsEyeView.dataManager.layers.get('cctv')?.module;
    const state = layer?.getUIState?.();
    const record = state?.cameras?.find((candidate) => Number.isFinite(candidate.lon) && Number.isFinite(candidate.lat));
    if (!record) return null;
    return [record.lon, record.lat, height, 0, -1.35];
  }, heightM);
  if (!camera) return 'CCTV catalog did not expose a geolocated camera';
  await setCamera(page, camera);
  await whenFramesDrawn(page);
  return null;
}

async function prepareFirms(page) {
  const result = await page.evaluate(() => {
    const layer = window.__godsEyeView.dataManager.layers.get('local-firms')?.module;
    const stats = layer?.getStats?.() || {};
    const fire = layer?.getStrongestFire?.();
    return { stats, fire };
  });
  if (!result.fire) return `FIRMS unavailable (${result.stats.error || 'no detections'})`;
  await setCamera(page, [result.fire.longitude, result.fire.latitude, 60_000, 0, -1.45]);
  await whenFramesDrawn(page);
  return null;
}

async function prepareVessels(page) {
  const state = await readLayerState(page, 'ais-live-vessels');
  if (!(state?.stats?.count > 0)) return `AIS unavailable (${state?.stats?.error || 'no live vessels'})`;
  await whenFramesDrawn(page);
  return null;
}

async function prepareDetection(page, densityPct) {
  const sourceStates = await Promise.all(['flights', 'satellites'].map((id) => readLayerState(page, id)));
  if (!sourceStates.some((state) => (state?.stats?.count || 0) > 0)) {
    return 'Detection sources exposed no observations';
  }
  const control = await page.evaluate((density) => window.__godsEyeView.styleManager.setDetection({
    enabled: true,
    densityPct: density,
  }), densityPct);
  if (!control?.ok) return `Detection control failed (${control?.error || 'unknown error'})`;
  await whenFramesDrawn(page);
  return null;
}

async function prepareTrackedFlight(page, cockpit) {
  if (cockpit) {
    const contacts = await page.evaluate(() => window.__godsEyeView.styleManager.setContextMode(
      'contacts',
      { origin: 'user' },
    ));
    if (!contacts?.ok) {
      return `Contacts activation failed (${contacts?.error || 'unknown error'})`;
    }
  }
  const tracked = await page.evaluate(() => {
    const entry = window.__godsEyeView.dataManager.layers.get('flights');
    const layer = entry?.module;
    const candidates = layer?.getAllPositions?.(500) || [];
    const airborne = candidates.find((candidate) => Number(candidate.altitudeM) > 1_000) || candidates[0];
    if (!airborne) return { ok: false, reason: 'no rendered civil aircraft' };
    const ok = layer.trackById?.(airborne.id);
    return { ok: Boolean(ok), id: airborne.id, label: airborne.label, reason: ok ? null : 'trackById rejected candidate' };
  });
  if (!tracked.ok) return `Civil tracking unavailable (${tracked.reason})`;
  try {
    await page.waitForFunction(() => Boolean(window.__godsEyeView.engine.camera.following()), { timeout: 10_000 });
  } catch {
    return 'Civil tracking did not create a tracked entity';
  }
  await whenFramesDrawn(page);
  if (!cockpit) return null;
  const entryAvailable = await page.evaluate(() => {
    const button = document.getElementById('cockpit-entry');
    if (!button || button.hidden || button.disabled) return false;
    button.click();
    return true;
  });
  if (!entryAvailable) return 'Cockpit entry control was unavailable for the tracked aircraft';
  try {
    await page.waitForFunction(() => document.body.classList.contains('cockpit-mode'), { timeout: 5_000 });
  } catch {
    return 'Cockpit entry control did not enter cockpit mode';
  }
  await whenFramesDrawn(page);
  return null;
}

async function prepareMission(page) {
  const state = await readLayerState(page, 'rocket-launches');
  if (!(state?.stats?.count > 0)) return `Mission feed unavailable (${state?.stats?.error || 'no missions'})`;
  const selected = await page.evaluate(() => {
    const button = document.querySelector('[data-mission-roster-index="0"]');
    if (!button) return false;
    button.click();
    return true;
  });
  if (!selected) return 'Mission roster did not expose a selectable mission';
  try {
    await page.waitForFunction(() => Boolean(window.__godsEyeView.dataManager.layers.get('rocket-launches')?.module?.qaDrawn?.()?.selected), { timeout: 10_000 });
  } catch {
    return 'Mission selection did not reach the layer probe';
  }
  await whenFramesDrawn(page);
  return null;
}

async function prepareScene(page, scene) {
  const missing = await page.evaluate(
    (ids) => ids.filter((id) => !window.__godsEyeView.dataManager.layers.has(id)),
    scene.layers,
  );
  if (missing.length)
    return { layerActivations: [], skipReason: `no ${missing.join(', ')} on ${ENGINE}` };
  if (scene.camera) await setCamera(page, scene.camera);
  const layerActivations = await activateLayers(page, scene.layers);
  let skipReason = null;
  if (scene.cctvHeightM) skipReason = await prepareCctv(page, scene.cctvHeightM);
  if (!skipReason && scene.id === 'firms') skipReason = await prepareFirms(page);
  if (!skipReason && scene.id === 'vessels') skipReason = await prepareVessels(page);
  if (!skipReason && scene.detectionDensity) skipReason = await prepareDetection(page, scene.detectionDensity);
  if (!skipReason && scene.trackedFlight) skipReason = await prepareTrackedFlight(page, scene.cockpit);
  if (!skipReason && scene.missionSelected) skipReason = await prepareMission(page);
  await whenFramesDrawn(page);
  return { layerActivations, skipReason };
}

async function readCanvasSummary(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('canvas')).map((canvas) => {
    const style = getComputedStyle(canvas);
    return {
      id: canvas.id || '(anonymous-canvas)',
      width: canvas.width,
      height: canvas.height,
      cssWidth: canvas.clientWidth,
      cssHeight: canvas.clientHeight,
      display: style.display,
      opacity: style.opacity,
      zIndex: style.zIndex,
    };
  }));
}

async function samplePhase(page, moving) {
  const raw = await page.evaluate(async ({ durationMs, movingCamera }) => {
    const { engine } = window.__godsEyeView;
    // Cesium's rotateRight / rotateUp: the camera turned about the axis
    // through the globe centre along its up (right) vector.
    const rotate = (axis, angle) => {
      const pose = engine.camera.pose();
      const len = Math.hypot(axis.x, axis.y, axis.z);
      const [ux, uy, uz] = [axis.x / len, axis.y / len, axis.z / len];
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      const turn = (v) => {
        const dot = ux * v.x + uy * v.y + uz * v.z;
        return {
          x: v.x * cos + (uy * v.z - uz * v.y) * sin + ux * dot * (1 - cos),
          y: v.y * cos + (uz * v.x - ux * v.z) * sin + uy * dot * (1 - cos),
          z: v.z * cos + (ux * v.y - uy * v.x) * sin + uz * dot * (1 - cos),
        };
      };
      engine.camera.setView({
        destination: turn(pose.position),
        orientation: { direction: turn(pose.direction), up: turn(pose.up) },
      });
    };
    const instrumentation = window.__overlayBaselineInstrumentation;
    instrumentation?.reset?.();
    const intervals = [];
    const startedAt = performance.now();
    let lastFrameAt = null;
    await new Promise((resolve) => {
      const step = (now) => {
        if (lastFrameAt != null) intervals.push(now - lastFrameAt);
        lastFrameAt = now;
        const elapsed = now - startedAt;
        if (movingCamera) {
          const pose = engine.camera.pose();
          rotate(pose.up, -0.00035);
          rotate(engine.camera.pose().right, 0.00008 * Math.sin(elapsed / 600));
        }
        engine.render.request('qa-overlay-baseline');
        if (elapsed >= durationMs) resolve();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
    const canvasMetrics = instrumentation?.snapshot?.() || [];
    const detectionDiagnostics = window.__godsEyeView.styleManager?.getDetectionDiagnostics?.() || null;
    const manager = window.__godsEyeView.dataManager;
    const cctvEntry = manager.layers.get('cctv');
    const cctvState = cctvEntry?.initialized ? cctvEntry.module.getUIState?.() : null;
    const firmsEntry = manager.layers.get('local-firms');
    const vesselsEntry = manager.layers.get('ais-live-vessels');
    return {
      intervals,
      canvasMetrics,
      detectionDiagnostics,
      exposedCounts: {
        cctvOwnedEntries: cctvState?.ambientCards?.count ?? null,
        cctvEntryLimit: cctvState?.ambientCards?.limit ?? null,
        firmsSourceObjects: firmsEntry?.initialized ? firmsEntry.module.getStats?.()?.count ?? null : null,
        vesselSourceObjects: vesselsEntry?.initialized ? vesselsEntry.module.getStats?.()?.count ?? null : null,
      },
      elapsedMs: performance.now() - startedAt,
    };
  }, { durationMs: SAMPLE_MS, movingCamera: moving });

  const canvases = raw.canvasMetrics
    .filter((metric) => KNOWN_OVERLAY_CANVASES.has(metric.id))
    .map((metric) => ({
      id: metric.id,
      calls: metric.calls,
      totalSyncMs: round(metric.totalSyncMs),
      maxSyncMs: round(metric.maxSyncMs),
      clearRectCalls: metric.methods.clearRect?.calls || 0,
      fillTextCalls: metric.methods.fillText?.calls || 0,
      drawImageCalls: metric.methods.drawImage?.calls || 0,
      measureTextCalls: metric.methods.measureText?.calls || 0,
      strokeCalls: metric.methods.stroke?.calls || 0,
      fillCalls: metric.methods.fill?.calls || 0,
      methods: Object.fromEntries(Object.entries(metric.methods).map(([name, value]) => [name, {
        calls: value.calls,
        totalSyncMs: round(value.totalSyncMs),
      }])),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return {
    requestedDurationMs: SAMPLE_MS,
    actualDurationMs: round(raw.elapsedMs),
    frameTime: summarizeFrameIntervals(raw.intervals),
    canvases,
    detectionDiagnostics: raw.detectionDiagnostics,
    exposedCounts: raw.exposedCounts,
  };
}

async function captureShot(page, shotsDir, sceneId, suffix) {
  if (!shotsDir) return null;
  fs.mkdirSync(shotsDir, { recursive: true });
  const safeScene = sceneId.replace(/[^a-z0-9-]+/gi, '-');
  const outPath = path.join(shotsDir, `${safeScene}-${suffix}.png`);
  await page.screenshot({ path: outPath });
  return outPath;
}

async function runScene(browser, scene, shotsDir) {
  const page = await browser.newPage();
  await page.setViewport({ ...VIEWPORT, deviceScaleFactor: DPR });
  await installStaticDist(page, DIST_DIR);
  await installDeterministicDevEndpoints(page);
  const consoleMessages = [];
  page.on('console', (message) => {
    if (['error', 'warning', 'warn'].includes(message.type())) {
      consoleMessages.push({ type: message.type(), text: message.text() });
    }
  });
  page.on('pageerror', (error) => consoleMessages.push({ type: 'pageerror', text: error.message }));
  await installPageInstrumentation(page);

  const result = {
    scene: scene.id,
    status: 'ok',
    reason: null,
    layerActivations: [],
    entityInventory: null,
    canvasInventory: [],
    samples: null,
    screenshots: [],
    consoleMessages,
  };
  try {
    await waitForApp(page);
    const prepared = await prepareScene(page, scene);
    result.layerActivations = prepared.layerActivations;
    result.entityInventory = await readEntityInventory(page);
    result.canvasInventory = await readCanvasSummary(page);
    if (prepared.skipReason) {
      result.status = 'skipped';
      result.reason = prepared.skipReason;
      return result;
    }
    const beforeShot = await captureShot(page, shotsDir, scene.id, 'before-motion');
    if (beforeShot) result.screenshots.push(beforeShot);
    const motion = await samplePhase(page, true);
    const afterMotionShot = await captureShot(page, shotsDir, scene.id, 'after-motion');
    if (afterMotionShot) result.screenshots.push(afterMotionShot);
    await whenFramesDrawn(page);
    const rest = await samplePhase(page, false);
    result.samples = { motion, rest };
    result.entityInventoryAfter = await readEntityInventory(page);
    return result;
  } catch (error) {
    result.status = 'error';
    result.reason = error?.stack || error?.message || String(error);
    return result;
  } finally {
    await page.close();
  }
}

const ENGINE = process.argv.find((value) => value.startsWith('--engine='))?.slice(9) ?? 'cesium';
const APP_URL = (() => {
  const url = new URL(getOpt('--url', DEFAULT_URL));
  url.searchParams.set('engine', ENGINE);
  return url.href;
})();
const DPR = Number(getOpt('--dpr', '1'));
const JSON_PATH = getOpt('--json');
const SCREENSHOTS_DIR = getOpt('--screenshots-dir');
const DIST_DIR = getOpt('--dist-dir');
const HEADFUL = hasFlag('--headful');
const HARDWARE_GPU = hasFlag('--hardware-gpu');

function softwareRenderer(renderer) {
  return /swiftshader|software|llvmpipe/i.test(String(renderer || ''));
}

function unavailableRenderer(renderer) {
  return !String(renderer || '').trim() || String(renderer).toLowerCase() === 'unavailable';
}

async function main() {
  if (!Number.isFinite(DPR) || DPR <= 0) throw new Error(`Invalid --dpr value: ${DPR}`);
  const scenes = selectedScenes();
  if (DIST_DIR && (!fs.existsSync(DIST_DIR) || !fs.statSync(DIST_DIR).isDirectory())) {
    throw new Error(`--dist-dir is not a directory: ${DIST_DIR}`);
  }
  if (!DIST_DIR) {
    const response = await fetch(APP_URL).catch((error) => ({ ok: false, statusText: error.message }));
    if (!response.ok) throw new Error(`Dev server unavailable at ${APP_URL}: ${response.status || response.statusText}`);
  }

  const browser = await launchBrowser({
    headless: true,
    args: [...(process.env.QA_ANGLE ? [] : HARDWARE_GPU ? [] : ['--enable-unsafe-swiftshader']), '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', `--window-size=${VIEWPORT.width},${VIEWPORT.height}`],
  });

  const run = { generatedAt: new Date().toISOString(), context: null, scenes: [] };
  try {
    const contextPage = await browser.newPage();
    await contextPage.setViewport({ ...VIEWPORT, deviceScaleFactor: DPR });
    await installStaticDist(contextPage, DIST_DIR);
    await contextPage.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const browserContext = await contextPage.evaluate(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
      const debug = gl?.getExtension('WEBGL_debug_renderer_info');
      return {
        userAgent: navigator.userAgent,
        dpr: window.devicePixelRatio,
        webglVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : gl?.getParameter(gl.VENDOR) || 'unavailable',
        webglRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER) || 'unavailable',
      };
    });
    await contextPage.close();
    const cpus = os.cpus();
    if (HARDWARE_GPU && (
      unavailableRenderer(browserContext.webglRenderer)
      || softwareRenderer(browserContext.webglRenderer)
    )) {
      throw new Error(`Hardware GPU requested but Chrome reported ${browserContext.webglRenderer}`);
    }
    run.context = {
      url: APP_URL,
      machine: {
        hostname: os.hostname(),
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        cpuModel: cpus[0]?.model || 'unknown',
        logicalCpuCount: cpus.length,
        totalMemoryGiB: round(os.totalmem() / (1024 ** 3), 1),
      },
      browser: {
        version: await browser.version(),
        userAgent: browserContext.userAgent,
        webglVendor: browserContext.webglVendor,
        webglRenderer: browserContext.webglRenderer,
      },
      viewport: { ...VIEWPORT, dpr: browserContext.dpr },
      gpuMode: process.env.QA_ANGLE || 'metal',
      chromeExecutable: CHROME_EXECUTABLE,
      chromeArgs: browser.process()?.spawnargs.slice(1),
      sampleMs: SAMPLE_MS,
      captureMode: DIST_DIR ? `static-dist:${path.resolve(DIST_DIR)}` : 'dev-server',
    };
    printContext(run.context);

    for (const scene of scenes) {
      const result = await runScene(browser, scene, SCREENSHOTS_DIR);
      run.scenes.push(result);
      printScene(result);
    }
  } finally {
    await closeBrowser(browser);
  }

  run.summary = {
    ok: run.scenes.filter((scene) => scene.status === 'ok').length,
    skipped: run.scenes.filter((scene) => scene.status === 'skipped').length,
    errors: run.scenes.filter((scene) => scene.status === 'error').length,
  };
  console.log(`Summary: ${run.summary.ok} measured · ${run.summary.skipped} skipped · ${run.summary.errors} errors`);
  if (JSON_PATH) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_PATH)), { recursive: true });
    fs.writeFileSync(JSON_PATH, `${JSON.stringify(run, null, 2)}\n`);
    console.log(`JSON: ${path.resolve(JSON_PATH)}`);
  }
  if (run.summary.errors > 0) process.exitCode = 1;
  if (HARDWARE_GPU && run.summary.ok === 0) {
    console.error('Hardware GPU run produced no measured scenes.');
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
