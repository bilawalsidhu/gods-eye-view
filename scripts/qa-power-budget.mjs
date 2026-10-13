/** Reproducible rendering-work comparison; frame/CPU counts are not battery watts. */
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';

const baseline = process.argv.includes('--baseline');
const cpu = process.argv.includes('--cpu');
// Cumulative OS CPU time, not an instantaneous ps percentage or CDP task time.
const cpuSnapshot = () => {
  const rows = execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,time=,comm='], {
    encoding: 'utf8',
  });
  return new Map(
    rows.split('\n').flatMap((line) => {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(.+)$/);
      if (!match) return [];
      const [, pid, parent, time, name] = match;
      const seconds = time
        .split(':')
        .reduce((total, part) => total * 60 + Number(part), 0);
      return [
        [
          Number(pid),
          { parent: Number(parent), seconds, name: name.split('/').at(-1) },
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
    for (const [pid, row] of snapshot)
      if (!ids.has(pid) && ids.has(row.parent)) {
        ids.add(pid);
        changed = true;
      }
  }
  return ids;
};
const origin = process.env.QA_BASE_URL || 'http://localhost:4173';
const tile = fs.readFileSync(
  new URL(
    '../node_modules/cesium/Build/Cesium/Assets/Textures/NaturalEarthII/0/0/0.jpg',
    import.meta.url,
  ),
);
const browser = await puppeteer.launch({
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    ...(process.platform === 'darwin'
      ? ['--use-angle=metal', '--enable-gpu']
      : ['--use-angle=swiftshader']),
  ],
});
const measurements = [];
const serverPid = cpu
  ? Number(
      execFileSync(
        '/usr/sbin/lsof',
        ['-nP', '-iTCP:4173', '-sTCP:LISTEN', '-t'],
        { encoding: 'utf8' },
      ).trim(),
    )
  : null;
if (cpu && !Number.isInteger(serverPid))
  throw new Error('Expected one local server PID on port 4173');
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 800, height: 600, deviceScaleFactor: 2 });
  await page.setRequestInterception(true);
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      url.origin === 'https://services.arcgisonline.com' &&
      /\/tile\/\d+\/\d+\/\d+$/.test(url.pathname)
    )
      return void request.respond({
        status: 200,
        contentType: 'image/jpeg',
        headers: { 'Access-Control-Allow-Origin': '*' },
        body: tile,
      });
    if (
      url.origin === new URL(origin).origin &&
      url.pathname === '/api/openai/hud-summary'
    )
      return void request.respond({
        status: 200,
        contentType: 'application/json',
        body: '{"summary":"Power-budget QA fixture"}',
      });
    void request.continue();
  });
  await page.goto(origin, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(window.__godsEyeView?.viewer), {
    timeout: 90_000,
  });
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.styleManager.initialRestorePromise;
    app.viewer.camera.cancelFlight();
    for (const [id, entry] of app.dataManager.layers)
      if (entry.enabled) await app.dataManager.setEnabled(id, false);
    app.viewer.camera.setView({
      destination: app.viewer.scene.globe.ellipsoid.cartographicToCartesian({
        longitude: 0.2,
        latitude: 0.7,
        height: 60000,
      }),
      orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
    });
    const governor = await import('/src/renderGovernor.js');
    governor.holdContinuousRender('qa-power-continuous');
    window.__qaPowerFrames = 0;
    app.viewer.scene.postRender.addEventListener(() => {
      window.__qaPowerFrames++;
    });
  });
  const client = await page.createCDPSession();
  await client.send('Performance.enable');
  for (const profile of baseline
    ? ['baseline']
    : cpu
      ? ['quality', 'battery', 'battery', 'quality', 'quality', 'battery']
      : ['quality', 'battery']) {
    if (!baseline)
      await page.evaluate(
        (profile) => window.__godsEyeView.powerSavings.setProfile(profile),
        profile,
      );
    await new Promise((resolve) => setTimeout(resolve, 2500));
    const before = await client.send('Performance.getMetrics');
    const start = await page.evaluate(() => window.__qaPowerFrames);
    const cpuBefore = cpu ? cpuSnapshot() : null;
    const startedAt = Date.now();
    await new Promise((resolve) => setTimeout(resolve, cpu ? 15000 : 6000));
    const elapsedMs = Date.now() - startedAt;
    const cpuAfter = cpu ? cpuSnapshot() : null;
    const after = await client.send('Performance.getMetrics');
    const observation = await page.evaluate(() => ({
      frames: window.__qaPowerFrames,
      targetFps: window.__godsEyeView.viewer.targetFrameRate,
      width: window.__godsEyeView.viewer.canvas.width,
      height: window.__godsEyeView.viewer.canvas.height,
      resolutionScale: window.__godsEyeView.viewer.resolutionScale,
      msaa: window.__godsEyeView.viewer.scene.msaaSamples,
    }));
    const metric = (result, name) =>
      result.metrics.find((item) => item.name === name)?.value || 0;
    const frames = observation.frames - start;
    let cpuObservation = {};
    if (cpu) {
      const tree = descendants(cpuAfter, browser.process().pid);
      for (const pid of descendants(cpuBefore, browser.process().pid)) {
        if (!cpuAfter.has(pid))
          throw new Error(`Browser process ${pid} exited during CPU sample`);
        tree.add(pid);
      }
      const processCpu = [...tree]
        .filter((pid) => cpuAfter.has(pid))
        .map((pid) => ({
          pid,
          name: cpuAfter.get(pid).name,
          cpuPercent:
            (100000 *
              Math.max(
                0,
                cpuAfter.get(pid).seconds - (cpuBefore.get(pid)?.seconds || 0),
              )) /
            elapsedMs,
        }));
      if (!cpuBefore.has(serverPid) || !cpuAfter.has(serverPid))
        throw new Error('Server PID changed during sample');
      cpuObservation = {
        browserCpuPercent: processCpu.reduce(
          (sum, row) => sum + row.cpuPercent,
          0,
        ),
        serverCpuPercent:
          (100000 *
            (cpuAfter.get(serverPid).seconds -
              cpuBefore.get(serverPid).seconds)) /
          elapsedMs,
        processCpu,
      };
    }
    measurements.push({
      profile,
      ...observation,
      frames,
      elapsedMs,
      measuredFps: (frames * 1000) / elapsedMs,
      renderedPixelSamples: frames * observation.width * observation.height,
      rendererTaskSeconds:
        metric(after, 'TaskDuration') - metric(before, 'TaskDuration'),
      ...cpuObservation,
    });
  }
  if (!baseline) {
    const [quality, battery] = measurements;
    if (!(
      battery.frames < quality.frames * 0.65 &&
      battery.renderedPixelSamples < quality.renderedPixelSamples * 0.5
    ))
      throw new Error(
        'Battery profile did not reduce measured rendering work enough',
      );
    await page.evaluate(async () => {
      (await import('/src/renderGovernor.js')).releaseContinuousRender(
        'qa-power-continuous',
      );
    });
    if (
      (await page.evaluate(
        () => window.__godsEyeView.getRenderGovernorDiagnostics().mode,
      )) !== 'idle'
    )
      throw new Error('Battery profile lost idle rendering');
  }
  if (!baseline) {
    const other = await browser.newPage();
    await other.bringToFront();
    await page.waitForFunction(
      () =>
        document.hidden &&
        !window.__godsEyeView.viewer.useDefaultRenderLoop &&
        window.__godsEyeView.dataManager._pollingSuspended,
      { timeout: 10000 },
    );
    await page.bringToFront();
    await page.waitForFunction(
      () =>
        !document.hidden &&
        window.__godsEyeView.viewer.useDefaultRenderLoop &&
        !window.__godsEyeView.dataManager._pollingSuspended,
      { timeout: 10000 },
    );
    await other.close();
    console.log(
      'PASS: background rendering/poll suspension and foreground restoration',
    );
  }
  fs.mkdirSync('output/playwright', { recursive: true });
  fs.writeFileSync(
    `output/playwright/power-${baseline ? 'baseline' : cpu ? 'cpu' : 'comparison'}.json`,
    JSON.stringify(
      {
        evidence:
          'Controlled continuous-render fixture with bundled imagery; not a battery discharge measurement',
        ...(cpu
          ? {
              cpuMethod:
                'macOS cumulative process CPU seconds / wall seconds * 100; 100% = one core; dedicated browser process tree and separate local Vite server',
              logicalProcessors: os.cpus().length,
              serverPid,
            }
          : {}),
        measurements,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify(measurements, null, 2));
} finally {
  await browser.close();
}
