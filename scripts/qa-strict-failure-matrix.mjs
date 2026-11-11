// Contract: failure injection in both directions, cold and warm, and a slow
// first frame. Each case starts on a fresh page with a session (earthquakes
// and flights, one aircraft selected) and switches with real input on the
// picker.
//
// - A failed switch rolls back to the engine that was running, with the
//   same session (manager, every layer model, enabled layers, selection),
//   the address still naming it and no history entry; an ordinary pick
//   afterwards succeeds and adds exactly one entry.
//   cold: the incoming engine cannot get a WebGL context;
//   warm: the parked incoming engine fails to resume.
// - A first frame slower than 10 s (animation frames held for 12 s) does not
//   roll back: the switch completes, the cover goes after the 10 s wait, one
//   history entry, the session intact, and the frame arrives.
//
//   node scripts/qa-strict-failure-matrix.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  assertSession,
  installFirstFrameProbe,
  installSessionFixtures,
  openApp,
  rememberEngine,
  SESSION_HASH,
  sessionState,
  startSession,
} from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const other = (kind) => (kind === 'navara' ? 'cesium' : 'navara');
const strict = createStrict({ origin: base.origin, layers: [] });
const results = [];
strict.extra.contracts = results;
await strict.run({}, async (b) => {
  // A fresh page on `start` with the session; `warm` visits the other
  // engine first so it is parked.
  const open = async (start, warm) => {
    const p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    p.errors = [];
    p.on('pageerror', (e) => p.errors.push(e.message));
    await installSessionFixtures(p, { flights: 20 });
    await installFirstFrameProbe(p);
    // Flights on with the first fixture aircraft tracked (the address's
    // layer options), so the session carries a selection.
    await openApp(
      p,
      base.origin,
      start,
      SESSION_HASH.replace(/&l=$/, '&l=f&lo=f.e.1_f.t.a00000'),
    );
    await startSession(p, ['earthquakes', 'flights']);
    await p.waitForFunction(
      () =>
        window.__godsEyeView.styleManager.getAircraftTrackingTarget()?.id ===
        'a00000',
      { timeout: 30000 },
    );
    if (warm) {
      await strict.pick(p, other(start));
      await waitForEngine(p, other(start));
      await rememberEngine(p);
      await strict.pick(p, start);
      await waitForEngine(p, start);
      await rememberEngine(p);
      // The warm-up's Navara→Cesium switch drops the tracked aircraft (a
      // defect of its own, reported); track it
      // again so this case tests the failure path with a selection.
      await p.evaluate(() =>
        window.__godsEyeView.dataManager.layers
          .get('flights')
          .module.trackById('a00000', { origin: 'user' }),
      );
      await p.waitForFunction(
        () =>
          window.__godsEyeView.styleManager.getAircraftTrackingTarget()?.id ===
          'a00000',
        { timeout: 30000 },
      );
    }
    return p;
  };
  const selection = (p) =>
    p.evaluate(
      () =>
        window.__godsEyeView?.styleManager.getAircraftTrackingTarget()?.id ??
        null,
    );

  for (const [start, temperature] of [
    ['navara', 'cold'],
    ['cesium', 'cold'],
    ['cesium', 'warm'],
    ['navara', 'warm'],
  ]) {
    const target = other(start);
    const label = `${temperature} ${start}→${target} failure`;
    const p = await open(start, temperature === 'warm');
    const before = await sessionState(p);
    const selected = await selection(p);
    if (temperature === 'cold')
      await p.evaluate(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          // The running globe already holds its context; only a new
          // globe asks for one.
          if (/webgl/i.test(String(type))) {
            window.__qaRefused = (window.__qaRefused ?? 0) + 1;
            throw new Error('QA: no WebGL context for the new globe');
          }
          return original.call(this, type, ...args);
        };
        window.__qaRestore = () => {
          HTMLCanvasElement.prototype.getContext = original;
        };
      });
    else
      await p.evaluate((target) => {
        const parked = window.__qaEngines.get(target);
        const request = parked.render.request;
        parked.render.request = function (reason, ...args) {
          if (reason === 'engine-resume' && !window.__qaRestored) {
            window.__qaRefused = (window.__qaRefused ?? 0) + 1;
            throw new Error('QA: the parked globe failed to resume');
          }
          return request.call(this, reason, ...args);
        };
        window.__qaRestore = () => {
          window.__qaRestored = true;
        };
      }, target);
    await strict.pick(p, target);
    await waitForEngine(p, start);
    const refused = await p.evaluate(() => window.__qaRefused ?? 0);
    const rolled = await assertSession(p, start, label + ': rollback');
    // The tracked aircraft, given up to 10 s to be re-acquired.
    const kept = await p
      .waitForFunction(
        (id) =>
          window.__godsEyeView?.styleManager.getAircraftTrackingTarget()?.id ===
          id,
        { timeout: 10000, polling: 100 },
        selected,
      )
      .then(() => selected)
      .catch(() => selection(p));
    await p.evaluate(() => window.__qaRestore());
    // An ordinary pick afterwards.
    await strict.pick(p, target);
    await waitForEngine(p, target);
    const retried = await assertSession(p, target, label + ': retry');
    const afterRetry = await p
      .waitForFunction(
        (id) =>
          window.__godsEyeView?.styleManager.getAircraftTrackingTarget()?.id ===
          id,
        { timeout: 10000, polling: 100 },
        selected,
      )
      .then(() => selected)
      .catch(() => selection(p));
    const row = {
      case: label,
      refused,
      rollbackTarget: rolled.engine,
      historyAfterFailure: rolled.history - before.history,
      selectionKept: kept === selected,
      selectionAfterRollback: kept,
      historyAfterRetry: retried.history - before.history,
      selectionAfterRetry: afterRetry,
      errors: p.errors.length,
    };
    row.failed = [
      refused > 0 || 'the injected failure did not happen',
      row.rollbackTarget === start || 'rolled back elsewhere',
      row.historyAfterFailure === 0 || 'the failed switch changed the history',
      selected === 'a00000' || 'no tracked aircraft before the failure',
      row.selectionKept || 'the tracked aircraft is lost after the rollback',
      row.historyAfterRetry === 1 || 'the retry did not add one entry',
      row.selectionAfterRetry === selected ||
        'the tracked aircraft is lost after the retry',
    ].filter((v) => v !== true);
    results.push(row);
    console.log(row.failed.length ? 'FAIL' : 'PASS', JSON.stringify(row));
    await p.close();
  }

  // Slow first frame: animation frames held for 12 s from the person's
  // input (a stalled GPU or compositor), cold and warm.
  for (const [start, temperature] of [
    ['cesium', 'cold'],
    ['navara', 'warm'],
  ]) {
    const target = other(start);
    const label = `${temperature} ${start}→${target} first frame after 12 s`;
    const p = await open(start, temperature === 'warm');
    const before = await sessionState(p);
    await p.evaluate((target) => {
      window.__qaSlow = { frame: window.__qaFirstFrame(target) };
      window.__qaSlow.frame.then((t) => (window.__qaSlow.drawn = t));
      const select = document.querySelector('#globe-engine');
      // From the change on, every animation frame waits until 12 s after it.
      select.addEventListener(
        'change',
        () => {
          const until = performance.now() + 12000;
          window.__qaSlow.at = performance.now();
          const raf = window.requestAnimationFrame.bind(window);
          window.requestAnimationFrame = (callback) =>
            raf((time) => {
              const wait = until - performance.now();
              if (wait <= 0) return callback(time);
              setTimeout(() => raf(callback), wait);
            });
          window.__qaSlow.release = () => {
            window.requestAnimationFrame = raf;
          };
        },
        { once: true, capture: true },
      );
      new MutationObserver((_, observer) => {
        if (
          window.__qaSlow.at &&
          !window.__qaSlow.coverGone &&
          !document.querySelector('.engine-switch-frame') &&
          !document.querySelector(
            '#globe-engine:is([disabled], [aria-busy="true"])',
          )
        ) {
          window.__qaSlow.coverGone = performance.now();
          observer.disconnect();
        }
      }).observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['disabled'],
      });
    }, target);
    await strict.pick(p, target, { settle: false });
    await p.waitForFunction(
      (target) =>
        window.__godsEyeView?.engine?.kind === target &&
        !document.querySelector(
          '#globe-engine:is([disabled], [aria-busy="true"])',
        ) &&
        !document.querySelector('.engine-switch-frame'),
      { polling: 200, timeout: 60000 },
      target,
    );
    const done = await assertSession(p, target, label);
    const timing = await p.evaluate(async () => {
      const frame = await window.__qaSlow.frame;
      return {
        coverGoneMs: Math.round(window.__qaSlow.coverGone - window.__qaSlow.at),
        firstFrameMs: Math.round(frame.presented - window.__qaSlow.at),
      };
    });
    const row = {
      case: label,
      engine: done.engine,
      history: done.history - before.history,
      ...timing,
      errors: p.errors.length,
    };
    results.push(row);
    assert.equal(row.history, 1, 'one history entry, no rollback');
    assert.ok(
      row.coverGoneMs >= 9500 && row.coverGoneMs < 12500,
      'the cover goes after the 10 s first-frame wait ' + JSON.stringify(row),
    );
    assert.ok(row.firstFrameMs >= 12000, 'the frame arrives after the stall');
    console.log('PASS', JSON.stringify(row));
    await p.close();
  }
  assert.deepEqual(
    results.filter((row) => row.failed?.length),
    [],
    'failure-injection cases that broke the contract',
  );
});
