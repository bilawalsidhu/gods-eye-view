import { waitForEngine } from './qa-strict-harness.mjs';
import { assertKeylessPreview } from './qa-strict-harness.mjs';
import assert from 'node:assert/strict';
import { createStrict, localPreview } from './qa-strict-harness.mjs';

const url = localPreview(process.argv[2]);
const military = process.argv.includes('--military');
const layerId = military ? 'military' : 'flights';
const aircraftId = military ? 'aaa052' : '71be26';
url.search = '?engine=navara&welcome=0';
url.hash =
  'v=2&lat=40.2539&lon=-125.5779&alt=21130&heading=360&pitch=-35&map=sentinel2' +
  (military ? '&l=m&lo=f.e.1_f.u.aaa052' : '&l=f&lo=f.e.1_f.t.71be26');
// The Command Dock, and the Globe Engine picker in it, is hidden in cockpit
// mode: no person can pick an engine there, so the cockpit switches below go
// through the select element; the real picker is used once the cockpit is
// left.
const HIDDEN_PICKER = 'the Globe Engine picker is hidden in cockpit mode';
const strict = createStrict({ origin: url.origin, layers: [layerId] });
await strict.run({}, async (browser) => {
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.setViewport({ width: 1280, height: 720 });
  await page.evaluateOnNewDocument(
    (layerId, aircraftId) => {
      window.__qaAircraft = { layerId, aircraftId };
      const fetch = window.fetch.bind(window);
      window.__flightPolls = 0;
      const interval = window.setInterval.bind(window);
      window.setInterval = function (callback, delay, ...args) {
        if (typeof callback !== 'function')
          return interval(callback, delay, ...args);
        const id = interval(
          function (...values) {
            if (window.__handoff?.timer === id) window.__handoff.ticks++;
            return callback.apply(this, values);
          },
          delay,
          ...args,
        );
        return id;
      };
      window.fetch = (input, options) => {
        const path = new URL(input.url ?? input, document.baseURI).pathname;
        const now = Math.floor(Date.now() / 1000);
        if (path === '/api/flights') {
          if (layerId === 'flights') window.__flightPolls++;
          return Promise.resolve(
            Response.json({
              time: now,
              states: [
                [
                  '71be26',
                  'GEV123',
                  'QA',
                  now,
                  now,
                  -125.5779,
                  40.2539,
                  9700,
                  false,
                  200,
                  45,
                  0,
                  null,
                  9700,
                  null,
                  false,
                  0,
                ],
              ],
            }),
          );
        }
        if (path === '/api/military') {
          if (layerId === 'military') window.__flightPolls++;
          return Promise.resolve(
            Response.json({
              now: Date.now(),
              ac: [
                {
                  hex: 'aaa052',
                  flight: 'GEVMIL',
                  lon: -125.5779,
                  lat: 40.2539,
                  alt_geom: 31825,
                  alt_baro: 31825,
                  gs: 389,
                  track: 45,
                  seen: 0,
                  seen_pos: 0,
                  dbFlags: 1,
                  type: 'adsb_icao',
                },
              ],
            }),
          );
        }
        if (path === '/api/flights/track')
          return Promise.resolve(Response.json({ path: [] }));
        if (path.startsWith('/api/flights/'))
          return Promise.resolve(Response.json({}));
        return fetch(input, options);
      };
    },
    layerId,
    aircraftId,
  );
  await page.goto(url.href, { waitUntil: 'domcontentloaded' });
  await waitForEngine(page, 'navara');
  // Cockpit mode deliberately holds camera inputs throughout these handoffs.
  const attached = (kind) => waitForEngine(page, kind, { timeout: 90000 });
  await page.evaluate(
    () => window.__godsEyeView.styleManager.initialRestorePromise,
  );
  await page.waitForSelector('#cockpit-entry', { visible: true });
  await page.click('#cockpit-entry');
  await page.waitForFunction(
    () => window.__godsEyeView.styleManager.getCockpitState().active,
  );
  await assertKeylessPreview(page);
  await page.evaluate(() => {
    const { dataManager, styleManager } = window.__godsEyeView;

    styleManager.cockpitView.setVisionMode('thermal');
    const entry = dataManager.layers.get(window.__qaAircraft.layerId);
    window.__handoff = {
      dataManager,
      entry,
      row: document.querySelector(
        `[data-layer-id="${window.__qaAircraft.layerId}"] .data-toggle-btn`,
      ),
      timer: entry.intervalId,
      ticks: 0,
      model: entry.module,
      pollCount: window.__flightPolls,
      timestamp: entry.module.getStats().lastUpdate,
    };
  });
  // Refuse the first Cesium canvas. The application must roll back with the
  // original aircraft still in the cockpit, then allow an ordinary retry.
  await page.evaluate(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...args) {
      if (String(type).includes('webgl')) {
        window.__refusedContext = true;
        throw new Error('QA renderer startup failure');
      }
      return original.call(this, type, ...args);
    };
    window.__restoreContext = () => {
      HTMLCanvasElement.prototype.getContext = original;
    };
  });
  const historyLength = await page.evaluate(() => history.length);
  await strict.selectEngine(page, 'cesium', HIDDEN_PICKER);
  await page.waitForFunction(() => window.__refusedContext === true);
  await attached('navara');
  // A failed switch leaves the session usable on the engine that worked and
  // adds no history entry.
  const survived = (kind) =>
    page.evaluate(
      (kind, length) => {
        const { dataManager, engine, styleManager } = window.__godsEyeView;
        return (
          engine.kind === kind &&
          new URL(location.href).searchParams.get('engine') === kind &&
          history.length === length &&
          dataManager === window.__handoff.dataManager &&
          dataManager.layers.get(window.__qaAircraft.layerId) ===
            window.__handoff.entry &&
          styleManager.getCockpitState().active &&
          styleManager.getCockpitState().visionMode === 'thermal' &&
          styleManager.getAircraftTrackingTarget()?.id ===
            window.__qaAircraft.aircraftId
        );
      },
      kind,
      historyLength,
    );
  await page.evaluate(() => window.__restoreContext());
  await strict.check(
    page,
    layerId,
    'cold Cesium failure rolls back to Navara: same session, cockpit, aircraft, no history entry',
    await survived('navara'),
  );
  console.log(
    'PASS cold Cesium failure rolled back to Navara with the same flight, cockpit and history',
  );

  for (const kind of ['cesium', 'navara']) {
    await strict.selectEngine(page, kind, HIDDEN_PICKER);
    await attached(kind);
    const result = await page.evaluate(() => {
      const { dataManager, engine, styleManager } = window.__godsEyeView;
      const before = window.__handoff;
      const entry = dataManager.layers.get(window.__qaAircraft.layerId);
      const cockpit = styleManager.getCockpitState();
      return {
        sameOwner:
          before.dataManager === dataManager &&
          before.entry === entry &&
          before.model === entry.module,
        sameRow:
          Boolean(before.row) &&
          before.row ===
            document.querySelector(
              `[data-layer-id="${window.__qaAircraft.layerId}"] .data-toggle-btn`,
            ),
        sameTimer:
          before.timer === entry.intervalId && entry.intervalId != null,
        sourcePolls: window.__flightPolls - before.pollCount,
        timerTicks: before.ticks,
        stamp: entry.module.getStats().lastUpdate,
        initialStamp: before.timestamp,
        id: cockpit.subject?.id,
        active: cockpit.active,
        mode: cockpit.visionMode,
        hud: !document.querySelector('#cockpit-hud').hidden,
        drawn: entry.module
          .qaDrawn()
          .some((row) => row.id === window.__qaAircraft.aircraftId),
        height: engine.camera.height(),
      };
    });
    assert.ok(
      result.sameOwner &&
        result.sameTimer &&
        result.sameRow &&
        result.active &&
        result.hud &&
        result.drawn,
      JSON.stringify(result),
    );
    assert.equal(result.id, aircraftId);
    assert.equal(result.mode, 'thermal');
    assert.ok(
      result.sourcePolls <= result.timerTicks,
      'switch must not add a source request',
    );
    if (result.timerTicks === 0) {
      assert.equal(result.stamp, result.initialStamp);
    }
    await strict.passed(
      page,
      layerId,
      'same manager entry, model, row, poll timer, cockpit, thermal mode, HUD and drawn aircraft',
      result,
    );
    // Polling goes on after the switch: the same timer ticks and each tick
    // reads the source once (no tick may be skipped, none added).
    const pollStart = await page.evaluate((layerId) => {
      const entry = window.__godsEyeView.dataManager.layers.get(layerId);
      return {
        layerId,
        every:
          Number(entry.module.refreshInterval) ||
          Number(entry.module.updateInterval),
        polls: window.__flightPolls,
        ticks: window.__handoff.ticks,
        stamp: entry.module.getStats().lastUpdate,
      };
    }, layerId);
    await page.waitForFunction(
      (start) => {
        const entry = window.__godsEyeView.dataManager.layers.get(start.layerId);
        const ticks = window.__handoff.ticks - start.ticks;
        return (
          ticks >= 2 &&
          window.__flightPolls - start.polls === ticks &&
          entry.module.getStats().lastUpdate !== start.stamp
        );
      },
      { timeout: 2.5 * pollStart.every + 5000 },
      pollStart,
    );
    const polls = await page.evaluate((start) => {
      const entry = window.__godsEyeView.dataManager.layers.get(start.layerId);
      return {
        every: start.every,
        ticks: window.__handoff.ticks - start.ticks,
        polls: window.__flightPolls - start.polls,
        updated: entry.module.getStats().lastUpdate !== start.stamp,
        sameTimer: entry.intervalId === window.__handoff.timer,
      };
    }, pollStart);
    await strict.check(
      page,
      layerId,
      'polling continues after the switch: two timer ticks, one source read each, fresh data',
      polls.every > 0 &&
        polls.ticks >= 2 &&
        polls.polls === polls.ticks &&
        polls.updated &&
        polls.sameTimer,
      polls,
    );
    await page.waitForFunction(
      () => Math.abs(window.__godsEyeView.engine.camera.height() - 9700) < 1000,
    );
    console.log(
      `PASS ${kind} cockpit, aircraft, HUD, manager and timer (${result.sourcePolls} polls since entry)`,
    );
  }
  // The other direction, warm: the parked Navara renderer fails to resume on
  // the way back from Cesium. The session rolls back to Cesium, then an
  // ordinary retry starts Navara cold.
  await page.evaluate(() => {
    window.__parkedNavara = window.__godsEyeView.engine;
  });
  await strict.selectEngine(page, 'cesium', HIDDEN_PICKER);
  await attached('cesium');
  const lengthOnCesium = await page.evaluate(() => {
    const request = window.__parkedNavara.render.request;
    window.__parkedNavara.render.request = function (...args) {
      window.__parkedNavara.render.request = request;
      window.__refusedResume = true;
      throw new Error('QA parked renderer failure');
    };
    return history.length;
  });
  await strict.selectEngine(page, 'navara', HIDDEN_PICKER);
  await page.waitForFunction(() => window.__refusedResume === true);
  await attached('cesium');
  assert.ok(
    (await page.evaluate(
      (length) => history.length === length,
      lengthOnCesium,
    )) &&
      (await page.evaluate(() => {
        const { styleManager } = window.__godsEyeView;
        return (
          styleManager.getCockpitState().active &&
          styleManager.getAircraftTrackingTarget()?.id ===
            window.__qaAircraft.aircraftId &&
          new URL(location.href).searchParams.get('engine') === 'cesium'
        );
      })),
    'a failed warm Navara resume must leave Cesium usable without a history entry',
  );
  await strict.passed(
    page,
    layerId,
    'warm Navara failure rolls back to Cesium: same aircraft and cockpit, no history entry',
  );
  console.log(
    'PASS warm Navara failure rolled back to Cesium with the same flight and cockpit',
  );
  await page.evaluate(() => {
    window.__parkedCesium = window.__godsEyeView.engine;
  });
  await strict.selectEngine(page, 'navara', HIDDEN_PICKER);
  await attached('navara');
  assert.ok(
    await page.evaluate(() => {
      const { engine, styleManager } = window.__godsEyeView;
      return (
        engine !== window.__parkedNavara &&
        styleManager.getCockpitState().active &&
        styleManager.getAircraftTrackingTarget()?.id ===
          window.__qaAircraft.aircraftId
      );
    }),
    'the retry starts a new Navara renderer on the same session',
  );
  console.log('PASS retry after the warm failure started Navara cold');

  // Both engines fail: the warm Cesium resume and the warm Navara recovery.
  // No engine runs, but the error screen offers the engine picker, and a
  // retry starts Cesium cold on the same session without a reload.
  const lengthBeforeDoubleFailure = await page.evaluate(() => {
    window.__failResume = true;
    for (const engine of [window.__godsEyeView.engine, window.__parkedCesium]) {
      const request = engine.render.request;
      engine.render.request = function (reason, ...args) {
        if (reason === 'engine-resume' && window.__failResume) {
          window.__refusedResumes = (window.__refusedResumes ?? 0) + 1;
          throw new Error('QA parked renderer failure');
        }
        return request.call(this, reason, ...args);
      };
    }
    window.__startDocument = document;
    return history.length;
  });
  await strict.selectEngine(page, 'cesium', HIDDEN_PICKER);
  await page
    .waitForSelector('#loading-screen .engine-switch-retry button', {
      visible: true,
      timeout: 90000,
    })
    .catch(async (error) => {
      console.log(
        'no retry picker',
        JSON.stringify(
          await page.evaluate(() => ({
            refused: window.__refusedResumes,
            engine: window.__godsEyeView?.engine?.kind ?? null,
            retry: !!document.querySelector('.engine-switch-retry'),
            loading: document.querySelector('#loading-screen')?.className,
            status: document.querySelector('#loading-screen .loader-status')
              ?.textContent,
            address: location.search,
          })),
        ),
      );
      throw error;
    });
  assert.ok(
    await page.evaluate(
      (length) =>
        window.__refusedResumes === 2 &&
        // No globe runs (the page's debug object may stay, without one).
        !window.__godsEyeView?.engine &&
        history.length === length &&
        !document
          .querySelector('#loading-screen')
          .classList.contains('hidden') &&
        /QA parked renderer failure/.test(
          document.querySelector('#loading-screen .loader-status').textContent,
        ),
      lengthBeforeDoubleFailure,
    ),
    'a failed recovery shows its error and the engine picker ' +
      JSON.stringify(
        await page.evaluate(() => ({
          refused: window.__refusedResumes,
          app: !!window.__godsEyeView,
          engine: window.__godsEyeView?.engine?.kind ?? null,
          history: history.length,
          loading: document.querySelector('#loading-screen')?.className,
          status: document.querySelector('#loading-screen .loader-status')
            ?.textContent,
        })),
      ),
  );
  await page.evaluate(() => {
    window.__failResume = false;
  });
  await page.click(
    '#loading-screen .engine-switch-retry [data-engine="cesium"]',
  );
  await attached('cesium');
  assert.ok(
    await page.evaluate(() => {
      const { dataManager, styleManager } = window.__godsEyeView;
      return (
        window.__startDocument === document &&
        !document.querySelector('.engine-switch-retry') &&
        dataManager === window.__handoff.dataManager &&
        dataManager.layers.get(window.__qaAircraft.layerId) ===
          window.__handoff.entry &&
        styleManager.getCockpitState().active &&
        styleManager.getAircraftTrackingTarget()?.id ===
          window.__qaAircraft.aircraftId &&
        new URL(location.href).searchParams.get('engine') === 'cesium'
      );
    }),
    'the retry restores the same session on Cesium',
  );
  await strict.passed(
    page,
    layerId,
    'after both engines fail, the retry restores the same session',
  );
  console.log(
    'PASS failed recovery offered the picker; the retry restored the session on Cesium',
  );
  await page.evaluate(() =>
    window.__godsEyeView.styleManager.controlCockpit('exit'),
  );
  await page.waitForFunction(
    () => !window.__godsEyeView.styleManager.getCockpitState().active,
  );
  // Out of the cockpit the dock shows the picker again: a switch with
  // real input keeps the same entry and timer, the aircraft drawn, and the
  // source polled on its timer.
  await page.evaluate(() => {
    window.__handoff.ticks = 0;
    window.__handoff.pollCount = window.__flightPolls;
    window.__handoff.timer = window.__godsEyeView.dataManager.layers.get(
      window.__qaAircraft.layerId,
    ).intervalId;
  });
  await strict.pick(page, 'navara');
  await waitForEngine(page, 'navara');
  const every = await page.evaluate(() => {
    const entry = window.__godsEyeView.dataManager.layers.get(
      window.__qaAircraft.layerId,
    );
    return (
      Number(entry.module.refreshInterval) ||
      Number(entry.module.updateInterval)
    );
  });
  await page.waitForFunction(
    () =>
      window.__handoff.ticks >= 1 &&
      window.__flightPolls - window.__handoff.pollCount === window.__handoff.ticks,
    { timeout: 2.5 * every + 5000 },
  );
  const after = await page.evaluate(() => {
    const { dataManager } = window.__godsEyeView;
    const entry = dataManager.layers.get(window.__qaAircraft.layerId);
    return {
      same:
        dataManager === window.__handoff.dataManager &&
        entry === window.__handoff.entry,
      timer: entry.intervalId === window.__handoff.timer,
      drawn: entry.module
        .qaDrawn()
        .some((row) => row.id === window.__qaAircraft.aircraftId),
      ticks: window.__handoff.ticks,
      polls: window.__flightPolls - window.__handoff.pollCount,
    };
  });
  await strict.check(
    page,
    layerId,
    'picker switch keeps the entry, timer and drawn aircraft; polling continues',
    after.same &&
      after.timer &&
      after.drawn &&
      after.ticks >= 1 &&
      after.polls === after.ticks,
    after,
  );
  assert.deepEqual(errors, []);
});
