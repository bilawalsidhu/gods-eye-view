#!/usr/bin/env node
// FIRMS native oracle and renderer comparison, through the real source parser.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import puppeteer from 'puppeteer';
import sharp from 'sharp';
import { watchW1Page, redact } from './qa-browserEvidence.mjs';
import {
  firmsFixture,
  FIRMS_EPOCH_MS,
  FIRMS_VALID_COUNT,
} from './fixtures/w2/firms.mjs';
const arg = (key) =>
  process.argv.find((v) => v.startsWith(`--${key}=`))?.slice(key.length + 3);
if (arg('compare')) {
  const files = arg('compare').split(',');
  if (files.length !== 2) throw new Error('Compare requires two captures');
  const [a, b] = await Promise.all(
    files.map((file) => fs.readFile(file, 'utf8').then(JSON.parse)),
  );
  const errors = [];
  for (const capture of [a, b]) {
    if (
      !capture.pass ||
      !capture.checks?.length ||
      capture.checks.some((check) => !check.pass) ||
      !Array.isArray(capture.browserErrors) ||
      capture.browserErrors.length ||
      !capture.runtimePages?.includes('main')
    )
      errors.push(
        `${capture.engine}: failed checks or missing strict observer evidence`,
      );
    if (
      capture.geometryEpochMs !== FIRMS_EPOCH_MS ||
      capture.records?.length !== FIRMS_VALID_COUNT ||
      capture.initialStats?.lastUpdate !== FIRMS_EPOCH_MS - 120000 ||
      !capture.enabledIdleReady?.ready ||
      capture.enabledIdleFrames !== 0 ||
      capture.disabledIdleFrames !== 0
    )
      errors.push(`${capture.engine}: missing source, epoch or idle evidence`);
    if (
      capture.selection?.selected?.frp !== 999 ||
      capture.selection.focusRequests?.length !== 1 ||
      capture.selection.focusRequests[0]?.id !==
        capture.selection.selected.id ||
      capture.selection.selectedActions !== 1 ||
      !capture.reorder?.before?.id ||
      capture.reorder.before.id !== capture.reorder?.after?.id ||
      capture.reorder?.selections !== 0
    )
      errors.push(
        `${capture.engine}: missing pointer/card/stable selection evidence`,
      );
  }
  if (!a.fixtureSha256 || a.fixtureSha256 !== b.fixtureSha256)
    errors.push('Source fixtures differ');
  if (JSON.stringify(a.records) !== JSON.stringify(b.records))
    errors.push('Analyst records differ');
  for (const pose of ['global', 'regional', 'local', 'close', 'terrain']) {
    const left = a.poses?.[pose],
      right = b.poses?.[pose];
    if (
      !(left?.known?.length >= 5) ||
      !(right?.known?.length >= 5) ||
      left.stats?.cells !== right.stats?.cells ||
      left.onScreen !== right.onScreen ||
      left.engineEpochMs !== FIRMS_EPOCH_MS ||
      right.engineEpochMs !== FIRMS_EPOCH_MS ||
      !(left.raster?.changedPixels >= 100) ||
      !(right.raster?.changedPixels >= 100)
    ) {
      errors.push(`${pose}: missing or different positive population`);
      continue;
    }
    for (const control of left.known) {
      const other = right.known.find((point) => point.id === control.id);
      if (
        !other ||
        ![
          control.screen?.x,
          control.screen?.y,
          other.screen?.x,
          other.screen?.y,
        ].every(Number.isFinite) ||
        Math.max(
          Math.abs(control.screen.x - other.screen.x),
          Math.abs(control.screen.y - other.screen.y),
        ) > 2
      )
        errors.push(`${pose}/${control.id}: projection differs`);
    }
    if (
      ['global', 'regional'].includes(pose) &&
      [a, b].some(
        (capture) =>
          capture.engine === 'cesium' &&
          capture.poses[pose].nativeCells?.length !==
            capture.poses[pose].stats.cells,
      )
    )
      errors.push(`${pose}: native cell geometry evidence is incomplete`);
    if (
      a.engine === 'cesium' &&
      b.engine === 'cesium' &&
      JSON.stringify(left.nativeCells) !== JSON.stringify(right.nativeCells)
    )
      errors.push(`${pose}: native rectangle geometry/colors/metadata differ`);
  }
  const result = { pass: errors.length === 0, errors };
  console.log(JSON.stringify(result));
  process.exit(result.pass ? 0 : 1);
}
const base = arg('base-url');
if (
  !base ||
  new Set([4173, 4185, 4186, 4187, 4188, 4189]).has(Number(new URL(base).port))
)
  throw new Error('Supply an unreserved --base-url');
const engine = arg('engine') ?? 'cesium';
if (!['cesium', 'navara'].includes(engine)) throw new Error('Unknown engine');
const layer = 'local-firms';
const out = path.resolve(
  arg('out') ?? `qa-artifacts/w2/firms/${engine}-baseline.json`,
);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const fixture = firmsFixture();
const report = {
  layer,
  engine,
  stage: 'native-oracle',
  checks: [],
  poses: {},
  browserErrors: [],
  geometryEpochMs: FIRMS_EPOCH_MS,
  fixtureSha256: sha(JSON.stringify(fixture)),
  driverSha256: sha(await fs.readFile(new URL(import.meta.url))),
};
await fs.mkdir(path.dirname(out), { recursive: true });
const check = (name, pass, detail) => {
  report.checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
};
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 180000,
  args: ['--use-angle=metal'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });
  watchW1Page(page, report, {
    name: 'main',
    baseUrl: base,
    preview: process.argv.includes('--preview'),
  });
  await page.evaluateOnNewDocument((payload) => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    const original = window.fetch.bind(window);
    window.__firmsQa = {
      requests: 0,
      terrainRequests: 0,
      next: null,
      reverse: false,
    };
    const json = (body, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    window.fetch = (input, init) => {
      const url = new URL(
        typeof input === 'string' ? input : (input.url ?? input),
        location.href,
      );
      const qa = window.__firmsQa;
      if (
        url.origin === location.origin &&
        url.pathname === '/api/openai/hud-summary'
      ) {
        qa.hudRequests = (qa.hudRequests ?? 0) + 1;
        const context = JSON.parse(init?.body ?? '{}');
        return Promise.resolve(
          json({
            summary: `FIRMS fixture ${context.feedProvenance?.overall ?? 'nominal'}`,
          }),
        );
      }
      if (url.origin === location.origin && url.pathname === '/api/firms') {
        qa.requests++;
        const next = qa.next;
        qa.next = null;
        if (next === 'error')
          return Promise.resolve(json({ error: 'fixture failure' }, 503));
        if (next === 'no_key')
          return Promise.resolve(json({ error: 'no_key' }, 503));
        if (next === 'delay')
          return new Promise((resolve) => {
            qa.release = () => resolve(json({ ...payload, fires: [] }));
          });
        return Promise.resolve(
          json({
            ...payload,
            stale: next === 'stale',
            fires: qa.reverse ? [...payload.fires].reverse() : payload.fires,
          }),
        );
      }
      if (
        url.origin === location.origin &&
        url.pathname === '/api/terrain/heights'
      ) {
        qa.terrainRequests++;
        // Explicit deterministic DEM fixture. These are not live terrain measurements.
        return Promise.resolve(
          json({
            results: (url.searchParams.get('points') ?? '')
              .split(';')
              .filter(Boolean)
              .map((p) => {
                const [lon, lat] = p.split(',').map(Number);
                const ellipsoid = lat > 60 ? -20 : 100;
                return { lat, lon, elevation: ellipsoid, geoid: 0, ellipsoid };
              }),
          }),
        );
      }
      return original(input, init);
    };
  }, fixture);
  const url = new URL(base);
  url.searchParams.set('engine', engine);
  await page.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 180000 });
  await page.waitForFunction(
    () => window.__godsEyeView?.layers && window.__godsEyeView?.styleManager,
    { timeout: 180000 },
  );
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.waitForFunction(
    () =>
      document.getElementById('loading-screen')?.classList.contains('hidden'),
    { timeout: 180000 },
  );
  const setup = await page.evaluate(
    async ([id, epoch]) => {
      const a = window.__godsEyeView;
      a.styleManager.orbitController.stop();
      a.engine.camera.cancelFlight();
      for (const [name] of a.dataManager.layers)
        if (a.dataManager.isEnabled(name)) await a.layers.disable(name);
      const { appClock } = await import('/src/time/clock.js');
      appClock.freeze(epoch);
      if (a.viewer)
        a.viewer.clock.currentTime =
          a.viewer.clock.currentTime.constructor.fromDate(new Date(epoch));
      const detection = await import('/src/data/detection.js');
      detection.setMode('OFF');
      return { available: a.dataManager.layers.has(id), engine: a.engine.kind };
    },
    [layer, FIRMS_EPOCH_MS],
  );
  check(
    'required layer and engine',
    setup.available && setup.engine === engine,
    setup,
  );
  if (!setup.available) throw new Error('Required FIRMS layer is unavailable');
  await page.evaluate((id) => window.__godsEyeView.layers.enable(id), layer);
  await page.waitForFunction(
    ([id, count]) =>
      window.__godsEyeView.dataManager.layers.get(id).module.getStats()
        .count === count,
    { timeout: 30000 },
    [layer, FIRMS_VALID_COUNT],
  );
  report.records = await page.evaluate(
    (id) =>
      window.__godsEyeView.dataManager.layers
        .get(id)
        .module.getAnalystRecords(1000),
    layer,
  );
  report.initialStats = await page.evaluate(
    (id) => window.__godsEyeView.dataManager.layers.get(id).module.getStats(),
    layer,
  );
  check(
    'real parser retains 371 valid detections with UTC acquisition and confidence',
    report.records.length === FIRMS_VALID_COUNT &&
      report.records.every(
        (r) =>
          Number.isFinite(r.acqTime) && r.confidence >= 0 && r.confidence <= 1,
      ),
    report.records.length,
  );
  check(
    'source receipt time is preserved',
    report.initialStats.lastUpdate === fixture.fetchedAt,
    report.initialStats.lastUpdate,
  );
  await page.evaluate(() => {
    const canvas = window.__godsEyeView.engine.host.canvas;
    const style = document.createElement('style');
    style.textContent = '.firms-qa-hidden {visibility:hidden!important}';
    document.head.append(style);
    for (const element of document.body.querySelectorAll('*'))
      if (element !== canvas && !element.contains(canvas))
        element.classList.add('firms-qa-hidden');
  });
  for (const [name, pose] of Object.entries({
    global: [-110, 40, 15000000, -90],
    regional: [-122.42, 37.77, 4000000, -90],
    local: [-122.42, 37.77, 1000000, -90],
    close: [-122.42, 37.77, 100000, -90],
    terrain: [-122.42, 37.3, 80000, -45],
  })) {
    await page.evaluate(async (p) => {
      const a = window.__godsEyeView,
        geo = await import('/src/geo/index.js');
      a.engine.camera.setView({
        destination: geo.cartesian3.fromDegrees(p[0], p[1], p[2]),
        orientation: { heading: 0, pitch: geo.math.toRadians(p[3]), roll: 0 },
      });
      a.engine.render.request('firms-qa-pose');
    }, pose);
    const ready = await page.evaluate(async () => {
      const e = window.__godsEyeView.engine,
        start = performance.now();
      let since = null;
      while (performance.now() - start < 90000) {
        if (e.surface.tilesLoaded()) since ??= performance.now();
        else since = null;
        if (since !== null && performance.now() - since > 1500) return true;
        e.render.request('firms-qa-settle');
        await new Promise((r) => setTimeout(r, 100));
      }
      return false;
    });
    check(`${name}: tiles settle`, ready);
    await sleep(3500);
    const snap = await page.evaluate((id) => {
      const a = window.__godsEyeView,
        e = a.engine,
        module = a.dataManager.layers.get(id).module;
      const controls = module
        .getDetectableObjects({ maxCount: 1000 })
        .map((r) => {
          const screen = e.projector.worldToWindow(r.position);
          return {
            id: r.id,
            position: { x: r.position.x, y: r.position.y, z: r.position.z },
            screen: screen ? { x: screen.x, y: screen.y } : null,
            visible:
              screen &&
              e.projector.horizonVisible(r.position) &&
              screen.x >= 0 &&
              screen.y >= 0 &&
              screen.x < 1280 &&
              screen.y < 800,
          };
        })
        .filter((r) => r.visible)
        .sort((a, b) => a.id.localeCompare(b.id));
      const sources = a.viewer?.dataSources.getByName(id) ?? [];
      return {
        stats: module.getStats(),
        engineEpochMs: e.clock.now(),
        known: controls.slice(0, 5),
        onScreen: controls.length,
        nativeCells: sources.flatMap((source) =>
          source.entities.values
            .filter((v) => v.rectangle)
            .map((v) => ({
              rectangle: v.rectangle.coordinates.getValue(
                a.viewer.clock.currentTime,
              ),
              color: v.rectangle.material.color.getValue(
                a.viewer.clock.currentTime,
              ),
              count: v.properties.count.getValue(a.viewer.clock.currentTime),
            })),
        ),
      };
    }, layer);
    check(
      `${name}: five positive controls at fixed epoch`,
      snap.known.length >= 5 && snap.engineEpochMs === FIRMS_EPOCH_MS,
      snap.onScreen,
    );
    check(
      `${name}: nonempty actual rendered population`,
      snap.stats.cells > 0,
      snap.stats.cells,
    );
    const onFile = out.replace(/\.json$/, `-${name}-on.png`),
      offFile = out.replace(/\.json$/, `-${name}-off.png`);
    const on = await page.screenshot({ path: onFile });
    await page.evaluate((id) => window.__godsEyeView.layers.disable(id), layer);
    await sleep(1500);
    const off = await page.screenshot({ path: offFile });
    const [a, b] = await Promise.all(
      [on, off].map((image) => sharp(image).removeAlpha().raw().toBuffer()),
    );
    let changedPixels = 0;
    for (let i = 0; i < a.length; i += 3)
      if (
        Math.max(
          Math.abs(a[i] - b[i]),
          Math.abs(a[i + 1] - b[i + 1]),
          Math.abs(a[i + 2] - b[i + 2]),
        ) > 16
      )
        changedPixels++;
    snap.raster = {
      changedPixels,
      on: { file: path.basename(onFile), sha256: sha(on) },
      off: { file: path.basename(offFile), sha256: sha(off) },
    };
    report.poses[name] = snap;
    check(
      `${name}: positive actual globe raster`,
      changedPixels >= 100,
      changedPixels,
    );
    await page.evaluate((id) => window.__godsEyeView.layers.enable(id), layer);
  }
  await page.evaluate(() => {
    for (const element of document.querySelectorAll('.firms-qa-hidden'))
      element.classList.remove('firms-qa-hidden');
  });
  const target = await page.evaluate(async (id) => {
    const a = window.__godsEyeView,
      geo = await import('/src/geo/index.js');
    a.engine.camera.setView({
      destination: geo.cartesian3.fromDegrees(-122.42, 37.77, 100000),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    a.engine.render.request('firms-click-pose');
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const m = a.dataManager.layers.get(id).module,
      record = m.getAnalystRecords(1)[0];
    const point = m
      .getDetectableObjects({ maxCount: 1000 })
      .find((r) => r.id === record.id);
    const screen = point && a.engine.projector.worldToWindow(point.position);
    window.__firmsQa.focusRequests = [];
    window.__firmsQa.onFocus = (event) =>
      window.__firmsQa.focusRequests.push({
        kind: event.detail?.kind,
        id: event.detail?.id,
      });
    window.addEventListener(
      'gev:world-request-focus',
      window.__firmsQa.onFocus,
    );
    return {
      record,
      screen: screen ? { x: screen.x, y: screen.y } : null,
      generation: a.styleManager._navigationGeneration,
    };
  }, layer);
  check(
    'strongest fire has a real visible pointer target',
    target.record?.frp === 999 &&
      target.screen?.x > 0 &&
      target.screen.x < 1280 &&
      target.screen.y > 0 &&
      target.screen.y < 800,
    target,
  );
  if (!target.screen) throw new Error('No positive FIRMS pointer target');
  await page.mouse.click(target.screen.x, target.screen.y);
  const selected = await page
    .waitForFunction(
      (id) =>
        window.__godsEyeView.dataManager.layers.get(id).module.getSelectedInfo()
          ?.frp === 999,
      { timeout: 5000 },
      layer,
    )
    .then(() => true)
    .catch(() => false);
  await page.evaluate(() => {
    window.__godsEyeView.engine.camera.cancelFlight();
    window.__godsEyeView.engine.render.request('firms-selected-proof');
  });
  await sleep(1500);
  report.selection = await page.evaluate((id) => {
    const a = window.__godsEyeView,
      qa = window.__firmsQa;
    window.removeEventListener('gev:world-request-focus', qa.onFocus);
    const actions = [
      ...document.querySelectorAll(
        '#world-overlay-action-list button[data-overlay-action-key]',
      ),
    ].filter((button) =>
      String(button.dataset.overlayActionKey ?? '').startsWith('firms\u0000'),
    );
    const canvas = document.getElementById('world-overlay-canvas');
    const pixels = canvas
      ?.getContext('2d')
      .getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    if (pixels)
      for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 8) ink++;
    return {
      selected: a.dataManager.layers.get(id).module.getSelectedInfo(),
      focusRequests: qa.focusRequests,
      generation: a.styleManager._navigationGeneration,
      contextId: window.__gevContextStore?.selectedEntityId,
      selectedActions: actions.filter(
        (button) => button.getAttribute('aria-pressed') === 'true',
      ).length,
      painted:
        window.__gevWorldOverlay?.getDiagnostics()?.paintedBySource?.firms ?? 0,
      ink,
    };
  }, layer);
  check(
    'real sprite click selects a stable detection and requests one UI-owned focus',
    selected &&
      report.selection.focusRequests.length === 1 &&
      report.selection.focusRequests[0].kind === 'fire' &&
      report.selection.focusRequests[0].id === report.selection.selected?.id &&
      report.selection.generation === target.generation + 1 &&
      report.selection.contextId === report.selection.selected?.id,
    report.selection,
  );
  check(
    'selected fire card has actual canvas ink and one accessible action',
    report.selection.painted > 0 &&
      report.selection.ink > 500 &&
      report.selection.selectedActions === 1,
    report.selection,
  );
  report.reorder = await page.evaluate(async (id) => {
    const m = window.__godsEyeView.dataManager.layers.get(id).module,
      before = m.getSelectedInfo();
    let selections = 0;
    const listener = () => selections++;
    window.addEventListener('gev:entity-selected', listener);
    try {
      window.__firmsQa.reverse = true;
      await m.update();
      const after = m.getSelectedInfo();
      window.__firmsQa.reverse = false;
      await m.update();
      return {
        before,
        after,
        selections,
        contextId: window.__gevContextStore?.selectedEntityId,
      };
    } finally {
      window.removeEventListener('gev:entity-selected', listener);
    }
  }, layer);
  check(
    'source reordering preserves selected identity without another selection event',
    Boolean(report.reorder.before?.id) &&
      report.reorder.after?.id === report.reorder.before.id &&
      report.reorder.contextId === report.reorder.before.id &&
      report.reorder.selections === 0,
    report.reorder,
  );
  report.source = await page.evaluate(async (id) => {
    const a = window.__godsEyeView,
      m = a.dataManager.layers.get(id).module,
      qa = window.__firmsQa;
    const original = JSON.stringify(m.getAnalystRecords(1000));
    qa.next = 'error';
    await m.update();
    const failed = {
      stats: m.getStats(),
      retained: JSON.stringify(m.getAnalystRecords(1000)) === original,
    };
    qa.next = 'no_key';
    await m.update();
    const keyless = m.getStats();
    qa.next = 'stale';
    await m.update();
    const stale = m.getStats();
    await m.update();
    const recovered = m.getStats();
    qa.next = 'delay';
    const pending = m.update();
    await a.layers.disable(id);
    await a.layers.enable(id);
    qa.release();
    await pending;
    return {
      failed,
      keyless,
      stale,
      recovered,
      afterLate: m.getStats(),
      count: m.getAnalystRecords(1000).length,
    };
  }, layer);
  check(
    'failed refresh retains last-good data and reports failure',
    report.source.failed.retained &&
      report.source.failed.stats.error === 'live feed unavailable',
    report.source.failed,
  );
  check(
    'keyless state is distinct from feed failure',
    report.source.keyless.keyRequired === true &&
      report.source.keyless.error === 'KEY REQUIRED',
    report.source.keyless,
  );
  check(
    'stale receipt clock and recovery are truthful',
    report.source.stale.stale === true &&
      report.source.stale.lastUpdate === fixture.fetchedAt &&
      !report.source.recovered.error &&
      !report.source.recovered.keyRequired,
    report.source.stale,
  );
  check(
    'late cancelled empty response cannot replace re-enabled data',
    report.source.count === FIRMS_VALID_COUNT &&
      !report.source.afterLate.loading,
    report.source.afterLate,
  );
  await sleep(3500);
  report.hudSummaryFixture = true;
  report.enabledIdleReady = await page.evaluate(async () => {
    const e = window.__godsEyeView.engine,
      start = performance.now();
    let lastFrame = start,
      lastSummary = start,
      previousSummary = document.getElementById('hud-summary')?.textContent;
    const stop = e.frames.postRender.addEventListener(() => {
      lastFrame = performance.now();
    });
    try {
      while (performance.now() - start < 90000) {
        const text = document.getElementById('hud-summary')?.textContent;
        if (text !== previousSummary) {
          previousSummary = text;
          lastSummary = performance.now();
        }
        if (
          e.surface.tilesLoaded() &&
          !e.camera.flightActive() &&
          performance.now() - lastFrame >= 1500 &&
          performance.now() - lastSummary >= 1500
        )
          return {
            ready: true,
            elapsedMs: performance.now() - start,
            hudRequests: window.__firmsQa.hudRequests ?? 0,
          };
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return {
        ready: false,
        elapsedMs: performance.now() - start,
        hudRequests: window.__firmsQa.hudRequests ?? 0,
      };
    } finally {
      stop();
    }
  });
  check(
    'enabled camera, tiles and summary animation settle before idle sample',
    report.enabledIdleReady.ready,
    report.enabledIdleReady,
  );
  report.enabledIdle = await page.evaluate(async () => {
    const app = window.__godsEyeView;
    const detection = await import('/src/data/detection.js');
    const target = app.viewer?.scene ?? app.engine.render;
    const method = app.viewer ? 'requestRender' : 'request';
    const original = target[method];
    const requests = [];
    target[method] = function (...args) {
      if (requests.length < 40)
        requests.push(
          new Error('FIRMS idle request').stack.replace(
            /https?:\/\/[^\s)]+/g,
            (url) => new URL(url).pathname,
          ),
        );
      return original.apply(this, args);
    };
    let frames = 0;
    const before = app.getRenderGovernorDiagnostics();
    window.__firmsQa.captureIdleDom = true;
    window.__firmsQa.mutations = [];
    window.__firmsQa.resizes = [];
    const stop = app.engine.frames.postRender.addEventListener(() => frames++);
    try {
      await new Promise((r) => setTimeout(r, 2000));
      return {
        frames,
        detectionMode: detection.getMode(),
        before,
        after: app.getRenderGovernorDiagnostics(),
        requests,
        overlay: window.__gevWorldOverlay?.getDiagnostics(),
        mutations: window.__firmsQa.mutations,
        resizes: window.__firmsQa.resizes,
      };
    } finally {
      stop();
      target[method] = original;
      window.__firmsQa.captureIdleDom = false;
    }
  });
  report.enabledIdleFrames = report.enabledIdle.frames;
  check(
    'enabled static scene zero frames in two seconds',
    report.enabledIdleFrames === 0,
    report.enabledIdleFrames,
  );
  report.lifecycle = await page.evaluate(async (id) => {
    const a = window.__godsEyeView,
      m = a.dataManager.layers.get(id).module;
    const counts = () => ({
      native: a.viewer?.dataSources.length ?? 0,
      movers: a.engine.movers.list().length,
      lines: a.engine.lines.list().length,
    });
    const before = counts();
    for (let i = 0; i < 10; i++) {
      await a.layers.disable(id);
      await a.layers.enable(id);
    }
    const after = counts();
    await a.layers.disable(id);
    return { before, after, disabledRecords: m.getAnalystRecords().length };
  }, layer);
  check(
    'ten toggles preserve resource counts and clear disabled records',
    JSON.stringify(report.lifecycle.before) ===
      JSON.stringify(report.lifecycle.after) &&
      report.lifecycle.disabledRecords === 0,
    report.lifecycle,
  );
  await sleep(3500);
  report.disabledIdleFrames = await page.evaluate(async () => {
    let frames = 0;
    const stop = window.__godsEyeView.engine.frames.postRender.addEventListener(
      () => frames++,
    );
    await new Promise((r) => setTimeout(r, 2000));
    stop();
    return frames;
  });
  check(
    'disabled static scene zero frames in two seconds',
    report.disabledIdleFrames === 0,
    report.disabledIdleFrames,
  );
} catch (error) {
  check('scenario completes', false, redact(error.stack ?? error.message));
} finally {
  await browser.close();
}
check(
  'observed pages have no runtime errors',
  report.browserErrors.length === 0,
  report.browserErrors,
);
report.pass = report.checks.length > 0 && report.checks.every((c) => c.pass);
await fs.writeFile(out, JSON.stringify(report, null, 2) + '\n');
console.log(
  `RESULT ${report.checks.filter((c) => c.pass).length}/${report.checks.length}`,
);
process.exitCode = report.pass ? 0 : 1;
