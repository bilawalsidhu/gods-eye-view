import { evaluateWithGeo } from './qa/geometry.mjs';
/** Camera-jump regression against an existing server; never starts a server. */
import { whenSettled, whenTilesLoaded } from './qa/ready.mjs';
import { launchBrowser, closeBrowser } from './qa/browser.mjs';
import { chromeExecutablePath, captureQaScreenshot } from './qa-chrome.mjs';
import { mkdir, writeFile } from 'node:fs/promises';
import { reduceTrailPixels } from '../src/layers/transit/qaMetrics.js';
import { blockPaidQaMaps } from './qa-map-policy.mjs';
import { transitQaBase } from './qa-transit-browser.mjs';

const base = transitQaBase(process.env.QA_BASE_URL);
const shots = process.env.QA_SHOTS || 'qa-shots/transit-recovery';
await mkdir(shots, { recursive: true });
const browser = await launchBrowser({
  headless: true,
  args: [
    ...(process.platform === 'darwin' ? [] : []),
    '--enable-gpu',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
  ],
});
try {
  const page = await browser.newPage();
  await blockPaidQaMaps(page);
  await page.setViewport({ width: 1920, height: 1080 });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    `${base}/?welcome=0#lat=30.271&lon=-97.7431&alt=600&heading=0&pitch=-60`,
  );
  await page.waitForFunction(() =>
    window.__godsEyeView?.dataManager?.layers.has('transit'),
  );
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.dataManager.setEnabled('transit', true, { source: 'qa' });
  });
  await whenTilesLoaded(page, { timeoutMs: 60000 });
  await whenSettled(page);
  await evaluateWithGeo(page, async (qaGeo) => {
    const C = qaGeo.cartographic,
      lat = 30.267 + 90 / 111320;
    const floor =
      window.__godsEyeView.engine.surface.terrainHeight(
        C.fromDegrees(-97.7431, lat),
      ) || 0;
    window.__godsEyeView.engine.camera.setView({
      destination: C.toCartesian(
        C.fromDegrees(
          -97.7431,
          lat - 600 / Math.tan(Math.PI / 3) / 111320,
          floor + 600,
        ),
      ),
      orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
    });
  });
  await whenSettled(page);
  await whenTilesLoaded(page, { timeoutMs: 60000 });
  await whenSettled(page);
  const result = await evaluateWithGeo(page, async (qaGeo) => {
    const app = window.__godsEyeView;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest(),
      parts = layer._transitPartsForTest();
    const { getRegisteredTransitFeed } =
      await import('/src/data/transitFeeds.js');
    const { setRate } = await import('/src/data/contactPlayback.js');
    const C = qaGeo.cartographic;
    const feed = {
      ...getRegisteredTransitFeed('capmetro-austin'),
      id: 'qa-camera-recovery',
    };
    const aim = (lat, height = 600) =>
      window.__godsEyeView.engine.camera.setView({
        destination: C.toCartesian(
          C.fromDegrees(
            -97.7431,
            lat - 600 / Math.tan(Math.PI / 3) / 111320,
            height,
          ),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 3, roll: 0 },
      });
    // The trail draws through engine.ground (render/display.js); its renderer
    // is the handle that shows and hides the whole trail. Keep the one the
    // selection below creates.
    let trailRenderer = null;
    const createTrailRenderer = parts.renderer.createTrailRenderer;
    parts.renderer.createTrailRenderer = (...args) =>
      (trailRenderer = createTrailRenderer.apply(parts.renderer, args));
    parts.selection.clearSelection();
    parts.ingestion.abortAllInFlight();
    state._activeFeeds.clear();
    for (const key of state._vehicles.keys())
      parts.ingestion.removeVehicle(key);
    // Model an outstanding floor lookup while reports arrive off screen.
    // Only acquisition is controlled; selection, visibility, paths and rendering
    // use their real owners. Release to the loaded terrain at the camera jump.
    const requestHeight = parts.height.requestHeight;
    parts.height.requestHeight = (lat, lon) => ({
      cell: `${lat},${lon}`,
      height: null,
      prior: null,
    });
    aim(30.28);
    const now = Date.now();
    for (let i = 0; i < 9; i++) {
      const timestamp = now - 135000 + i * 15000;
      parts.ingestion.applySnapshot(
        feed,
        {
          fetchedAt: timestamp,
          vehicles: [
            {
              id: 'moving-bus',
              routeId: '1',
              tripId: 'qa',
              lat: 30.267 + (i * 90) / 111320,
              lon: -97.7431,
              timestamp: timestamp / 1000,
              timestampSource: 'vehicle',
              bearing: 0,
            },
          ],
        },
        { stale: false },
      );
    }
    const entry = state._vehicles.get(`${feed.id}:moving-bus`);
    entry.qaFixture = true; // Protect this disclosed fixture from live feed eviction.
    parts.rendering.sampleIdle(entry);
    const before = {
      shown: entry.marker.show,
      heightPending: entry.heightPending,
      phase: entry.sample.phase,
      fixes: entry.track.count,
    };
    clearTimeout(state._floorTimer);
    state._floorTimer = null;
    const started = performance.now();
    parts.selection.selectVehicle(entry.key);
    parts.renderer.createTrailRenderer = createTrailRenderer;
    const preparedAtSelection = !!parts.trails.diagnostics()?.body;
    parts.height.requestHeight = requestHeight;
    const floor =
      window.__godsEyeView.engine.surface.terrainHeight(
        C.fromDegrees(entry.sample.lon, entry.sample.lat),
      ) || 0;
    aim(entry.sample.lat, floor + 600);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let trail;
    while (performance.now() - started < 1400) {
      trail = parts.trails.diagnostics();
      if (entry.marker.show && trail?.body?.show && trail.body.ready) break;
      window.__godsEyeView.engine.render.request();
      await wait(25);
    }
    const status = {
      before,
      preparedAtSelection,
      markerShow: entry.marker.show,
      body: !!trail?.body,
      bodyShow: trail?.body?.show === true,
      visibility: layer
        ._transitVisibilityForTest()
        .find((e) => e.key === entry.key),
      recoveryMs: performance.now() - started,
    };
    if (!trailRenderer)
      return { ...status, reason: 'the selection created no trail renderer' };
    if (!entry.marker.show || !trail?.body?.show || !trail.body.ready)
      return {
        ...status,
        reason: 'marker or body did not recover before pixel deadline',
      };
    setRate(entry.track, 0, {
      wallNowMs: Date.now(),
      monoNowMs: performance.now(),
    });
    parts.rendering.sampleIdle(entry);
    parts.rendering.schedulePlayback(entry);
    // Marker positions are plain { x, y, z } now (the display's handles), not
    // Cesium Cartesian3 instances with static helpers.
    const V = {
      distance: (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z),
      lerp: (a, b, t) => ({
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        z: a.z + (b.z - a.z) * t,
      }),
    };
    const points = entry.trailSegments
      .filter((s) => s.toT <= entry.sample.displayT)
      .flatMap((s) => s.positions);
    const lengths = [0];
    for (let i = 1; i < points.length; i++)
      lengths.push(lengths.at(-1) + V.distance(points[i - 1], points[i]));
    const canvas = window.__godsEyeView.engine.host.canvas,
      gl = window.__godsEyeView.engine.host.canvas.getContext('webgl2'),
      scale = canvas.width / canvas.clientWidth;
    const mul = (m, v) =>
      [0, 1, 2, 3].map(
        (i) =>
          m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2] + m[i + 12] * v[3],
      );
    const project = (p) => {
      const q = mul(window.__godsEyeView.engine.projector.viewProjection(), [
        p.x,
        p.y,
        p.z,
        1,
      ]);
      return {
        x: ((q[0] / q[3]) * 0.5 + 0.5) * canvas.clientWidth,
        y: (0.5 - (q[1] / q[3]) * 0.5) * canvas.clientHeight,
        inFront: q[3] > 0,
      };
    };
    const samples = Array.from({ length: 8 }, (_, i) => {
      const d = (lengths.at(-1) * (i + 1)) / 9;
      let j = 1;
      while (j < lengths.length - 1 && lengths[j] < d) j++;
      const p = V.lerp(
        points[j - 1],
        points[j],
        (d - lengths[j - 1]) / Math.max(0.001, lengths[j] - lengths[j - 1]),
      );
      const cart = C.fromCartesian(p);
      cart.height =
        window.__godsEyeView.engine.surface.terrainHeight(cart) || 0;
      return {
        ...project(C.toCartesian(cart)),
        radius: (Math.SQRT2 * Math.ceil(3 * scale)) / scale,
      };
    });
    const sprite = {
      ...project(entry.marker.position),
      radius: Math.hypot(entry.marker.width, entry.marker.height) / 2 + 4,
    };
    const read = () =>
      samples.map(({ x, y }) => {
        const r = Math.ceil(3 * scale),
          px = Math.round(x * scale),
          py = Math.round(canvas.height - 1 - y * scale);
        if (
          px < r ||
          py < r ||
          px + r >= canvas.width ||
          py + r >= canvas.height
        )
          return null;
        const data = new Uint8Array((2 * r + 1) ** 2 * 4);
        gl.readPixels(
          px - r,
          py - r,
          2 * r + 1,
          2 * r + 1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          data,
        );
        return Array.from(data);
      });
    const frame = () =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          remove();
          reject(new Error('No recovery frame'));
        }, 500);
        const remove =
          window.__godsEyeView.engine.frames.postRender.addEventListener(() => {
            remove();
            clearTimeout(timer);
            resolve(read());
          });
        window.__godsEyeView.engine.render.request();
      });
    let visible = true;
    // Body and head together, as the trail's own visibility switch does.
    const remove =
      window.__godsEyeView.engine.frames.preRender.addEventListener(() =>
        trailRenderer.setVisible(visible),
      );
    const captures = [];
    try {
      for (const show of [false, true, false, true]) {
        visible = show;
        await frame();
        captures.push(await frame());
      }
    } finally {
      remove();
      trailRenderer.setVisible(true);
      parts.trails.update();
    }
    const [off, on, offAgain, onAgain] = captures;
    return {
      ...status,
      samples,
      sprite,
      off,
      on,
      offAgain,
      onAgain,
      tilesReady:
        window.__godsEyeView.engine.surface.tilesLoaded() &&
        parts.trails.diagnostics().body === trail.body,
      elapsedMs: performance.now() - started,
      // The trail's ground corridors (age bands and head, each with a backing).
      lines: app.engine.ground
        .list()
        .filter(({ id }) => id.startsWith('transit-trail-')),
    };
  });
  const pixels = reduceTrailPixels(result.on, result.off, result);
  result.present = pixels.present;
  result.pixelPass = pixels.pass;
  result.pixelDetails = pixels;
  result.errors = errors;
  await captureQaScreenshot(page, { path: `${shots}/recovery.png` });
  await writeFile(`${shots}/recovery.json`, JSON.stringify(result, null, 2));
  for (const key of ['on', 'off', 'onAgain', 'offAgain']) delete result[key];
  const pass =
    result.before?.shown === false &&
    result.before?.phase === 'playing' &&
    // Ground history is prepared even while marker floors are unresolved.
    result.preparedAtSelection &&
    result.markerShow &&
    result.body &&
    result.bodyShow &&
    result.elapsedMs <= 2000 &&
    pixels.pass &&
    !errors.length;
  console.log(
    `${pass ? 'PASS' : 'FAIL'} select moving bus, setView, marker + body + >=6/8 trail pixels within 2 s`,
  );
  console.log(JSON.stringify(result));
  process.exitCode = pass ? 0 : 1;
} finally {
  await closeBrowser(browser);
}
