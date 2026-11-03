// Contract: a WebGL context loss during a switch (WEBGL_lose_context, the
// context coming back 1 s later with restoreContext(), as after a GPU
// reset). After each case the page runs one engine on the same session, the
// history matches the outcome (one entry for a completed switch, none for a
// rollback), the running engine draws a non-blank frame, and a later pick
// back to the engine that lost its context draws a non-blank frame too.
//
// - outgoing: the running engine's context is lost by the same input that
//   starts the switch (cold Navara→Cesium, then warm Cesium→Navara);
// - incoming: the parked target engine's context is lost by the input that
//   asks for it (warm, both directions).
//
//   node scripts/qa-strict-context-loss.mjs http://127.0.0.1:4208

import assert from 'node:assert/strict';
import {
  createStrict,
  localPreview,
  waitForEngine,
} from './qa-strict-harness.mjs';
import {
  installFirstFrameProbe,
  installSessionFixtures,
  openApp,
  rememberEngine,
  sessionState,
  startSession,
} from './qa-strict-session.mjs';

const base = localPreview(process.argv[2]);
const other = (kind) => (kind === 'navara' ? 'cesium' : 'navara');
const strict = createStrict({ origin: base.origin, layers: [] });
const results = [];
strict.extra.contracts = results;
await strict.run({ args: ['--use-angle=metal', '--enable-gpu'] }, async (b) => {
  let p = null;
  const errors = [];
  // A fresh page on `from`; warm visits the other engine first.
  const fresh = async (from, warm) => {
    await p?.close().catch(() => {});
    p = await b.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    p.on('pageerror', (e) => errors.push(e.message));
    await installSessionFixtures(p, { flights: 20 });
    await installFirstFrameProbe(p);
    await openApp(p, base.origin, from);
    await startSession(p, ['earthquakes', 'flights']);
    if (!warm) return;
    for (const kind of [other(from), from]) {
      await strict.pick(p, kind);
      await waitForEngine(p, kind);
      await rememberEngine(p);
    }
  };

  // The running engine draws a non-blank frame within 15 s.
  const draws = (kind) =>
    p.evaluate(
      (kind) =>
        Promise.race([
          window.__qaFirstFrame(kind).then(() => true),
          new Promise((resolve) => setTimeout(() => resolve(false), 15000)),
        ]),
      kind,
    );
  const settle = async () => {
    await p.waitForFunction(
      () =>
        (window.__godsEyeView &&
          !document.querySelector('#globe-engine')?.disabled &&
          !document.querySelector('.engine-switch-frame') &&
          document.querySelector('#loading-screen.hidden')) ||
        document.querySelector('.engine-switch-retry'),
      { polling: 100, timeout: 90000 },
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
  };
  const intact = (state) =>
    state.running &&
    state.manager &&
    state.models &&
    state.enabled &&
    state.address === state.engine &&
    state.picker === state.engine;

  for (const [loser, from, temperature] of [
    ['outgoing', 'navara', 'cold'],
    ['outgoing', 'cesium', 'warm'],
    ['incoming', 'navara', 'warm'],
    ['incoming', 'cesium', 'warm'],
  ]) {
    const to = other(from);
    const label = `${temperature} ${from}→${to}, ${loser} context lost`;
    // Cold cases, and any case after a failed one, start on a fresh page.
    if (!p || temperature === 'cold' || results.at(-1)?.failed.length)
      await fresh(from, temperature === 'warm');
    else if ((await sessionState(p)).engine !== from) {
      await strict.pick(p, from);
      await waitForEngine(p, from);
      await rememberEngine(p);
    }
    const before = await sessionState(p);
    // The input that starts the switch also loses the context; it comes
    // back a second later.
    await p.evaluate(
      (loser, from, to) => {
        const select = document.querySelector('#globe-engine');
        select.addEventListener(
          'change',
          () => {
            const engine =
              loser === 'outgoing'
                ? window.__godsEyeView.engine
                : window.__qaEngines.get(to);
            const canvas = engine.host.canvas;
            const context =
              canvas.getContext('webgl2') ?? canvas.getContext('webgl');
            const extension = context.getExtension('WEBGL_lose_context');
            window.__qaLoss = {
              kind: engine.kind,
              lost: false,
              restored: false,
            };
            canvas.addEventListener(
              'webglcontextrestored',
              () => (window.__qaLoss.restoredEvent = true),
              { once: true },
            );
            extension.loseContext();
            window.__qaLoss.lost = context.isContextLost();
            setTimeout(() => {
              extension.restoreContext();
              window.__qaLoss.restored = true;
            }, 1000);
          },
          { once: true, capture: true },
        );
      },
      loser,
      from,
      to,
    );
    try {
      await strict.pick(p, to, { settle: false });
      await settle();
      await p.waitForFunction(() => window.__qaLoss?.restored, {
        polling: 100,
        timeout: 10000,
      });
      await settle();
    } catch (error) {
      results.push({
        case: label,
        failed: [
          'the switch could not be made: ' +
            String(error.message).slice(0, 200),
        ],
      });
      console.log('FAIL', JSON.stringify(results.at(-1)));
      continue;
    }
    const after = await sessionState(p);
    const loss = await p.evaluate(() => window.__qaLoss);
    const outcome = after.engine === to ? 'switched' : 'rolled back';
    if (after.running) await rememberEngine(p);
    const drawn = after.running ? await draws(after.engine) : false;
    console.log(
      'after',
      label,
      JSON.stringify({ after, loss, drawn }),
      JSON.stringify(
        await p.evaluate(() => ({
          toggle: document
            .querySelector('#control-panel-toggle')
            ?.getAttribute('aria-expanded'),
          retry: !!document.querySelector('.engine-switch-retry'),
          status: document.querySelector('#loading-screen .loader-status')
            ?.textContent,
          loading: document.querySelector('#loading-screen')?.className,
        })),
      ),
    );
    // Back to the engine that lost its context, with real input.
    const back = after.engine === loss.kind ? other(loss.kind) : loss.kind;
    let backDrawn = null,
      backState = null;
    let backError = null;
    if (after.running) {
      try {
        await strict.pick(p, back);
        await waitForEngine(p, back, { timeout: 60000 });
      } catch (error) {
        backError = String(error.message).slice(0, 300);
      }
      backState = await sessionState(p);
      if (backState.running) await rememberEngine(p);
      backDrawn = backState.engine === back ? await draws(back) : false;
    }
    const row = {
      case: label,
      lostKind: loss.kind,
      lost: loss.lost,
      restoredEvent: Boolean(loss.restoredEvent),
      outcome,
      sessionIntact: intact(after),
      history: after.history - before.history,
      drawn,
      back,
      backEngine: backState?.engine ?? null,
      backSessionIntact: backState ? intact(backState) : false,
      backDrawn,
      backError,
      pageErrors: errors.splice(0),
    };
    row.failed = [
      row.lost || 'the context was not lost',
      row.sessionIntact || 'the session is not intact',
      row.history === (outcome === 'switched' ? 1 : 0) ||
        'the history does not match the outcome',
      row.drawn || 'no non-blank frame from the running engine',
      row.backEngine === back || `the pick back to ${back} did not run it`,
      row.backSessionIntact || 'the session is not intact after the pick back',
      row.backDrawn || `no non-blank frame from ${back} after the pick back`,
      row.backError === null || 'the pick back failed: ' + row.backError,
      row.pageErrors.length === 0 || 'uncaught page errors',
    ].filter((v) => v !== true);
    results.push(row);
    console.log(row.failed.length ? 'FAIL' : 'PASS', JSON.stringify(row));
  }
  assert.deepEqual(
    results.filter((row) => row.failed.length),
    [],
    'context-loss cases that broke the contract',
  );
});
