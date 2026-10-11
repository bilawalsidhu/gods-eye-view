/** REAL feeds/imagery, normal layer cadence and natural rendering. CPU is not watts. */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const profileCpu = process.argv.includes('--profile');
const tag =
  process.argv.find((arg) => arg.startsWith('--tag='))?.slice(6) || '';
if (tag && !/^[a-z0-9-]+$/.test(tag)) throw new Error('Invalid artifact tag');
const artifactName = `live-cpu${tag ? '-' + tag : ''}`;
const output = new URL('../output/playwright/', import.meta.url);
fs.mkdirSync(output, { recursive: true });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const cpuSnapshot = () => {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,time=,comm='], {
    encoding: 'utf8',
  });
  return new Map(
    rows.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.+)$/);
      if (!match) return [];
      const [, pid, parent, time, name] = match;
      return [
        [
          Number(pid),
          {
            parent: Number(parent),
            seconds: time
              .split(':')
              .reduce((total, part) => total * 60 + Number(part), 0),
            name: name.split('/').at(-1),
          },
        ],
      ];
    }),
  );
};
const descendants = (snapshot, root) => {
  const ids = new Set([root]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, row] of snapshot) {
      if (!ids.has(pid) && ids.has(row.parent)) {
        ids.add(pid);
        changed = true;
      }
    }
  }
  return ids;
};
const port = new URL(origin).port || '80';
const serverPid = Number(
  execFileSync(
    '/usr/sbin/lsof',
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
    { encoding: 'utf8' },
  ).trim(),
);
if (!Number.isInteger(serverPid) || serverPid <= 0)
  throw new Error('Expected one local server listening PID');

const browser = await puppeteer.launch({
  headless: false,
  args: [
    '--no-sandbox',
    '--window-size=1280,880',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : []),
  ],
});
const measurements = [];
const feedEvidence = [];
const previousFeed = new Map();
const pendingResponses = new Set();
try {
  const systemSession = await browser.target().createCDPSession();
  const { gpu } = await systemSession.send('SystemInfo.getInfo');
  const gpuRenderer = gpu.auxAttributes?.glRenderer || '';
  await systemSession.detach();
  if (!gpuRenderer || /swiftshader|llvmpipe|software/i.test(gpuRenderer))
    throw new Error(
      `Hardware GPU renderer required: ${gpuRenderer || 'unavailable'}`,
    );
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 });
  await page.evaluateOnNewDocument(() => {
    localStorage.setItem('gev:first-run-mission:v1', 'suppressed');
    localStorage.setItem('gev-power-profile-v1', 'battery');
  });
  // Observe production responses; do not intercept, mock, inject or accelerate polling.
  page.on('response', (response) => {
    const path = new URL(response.url()).pathname;
    if (!['/api/flights', '/api/vessels'].includes(path)) return;
    const task = (async () => {
      const receivedAt = Date.now();
      const payload = await response.json();
      const isFlight = path === '/api/flights';
      const rows = isFlight ? payload.states || [] : payload.rows || [];
      const positions = new Map(
        rows.map((row) =>
          isFlight
            ? [row[0], { lat: row[6], lon: row[5], report: row[3] }]
            : [
                String(row.mmsi),
                {
                  lat: row.lat,
                  lon: row.lon,
                  report: row.last_position_epoch ?? row.last_position_UTC,
                },
              ],
        ),
      );
      let common = 0,
        changedPositions = 0,
        changedReports = 0;
      const previous = previousFeed.get(path);
      if (previous) {
        for (const [id, position] of positions) {
          const prior = previous.get(id);
          if (!prior) continue;
          common++;
          if (position.lat !== prior.lat || position.lon !== prior.lon)
            changedPositions++;
          if (position.report !== prior.report) changedReports++;
        }
      }
      previousFeed.set(path, positions);
      const headers = response.headers();
      feedEvidence.push({
        receivedAt,
        path,
        httpStatus: response.status(),
        rows: rows.length,
        source: headers['x-flight-source'] || headers['x-feed-source'] || null,
        coverage: headers['x-flight-coverage'] || null,
        snapshotAt: isFlight ? payload.time * 1000 : null,
        snapshotAgeMs: isFlight ? receivedAt - payload.time * 1000 : null,
        transportStatus: payload.status || null,
        lastMessageAgeMs:
          !isFlight && payload.lastMessageAt
            ? receivedAt - Number(payload.lastMessageAt)
            : null,
        comparedWithPrevious: Boolean(previous),
        common,
        changedPositions,
        changedReports,
      });
    })();
    pendingResponses.add(task);
    task.finally(() => pendingResponses.delete(task)).catch(() => {});
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded', timeout: 60_000 });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 90_000,
  });
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.viewer.camera.cancelFlight();
    app.viewer.scene.tweens.removeAll();
    app.powerSavings.setProfile('battery');
    app.viewer.camera.setView({
      destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (12.25 * Math.PI) / 180,
        latitude: (42.4 * Math.PI) / 180,
        height: 1_050_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    await app.dataManager.setEnabled('flights', true);
    await app.dataManager.setEnabled('ais-live-vessels', true);
    window.__qaLiveFrames = 0;
    app.viewer.scene.postRender.addEventListener(() => window.__qaLiveFrames++);
  });
  await page.waitForFunction(
    () => {
      const manager = window.__godsEyeView.dataManager;
      return ['flights', 'ais-live-vessels'].every((id) => {
        const entry = manager.layers.get(id);
        const stats = entry?.module.getStats();
        return (
          entry?.enabled && stats?.count > 0 && !stats.error && !stats.stale
        );
      });
    },
    { timeout: 120_000 },
  );
  console.log('REAL live layers loaded; warming scene for 30 seconds.');
  await delay(30_000);
  // A delayed startup flight can begin after first restore on a fresh profile.
  await page.evaluate(() => {
    const app = window.__godsEyeView;
    app.viewer.camera.cancelFlight();
    app.viewer.scene.tweens.removeAll();
    app.viewer.camera.setView({
      destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: (12.25 * Math.PI) / 180,
        latitude: (42.4 * Math.PI) / 180,
        height: 1_050_000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
  });
  await delay(5_000);
  const profiler = profileCpu ? await page.createCDPSession() : null;
  if (profiler) {
    await profiler.send('Profiler.enable');
    await profiler.send('Profiler.setSamplingInterval', { interval: 1000 });
    await profiler.send('Profiler.start');
  }
  const sceneEvidence = () =>
    page.evaluate(() => {
      const app = window.__godsEyeView;
      const rectangle = app.viewer.camera.computeViewRectangle();
      const layers = ['flights', 'ais-live-vessels'].map((id) => {
        const entry = app.dataManager.layers.get(id);
        const stats = entry.module.getStats();
        const records = entry.module.getAnalystRecords(50_000);
        const inView = records.filter((row) => {
          if (!rectangle) return false;
          const lat = (row.lat * Math.PI) / 180,
            lon = (row.lon * Math.PI) / 180;
          return (
            lat >= rectangle.south &&
            lat <= rectangle.north &&
            (rectangle.west <= rectangle.east
              ? lon >= rectangle.west && lon <= rectangle.east
              : lon >= rectangle.west || lon <= rectangle.east)
          );
        });
        return {
          id,
          enabled: entry.enabled,
          stats,
          withinGeographicViewport: inView.length,
          rawPositions: inView.map((row) => [
            row.icao24 || row.mmsi,
            row.lat,
            row.lon,
          ]),
        };
      });
      const spriteCollections = [];
      const primitives = app.viewer.scene.primitives;
      for (let i = 0; i < primitives.length; i++) {
        const primitive = primitives.get(i);
        if (
          primitive.constructor.name !== 'BillboardCollection' ||
          !primitive.length
        )
          continue;
        const firstId = primitive.get(0).id;
        spriteCollections.push({
          layer:
            typeof firstId === 'string'
              ? 'flights'
              : firstId?.mmsi
                ? 'vessels'
                : 'other',
          count: primitive.length,
          blendOption: primitive.blendOption,
          renderCommands: app.viewer.scene._frameState.commandList.filter(
            (command) => command.owner === primitive,
          ).length,
        });
      }
      return {
        at: Date.now(),
        frames: window.__qaLiveFrames,
        profile: app.powerSavings.getState(),
        governor: app.getRenderGovernorDiagnostics(),
        visibility: document.visibilityState,
        camera: {
          latitude:
            (app.viewer.camera.positionCartographic.latitude * 180) / Math.PI,
          longitude:
            (app.viewer.camera.positionCartographic.longitude * 180) / Math.PI,
          heightM: app.viewer.camera.positionCartographic.height,
          pitch: app.viewer.camera.pitch,
        },
        rectangle: rectangle
          ? {
              south: rectangle.south,
              north: rectangle.north,
              west: rectangle.west,
              east: rectangle.east,
            }
          : null,
        canvas: {
          width: app.viewer.canvas.width,
          height: app.viewer.canvas.height,
        },
        cssViewport: {
          width: innerWidth,
          height: innerHeight,
          dpr: devicePixelRatio,
        },
        layerStats: layers,
        spriteCollections,
      };
    });
  for (let sample = 1; sample <= 3; sample++) {
    const startScene = await sceneEvidence();
    if (
      startScene.layerStats.some(
        (layer) => layer.withinGeographicViewport === 0,
      )
    ) {
      console.log(
        JSON.stringify({
          camera: startScene.camera,
          rectangle: startScene.rectangle,
          layers: startScene.layerStats.map(
            ({ rawPositions, ...layer }) => layer,
          ),
        }),
      );
      throw new Error(
        'Both live layers must contain contacts in the measured viewport',
      );
    }
    const before = cpuSnapshot();
    const startedAt = Date.now();
    console.log(
      `Sample ${sample}/3 started: Battery saver, ships and aircraft live.`,
    );
    await delay(30_000);
    const after = cpuSnapshot();
    const endedAt = Date.now();
    if (profiler && sample === 1) {
      const { profile } = await profiler.send('Profiler.stop');
      fs.writeFileSync(
        new URL(`${artifactName}.cpuprofile`, output),
        JSON.stringify(profile),
      );
      await profiler.detach();
    }
    const elapsedMs = endedAt - startedAt;
    const endScene = await sceneEvidence();
    const ids = new Set([
      ...descendants(before, browser.process().pid),
      ...descendants(after, browser.process().pid),
    ]);
    for (const pid of descendants(before, browser.process().pid))
      if (!after.has(pid))
        throw new Error(`Browser process ${pid} exited during measurement`);
    if (!before.has(serverPid) || !after.has(serverPid))
      throw new Error('Server exited during measurement');
    const processCpu = [...ids].map((pid) => ({
      pid,
      name: after.get(pid).name,
      cpuPercent:
        (100_000 *
          Math.max(
            0,
            after.get(pid).seconds - (before.get(pid)?.seconds || 0),
          )) /
        elapsedMs,
    }));
    const updatesInView = endScene.layerStats.map((layer) => {
      const previous = new Map(
        startScene.layerStats
          .find((row) => row.id === layer.id)
          .rawPositions.map(([id, lat, lon]) => [id, [lat, lon]]),
      );
      let common = 0,
        changedRawPositions = 0;
      for (const [id, lat, lon] of layer.rawPositions) {
        if (!previous.has(id)) continue;
        common++;
        const [oldLat, oldLon] = previous.get(id);
        if (oldLat !== lat || oldLon !== lon) changedRawPositions++;
      }
      return { id: layer.id, common, changedRawPositions };
    });
    for (const scene of [startScene, endScene]) {
      for (const layer of scene.layerStats) delete layer.rawPositions;
      if (
        scene.visibility !== 'visible' ||
        scene.profile.profile !== 'battery' ||
        scene.layerStats.some(
          (layer) => !layer.enabled || layer.stats.error || layer.stats.stale,
        )
      )
        throw new Error('Live measurement state changed or a feed degraded');
    }
    const observation = {
      sample,
      startedAt,
      endedAt,
      elapsedMs,
      browserCpuPercent: processCpu.reduce(
        (sum, row) => sum + row.cpuPercent,
        0,
      ),
      serverCpuPercent:
        (100_000 *
          (after.get(serverPid).seconds - before.get(serverPid).seconds)) /
        elapsedMs,
      measuredFps: ((endScene.frames - startScene.frames) * 1000) / elapsedMs,
      processCpu,
      startScene,
      endScene,
      updatesInView,
    };
    measurements.push(observation);
    console.log(
      JSON.stringify({
        sample,
        browserCpuPercent: observation.browserCpuPercent,
        serverCpuPercent: observation.serverCpuPercent,
        measuredFps: observation.measuredFps,
        updatesInView,
      }),
    );
  }
  await Promise.all([...pendingResponses]);
  const measuredStart = measurements[0].startedAt;
  const measuredEnd = measurements.at(-1).endedAt;
  for (const path of ['/api/flights', '/api/vessels']) {
    if (
      !feedEvidence.some(
        (row) =>
          row.path === path &&
          row.receivedAt >= measuredStart &&
          row.receivedAt <= measuredEnd &&
          row.httpStatus === 200 &&
          row.changedPositions > 0,
      )
    )
      throw new Error(
        `No actual source position updates received during measurement: ${path}`,
      );
  }
  const totalMs = measurements.reduce((sum, row) => sum + row.elapsedMs, 0);
  const mean = (field) =>
    measurements.reduce((sum, row) => sum + row[field] * row.elapsedMs, 0) /
    totalMs;
  const summary = {
    browserCpuPercent: mean('browserCpuPercent'),
    serverCpuPercent: mean('serverCpuPercent'),
    combinedCpuPercent: mean('browserCpuPercent') + mean('serverCpuPercent'),
    measuredFps: mean('measuredFps'),
    browserRange: measurements.map((row) => row.browserCpuPercent),
    serverRange: measurements.map((row) => row.serverCpuPercent),
  };
  const report = {
    provenance:
      'REAL live application feeds and imagery; no injected positions, no forced render holds',
    createdAt: new Date().toISOString(),
    platform: os.platform(),
    cpuModel: os.cpus()[0].model,
    logicalCpus: os.cpus().length,
    nodeVersion: process.version,
    browserVersion: await browser.version(),
    gpuRenderer,
    headless: false,
    profiledFirstSample: profileCpu,
    cpuUnits: '100% equals one fully occupied logical CPU',
    camera: {
      latitude: 42.4,
      longitude: 12.25,
      heightM: 1_050_000,
      pitchDeg: -90,
    },
    pollingIntervalsMs: { flights: 30_000, vessels: 60_000 },
    serverPid,
    measurements,
    feedEvidence,
    summary,
  };
  fs.writeFileSync(
    new URL(`${artifactName}.json`, output),
    JSON.stringify(report, null, 2) + '\n',
  );
  console.log(JSON.stringify(summary, null, 2));
  await page.screenshot({
    path: fileURLToPath(new URL(`${artifactName}-benchmark.png`, output)),
  });
} finally {
  await browser.close();
}
