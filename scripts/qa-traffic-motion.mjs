#!/usr/bin/env node
/**
 * Traffic motion acceptance: real-GPU Puppeteer, stable identities, stationary
 * camera holds and timestamped CDP JPEGs encoded with ffmpeg. No tile mocks.
 * Run: node scripts/qa-traffic-motion.mjs http://localhost:4186
 * --baseline records the unmodified pre-fix implementation (object identities
 * via WeakMap, never collection indices); it reports failures without exiting 1.
 * --mode=tomtom|osm|hybrid limits a diagnostic run. --tag=name keeps captures.
 * --journey follows a neighborhood-to-city route with layer toggles, then
 * checks Capitol/greenbelt/parking/corridor views against a 1.5 s limit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import puppeteer from 'puppeteer';
const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(
    'Usage: node scripts/qa-traffic-motion.mjs <url> [--baseline] [--mode=tomtom|osm|hybrid] [--tag=name] [--journey]',
  );
  process.exit(0);
}
const url = args.find((a) => /^https?:/.test(a));
if (!url) throw new Error('A running dev server URL is required');
const baseline = args.includes('--baseline');
const journey = args.includes('--journey');
const option = (key) =>
  args.find((a) => a.startsWith(`--${key}=`))?.split('=')[1];
const modes = option('mode') ? [option('mode')] : ['tomtom', 'osm', 'hybrid'];
if (modes.some((m) => !['tomtom', 'osm', 'hybrid'].includes(m)))
  throw new Error('Invalid road mode');
const root = path.resolve(
  'qa-shots/motion',
  option('tag') || (baseline ? 'before' : '.'),
);
fs.mkdirSync(root, { recursive: true });
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  encoding: 'utf8',
}).trim();
const browser = await puppeteer.launch({
  headless: true,
  protocolTimeout: 300000,
  args: [
    '--use-angle=metal',
    '--window-size=1280,800',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
const results = [];
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  for (const mode of modes) {
    const dir = path.join(root, mode);
    fs.mkdirSync(dir, { recursive: true });
    const page = await browser.newPage();
    const errors = [],
      forbidden = [],
      logs = [],
      tileRequests = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text());
      if (m.text().startsWith('[Data:Traffic]')) logs.push(m.text());
    });
    page.on('request', (r) => {
      const u = new URL(r.url());
      if (
        u.hostname === 'tiles.openfreemap.org' &&
        /\/\d+\/\d+\/\d+(?:\.pbf)?$/.test(u.pathname)
      )
        tileRequests.push(u.pathname);
      if (
        /overpass/i.test(u.hostname) ||
        u.hostname === 'nominatim.openstreetmap.org'
      )
        forbidden.push(u.hostname);
    });
    await page.setViewport({ width: 1280, height: 800 });
    await page.evaluateOnNewDocument(() =>
      sessionStorage.setItem('gev:first-run-mission-session:v1', 'dismissed'),
    );
    const u = new URL(url);
    u.searchParams.set('trafficRoads', mode);
    u.searchParams.set('trafficDebug', '1');
    await page.goto(u.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(
      () =>
        window.__godsEyeView?.dataManager &&
        document.getElementById('loading-screen')?.classList.contains('hidden'),
      { timeout: 120000 },
    );
    await page.evaluate(
      () => window.__godsEyeView.styleManager.initialRestorePromise,
    );
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      const g = window.__godsEyeView;
      g.styleManager.setDetection({ enabled: false });
      for (const [id] of g.dataManager.layers)
        g.dataManager.setEnabled(id, false);
      g.viewer.scene.screenSpaceCameraController.enableCollisionDetection = false;
    });
    const identity = await page.evaluate(() => ({
      title: document.title,
      text: document.body.innerText.length,
      overlay: Boolean(document.querySelector('vite-error-overlay')),
    }));
    await page.evaluate((baseline) => {
      const { viewer, dataManager } = window.__godsEyeView;
      const layer = dataManager.layers.get('traffic').module;
      if (!baseline && typeof layer.visitMotionDots !== 'function')
        throw new Error('Traffic must expose stable dot identities');
      const scene = viewer.scene;
      const weakIds = new WeakMap();
      let nextId = 0,
        rebuilds = 0;
      const collections = [];
      function discoverCollections() {
        for (let i = 0; i < scene.primitives.length; i++) {
          const p = scene.primitives.get(i);
          if (!Array.isArray(p._pointPrimitives) || collections.includes(p))
            continue;
          collections.push(p);
          const removeAll = p.removeAll;
          p.removeAll = function () {
            if (this.length) rebuilds++;
            return removeAll.call(this);
          };
        }
      }
      let previous = new Map(),
        previousN = 0,
        lastRebuilds = 0,
        lastTime = 0;
      const rows = [];
      window.__motion = {
        rows,
        active: false,
        moveEnds: [],
        label: 'camera moving',
        holdStart: null,
      };
      const clock = document.createElement('div');
      clock.style.cssText =
        'position:fixed;bottom:4px;left:38%;padding:3px 8px;background:#000c;color:#fff;font:12px monospace;z-index:999999;pointer-events:none';
      document.body.append(clock);
      viewer.camera.moveEnd.addEventListener(() =>
        window.__motion.moveEnds.push(performance.now()),
      );
      scene.postRender.addEventListener(() => {
        if (!window.__motion.active) return;
        discoverCollections();
        const now = performance.now(),
          points = new Map();
        clock.textContent =
          `QA: ${window.__motion.label}` +
          (window.__motion.holdStart === null
            ? ''
            : ` | camera stopped +${((now - window.__motion.holdStart) / 1000).toFixed(1)}s`);
        const visit = (id, roadId, point) => {
          if (!point.show) return;
          const s = scene.cartesianToCanvasCoordinates(point.position);
          if (s && s.x >= 0 && s.y >= 0 && s.x <= 1280 && s.y <= 800)
            points.set(id, { x: s.x, y: s.y, roadId });
        };
        let n = 0,
          offRoad = 0;
        if (!baseline && layer.visitMotionDots) {
          layer.visitMotionDots((id, roadId, point, road) => {
            if (point.show) {
              const p = road?.roadProperties;
              const allowed = road?.directFlow
                ? [
                    'Motorway',
                    'International road',
                    'Major road',
                    'Secondary road',
                    'Connecting road',
                    'Major local road',
                    'Local road',
                    'Minor local road',
                  ].includes(p?.roadType)
                : [
                    'motorway',
                    'trunk',
                    'primary',
                    'secondary',
                    'tertiary',
                    'minor',
                  ].includes(p?.class) &&
                  !p?.service &&
                  !p?.subclass &&
                  !['no', 'private'].includes(p?.access) &&
                  p?.brunnel !== 'tunnel';
              if (!allowed) offRoad++;
            }
            if (point.show) n++;
            visit(id, roadId, point);
          });
        } else {
          for (const coll of collections)
            if (coll.show)
              for (let i = 0; i < coll.length; i++) {
                const p = coll.get(i);
                if (!weakIds.has(p)) weakIds.set(p, ++nextId);
                if (p.show) n++;
                visit(weakIds.get(p), null, p);
              }
        }
        let tracked = 0,
          jumps = 0,
          reassigned = 0,
          births = 0,
          deaths = 0;
        for (const [id, p] of points) {
          const prev = previous.get(id);
          if (!prev) {
            births++;
            continue;
          }
          tracked++;
          if (Math.hypot(p.x - prev.x, p.y - prev.y) > 30) jumps++;
          if (p.roadId !== prev.roadId) reassigned++;
        }
        for (const id of previous.keys()) if (!points.has(id)) deaths++;
        rows.push({
          t: now,
          loading: layer.getStats().loading,
          syncing:
            document
              .getElementById('traffic-sync-chip')
              ?.classList.contains('visible') &&
            document.getElementById('traffic-sync-progress')?.textContent ===
              '...',
          surfacePending: layer.getStats().surfacePending,
          offRoad,
          dt: now - lastTime,
          n,
          visible: points.size,
          tracked,
          jumps,
          jumpFrac: tracked ? jumps / tracked : 0,
          reassigned,
          births,
          deaths,
          sizeChanged: n !== previousN,
          rebuilds: rebuilds - lastRebuilds,
        });
        previous = points;
        previousN = n;
        lastRebuilds = rebuilds;
        lastTime = now;
      });
    }, baseline);
    const fly = (lat, lon, height, pitch, duration, heading = 20) =>
      page.evaluate(
        async (v) => {
          const { viewer } = window.__godsEyeView;
          window.__motion.label = 'camera moving';
          window.__motion.holdStart = null;
          viewer.camera.cancelFlight();
          await new Promise((resolve) =>
            viewer.camera.flyTo({
              destination: viewer.scene.globe.ellipsoid.cartographicToCartesian(
                {
                  latitude: (v.lat * Math.PI) / 180,
                  longitude: (v.lon * Math.PI) / 180,
                  height: v.height,
                },
              ),
              orientation: {
                heading: (v.heading * Math.PI) / 180,
                pitch: (v.pitch * Math.PI) / 180,
                roll: 0,
              },
              duration: v.duration,
              complete: resolve,
              cancel: resolve,
            }),
          );
        },
        { lat, lon, height, pitch, duration, heading },
      );
    const cdp = await page.createCDPSession();
    let fi = 0;
    const frames = [];
    cdp.on('Page.screencastFrame', (f) => {
      const name = `f${String(fi++).padStart(5, '0')}.jpg`;
      fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, 'base64'));
      frames.push({ name, timestamp: f.metadata.timestamp });
      cdp
        .send('Page.screencastFrameAck', { sessionId: f.sessionId })
        .catch(() => {});
    });
    await fly(
      ...(journey
        ? [30.25, -97.7497, 700, -40, 0, 10]
        : [30.2685, -97.7425, 450, -35, 0]),
    );
    await cdp.send('Page.startScreencast', {
      format: 'jpeg',
      quality: 65,
      maxWidth: 1280,
      maxHeight: 800,
      everyNthFrame: journey ? 1 : 3,
    });
    await page.evaluate(() => {
      window.__motion.active = true;
    });
    const holds = [];
    const hold = async (name, warm = false, holdMs = 10000, empty = false) => {
      const start = await page.evaluate((label) => {
        const start = performance.now();
        window.__motion.label = label;
        window.__motion.holdStart = start;
        return start;
      }, name);
      await delay(holdMs);
      const end = await page.evaluate(() => performance.now());
      holds.push({
        name,
        warm,
        start,
        end,
        empty,
        settleMs: journey ? 1500 : warm ? 1000 : 3000,
      });
      await page.screenshot({ path: path.join(dir, `${name}.png`) });
      console.log(`${mode}: captured ${name}`);
    };
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.setEnabled('traffic', true),
    );
    // Match motion-reference: begin the camera-motion scenario from a
    // settled street view. Initial mesh acquisition is recorded in the clip
    // and first-dot diagnostics, but is not a stationary motion hold.
    if (journey) {
      await delay(4000);
      await hold('south-congress', true, 6000);
      const step = async (name, view, ms = 6000, empty = false) => {
        await fly(...view);
        await hold(name, false, ms, empty);
      };
      await step('pan-north-400m', [30.2536, -97.7497, 700, -40, 2, 10], 4000);
      await step('pan-east-500m', [30.2536, -97.7445, 700, -40, 2, 10], 4000);
      await step('zoom-out-2.5km', [30.2536, -97.7445, 2500, -45, 2.5, 10]);
      await step(
        'downtown-2.5km',
        [30.2672, -97.7431, 2500, -45, 2.5, 10],
        5000,
      );
      await step('downtown-500m', [30.2672, -97.7431, 500, -35, 2.5, 20]);
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled('alpr-cameras', true),
      );
      await hold('enable-alpr', true, 6000);
      await step('pan-west-600m', [30.2672, -97.7494, 500, -35, 2, 20], 5000);
      await step('city-12km', [30.28, -97.75, 12000, -60, 3, 0], 8000, true);
      await fly(30.3125, -97.765, 1000, -45, 3, 0);
      await page.evaluate(() =>
        window.__godsEyeView.dataManager.setEnabled(
          'military-installations',
          true,
        ),
      );
      await hold('camp-mabry-1km', false, 8000);
      await step('camp-mabry-pan', [30.3125, -97.76, 1000, -45, 2, 30], 5000);
      await step('greenbelt', [30.312, -97.775, 1000, -55, 3, 0], 6000);
      await step('capitol', [30.2747, -97.7404, 500, -70, 3, 0], 6000);
      await step('commercial-parking', [30.307, -97.735, 600, -60, 3, 0], 6000);
      await step('corridor', [30.347, -97.799, 1000, -45, 3, 0], 6000);
    } else {
      await delay(12000);
      await page.waitForFunction(
        () => window.__motion.rows.some((r) => r.n > 0),
        { timeout: 1000 },
      );
      await hold('street-warm', true);
      await fly(30.2685, -97.7425, 3000, -45, 1.5);
      await hold('zoom-out');
      await fly(30.2685, -97.72, 3000, -45, 1.5);
      await hold('pan-east');
      await fly(30.2685, -97.725, 600, -35, 1.5);
      await hold('zoom-in');
      await fly(-23.5505, -46.6333, 1250, -35, 1.5);
      await hold('sao-paulo');
      await fly(30.2685, -97.7425, 450, -35, 1.5);
      await hold('austin-revisit', true);
    }
    await page.evaluate(() => {
      window.__motion.active = false;
    });
    await cdp.send('Page.stopScreencast');
    const rows = await page.evaluate(() => window.__motion.rows);
    const surfacePhases = await page.evaluate(() =>
      performance
        .getEntriesByType('measure')
        .filter(
          (e) => e.name.startsWith('roads:') || e.name.startsWith('traffic:'),
        )
        .map((e) => ({
          name: e.name,
          start: e.startTime,
          duration: e.duration,
          detail: e.detail,
        })),
    );
    const stats = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers.get('traffic').module.getStats(),
    );
    const phases = holds.map((h) => {
      const all = rows.filter((r) => r.t >= h.start && r.t < h.end);
      const settled = all.filter((r) => r.t >= h.start + h.settleMs);
      const n = settled.map((r) => r.n);
      const lastBusy = all.findLastIndex(
        (r) => r.loading || r.syncing || r.sizeChanged || r.jumpFrac > 0.02,
      );
      // First observed settled frame after the last population/loading event.
      const steadyMs =
        lastBusy < 0
          ? 0
          : Math.round((all[lastBusy + 1]?.t ?? h.end) - h.start);
      const phase = {
        mode,
        phase: h.name,
        steadyMs,
        lateLoadingFrames: settled.filter((r) => r.loading).length,
        offRoadDots: Math.max(0, ...all.map((r) => r.offRoad)),
        settleMs: h.settleMs,
        frames: settled.length,
        rebuilds: all.reduce((s, r) => s + r.rebuilds, 0),
        lateRebuilds: settled.reduce((s, r) => s + r.rebuilds, 0),
        jumpFrames: settled.filter((r) => r.jumpFrac > 0.02).length,
        reassigned: settled.reduce((s, r) => s + r.reassigned, 0),
        sizeChanges: settled.filter((r) => r.sizeChanged).length,
        minDots: Math.min(...n),
        maxDots: Math.max(...n),
        maxFrameMs: Math.round(Math.max(...settled.map((r) => r.dt))),
      };
      phase.passed =
        phase.frames >= 20 &&
        phase.rebuilds <= 1 &&
        phase.lateRebuilds === 0 &&
        phase.jumpFrames === 0 &&
        phase.reassigned === 0 &&
        phase.sizeChanges === 0 &&
        (h.empty ? phase.maxDots === 0 : phase.minDots > 0) &&
        (!journey ||
          (phase.steadyMs <= 1500 &&
            phase.offRoadDots === 0 &&
            all.at(-1)?.surfacePending === 0));
      return phase;
    });
    fs.writeFileSync(
      path.join(dir, 'frames.ffconcat'),
      'ffconcat version 1.0\n' +
        frames
          .map(
            (f, i) =>
              `file '${f.name}'\nduration ${Math.max(0.001, Math.min(2, (frames[i + 1]?.timestamp || f.timestamp + 0.1) - f.timestamp))}\n`,
          )
          .join(''),
    );
    execFileSync('ffmpeg', [
      '-y',
      '-loglevel',
      'error',
      '-safe',
      '0',
      '-f',
      'concat',
      '-i',
      path.join(dir, 'frames.ffconcat'),
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-pix_fmt',
      'yuv420p',
      '-vf',
      journey ? 'scale=1280:-2' : 'scale=960:-2',
      path.join(dir, 'clip.mp4'),
    ]);
    const result = {
      mode,
      revision,
      baseline,
      identity,
      url: u.href,
      phases,
      errors,
      forbidden,
      tileRequests,
      duplicateTiles: tileRequests.filter(
        (p, i) => tileRequests.indexOf(p) !== i,
      ),
      stats,
      surfacePhases,
      logs,
      holds,
      rows,
      moveEnds: await page.evaluate(() => window.__motion.moveEnds),
      clip: path.join(dir, 'clip.mp4'),
      frames: frames.length,
    };
    result.passed =
      phases.every((p) => p.passed) &&
      !errors.length &&
      !forbidden.length &&
      result.duplicateTiles.length === 0 &&
      !identity.overlay &&
      identity.text > 100;
    fs.writeFileSync(
      path.join(dir, 'metrics.json'),
      JSON.stringify(result, null, 2),
    );
    results.push(result);
    console.table(phases);
    await page.close();
  }
} finally {
  await browser.close();
  fs.writeFileSync(
    path.join(root, 'results.json'),
    JSON.stringify(
      results.map(({ rows, ...r }) => r),
      null,
      2,
    ),
  );
}
if (!baseline && results.some((r) => !r.passed)) process.exitCode = 1;
