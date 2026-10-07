#!/usr/bin/env node
/**
 * Traffic-warm OpenFreeMap outline acceptance.
 *
 * Each sample opens a fresh application page, loads the Texas Capitol z14 tile
 * through Street Traffic, then circles a building from that same tile. It
 * records application fetches separately from browser transfer bytes,
 * body-read/decode/extraction/install measures, and Long Tasks. A second ask
 * on the page proves the outline source's own consumer-cache path. A separate
 * page holds traffic's target response while the outline consumer subscribes,
 * proving that overlap still produces one application fetch and one decode.
 *
 * Acceptance is declared before measurement: cold outline decode, extraction,
 * and install must fit one 60 Hz frame at p95 (16.7 ms), no sample may create a
 * >=50 ms Long Task, and neither the first nor second outline ask may fetch or
 * decode the traffic-warm tile again. The target tile's traffic-idle outline
 * projection must also fit one frame; unrelated traffic activation Long Tasks
 * are reported separately as baseline evidence.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import puppeteer from 'puppeteer';

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (args.includes('--help') || args.includes('-h')) {
  console.log(
    'Usage: node scripts/qa-openfreemap-same-tile.mjs [--url http://localhost:4173] [--runs 5] [--headful] [--out qa-shots/openfreemap-same-tile.json]',
  );
  process.exit(0);
}

const APP_URL = valueAfter('--url', 'http://localhost:4173');
const RUNS = Number(valueAfter('--runs', '5'));
const OUTPUT = path.resolve(
  valueAfter('--out', 'qa-shots/openfreemap-same-tile.json'),
);
const FRAME_BUDGET_MS = 16.7;
const LONG_TASK_MS = 50;
const TARGET = Object.freeze({
  latitude: 30.27472,
  longitude: -97.74035,
  z: 14,
  x: 3743,
  y: 6745,
});
const TARGET_PATH = `/${TARGET.z}/${TARGET.x}/${TARGET.y}.pbf`;

if (!Number.isInteger(RUNS) || RUNS < 3 || RUNS > 20)
  throw new Error('--runs must be an integer from 3 through 20');
const targetUrl = new URL(APP_URL);
if (!['http:', 'https:'].includes(targetUrl.protocol))
  throw new Error('--url must be HTTP(S)');

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  return sorted[Math.ceil(p * sorted.length) - 1];
};
const round = (value) =>
  value == null ? null : Number(Number(value).toFixed(3));
const measures = (entries, name) =>
  entries.filter((entry) => entry.name === name).map((entry) => entry.ms);
const sum = (values) => values.reduce((total, value) => total + value, 0);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await fs.mkdir(path.dirname(OUTPUT), { recursive: true });

const browser = await puppeteer.launch({
  headless: args.includes('--headful') ? false : 'new',
  protocolTimeout: 240_000,
  ...(process.env.PUPPETEER_EXECUTABLE_PATH
    ? { executablePath: process.env.PUPPETEER_EXECUTABLE_PATH }
    : {}),
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-gl=angle',
    ...(args.includes('--headful')
      ? []
      : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--disable-dev-shm-usage',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--window-size=1440,1000',
  ],
});

const report = {
  appUrl: APP_URL,
  target: TARGET,
  targetPath: TARGET_PATH,
  acceptance: {
    coldCpuP95Ms: FRAME_BUDGET_MS,
    maxLongTaskMs: LONG_TASK_MS,
    trafficIdleProjectionMaxMs: FRAME_BUDGET_MS,
    coldApplicationFetches: 0,
    coldOutlineTransferBytes: 0,
    coldDecodes: 0,
    warmApplicationFetches: 0,
    warmDecodes: 0,
    overlapApplicationFetches: 1,
    overlapDecodes: 1,
  },
  renderer: null,
  samples: [],
  errors: [],
};

function relevantMeasures(raw) {
  return raw
    .filter(
      (entry) =>
        entry.name.startsWith('roads:') || entry.name.startsWith('outlines:'),
    )
    .map((entry) => ({
      name: entry.name,
      ms: round(entry.duration),
      at: round(entry.startTime),
      detail: entry.detail || {},
    }));
}

async function beginOutline(page, label) {
  await page.evaluate(
    ({ label, target }) => {
      performance.clearMeasures();
      window.__qaOutlineLongTasks.length = 0;
      window.__qaOutlineStarted = performance.now();
      window.__qaOutlinePromise = Promise.resolve(
        window.__gevVoiceCommands.runner('annotate_map', {
          annotations: [
            {
              type: 'area',
              target: 'this building',
              label,
              entityKind: 'building',
              latitude: target.latitude,
              longitude: target.longitude,
            },
          ],
        }),
      );
    },
    { label, target: TARGET },
  );
}

async function settleOutline(page, label) {
  return page.evaluate(async (label) => {
      const result = await window.__qaOutlinePromise;
      let annotation = null;
      const deadline = performance.now() + 30_000;
      while (performance.now() < deadline) {
        annotation = (window.__gevAnnotations?.list?.() || []).find(
          (item) => item.label === label,
        );
        if (annotation && !annotation.pendingOutline) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (!annotation || annotation.pendingOutline)
        throw new Error(`${label}: outline did not settle`);
      const { scene } = window.__godsEyeView.viewer;
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 1500);
        const remove = scene.postRender.addEventListener(() => {
          clearTimeout(timer);
          remove();
          resolve();
        });
        scene.requestRender();
      });
      await new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      );
      return {
        commandToRenderMs: performance.now() - window.__qaOutlineStarted,
        result,
        annotation: {
          pending: Boolean(annotation.pendingOutline),
          unavailable: Boolean(annotation.outlineUnavailable),
          synthesized: Boolean(annotation.synthesized),
          footprintKind: annotation.footprintKind || null,
          ringPoints: annotation.ring?.length || 0,
          parts: annotation.polygons?.length || (annotation.ring ? 1 : 0),
        },
        measures: performance.getEntriesByType('measure').map((entry) => ({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime,
          detail: entry.detail,
        })),
        longTasks: window.__qaOutlineLongTasks.slice(),
      };
    }, label);
}

async function driveOutline(page, label) {
  await beginOutline(page, label);
  return settleOutline(page, label);
}

try {
  for (let run = 0; run <= RUNS; run += 1) {
    const page = await browser.newPage();
    await page.setViewport({ width: 1440, height: 1000 });
    let overlapMode = false;
    let overlapApplicationRequests = 0;
    let heldTargetRequest = null;
    let resolveHeldTarget;
    const heldTarget = new Promise((resolve) => {
      resolveHeldTarget = resolve;
    });
    if (run === 0) {
      await page.setRequestInterception(true);
      page.on('request', (request) => {
        let isTarget = false;
        try {
          isTarget = new URL(request.url()).pathname.endsWith(TARGET_PATH);
        } catch {
          // Invalid URLs are passed through for the browser to handle.
        }
        if (overlapMode && isTarget) {
          overlapApplicationRequests += 1;
          if (!heldTargetRequest) {
            heldTargetRequest = request;
            resolveHeldTarget();
            return;
          }
        }
        void request.continue();
      });
    }
    await page.evaluateOnNewDocument(() => {
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed');
      window.__qaOutlineLongTasks = [];
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries())
            window.__qaOutlineLongTasks.push({
              at: entry.startTime,
              ms: entry.duration,
            });
        }).observe({ type: 'longtask', buffered: false });
        window.__qaLongTaskSupported = true;
      } catch {
        window.__qaLongTaskSupported = false;
      }
    });

    let phase = 'startup';
    const network = [];
    const pending = new Map();
    const client = await page.createCDPSession();
    await client.send('Network.enable');
    client.on('Network.requestWillBeSent', (event) => {
      let url;
      try {
        url = new URL(event.request.url);
      } catch {
        return;
      }
      if (
        url.hostname !== 'tiles.openfreemap.org' ||
        !url.pathname.endsWith('.pbf')
      )
        return;
      const entry = {
        requestId: event.requestId,
        phase,
        url: url.origin + url.pathname,
        targetTile: url.pathname.endsWith(TARGET_PATH),
        cached: false,
        transferBytes: 0,
        responseBytes: 0,
        finished: false,
      };
      pending.set(event.requestId, entry);
      network.push(entry);
    });
    client.on('Network.requestServedFromCache', ({ requestId }) => {
      const entry = pending.get(requestId);
      if (entry) entry.cached = true;
    });
    client.on('Network.responseReceived', ({ requestId, response }) => {
      const entry = pending.get(requestId);
      if (!entry) return;
      entry.status = response.status;
      entry.cached ||= Boolean(
        response.fromDiskCache ||
        response.fromServiceWorker ||
        response.fromPrefetchCache,
      );
    });
    client.on('Network.dataReceived', ({ requestId, dataLength }) => {
      const entry = pending.get(requestId);
      if (entry) entry.responseBytes += dataLength;
    });
    client.on('Network.loadingFinished', ({ requestId, encodedDataLength }) => {
      const entry = pending.get(requestId);
      if (!entry) return;
      entry.transferBytes = entry.cached ? 0 : encodedDataLength;
      entry.finished = true;
      pending.delete(requestId);
    });
    client.on('Network.loadingFailed', ({ requestId, errorText }) => {
      const entry = pending.get(requestId);
      if (!entry) return;
      entry.failure = errorText;
      entry.finished = true;
      pending.delete(requestId);
    });

    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error.message)));
    const navigation = new URL(APP_URL);
    navigation.searchParams.set('welcome', '0');
    navigation.searchParams.set('trafficDebug', '1');
    navigation.searchParams.set('trafficRoads', 'osm');
    await page.goto(navigation.href, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.viewer &&
        window.__godsEyeView?.dataManager &&
        window.__gevVoiceCommands?.runner &&
        window.__gevAnnotations &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 120_000, polling: 250 },
    );
    await page.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
    await page.evaluate(() =>
      window.__godsEyeView.styleManager.setDetection({ enabled: false }),
    );
    await page.evaluate(async (target) => {
      const { viewer, dataManager } = window.__godsEyeView;
      await dataManager.setEnabled('traffic', false);
      viewer.camera.cancelFlight();
      viewer.camera.setView({
        destination: window.__CESIUM__.Cartesian3.fromDegrees(
          target.longitude,
          target.latitude,
          700,
        ),
        orientation: {
          heading: 0,
          pitch: (-65 * Math.PI) / 180,
          roll: 0,
        },
      });
      viewer.camera.moveEnd.raiseEvent();
      window.__gevAnnotations.clear();
      performance.clearMeasures();
    }, TARGET);
    await sleep(750);

    if (run === 0) {
      phase = 'overlap';
      overlapMode = true;
      await page.evaluate(() => {
        window.__qaOutlineLongTasks.length = 0;
        performance.clearMeasures();
      });
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('traffic', true),
      );
      await Promise.race([
        heldTarget,
        sleep(30_000).then(() => {
          throw new Error('overlap phase did not intercept the target tile');
        }),
      ]);
      await beginOutline(page, 'QA Capitol overlap');
      await sleep(100);
      await heldTargetRequest.continue();
      const overlap = await settleOutline(page, 'QA Capitol overlap');
      await sleep(750);
      const trafficStats = await page.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('traffic')
          .module.getStats(),
      );
      assert.equal(trafficStats.error, null, 'overlap traffic source error');
      overlap.measures = relevantMeasures(overlap.measures);
      overlap.network = network.filter(
        (entry) => entry.phase === 'overlap' && entry.targetTile,
      );
      const overlapDecodes = overlap.measures
        .filter(
          (entry) =>
            entry.name === 'roads:decode' &&
            String(entry.detail?.key).endsWith(
              `:${TARGET.z}/${TARGET.x}/${TARGET.y}`,
            ),
        )
        .map((entry) => entry.ms);
      assert.equal(
        overlapApplicationRequests,
        1,
        'overlapping traffic and outline consumers issue one application request',
      );
      assert.equal(
        overlap.network.length,
        1,
        'overlapping traffic and outline consumers emit one target network request',
      );
      assert.equal(
        overlapDecodes.length,
        1,
        'overlapping traffic and outline consumers decode once',
      );
      assert.equal(overlap.annotation.unavailable, false);
      assert.equal(overlap.annotation.footprintKind, 'building');
      report.overlap = {
        applicationFetches: overlapApplicationRequests,
        targetNetworkRequests: overlap.network.length,
        transferBytes: sum(
          overlap.network.map((entry) => entry.transferBytes),
        ),
        decodes: overlapDecodes.length,
        decodeMs: round(sum(overlapDecodes)),
        longTasks: overlap.longTasks.length,
      };
      await page.close();
      continue;
    }

    phase = 'traffic';
    await page.evaluate(() => {
      window.__qaOutlineLongTasks.length = 0;
      performance.clearMeasures();
    });
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', true),
    );
    await page.waitForFunction(
      () => {
        const stats = window.__godsEyeView.dataManager.layers
          .get('traffic')
          .module.getStats();
        return stats.count > 0 && !stats.loading && !stats.error;
      },
      { timeout: 180_000, polling: 250 },
    );
    await sleep(1500);
    const trafficMeasures = relevantMeasures(
      await page.evaluate(() =>
        performance.getEntriesByType('measure').map((entry) => ({
          name: entry.name,
          duration: entry.duration,
          startTime: entry.startTime,
          detail: entry.detail,
        })),
      ),
    );
    const trafficLongTasks = await page.evaluate(() =>
      window.__qaOutlineLongTasks.slice(),
    );
    const trafficTarget = network.filter(
      (entry) => entry.phase === 'traffic' && entry.targetTile,
    );
    const targetTile = `${TARGET.z}/${TARGET.x}/${TARGET.y}`;
    const targetProjectionMeasures = trafficMeasures.filter(
      (entry) =>
        entry.detail?.tile === targetTile &&
        ['outlines:street-extract', 'outlines:polygon-extract'].includes(
          entry.name,
        ),
    );
    const targetProjectionMs = sum(
      targetProjectionMeasures.map((entry) => entry.ms),
    );
    assert.ok(
      trafficTarget.length >= 1,
      `sample ${run}: traffic did not load ${TARGET_PATH}`,
    );
    assert.equal(
      targetProjectionMeasures.length,
      2,
      `sample ${run}: traffic did not prepare the target outline projection`,
    );
    assert.ok(
      targetProjectionMs <= FRAME_BUDGET_MS,
      `sample ${run}: traffic-idle target projection ${targetProjectionMs} ms exceeds ${FRAME_BUDGET_MS} ms`,
    );

    phase = 'outline-cold';
    const cold = await driveOutline(page, `QA Capitol cold ${run}`);
    await sleep(750);
    cold.measures = relevantMeasures(cold.measures);
    cold.network = network.filter(
      (entry) => entry.phase === 'outline-cold' && entry.targetTile,
    );
    cold.longTasks = cold.longTasks.map((entry) => ({
      at: round(entry.at),
      ms: round(entry.ms),
    }));

    await page.evaluate(() => window.__gevAnnotations.clear());
    phase = 'outline-warm';
    const warm = await driveOutline(page, `QA Capitol warm ${run}`);
    await sleep(750);
    warm.measures = relevantMeasures(warm.measures);
    warm.network = network.filter(
      (entry) => entry.phase === 'outline-warm' && entry.targetTile,
    );
    warm.longTasks = warm.longTasks.map((entry) => ({
      at: round(entry.at),
      ms: round(entry.ms),
    }));

    const supported = await page.evaluate(() => window.__qaLongTaskSupported);
    assert.equal(supported, true, `sample ${run}: Long Tasks unsupported`);
    assert.deepEqual(pageErrors, [], `sample ${run}: browser errors`);
    assert.equal(cold.annotation.unavailable, false);
    assert.equal(cold.annotation.synthesized, false);
    assert.equal(cold.annotation.footprintKind, 'building');
    assert.ok(cold.annotation.ringPoints >= 4);
    assert.equal(warm.annotation.footprintKind, 'building');
    assert.ok(warm.annotation.ringPoints >= 4);

    const coldDecodes = measures(cold.measures, 'roads:decode');
    const coldInstalls = measures(cold.measures, 'outlines:install');
    const warmDecodes = measures(warm.measures, 'roads:decode');
    assert.equal(
      cold.network.length,
      0,
      'shared decoded tile performs no second application fetch',
    );
    assert.equal(sum(cold.network.map((entry) => entry.transferBytes)), 0);
    assert.equal(coldDecodes.length, 0, 'shared decoded tile is not parsed again');
    assert.equal(
      measures(cold.measures, 'outlines:street-extract').length,
      0,
      'traffic idle preparation owns street extraction',
    );
    assert.equal(
      measures(cold.measures, 'outlines:polygon-extract').length,
      0,
      'traffic idle preparation owns polygon extraction',
    );
    assert.ok(coldInstalls.length >= 1, 'cold outline installs geometry');
    assert.equal(warm.network.length, 0, 'decoded-cache hit performs no fetch');
    assert.equal(warmDecodes.length, 0, 'decoded-cache hit performs no decode');

    report.renderer ||= await page.evaluate(() => {
      const gl = window.__godsEyeView.viewer.scene.context._gl;
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      return debug
        ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)
        : gl.getParameter(gl.RENDERER);
    });
    if (args.includes('--headful')) {
      assert.doesNotMatch(
        String(report.renderer),
        /swiftshader|software rasterizer|llvmpipe/i,
        `sample ${run}: headful evidence requires a hardware renderer`,
      );
    }
    report.samples.push({
      run,
      pageErrors,
      traffic: {
        applicationFetches: trafficTarget.length,
        transferBytes: sum(trafficTarget.map((entry) => entry.transferBytes)),
        decodes: measures(trafficMeasures, 'roads:decode').length,
        targetProjectionMs: round(targetProjectionMs),
        longTasks: trafficLongTasks.map((entry) => ({
          at: round(entry.at),
          ms: round(entry.ms),
        })),
        measures: trafficMeasures,
        network: trafficTarget,
      },
      cold: {
        ...cold,
        applicationFetches: cold.network.length,
        transferBytes: sum(cold.network.map((entry) => entry.transferBytes)),
        decodeMs: round(sum(coldDecodes)),
        bodyReadMs: round(sum(measures(cold.measures, 'roads:tile-body-read'))),
        streetExtractMs: round(
          sum(measures(cold.measures, 'outlines:street-extract')),
        ),
        polygonExtractMs: round(
          sum(measures(cold.measures, 'outlines:polygon-extract')),
        ),
        installMs: round(sum(coldInstalls)),
        mainThreadCpuMs: round(
          sum(coldDecodes) +
            sum(measures(cold.measures, 'outlines:street-extract')) +
            sum(measures(cold.measures, 'outlines:polygon-extract')) +
            sum(coldInstalls),
        ),
      },
      warm: {
        ...warm,
        applicationFetches: warm.network.length,
        transferBytes: sum(warm.network.map((entry) => entry.transferBytes)),
        decodeMs: round(sum(warmDecodes)),
        installMs: round(sum(measures(warm.measures, 'outlines:install'))),
      },
    });
    await page.close();
  }

  const coldCpu = report.samples.map((sample) => sample.cold.mainThreadCpuMs);
  const outlineLongTasks = report.samples.flatMap((sample) => [
    ...sample.cold.longTasks,
    ...sample.warm.longTasks,
  ]);
  const trafficLongTasks = report.samples.flatMap(
    (sample) => sample.traffic.longTasks,
  );
  report.summary = {
    samples: report.samples.length,
    overlapApplicationFetches: report.overlap?.applicationFetches ?? null,
    overlapDecodes: report.overlap?.decodes ?? null,
    coldCpuP50Ms: round(percentile(coldCpu, 0.5)),
    coldCpuP95Ms: round(percentile(coldCpu, 0.95)),
    coldCpuMaxMs: round(Math.max(...coldCpu)),
    coldCommandToRenderP95Ms: round(
      percentile(
        report.samples.map((sample) => sample.cold.commandToRenderMs),
        0.95,
      ),
    ),
    coldApplicationFetches: sum(
      report.samples.map((sample) => sample.cold.applicationFetches),
    ),
    coldTransferBytes: sum(
      report.samples.map((sample) => sample.cold.transferBytes),
    ),
    coldDecodes: sum(
      report.samples.map(
        (sample) => measures(sample.cold.measures, 'roads:decode').length,
      ),
    ),
    warmApplicationFetches: sum(
      report.samples.map((sample) => sample.warm.applicationFetches),
    ),
    warmDecodes: sum(
      report.samples.map(
        (sample) => measures(sample.warm.measures, 'roads:decode').length,
      ),
    ),
    trafficIdleProjectionMaxMs: round(
      Math.max(
        ...report.samples.map((sample) => sample.traffic.targetProjectionMs),
      ),
    ),
    trafficBaselineLongTasks: trafficLongTasks.length,
    trafficBaselineMaxLongTaskMs: round(
      trafficLongTasks.length
        ? Math.max(...trafficLongTasks.map((entry) => entry.ms))
        : 0,
    ),
    longTasks: outlineLongTasks.length,
    maxLongTaskMs: round(
      outlineLongTasks.length
        ? Math.max(...outlineLongTasks.map((entry) => entry.ms))
        : 0,
    ),
  };
  assert.ok(
    report.summary.coldCpuP95Ms <= FRAME_BUDGET_MS,
    `cold decode+extract+install p95 ${report.summary.coldCpuP95Ms} ms exceeds ${FRAME_BUDGET_MS} ms`,
  );
  assert.ok(
    report.summary.trafficIdleProjectionMaxMs <= FRAME_BUDGET_MS,
    'traffic-idle outline projection exceeded one frame',
  );
  assert.equal(report.summary.longTasks, 0, 'outline ask created a Long Task');
  assert.equal(report.summary.coldTransferBytes, 0);
  assert.equal(report.summary.coldApplicationFetches, 0);
  assert.equal(report.summary.coldDecodes, 0);
  assert.equal(report.summary.warmApplicationFetches, 0);
  assert.equal(report.summary.warmDecodes, 0);
  assert.equal(report.summary.overlapApplicationFetches, 1);
  assert.equal(report.summary.overlapDecodes, 1);
  report.passed = true;
  console.table(
    report.samples.map((sample) => ({
      run: sample.run,
      trafficPrepMs: sample.traffic.targetProjectionMs,
      appFetches: sample.cold.applicationFetches,
      transferBytes: sample.cold.transferBytes,
      bodyReadMs: sample.cold.bodyReadMs,
      decodeMs: sample.cold.decodeMs,
      streetMs: sample.cold.streetExtractMs,
      polygonMs: sample.cold.polygonExtractMs,
      installMs: sample.cold.installMs,
      cpuMs: sample.cold.mainThreadCpuMs,
      renderMs: round(sample.cold.commandToRenderMs),
      longTasks: sample.cold.longTasks.length,
    })),
  );
  console.log('OpenFreeMap same-tile acceptance passed:', report.summary);
} catch (error) {
  report.passed = false;
  report.failure = String(error?.stack || error);
  console.error(error);
  process.exitCode = 1;
} finally {
  await fs.writeFile(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
  await browser.close();
}
