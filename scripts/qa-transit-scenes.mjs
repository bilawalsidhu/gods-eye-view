import { reportTransitVisibility } from './qa-transit-browser.mjs';
import { writeFile } from 'node:fs/promises';
import {
  reduceFleet,
  reduceMotion,
  reduceBackground,
  reduceSensorContrast,
  reduceTrailPixels,
} from '../src/layers/transit/qaMetrics.js';

/** CDP includes objects collected during the sample, not just surviving objects. */
export function allocationTotals(profile) {
  let frameBytes = 0,
    layerFrameBytes = 0,
    sharedOverlayBytes = 0,
    qaBytes = 0;
  const allocators = new Map();
  function visit(node, inFrame = false, inQa = false, inOverlay = false) {
    const frame = node.callFrame || {},
      name = frame.functionName || '',
      url = frame.url || '';
    const nested =
      inFrame ||
      name === 'onPreRender' ||
      /^render\d*$/.test(name) ||
      /^Scene\d*\.render$/.test(name);
    // QA wraps the real frame callback: re-enter production attribution at its
    // onPreRender boundary, but exclude QA's own Math/Cesium helper descendants.
    const qa =
      name === 'onPreRender'
        ? false
        : inQa || /\/transit\/testing\.js(?:\?|$)/.test(url);
    const overlay = inOverlay || name === '_drawOverlay';
    const bytes = node.selfSize || 0;
    if (nested) {
      if (qa) qaBytes += bytes;
      else {
        frameBytes += bytes;
        const allocator = `${name || '(anonymous)'} ${url.split('?')[0]}:${(frame.lineNumber ?? -1) + 1}`;
        allocators.set(allocator, (allocators.get(allocator) || 0) + bytes);
        if (overlay) sharedOverlayBytes += bytes;
        if (
          /\/layers\/transit\/|\/data\/(?:contactPlayback|contactTrailRenderer|transit[^/]*)\.js/.test(
            url,
          )
        )
          layerFrameBytes += bytes;
      }
    }
    for (const child of node.children || []) visit(child, nested, qa, overlay);
  }
  visit(profile.head);
  return {
    frameBytes,
    layerFrameBytes,
    sharedOverlayBytes,
    qaBytes,
    topAllocators: [...allocators]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([allocator, bytes]) => ({ allocator, bytes })),
  };
}

export async function runFleetBudgets({
  page,
  check,
  wait,
  shots,
  tag,
  detectOn,
  selectStyle,
}) {
  console.log(
    '\n== moving fleet budgets: 1920×1080 CSS, warmed view, DETECT dense ==',
  );
  await selectStyle(page, 'normal');
  await detectOn(page);
  const cdp = await page.createCDPSession();
  await cdp.send('HeapProfiler.enable');
  for (const count of [800, 3000]) {
    await page.evaluate(async (count) => {
      const app = window.__godsEyeView;
      await app.dataManager.setEnabled('transit', true, { source: 'qa' });
      const camera = app.viewer.camera,
        C = camera.positionCartographic.constructor;
      camera.setView({
        destination: C.toCartesian(
          C.fromDegrees(-71.0605, 42.3554, count === 800 ? 600 : 30000),
        ),
        orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
      });
      const layer = app.dataManager.layers.get('transit').module;
      layer._transitPartsForTest().ingestion.abortAllInFlight();
      layer._transitStateForTest()._activeFeeds.clear();
      for (const key of layer._transitStateForTest()._vehicles.keys())
        layer._transitPartsForTest().ingestion.removeVehicle(key);
    }, count);
    await wait(8000);
    // Camera proximity can finish a live poll during tile warm-up. Remove it
    // before the heap baseline, or its memory would discount the fixture fleet.
    await page.evaluate(() => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest(),
        parts = layer._transitPartsForTest();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      for (const key of state._vehicles.keys())
        parts.ingestion.removeVehicle(key);
      parts.rendering.syncRenderHold();
      window.__godsEyeView.viewer.scene.requestRender();
    });
    await wait(500);
    await cdp.send('HeapProfiler.collectGarbage');
    const before = await cdp.send('Runtime.getHeapUsage');
    const loaded = await page.evaluate(
      (count) =>
        window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._loadTransitFleetForTest(
            count,
            { lat: 42.3554, lon: -71.0605 },
            count === 800 ? 5 : 120,
          ),
      count,
    );
    await reportTransitVisibility(
      page,
      `${count} budget visibility after load`,
    );
    await wait(2000);
    await cdp.send('HeapProfiler.collectGarbage');
    // The retained delta is conservative: it includes concurrent page growth.
    const retained = await cdp.send('Runtime.getHeapUsage');
    // Timing/upload acceptance runs without the allocation profiler attached.
    const trace = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._measureTransitFramesForTest(8000),
    );
    await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._resetTransitFixtureClockForTest(),
    );
    await wait(1500);
    await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 128,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    await reportTransitVisibility(
      page,
      `${count} budget visibility before allocation trace`,
    );
    const allocationTrace = await page.evaluate(() =>
      window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._measureTransitFramesForTest(6000),
    );
    const { profile } = await cdp.send('HeapProfiler.stopSampling');
    const allocations = allocationTotals(profile);
    const retainedBytes = retained.usedSize - before.usedSize;
    const evidence = reduceFleet(
      trace.rows,
      count,
      allocations.layerFrameBytes / allocationTrace.rows.length,
      retainedBytes,
      loaded.fixBytes,
    );
    const details = {
      ...evidence,
      ...allocations,
      wholeFrameBytesPerFrame:
        allocations.frameBytes / allocationTrace.rows.length,
      topAllocatorsPerFrame: allocations.topAllocators.map((a) => ({
        ...a,
        bytesPerFrame: a.bytes / allocationTrace.rows.length,
      })),
      allocationFrames: allocationTrace.rows.length,
      loaded,
      dpr: trace.dpr,
      viewport: [trace.width, trace.height],
      heapMethod:
        'GC-bracketed whole-page growth after fleet load (conservative)',
      allocationMethod:
        'CDP 128-byte sampling including collected objects; transit source self allocation gates, whole render stacks reported, QA scaffolding excluded',
    };
    await writeFile(
      `${shots}/${tag}-fleet-${count}.json`,
      JSON.stringify(details, null, 2),
    );
    await writeFile(
      `${shots}/${tag}-fleet-${count}-allocations.json`,
      JSON.stringify(profile),
    );
    check(
      `${count} moving vehicles meet CPU, frame interval, billboard upload, heap and allocation budgets`,
      evidence.pass && trace.width === 1920 && trace.height === 1080,
      JSON.stringify(details),
    );
    check(
      `${count}: transit-authored frame allocation <= 8 KiB`,
      allocationTrace.rows.length >= 100 &&
        reduceMotion(allocationTrace.rows).pass &&
        allocationTrace.rows.every((r) => r.moving === count) &&
        allocations.layerFrameBytes / allocationTrace.rows.length <= 8192,
      `${allocations.layerFrameBytes / allocationTrace.rows.length} transit-authored bytes/frame; whole frame ${allocations.frameBytes / allocationTrace.rows.length}; top three ${JSON.stringify(details.topAllocatorsPerFrame)}; collected objects included. Full profile saved.`,
    );
    await page.screenshot({
      path: `${shots}/${tag}-fleet-${count}.jpg`,
      type: 'jpeg',
      quality: 85,
    });
    const settled = await page.evaluate(async () => {
      const layer =
        window.__godsEyeView.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest();
      const { seek } = await import('/src/data/contactPlayback.js');
      const { updatePlayback } =
        await import('/src/layers/transit/movement.js');
      for (const entry of state._vehicles.values()) {
        entry.clocks.wallNowMs = Date.now();
        entry.clocks.monoNowMs = performance.now();
        seek(entry.track, entry.fixes.at(-1).t, entry.clocks);
        updatePlayback(entry, Date.now(), performance.now());
        layer._transitPartsForTest().rendering.schedulePlayback(entry);
      }
      layer._transitPartsForTest().rendering.syncRenderHold();
      return { moving: state._moving.size, held: state._renderHeld };
    });
    check(
      `${count}: settling releases the transit hold`,
      settled.moving === 0 && !settled.held,
      JSON.stringify(settled),
    );
  }
  await cdp.detach();
}

export async function runBostonMatrix({
  page,
  check,
  wait,
  shots,
  tag,
  selectStyle,
  sampleRendered,
  detectOn,
}) {
  console.log(
    '\n== Boston matrix: scripted Red, 741, 742, Green-E; actual map backgrounds ==',
  );
  await detectOn(page);
  const routes = ['Red', '741', '742', 'Green-E'];
  const looks = [
    { name: 'normal', style: 'normal', params: {} },
    { name: 'nvg', style: 'surveillance', params: {} },
    { name: 'noir', style: 'noir', params: {} },
    {
      name: 'white-hot',
      style: 'thermal',
      params: { 'WHOT/BHOT': 0, Ironbow: 0 },
    },
    {
      name: 'black-hot',
      style: 'thermal',
      params: { 'WHOT/BHOT': 1, Ironbow: 0 },
    },
    {
      name: 'ironbow',
      style: 'thermal',
      params: { 'WHOT/BHOT': 0, Ironbow: 1 },
    },
  ];
  // Actual Boston views. Acceptance checks the measured background; a tile/key
  // failure or an unsuitable view is explicitly unexercised, never assumed bright/dark.
  const backgrounds = [
    {
      name: 'bright',
      candidates: [
        { lat: 42.3458, lon: -71.0464 },
        { lat: 42.3659, lon: -71.018 },
        { lat: 42.3526, lon: -71.0461 },
        { lat: 42.3486, lon: -71.0825 },
      ],
    },
    {
      name: 'dark',
      candidates: [
        { lat: 42.3574, lon: -71.0375 },
        { lat: 42.3554, lon: -71.0655 },
        { lat: 42.3588, lon: -71.0738 },
        { lat: 42.348, lon: -71.032 },
      ],
    },
  ];
  const evidence = [];
  for (const group of backgrounds) {
    let background, backgroundResult;
    const attempts = [];
    await selectStyle(page, 'normal');
    for (const candidate of group.candidates) {
      background = { ...candidate, name: group.name };
      await page.evaluate((b) => {
        const camera = window.__godsEyeView.viewer.camera,
          C = camera.positionCartographic.constructor;
        camera.setView({
          destination: C.toCartesian(C.fromDegrees(b.lon, b.lat, 600)),
          orientation: { heading: 0, pitch: -Math.PI / 2, roll: 0 },
        });
      }, background);
      await wait(8000);
      await page.evaluate(
        ({ background, routes }) => {
          const layer =
            window.__godsEyeView.dataManager.layers.get('transit').module;
          layer._loadTransitFleetForTest(8, background, 45, routes);
          for (const entry of layer._transitStateForTest()._vehicles.values()) {
            entry.track.rate = 0;
            layer._transitPartsForTest().rendering.schedulePlayback(entry);
          }
        },
        { background, routes },
      );
      await wait(1000);
      backgroundResult = reduceBackground(
        group.name,
        await sampleRendered(page),
      );
      attempts.push({ background, ...backgroundResult });
      if (backgroundResult.pass) break;
    }
    check(
      `Boston ${background.name}: all four routes over measured ${background.name} background`,
      backgroundResult.pass,
      JSON.stringify({ attempts, chosen: background }),
      { unexercised: !backgroundResult.pass },
    );
    for (const look of looks) {
      await selectStyle(page, look.style, look.params);
      await wait(1200);
      await reportTransitVisibility(
        page,
        `Boston ${background.name}/${look.name} visibility`,
      );
      const pixels = await sampleRendered(page);
      const modes = await page.evaluate(() => {
        const layer =
          window.__godsEyeView.dataManager.layers.get('transit').module;
        return [...layer._transitStateForTest()._vehicles.values()].map(
          (e) => ({
            key: e.key,
            route: e.record.routeId,
            image: e.marker.image,
            width: e.marker.width,
            color: e.marker.color.toCssHexString(),
          }),
        );
      });
      const contrast =
        look.name === 'normal'
          ? null
          : reduceSensorContrast(
              pixels,
              look.name === 'black-hot' ? 'black' : 'white',
              look.style,
            );
      check(
        `Boston ${background.name}/${look.name}: all four silhouettes and mode brackets readable`,
        pixels.length >= 6 &&
          pixels.every(
            (p) =>
              p.bracket &&
              p.bracketExpected &&
              Math.hypot(...p.bracket.map((v, i) => v - p.bracketExpected[i])) <
                48,
          ) &&
          (!contrast || contrast.pass),
        JSON.stringify({ pixels, contrast }),
        { unexercised: pixels.length < 6 },
      );
      await page.screenshot({
        path: `${shots}/${tag}-matrix-${background.name}-${look.name}-fleet.jpg`,
        type: 'jpeg',
        quality: 90,
      });
      for (const target of modes) {
        await page.evaluate(
          (key) =>
            window.__godsEyeView.dataManager.layers
              .get('transit')
              .module._transitPartsForTest()
              .selection.selectVehicle(key),
          target.key,
        );
        await wait(500);
        await page.screenshot({
          path: `${shots}/${tag}-matrix-${background.name}-${look.name}-${target.route}-selected.jpg`,
          type: 'jpeg',
          quality: 90,
        });
        const restored = await page.evaluate((key) => {
          const layer =
            window.__godsEyeView.dataManager.layers.get('transit').module;
          layer._transitPartsForTest().selection.clearSelection();
          const e = layer._transitStateForTest()._vehicles.get(key);
          return {
            image: e.marker.image,
            width: e.marker.width,
            color: e.marker.color.toCssHexString(),
          };
        }, target.key);
        check(
          `Boston ${background.name}/${look.name}/${target.route}: deselect restores fleet styling`,
          restored.image === target.image &&
            restored.width === target.width &&
            restored.color === target.color,
        );
      }
      await wait(300);
      await page.screenshot({
        path: `${shots}/${tag}-matrix-${background.name}-${look.name}-restored.jpg`,
        type: 'jpeg',
        quality: 90,
      });
      evidence.push({
        background,
        look,
        pixels,
        routes: modes.map((m) => m.route),
      });
    }
  }
  await selectStyle(page, 'normal');
  await writeFile(
    `${shots}/${tag}-boston-matrix.json`,
    JSON.stringify(evidence, null, 2),
  );
}

/** Real MBTA observations at oblique street views, separate from matrix fixtures. */
export async function runBostonLive({
  page,
  check,
  wait,
  shots,
  tag,
  detectOn,
  selectStyle,
  sampleRendered,
}) {
  console.log('\n== Boston live oblique streets ==');
  await page.evaluate(async () => {
    const app = window.__godsEyeView;
    await app.dataManager.setEnabled('transit', false, { source: 'qa' });
    const camera = app.viewer.camera,
      C = camera.positionCartographic.constructor;
    camera.setView({
      destination: C.toCartesian(C.fromDegrees(-71.0605, 42.3554, 600)),
      orientation: { heading: 0, pitch: -Math.PI / 4, roll: 0 },
    });
    await app.dataManager.setEnabled('transit', true, { source: 'qa' });
    const layer = app.dataManager.layers.get('transit').module;
    layer._setTransitFixtureFloorsForTest([], 0);
    await layer.update();
  });
  await wait(20000);
  await detectOn(page);
  const evidence = [];
  for (const view of [
    {
      name: 'white-hot',
      style: 'thermal',
      altitude: 120,
      heading: 0,
      pitch: -20,
      params: { 'WHOT/BHOT': 0, Ironbow: 0 },
    },
    {
      name: 'nvg',
      style: 'surveillance',
      altitude: 600,
      heading: 30,
      pitch: -45,
      params: {},
    },
    {
      name: 'noir',
      style: 'noir',
      altitude: 400,
      heading: 60,
      pitch: -35,
      params: {},
    },
  ]) {
    await page.evaluate((view) => {
      const app = window.__godsEyeView,
        camera = app.viewer.camera,
        C = camera.positionCartographic.constructor;
      app.dataManager.layers
        .get('transit')
        .module._transitPartsForTest()
        .selection.clearSelection();
      camera.setView({
        destination: C.toCartesian(
          C.fromDegrees(-71.0605, 42.3554, view.altitude),
        ),
        orientation: {
          heading: (view.heading * Math.PI) / 180,
          pitch: (view.pitch * Math.PI) / 180,
          roll: 0,
        },
      });
    }, view);
    await selectStyle(page, view.style, view.params);
    await wait(8000);
    const fleet = await page.evaluate(() => {
      const state = window.__godsEyeView.dataManager.layers
        .get('transit')
        .module._transitStateForTest();
      const entries = [...state._vehicles.values()];
      return {
        total: entries.length,
        visible: entries.filter((e) => e.marker?.show).length,
        fixtures: entries.filter((e) => e.qaFixture).length,
        routes: [
          ...new Set(
            entries.filter((e) => e.marker?.show).map((e) => e.record.routeId),
          ),
        ],
      };
    });
    check(
      `Boston live/${view.name}: observed vehicles in the oblique street view`,
      fleet.total > 0 && fleet.visible > 0 && fleet.fixtures === 0,
      JSON.stringify({ view, fleet }),
      { unexercised: fleet.visible === 0 },
    );
    const pixels = await sampleRendered(page);
    const contrast = reduceSensorContrast(pixels, 'white', view.style);
    check(
      `Boston live/${view.name}: unobscured sensor contrast`,
      contrast.pass,
      JSON.stringify(contrast),
      { unexercised: contrast.unexercised },
    );
    const target = pixels[0];
    let selection = null;
    if (target) {
      await page.mouse.click(target.x, target.y);
      await wait(250);
      selection = await page.evaluate((key) => {
        const state = window.__godsEyeView.dataManager.layers
          .get('transit')
          .module._transitStateForTest();
        return {
          expected: key,
          actual: state._selectedKey,
          pick: state._lastPickForTest ?? null,
        };
      }, target.key);
    }
    check(
      `Boston live/${view.name}: real mouse selects an observed vehicle`,
      selection?.actual === target?.key && !!target,
      JSON.stringify(selection),
      { unexercised: !target },
    );
    await page.screenshot({
      path: `${shots}/${tag}-boston-live-${view.name}.jpg`,
      type: 'jpeg',
      quality: 90,
    });
    evidence.push({ view, fleet, pixels, contrast, selection });
  }
  await writeFile(
    `${shots}/${tag}-boston-live.json`,
    JSON.stringify(evidence, null, 2),
  );
}

/** Google 3D proof: paired framebuffer reads reject coincidental road colours. */
export async function runTrailVisibility({
  page,
  check,
  wait,
  shots,
  tag,
  selectStyle,
  altitude = 600,
  pitch = 45,
}) {
  const name = 'Google 3D selected trail visible at 6 of 8 projected samples';
  await selectStyle(page, 'normal');
  await page.evaluate(
    async ({ altitude, pitch }) => {
      const app = window.__godsEyeView;
      await app.dataManager.setEnabled('transit', true, { source: 'qa' });
      if (app.mapStackController.isStackAvailable('photoreal'))
        await app.mapStackController.setStack('photoreal');
      const camera = app.viewer.camera,
        C = camera.positionCartographic.constructor;
      camera.setView({
        destination: C.toCartesian(
          C.fromDegrees(
            -97.7431,
            30.26725 - altitude / Math.tan((pitch * Math.PI) / 180) / 111320,
            altitude,
          ),
        ),
        orientation: { heading: 0, pitch: (-pitch * Math.PI) / 180, roll: 0 },
      });
    },
    { altitude, pitch },
  );
  await wait(8000);
  const setup = await page.evaluate(
    async ({ altitude, pitch }) => {
      const app = window.__godsEyeView,
        scene = app.viewer.scene;
      const layer = app.dataManager.layers.get('transit').module;
      const state = layer._transitStateForTest(),
        parts = layer._transitPartsForTest();
      const google =
        !!app.tileset &&
        app.tileset.show !== false &&
        app.mapStackController.getActiveId() === 'photoreal';
      if (!google)
        return { google: false, reason: 'visible Google 3D tileset required' };
      const C = scene.camera.positionCartographic.constructor;
      const centreLat = 30.267 + 90 / 111320;
      const floor = scene.sampleHeight(C.fromDegrees(-97.7431, centreLat));
      if (Number.isFinite(floor))
        scene.camera.setView({
          destination: C.toCartesian(
            C.fromDegrees(
              -97.7431,
              centreLat - altitude / Math.tan((pitch * Math.PI) / 180) / 111320,
              floor + altitude,
            ),
          ),
          orientation: { heading: 0, pitch: (-pitch * Math.PI) / 180, roll: 0 },
        });
      parts.selection.clearSelection();
      parts.ingestion.abortAllInFlight();
      state._activeFeeds.clear();
      for (const key of state._vehicles.keys())
        parts.ingestion.removeVehicle(key);
      clearTimeout(state._cameraDebounceTimer);
      state._cameraDebounceTimer = null;
      const { getRegisteredTransitFeed } =
        await import('/src/data/transitFeeds.js');
      const { seek, setRate } = await import('/src/data/contactPlayback.js');
      const feed = getRegisteredTransitFeed('capmetro-austin');
      if (!feed) throw new Error('CapMetro fixture feed missing');
      const now = Date.now();
      // Nine straight street fixes, 30 m apart. Use the production surface path.
      for (let i = 0; i < 9; i++) {
        const timestamp = (now - 120000 + i * 15000) / 1000;
        parts.ingestion.applySnapshot(
          feed,
          {
            fetchedAt: timestamp * 1000,
            vehicles: [
              {
                id: 'trail-visible',
                routeId: '1',
                tripId: 'trail-visible',
                lat: 30.267 + (i * 30) / 111320,
                lon: -97.7431,
                timestamp,
                timestampSource: 'vehicle',
                bearing: 0,
              },
            ],
          },
          { stale: false },
        );
      }
      const entry = state._vehicles.get(`${feed.id}:trail-visible`);
      entry.qaFixture = true;
      const clocks = { wallNowMs: now, monoNowMs: performance.now() };
      seek(entry.track, now - 45000, clocks);
      setRate(entry.track, 1, clocks);
      parts.rendering.sampleIdle(entry);
      parts.height.anchorFloors();
      parts.rendering.refreshVisibility();
      parts.rendering.maintainPresentation();
      parts.selection.selectVehicle(entry.key);
      return {
        google,
        key: entry.key,
        fixes: entry.track.count,
        startDisplayT: now - 45000,
        startLat: entry.sample.lat,
      };
    },
    { altitude, pitch },
  );
  if (!setup.google) {
    check(name, false, JSON.stringify(setup), { unexercised: true });
    return;
  }
  await wait(20000);
  const result = await page.evaluate(async (setup) => {
    const app = window.__godsEyeView,
      scene = app.viewer.scene;
    const layer = app.dataManager.layers.get('transit').module;
    const state = layer._transitStateForTest(),
      parts = layer._transitPartsForTest();
    const entry = state._vehicles.get(setup.key);
    const trail = parts.trails.diagnostics();
    if (!entry || !trail)
      return { ...setup, present: 0, reason: 'selection disappeared' };
    const { setRate } = await import('/src/data/contactPlayback.js');
    setRate(entry.track, 0, {
      wallNowMs: Date.now(),
      monoNowMs: performance.now(),
    });
    parts.rendering.sampleIdle(entry);
    parts.rendering.schedulePlayback(entry);
    parts.rendering.syncRenderHold();
    const canvas = scene.canvas,
      gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    const scale = canvas.width / canvas.clientWidth;
    const points = entry.trailSegments
      .filter((s) => s.toT <= entry.sample.displayT)
      .flatMap((s) => s.positions);
    if (trail.head?.show) points.push(...trail.head.positions);
    if (points.length < 2)
      return { ...setup, present: 0, reason: 'no completed path' };
    const C = scene.camera.positionCartographic.constructor;
    const V = entry.marker.position.constructor;
    const lengths = [0];
    for (let i = 1; i < points.length; i++)
      lengths.push(lengths.at(-1) + V.distance(points[i - 1], points[i]));
    const mul = (m, v) =>
      [0, 1, 2, 3].map(
        (i) =>
          m[i] * v[0] + m[i + 4] * v[1] + m[i + 8] * v[2] + m[i + 12] * v[3],
      );
    const samples = Array.from({ length: 8 }, (_, i) => {
      const d = (lengths.at(-1) * (i + 1)) / 9;
      let j = 1;
      while (j < lengths.length - 1 && lengths[j] < d) j++;
      const p = V.lerp(
        points[j - 1],
        points[j],
        (d - lengths[j - 1]) / Math.max(0.001, lengths[j] - lengths[j - 1]),
        new V(),
      );
      const cart = C.fromCartesian(p);
      const height = scene.sampleHeight(
        cart,
        [entry.marker, trail.body, trail.headPrimitive].filter(Boolean),
      );
      if (Number.isFinite(height)) cart.height = height;
      const surface = C.toCartesian(cart);
      const q = mul(
        scene.camera.frustum.projectionMatrix,
        mul(scene.camera.viewMatrix, [surface.x, surface.y, surface.z, 1]),
      );
      return {
        x: ((q[0] / q[3]) * 0.5 + 0.5) * canvas.clientWidth,
        y: (0.5 - (q[1] / q[3]) * 0.5) * canvas.clientHeight,
        inFront: q[3] > 0,
      };
    });
    const read = () =>
      samples.map(({ x, y, inFront }) => {
        const r = Math.ceil(3 * scale),
          px = Math.round(x * scale),
          py = Math.round(canvas.height - 1 - y * scale);
        if (
          !inFront ||
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
        return data;
      });
    const frame = () =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          remove();
          reject(new Error('Trail framebuffer did not render within 5 s'));
        }, 5000);
        const remove = scene.postRender.addEventListener(() => {
          remove();
          clearTimeout(timeout);
          resolve(read());
        });
        scene.requestRender();
      });
    const on = await frame();
    const bodyShow = trail.body?.show,
      headShow = trail.head?.show,
      backingShow = trail.backing?.show;
    const hide = () => {
      if (trail.body) trail.body.show = false;
      if (trail.headPrimitive) trail.headPrimitive.show = false;
      if (trail.head) trail.head.show = false;
      if (trail.backing) trail.backing.show = false;
    };
    // Run after the layer's own frame update, which restores selection visibility.
    const removeHide = scene.preRender.addEventListener(hide);
    let off;
    try {
      off = await frame();
    } finally {
      removeHide();
      if (trail.body) trail.body.show = bodyShow;
      if (trail.headPrimitive) trail.headPrimitive.show = true;
      if (trail.head) trail.head.show = headShow;
      if (trail.backing) trail.backing.show = backingShow;
      await frame();
    }
    return {
      ...setup,
      fixes: entry.track.count,
      selected: state._selectedKey === setup.key,
      pathMetres: lengths.at(-1),
      samples,
      on: on.map((p) => (p ? Array.from(p) : null)),
      off: off.map((p) => (p ? Array.from(p) : null)),
      elapsedDisplayMs: entry.sample.displayT - setup.startDisplayT,
      movedMetres: Math.abs(entry.sample.lat - setup.startLat) * 111320,
      body: trail.body?.constructor.name,
      headStrategy: trail.headStrategy || 'PolylineCollection',
      headRebuilds: trail.headRebuilds ?? null,
    };
  }, setup);
  const pixels = reduceTrailPixels(result.on, result.off);
  result.altitude = altitude;
  result.pitch = pitch;
  result.present = pixels.present;
  result.total = pixels.total;
  result.samples = result.samples?.map((s, i) => ({
    ...s,
    hit: pixels.hits[i],
  }));
  delete result.on;
  delete result.off;
  await page.screenshot({
    path: `${shots}/${tag}-${altitude}m-trail-visible.jpg`,
    type: 'jpeg',
    quality: 95,
  });
  await writeFile(
    `${shots}/${tag}-${altitude}m-trail-visible.json`,
    JSON.stringify(result, null, 2),
  );
  check(
    name,
    result.google &&
      result.selected &&
      result.fixes >= 5 &&
      result.pathMetres > 15 &&
      result.elapsedDisplayMs >= 19000 &&
      result.movedMetres >= 5 &&
      result.present >= 6,
    JSON.stringify(result),
  );
  await page.evaluate(() =>
    window.__godsEyeView.dataManager.layers
      .get('transit')
      .module._transitPartsForTest()
      .selection.clearSelection(),
  );
}
