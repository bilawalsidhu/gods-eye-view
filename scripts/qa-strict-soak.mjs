// Soak and switch timing under a mixed workload: radio playing (750
// stations), earthquakes, 10 000 flights, 200 military aircraft, wind with
// its GPU particles, and the traffic simulation, all from fixtures.
//
// Each run starts a fresh browser on one engine and switches with real
// input on the picker. Run r starts on Navara when r is odd and on Cesium
// when it is even, so the first switch of each run is a cold one in either
// direction.
//
// "First frame" of a switch: the first postRender of the incoming engine
// whose picture, read back from its canvas in that callback, is not blank,
// then the next animation frame (presented). Timed in the page from the
// picker's change event, so no CDP round trip is included.
//
// Checked on every switch: the same session (manager and every layer
// model), the radio still playing the same station with one play() call.
// With --assert (the long run), the flights' fix history fills first (see
// below), then after the warm-up (switch 20): live WebGL
// objects per engine context grow by at most 0.1 per switch (least-squares
// slope over the checkpoints) and by at most 64 overall; no new WebGL
// context; the JS objects grow by at most 10 KiB per switch and native
// memory by at most 32 KiB (heap snapshots at the warm-up and the end, V8's
// compiled code left out and reported apart, with the used heap's slope); no
// new document; the webglcontextlost/restored listener counts on both engine
// canvases stay as they were (each canvas keeps its webglcontextlost
// listener).
//
//   node scripts/qa-strict-soak.mjs http://127.0.0.1:4208 --runs=6 --swaps=50
//   node scripts/qa-strict-soak.mjs http://127.0.0.1:4208 --runs=1 --swaps=500 --assert

import { closeBrowser } from './qa/browser.mjs';
import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  installFirstFrameProbe,
  installSessionFixtures,
  installWebGlCounters,
  openApp,
  quantile,
  rememberEngine,
  slope,
  startSession,
} from './qa-strict-session.mjs';
import { installRadioFixture, stations } from './fixtures/layers/radio.mjs';
import { trafficFixtureResponse } from './traffic-fixtures.mjs';
import { POSITION_HISTORY_LIMIT } from '../src/layers/flights/recordPolicy.js';
import { heapSizesByType } from './qa/heapSnapshotSizes.mjs';

const base = localPreview(process.argv[2]);
const option = (name, fallback) => {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  return arg ? Number(arg.slice(name.length + 3)) : fallback;
};
const runs = option('runs', 6);
const swaps = option('swaps', 50);
const strictMode = process.argv.includes('--assert');
assert.ok(
  Number.isInteger(swaps) && swaps >= 4 && swaps % 2 === 0,
  'even --swaps',
);
const WARM_UP = 20;
const CHECKPOINTS = [
  2, 10, 20, 50, 100, 150, 200, 250, 300, 350, 400, 450, 500,
];
const HASH =
  'v=2&lat=30.2670&lon=-97.7440&alt=3000&heading=0&pitch=-90&map=osm&l=';
const LAYERS = [
  'earthquakes',
  'flights',
  'military',
  'wind',
  'traffic',
  'radio',
];

const strict = createStrict({
  origin: base.origin,
  layers: [],
  // Road tiles of the traffic simulation, from scripts/traffic-fixtures.mjs.
  fixtures: ['https://tiles.openfreemap.org/*'],
});

/** Wind and traffic fixtures on their own CDP Fetch patterns. */
async function installWorkloadFixtures(page) {
  const session = await page.createCDPSession();
  const grid = (u) => {
    const kind = u.searchParams.get('overlay');
    const count = 36 * 19;
    const values = new Float32Array(count * (kind ? 3 : 2));
    values.fill(8, 0, count);
    values.fill(6, count, count * 2);
    if (kind) values.fill(40, count * 2);
    return Buffer.from(values.buffer);
  };
  session.on('Fetch.requestPaused', async ({ requestId, request }) => {
    const u = new URL(request.url);
    let answer;
    try {
      if (u.pathname.startsWith('/api/wind/')) {
        const model = u.searchParams.get('model');
        answer = u.pathname.endsWith('/manifest')
          ? {
              status: 200,
              contentType: 'application/json',
              body: JSON.stringify({
                model,
                overlay: 'none',
                grid: { nx: 36, ny: 19, lo1: 0, la1: 90, dx: 10, dy: 10 },
                gridUrl: '/api/wind/grid/' + model + '-qa.bin' + u.search,
                cycle: {
                  validIso: '2026-11-02T12:00:00Z',
                  runIso: '2026-11-02T06:00:00Z',
                },
              }),
            }
          : {
              status: 200,
              contentType: 'application/octet-stream',
              body: grid(u),
            };
      } else if (u.pathname === '/api/tomtom/status')
        answer = {
          status: 200,
          contentType: 'application/json',
          body: '{"hasKey":false}',
        };
      else answer = trafficFixtureResponse({ url: () => request.url });
      await session.send('Fetch.fulfillRequest', {
        requestId,
        responseCode: answer.status,
        responseHeaders: [
          { name: 'Content-Type', value: answer.contentType },
          { name: 'Access-Control-Allow-Origin', value: '*' },
        ],
        body: Buffer.from(answer.body).toString('base64'),
      });
    } catch {
      await session
        .send('Fetch.failRequest', { requestId, errorReason: 'Failed' })
        .catch(() => {});
    }
  });
  await session.send('Fetch.enable', {
    patterns: [
      { urlPattern: `${base.origin}/api/wind/*` },
      { urlPattern: `${base.origin}/api/tomtom/*` },
      { urlPattern: 'https://tiles.openfreemap.org/*' },
    ],
  });
}

const report = { runs: [], swaps, strict: strictMode };
strict.extra.soak = report;

for (let run = 1; run <= runs; run++) {
  const start = run % 2 ? 'navara' : 'cesium';
  const browser = await strict.launch();
  const row = { run, start, swaps: [], checkpoints: [], errors: [] };
  report.runs.push(row);
  try {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    p.on('pageerror', (e) => row.errors.push(e.message.slice(0, 300)));
    await installRadioFixture(p);
    await installSessionFixtures(p, { flights: 10000, military: 200 });
    await installWebGlCounters(p);
    await installFirstFrameProbe(p);
    await installWorkloadFixtures(p);
    const cdp = await p.createCDPSession();
    await openApp(p, base.origin, start, HASH);
    await startSession(p, LAYERS);
    await p.waitForFunction(
      () => {
        const layers = window.__godsEyeView.dataManager.layers;
        const stat = (id) => layers.get(id).module.getStats();
        return (
          stat('radio').count === 750 &&
          stat('flights').count > 0 &&
          stat('military').count > 0 &&
          stat('traffic').count >= 10 &&
          layers.get('wind').module.getDiagnostics().gpu?.ready
        );
      },
      { timeout: 90000, polling: 500 },
    );
    await p.evaluate((id) => {
      const radio = window.__godsEyeView.dataManager.layers.get('radio').module;
      radio.selectStation(id, { autoplay: true, focus: false, origin: 'user' });
      window.__qaRadio.station = id;
    }, stations[10].id);
    await p.waitForFunction(
      () =>
        window.__qaRadio.plays.length === 1 &&
        window.__godsEyeView.dataManager.layers.get('radio').module.getUIState()
          .audioState === 'playing',
    );
    // Each aircraft keeps its last POSITION_HISTORY_LIMIT fixes for dead
    // reckoning, so the first polls of the flights feed grow the heap by
    // itself (about 14 MiB here, over 2.5 min; a run without switches then
    // levels off). The long run lets that history fill before it switches,
    // so the heap slope it asserts is the switches' own.
    if (strictMode) {
      const filling = Date.now();
      await p.waitForFunction(
        (polls) => window.__qaReads.flights > polls,
        { timeout: 300000, polling: 1000 },
        POSITION_HISTORY_LIMIT,
      );
      row.historyFillSeconds = Math.round((Date.now() - filling) / 1000);
    }
    row.workload = await p.evaluate(() => {
      const layers = window.__godsEyeView.dataManager.layers;
      return Object.fromEntries(
        ['flights', 'military', 'traffic', 'radio', 'earthquakes'].map((id) => [
          id,
          layers.get(id).module.getStats().count,
        ]),
      );
    });
    const listeners = async () => {
      const { result } = await cdp.send('Runtime.evaluate', {
        includeCommandLineAPI: true,
        returnByValue: true,
        expression: `(() => Object.fromEntries([...window.__qaEngines].map(([kind, engine]) => {
          const events = getEventListeners(engine.host.canvas);
          return [kind, [events.webglcontextlost?.length ?? 0, events.webglcontextrestored?.length ?? 0]];
        })))()`,
      });
      return result.value;
    };
    const seen = new Set([start]);
    let kind = start;
    // The switch after a heap snapshot is slower; timings leave it out.
    let afterSnapshot = false;
    for (let i = 1; i <= swaps; i++) {
      kind = kind === 'navara' ? 'cesium' : 'navara';
      const cold = !seen.has(kind);
      seen.add(kind);
      await p.evaluate((kind) => {
        window.__qaFrame = window.__qaFirstFrame(kind);
      }, kind);
      const pick = await strict.pick(p, kind);
      await waitForEngine(p, kind);
      const frame = await p.evaluate(() => window.__qaFrame);
      await rememberEngine(p);
      const state = await p.evaluate(() => {
        const { dataManager } = window.__godsEyeView;
        const session = window.__qaSession;
        const radio = dataManager.layers.get('radio').module;
        return {
          session:
            dataManager === session.manager &&
            [...session.models].every(
              ([id, model]) => dataManager.layers.get(id)?.module === model,
            ),
          radio:
            window.__qaRadio.plays.length === 1 &&
            radio.getUIState().audioState === 'playing' &&
            radio.getUIState().selected?.id === window.__qaRadio.station,
        };
      });
      assert.ok(
        state.session && state.radio,
        `swap ${i}: ${JSON.stringify(state)}`,
      );
      row.swaps.push({
        i,
        to: kind,
        cold,
        firstFrameMs: Math.round((frame.presented - pick.at) * 10) / 10,
        drawnMs: Math.round((frame.drawn - pick.at) * 10) / 10,
        settledMs:
          pick.idleAt == null
            ? null
            : Math.round((pick.idleAt - pick.at) * 10) / 10,
        ...(afterSnapshot ? { afterSnapshot } : {}),
      });
      afterSnapshot = false;
      if (CHECKPOINTS.includes(i) || i === swaps) {
        await cdp.send('HeapProfiler.collectGarbage');
        const heap = await cdp.send('Runtime.getHeapUsage');
        // The heap by snapshot node type, at the first checkpoint after the
        // warm-up and at the last: the asserted growth is the JS objects'
        // (V8's compiled code grows with tier-ups over a long run; native
        // memory, array buffer data included, is reported apart). The switch
        // after a snapshot is left out of the timings.
        let typesMiB = null;
        if (strictMode && (i === WARM_UP || i === swaps)) {
          const sizes = await heapSizesByType(cdp);
          typesMiB = Object.fromEntries(
            Object.entries(sizes).map(([type, bytes]) => [
              type,
              Math.round((bytes / 1048576) * 100) / 100,
            ]),
          );
          afterSnapshot = true;
        }
        const dom = await cdp.send('Memory.getDOMCounters');
        row.checkpoints.push({
          swap: i,
          engine: kind,
          heapMiB: Math.round((heap.usedSize / 1048576) * 100) / 100,
          typesMiB,
          ...dom,
          listeners: await listeners(),
          webgl: await p.evaluate(() => window.__qaGlCounts()),
        });
      }
    }
  } finally {
    await closeBrowser(browser);
  }
  const warm = (to) =>
    row.swaps
      .filter((s) => !s.cold && !s.afterSnapshot && s.to === to)
      .map((s) => s.firstFrameMs);
  row.summary = Object.fromEntries(
    ['navara', 'cesium'].map((to) => [
      to,
      {
        cold:
          row.swaps.find((s) => s.cold && s.to === to)?.firstFrameMs ?? null,
        warmP50: quantile(warm(to), 0.5),
        warmP95: quantile(warm(to), 0.95),
      },
    ]),
  );
  console.log(
    'RUN',
    JSON.stringify({ run, start, ...row.summary, workload: row.workload }),
  );
}

// Pooled over the runs, per direction.
const pooled = (to, cold) =>
  report.runs.flatMap((r) =>
    r.swaps
      .filter((s) => s.to === to && s.cold === cold && !s.afterSnapshot)
      .map((s) => s.firstFrameMs),
  );
report.summary = Object.fromEntries(
  ['navara', 'cesium'].map((to) => [
    to === 'navara' ? 'cesium→navara' : 'navara→cesium',
    {
      cold: pooled(to, true),
      warmP50: quantile(pooled(to, false), 0.5),
      warmP95: quantile(pooled(to, false), 0.95),
      warmSwitches: pooled(to, false).length,
    },
  ]),
);
console.log('SOAK', JSON.stringify(report.summary));
strict.timings.push(
  ...report.runs.flatMap((r) => r.swaps.map((s) => ({ run: r.run, ...s }))),
);

if (strictMode) {
  const checks = [];
  for (const row of report.runs) {
    const late = row.checkpoints.filter((c) => c.swap >= WARM_UP);
    assert.ok(late.length >= 3, 'enough checkpoints after the warm-up');
    const first = late[0];
    const last = late.at(-1);
    for (const owner of ['navara', 'cesium']) {
      const totals = late.map((c) => [
        c.swap,
        c.webgl
          .filter((g) => g.owner === owner && !g.lost)
          .reduce((s, g) => s + g.total, 0),
      ]);
      checks.push({
        check: `${owner} live WebGL objects`,
        slopePerSwap: Math.round(slope(totals) * 1000) / 1000,
        from: totals[0][1],
        to: totals.at(-1)[1],
        pass: slope(totals) <= 0.1 && totals.at(-1)[1] - totals[0][1] <= 64,
      });
    }
    checks.push({
      check: 'WebGL contexts',
      from: first.webgl.length,
      to: last.webgl.length,
      pass: last.webgl.length === first.webgl.length,
    });
    const heap = late.map((c) => [c.swap, c.heapMiB * 1024]);
    const typed = late.filter((c) => c.typesMiB);
    assert.equal(typed.length, 2, 'heap snapshots at the warm-up and the end');
    const [from, to] = typed;
    const outside = new Set(['code', 'native', 'synthetic']);
    const objects = (c) =>
      Object.entries(c.typesMiB)
        .filter(([type]) => !outside.has(type))
        .reduce((sum, [, mib]) => sum + mib, 0);
    const perSwitch = (mib) =>
      Math.round(((mib * 1024) / (to.swap - from.swap)) * 100) / 100;
    const objectGrowth = perSwitch(objects(to) - objects(from));
    const nativeGrowth = perSwitch(
      (to.typesMiB.native ?? 0) - (from.typesMiB.native ?? 0),
    );
    checks.push({
      check: 'JS heap KiB per switch',
      objectsKiBPerSwitch: objectGrowth,
      fromMiB: Math.round(objects(from) * 100) / 100,
      toMiB: Math.round(objects(to) * 100) / 100,
      // Reported, not asserted: the used heap's slope (compiled code
      // included) and compiled code's growth.
      usedSlopePerSwap: Math.round(slope(heap) * 100) / 100,
      codeKiBPerSwitch: perSwitch(
        (to.typesMiB.code ?? 0) - (from.typesMiB.code ?? 0),
      ),
      nativeKiBPerSwitch: nativeGrowth,
      pass: objectGrowth <= 10 && nativeGrowth <= 32,
    });
    checks.push({
      check: 'documents',
      from: first.documents,
      to: last.documents,
      pass: last.documents <= first.documents,
    });
    checks.push({
      check: 'context-loss listeners on both canvases',
      from: first.listeners,
      to: last.listeners,
      pass:
        JSON.stringify(last.listeners) === JSON.stringify(first.listeners) &&
        Object.keys(last.listeners).length === 2 &&
        Object.values(last.listeners).every(([lost]) => lost > 0),
    });
  }
  report.checks = checks;
  for (const check of checks)
    console.log(check.pass ? 'PASS' : 'FAIL', JSON.stringify(check));
  await strict.finishAndExit({
    failed: checks.some((c) => !c.pass) ? 'soak checks failed' : null,
  });
} else await strict.finishAndExit();
