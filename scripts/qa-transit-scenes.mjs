import { reportTransitVisibility } from './qa-transit-browser.mjs';
import { writeFile } from 'node:fs/promises';
import {
  reduceFleet,
  reduceMotion,
  reduceBackground,
  reduceSensorContrast,
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
