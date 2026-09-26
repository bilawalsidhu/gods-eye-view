import puppeteer from 'puppeteer';

/** Prove parked and moving headings in the real scene, without live feeds. */
export async function runTransitHeadingRegression(base, check) {
  const browser = await puppeteer.launch({
    headless: true,
    executablePath:
      process.env.PUPPETEER_EXECUTABLE_PATH ||
      (await puppeteer.executablePath().catch(() => null)),
    args: ['--no-sandbox', '--disable-background-timer-throttling'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(
      `${base}/?welcome=0#lat=42.3601&lon=-71.0589&alt=1200&heading=0&pitch=-90`,
      { waitUntil: 'domcontentloaded' },
    );
    await page.waitForFunction(
      () => window.__godsEyeView?.dataManager?.layers?.has('transit'),
      { timeout: 90000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await page.evaluate(async () => {
      const app = window.__godsEyeView;
      await app.dataManager.setEnabled('transit', true, { source: 'qa' });
      const layer = app.dataManager.layers.get('transit').module;
      layer._loadTransitFleetForTest(4, { lat: 42.3601, lon: -71.0589 }, 100);
      const state = layer._transitStateForTest(),
        parts = layer._transitPartsForTest();
      const { destroyTrack } = await import('/src/data/contactPlayback.js');
      const {
        initializePlayback,
        recordFix,
        updatePlayback,
        attachFloorToPlace,
      } = await import('/src/layers/transit/movement.js');
      // The first three are parked: held east, reported east only, unknown.
      for (let i = 0; i < 3; i++) {
        const entry = state._vehicles.get(`mbta:qa-${i}`);
        state._moving.delete(entry);
        destroyTrack(entry.track);
        initializePlayback(entry, state._historyBudget);
        recordFix(entry, {
          t: Date.now() - 30000,
          lat: entry.record.lat,
          lon: entry.record.lon,
        });
        attachFloorToPlace(entry, entry.record, 20);
        updatePlayback(entry, Date.now(), performance.now());
        entry.courseDeg = i === 0 ? 90 : null;
        entry.record.bearing = i === 1 ? 90 : null;
        entry.displayPaths.clear();
        parts.rendering.placeSample(entry);
        parts.rendering.schedulePlayback(entry);
      }
      parts.rendering.syncRenderHold();
      window.__headingErrors = [];
      app.viewer.scene.renderError.addEventListener((scene, error) =>
        window.__headingErrors.push(error.message),
      );
    });
    const pose = async (heading) => {
      await page.evaluate((heading) => {
        const camera = window.__godsEyeView.viewer.camera;
        const C = camera.positionCartographic.constructor;
        camera.setView({
          destination: C.toCartesian(C.fromDegrees(-71.0589, 42.3601, 1200)),
          orientation: { heading, pitch: -Math.PI / 2, roll: 0 },
        });
      }, heading);
      await new Promise((resolve) => setTimeout(resolve, 700));
    };
    const sample = () =>
      page.evaluate(async () => {
        const app = window.__godsEyeView,
          scene = app.viewer.scene;
        const state = app.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
        const mul = (m, v) =>
          [0, 1, 2, 3].map(
            (r) =>
              m[r] * v[0] +
              m[r + 4] * v[1] +
              m[r + 8] * v[2] +
              m[r + 12] * v[3],
          );
        const project = (p) => {
          const clip = mul(
            scene.camera.frustum.projectionMatrix,
            mul(scene.camera.viewMatrix, [p.x, p.y, p.z, 1]),
          );
          return {
            x: ((clip[0] / clip[3] + 1) * scene.canvas.clientWidth) / 2,
            y: ((1 - clip[1] / clip[3]) * scene.canvas.clientHeight) / 2,
          };
        };
        return [0, 1, 2, 3].map((i) => {
          const entry = state._vehicles.get(`mbta:qa-${i}`);
          const p = project(entry.marker.position);
          return {
            rotation: entry.marker.rotation,
            course: entry.courseDeg,
            moving: state._moving.has(entry),
            visible: entry.marker.show,
            x: p.x,
            y: p.y,
          };
        });
      });
    await pose(0);
    const before = await sample();
    await pose(Math.PI / 2);
    const after = await sample();
    const deltaDeg = (a, b) =>
      (Math.atan2(Math.sin(b - a), Math.cos(b - a)) * 180) / Math.PI;
    for (const [i, label] of ['held course', 'reported bearing'].entries()) {
      const delta = deltaDeg(before[i].rotation, after[i].rotation);
      check(
        `parked ${label} reprojects through a 90 degree camera orbit`,
        before[i].visible &&
          after[i].visible &&
          !before[i].moving &&
          !after[i].moving &&
          Math.abs(delta - 90) <= 5,
        JSON.stringify({ before: before[i], after: after[i], delta }),
      );
    }
    check(
      'unknown parked course remains screen-up',
      before[2].rotation === 0 && after[2].rotation === 0,
    );
    await new Promise((resolve) => setTimeout(resolve, 1200));
    const moved = (await sample())[3];
    const dx = moved.x - after[3].x,
      dy = moved.y - after[3].y;
    const travelRotation = Math.atan2(-dx, -dy);
    const error = Math.abs(deltaDeg(travelRotation, moved.rotation));
    check(
      'moving vehicle still points along its rendered travel after orbit',
      moved.visible && moved.moving && Math.hypot(dx, dy) > 0.5 && error <= 5,
      JSON.stringify({
        pixels: Math.hypot(dx, dy),
        error,
        after: after[3],
        moved,
      }),
    );
    check(
      'heading regression has no scene render errors',
      (await page.evaluate(() => window.__headingErrors)).length === 0,
    );
  } finally {
    await browser.close();
  }
}
