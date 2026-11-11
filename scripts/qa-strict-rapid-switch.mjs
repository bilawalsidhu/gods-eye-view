import { whenSettled } from './qa/ready.mjs';
// Contract: rapid switches. Back-to-back picks with real input, a second
// pointer click on the picker while it is busy, a history visit superseded
// by the opposite visit before its engine is ready, and a pick superseded by
// Back before its engine is ready. After each: the expected engine runs on
// the same session, the history has exactly the expected entries, both
// engines are the warm ones (no third engine), one engine canvas is shown.
//
//   node scripts/qa-strict-rapid-switch.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  assertSession,
  installSessionFixtures,
  openApp,
  rememberEngine,
  sessionState,
  startSession,
} from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const strict = createStrict({ origin: base.origin, layers: [] });
await strict.run({}, async (b) => {
  const p = await b.newPage();
  await p.setViewport({ width: 1280, height: 800 });
  const errors = [];
  p.on('pageerror', (e) => errors.push(e.message));
  await installSessionFixtures(p, { flights: 20 });
  await openApp(p, base.origin, 'navara');
  await startSession(p, ['earthquakes', 'flights']);
  const engines = () =>
    p.evaluate(() => {
      const shown = [...window.__qaEngines.values()].filter(
        (engine) => engine.host.canvas.isConnected,
      ).length;
      return {
        warm:
          window.__qaEngines.get(window.__godsEyeView.engine.kind) ===
          window.__godsEyeView.engine,
        known: window.__qaEngines.size,
        shown,
      };
    });
  const contract = (name, value, detail) => {
    assert.ok(value, name + ' ' + JSON.stringify(detail ?? ''));
    strict.extra.contracts ??= [];
    strict.extra.contracts.push({ name, pass: true, detail });
    console.log('PASS', name);
  };

  // 1. Back-to-back picks; a second click on the busy picker does nothing.
  const start = (await sessionState(p)).history;
  for (const [i, kind] of ['cesium', 'navara', 'cesium', 'navara'].entries()) {
    await strict.pick(p, kind, { settle: false });
    // The picker is disabled while the engine changes: a second pointer
    // click on it (the person trying the other engine) changes nothing.
    const box = await p.$eval('#globe-engine', (el) => {
      const r = el.getBoundingClientRect();
      return {
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        disabled: el.disabled,
      };
    });
    await p.mouse.click(box.x, box.y);
    await waitForEngine(p, kind);
    await rememberEngine(p);
    const state = await assertSession(p, kind, `pick ${i + 1} to ${kind}`);
    assert.equal(state.history, start + i + 1, 'one entry per pick');
    const shown = await engines();
    assert.ok(shown.warm && shown.shown === 1, JSON.stringify(shown));
  }
  contract(
    'four back-to-back picks: each adds one history entry, keeps the session, reuses the warm engines and shows one canvas; a click on the busy picker changes nothing',
    true,
    { history: (await sessionState(p)).history - start },
  );

  // A switch in progress, seen from the page: the engine object the page
  // exposes is the starting engine until the switch is over.
  const progress = () =>
    p.evaluate(() => {
      window.__qaSteps = [];
      const mark = (step) =>
        window.__qaSteps.push({
          step,
          engine: window.__godsEyeView?.engine?.kind ?? null,
          busy: Boolean(
            document.querySelector(
              '#globe-engine:is([disabled], [aria-busy="true"])',
            ),
          ),
        });
      window.__qaMark = mark;
    });

  // 2. A history visit superseded before its engine is ready: Back (to the
  // Cesium entry) and, from the page's popstate handling of that Back, at
  // once Forward (to the Navara entry), while Back's switch runs.
  const length = (await sessionState(p)).history;
  await progress();
  await p.evaluate(() => {
    window.addEventListener(
      'popstate',
      () => {
        window.__qaMark('back');
        history.forward();
      },
      { once: true },
    );
    history.back();
  });
  await waitForEngine(p, 'navara');
  await whenSettled(p);
  await assertSession(p, 'navara', 'Forward supersedes Back');
  const visited = await sessionState(p);
  const shown = await engines();
  const backSteps = await p.evaluate(() => window.__qaSteps);
  contract(
    'Back then Forward before the Cesium entry is ready: Navara runs on the same session, no entry added, one canvas shown',
    visited.history === length && shown.warm && shown.shown === 1,
    { steps: backSteps, history: visited.history - length, ...shown },
  );

  // 3. A pick superseded by Back before its engine is ready: the person
  // picks Cesium and presses Back while it starts (Back is issued from the
  // page's own change handling of the pick, so it lands mid-switch). The
  // pick adds no entry and Back's entry (Cesium, the entry before) wins.
  const before = await sessionState(p);
  await progress();
  await p.evaluate(() => {
    window.addEventListener(
      'change',
      (event) => {
        if (event.target?.id !== 'globe-engine') return;
        window.__qaMark('pick');
        history.back();
      },
      { once: true },
    );
  });
  await strict.pick(p, 'cesium', { settle: false });
  await waitForEngine(p, 'cesium', { timeout: 30000 });
  await whenSettled(p);
  await assertSession(p, 'cesium', 'Back supersedes the pick');
  const after = await sessionState(p);
  const backShown = await engines();
  const pickSteps = await p.evaluate(() => window.__qaSteps);
  contract(
    'a pick superseded by Back before ready: Back’s Cesium entry runs on the same session, the pick adds no entry, one canvas shown',
    after.history === before.history &&
      backShown.warm &&
      backShown.shown === 1 &&
      pickSteps[0]?.busy,
    { steps: pickSteps, history: after.history - before.history, ...backShown },
  );
  // The page still takes an ordinary pick afterwards.
  await strict.pick(p, 'navara');
  await waitForEngine(p, 'navara');
  await assertSession(p, 'navara', 'a pick after the races');
  assert.deepEqual(errors, []);
});
